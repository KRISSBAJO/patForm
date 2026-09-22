import { Blueprint } from '../blueprint/index.js';
import { validate } from '../compiler/validate.js';
import type { Diagnostic } from '../compiler/diagnostics.js';
import { inTransaction, type Client, type Pool } from './db.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';

/**
 * Process packs — the template marketplace, §21's P2 line.
 *
 * §1.2 states the whole idea as a contrast with what everyone else ships:
 * *"Templates copy a form. Process packs include schema, workflow, messages,
 * documents, dashboard, and policy defaults."*
 *
 * That sentence is the product, so the code has to hold it up. Three things
 * follow from it:
 *
 * **A pack that does not compile cannot be listed.** Publishing runs the same
 * compiler a workspace's own blueprint goes through. Shipping a template that
 * produces errors on install would teach people that the errors are noise —
 * and the compiler being believed is the thing this platform sells.
 *
 * **The contents are computed, never written.** A card claiming "two
 * approvals, a PDF and a dashboard" is derived from the blueprint at publish
 * time, so it cannot drift from what installing actually gives you. A hand-
 * written feature list is marketing; this is a description.
 *
 * **Installing produces a draft, not a published version.** §1.3's "review
 * before publish" does not stop applying because the blueprint came from us.
 * Somebody opens it in the builder, sees what it does, changes the approval
 * thresholds to match their org, and publishes. A pack that went live on
 * install would put a process nobody had read in front of real respondents.
 */

export interface PackContents {
  fields: number;
  states: number;
  approvals: number;
  tasks: number;
  emails: number;
  documents: number;
  metrics: number;
  roles: { key: string; name: string; kind: string }[];
  /** The policy defaults §1.2 names, which are the part a template never carries. */
  /** What a card can draw, rather than describe. */
  preview: {
    flow: { name: string; kind: string }[];
    askedFor: string[];
    deciders: string[];
  };
  policy: {
    sensitivityCeiling: string;
    retentionDays: number | null;
    restrictedFields: number;
    fieldsHiddenFromSomeone: number;
  };
  scenarios: number;
}

export interface PackSummary {
  id: string;
  packKey: string;
  version: number;
  name: string;
  summary: string;
  category: string;
  audience: string;
  contents: PackContents;
  builtIn: boolean;
  publishedBy: string;
  publishedAt: string;
}

/**
 * What is actually in there.
 *
 * Read off the blueprint rather than declared beside it, so the listing and
 * the thing installed cannot disagree. `fieldsHiddenFromSomeone` is the one
 * worth having on a card: a pack where no field is hidden from any role has
 * not thought about who sees what, and that is visible before installing
 * rather than after.
 */
export function describeContents(bp: Blueprint): PackContents {
  const restricted = bp.data.fields.filter((f) => f.classification === 'restricted');
  const hidden = new Set(bp.roles.flatMap((r) => r.hiddenFields ?? []));

  return {
    fields: bp.data.fields.length,
    states: bp.workflow.states.length,
    approvals: bp.workflow.approvals.length,
    tasks: bp.workflow.tasks.length,
    emails: bp.communications.email.length,
    documents: bp.outputs.documents.length,
    metrics: bp.outputs.dashboard.metrics.length,
    roles: bp.roles.map((r) => ({ key: r.key, name: r.name, kind: r.kind })),
    policy: {
      sensitivityCeiling: bp.intent.sensitivityCeiling,
      retentionDays: bp.intent.retentionDays ?? null,
      restrictedFields: restricted.length,
      fieldsHiddenFromSomeone: hidden.size,
    },
    scenarios: bp.tests.length,
    /*
     * Enough to draw the pack rather than describe it.
     *
     * A card that is only words makes somebody read nine of them to compare
     * two packs. These three give it something to *show*: the path a record
     * takes, what the form actually asks, and who is waiting on it — all read
     * from the blueprint, so a preview cannot depict a process the pack does
     * not contain.
     */
    preview: {
      flow: orderedStates(bp),
      askedFor: bp.data.fields
        .filter((f) => (f.setBy ?? 'respondent') === 'respondent' && f.type !== 'content')
        .slice(0, 5)
        .map((f) => f.label),
      deciders: bp.workflow.approvals.map((a) => a.name),
    },
  };
}

/**
 * The states in the order a record meets them.
 *
 * Walked from the initial state rather than taken as declared, because a
 * blueprint may list them in any order and a preview that shows "rejected"
 * before "in review" is worse than no preview.
 */
