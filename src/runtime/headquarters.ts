/**
 * Headquarters over National workspaces.
 *
 * A worldwide church is a group: one workspace is its International
 * Headquarters, and each National Church is its own workspace with its own
 * districts, stations, people, offices and request types. A National joins
 * by mutual consent: Headquarters issues a one-time code, and the National's
 * owner enters it. Headquarters can then see consolidated figures, set rules
 * every National must follow, and decide requests a rule escalates to it.
 *
 * Isolation is the default. Nationals never see one another. A person at
 * Headquarters reaches a National only through an explicit grant (view,
 * records, policies, escalations, manage), and every read of a National's
 * record is written to both workspaces' audit trails, so a National can see
 * when Headquarters opened its records.
 */
import { createHash, randomBytes } from 'node:crypto';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import type { Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { objectStore } from './object-store.js';

export const HQ_PERMISSIONS = ['view', 'records', 'policies', 'escalations', 'manage'] as const;
export type HqPermission = (typeof HQ_PERMISSIONS)[number];
const UUID = /^[0-9a-f-]{36}$/;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

interface Me { tenantId: string; actorId: string; role: string; email: string }
async function me(pool: Pool | Client, principal: Principal): Promise<Me> {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  const { rows } = await pool.query<{ workspace_role: string; active: boolean; email: string }>('select workspace_role, active, email from actor where id = $1 and tenant_id = $2', [principal.actorId, principal.tenantId]);
  if (!rows[0]?.active || ['pre_hire', 'auditor'].includes(rows[0].workspace_role)) throw new InvalidInput('your workspace access is not active');
  return { tenantId: principal.tenantId, actorId: principal.actorId, role: rows[0].workspace_role, email: rows[0].email };
}

interface Hq extends Me { groupId: string; groupName: string; perms: Set<HqPermission> }
/** The caller as a person at Headquarters, with what they may do across the Nationals. */
async function hq(pool: Pool | Client, principal: Principal, need: HqPermission | HqPermission[]): Promise<Hq> {
  const m = await me(pool, principal);
  const { rows } = await pool.query<{ id: string; name: string }>('select id, name from church_group where hq_tenant_id = $1', [m.tenantId]);
  if (!rows[0]) throw new InvalidInput('this workspace is not a headquarters');
  let perms: Set<HqPermission>;
  if (['owner', 'admin'].includes(m.role)) perms = new Set(HQ_PERMISSIONS);
  else {
    const { rows: g } = await pool.query<{ permissions: string[] }>('select permissions from group_grant where group_id = $1 and actor_id = $2', [rows[0].id, m.actorId]);
    perms = new Set((g[0]?.permissions ?? []) as HqPermission[]);
  }
  const needs = Array.isArray(need) ? need : [need];
  if (!needs.some((n) => perms.has(n))) throw new InvalidInput(`you need the ${needs.join(' or ')} permission at Headquarters for this`);
  return { ...m, groupId: rows[0].id, groupName: rows[0].name, perms };
}
/** A National in this group, or refuse: Headquarters reaches only its own Nationals. */
async function national(pool: Pool | Client, h: Hq, tenantId: string) {
  if (!UUID.test(tenantId)) throw new InvalidInput('no such National');
  const { rows } = await pool.query<{ id: string; name: string; group_label: string | null }>('select id, name, group_label from tenant where id = $1 and group_id = $2', [tenantId, h.groupId]);
  if (!rows[0]) throw new InvalidInput('no such National in this group');
  return rows[0];
}
/** Recorded on both sides: Headquarters did it, and the National can see it was done. */
async function auditBoth(client: Client | Pool, h: Hq, nationalTenant: string | null, action: string, targetId: string | null, detail: Record<string, unknown> = {}) {
  await recordWorkspaceAudit(client, { tenantId: h.tenantId, actorId: h.actorId, action: `headquarters.${action}`, targetId, detail: { ...detail, national: nationalTenant } });
  if (nationalTenant) await recordWorkspaceAudit(client, { tenantId: nationalTenant, actorId: null, action: `headquarters.${action}`, targetId, detail: { ...detail, by: h.email, headquarters: h.groupName } });
}

// --------------------------------------------------------------- status

/** What this workspace is in the group: a headquarters, a National, or neither. */
export async function hqStatus(pool: Pool, principal: Principal) {
  const m = await me(pool, principal);
  const { rows: asHq } = await pool.query<{ id: string; name: string }>('select id, name from church_group where hq_tenant_id = $1', [m.tenantId]);
  if (asHq[0]) {
    let perms: string[] = [...HQ_PERMISSIONS];
    if (!['owner', 'admin'].includes(m.role)) {
      const { rows: g } = await pool.query<{ permissions: string[] }>('select permissions from group_grant where group_id = $1 and actor_id = $2', [asHq[0].id, m.actorId]);
      perms = g[0]?.permissions ?? [];
    }
    return { role: 'headquarters' as const, group: asHq[0], permissions: perms, canAdminister: ['owner', 'admin'].includes(m.role) };
  }
  const { rows: asNat } = await pool.query<{ group_id: string | null; group_label: string | null; group_joined_at: Date | null; name: string; hq: string | null }>(
    `select t.group_id, t.group_label, t.group_joined_at, g.name, h.name as hq from tenant t left join church_group g on g.id = t.group_id left join tenant h on h.id = g.hq_tenant_id where t.id = $1`, [m.tenantId]);
  const n = asNat[0]!;
  if (n.group_id) {
    const { rows: rules } = await pool.query('select id, kind, name, applies, document from group_rule where group_id = $1 and active order by kind, name', [n.group_id]);
    return { role: 'national' as const, group: { id: n.group_id, name: n.name }, label: n.group_label, headquarters: n.hq, joinedAt: n.group_joined_at, rules, canAdminister: m.role === 'owner' };
  }
  return { role: 'none' as const, canAdminister: ['owner', 'admin'].includes(m.role), isOwner: m.role === 'owner' };
}

// ------------------------------------------------------------ the group

export async function createGroup(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const m = await me(pool, principal);
  if (!['owner', 'admin'].includes(m.role)) throw new InvalidInput('only a workspace owner or admin can make this workspace a headquarters');
  const name = text(body.name, 120); if (!name) throw new InvalidInput('name the church, as the whole world knows it');
  return inTransaction(pool, async (client) => {
    await client.query('select id from tenant where id = $1 for update', [m.tenantId]);
    const { rows: t } = await client.query<{ group_id: string | null }>('select group_id from tenant where id = $1', [m.tenantId]);
    if (t[0]?.group_id) throw new InvalidInput('this workspace is a National in a group; it cannot also be a headquarters');
    const { rows: had } = await client.query('select 1 from church_group where hq_tenant_id = $1', [m.tenantId]);
    if (had.length) throw new InvalidInput('this workspace is already a headquarters');
    const { rows } = await client.query<{ id: string }>('insert into church_group (name, hq_tenant_id, created_by) values ($1, $2, $3) returning id', [name, m.tenantId, m.actorId]);
    await recordWorkspaceAudit(client, { tenantId: m.tenantId, actorId: m.actorId, action: 'headquarters.created', targetId: rows[0]!.id, detail: { name } });
    return { id: rows[0]!.id };
  });
}

/** A one-time code a National's owner enters to join. Shown once; only its hash is kept. */
export async function inviteNational(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const h = await hq(pool, principal, 'manage');
  const label = text(body.label, 120); if (!label) throw new InvalidInput('name the National, like "Nigeria National"');
  const token = `grp_${randomBytes(18).toString('base64url')}`;
  const { rows } = await pool.query<{ id: string; expires_at: Date }>(
    `insert into group_invite (group_id, label, token_hash, created_by, expires_at) values ($1, $2, $3, $4, now() + interval '14 days') returning id, expires_at`, [h.groupId, label, hash(token), h.actorId]);
  await auditBoth(pool, h, null, 'national_invited', rows[0]!.id, { label });
  return { id: rows[0]!.id, code: token, expiresAt: rows[0]!.expires_at.toISOString() };
}
export async function revokeInvite(pool: Pool, principal: Principal, inviteId: string) {
  const h = await hq(pool, principal, 'manage');
  const { rows } = await pool.query('update group_invite set revoked_at = now() where id = $1 and group_id = $2 and accepted_at is null and revoked_at is null returning id', [inviteId, h.groupId]);
  if (!rows[0]) throw new InvalidInput('no open code with that id');
  await auditBoth(pool, h, null, 'invite_revoked', inviteId);
  return { ok: true };
}

/** The National's owner joins with the code. Their workspace stays theirs; Headquarters gains only what grants allow. */
export async function joinGroup(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const m = await me(pool, principal);
  if (m.role !== 'owner') throw new InvalidInput('only the owner of this workspace can join it to a headquarters');
  const code = text(body.code, 80); if (!code) throw new InvalidInput('enter the code from Headquarters');
  return inTransaction(pool, async (client) => {
    await client.query('select id from tenant where id = $1 for update', [m.tenantId]);
    const { rows: inv } = await client.query<{ id: string; group_id: string; label: string; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null }>('select id, group_id, label, expires_at, accepted_at, revoked_at from group_invite where token_hash = $1 for update', [hash(code)]);
    const i = inv[0];
    if (!i || i.accepted_at || i.revoked_at || i.expires_at < new Date()) throw new InvalidInput('that code is not valid any more; ask Headquarters for a new one');
    const { rows: g } = await client.query<{ hq_tenant_id: string; name: string }>('select hq_tenant_id, name from church_group where id = $1', [i.group_id]);
    if (g[0]!.hq_tenant_id === m.tenantId) throw new InvalidInput('a headquarters cannot join itself');
    const { rows: asHq } = await client.query('select 1 from church_group where hq_tenant_id = $1', [m.tenantId]);
    if (asHq.length) throw new InvalidInput('this workspace is a headquarters; it cannot join another group');
    const { rows: t } = await client.query<{ group_id: string | null }>('select group_id from tenant where id = $1', [m.tenantId]);
    if (t[0]?.group_id) throw new InvalidInput('this workspace already belongs to a headquarters');
    await client.query('update tenant set group_id = $2, group_label = $3, group_joined_at = now() where id = $1', [m.tenantId, i.group_id, i.label]);
    await client.query('update group_invite set accepted_tenant_id = $2, accepted_at = now() where id = $1', [i.id, m.tenantId]);
    await recordWorkspaceAudit(client, { tenantId: m.tenantId, actorId: m.actorId, action: 'headquarters.joined', targetId: i.group_id, detail: { headquarters: g[0]!.name, label: i.label } });
    await recordWorkspaceAudit(client, { tenantId: g[0]!.hq_tenant_id, actorId: null, action: 'headquarters.national_joined', targetId: m.tenantId, detail: { label: i.label, by: m.email } });
    return { groupId: i.group_id, headquarters: g[0]!.name, label: i.label };
  });
}

export async function removeNational(pool: Pool, principal: Principal, tenantId: string) {
  const h = await hq(pool, principal, 'manage');
  const n = await national(pool, h, tenantId);
  await pool.query('update tenant set group_id = null, group_label = null, group_joined_at = null where id = $1', [n.id]);
  await auditBoth(pool, h, n.id, 'national_removed', n.id, { label: n.group_label });
  return { ok: true };
}

// ---------------------------------------------------------------- grants

export async function listAccess(pool: Pool, principal: Principal) {
  const h = await hq(pool, principal, ['manage', 'view']);
  const { rows } = await pool.query(
    `select a.id, a.display_name, a.email, a.workspace_role, coalesce(g.permissions, '{}') as permissions
       from actor a left join group_grant g on g.actor_id = a.id and g.group_id = $2
      where a.tenant_id = $1 and a.active and a.workspace_role not in ('pre_hire', 'auditor') order by a.display_name`, [h.tenantId, h.groupId]);
  const { rows: invites } = await pool.query(`select id, label, created_at, expires_at, accepted_at, revoked_at, accepted_tenant_id from group_invite where group_id = $1 order by created_at desc limit 50`, [h.groupId]);
  return { people: rows.map((r) => ({ ...r, implicit: ['owner', 'admin'].includes(r.workspace_role as string) })), invites, permissions: HQ_PERMISSIONS };
}
export async function setAccess(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const h = await hq(pool, principal, 'manage');
  const actorId = text(body.actorId, 36);
  const { rows } = await pool.query<{ workspace_role: string }>('select workspace_role from actor where id = $1 and tenant_id = $2 and active', [actorId || null, h.tenantId]);
  if (!rows[0]) throw new InvalidInput('choose someone in the Headquarters workspace');
  const permissions = Array.isArray(body.permissions) ? [...new Set(body.permissions.map((p) => text(p, 20)))] : [];
  for (const p of permissions) if (!(HQ_PERMISSIONS as readonly string[]).includes(p)) throw new InvalidInput(`permission must be one of ${HQ_PERMISSIONS.join(', ')}`);
  await pool.query(`insert into group_grant (group_id, actor_id, permissions, granted_by) values ($1, $2, $3, $4)
                    on conflict (group_id, actor_id) do update set permissions = excluded.permissions, granted_by = excluded.granted_by, updated_at = now()`, [h.groupId, actorId, permissions, h.actorId]);
  await auditBoth(pool, h, null, 'access_set', actorId, { permissions });
  return { ok: true };
}

// -------------------------------------------------------------- overview

/** Figures for every National, aggregated: no names, no records. */
export async function hqOverview(pool: Pool, principal: Principal) {
  const h = await hq(pool, principal, 'view');
  const { rows: nats } = await pool.query<{ id: string; name: string; group_label: string | null; group_joined_at: Date }>('select id, name, group_label, group_joined_at from tenant where group_id = $1 order by group_label, name', [h.groupId]);
  const ids = nats.map((n) => n.id);
  const count = async (sql: string) => new Map((await pool.query<{ tenant_id: string; n: number }>(sql, [ids])).rows.map((r) => [r.tenant_id, r.n]));
  const [stations, jurisdictions, members, vacant, open, overdue, decided, escalations, rules] = await Promise.all([
    count(`select u.tenant_id, count(*)::int as n from org_unit u join org_level l on l.id = u.level_id where u.tenant_id = any($1) and u.active and l.is_station group by u.tenant_id`),
    count(`select u.tenant_id, count(*)::int as n from org_unit u join org_level l on l.id = u.level_id where u.tenant_id = any($1) and u.active and not l.is_station group by u.tenant_id`),
    count(`select tenant_id, count(*)::int as n from actor where tenant_id = any($1) and active and workspace_role not in ('pre_hire') group by tenant_id`),
    count(`select u.tenant_id, count(*)::int as n from org_unit u join office_type t on t.tenant_id = u.tenant_id and t.level_id = u.level_id and t.single and t.active and t.kind <> 'unit_head'
            where u.tenant_id = any($1) and u.active and not exists (select 1 from office_holder h where h.unit_id = u.id and h.office_type_id = t.id and h.starts_on <= current_date and (h.ends_on is null or h.ends_on > current_date)) group by u.tenant_id`),
    count(`select tenant_id, count(*)::int as n from general_request where tenant_id = any($1) and status = 'pending' group by tenant_id`),
    count(`select tenant_id, count(*)::int as n from general_request where tenant_id = any($1) and status = 'pending' and submitted_at < now() - interval '7 days' group by tenant_id`),
    count(`select tenant_id, count(*)::int as n from general_request where tenant_id = any($1) and status in ('approved', 'rejected') and updated_at > now() - interval '30 days' group by tenant_id`),
    count(`select s.tenant_id, count(*)::int as n from general_request_step s where s.tenant_id = any($1) and s.hq and s.status = 'pending' group by s.tenant_id`),
    pool.query<{ n: number }>('select count(*)::int as n from group_rule where group_id = $1 and active', [h.groupId]),
  ]);
  const rows = nats.map((n) => ({ id: n.id, label: n.group_label ?? n.name, workspace: n.name, joinedAt: n.group_joined_at, stations: stations.get(n.id) ?? 0, jurisdictions: jurisdictions.get(n.id) ?? 0, members: members.get(n.id) ?? 0, vacant: vacant.get(n.id) ?? 0, open: open.get(n.id) ?? 0, overdue: overdue.get(n.id) ?? 0, decided30: decided.get(n.id) ?? 0, escalations: escalations.get(n.id) ?? 0 }));
  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
  return { group: { id: h.groupId, name: h.groupName }, permissions: [...h.perms], nationals: rows, totals: { nationals: rows.length, stations: sum('stations'), members: sum('members'), vacant: sum('vacant'), open: sum('open'), overdue: sum('overdue'), escalations: sum('escalations'), rules: rules.rows[0]!.n } };
}

// ----------------------------------------------------------------- rules

export interface GroupRule { id: string; kind: 'escalate' | 'require_document'; name: string; applies: { typeSeed?: string; category?: string; minAmount?: number }; document: string | null }
export async function listRules(pool: Pool, principal: Principal) {
  const h = await hq(pool, principal, ['policies', 'view', 'escalations']);
  const { rows } = await pool.query('select id, kind, name, applies, document, active, updated_at from group_rule where group_id = $1 order by active desc, kind, name', [h.groupId]);
  return rows;
}
export async function saveRule(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const h = await hq(pool, principal, 'policies');
  const kind = text(body.kind, 20);
  if (!['escalate', 'require_document'].includes(kind)) throw new InvalidInput('a rule escalates to Headquarters or requires a document');
  const name = text(body.name, 120); if (!name) throw new InvalidInput('name the rule');
  const a = (body.applies ?? {}) as Record<string, unknown>;
  const applies: GroupRule['applies'] = {};
  if (text(a.typeSeed, 60)) applies.typeSeed = text(a.typeSeed, 60);
  if (text(a.category, 60)) applies.category = text(a.category, 60);
  if (a.minAmount !== undefined && a.minAmount !== null && a.minAmount !== '') { const n = Number(a.minAmount); if (!(n >= 0)) throw new InvalidInput('the amount must be a number'); applies.minAmount = n; }
  if (!applies.typeSeed && !applies.category && applies.minAmount === undefined) throw new InvalidInput('say which requests the rule covers: a category, a request type or an amount');
  const document = kind === 'require_document' ? text(body.document, 100) : null;
  if (kind === 'require_document' && !document) throw new InvalidInput('name the document Headquarters requires');
  const id = text(body.id, 36);
  if (id) {
    const { rows } = await pool.query('update group_rule set kind = $3, name = $4, applies = $5, document = $6, active = $7, updated_at = now() where id = $1 and group_id = $2 returning id', [id, h.groupId, kind, name, JSON.stringify(applies), document, body.active !== false]);
    if (!rows[0]) throw new InvalidInput('no such rule');
  } else await pool.query('insert into group_rule (group_id, kind, name, applies, document, created_by) values ($1, $2, $3, $4, $5, $6)', [h.groupId, kind, name, JSON.stringify(applies), document, h.actorId]);
  await auditBoth(pool, h, null, 'rule_saved', id || null, { kind, name, applies });
  return { ok: true };
}

/** The active rules a National must follow (none when it is not in a group). */
export async function rulesForTenant(client: Client | Pool, tenantId: string): Promise<(GroupRule & { groupId: string })[]> {
  const { rows } = await client.query<GroupRule & { groupId: string }>(
    `select r.id, r.kind, r.name, r.applies, r.document, r.group_id as "groupId" from group_rule r join tenant t on t.group_id = r.group_id where t.id = $1 and r.active`, [tenantId]);
  return rows;
}
/** Does a rule cover this request? Category and type by name/seed; an amount needs the type's amount question. */
export function ruleCovers(rule: GroupRule, type: { seed_key?: string | null; amount_field?: string | null }, category: string | null, answers: Record<string, unknown>): boolean {
  const a = rule.applies ?? {};
  if (a.typeSeed && a.typeSeed !== type.seed_key) return false;
  if (a.category && a.category.toLowerCase() !== (category ?? '').toLowerCase()) return false;
  if (a.minAmount !== undefined) {
    if (!type.amount_field) return false;
    const n = Number(answers[type.amount_field]);
    if (!Number.isFinite(n) || n < a.minAmount) return false;
  }
  return true;
}
/** Everyone at Headquarters who may decide escalations. */
export async function hqDeciders(client: Client | Pool, groupId: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `select a.id from church_group g join actor a on a.tenant_id = g.hq_tenant_id and a.active
      left join group_grant gg on gg.group_id = g.id and gg.actor_id = a.id
      where g.id = $1 and (a.workspace_role in ('owner', 'admin') or 'escalations' = any(coalesce(gg.permissions, '{}'))) order by a.display_name`, [groupId]);
  return rows.map((r) => r.id);
}

