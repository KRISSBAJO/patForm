import { Blueprint } from '../blueprint/index.js';
import { validate } from '../compiler/validate.js';
import type { Diagnostic } from '../compiler/diagnostics.js';
import { inTransaction, type Pool } from './db.js';
import { require_, requireWorkspaceCapability, type Principal } from './policy.js';
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
  if (principal.kind !== 'actor') throw new Error('the builder is for signed-in members');

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
    [draftId, principal.tenantId],
  );
  const row = rows[0];
  if (!row) throw new Error('no such draft');

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
  args: { principal: Principal; draftId: string; blueprint: unknown },
): Promise<{ diagnostics: Diagnostic[]; publishable: boolean; parsed: boolean }> {
  if (args.principal.kind !== 'actor') throw new Error('the builder is for signed-in members');

  const parsed = Blueprint.safeParse(args.blueprint);

  await pool.query(
    'update process_draft set blueprint = $1, updated_at = now() where id = $2 and tenant_id = $3 and published_as is null',
    [JSON.stringify(args.blueprint), args.draftId, args.principal.tenantId],
  );

  if (!parsed.success) {
    return {
      parsed: false,
      publishable: false,
      diagnostics: shapeDiagnostics(parsed.error),
    };
  }

  const compiled = validate(parsed.data);
  return { parsed: true, diagnostics: compiled.items, publishable: compiled.publishable };
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
  args: { principal: Principal; draftId: string },
): Promise<{ version: number; impact: PublishImpact }> {
  if (args.principal.kind !== 'actor') throw new Error('the builder is for signed-in members');

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
  const version = await engine.publish(args.principal.tenantId, draft.blueprint, describe(args.principal));

  await pool.query('update process_draft set published_as = $1, updated_at = now() where id = $2', [
    version.version,
    draft.id,
  ]);

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

  const { rowCount } = await pool.query(
    'delete from process_draft where id = $1 and tenant_id = $2 and published_as is null',
    [args.draftId, principal.tenantId],
  );
  return { discarded: (rowCount ?? 0) > 0 };
}