function orderedStates(bp: Blueprint): { name: string; kind: string }[] {
  const byKey = new Map(bp.workflow.states.map((s) => [s.key, s]));
  const next = new Map<string, string[]>();
  for (const t of bp.workflow.transitions) {
    if (t.from === t.to) continue; // a timer loop is not progress
    next.set(t.from, [...(next.get(t.from) ?? []), t.to]);
  }

  const start = bp.workflow.states.find((s) => s.type === 'initial');
  const out: { name: string; kind: string }[] = [];
  const seen = new Set<string>();
  const queue = start ? [start.key] : [];

  while (queue.length && out.length < 8) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const state = byKey.get(key);
    if (!state) continue;
    out.push({
      name: state.publicLabel ?? state.name,
      kind: state.type === 'terminal' ? (state.outcome ?? 'terminal') : state.type,
    });
    // Breadth first, and success before refusal, so the happy path leads.
    const onward = (next.get(key) ?? []).sort((a, b) => {
      const rank = (k: string) => (byKey.get(k)?.type === 'terminal' ? 1 : 0);
      return rank(a) - rank(b);
    });
    queue.push(...onward);
  }

  return out;
}

// ----------------------------------------------------------------- publish

export async function publishPack(
  pool: Pool,
  args: {
    principal: Principal | 'system';
    packKey: string;
    name: string;
    summary: string;
    category: string;
    audience?: string;
    blueprint: unknown;
    /** A built-in pack is visible to every workspace. */
    builtIn?: boolean;
  },
): Promise<{ id: string; version: number; diagnostics: Diagnostic[] }> {
  let tenantId: string | null = null;
  let publishedBy = 'system';

  if (args.principal !== 'system') {
    await requireWorkspaceCapability(pool, args.principal, 'administer', 'packs');
    if (args.principal.kind !== 'actor') throw new Error('unreachable');
    tenantId = args.builtIn ? null : args.principal.tenantId;
    publishedBy = `actor:${args.principal.actorId}`;
  }

  const parsed = Blueprint.safeParse(args.blueprint);
  if (!parsed.success) {
    throw new Error(`that is not a blueprint: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }

  /*
   * The same compiler, not a lighter one.
   *
   * A pack that ships with errors would be a published statement that the
   * compiler's output is ignorable. Warnings are allowed through — they are
   * judgements, and a pack author may have answered one — but they travel
   * with the pack so an installer sees what was accepted on their behalf.
   */
  const compiled = validate(parsed.data);
  if (!compiled.publishable) {
    const first = compiled.errors[0];
    throw new Error(
      `a pack must compile: ${compiled.errors.length} error(s), starting with ${first?.code} — ${first?.message}`,
    );
  }

  const { rows: existing } = await pool.query<{ version: number }>(
    `select coalesce(max(version), 0) as version from pack
      where pack_key = $1 and tenant_id is not distinct from $2`,
    [args.packKey, tenantId],
  );
  const version = Number(existing[0]!.version) + 1;

  const { rows } = await pool.query<{ id: string }>(
    `insert into pack (tenant_id, pack_key, version, name, summary, category, audience,
                       blueprint, contents, published_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      tenantId,
      args.packKey,
      version,
      args.name,
      args.summary,
      args.category,
      args.audience ?? '',
      JSON.stringify(parsed.data),
      JSON.stringify(describeContents(parsed.data)),
      publishedBy,
    ],
  );

  return { id: rows[0]!.id, version, diagnostics: compiled.warnings };
}

// ------------------------------------------------------------------ browse

/**
 * The catalogue a workspace sees: built-in packs and its own.
 *
 * Only the newest version of each key. A marketplace that lists every version
 * of everything is a changelog, and nobody installs from a changelog.
 */
export async function listPacks(
  pool: Pool,
  args: { principal: Principal; category?: string; search?: string },
): Promise<PackSummary[]> {
  if (args.principal.kind !== 'actor') throw new Error('signed-in members only');

  const { rows } = await pool.query<{
    id: string;
    tenant_id: string | null;
    pack_key: string;
    version: number;
    name: string;
    summary: string;
    category: string;
    audience: string;
    contents: PackContents;
    published_by: string;
    published_at: Date;
  }>(
    `select distinct on (pack_key, tenant_id)
            id, tenant_id, pack_key, version, name, summary, category, audience,
            contents, published_by, published_at
       from pack
      where withdrawn_at is null
        and (tenant_id is null or tenant_id = $1)
        and ($2::text is null or category = $2)
        and ($3::text is null or name ilike '%' || $3 || '%' or summary ilike '%' || $3 || '%'
             or audience ilike '%' || $3 || '%')
      order by pack_key, tenant_id, version desc`,
    [args.principal.tenantId, args.category ?? null, args.search ?? null],
  );

  return rows.map((r) => ({
    id: r.id,
    packKey: r.pack_key,
    version: r.version,
    name: r.name,
    summary: r.summary,
    category: r.category,
    audience: r.audience,
    contents: r.contents,
    builtIn: r.tenant_id === null,
    publishedBy: r.published_by,
    publishedAt: r.published_at.toISOString(),
  }));
}

export async function readPack(
  pool: Pool,
  args: { principal: Principal; packId: string },
): Promise<PackSummary & { blueprint: Blueprint; warnings: Diagnostic[] }> {
  if (args.principal.kind !== 'actor') throw new Error('signed-in members only');
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string | null;
    pack_key: string;
    version: number;
    name: string;
    summary: string;
    category: string;
    audience: string;
    contents: PackContents;
    blueprint: Blueprint;
    published_by: string;
    published_at: Date;
  }>(
    `select * from pack
      where id = $1 and withdrawn_at is null and (tenant_id is null or tenant_id = $2)`,
    [args.packId, args.principal.tenantId],
  );
  const pack = rows[0];
  if (!pack) throw new Error('no such pack');

  // Re-validated on read, not trusted from publish time. A compiler rule added
  // since should surface here rather than at install.
  const compiled = validate(pack.blueprint);

  return {
    id: pack.id,
    packKey: pack.pack_key,
    version: pack.version,
    name: pack.name,
    summary: pack.summary,
    category: pack.category,
    audience: pack.audience,
    contents: pack.contents,
    builtIn: pack.tenant_id === null,
    publishedBy: pack.published_by,
    publishedAt: pack.published_at.toISOString(),
    blueprint: pack.blueprint,
    warnings: compiled.items,
  };
}