// -------------------------------------------------- records and escalations

/** A National's requests, for someone at Headquarters with the records permission. */
export async function nationalRequests(pool: Pool, principal: Principal, tenantId: string) {
  const h = await hq(pool, principal, 'records');
  const n = await national(pool, h, tenantId);
  const { rows } = await pool.query(
    `select r.id, r.title, r.status, r.submitted_at, r.updated_at, t.name as type_name, c.name as category, a.display_name as requester
       from general_request r join general_request_type t on t.id = r.type_id left join general_request_category c on c.id = t.category_id join actor a on a.id = r.requester_id
      where r.tenant_id = $1 and r.status <> 'draft' order by r.updated_at desc limit 200`, [n.id]);
  await auditBoth(pool, h, n.id, 'records_listed', n.id, { count: rows.length });
  return { national: { id: n.id, label: n.group_label ?? n.name }, requests: rows };
}

/** Requests waiting for Headquarters, across every National. */
export async function listEscalations(pool: Pool, principal: Principal) {
  const h = await hq(pool, principal, ['escalations', 'records']);
  const { rows } = await pool.query(
    `select r.id, r.title, r.submitted_at, r.updated_at, s.opened_at, t.name as type_name, c.name as category, a.display_name as requester, tn.id as tenant_id, coalesce(tn.group_label, tn.name) as national,
            ($2 = any(s.approvers) and not exists (select 1 from general_request_vote v where v.step_id = s.id and v.actor_id = $2)) as mine
       from general_request_step s join general_request r on r.id = s.request_id and r.round = s.round join tenant tn on tn.id = s.tenant_id and tn.group_id = $1
       join general_request_type t on t.id = r.type_id left join general_request_category c on c.id = t.category_id join actor a on a.id = r.requester_id
      where s.hq and s.status = 'pending' order by s.opened_at`, [h.groupId, h.actorId]);
  return rows;
}

