import { Blueprint } from '../blueprint/index.js';
import { validate } from '../compiler/validate.js';
import type { Diagnostic } from '../compiler/diagnostics.js';
import { inTransaction, type Pool } from './db.js';
import { require_, requireWorkspaceCapability, type Principal } from './policy.js';
import { DraftConflict } from './errors.js';
import { runScenarios, type ScenarioResult } from './scenarios.js';
import { Engine } from './engine.js';
import {
  availableProviders,
  blueprintSchema,
  generateBlueprint,
  providerFor,
  type GenerationOutcome,
  type ProviderName,
} from '../ai/index.js';

/**
 * The builder's server side.
 *
 * §20.1 step 3: "The builder changes a field and approval threshold, resolves
 * warnings, and publishes." Four requirements sit behind that sentence —
 * BLD-03 (edit without editing JSON), BLD-04 (the compiler names what is
 * wrong), BLD-05 (test with sample records before publishing), BLD-07
 * (publishing confirms the schema and migration effects).
 *
 * The compiler is the whole point. A builder that lets you draw a process and
 * discover at runtime that nobody can approve it is a diagram tool. What makes
 * this one worth using is that it refuses, and says why, and says it while you
 * are still looking at the thing you broke.
 */

export interface DraftSummary {
  id: string;
  processKey: string;
  processName: string;
  basedOnVersion: number | null;
  updatedAt: string;
  createdBy: string;
}

export interface DraftDetail extends DraftSummary {
  blueprint: Blueprint;
  diagnostics: Diagnostic[];
  publishable: boolean;
  /** What a save or a publish must name, so it cannot land on work it has not seen. */
  revision: number;
  /** The form's public link id, once the process has been published. */
  formId: string | null;
  /** Who saved it last, by name. Null until somebody saves. */
  updatedBy: string | null;
  lock: DraftLock;
}

/** How long opening a draft holds it. The builder renews at a third of this. */
export const LEASE_SECONDS = 120;

export interface DraftLock {
  /** Whoever holds the lease, by name — null when nobody does or it has expired. */
  by: string | null;
  mine: boolean;
  since: string | null;
  until: string | null;
}

type Actor = Extract<Principal, { kind: 'actor' }>;

function actorOf(principal: Principal): Actor {
  if (principal.kind !== 'actor') throw new Error('the builder is for signed-in members');
  return principal;
}

/**
 * The permission every draft operation needs, checked on every one of them.
 *
 * Opening, creating and discarding a draft checked `administer`. Loading,
 * saving, testing, the impact summary and publishing checked only that the
 * caller was in the same workspace — so a read-only member who had a draft's
 * id, which the builder's own process list hands to anybody signed in, could
 * rewrite a process and publish it. The gate was on the door and not on the
 * rooms.
 *
 * Same rule as `openDraft`: `administer` from the process's roles or from the
 * workspace role. A process that has never been published has no roles yet,
 * so only the workspace role can grant it.
 */
async function requireDraftAdmin(pool: Pool, principal: Actor, processKey: string): Promise<void> {
  const published = await currentBlueprint(pool, principal.tenantId, processKey);
  if (!published) {
    await requireWorkspaceCapability(pool, principal, 'administer', processKey);
    return;
  }
  const client = await pool.connect();
  try {
    await require_(
      client,
      { principal, action: 'administer', tenantId: principal.tenantId, processKey, blueprint: published.blueprint },
      pool,
    );
  } finally {
    client.release();
  }
}

interface LockRow {
  revision: number;
  published_as: number | null;
  updated_at: Date;
  updated_by: string | null;
  updated_by_name: string | null;
  locked_by: string | null;
  locked_by_name: string | null;
  locked_at: Date | null;
  locked_until: Date | null;
  live: boolean;
}

async function lockRow(pool: Pool, principal: Actor, draftId: string): Promise<LockRow | null> {
  const { rows } = await pool.query<LockRow>(
    `select d.revision, d.published_as, d.updated_at, d.updated_by, d.locked_by, d.locked_at, d.locked_until,
            coalesce(d.locked_until > now(), false) as live,
            u.display_name as updated_by_name, l.display_name as locked_by_name
       from process_draft d
       left join actor u on u.id = d.updated_by
       left join actor l on l.id = d.locked_by
      where d.id = $1 and d.tenant_id = $2`,
    [draftId, principal.tenantId],
  );
  return rows[0] ?? null;
}