// ----------------------------------------------------------------- install

export interface Installation {
  draftId: string;
  processKey: string;
  packName: string;
  packVersion: number;
  /** Anything the installer should read before publishing. */
  warnings: Diagnostic[];
}

/**
 * Installs a pack as a draft.
 *
 * Not as a published version, and the difference is the product's own
 * principle: §1.3, "review before publish. Generated systems must be
 * understandable and editable." A pack is a generated system that somebody
 * else generated, which makes reviewing it more important rather than less.
 *
 * So this puts it in the builder, where the diagnostics panel is already
 * pointed at it, and the person who installed it decides when it goes live.
 */
export async function installPack(
  pool: Pool,
  args: { principal: Principal; packId: string; processKey: string; name?: string },
): Promise<Installation> {
  await requireWorkspaceCapability(pool, args.principal, 'administer', 'packs');
  if (args.principal.kind !== 'actor') throw new Error('unreachable');
  const tenantId = args.principal.tenantId;

  if (!/^[a-z][a-z0-9_]{2,}$/.test(args.processKey)) {
    throw new Error('a process key is lowercase letters, digits and underscores, at least three characters');
  }

  const pack = await readPack(pool, { principal: args.principal, packId: args.packId });

  const { rows: clash } = await pool.query(
    `select 1 from process_version where tenant_id = $1 and process_key = $2
      union all
     select 1 from process_draft where tenant_id = $1 and process_key = $2 and published_as is null`,
    [tenantId, args.processKey],
  );
  if (clash.length) throw new Error(`"${args.processKey}" already exists in this workspace`);

  const blueprint = {
    ...pack.blueprint,
    key: args.processKey,
    name: args.name ?? pack.blueprint.name,
  };

  return inTransaction(pool, async (client: Client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into process_draft (tenant_id, process_key, based_on_version, blueprint, created_by)
       values ($1, $2, null, $3, $4) returning id`,
      [tenantId, args.processKey, JSON.stringify(blueprint), `actor:${args.principal.kind === 'actor' ? args.principal.actorId : 'system'}`],
    );
    const draftId = rows[0]!.id;

    // Where it came from, so a process can answer "why is it like this?" and
    // so a fix to the pack can find the workspaces that took the old one.
    await client.query(
      `insert into pack_install (tenant_id, pack_id, process_key, draft_id, installed_by)
       values ($1, $2, $3, $4, $5)`,
      [tenantId, pack.id, args.processKey, draftId, `actor:${args.principal.kind === 'actor' ? args.principal.actorId : 'system'}`],
    );

    return {
      draftId,
      processKey: args.processKey,
      packName: pack.name,
      packVersion: pack.version,
      warnings: pack.warnings,
    };
  });
}

/** What this workspace has taken, and from which version. */
export async function listInstalls(pool: Pool, principal: Principal) {
  if (principal.kind !== 'actor') throw new Error('signed-in members only');
  const { rows } = await pool.query(
    `select i.process_key, i.installed_at, i.installed_by, p.name as pack_name, p.pack_key, p.version,
            (select max(version) from pack p2
              where p2.pack_key = p.pack_key and p2.tenant_id is not distinct from p.tenant_id
                and p2.withdrawn_at is null) as latest_version
       from pack_install i join pack p on p.id = i.pack_id
      where i.tenant_id = $1 order by i.installed_at desc`,
    [principal.tenantId],
  );
  return rows;
}

export async function withdrawPack(
  pool: Pool,
  args: { principal: Principal; packId: string },
): Promise<{ withdrawn: boolean }> {
  await requireWorkspaceCapability(pool, args.principal, 'administer', 'packs');
  if (args.principal.kind !== 'actor') throw new Error('unreachable');
  // Withdrawn, never deleted: a workspace that installed it keeps being able
  // to see where its process came from.
  const { rowCount } = await pool.query(
    'update pack set withdrawn_at = now() where id = $1 and tenant_id = $2 and withdrawn_at is null',
    [args.packId, args.principal.tenantId],
  );
  return { withdrawn: (rowCount ?? 0) > 0 };
}