async function requestInGroup(client: Client | Pool, h: Hq, requestId: string) {
  if (!UUID.test(requestId)) throw new InvalidInput('no such request');
  const { rows } = await client.query<{ id: string; tenant_id: string; title: string; status: string; round: number; answers: Record<string, unknown>; requester_id: string; type_snapshot: unknown; national: string }>(
    `select r.id, r.tenant_id, r.title, r.status, r.round, r.answers, r.requester_id, r.type_snapshot, coalesce(t.group_label, t.name) as national
       from general_request r join tenant t on t.id = r.tenant_id where r.id = $1 and t.group_id = $2`, [requestId, h.groupId]);
  if (!rows[0]) throw new InvalidInput('no such request in this group');
  return rows[0];
}

/** The full request, for deciding an escalation or reviewing records. Recorded in the National's audit trail. */
export async function escalationDetail(pool: Pool, principal: Principal, requestId: string) {
  const h = await hq(pool, principal, ['escalations', 'records']);
  const r = await requestInGroup(pool, h, requestId);
  const [steps, files, events, requester] = await Promise.all([
    pool.query(`select s.id, s.round, s.position, s.stage, s.name, s.status, s.required, s.note, s.hq, (select count(*)::int from general_request_vote v where v.step_id = s.id and v.decision = 'approve') as approvals,
                       (select coalesce(json_agg(json_build_object('name', a.display_name, 'decision', v.decision, 'note', v.note) order by v.created_at), '[]') from general_request_vote v join actor a on a.id = v.actor_id where v.step_id = s.id) as votes,
                       ($2 = any(s.approvers) and s.status = 'pending' and not exists (select 1 from general_request_vote v where v.step_id = s.id and v.actor_id = $2)) as mine
                  from general_request_step s where s.request_id = $1 and s.round = (select round from general_request where id = $1) order by s.position`, [requestId, h.actorId]),
    pool.query('select id, filename, byte_size, document_key, created_at from general_request_file where request_id = $1 order by created_at', [requestId]),
    pool.query(`select e.kind, e.detail, e.created_at, a.display_name as actor from general_request_event e left join actor a on a.id = e.actor_id where e.request_id = $1 order by e.id desc limit 50`, [requestId]),
    pool.query<{ display_name: string }>('select display_name from actor where id = $1', [r.requester_id]),
  ]);
  await auditBoth(pool, h, r.tenant_id, 'request_opened', requestId, { title: r.title });
  return { request: { id: r.id, title: r.title, status: r.status, answers: r.answers, national: r.national, requester: requester.rows[0]?.display_name ?? null }, type: r.type_snapshot, steps: steps.rows, files: files.rows, events: events.rows, canDecide: (steps.rows as { mine: boolean; hq: boolean }[]).some((s) => s.mine && s.hq) && h.perms.has('escalations') };
}