function lockOf(row: LockRow, principal: Actor): DraftLock {
  if (!row.locked_by || !row.live) return { by: null, mine: false, since: null, until: null };
  return {
    by: row.locked_by_name,
    mine: row.locked_by === principal.actorId,
    since: row.locked_at?.toISOString() ?? null,
    until: row.locked_until?.toISOString() ?? null,
  };
}

/**
 * Why a conditional write matched nothing, in words.
 *
 * Every write below is a single `update ... where revision = $n and <lease is
 * free or mine>`, so the database decides atomically and there is no window
 * between checking and writing. When it refuses, this reads the row once more
 * to say which condition failed — the order matters: a published draft is
 * not "stale", and a draft somebody is holding is better explained by who
 * holds it than by a revision number.
 */
async function conflictFor(pool: Pool, principal: Actor, draftId: string, base: number): Promise<Error> {
  const row = await lockRow(pool, principal, draftId);
  if (!row) return new Error('no such draft');
  if (row.published_as !== null) {
    return new DraftConflict(
      'published',
      `this draft was published as version ${row.published_as} — open the process again to keep editing`,
      { version: row.published_as },
    );
  }
  if (row.locked_by && row.live && row.locked_by !== principal.actorId) {
    return new DraftConflict('held', `${row.locked_by_name ?? 'another member'} is editing this draft`, {
      by: row.locked_by_name ?? undefined,
      at: row.locked_at?.toISOString(),
    });
  }
  if (row.revision !== base) {
    // The same person in two tabs is the commonest way to get here, and
    // "Joy saved this after you opened it", said to Joy, reads as a fault.
    const self = row.updated_by === principal.actorId;
    return new DraftConflict(
      'stale',
      self
        ? 'you saved this draft from another tab after this one loaded it'
        : `${row.updated_by_name ?? 'someone'} saved this draft after you opened it`,
      { by: self ? 'you' : (row.updated_by_name ?? undefined), at: row.updated_at.toISOString(), revision: row.revision },
    );
  }
  return new Error('the draft could not be saved');
}

async function currentBlueprint(pool: Pool, tenantId: string, processKey: string) {
  const { rows } = await pool.query<{ blueprint: Blueprint; version: number }>(
    `select blueprint, version from process_version
      where tenant_id = $1 and process_key = $2 order by version desc limit 1`,
    [tenantId, processKey],
  );
  return rows[0] ?? null;
}

/** Every published process, and whether somebody already has it open. */
export async function listForBuilder(pool: Pool, principal: Principal) {
  if (principal.kind !== 'actor') throw new Error('the builder is for signed-in members');
  const { rows } = await pool.query<{
    process_key: string;
    name: string;
    version: number | null;
    draft_id: string | null;
    instances: number;
  }>(
    `with latest as (
       select distinct on (process_key) process_key, version, blueprint
         from process_version where tenant_id = $1 order by process_key, version desc
     )
     , keys as (
       select process_key from latest
       union
       select process_key from process_draft where tenant_id = $1 and published_as is null
     )
     select k.process_key,
            coalesce(l.blueprint ->> 'name',
                     (select d.blueprint ->> 'name' from process_draft d
                       where d.tenant_id = $1 and d.process_key = k.process_key and d.published_as is null
                       order by d.updated_at desc limit 1)) as name,
            l.version,
            (select d.id from process_draft d
              where d.tenant_id = $1 and d.process_key = k.process_key and d.published_as is null
              order by d.updated_at desc limit 1) as draft_id,
            (select count(*)::int from instance i
              where i.tenant_id = $1 and i.process_key = k.process_key and i.completed_at is null) as instances
       from keys k left join latest l on l.process_key = k.process_key
      order by k.process_key`,
    [principal.tenantId],
  );
  return rows;
}