export async function escalationFileLink(pool: Pool, principal: Principal, requestId: string, fileId: string) {
  const h = await hq(pool, principal, ['escalations', 'records']);
  const r = await requestInGroup(pool, h, requestId);
  const { rows } = await pool.query<{ filename: string; storage_key: string }>('select filename, storage_key from general_request_file where id = $1 and request_id = $2', [fileId, r.id]);
  if (!rows[0]) throw new InvalidInput('no such file');
  const store = objectStore(); const scan = await store.scan(rows[0].storage_key);
  if (scan !== 'clean') throw new InvalidInput(scan === 'scanning' ? 'The file is still being checked. Try again shortly.' : 'The file did not pass its malware check.');
  await auditBoth(pool, h, r.tenant_id, 'file_opened', fileId, { request: r.id, filename: rows[0].filename });
  return { url: await store.link(rows[0].storage_key, { filename: rows[0].filename, contentType: 'application/octet-stream' }), filename: rows[0].filename };
}

/** Headquarters decides the review a rule escalated to it. */
export async function decideEscalation(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const h = await hq(pool, principal, 'escalations');
  const decision = text(body.decision, 10); const note = text(body.note, 2000);
  if (!['approve', 'reject', 'return'].includes(decision)) throw new InvalidInput('choose approve, reject or return');
  if (decision !== 'approve' && !note) throw new InvalidInput('explain why, for the National and the requester');
  return inTransaction(pool, async (client) => {
    const r = await requestInGroup(client, h, requestId);
    await client.query('select id from general_request where id = $1 for update', [r.id]);
    if (r.status !== 'pending') throw new InvalidInput('this request is not waiting for a decision');
    const { rows } = await client.query<{ id: number; required: number; name: string }>(
      `select s.id, s.required, s.name from general_request_step s where s.request_id = $1 and s.round = $2 and s.hq and s.status = 'pending' and $3 = any(s.approvers)
          and not exists (select 1 from general_request_vote v where v.step_id = s.id and v.actor_id = $3) for update`, [r.id, r.round, h.actorId]);
    const step = rows[0]; if (!step) throw new InvalidInput('you are not a named decider for this Headquarters review');
    await client.query('insert into general_request_vote (step_id, actor_id, decision, note) values ($1, $2, $3, $4)', [step.id, h.actorId, decision, note || null]);
    const ev = (kind: string, detail: Record<string, unknown>) => client.query('insert into general_request_event (tenant_id, request_id, actor_id, kind, detail) values ($1, $2, $3, $4, $5)', [r.tenant_id, r.id, h.actorId, kind, JSON.stringify(detail)]);
    await ev('decision', { step: step.name, decision, note, headquarters: h.groupName });
    await auditBoth(client, h, r.tenant_id, 'escalation_decided', r.id, { decision });
    if (decision !== 'approve') {
      const status = decision === 'return' ? 'returned' : 'rejected';
      await client.query('update general_request_step set status = $2, closed_at = now() where id = $1', [step.id, status]);
      await client.query(`update general_request_step set status = 'closed', closed_at = now() where request_id = $1 and round = $2 and status in ('pending', 'waiting')`, [r.id, r.round]);
      await client.query('update general_request set status = $2, updated_at = now() where id = $1', [r.id, status]);
      return { id: r.id, status };
    }
    const { rows: votes } = await client.query<{ n: number }>("select count(*)::int as n from general_request_vote where step_id = $1 and decision = 'approve'", [step.id]);
    if (votes[0]!.n < step.required) return { id: r.id, status: 'pending' };
    await client.query("update general_request_step set status = 'approved', closed_at = now() where id = $1", [step.id]);
    const { rows: left } = await client.query<{ n: number }>(`select count(*)::int as n from general_request_step where request_id = $1 and round = $2 and status in ('pending', 'waiting')`, [r.id, r.round]);
    if (left[0]!.n) return { id: r.id, status: 'pending' };
    await client.query("update general_request set status = 'approved', updated_at = now() where id = $1", [r.id]);
    await ev('approved', { by: 'Headquarters' });
    return { id: r.id, status: 'approved' };
  });
}