/** Opens the latest published version for editing, or reuses an open draft. */
export async function openDraft(
  pool: Pool,
  args: { principal: Principal; processKey: string },
): Promise<DraftDetail> {
  if (args.principal.kind !== 'actor') throw new Error('the builder is for signed-in members');
  const tenantId = args.principal.tenantId;

  const published = await currentBlueprint(pool, tenantId, args.processKey);
  if (!published) throw new Error(`no published version of "${args.processKey}"`);

  // The transaction returns an id and nothing else. Reading the draft back
  // inside it would take a second connection out of the pool, and that
  // connection cannot see a row this transaction has not committed yet — the
  // same trap as the refusal audit and the delivery log, arrived at from the
  // opposite direction.
  const draftId = await inTransaction(pool, async (client) => {
    await require_(
      client,
      {
        principal: args.principal,
        action: 'administer',
        tenantId,
        processKey: args.processKey,
        blueprint: published.blueprint,
      },
      pool,
    );

    const { rows: existing } = await client.query<{ id: string }>(
      `select id from process_draft
        where tenant_id = $1 and process_key = $2 and published_as is null
        order by updated_at desc limit 1`,
      [tenantId, args.processKey],
    );
    if (existing.length) return existing[0]!.id;

    const { rows } = await client.query<{ id: string }>(
      `insert into process_draft (tenant_id, process_key, based_on_version, blueprint, created_by)
       values ($1, $2, $3, $4, $5) returning id`,
      [tenantId, args.processKey, published.version, published.blueprint, describe(args.principal)],
    );
    return rows[0]!.id;
  });

  return loadDraft(pool, args.principal, draftId);
}

export async function loadDraft(pool: Pool, principal: Principal, draftId: string): Promise<DraftDetail> {
  const actor = actorOf(principal);

  const { rows } = await pool.query<{
    id: string;
    process_key: string;
    based_on_version: number | null;
    blueprint: Blueprint;
    created_by: string;
    updated_at: Date;
  }>(
    `select id, process_key, based_on_version, blueprint, created_by, updated_at
       from process_draft where id = $1 and tenant_id = $2`,
    [draftId, actor.tenantId],
  );
  const row = rows[0];
  if (!row) throw new Error('no such draft');
  await requireDraftAdmin(pool, actor, row.process_key);
  const lock = (await lockRow(pool, actor, draftId))!;

  // saveDraft stores work that does not parse, on purpose. Reopening one of
  // those used to reach `validate` with something that is not a blueprint and
  // throw — which made the "your work is never lost" promise false the moment
  // you refreshed the page. Shape errors come back as diagnostics instead.
  const shape = Blueprint.safeParse(row.blueprint);
  const compiled = shape.success ? validate(shape.data) : null;
  const diagnostics = shape.success ? compiled!.items : shapeDiagnostics(shape.error);

  return {
    id: row.id,
    processKey: row.process_key,
    processName: shape.success ? shape.data.name : (row.blueprint as { name?: string })?.name ?? row.process_key,
    basedOnVersion: row.based_on_version,
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by,
    blueprint: row.blueprint,
    diagnostics,
    publishable: compiled ? compiled.publishable : false,
    revision: lock.revision,
    formId:
      (
        await pool.query<{ public_id: string }>(
          'select public_id from public_form where tenant_id = $1 and process_key = $2',
          [actor.tenantId, row.process_key],
        )
      ).rows[0]?.public_id ?? null,
    updatedBy: lock.updated_by_name,
    lock: lockOf(lock, actor),
  };
}

/** Zod issues, phrased the way the diagnostics panel expects. */
function shapeDiagnostics(error: { issues: { path: PropertyKey[]; message: string }[] }): Diagnostic[] {
  return error.issues.slice(0, 20).map((issue) => ({
    code: 'SHAPE',
    severity: 'error' as const,
    at: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Saves an edit and compiles it.
 *
 * A draft that does not even parse is still saved. Refusing to store work
 * because it is currently invalid is how people lose an afternoon — the
 * compiler's job is to stop it *publishing*, not to stop it existing.
 */
export async function saveDraft(
  pool: Pool,
  args: { principal: Principal; draftId: string; blueprint: unknown; baseRevision: number },
): Promise<{ diagnostics: Diagnostic[]; publishable: boolean; parsed: boolean; revision: number }> {
  const actor = actorOf(args.principal);
  const draft = await draftKey(pool, actor, args.draftId);
  await requireDraftAdmin(pool, actor, draft);

  const parsed = Blueprint.safeParse(args.blueprint);

  /*
   * One statement decides. The revision must be the one this edit was made
   * against, and the lease must be free, expired, or already this member's.
   *
   * This used to be an unconditional update that also matched nothing, and
   * said nothing, when the draft had already been published — so a save
   * after somebody else published returned fresh diagnostics and a green
   * "saved", and the work went nowhere. A write that did not happen now says
   * so, and says why.
   *
   * Saving renews the lease: someone typing is plainly still editing.
   */
  const { rows } = await pool.query<{ revision: number }>(
    `update process_draft
        set blueprint = $1, updated_at = now(), updated_by = $4, revision = revision + 1,
            locked_by = $4,
            locked_at = case when locked_by = $4 and locked_until > now() then locked_at else now() end,
            locked_until = now() + make_interval(secs => $6)
      where id = $2 and tenant_id = $3 and published_as is null and revision = $5
        and (locked_by is null or locked_by = $4 or locked_until < now())
      returning revision`,
    [JSON.stringify(args.blueprint), args.draftId, actor.tenantId, actor.actorId, args.baseRevision, LEASE_SECONDS],
  );
  if (!rows.length) throw await conflictFor(pool, actor, args.draftId, args.baseRevision);
  const revision = rows[0]!.revision;

  if (!parsed.success) {
    return {
      parsed: false,
      publishable: false,
      diagnostics: shapeDiagnostics(parsed.error),
      revision,
    };
  }

  const compiled = validate(parsed.data);
  return { parsed: true, diagnostics: compiled.items, publishable: compiled.publishable, revision };
}

async function draftKey(pool: Pool, actor: Actor, draftId: string): Promise<string> {
  const { rows } = await pool.query<{ process_key: string }>(
    'select process_key from process_draft where id = $1 and tenant_id = $2',
    [draftId, actor.tenantId],
  );
  if (!rows[0]) throw new Error('no such draft');
  return rows[0].process_key;
}

// ---------------------------------------------------------------- the lease

/**
 * Claims a draft for editing, or renews the claim.
 *
 * Returns the lock either way rather than throwing when somebody else holds
 * it: being told "Sam is editing this" is the ordinary outcome of opening a
 * busy draft, not an error, and the builder turns it into a read-only view
 * with a way to take over.
 *
 * `takeOver` is for the case the lease exists for — Sam opened it, went to a
 * meeting, and the tab is still renewing. It moves the lease. It does not
 * touch Sam's unsaved work, which is in Sam's tab; Sam's next save is refused
 * with this member's name on it, and nothing is lost on either side.
 */
export async function claimDraft(
  pool: Pool,
  args: { principal: Principal; draftId: string; takeOver?: boolean },
): Promise<DraftLock & { revision: number; tookOverFrom?: string }> {
  const actor = actorOf(args.principal);
  await requireDraftAdmin(pool, actor, await draftKey(pool, actor, args.draftId));

  const before = await lockRow(pool, actor, args.draftId);
  if (!before) throw new Error('no such draft');
  if (before.published_as !== null) {
    throw await conflictFor(pool, actor, args.draftId, before.revision);
  }

  const { rowCount } = await pool.query(
    `update process_draft
        set locked_by = $3,
            locked_at = case when locked_by = $3 and locked_until > now() then locked_at else now() end,
            locked_until = now() + make_interval(secs => $4)
      where id = $1 and tenant_id = $2 and published_as is null
        and (locked_by is null or locked_by = $3 or locked_until < now() or $5)`,
    [args.draftId, actor.tenantId, actor.actorId, LEASE_SECONDS, args.takeOver === true],
  );

  const after = (await lockRow(pool, actor, args.draftId))!;
  const displaced =
    rowCount && args.takeOver && before.live && before.locked_by && before.locked_by !== actor.actorId
      ? (before.locked_by_name ?? 'another member')
      : undefined;
  return { ...lockOf(after, actor), revision: after.revision, ...(displaced ? { tookOverFrom: displaced } : {}) };
}

/** Lets go of a draft, if this member holds it. Anybody else's lease is left alone. */
export async function releaseDraft(pool: Pool, args: { principal: Principal; draftId: string }): Promise<{ released: boolean }> {
  const actor = actorOf(args.principal);
  const { rowCount } = await pool.query(
    `update process_draft set locked_by = null, locked_at = null, locked_until = null
      where id = $1 and tenant_id = $2 and locked_by = $3`,
    [args.draftId, actor.tenantId, actor.actorId],
  );
  return { released: (rowCount ?? 0) > 0 };
}

/** BLD-05: run the draft's own scenarios against the real engine, in a scratch tenant. */
export async function testDraft(
  pool: Pool,
  args: { principal: Principal; draftId: string },
): Promise<{ results: ScenarioResult[]; passed: number; total: number }> {
  const draft = await loadDraft(pool, args.principal, args.draftId);
  if (!draft.publishable) {
    throw new Error('the draft does not compile yet, so there is nothing to run it against');
  }
  const results = await runScenarios(pool, draft.blueprint);
  return { results, passed: results.filter((r) => r.passed).length, total: results.length };
}

// ------------------------------------------------------------------ impact

export interface PublishImpact {
  fromVersion: number | null;
  fields: { added: string[]; removed: string[]; retyped: { key: string; from: string; to: string }[] };
  states: { added: string[]; removed: string[] };
  /** Records still running. They stay on the version they started under. */
  inFlight: number;
  /** Removed fields that in-flight records still hold values for. */
  strandedData: string[];
  warnings: Diagnostic[];
}

/**
 * BLD-07: "Publishing requires confirmation of schema and migration effects."
 *
 * The number that matters is `inFlight`. §9.2 says a new version affects only
 * new instances by default, which is safe and also surprising — somebody who
 * has just fixed a broken approval expects the records stuck on it to move.
 * Saying how many will not is the honest thing to put in front of them.
 */
export async function publishImpact(
  pool: Pool,
  args: { principal: Principal; draftId: string },
): Promise<PublishImpact> {
  if (args.principal.kind !== 'actor') throw new Error('the builder is for signed-in members');
  const draft = await loadDraft(pool, args.principal, args.draftId);
  const published = await currentBlueprint(pool, args.principal.tenantId, draft.processKey);

  const before = published?.blueprint;
  const after = draft.blueprint;

  const beforeFields = new Map((before?.data.fields ?? []).map((f) => [f.key, f]));
  const afterFields = new Map(after.data.fields.map((f) => [f.key, f]));

  const added = [...afterFields.keys()].filter((k) => !beforeFields.has(k));
  const removed = [...beforeFields.keys()].filter((k) => !afterFields.has(k));
  const retyped = [...afterFields.entries()]
    .filter(([k, f]) => beforeFields.has(k) && beforeFields.get(k)!.type !== f.type)
    .map(([k, f]) => ({ key: k, from: beforeFields.get(k)!.type, to: f.type }));

  const beforeStates = new Set((before?.workflow.states ?? []).map((s) => s.key));
  const afterStates = new Set(after.workflow.states.map((s) => s.key));

  const { rows: counts } = await pool.query<{ count: number }>(
    'select count(*)::int as count from instance where tenant_id = $1 and process_key = $2 and completed_at is null',
    [args.principal.tenantId, draft.processKey],
  );

  // A field removed from the schema does not remove it from records that
  // already hold a value; §9.2 keeps those readable under retention.
  let stranded: string[] = [];
  if (removed.length && counts[0]!.count) {
    const { rows } = await pool.query<{ key: string }>(
      `select distinct k as key from instance i, lateral jsonb_object_keys(i.data) k
        where i.tenant_id = $1 and i.process_key = $2 and i.completed_at is null and k = any($3::text[])`,
      [args.principal.tenantId, draft.processKey, removed],
    );
    stranded = rows.map((r) => r.key);
  }

  return {
    fromVersion: published?.version ?? null,
    fields: { added, removed, retyped },
    states: {
      added: [...afterStates].filter((s) => !beforeStates.has(s)),
      removed: [...beforeStates].filter((s) => !afterStates.has(s)),
    },
    inFlight: counts[0]!.count,
    strandedData: stranded,
    warnings: draft.diagnostics.filter((d) => d.severity === 'warning'),
  };
}

/**
 * Publishes, if the compiler allows it.
 *
 * The check is repeated here rather than trusted from the UI. A publish
 * endpoint that believes the client about whether a blueprint compiles is not
 * a gate, and the whole argument for this architecture is that the gate is
 * real.
 */
export async function publishDraft(
  pool: Pool,
  args: { principal: Principal; draftId: string; revision: number },
): Promise<{ version: number; impact: PublishImpact }> {
  const actor = actorOf(args.principal);
  await requireDraftAdmin(pool, actor, await draftKey(pool, actor, args.draftId));

  /*
   * Publish exactly what the publisher reviewed.
   *
   * The impact dialog is computed from one revision; a save landing between
   * that and the confirm would publish something nobody looked at. So the
   * publish names its revision and takes the lease in the same statement —
   * after this matches, nobody else can save until the version exists.
   */
  const { rowCount } = await pool.query(
    `update process_draft
        set locked_by = $3,
            locked_at = case when locked_by = $3 and locked_until > now() then locked_at else now() end,
            locked_until = now() + make_interval(secs => $5)
      where id = $1 and tenant_id = $2 and published_as is null and revision = $4
        and (locked_by is null or locked_by = $3 or locked_until < now())`,
    [args.draftId, actor.tenantId, actor.actorId, args.revision, LEASE_SECONDS],
  );
  if (!rowCount) throw await conflictFor(pool, actor, args.draftId, args.revision);

  const draft = await loadDraft(pool, args.principal, args.draftId);
  const compiled = validate(draft.blueprint);
  if (!compiled.publishable) {
    const first = compiled.errors[0];
    throw new Error(
      `the draft has ${compiled.errors.length} error(s) and cannot be published — ${first?.code}: ${first?.message}`,
    );
  }

  const impact = await publishImpact(pool, args);
  const engine = new Engine(pool);
  const version = await engine.publish(actor.tenantId, draft.blueprint, describe(args.principal));

  await pool.query(
    `update process_draft
        set published_as = $1, updated_at = now(), locked_by = null, locked_at = null, locked_until = null
      where id = $2`,
    [version.version, draft.id],
  );

  return { version: version.version, impact };
}

function describe(principal: Principal): string {
  return principal.kind === 'actor' ? `actor:${principal.actorId}` : principal.kind;
}

// ------------------------------------------------------- creating a process

/**
 * BLD-01/02: a new process starts from a description, not from a blank canvas.
 *
 * Two routes, and the choice is not cosmetic. `describe` hands the description
 * to the generation pipeline, which already runs shape → compile → repair and
 * refuses to hand back something that does not compile. `copy` clones a
 * published process under a new key, which is what people actually do when the
 * new thing is "like that one but for contractors".
 *
 * Neither writes a published version. Both produce a draft, so the compiler
 * and the impact summary still stand between this and anything real.
 */
export interface NewProcess {
  key: string;
  name?: string;
  /** Route one: describe it and let the model propose. */
  description?: string;
  pack?: string;
  provider?: ProviderName;
  /** Route two: copy an existing published process. */
  copyFrom?: string;
}

export async function createDraft(
  pool: Pool,
  args: { principal: Principal; input: NewProcess },
): Promise<DraftDetail & { audit?: GenerationOutcome['audit']; decision?: string }> {
  const { principal, input } = args;
  await requireWorkspaceCapability(pool, principal, 'administer', input.key);
  if (principal.kind !== 'actor') throw new Error('unreachable');
  const tenantId = principal.tenantId;

  if (!/^[a-z][a-z0-9_]{2,}$/.test(input.key)) {
    throw new Error('a process key is lowercase letters, digits and underscores, at least three characters');
  }

  const { rows: clash } = await pool.query(
    `select 1 from process_version where tenant_id = $1 and process_key = $2
      union all
     select 1 from process_draft where tenant_id = $1 and process_key = $2 and published_as is null`,
    [tenantId, input.key],
  );
  if (clash.length) throw new Error(`"${input.key}" already exists in this workspace`);

  let blueprint: Blueprint;
  let audit: GenerationOutcome['audit'] | undefined;
  let decision: string | undefined;

  if (input.copyFrom) {
    const source = await currentBlueprint(pool, tenantId, input.copyFrom);
    if (!source) throw new Error(`no published version of "${input.copyFrom}" to copy`);
    blueprint = { ...source.blueprint, key: input.key, name: input.name ?? `${source.blueprint.name} (copy)` };
  } else {
    if (!input.description?.trim()) throw new Error('describe the process, or name one to copy');
    const available = availableProviders();
    if (!available.length) {
      throw new Error('no AI provider is configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY, or copy an existing process');
    }
    const provider = providerFor(input.provider ?? available[0]!);
    // The pool is passed so a clean blueprint also has to pass its own
    // scenarios before the pipeline calls it publishable (§7.4, gate three).
    const outcome = await generateBlueprint(provider, blueprintSchema(), {
      description: input.description,
      pack: input.pack,
      pool,
    });
    audit = outcome.audit;
    decision = outcome.decision;
    if (!outcome.blueprint) {
      throw new Error(
        `the model did not produce a usable blueprint (${outcome.decision}) — ${outcome.diagnostics[0]?.message ?? 'no detail'}`,
      );
    }
    // The key the builder typed wins over the one the model chose, so the URL
    // and the list entry match what they asked for.
    blueprint = { ...outcome.blueprint, key: input.key, name: input.name ?? outcome.blueprint.name };
  }

  const { rows } = await pool.query<{ id: string }>(
    `insert into process_draft (tenant_id, process_key, based_on_version, blueprint, created_by)
     values ($1, $2, null, $3, $4) returning id`,
    [tenantId, input.key, JSON.stringify(blueprint), describe(principal)],
  );

  return { ...(await loadDraft(pool, principal, rows[0]!.id)), audit, decision };
}

/**
 * Throws a draft away.
 *
 * Only an unpublished one: a draft with `published_as` set is the record of
 * where a version came from, and deleting that would break the provenance the
 * audit depends on.
 */
export async function discardDraft(
  pool: Pool,
  args: { principal: Principal; draftId: string },
): Promise<{ discarded: boolean }> {
  const { principal } = args;
  await requireWorkspaceCapability(pool, principal, 'administer', args.draftId);
  if (principal.kind !== 'actor') throw new Error('unreachable');

  // Not out from under somebody who is editing it.
  const { rowCount } = await pool.query(
    `delete from process_draft
      where id = $1 and tenant_id = $2 and published_as is null
        and (locked_by is null or locked_by = $3 or locked_until < now())`,
    [args.draftId, principal.tenantId, principal.actorId],
  );
  if (!rowCount) {
    const row = await lockRow(pool, principal, args.draftId);
    if (row && row.published_as === null) throw await conflictFor(pool, principal, args.draftId, row.revision);
  }
  return { discarded: (rowCount ?? 0) > 0 };
}

// --------------------------------------------------------------- versions

export interface VersionRow {
  version: number;
  publishedAt: string;
  publishedBy: string;
  /** Records that started under this version, whether or not they finished. */
  records: number;
  /** What changed from the version before it, in plain sentences. */
  changes: string[];
}

/** A list, then the differences between neighbours. Order is oldest first. */
function changesBetween(before: Blueprint | null, after: Blueprint): string[] {
  if (!before) return ['first published version'];
  const out: string[] = [];

  if (before.name !== after.name) out.push(`renamed from "${before.name}" to "${after.name}"`);

  const beforeFields = new Map(before.data.fields.map((f) => [f.key, f]));
  const afterFields = new Map(after.data.fields.map((f) => [f.key, f]));

  const added = [...afterFields.keys()].filter((k) => !beforeFields.has(k));
  const removed = [...beforeFields.keys()].filter((k) => !afterFields.has(k));
  const retyped = [...afterFields.entries()].filter(
    ([k, f]) => beforeFields.has(k) && beforeFields.get(k)!.type !== f.type,
  );
  const required = [...afterFields.entries()].filter(
    ([k, f]) => beforeFields.has(k) && !beforeFields.get(k)!.required && f.required,
  );

  if (added.length) out.push(`added ${added.length === 1 ? 'the question' : 'the questions'} ${list(added)}`);
  if (removed.length) out.push(`removed ${removed.length === 1 ? 'the question' : 'the questions'} ${list(removed)}`);
  for (const [k, f] of retyped) out.push(`changed ${k} from ${beforeFields.get(k)!.type} to ${f.type}`);
  if (required.length) out.push(`made ${list(required.map(([k]) => k))} required`);

  const beforeStates = new Set(before.workflow.states.map((s) => s.key));
  const afterStates = new Set(after.workflow.states.map((s) => s.key));
  const statesAdded = [...afterStates].filter((s) => !beforeStates.has(s));
  const statesGone = [...beforeStates].filter((s) => !afterStates.has(s));
  if (statesAdded.length) out.push(`added the step ${list(statesAdded)}`);
  if (statesGone.length) out.push(`removed the step ${list(statesGone)}`);

  const ruleDelta = (after.workflow.transitions ?? []).length - (before.workflow.transitions ?? []).length;
  if (ruleDelta > 0) out.push(`added ${ruleDelta} automation rule${ruleDelta === 1 ? '' : 's'}`);
  if (ruleDelta < 0) out.push(`removed ${-ruleDelta} automation rule${ruleDelta === -1 ? '' : 's'}`);

  const approvalDelta = (after.workflow.approvals ?? []).length - (before.workflow.approvals ?? []).length;
  if (approvalDelta > 0) out.push(`added ${approvalDelta} approval${approvalDelta === 1 ? '' : 's'}`);
  if (approvalDelta < 0) out.push(`removed ${-approvalDelta} approval${approvalDelta === -1 ? '' : 's'}`);

  /*
   * The form itself, which is most of what somebody changes and none of what
   * the checks above look at. Compared as a whole rather than field by field:
   * the useful sentence is "the form changed", and the preview and the
   * blueprint say how.
   */
  const experience = (bp: Blueprint) => JSON.stringify(bp.experience);
  if (experience(before) !== experience(after)) {
    const header = JSON.stringify(before.experience.branding) !== JSON.stringify(after.experience.branding);
    const layout =
      JSON.stringify(before.experience.pages.map((p) => p.sections.map((s2) => s2.widths))) !==
      JSON.stringify(after.experience.pages.map((p) => p.sections.map((s2) => s2.widths)));

    if (header) out.push('changed the form header');
    if (layout) out.push('changed how the questions are laid out');
    if (!header && !layout) out.push('changed the form');
  }

  const emailDelta =
    (after.communications?.email ?? []).length - (before.communications?.email ?? []).length;
  if (emailDelta > 0) out.push(`added ${emailDelta} message${emailDelta === 1 ? '' : 's'}`);
  if (emailDelta < 0) out.push(`removed ${-emailDelta} message${emailDelta === -1 ? '' : 's'}`);

  /*
   * A difference nothing above catches still has to be reported. Saying
   * "nothing changed" about a version that did change is worse than saying
   * something vague, because somebody would stop looking.
   */
  if (!out.length) {
    out.push(
      JSON.stringify(before) === JSON.stringify(after)
        ? 'republished with no changes'
        : 'changed in ways this summary does not cover — compare the two blueprints',
    );
  }
  return out;
}

function list(keys: string[]): string {
  if (keys.length <= 3) return keys.join(', ');
  return `${keys.slice(0, 3).join(', ')} and ${keys.length - 3} more`;
}

/**
 * Every published version of one process, newest first.
 *
 * `process_version` is append-only and refuses UPDATE by database trigger, so
 * this is the record rather than a reconstruction of it — nobody, including
 * this code, can have edited a past version into agreeing with the present.
 */
export async function versionHistory(
  pool: Pool,
  principal: Principal,
  processKey: string,
): Promise<VersionRow[]> {
  if (principal.kind !== 'actor') throw new Error('the builder is for signed-in members');

  const { rows } = await pool.query<{
    id: string;
    version: number;
    blueprint: Blueprint;
    published_at: Date;
    published_by: string;
    records: number;
  }>(
    /*
     * `published_by` is an audit string like `actor:<uuid>`, which is the right
     * thing to store and the wrong thing to read. Resolved to a name here, and
     * left as it was stored when no actor matches — a person who has since
     * been removed still published that version.
     */
    `select v.id, v.version, v.blueprint, v.published_at,
            coalesce(a.display_name, v.published_by) as published_by,
            (select count(*)::int from instance i where i.process_version_id = v.id) as records
       from process_version v
       left join actor a
         on v.published_by like 'actor:%'
        and a.id::text = split_part(v.published_by, ':', 2)
        and a.tenant_id = v.tenant_id
      where v.tenant_id = $1 and v.process_key = $2
      order by v.version asc`,
    [principal.tenantId, processKey],
  );

  const out = rows.map((row, i) => ({
    version: row.version,
    publishedAt: row.published_at.toISOString(),
    publishedBy: row.published_by,
    records: row.records,
    changes: changesBetween(i === 0 ? null : rows[i - 1]!.blueprint, row.blueprint),
  }));

  return out.reverse();
}
