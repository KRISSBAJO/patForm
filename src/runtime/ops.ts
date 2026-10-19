/**
 * Assets, IT and service operations (PRD Module 9).
 *
 * The rules that matter most:
 *   - An asset bought through Procurement is registered only against goods
 *     that were received and accepted, one asset per accepted unit
 *     (acceptance 1). Anything bought elsewhere needs its own reference.
 *   - Custody is a history. One physical asset has one holder at a time
 *     unless it is marked shared; returning ends the assignment and keeps it
 *     (OPS-02, acceptance 3).
 *   - An approved access request is still only pending. It becomes access
 *     when the system's connector confirms, or when someone in IT, other
 *     than the person getting access, records evidence (OPS-04, acceptance 2).
 *   - Revocations are their own records. A failed one is a critical
 *     exception that stays listed whatever happens to the HR case (OPS-05).
 *   - Service targets pause while a ticket waits on the requester (OPS-06).
 *   - A maintenance job exists once per plan and date, however often the
 *     scheduler runs (acceptance 4). A failed inspection restricts the asset
 *     and opens corrective work (OPS-07).
 *   - A normal change runs only when approved, inside its window, with its
 *     preconditions met; an emergency change may start at once but needs a
 *     review afterwards by someone else (OPS-08).
 */
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { enabledModules } from './modules.js';
import { managerOf } from './org.js';
import { seal, open as unseal } from './secret-box.js';
import { sign, verify } from './webhooks.js';
import { randomBytes } from 'node:crypto';

const UUID = /^[0-9a-f-]{36}$/;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[, ]/g, '')); return Number.isFinite(n) ? n : NaN; };
const today = () => new Date().toISOString().slice(0, 10);
const HOUR = 3600_000;
function id(v: unknown, what: string): string { const s = text(v, 36); if (!UUID.test(s)) throw new InvalidInput(`${what} must be an id`); return s; }
function day(v: unknown, what: string, required = false): string | null {
  const s = text(v, 10);
  if (!s) { if (required) throw new InvalidInput(`${what} is required`); return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new InvalidInput(`${what} must be a date`);
  return s;
}
function when(v: unknown, what: string): Date | null {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new InvalidInput(`${what} must be a date and time`);
  return d;
}
const list = (v: unknown, max = 40) => (Array.isArray(v) ? v.map((x) => text(x, 200)).filter(Boolean).slice(0, max) : []);

// ------------------------------------------------------------------ access

export type Team = 'it' | 'facilities';
interface Who { tenantId: string; actorId: string; admin: boolean; teams: Team[]; staff: boolean; role: string }
async function who(pool: Pool | Client, principal: Principal): Promise<Who> {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  if (!(await enabledModules(pool as Pool, principal.tenantId)).has('assets')) {
    throw new InvalidInput('the Assets and IT module is switched off for this workspace — an owner can switch it on in Settings');
  }
  const { rows } = await pool.query<{ workspace_role: string; active: boolean }>('select workspace_role, active from actor where id = $1 and tenant_id = $2', [principal.actorId, principal.tenantId]);
  if (!rows[0]?.active || rows[0].workspace_role === 'pre_hire') throw new InvalidInput('this opens after your first day');
  const admin = ['owner', 'admin'].includes(rows[0].workspace_role);
  const { rows: t } = await pool.query<{ team: Team }>("select team from hr_team_member where tenant_id = $1 and actor_id = $2 and team in ('it', 'facilities')", [principal.tenantId, principal.actorId]);
  const teams = t.map((r) => r.team);
  return { tenantId: principal.tenantId, actorId: principal.actorId, admin, teams, staff: admin || teams.length > 0, role: rows[0].workspace_role };
}
const requireStaff = (w: Who) => { if (!w.staff) throw new InvalidInput('only the IT or Facilities team can do this'); };
const requireAdmin = (w: Who) => { if (!w.admin) throw new InvalidInput('only an owner or admin can do this'); };
const inTeam = (w: Who, team: string) => w.admin || w.teams.includes(team as Team);
const requireIt = (w: Who) => { if (!inTeam(w, 'it')) throw new InvalidInput('only the IT team can do this'); };
export const opsWho = who;
export const opsInTeam = inTeam;

async function nextNumber(client: Client, table: 'ticket' | 'access_request' | 'change_request', tenantId: string): Promise<number> {
  await client.query('select pg_advisory_xact_lock(hashtext($1 || $2))', [table, tenantId]);
  const { rows } = await client.query<{ n: number }>(`select coalesce(max(number), 1000) + 1 as n from ${table} where tenant_id = $1`, [tenantId]);
  return rows[0]!.n;
}

// ---------------------------------------------------------------- settings

export interface OpsSettings {
  categories: string[];
  allocationNeedsApproval: boolean;
  captureLocation: boolean;
  pauseWhileWaiting: boolean;
  reopenDays: number;
  /** Hours to respond and to resolve, by priority 1 (highest) to 4. */
  targets: Record<'1' | '2' | '3' | '4', { respond: number; resolve: number }>;
}
export const DEFAULT_OPS: OpsSettings = {
  categories: ['Laptop', 'Phone', 'Monitor', 'Vehicle', 'Furniture', 'Equipment'],
  allocationNeedsApproval: false,
  captureLocation: false,
  pauseWhileWaiting: true,
  reopenDays: 14,
  targets: { 1: { respond: 1, resolve: 4 }, 2: { respond: 4, resolve: 24 }, 3: { respond: 8, resolve: 72 }, 4: { respond: 24, resolve: 120 } },
};
export async function opsSettings(client: Client | Pool, tenantId: string): Promise<OpsSettings> {
  const { rows } = await client.query<{ settings: Partial<OpsSettings> }>('select settings from ops_settings where tenant_id = $1', [tenantId]);
  return { ...DEFAULT_OPS, ...(rows[0]?.settings ?? {}) };
}
export async function readOpsSettings(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query<{ team: string; actor_id: string; display_name: string }>(
    `select m.team, m.actor_id, a.display_name from hr_team_member m join actor a on a.id = m.actor_id where m.tenant_id = $1 and m.team in ('it', 'facilities') order by m.team, a.display_name`, [w.tenantId]);
  return { settings: await opsSettings(pool, w.tenantId), teams: rows, me: { admin: w.admin, teams: w.teams, staff: w.staff } };
}
export async function updateOpsSettings(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireAdmin(w);
  const cur = await opsSettings(pool, w.tenantId);
  const next: OpsSettings = { ...cur };
  if (body.categories !== undefined) { const c = list(body.categories); if (!c.length) throw new InvalidInput('keep at least one asset category'); next.categories = c; }
  for (const k of ['allocationNeedsApproval', 'captureLocation', 'pauseWhileWaiting'] as const) if (body[k] !== undefined) next[k] = body[k] === true;
  if (body.reopenDays !== undefined) { const n = Math.trunc(num(body.reopenDays)); if (!(n >= 0 && n <= 90)) throw new InvalidInput('reopenDays must be 0 to 90'); next.reopenDays = n; }
  if (body.targets !== undefined) {
    const t = body.targets as Record<string, { respond?: unknown; resolve?: unknown }>;
    for (const p of ['1', '2', '3', '4'] as const) {
      if (!t?.[p]) continue;
      const respond = num(t[p].respond); const resolve = num(t[p].resolve);
      if (!(respond > 0 && resolve >= respond)) throw new InvalidInput(`priority ${p}: respond must be above 0 and resolve at least as long`);
      next.targets = { ...next.targets, [p]: { respond, resolve } };
    }
  }
  await pool.query(`insert into ops_settings (tenant_id, settings, updated_by) values ($1, $2, $3) on conflict (tenant_id) do update set settings = excluded.settings, updated_by = excluded.updated_by, updated_at = now()`,
    [w.tenantId, JSON.stringify(next), w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'ops.settings_changed', targetId: w.tenantId, detail: { before: cur, after: next } });
  return next;
}
/** Who is in IT and Facilities. The same teams the HR module uses for its tasks. */
export async function setOpsTeamMember(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireAdmin(w);
  const team = text(body.team, 20);
  if (!['it', 'facilities'].includes(team)) throw new InvalidInput('team must be it or facilities');
  const actorId = id(body.actorId, 'actorId');
  const { rows } = await pool.query('select 1 from actor where id = $1 and tenant_id = $2 and active', [actorId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such member');
  if (body.remove === true) await pool.query('delete from hr_team_member where tenant_id = $1 and team = $2 and actor_id = $3', [w.tenantId, team, actorId]);
  else await pool.query('insert into hr_team_member (tenant_id, team, actor_id) values ($1, $2, $3) on conflict do nothing', [w.tenantId, team, actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: body.remove === true ? 'ops.team_removed' : 'ops.team_added', targetId: actorId, detail: { team } });
  return { team, actorId, member: body.remove !== true };
}

// ------------------------------------------------------------------ photos

const PHOTO = /^ops-photo:([0-9a-f-]{36})$/;
/** Photo references must be uploads to this workspace, for this thing, that did not fail the malware check. */
async function checkPhotos(client: Client | Pool, tenantId: string, refs: string[], where: { jobId?: string; assetId?: string }): Promise<string[]> {
  const ids: string[] = [];
  for (const r of refs) {
    const m = PHOTO.exec(r);
    if (!m) throw new InvalidInput('photos must be uploaded, not typed in');
    ids.push(m[1]!);
  }
  if (!ids.length) return [];
  const { rows } = await client.query<{ id: string; job_id: string | null; asset_id: string | null; scan_status: string }>(
    'select id, job_id, asset_id, scan_status from ops_photo where tenant_id = $1 and id = any($2::uuid[])', [tenantId, ids]);
  for (const id of ids) {
    const p = rows.find((x) => x.id === id);
    if (!p || (where.jobId && p.job_id !== where.jobId) || (where.assetId && p.asset_id !== where.assetId)) throw new InvalidInput('one of the photos does not belong here; upload it again');
    if (p.scan_status === 'quarantined') throw new InvalidInput('one of the photos failed its malware check; remove it');
  }
  return ids;
}
async function photosFor(client: Client | Pool, column: 'asset_id' | 'ticket_id', id: string) {
  const { rows } = await client.query(
    `select p.id, p.filename, p.scan_status, p.job_id, p.assignment_id, p.ticket_id, p.created_at, a.display_name as uploaded_by
       from ops_photo p left join actor a on a.id = p.uploaded_by where p.${column} = $1 order by p.created_at desc limit 100`, [id]);
  return rows;
}

// ------------------------------------------------------------------ assets

async function event(client: Client | Pool, assetId: string, kind: string, actorId: string | null, detail: Record<string, unknown> = {}) {
  await client.query('insert into asset_event (asset_id, kind, detail, actor_id) values ($1, $2, $3, $4)', [assetId, kind, JSON.stringify(detail), actorId]);
}

/** Acceptance 1: received goods that have not all been registered as assets yet. */
export async function awaitingRegistration(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireStaff(w);
  const { rows } = await pool.query<{ line_id: string; order_number: number; description: string; vendor: string; received: string; registered: number; last_received: Date }>(
    `select l.id as line_id, o.number as order_number, l.description, v.name as vendor,
            sum(r.accepted - r.returned) as received, max(r.received_at) as last_received,
            (select count(*)::int from asset a where a.order_line_id = l.id) as registered
       from goods_receipt r join purchase_order_line l on l.id = r.line_id join purchase_order o on o.id = r.order_id join vendor v on v.id = o.vendor_id
      where r.tenant_id = $1 and l.kind = 'goods'
      group by l.id, o.number, l.description, v.name
     having sum(r.accepted - r.returned) > (select count(*) from asset a where a.order_line_id = l.id)
      order by max(r.received_at)`, [w.tenantId]);
  return rows.map((r) => ({ ...r, received: Number(r.received), waiting: Number(r.received) - r.registered }));
}

export async function registerAsset(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireStaff(w);
  const settings = await opsSettings(pool, w.tenantId);
  const tag = text(body.tag, 60); const name = text(body.name, 200); const category = text(body.category, 60);
  if (!tag) throw new InvalidInput('give the asset a tag (the label on it)');
  if (!name) throw new InvalidInput('describe the asset');
  if (!settings.categories.includes(category)) throw new InvalidInput(`category must be one of: ${settings.categories.join(', ')}`);
  const condition = text(body.condition, 10) || 'new';
  if (!['new', 'good', 'fair', 'poor', 'broken'].includes(condition)) throw new InvalidInput('condition must be new, good, fair, poor or broken');
  const orderLineId = body.orderLineId ? id(body.orderLineId, 'orderLineId') : null;
  const acquisitionRef = text(body.acquisitionRef, 200) || null;
  return inTransaction(pool, async (client) => {
    let ref = acquisitionRef;
    if (orderLineId) {
      const { rows } = await client.query<{ kind: string; number: number; tenant_id: string }>(
        `select l.kind, o.number, o.tenant_id from purchase_order_line l join purchase_order o on o.id = l.order_id where l.id = $1 for update of l`, [orderLineId]);
      if (!rows[0] || rows[0].tenant_id !== w.tenantId) throw new InvalidInput('no such order line');
      if (rows[0].kind !== 'goods') throw new InvalidInput('that line is a service, not goods');
      const { rows: q } = await client.query<{ received: string; registered: number }>(
        `select coalesce((select sum(accepted - returned) from goods_receipt where line_id = $1), 0) as received, (select count(*)::int from asset where order_line_id = $1) as registered`, [orderLineId]);
      const received = Number(q[0]!.received);
      if (received <= 0) throw new InvalidInput(`order ${rows[0].number} has not been received yet: record the goods receipt first`);
      if (q[0]!.registered >= received) throw new InvalidInput(`all ${received} received on this line are already registered`);
      ref = ref ?? `PO ${rows[0].number}`;
    } else if (!ref) throw new InvalidInput('give the purchase reference, or register it from a goods receipt');
    const { rows: dup } = await client.query('select 1 from asset where tenant_id = $1 and tag = $2', [w.tenantId, tag]);
    if (dup[0]) throw new InvalidInput(`tag ${tag} is already used`);
    const { rows } = await client.query<{ id: string }>(
      `insert into asset (tenant_id, tag, category, name, serial, owner_entity, location, acquisition_ref, order_line_id, warranty_until, condition, shared, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [w.tenantId, tag, category, name, text(body.serial, 120) || null, text(body.ownerEntity, 120) || null, text(body.location, 200) || null, ref, orderLineId,
        day(body.warrantyUntil, 'warrantyUntil'), condition, body.shared === true, w.actorId]);
    await event(client, rows[0]!.id, 'registered', w.actorId, { tag, ref });
    return { id: rows[0]!.id, tag };
  });
}

export async function listAssets(pool: Pool, principal: Principal, opts: { status?: string; q?: string } = {}) {
  const w = await who(pool, principal);
  const { rows } = await pool.query(
    `select a.id, a.tag, a.category, a.name, a.serial, a.location, a.condition, a.status, a.shared, a.warranty_until::text, a.acquisition_ref, a.restricted_reason, a.owner_entity,
            (select json_agg(json_build_object('id', s.id, 'name', h.display_name, 'status', s.status, 'holderId', s.custodian_id)) from asset_assignment s join actor h on h.id = s.custodian_id
              where s.asset_id = a.id and s.status in ('pending_approval', 'pending_ack', 'active')) as holders,
            (select min(due_on)::text from maintenance_job j where j.asset_id = a.id and j.status = 'open') as maintenance_due
       from asset a
      where a.tenant_id = $1 and ($2 or exists (select 1 from asset_assignment s where s.asset_id = a.id and s.custodian_id = $3 and s.status in ('pending_ack', 'active')))
        and ($4::text is null or a.status = $4) and ($5::text is null or a.tag ilike '%' || $5 || '%' or a.name ilike '%' || $5 || '%' or a.serial ilike '%' || $5 || '%')
      order by a.tag`, [w.tenantId, w.staff, w.actorId, opts.status || null, opts.q || null]);
  return rows;
}

export async function assetDetail(pool: Pool, principal: Principal, assetId: string) {
  const w = await who(pool, principal); requireStaff(w);
  if (!UUID.test(assetId)) throw new InvalidInput('no such asset');
  const { rows } = await pool.query('select *, warranty_until::text from asset where id = $1 and tenant_id = $2', [assetId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such asset');
  const { rows: assignments } = await pool.query(
    `select s.id, s.status, s.condition_out, s.accessories, s.handover_ref, s.acknowledged_at, s.returned_at, s.condition_in, s.accessories_in, s.return_ref, s.created_at, s.case_id,
            h.display_name as holder, b.display_name as assigned_by, p.display_name as approved_by, r.display_name as returned_by
       from asset_assignment s join actor h on h.id = s.custodian_id left join actor b on b.id = s.assigned_by left join actor p on p.id = s.approved_by left join actor r on r.id = s.returned_by
      where s.asset_id = $1 order by s.created_at desc`, [assetId]);
  const { rows: history } = await pool.query(`select e.kind, e.detail, e.occurred_at, a.display_name as actor from asset_event e left join actor a on a.id = e.actor_id where e.asset_id = $1 order by e.id desc`, [assetId]);
  const { rows: jobs } = await pool.query(`select j.id, p.title, j.due_on::text, j.status, j.outcome, j.findings, j.completed_at from maintenance_job j join maintenance_plan p on p.id = j.plan_id where j.asset_id = $1 order by j.due_on desc limit 50`, [assetId]);
  const { rows: tickets } = await pool.query(`select id, number, title, status, kind, created_at from ticket where asset_id = $1 order by created_at desc limit 50`, [assetId]);
  return { asset: rows[0], assignments, history, maintenance: jobs, tickets, photos: await photosFor(pool, 'asset_id', assetId) };
}

export async function updateAsset(pool: Pool, principal: Principal, assetId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireStaff(w);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; location: string | null; condition: string }>('select status, location, condition from asset where id = $1 and tenant_id = $2 for update', [assetId, w.tenantId]);
    const a = rows[0];
    if (!a) throw new InvalidInput('no such asset');
    const changes: Record<string, unknown> = {};
    if (body.location !== undefined) changes.location = text(body.location, 200) || null;
    if (body.condition !== undefined) { const c = text(body.condition, 10); if (!['new', 'good', 'fair', 'poor', 'broken'].includes(c)) throw new InvalidInput('condition must be new, good, fair, poor or broken'); changes.condition = c; }
    if (body.status !== undefined) {
      const s = text(body.status, 20);
      if (!['in_stock', 'in_repair', 'lost', 'retired', 'disposed'].includes(s)) throw new InvalidInput('status must be in_stock, in_repair, lost, retired or disposed');
      const reason = text(body.reason, 500);
      if (!reason) throw new InvalidInput('say why the status is changing');
      const { rows: open } = await client.query("select 1 from asset_assignment where asset_id = $1 and status in ('pending_approval', 'pending_ack', 'active')", [assetId]);
      if (open[0] && s !== 'lost') throw new InvalidInput('someone holds this asset: record the return first');
      if (a.status === 'restricted' && s === 'in_stock') throw new InvalidInput('this asset is restricted after a failed inspection: lift the restriction instead');
      changes.status = s; changes.reason = reason;
    }
    const cols = Object.keys(changes).filter((k) => k !== 'reason');
    if (!cols.length) return { id: assetId };
    await client.query(`update asset set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [assetId, ...cols.map((k) => changes[k])]);
    await event(client, assetId, 'updated', w.actorId, { before: a, after: changes });
    return { id: assetId };
  });
}

/** OPS-02. A hand-out; approved first when the workspace says so, then acknowledged by the holder. */
export async function assignAsset(pool: Pool, principal: Principal, assetId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireStaff(w);
  const custodianId = id(body.custodianId, 'custodianId');
  const settings = await opsSettings(pool, w.tenantId);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; shared: boolean; tag: string; condition: string; restricted_reason: string | null }>(
      'select status, shared, tag, condition, restricted_reason from asset where id = $1 and tenant_id = $2 for update', [assetId, w.tenantId]);
    const a = rows[0];
    if (!a) throw new InvalidInput('no such asset');
    if (a.status === 'restricted') throw new InvalidInput(`${a.tag} is restricted: ${a.restricted_reason ?? 'failed inspection'}`);
    if (!['in_stock', 'assigned'].includes(a.status)) throw new InvalidInput(`${a.tag} is ${a.status.replace('_', ' ')}`);
    const { rows: holder } = await client.query<{ active: boolean; workspace_role: string }>('select active, workspace_role from actor where id = $1 and tenant_id = $2', [custodianId, w.tenantId]);
    if (!holder[0]?.active) throw new InvalidInput('no such member');
    const { rows: open } = await client.query<{ custodian_id: string; name: string }>(
      `select s.custodian_id, h.display_name as name from asset_assignment s join actor h on h.id = s.custodian_id where s.asset_id = $1 and s.status in ('pending_approval', 'pending_ack', 'active')`, [assetId]);
    if (open.some((o) => o.custodian_id === custodianId)) throw new InvalidInput('they already hold this asset');
    if (open.length && !a.shared) throw new InvalidInput(`${a.tag} is already with ${open[0]!.name}; record the return first, or mark the asset as shared`);
    const condition = text(body.condition, 10) || a.condition;
    if (!['new', 'good', 'fair', 'poor', 'broken'].includes(condition)) throw new InvalidInput('condition must be new, good, fair, poor or broken');
    const status = settings.allocationNeedsApproval ? 'pending_approval' : 'pending_ack';
    const { rows: made } = await client.query<{ id: string }>(
      `insert into asset_assignment (asset_id, custodian_id, status, approved_by, assigned_by, condition_out, accessories, handover_ref) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [assetId, custodianId, status, status === 'pending_ack' ? w.actorId : null, w.actorId, condition, JSON.stringify(list(body.accessories)), text(body.handoverRef, 300) || null]);
    const photos = await checkPhotos(client, w.tenantId, list(body.photos, 10), { assetId });
    if (photos.length) await client.query('update ops_photo set assignment_id = $2 where id = any($1::uuid[]) and assignment_id is null', [photos, made[0]!.id]);
    await event(client, assetId, 'assigned', w.actorId, { custodianId, status, accessories: list(body.accessories), photos: photos.length });
    return { id: made[0]!.id, status };
  });
}

export async function approveAssignment(pool: Pool, principal: Principal, assignmentId: string) {
  const w = await who(pool, principal); requireAdmin(w);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ asset_id: string; custodian_id: string; assigned_by: string; status: string }>(
      `select s.asset_id, s.custodian_id, s.assigned_by, s.status from asset_assignment s join asset a on a.id = s.asset_id where s.id = $1 and a.tenant_id = $2 for update of s`, [assignmentId, w.tenantId]);
    const s = rows[0];
    if (!s) throw new InvalidInput('no such hand-out');
    if (s.status !== 'pending_approval') throw new InvalidInput('this hand-out is not waiting for approval');
    if (s.assigned_by === w.actorId || s.custodian_id === w.actorId) throw new InvalidInput('someone other than the person handing it out, and other than the holder, approves');
    await client.query(`update asset_assignment set status = 'pending_ack', approved_by = $2 where id = $1`, [assignmentId, w.actorId]);
    await event(client, s.asset_id, 'assignment_approved', w.actorId, { assignmentId });
    return { id: assignmentId, status: 'pending_ack' };
  });
}

/** The holder confirms receipt, with the condition and accessories as handed over. */
export async function acknowledgeAssignment(pool: Pool, principal: Principal, assignmentId: string) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ asset_id: string; custodian_id: string; status: string; condition_out: string; accessories: string[]; tag: string }>(
      `select s.asset_id, s.custodian_id, s.status, s.condition_out, s.accessories, a.tag from asset_assignment s join asset a on a.id = s.asset_id where s.id = $1 and a.tenant_id = $2 for update of s`, [assignmentId, w.tenantId]);
    const s = rows[0];
    if (!s || s.custodian_id !== w.actorId) throw new InvalidInput('no such hand-out for you');
    if (s.status === 'pending_approval') throw new InvalidInput('this hand-out is still waiting for approval');
    if (s.status !== 'pending_ack') throw new InvalidInput('already acknowledged');
    const statement = `I have received ${s.tag} in ${s.condition_out} condition${s.accessories.length ? `, with ${s.accessories.join(', ')}` : ''}.`;
    await client.query(`update asset_assignment set status = 'active', acknowledged_at = now(), acknowledgement = $2 where id = $1`, [assignmentId, statement]);
    await client.query(`update asset set status = 'assigned', updated_at = now() where id = $1`, [s.asset_id]);
    await event(client, s.asset_id, 'acknowledged', w.actorId, { statement });
    return { statement };
  });
}

/** Acceptance 3: the assignment ends and stays; the asset is free again. */
export async function returnAsset(pool: Pool, principal: Principal, assignmentId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireStaff(w);
  const condition = text(body.condition, 10);
  if (!['new', 'good', 'fair', 'poor', 'broken'].includes(condition)) throw new InvalidInput('record the condition it came back in: new, good, fair, poor or broken');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ asset_id: string; custodian_id: string; status: string; accessories: string[] }>(
      `select s.asset_id, s.custodian_id, s.status, s.accessories from asset_assignment s join asset a on a.id = s.asset_id where s.id = $1 and a.tenant_id = $2 for update of s`, [assignmentId, w.tenantId]);
    const s = rows[0];
    if (!s) throw new InvalidInput('no such hand-out');
    if (!['pending_approval', 'pending_ack', 'active'].includes(s.status)) throw new InvalidInput('this has already been returned');
    await client.query('select 1 from asset where id = $1 for update', [s.asset_id]);
    const back = list(body.accessories);
    const missing = s.accessories.filter((x) => !back.includes(x));
    // Link the return to the person's open offboarding, if there is one.
    const { rows: c } = await client.query<{ id: string }>(
      `select c.id from lifecycle_case c join employee_record e on e.id = c.employee_id
        where c.tenant_id = $1 and e.actor_id = $2 and c.status = 'open' and c.kind in ('offboarding', 'urgent_termination') limit 1`, [w.tenantId, s.custodian_id]);
    const caseId = body.caseId ? id(body.caseId, 'caseId') : c[0]?.id ?? null;
    await client.query(
      `update asset_assignment set status = $2, returned_at = now(), condition_in = $3, accessories_in = $4, return_ref = $5, returned_by = $6, case_id = coalesce(case_id, $7) where id = $1`,
      [assignmentId, s.status === 'active' ? 'returned' : 'cancelled', condition, JSON.stringify(back), text(body.returnRef, 300) || null, w.actorId, caseId]);
    const { rows: still } = await client.query("select 1 from asset_assignment where asset_id = $1 and status in ('pending_approval', 'pending_ack', 'active')", [s.asset_id]);
    await client.query(`update asset set condition = $2, status = case when status = 'assigned' and $3 then 'in_stock' else status end, updated_at = now() where id = $1`, [s.asset_id, condition, !still[0]]);
    const photos = await checkPhotos(client, w.tenantId, list(body.photos, 10), { assetId: s.asset_id });
    if (photos.length) await client.query('update ops_photo set assignment_id = $2 where id = any($1::uuid[]) and assignment_id is null', [photos, assignmentId]);
    await event(client, s.asset_id, 'returned', w.actorId, { assignmentId, condition, missing, caseId, photos: photos.length });
    return { id: assignmentId, missing, caseId };
  });
}

/** What a person still holds; used by HR offboarding before equipment recovery can be marked done. */
export async function openCustody(client: Client | Pool, tenantId: string, actorId: string): Promise<string[]> {
  const { rows } = await client.query<{ tag: string; name: string }>(
    `select a.tag, a.name from asset_assignment s join asset a on a.id = s.asset_id where a.tenant_id = $1 and s.custodian_id = $2 and s.status in ('pending_ack', 'active') order by a.tag`, [tenantId, actorId]);
  return rows.map((r) => `${r.tag} (${r.name})`);
}

export async function myAssets(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query(
    `select s.id as assignment_id, s.status, s.condition_out, s.accessories, s.acknowledged_at, s.acknowledgement, a.id, a.tag, a.name, a.category, a.serial
       from asset_assignment s join asset a on a.id = s.asset_id where a.tenant_id = $1 and s.custodian_id = $2 and s.status in ('pending_approval', 'pending_ack', 'active') order by a.tag`, [w.tenantId, w.actorId]);
  return rows;
}

/** OPS-10: assets with people who have left, are leaving or are deactivated. */
async function recoveryList(pool: Pool | Client, tenantId: string) {
  const { rows } = await pool.query(
    `select s.id as assignment_id, a.id as asset_id, a.tag, a.name, h.display_name as holder, h.active as holder_active, e.end_date::text as end_date,
            (select c.id from lifecycle_case c where c.employee_id = e.id and c.status = 'open' and c.kind in ('offboarding', 'urgent_termination') limit 1) as case_id
       from asset_assignment s join asset a on a.id = s.asset_id join actor h on h.id = s.custodian_id left join employee_record e on e.actor_id = h.id
      where a.tenant_id = $1 and s.status in ('pending_ack', 'active')
        and (not h.active or e.status = 'left' or (e.end_date is not null and e.end_date <= current_date + 14)
             or exists (select 1 from lifecycle_case c where c.employee_id = e.id and c.status = 'open' and c.kind in ('offboarding', 'urgent_termination')))
      order by e.end_date nulls first, a.tag`, [tenantId]);
  return rows;
}
export async function awaitingRecovery(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireStaff(w);
  return recoveryList(pool, w.tenantId);
}

// ------------------------------------------------------------------ access

export async function listSystems(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query(
    `select s.id, s.name, s.roles, s.max_days, s.active, s.owner_id, o.display_name as owner, s.connector_actor_id, c.display_name as connector, s.connector_url, (s.connector_secret is not null) as has_secret
       from access_system s join actor o on o.id = s.owner_id left join actor c on c.id = s.connector_actor_id where s.tenant_id = $1 order by s.name`, [w.tenantId]);
  return rows;
}

export async function saveSystem(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireAdmin(w);
  const name = text(body.name, 120);
  if (!name) throw new InvalidInput('name the system');
  const ownerId = id(body.ownerId, 'ownerId');
  const roles = list(body.roles);
  if (!roles.length) throw new InvalidInput('list the roles people can ask for');
  const maxDays = body.maxDays === undefined || body.maxDays === '' || body.maxDays === null ? null : Math.trunc(num(body.maxDays));
  if (maxDays !== null && !(maxDays >= 1 && maxDays <= 3660)) throw new InvalidInput('maxDays must be 1 to 3660');
  const connector = body.connectorActorId ? id(body.connectorActorId, 'connectorActorId') : null;
  for (const a of [ownerId, connector].filter(Boolean)) {
    const { rows } = await pool.query('select 1 from actor where id = $1 and tenant_id = $2 and active', [a, w.tenantId]);
    if (!rows[0]) throw new InvalidInput('no such member');
  }
  const url = text(body.connectorUrl, 500) || null;
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new InvalidInput('the connector address must be a web address'); }
    // A signed request over plain HTTP is one anybody on the path can read.
    if (parsed.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) throw new InvalidInput('the connector address must be https');
  }
  let sid: string;
  if (body.id) {
    sid = id(body.id, 'id');
    const { rowCount } = await pool.query(`update access_system set name = $3, owner_id = $4, roles = $5, max_days = $6, connector_actor_id = $7, active = $8, connector_url = $9 where id = $1 and tenant_id = $2`,
      [sid, w.tenantId, name, ownerId, JSON.stringify(roles), maxDays, connector, body.active !== false, url]);
    if (!rowCount) throw new InvalidInput('no such system');
    await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'ops.system_changed', targetId: sid, detail: { name, ownerId, roles, maxDays, connector, url } });
  } else {
    const { rows } = await pool.query<{ id: string }>(`insert into access_system (tenant_id, name, owner_id, roles, max_days, connector_actor_id, connector_url) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [w.tenantId, name, ownerId, JSON.stringify(roles), maxDays, connector, url]);
    sid = rows[0]!.id;
    await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'ops.system_added', targetId: sid, detail: { name, ownerId, roles, maxDays, connector, url } });
  }
  // The signing secret is shown once, when first needed or when asked for a new one.
  let secret: string | null = null;
  if (url) {
    const { rows } = await pool.query<{ connector_secret: string | null }>('select connector_secret from access_system where id = $1', [sid]);
    if (!rows[0]!.connector_secret || body.newSecret === true) {
      secret = `pcs_${randomBytes(24).toString('base64url')}`;
      await pool.query('update access_system set connector_secret = $2 where id = $1', [sid, seal(secret, `access_system:${sid}`)]);
      await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'ops.connector_secret_issued', targetId: sid });
    }
  }
  return { id: sid, secret };
}

/** OPS-04: system, role, justification and expiry. */
export async function requestAccess(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const systemId = id(body.systemId, 'systemId');
  const holderId = body.holderId ? id(body.holderId, 'holderId') : w.actorId;
  const role = text(body.role, 120);
  const justification = text(body.justification, 2000);
  if (!justification) throw new InvalidInput('give the business reason');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ name: string; roles: string[]; max_days: number | null; active: boolean }>('select name, roles, max_days, active from access_system where id = $1 and tenant_id = $2', [systemId, w.tenantId]);
    const s = rows[0];
    if (!s?.active) throw new InvalidInput('no such system');
    if (!s.roles.includes(role)) throw new InvalidInput(`role must be one of: ${s.roles.join(', ')}`);
    if (holderId !== w.actorId) {
      const mgr = await managerOf(client, { tenantId: w.tenantId, actorId: holderId, at: new Date() });
      if (!(w.staff || mgr?.id === w.actorId)) throw new InvalidInput('you can ask for access for yourself or the people who report to you');
    }
    const { rows: h } = await client.query('select 1 from actor where id = $1 and tenant_id = $2 and active', [holderId, w.tenantId]);
    if (!h[0]) throw new InvalidInput('no such member');
    const expiresOn = day(body.expiresOn, 'expiresOn', s.max_days !== null);
    if (expiresOn && expiresOn <= today()) throw new InvalidInput('the expiry must be in the future');
    if (s.max_days && expiresOn && (new Date(expiresOn).getTime() - Date.now()) / 86400000 > s.max_days) throw new InvalidInput(`${s.name} access lasts at most ${s.max_days} days`);
    const { rows: dup } = await client.query(`select 1 from access_request where system_id = $1 and holder_id = $2 and role = $3 and status in ('requested', 'approved')`, [systemId, holderId, role]);
    if (dup[0]) throw new InvalidInput('the same request is already open');
    const number = await nextNumber(client, 'access_request', w.tenantId);
    const { rows: made } = await client.query<{ id: string }>(
      `insert into access_request (tenant_id, number, system_id, role, holder_id, requested_by, justification, expires_on) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [w.tenantId, number, systemId, role, holderId, w.actorId, justification, expiresOn]);
    return { id: made[0]!.id, number, status: 'requested' };
  });
}

/** The system owner decides. Approval does not give access; fulfilment does. */
export async function decideAccess(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const approve = body.decision === 'approve';
  if (!approve && body.decision !== 'reject') throw new InvalidInput('decide approve or reject');
  const note = text(body.note, 1000);
  if (!approve && !note) throw new InvalidInput('say why not');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; holder_id: string; requested_by: string; owner_id: string; owner_active: boolean }>(
      `select r.status, r.holder_id, r.requested_by, s.owner_id, o.active as owner_active from access_request r join access_system s on s.id = r.system_id join actor o on o.id = s.owner_id
        where r.id = $1 and r.tenant_id = $2 for update of r`, [requestId, w.tenantId]);
    const r = rows[0];
    if (!r) throw new InvalidInput('no such request');
    if (r.status !== 'requested') throw new InvalidInput('already decided');
    const owner = r.owner_id === w.actorId || (!r.owner_active && w.admin);
    if (!owner) throw new InvalidInput("the system's owner decides access to it");
    if (w.actorId === r.holder_id || w.actorId === r.requested_by) throw new InvalidInput('someone other than the person asking, or getting the access, decides');
    await client.query(`update access_request set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`, [requestId, approve ? 'approved' : 'rejected', w.actorId, note || null]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: approve ? 'ops.access_approved' : 'ops.access_rejected', targetId: requestId, detail: { note } });
    if (approve) await queueProvisioning(client, requestId);
    return { id: requestId, status: approve ? 'approved' : 'rejected', next: approve ? 'Waiting for the system to confirm, or for IT to record evidence.' : null };
  });
}

/**
 * Acceptance 2. Access exists only once the system's connector confirms
 * (the call comes from the connector's own account) or someone in IT, not
 * the holder, records evidence of the change made by hand.
 */
export async function confirmProvisioning(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const via = body.via === 'connector' ? 'connector' : body.via === 'manual' ? 'manual' : null;
  if (!via) throw new InvalidInput('via must be connector or manual');
  const evidence = text(body.evidenceRef, 500);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; holder_id: string; system_id: string; role: string; expires_on: string | null; connector_actor_id: string | null; name: string }>(
      `select r.status, r.holder_id, r.system_id, r.role, r.expires_on::text, s.connector_actor_id, s.name from access_request r join access_system s on s.id = r.system_id
        where r.id = $1 and r.tenant_id = $2 for update of r`, [requestId, w.tenantId]);
    const r = rows[0];
    if (!r) throw new InvalidInput('no such request');
    if (r.status === 'requested') throw new InvalidInput('this request has not been approved');
    if (!['approved', 'failed'].includes(r.status)) throw new InvalidInput(`this request is ${r.status}`);
    if (via === 'connector') {
      if (!r.connector_actor_id) throw new InvalidInput(`${r.name} has no connector; IT records the change with evidence`);
      if (w.actorId !== r.connector_actor_id) throw new InvalidInput(`only the ${r.name} connector can confirm`);
    } else {
      requireIt(w);
      if (w.actorId === r.holder_id) throw new InvalidInput('someone other than the person getting the access records it');
      if (!evidence) throw new InvalidInput('record the evidence: a ticket, screenshot or log reference');
    }
    await client.query(`update access_request set status = 'provisioned', provisioned_via = $2, evidence_ref = $3, provisioned_by = $4, provisioned_at = now(), failure_note = null where id = $1`,
      [requestId, via, evidence || text(body.externalRef, 300) || null, w.actorId]);
    const { rows: g } = await client.query<{ id: string }>(`insert into access_grant (tenant_id, system_id, role, holder_id, request_id, expires_on) values ($1, $2, $3, $4, $5, $6) returning id`,
      [w.tenantId, r.system_id, r.role, r.holder_id, requestId, r.expires_on]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'ops.access_provisioned', targetId: requestId, detail: { via, evidence, grantId: g[0]!.id } });
    return { id: requestId, status: 'provisioned', grantId: g[0]!.id };
  });
}

export async function failProvisioning(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const note = text(body.note, 1000);
  if (!note) throw new InvalidInput('say what went wrong');
  const { rows } = await pool.query<{ connector_actor_id: string | null }>(`select s.connector_actor_id from access_request r join access_system s on s.id = r.system_id where r.id = $1 and r.tenant_id = $2`, [requestId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such request');
  if (rows[0].connector_actor_id !== w.actorId) requireIt(w);
  const { rowCount } = await pool.query(`update access_request set status = 'failed', failure_note = $2 where id = $1 and status = 'approved'`, [requestId, note]);
  if (!rowCount) throw new InvalidInput('only an approved request can fail provisioning');
  return { id: requestId, status: 'failed' };
}

export async function listAccess(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  await reconcileAccess(pool, w.tenantId);
  const { rows: requests } = await pool.query(
    `select r.id, r.number, r.role, r.status, r.justification, r.expires_on::text, r.decision_note, r.failure_note, r.provisioned_via, r.evidence_ref, r.created_at,
            s.name as system, s.id as system_id, h.display_name as holder, r.holder_id, q.display_name as requested_by, r.requested_by as requested_by_id, d.display_name as decided_by,
            (s.owner_id = $2) as i_own
       from access_request r join access_system s on s.id = r.system_id join actor h on h.id = r.holder_id join actor q on q.id = r.requested_by left join actor d on d.id = r.decided_by
      where r.tenant_id = $1 and ($3 or r.holder_id = $2 or r.requested_by = $2 or s.owner_id = $2)
      order by r.created_at desc limit 300`, [w.tenantId, w.actorId, w.staff]);
  const { rows: grants } = await pool.query(
    `select g.id, g.role, g.status, g.granted_at, g.expires_on::text, g.revoke_reason, g.revoke_requested_at, g.failure_note, g.revoked_at, g.reviewed_at, g.review_note,
            s.name as system, h.display_name as holder, h.active as holder_active, (s.owner_id = $2) as i_own
       from access_grant g join access_system s on s.id = g.system_id join actor h on h.id = g.holder_id
      where g.tenant_id = $1 and ($3 or g.holder_id = $2 or s.owner_id = $2)
      order by (g.status = 'revoke_failed') desc, (g.status = 'revoking') desc, s.name, h.display_name limit 500`, [w.tenantId, w.actorId, w.staff]);
  return { requests, grants };
}

/** OPS-05: everything a person holds goes to revocation. Called when HR revokes access. */
export async function queueRevocations(client: Client | Pool, tenantId: string, actorId: string, reason: string): Promise<number> {
  const { rowCount } = await client.query(
    `update access_grant set status = 'revoking', revoke_requested_at = now(), revoke_reason = $3 where tenant_id = $1 and holder_id = $2 and status = 'active'`, [tenantId, actorId, reason]);
  await queueRevokeDeliveries(client, tenantId);
  return rowCount ?? 0;
}

/** Identity status wins: deactivated holders and expired grants go to revocation. */
export async function reconcileAccess(client: Client | Pool, tenantId?: string): Promise<number> {
  const a = await client.query(
    `update access_grant g set status = 'revoking', revoke_requested_at = now(), revoke_reason = 'the holder is no longer active'
       from actor h where h.id = g.holder_id and not h.active and g.status = 'active' and ($1::uuid is null or g.tenant_id = $1)`, [tenantId ?? null]);
  const b = await client.query(
    `update access_grant set status = 'revoking', revoke_requested_at = now(), revoke_reason = 'expired'
      where status = 'active' and expires_on is not null and expires_on <= current_date and ($1::uuid is null or tenant_id = $1)`, [tenantId ?? null]);
  await queueRevokeDeliveries(client, tenantId);
  return (a.rowCount ?? 0) + (b.rowCount ?? 0);
}

async function grantFor(client: Client, w: Who, grantId: string) {
  if (!UUID.test(grantId)) throw new InvalidInput('no such access');
  const { rows } = await client.query<{ status: string; holder_id: string; connector_actor_id: string | null; owner_id: string; name: string }>(
    `select g.status, g.holder_id, s.connector_actor_id, s.owner_id, s.name from access_grant g join access_system s on s.id = g.system_id where g.id = $1 and g.tenant_id = $2 for update of g`, [grantId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such access');
  return rows[0];
}

export async function confirmRevocation(pool: Pool, principal: Principal, grantId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const g = await grantFor(client, w, grantId);
    if (!['revoking', 'revoke_failed'].includes(g.status)) throw new InvalidInput('this access is not waiting to be revoked');
    const viaConnector = g.connector_actor_id === w.actorId;
    if (!viaConnector) {
      requireIt(w);
      if (!text(body.evidenceRef, 500)) throw new InvalidInput('record the evidence that the access was removed');
    }
    await client.query(`update access_grant set status = 'revoked', revoked_via = $2, revoke_evidence = $3, revoked_by = $4, revoked_at = now() where id = $1`,
      [grantId, viaConnector ? 'connector' : 'manual', text(body.evidenceRef, 500) || null, w.actorId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'ops.access_revoked', targetId: grantId, detail: { via: viaConnector ? 'connector' : 'manual' } });
    return { id: grantId, status: 'revoked' };
  });
}

/** A failure is a critical exception; it stays on the list until someone confirms the removal. */
export async function failRevocation(pool: Pool, principal: Principal, grantId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const note = text(body.note, 1000);
  if (!note) throw new InvalidInput('say what went wrong');
  return inTransaction(pool, async (client) => {
    const g = await grantFor(client, w, grantId);
    if (g.connector_actor_id !== w.actorId) requireIt(w);
    if (g.status !== 'revoking') throw new InvalidInput('this access is not being revoked');
    await client.query(`update access_grant set status = 'revoke_failed', failure_note = $2, failed_at = now() where id = $1`, [grantId, note]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'ops.revocation_failed', targetId: grantId, detail: { note, system: g.name } });
    return { id: grantId, status: 'revoke_failed' };
  });
}

/** Access review by the system owner: keep, with a note, or send to revocation. */
export async function reviewGrant(pool: Pool, principal: Principal, grantId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const keep = body.decision === 'keep';
  if (!keep && body.decision !== 'revoke') throw new InvalidInput('decide keep or revoke');
  const note = text(body.note, 1000);
  if (!note) throw new InvalidInput('record the reason');
  return inTransaction(pool, async (client) => {
    const g = await grantFor(client, w, grantId);
    if (g.owner_id !== w.actorId && !w.admin) throw new InvalidInput("the system's owner reviews access to it");
    if (g.holder_id === w.actorId) throw new InvalidInput('nobody reviews their own access');
    if (g.status !== 'active') throw new InvalidInput('only active access is reviewed');
    if (keep) await client.query(`update access_grant set reviewed_at = now(), reviewed_by = $2, review_note = $3 where id = $1`, [grantId, w.actorId, note]);
    else { await client.query(`update access_grant set status = 'revoking', revoke_requested_at = now(), revoke_reason = $3, reviewed_at = now(), reviewed_by = $2, review_note = $3 where id = $1`, [grantId, w.actorId, `access review: ${note}`]); await queueRevokeDeliveries(client, w.tenantId); }
    return { id: grantId, status: keep ? 'active' : 'revoking' };
  });
}

// --------------------------------------------------------------- connector
//
// A system with a connector address gets a signed POST when access to it is
// approved or must be removed. Its reply, or a signed call back later, is
// what confirms the change; Patform never assumes it happened.
//
//   reply {"status": "done", "reference": "..."}   confirmed now
//   reply {"status": "failed", "error": "..."}     a failure, shown to IT
//   any other 2xx                                  accepted; call back later
//   non-2xx or no answer                           retried, then a failure

const MAX_ATTEMPTS = 8;

async function queueProvisioning(client: Client | Pool, requestId: string) {
  await client.query(
    `insert into ops_connector_delivery (tenant_id, system_id, kind, request_id, payload)
     select r.tenant_id, s.id, 'provision', r.id,
            jsonb_build_object('event', 'access.provision', 'system', s.name, 'request', jsonb_build_object('id', r.id, 'number', r.number),
              'holder', jsonb_build_object('id', h.id, 'email', h.email, 'name', h.display_name), 'role', r.role, 'expiresOn', r.expires_on)
       from access_request r join access_system s on s.id = r.system_id join actor h on h.id = r.holder_id
      where r.id = $1 and s.connector_url is not null
     on conflict do nothing`, [requestId]);
}

async function queueRevokeDeliveries(client: Client | Pool, tenantId?: string) {
  await client.query(
    `insert into ops_connector_delivery (tenant_id, system_id, kind, grant_id, payload)
     select g.tenant_id, s.id, 'revoke', g.id,
            jsonb_build_object('event', 'access.revoke', 'system', s.name, 'grant', jsonb_build_object('id', g.id),
              'holder', jsonb_build_object('id', h.id, 'email', h.email, 'name', h.display_name), 'role', g.role, 'reason', g.revoke_reason)
       from access_grant g join access_system s on s.id = g.system_id join actor h on h.id = g.holder_id
      where g.status = 'revoking' and s.connector_url is not null and ($1::uuid is null or g.tenant_id = $1)
     on conflict do nothing`, [tenantId ?? null]);
}

type Outcome = { status: 'done'; reference?: string } | { status: 'failed'; error: string } | { status: 'accepted' };

async function applyOutcome(client: Client, d: { id: number; tenant_id: string; system_id: string; kind: string; request_id: string | null; grant_id: string | null }, outcome: Outcome) {
  if (outcome.status === 'accepted') {
    await client.query(`update ops_connector_delivery set status = 'accepted' where id = $1 and status = 'pending'`, [d.id]);
    return;
  }
  const { rows: sys } = await client.query<{ connector_actor_id: string | null; name: string }>('select connector_actor_id, name from access_system where id = $1', [d.system_id]);
  const by = sys[0]?.connector_actor_id ?? null;
  if (d.kind === 'provision' && d.request_id) {
    const { rows } = await client.query<{ status: string; system_id: string; role: string; holder_id: string; expires_on: string | null }>(
      'select status, system_id, role, holder_id, expires_on::text from access_request where id = $1 for update', [d.request_id]);
    const r = rows[0];
    if (r && ['approved', 'failed'].includes(r.status)) {
      if (outcome.status === 'done') {
        await client.query(`update access_request set status = 'provisioned', provisioned_via = 'connector', evidence_ref = $2, provisioned_by = $3, provisioned_at = now(), failure_note = null where id = $1`,
          [d.request_id, outcome.reference ?? `connector delivery ${d.id}`, by]);
        await client.query(`insert into access_grant (tenant_id, system_id, role, holder_id, request_id, expires_on) values ($1, $2, $3, $4, $5, $6)`, [d.tenant_id, r.system_id, r.role, r.holder_id, d.request_id, r.expires_on]);
      } else if (r.status === 'approved') {
        await client.query(`update access_request set status = 'failed', failure_note = $2 where id = $1`, [d.request_id, `${sys[0]?.name ?? 'connector'}: ${outcome.error}`]);
      }
      await recordWorkspaceAudit(client, { tenantId: d.tenant_id, actorId: by, action: outcome.status === 'done' ? 'ops.access_provisioned' : 'ops.provisioning_failed', targetId: d.request_id, detail: { via: 'connector', delivery: d.id, ...outcome } });
    }
  }
  if (d.kind === 'revoke' && d.grant_id) {
    const { rows } = await client.query<{ status: string }>('select status from access_grant where id = $1 for update', [d.grant_id]);
    if (rows[0] && ['revoking', 'revoke_failed'].includes(rows[0].status)) {
      if (outcome.status === 'done') {
        await client.query(`update access_grant set status = 'revoked', revoked_via = 'connector', revoke_evidence = $2, revoked_by = $3, revoked_at = now() where id = $1`, [d.grant_id, outcome.reference ?? `connector delivery ${d.id}`, by]);
      } else if (rows[0].status === 'revoking') {
        await client.query(`update access_grant set status = 'revoke_failed', failure_note = $2, failed_at = now() where id = $1`, [d.grant_id, `${sys[0]?.name ?? 'connector'}: ${outcome.error}`]);
      }
      await recordWorkspaceAudit(client, { tenantId: d.tenant_id, actorId: by, action: outcome.status === 'done' ? 'ops.access_revoked' : 'ops.revocation_failed', targetId: d.grant_id, detail: { via: 'connector', delivery: d.id, ...outcome } });
    }
  }
  await client.query(`update ops_connector_delivery set status = $2, finished_at = now(), last_error = $3 where id = $1`, [d.id, outcome.status, outcome.status === 'failed' ? outcome.error : null]);
}

function readOutcome(status: number, raw: string): Outcome {
  let body: { status?: unknown; reference?: unknown; error?: unknown } = {};
  try { body = JSON.parse(raw); } catch { /* a 2xx without JSON is an acceptance */ }
  if (body.status === 'done') return { status: 'done', reference: typeof body.reference === 'string' ? body.reference.slice(0, 300) : undefined };
  if (body.status === 'failed') return { status: 'failed', error: typeof body.error === 'string' && body.error ? body.error.slice(0, 500) : 'the system reported a failure' };
  void status;
  return { status: 'accepted' };
}

/** The worker's half: send what is due, apply the answers, back off on errors. */
export async function deliverConnectors(pool: Pool, args: { workerId: string; now?: Date; fetchImpl?: typeof fetch; batch?: number } = { workerId: 'worker' }) {
  const now = args.now ?? new Date();
  const doFetch = args.fetchImpl ?? fetch;
  const { rows } = await pool.query<{ id: number; tenant_id: string; system_id: string; kind: string; request_id: string | null; grant_id: string | null; payload: Record<string, unknown>; attempts: number; connector_url: string | null; connector_secret: string | null }>(
    `update ops_connector_delivery d set claimed_by = $1, attempts = d.attempts + 1, available_at = $2 + interval '60 seconds'
       from access_system s
      where s.id = d.system_id and d.id in (select id from ops_connector_delivery where status = 'pending' and available_at <= $2 order by id for update skip locked limit $3)
      returning d.id, d.tenant_id, d.system_id, d.kind, d.request_id, d.grant_id, d.payload, d.attempts, s.connector_url, s.connector_secret`,
    [args.workerId, now, args.batch ?? 20]);
  let sent = 0;
  for (const d of rows) {
    const fail = async (error: string, status: number | null) => {
      if (d.attempts >= MAX_ATTEMPTS || !d.connector_url || !d.connector_secret) {
        await inTransaction(pool, (c) => applyOutcome(c, d, { status: 'failed', error: `connector unreachable after ${d.attempts} attempt(s): ${error}` }));
      } else {
        const wait = Math.min(2 ** d.attempts, 360);
        await pool.query(`update ops_connector_delivery set last_error = $2, response_status = $3, available_at = $4::timestamptz + make_interval(mins => $5) where id = $1`, [d.id, error, status, now, wait]);
      }
    };
    if (!d.connector_url || !d.connector_secret) { await fail('the connector address or secret was removed', null); continue; }
    const body = JSON.stringify({ ...d.payload, delivery: d.id });
    const secret = unseal(d.connector_secret, `access_system:${d.system_id}`).plaintext;
    try {
      const res = await doFetch(d.connector_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'patform-signature': sign(body, [secret]), 'patform-event': String(d.payload.event), 'patform-delivery': String(d.id) },
        body, signal: AbortSignal.timeout(10_000),
      });
      const raw = await res.text().catch(() => '');
      if (!res.ok) { await fail(`HTTP ${res.status}`, res.status); continue; }
      await pool.query('update ops_connector_delivery set response_status = $2 where id = $1', [d.id, res.status]);
      await inTransaction(pool, (c) => applyOutcome(c, d, readOutcome(res.status, raw)));
      sent++;
    } catch (err) {
      await fail(err instanceof Error ? err.message : String(err), null);
    }
  }
  return { claimed: rows.length, sent };
}

/**
 * The system's call back, for work it accepted and finished later. Signed
 * with the same secret, over the exact bytes; no session.
 */
export async function connectorCallback(pool: Pool, systemId: string, raw: string, signature: string) {
  if (!UUID.test(systemId)) return { ok: false as const, status: 401 };
  const { rows: sys } = await pool.query<{ connector_secret: string | null }>('select connector_secret from access_system where id = $1', [systemId]);
  if (!sys[0]?.connector_secret) return { ok: false as const, status: 401 };
  const secret = unseal(sys[0].connector_secret, `access_system:${systemId}`).plaintext;
  if (!verify(signature, raw, secret).ok) return { ok: false as const, status: 401 };
  let body: { delivery?: unknown; status?: unknown; reference?: unknown; error?: unknown };
  try { body = JSON.parse(raw); } catch { return { ok: false as const, status: 400, error: 'body is not valid JSON' }; }
  const deliveryId = Number(body.delivery);
  if (!Number.isInteger(deliveryId)) return { ok: false as const, status: 400, error: 'delivery is required' };
  if (body.status !== 'done' && body.status !== 'failed') return { ok: false as const, status: 400, error: 'status must be done or failed' };
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: number; tenant_id: string; system_id: string; kind: string; request_id: string | null; grant_id: string | null; status: string }>(
      'select id, tenant_id, system_id, kind, request_id, grant_id, status from ops_connector_delivery where id = $1 and system_id = $2 for update', [deliveryId, systemId]);
    const d = rows[0];
    if (!d) return { ok: false as const, status: 404, error: 'no such delivery for this system' };
    if (d.status === 'done' || d.status === 'failed') return { ok: true as const, status: 200, already: d.status };
    await applyOutcome(client, d, readOutcome(200, raw));
    return { ok: true as const, status: 200 };
  });
}

// --------------------------------------------------------- catalogue, tickets

export interface Field { key: string; label: string; required: boolean }
export async function listServiceTypes(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query<{ id: string; key: string; name: string; description: string | null; team: string; approval: string; fields: Field[]; roles: string[] | null; respond_hours: string; resolve_hours: string; evidence_required: boolean; active: boolean }>(
    'select * from service_type where tenant_id = $1 order by name', [w.tenantId]);
  return rows.filter((t) => w.staff || (t.active && (!t.roles || t.roles.includes(w.role))));
}

export async function saveServiceType(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireAdmin(w);
  const name = text(body.name, 120);
  if (!name) throw new InvalidInput('name the service');
  const key = text(body.key, 40) || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const team = text(body.team, 20);
  if (!['it', 'facilities'].includes(team)) throw new InvalidInput('team must be it or facilities');
  const approval = body.approval === 'manager' ? 'manager' : 'none';
  const fields: Field[] = (Array.isArray(body.fields) ? body.fields : []).map((f, i) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const label = text(o.label, 120);
    if (!label) throw new InvalidInput(`field ${i + 1} needs a label`);
    return { key: text(o.key, 40) || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), label, required: o.required === true };
  });
  const respond = num(body.respondHours ?? 8); const resolve = num(body.resolveHours ?? 40);
  if (!(respond > 0 && resolve >= respond)) throw new InvalidInput('the response target must be above 0 and the resolution target at least as long');
  const roles = body.roles === undefined || body.roles === null ? null : list(body.roles);
  const { rows } = await pool.query<{ id: string }>(
    `insert into service_type (tenant_id, key, name, description, team, approval, fields, roles, respond_hours, resolve_hours, evidence_required, active)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (tenant_id, key) do update set name = excluded.name, description = excluded.description, team = excluded.team, approval = excluded.approval, fields = excluded.fields,
       roles = excluded.roles, respond_hours = excluded.respond_hours, resolve_hours = excluded.resolve_hours, evidence_required = excluded.evidence_required, active = excluded.active
     returning id`,
    [w.tenantId, key, name, text(body.description, 1000) || null, team, approval, JSON.stringify(fields), roles && roles.length ? JSON.stringify(roles) : null, respond, resolve, body.evidenceRequired === true, body.active !== false]);
  return { id: rows[0]!.id, key };
}

const priorityOf = (impact: number, urgency: number) => Math.min(4, impact + urgency - 1);

async function setTargets(client: Client, ticketId: string, from: Date, respondHours: number, resolveHours: number) {
  await client.query('update ticket set respond_due = $2, resolve_due = $3 where id = $1', [ticketId, new Date(from.getTime() + respondHours * HOUR), new Date(from.getTime() + resolveHours * HOUR)]);
}
async function note(client: Client | Pool, ticketId: string, kind: 'work_note' | 'update' | 'system', body: string, authorId: string | null) {
  await client.query('insert into ticket_note (ticket_id, kind, body, author_id) values ($1, $2, $3, $4)', [ticketId, kind, body, authorId]);
}

/** A service request from the catalogue, or an incident. */
export async function openTicket(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const settings = await opsSettings(pool, w.tenantId);
  const title = text(body.title, 200);
  if (!title) throw new InvalidInput('give it a short title');
  const impact = body.impact === undefined ? 3 : Math.trunc(num(body.impact)); const urgency = body.urgency === undefined ? 3 : Math.trunc(num(body.urgency));
  if (![1, 2, 3].includes(impact) || ![1, 2, 3].includes(urgency)) throw new InvalidInput('impact and urgency are 1 (high) to 3 (low)');
  const assetId = body.assetId ? id(body.assetId, 'assetId') : null;
  return inTransaction(pool, async (client) => {
    let type: { id: string; team: string; approval: string; fields: Field[]; roles: string[] | null; respond_hours: string; resolve_hours: string; active: boolean; name: string } | null = null;
    const details: Record<string, string> = {};
    if (body.typeId) {
      const { rows } = await client.query('select * from service_type where id = $1 and tenant_id = $2', [id(body.typeId, 'typeId'), w.tenantId]);
      type = rows[0] ?? null;
      if (!type?.active) throw new InvalidInput('no such service');
      if (type.roles && !type.roles.includes(w.role)) throw new InvalidInput(`${type.name} is not offered to your role`);
      const given = (body.details ?? {}) as Record<string, unknown>;
      const missing = type.fields.filter((f) => f.required && !text(given[f.key], 2000)).map((f) => f.label);
      if (missing.length) throw new InvalidInput(`fill in: ${missing.join(', ')}`);
      for (const f of type.fields) { const v = text(given[f.key], 2000); if (v) details[f.key] = v; }
    }
    const team = type?.team ?? text(body.team, 20);
    if (!['it', 'facilities'].includes(team)) throw new InvalidInput('team must be it or facilities');
    if (assetId) { const { rows } = await client.query('select 1 from asset where id = $1 and tenant_id = $2', [assetId, w.tenantId]); if (!rows[0]) throw new InvalidInput('no such asset'); }
    const number = await nextNumber(client, 'ticket', w.tenantId);
    let approver: string | null = null;
    if (type?.approval === 'manager') {
      approver = (await managerOf(client, { tenantId: w.tenantId, actorId: w.actorId, at: new Date() }))?.id ?? null;
      if (!approver) throw new InvalidInput(`${type.name} needs your manager's approval, and you have no manager on file. Ask an admin to set one`);
    }
    const priority = priorityOf(impact, urgency);
    const { rows } = await client.query<{ id: string; created_at: Date }>(
      `insert into ticket (tenant_id, number, type_id, kind, title, description, details, requester_id, team, impact, urgency, priority, status, approver_id, asset_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id, created_at`,
      [w.tenantId, number, type?.id ?? null, type ? 'request' : 'incident', title, text(body.description, 4000) || null, JSON.stringify(details), w.actorId, team, impact, urgency, priority,
        approver ? 'awaiting_approval' : 'new', approver, assetId]);
    const t = rows[0]!;
    if (!approver) {
      const target = type ? { respond: Number(type.respond_hours), resolve: Number(type.resolve_hours) } : settings.targets[String(priority) as '1'];
      await setTargets(client, t.id, t.created_at, target.respond, target.resolve);
    }
    return { id: t.id, number, status: approver ? 'awaiting_approval' : 'new', priority };
  });
}

async function ticketFor(client: Client | Pool, w: Who, ticketId: string, lock = false) {
  if (!UUID.test(ticketId)) throw new InvalidInput('no such ticket');
  const { rows } = await client.query<{ id: string; status: string; requester_id: string; team: string; assignee_id: string | null; approver_id: string | null; type_id: string | null; paused_since: Date | null; resolve_due: Date | null;
    resolved_at: Date | null; responded_at: Date | null; priority: number; kind: string; asset_id: string | null; evidence_required: boolean | null; respond_hours: string | null; resolve_hours: string | null; number: number }>(
    `select t.*, st.evidence_required, st.respond_hours, st.resolve_hours from ticket t left join service_type st on st.id = t.type_id where t.id = $1 and t.tenant_id = $2 ${lock ? 'for update of t' : ''}`, [ticketId, w.tenantId]);
  const t = rows[0];
  if (!t) throw new InvalidInput('no such ticket');
  const mine = t.requester_id === w.actorId;
  const canWork = inTeam(w, t.team);
  if (!mine && !canWork && t.approver_id !== w.actorId) throw new InvalidInput('no such ticket');
  return { ...t, mine, canWork };
}

export async function listTickets(pool: Pool, principal: Principal, opts: { scope?: string } = {}) {
  const w = await who(pool, principal);
  await sweepTickets(pool, w.tenantId);
  const scope = opts.scope ?? (w.staff ? 'queue' : 'mine');
  const { rows } = await pool.query(
    `select t.id, t.number, t.kind, t.title, t.status, t.priority, t.impact, t.urgency, t.team, t.created_at, t.respond_due, t.resolve_due, t.responded_at, t.breached_at, t.escalated_at,
            t.paused_since, t.resolved_at, t.reopened, t.requester_id, r.display_name as requester, s.display_name as assignee, st.name as service, a.tag as asset_tag
       from ticket t join actor r on r.id = t.requester_id left join actor s on s.id = t.assignee_id left join service_type st on st.id = t.type_id left join asset a on a.id = t.asset_id
      where t.tenant_id = $1 and (
        ($2 = 'mine' and t.requester_id = $3) or
        ($2 = 'approve' and t.approver_id = $3 and t.status = 'awaiting_approval') or
        ($2 = 'queue' and t.team = any($4::text[]) and t.status not in ('closed', 'cancelled', 'rejected', 'awaiting_approval')))
      order by (t.breached_at is not null) desc, t.priority, t.created_at limit 300`,
    [w.tenantId, scope, w.actorId, w.admin ? ['it', 'facilities'] : w.teams]);
  return rows;
}

export async function ticketDetail(pool: Pool, principal: Principal, ticketId: string) {
  const w = await who(pool, principal);
  const t = await ticketFor(pool, w, ticketId);
  const { rows } = await pool.query(
    `select t.*, r.display_name as requester, s.display_name as assignee, st.name as service, st.fields, a.tag as asset_tag from ticket t join actor r on r.id = t.requester_id left join actor s on s.id = t.assignee_id
       left join service_type st on st.id = t.type_id left join asset a on a.id = t.asset_id where t.id = $1`, [ticketId]);
  // Work notes stay with the team; the requester sees updates.
  const { rows: notes } = await pool.query(
    `select n.kind, n.body, n.occurred_at, a.display_name as author from ticket_note n left join actor a on a.id = n.author_id where n.ticket_id = $1 and (n.kind <> 'work_note' or $2) order by n.id`, [ticketId, t.canWork]);
  return { ticket: rows[0], notes, canWork: t.canWork, photos: await photosFor(pool, 'ticket_id', ticketId) };
}

export async function decideTicket(pool: Pool, principal: Principal, ticketId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const approve = body.decision === 'approve';
  return inTransaction(pool, async (client) => {
    const t = await ticketFor(client, w, ticketId, true);
    if (t.status !== 'awaiting_approval') throw new InvalidInput('this request is not waiting for approval');
    if (t.approver_id !== w.actorId || t.requester_id === w.actorId) throw new InvalidInput("the requester's manager approves");
    const why = text(body.note, 1000);
    if (!approve && !why) throw new InvalidInput('say why not');
    await client.query(`update ticket set status = $2, approved_by = $3, approved_at = now(), updated_at = now() where id = $1`, [ticketId, approve ? 'new' : 'rejected', w.actorId]);
    await note(client, ticketId, 'update', approve ? `Approved${why ? `: ${why}` : ''}` : `Not approved: ${why}`, w.actorId);
    if (approve) {
      const settings = await opsSettings(client, w.tenantId);
      const target = t.respond_hours ? { respond: Number(t.respond_hours), resolve: Number(t.resolve_hours) } : settings.targets[String(t.priority) as '1'];
      await setTargets(client, ticketId, new Date(), target.respond, target.resolve);
    }
    return { id: ticketId, status: approve ? 'new' : 'rejected' };
  });
}

/** Leaving "waiting on the requester" restarts the clock, and the time paused moves the target. */
async function resumeClock(client: Client, ticketId: string) {
  await client.query(
    `update ticket set paused_seconds = paused_seconds + extract(epoch from now() - paused_since)::int,
            resolve_due = resolve_due + (now() - paused_since), paused_since = null where id = $1 and paused_since is not null`, [ticketId]);
}

/** OPS-06: assignment, status, notes and resolution by the fulfilling team. */
export async function workTicket(pool: Pool, principal: Principal, ticketId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const action = text(body.action, 20);
  const settings = await opsSettings(pool, w.tenantId);
  return inTransaction(pool, async (client) => {
    const t = await ticketFor(client, w, ticketId, true);
    if (!t.canWork) throw new InvalidInput(`only the ${t.team.toUpperCase()} team works on this`);
    if (['closed', 'cancelled', 'rejected', 'awaiting_approval'].includes(t.status)) throw new InvalidInput(`this ticket is ${t.status.replace('_', ' ')}`);
    const firstTouch = t.responded_at ? '' : ', responded_at = now()';
    switch (action) {
      case 'assign': {
        const assignee = body.assigneeId ? id(body.assigneeId, 'assigneeId') : w.actorId;
        const { rows } = await client.query<{ team: string }>(`select team from hr_team_member where tenant_id = $1 and actor_id = $2 and team = $3`, [w.tenantId, assignee, t.team]);
        const { rows: adm } = await client.query(`select 1 from actor where id = $1 and tenant_id = $2 and workspace_role in ('owner', 'admin')`, [assignee, w.tenantId]);
        if (!rows[0] && !adm[0]) throw new InvalidInput(`they are not in the ${t.team.toUpperCase()} team`);
        if (t.status === 'waiting_on_user') await resumeClock(client, ticketId);
        await client.query(`update ticket set assignee_id = $2, status = case when status in ('new', 'waiting_on_user') then 'in_progress' else status end, updated_at = now()${firstTouch} where id = $1`, [ticketId, assignee]);
        await note(client, ticketId, 'system', `Assigned`, w.actorId);
        break;
      }
      case 'note': {
        const b = text(body.body, 4000);
        if (!b) throw new InvalidInput('the note is empty');
        await note(client, ticketId, body.visible === true ? 'update' : 'work_note', b, w.actorId);
        await client.query(`update ticket set updated_at = now()${firstTouch} where id = $1`, [ticketId]);
        break;
      }
      case 'wait': {
        const b = text(body.body, 4000);
        if (!b) throw new InvalidInput('say what you need from the requester');
        if (t.status === 'resolved') throw new InvalidInput('this ticket is resolved');
        await note(client, ticketId, 'update', b, w.actorId);
        await client.query(`update ticket set status = 'waiting_on_user', paused_since = case when $2 then now() else null end, updated_at = now()${firstTouch} where id = $1`, [ticketId, settings.pauseWhileWaiting]);
        break;
      }
      case 'escalate': {
        const b = text(body.body, 1000);
        if (!b) throw new InvalidInput('say why');
        await client.query(`update ticket set escalated_at = now(), priority = greatest(1, priority - 1), updated_at = now() where id = $1`, [ticketId]);
        await note(client, ticketId, 'work_note', `Escalated: ${b}`, w.actorId);
        break;
      }
      case 'resolve': {
        const resolution = text(body.resolution, 4000);
        if (!resolution) throw new InvalidInput('say how it was resolved');
        const evidence = text(body.evidenceRef, 500);
        if (t.evidence_required && !evidence) throw new InvalidInput('this service needs evidence of completion');
        if (t.status === 'waiting_on_user') await resumeClock(client, ticketId);
        await client.query(`update ticket set status = 'resolved', resolution = $2, resolution_evidence = $3, resolved_at = now(), updated_at = now()${firstTouch} where id = $1`, [ticketId, resolution, evidence || null]);
        await note(client, ticketId, 'update', `Resolved: ${resolution}`, w.actorId);
        break;
      }
      default: throw new InvalidInput('action must be assign, note, wait, escalate or resolve');
    }
    return { id: ticketId };
  });
}

/** The requester replies, confirms, cancels or reopens within the allowed days. */
export async function requesterTicket(pool: Pool, principal: Principal, ticketId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const action = text(body.action, 20);
  const settings = await opsSettings(pool, w.tenantId);
  return inTransaction(pool, async (client) => {
    const t = await ticketFor(client, w, ticketId, true);
    if (!t.mine) throw new InvalidInput('only the person who raised it can do this');
    const b = text(body.body, 4000);
    if (action === 'reply') {
      if (!b) throw new InvalidInput('the reply is empty');
      if (['closed', 'cancelled', 'rejected'].includes(t.status)) throw new InvalidInput(`this ticket is ${t.status}`);
      await note(client, ticketId, 'update', b, w.actorId);
      if (t.status === 'waiting_on_user') { await resumeClock(client, ticketId); await client.query(`update ticket set status = 'in_progress', updated_at = now() where id = $1`, [ticketId]); }
    } else if (action === 'confirm') {
      if (t.status !== 'resolved') throw new InvalidInput('only a resolved ticket can be closed');
      await client.query(`update ticket set status = 'closed', closed_at = now(), updated_at = now() where id = $1`, [ticketId]);
    } else if (action === 'reopen') {
      if (t.status !== 'resolved' && t.status !== 'closed') throw new InvalidInput('only a resolved ticket can be reopened');
      if (!b) throw new InvalidInput('say what is still wrong');
      if (t.resolved_at && Date.now() - new Date(t.resolved_at).getTime() > settings.reopenDays * 86400000) throw new InvalidInput(`tickets can be reopened for ${settings.reopenDays} days; raise a new one`);
      await client.query(`update ticket set status = 'in_progress', reopened = reopened + 1, resolved_at = null, closed_at = null, updated_at = now() where id = $1`, [ticketId]);
      await note(client, ticketId, 'update', `Reopened: ${b}`, w.actorId);
    } else if (action === 'cancel') {
      if (['resolved', 'closed', 'cancelled', 'rejected'].includes(t.status)) throw new InvalidInput(`this ticket is ${t.status}`);
      await client.query(`update ticket set status = 'cancelled', paused_since = null, updated_at = now() where id = $1`, [ticketId]);
    } else throw new InvalidInput('action must be reply, confirm, reopen or cancel');
    return { id: ticketId };
  });
}

/** Missed targets are flagged and escalated once; resolved tickets close after the reopen period. */
export async function sweepTickets(client: Client | Pool, tenantId?: string): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `update ticket set breached_at = now(), escalated_at = coalesce(escalated_at, now())
      where status in ('new', 'in_progress') and breached_at is null and resolve_due < now() and ($1::uuid is null or tenant_id = $1) returning id`, [tenantId ?? null]);
  for (const r of rows) await note(client, r.id, 'system', 'Service target missed; escalated', null);
  await client.query(
    `update ticket t set status = 'closed', closed_at = now() from ops_settings s
      where t.status = 'resolved' and s.tenant_id = t.tenant_id and t.resolved_at < now() - make_interval(days => coalesce((s.settings->>'reopenDays')::int, 14)) and ($1::uuid is null or t.tenant_id = $1)`, [tenantId ?? null]);
  await client.query(
    `update ticket set status = 'closed', closed_at = now() where status = 'resolved' and resolved_at < now() - interval '14 days'
        and not exists (select 1 from ops_settings s where s.tenant_id = ticket.tenant_id) and ($1::uuid is null or tenant_id = $1)`, [tenantId ?? null]);
  return rows.length;
}

// ------------------------------------------------------------- maintenance

export async function createPlan(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireStaff(w);
  const assetId = id(body.assetId, 'assetId');
  const title = text(body.title, 200);
  if (!title) throw new InvalidInput('name the job');
  const everyDays = Math.trunc(num(body.everyDays));
  if (!(everyDays >= 1 && everyDays <= 3660)) throw new InvalidInput('everyDays must be 1 to 3660');
  const checklist = list(body.checklist, 60);
  if (!checklist.length) throw new InvalidInput('list what to check');
  const team = text(body.team, 20);
  if (!['it', 'facilities'].includes(team) || !inTeam(w, team)) throw new InvalidInput('team must be it or facilities, and yours');
  const firstDue = day(body.firstDue, 'firstDue', true)!;
  const { rows: a } = await pool.query('select 1 from asset where id = $1 and tenant_id = $2', [assetId, w.tenantId]);
  if (!a[0]) throw new InvalidInput('no such asset');
  const { rows } = await pool.query<{ id: string }>(
    `insert into maintenance_plan (tenant_id, asset_id, title, every_days, checklist, team, next_due, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [w.tenantId, assetId, title, everyDays, JSON.stringify(checklist), team, firstDue, w.actorId]);
  await event(pool, assetId, 'maintenance_planned', w.actorId, { title, everyDays, firstDue });
  return { id: rows[0]!.id };
}

/**
 * Acceptance 4. Each occurrence is inserted against (plan, date), which is
 * unique, and the plan only moves on if it is still at that date. Two
 * schedulers running at once, or one retrying, make one job per date.
 */
export async function generateMaintenance(pool: Pool | Client, opts: { tenantId?: string; until?: string } = {}): Promise<number> {
  const until = opts.until ?? today();
  let made = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const { rows } = await pool.query<{ id: string; tenant_id: string; asset_id: string; next_due: string; every_days: number }>(
      `select id, tenant_id, asset_id, next_due::text, every_days from maintenance_plan where active and next_due <= $1 and ($2::uuid is null or tenant_id = $2) limit 200`, [until, opts.tenantId ?? null]);
    if (!rows.length) break;
    for (const p of rows) {
      const ins = await pool.query(`insert into maintenance_job (tenant_id, plan_id, asset_id, due_on) values ($1, $2, $3, $4) on conflict (plan_id, due_on) do nothing`, [p.tenant_id, p.id, p.asset_id, p.next_due]);
      made += ins.rowCount ?? 0;
      await pool.query(`update maintenance_plan set next_due = next_due + every_days where id = $1 and next_due = $2`, [p.id, p.next_due]);
    }
  }
  return made;
}

export async function listMaintenance(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireStaff(w);
  await generateMaintenance(pool, { tenantId: w.tenantId });
  const { rows: jobs } = await pool.query(
    `select j.id, j.due_on::text, j.status, j.outcome, j.version, j.draft, j.findings, p.title, p.checklist, p.team, a.tag, a.name as asset, a.id as asset_id, a.status as asset_status
       from maintenance_job j join maintenance_plan p on p.id = j.plan_id join asset a on a.id = j.asset_id
      where j.tenant_id = $1 and (j.status = 'open' or j.completed_at > now() - interval '30 days') and p.team = any($2::text[])
      order by j.status = 'done', j.due_on`, [w.tenantId, w.admin ? ['it', 'facilities'] : w.teams]);
  const { rows: plans } = await pool.query(
    `select p.id, p.title, p.every_days, p.next_due::text, p.team, p.active, a.tag from maintenance_plan p join asset a on a.id = p.asset_id where p.tenant_id = $1 order by p.next_due`, [w.tenantId]);
  return { jobs, plans, captureLocation: (await opsSettings(pool, w.tenantId)).captureLocation };
}

type Result = 'pass' | 'fail' | 'na';
function readJobBody(body: Record<string, unknown>, captureLocation: boolean) {
  const results = (body.results && typeof body.results === 'object' ? body.results : {}) as Record<string, Result>;
  const photos = list(body.photos, 20).filter((r) => PHOTO.test(r) || (() => { throw new InvalidInput('photos must be uploaded, not typed in'); })());
  let location: { lat: number; lng: number } | null = null;
  if (body.location) {
    if (!captureLocation) throw new InvalidInput('location capture is switched off for this workspace');
    const l = body.location as Record<string, unknown>;
    const lat = num(l.lat); const lng = num(l.lng);
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) throw new InvalidInput('location must be a latitude and longitude');
    location = { lat, lng };
  }
  return { results, photos, findings: text(body.findings, 4000) || null, location };
}

/** OPS-09: drafts carry a version, so a stale phone cannot overwrite newer work. */
export async function saveJobDraft(pool: Pool, principal: Principal, jobId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireStaff(w);
  const settings = await opsSettings(pool, w.tenantId);
  const d = readJobBody(body, settings.captureLocation);
  const version = Math.trunc(num(body.version));
  await checkPhotos(pool, w.tenantId, d.photos, { jobId });
  const { rows } = await pool.query<{ version: number }>(
    `update maintenance_job j set draft = $3, version = version + 1 from maintenance_plan p
      where j.id = $1 and j.tenant_id = $2 and p.id = j.plan_id and j.status = 'open' and j.version = $4 and p.team = any($5::text[]) returning j.version`,
    [jobId, w.tenantId, JSON.stringify(d), version, w.admin ? ['it', 'facilities'] : w.teams]);
  if (!rows[0]) {
    const { rows: cur } = await pool.query<{ version: number; status: string }>('select version, status from maintenance_job where id = $1 and tenant_id = $2', [jobId, w.tenantId]);
    if (!cur[0]) throw new InvalidInput('no such job');
    if (cur[0].status !== 'open') throw new InvalidInput('this job is already done');
    throw new InvalidInput(`saved elsewhere since you opened it (version ${cur[0].version}, yours ${version}); reload before saving`);
  }
  return { id: jobId, version: rows[0].version };
}

/** OPS-07: a failed check restricts the asset and opens corrective work. */
export async function completeJob(pool: Pool, principal: Principal, jobId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireStaff(w);
  const settings = await opsSettings(pool, w.tenantId);
  const d = readJobBody(body, settings.captureLocation);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; version: number; checklist: string[]; title: string; team: string; asset_id: string; tag: string }>(
      `select j.status, j.version, p.checklist, p.title, p.team, j.asset_id, a.tag from maintenance_job j join maintenance_plan p on p.id = j.plan_id join asset a on a.id = j.asset_id
        where j.id = $1 and j.tenant_id = $2 for update of j`, [jobId, w.tenantId]);
    const j = rows[0];
    if (!j) throw new InvalidInput('no such job');
    if (!inTeam(w, j.team)) throw new InvalidInput(`this is a job for the ${j.team.toUpperCase()} team`);
    if (j.status !== 'open') throw new InvalidInput('this job is already done');
    if (body.version !== undefined && Math.trunc(num(body.version)) !== j.version) throw new InvalidInput('saved elsewhere since you opened it; reload before finishing');
    await checkPhotos(client, w.tenantId, d.photos, { jobId });
    const unanswered = j.checklist.filter((c) => !['pass', 'fail', 'na'].includes(d.results[c] as string));
    if (unanswered.length) throw new InvalidInput(`answer every check: ${unanswered.join(', ')}`);
    const failed = j.checklist.filter((c) => d.results[c] === 'fail');
    if (failed.length && !d.findings) throw new InvalidInput('describe what failed');
    const outcome = failed.length ? 'fail' : 'pass';
    let ticketId: string | null = null;
    if (outcome === 'fail') {
      const number = await nextNumber(client, 'ticket', w.tenantId);
      const target = settings.targets['2'];
      const { rows: t } = await client.query<{ id: string }>(
        `insert into ticket (tenant_id, number, kind, title, description, requester_id, team, impact, urgency, priority, asset_id) values ($1, $2, 'corrective', $3, $4, $5, $6, 2, 1, 2, $7) returning id`,
        [w.tenantId, number, `Fix ${j.tag}: ${failed.join(', ')}`, d.findings, w.actorId, j.team, j.asset_id]);
      ticketId = t[0]!.id;
      await client.query('update ticket set respond_due = now() + make_interval(secs => $2), resolve_due = now() + make_interval(secs => $3) where id = $1', [ticketId, target.respond * 3600, target.resolve * 3600]);
      await client.query(`update asset set status = 'restricted', restricted_reason = $2, updated_at = now() where id = $1 and status not in ('retired', 'disposed', 'lost')`, [j.asset_id, `failed ${j.title}: ${failed.join(', ')}`]);
    }
    await client.query(
      `update maintenance_job set status = 'done', results = $2, findings = $3, photos = $4, location = $5, outcome = $6, follow_up_ticket = $7, completed_by = $8, completed_at = now(), draft = null, version = version + 1 where id = $1`,
      [jobId, JSON.stringify(d.results), d.findings, JSON.stringify(d.photos), d.location ? JSON.stringify(d.location) : null, outcome, ticketId, w.actorId]);
    await event(client, j.asset_id, outcome === 'fail' ? 'inspection_failed' : 'inspection_passed', w.actorId, { job: j.title, failed, ticketId });
    return { id: jobId, outcome, ticketId };
  });
}

/** A restriction is lifted only once its corrective work is resolved. */
export async function liftRestriction(pool: Pool, principal: Principal, assetId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireStaff(w);
  const why = text(body.note, 1000);
  if (!why) throw new InvalidInput('say what was done');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string }>('select status from asset where id = $1 and tenant_id = $2 for update', [assetId, w.tenantId]);
    if (!rows[0]) throw new InvalidInput('no such asset');
    if (rows[0].status !== 'restricted') throw new InvalidInput('this asset is not restricted');
    const { rows: open } = await client.query<{ number: number }>(`select number from ticket where asset_id = $1 and kind = 'corrective' and status not in ('resolved', 'closed', 'cancelled', 'rejected')`, [assetId]);
    if (open.length) throw new InvalidInput(`corrective work is still open: ${open.map((o) => `#${o.number}`).join(', ')}`);
    await client.query(`update asset set status = 'in_stock', restricted_reason = null, updated_at = now() where id = $1`, [assetId]);
    await event(client, assetId, 'restriction_lifted', w.actorId, { note: why });
    return { id: assetId, status: 'in_stock' };
  });
}

// ----------------------------------------------------------------- changes

export async function createChange(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireStaff(w);
  const title = text(body.title, 200); const impact = text(body.impact, 2000); const rollback = text(body.rollbackPlan, 4000);
  if (!title) throw new InvalidInput('name the change');
  if (!impact) throw new InvalidInput('describe the impact');
  if (!rollback) throw new InvalidInput('a change needs a rollback plan');
  const risk = text(body.risk, 10);
  if (!['low', 'medium', 'high'].includes(risk)) throw new InvalidInput('risk must be low, medium or high');
  const kind = body.kind === 'emergency' ? 'emergency' : 'normal';
  const start = when(body.windowStart, 'windowStart'); const end = when(body.windowEnd, 'windowEnd');
  if (kind === 'normal') {
    if (!start || !end) throw new InvalidInput('a normal change needs an execution window');
    if (end <= start) throw new InvalidInput('the window ends before it starts');
  }
  const preconditions = list(body.preconditions, 30).map((t) => ({ text: t, done: false, by: null as string | null, at: null as string | null }));
  return inTransaction(pool, async (client) => {
    const number = await nextNumber(client, 'change_request', w.tenantId);
    const { rows } = await client.query<{ id: string }>(
      `insert into change_request (tenant_id, number, title, kind, description, impact, risk, system_id, asset_id, preconditions, rollback_plan, window_start, window_end, requested_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
      [w.tenantId, number, title, kind, text(body.description, 4000) || null, impact, risk, body.systemId ? id(body.systemId, 'systemId') : null, body.assetId ? id(body.assetId, 'assetId') : null,
        JSON.stringify(preconditions), rollback, start, end, w.actorId]);
    return { id: rows[0]!.id, number, kind };
  });
}

async function changeFor(client: Client, w: Who, changeId: string) {
  if (!UUID.test(changeId)) throw new InvalidInput('no such change');
  const { rows } = await client.query<{ id: string; kind: string; status: string; requested_by: string; started_by: string | null; window_start: Date | null; window_end: Date | null; preconditions: { text: string; done: boolean; by: string | null; at: string | null }[]; system_owner: string | null; finished_at: Date | null; retrospective: string | null }>(
    `select c.*, s.owner_id as system_owner from change_request c left join access_system s on s.id = c.system_id where c.id = $1 and c.tenant_id = $2 for update of c`, [changeId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such change');
  return rows[0];
}

export async function decideChange(pool: Pool, principal: Principal, changeId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const approve = body.decision === 'approve';
  const why = text(body.note, 1000);
  if (!why) throw new InvalidInput('record the reason');
  return inTransaction(pool, async (client) => {
    const c = await changeFor(client, w, changeId);
    if (c.kind !== 'normal') throw new InvalidInput('an emergency change is reviewed afterwards, not approved first');
    if (c.status !== 'submitted') throw new InvalidInput('already decided');
    if (!(w.admin || c.system_owner === w.actorId)) throw new InvalidInput("an owner, admin or the system's owner approves changes");
    if (c.requested_by === w.actorId) throw new InvalidInput('someone other than the person asking approves');
    await client.query(`update change_request set status = $2, approved_by = $3, approved_at = now(), decision_note = $4 where id = $1`, [changeId, approve ? 'approved' : 'rejected', w.actorId, why]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: approve ? 'ops.change_approved' : 'ops.change_rejected', targetId: changeId, detail: { why } });
    return { id: changeId, status: approve ? 'approved' : 'rejected' };
  });
}

export async function checkPrecondition(pool: Pool, principal: Principal, changeId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireStaff(w);
  const index = Math.trunc(num(body.index));
  return inTransaction(pool, async (client) => {
    const c = await changeFor(client, w, changeId);
    if (!['submitted', 'approved'].includes(c.status)) throw new InvalidInput('the change has started or ended');
    if (!c.preconditions[index]) throw new InvalidInput('no such precondition');
    c.preconditions[index] = { ...c.preconditions[index]!, done: true, by: w.actorId, at: new Date().toISOString() };
    await client.query('update change_request set preconditions = $2 where id = $1', [changeId, JSON.stringify(c.preconditions)]);
    return { preconditions: c.preconditions };
  });
}

export async function startChange(pool: Pool, principal: Principal, changeId: string) {
  const w = await who(pool, principal); requireStaff(w);
  return inTransaction(pool, async (client) => {
    const c = await changeFor(client, w, changeId);
    const now = Date.now();
    if (c.kind === 'normal') {
      if (c.status !== 'approved') throw new InvalidInput('a normal change starts only once approved');
      if (now < c.window_start!.getTime() || now > c.window_end!.getTime()) throw new InvalidInput(`outside the approved window (${c.window_start!.toISOString()} to ${c.window_end!.toISOString()})`);
    } else {
      // The expedited route: an owner, admin or IT member may start it now.
      if (c.status !== 'submitted') throw new InvalidInput(`this change is ${c.status}`);
      requireIt(w);
    }
    const open = c.preconditions.filter((p) => !p.done).map((p) => p.text);
    if (open.length) throw new InvalidInput(`preconditions not met: ${open.join('; ')}`);
    await client.query(`update change_request set status = 'in_progress', started_by = $2, started_at = now() where id = $1`, [changeId, w.actorId]);
    return { id: changeId, status: 'in_progress' };
  });
}

export async function finishChange(pool: Pool, principal: Principal, changeId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireStaff(w);
  const outcome = text(body.outcome, 20);
  if (!['completed', 'failed', 'rolled_back'].includes(outcome)) throw new InvalidInput('outcome must be completed, failed or rolled_back');
  const verification = text(body.verification, 4000);
  if (!verification) throw new InvalidInput('record how the result was checked');
  return inTransaction(pool, async (client) => {
    const c = await changeFor(client, w, changeId);
    if (c.status !== 'in_progress') throw new InvalidInput('this change is not in progress');
    await client.query(`update change_request set status = $2, verification = $3, finished_at = now() where id = $1`, [changeId, outcome, verification]);
    return { id: changeId, status: outcome, retrospectiveDue: c.kind === 'emergency' };
  });
}

/** The emergency route's other half: a review afterwards by someone who did not run it. */
export async function reviewEmergencyChange(pool: Pool, principal: Principal, changeId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireAdmin(w);
  const review = text(body.review, 4000);
  if (!review) throw new InvalidInput('write the review');
  return inTransaction(pool, async (client) => {
    const c = await changeFor(client, w, changeId);
    if (c.kind !== 'emergency') throw new InvalidInput('only emergency changes are reviewed afterwards');
    if (!c.finished_at) throw new InvalidInput('the change has not finished');
    if (c.retrospective) throw new InvalidInput('already reviewed');
    if (c.started_by === w.actorId || c.requested_by === w.actorId) throw new InvalidInput('someone other than the people who asked for and ran the change reviews it');
    await client.query(`update change_request set retrospective = $2, retrospective_by = $3, retrospective_at = now() where id = $1`, [changeId, review, w.actorId]);
    return { id: changeId };
  });
}

export async function listChanges(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireStaff(w);
  const { rows } = await pool.query(
    `select c.id, c.number, c.title, c.kind, c.risk, c.status, c.impact, c.rollback_plan, c.preconditions, c.window_start, c.window_end, c.decision_note, c.verification, c.retrospective,
            c.finished_at, c.created_at, r.display_name as requested_by, c.requested_by as requested_by_id, a.display_name as approved_by, s.display_name as started_by, c.started_by as started_by_id, sys.name as system, x.tag as asset
       from change_request c join actor r on r.id = c.requested_by left join actor a on a.id = c.approved_by left join actor s on s.id = c.started_by
       left join access_system sys on sys.id = c.system_id left join asset x on x.id = c.asset_id
      where c.tenant_id = $1 order by c.status in ('completed', 'failed', 'rolled_back', 'rejected'), c.created_at desc limit 200`, [w.tenantId]);
  return rows;
}

// --------------------------------------------------------------- dashboard

/** OPS-10. */
export async function opsDashboard(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireStaff(w);
  await sweepTickets(pool, w.tenantId);
  await reconcileAccess(pool, w.tenantId);
  await generateMaintenance(pool, { tenantId: w.tenantId });
  const { rows: backlog } = await pool.query<{ team: string; status: string; n: number }>(
    `select team, status, count(*)::int as n from ticket where tenant_id = $1 and status in ('new', 'in_progress', 'waiting_on_user', 'awaiting_approval') group by team, status`, [w.tenantId]);
  const { rows: aging } = await pool.query<{ bucket: string; n: number }>(
    `select case when now() - created_at < interval '3 days' then '0-2 days' when now() - created_at < interval '8 days' then '3-7 days'
                 when now() - created_at < interval '31 days' then '8-30 days' else 'over 30 days' end as bucket, count(*)::int as n
       from ticket where tenant_id = $1 and status in ('new', 'in_progress', 'waiting_on_user') group by 1`, [w.tenantId]);
  const { rows: breached } = await pool.query(
    `select id, number, title, team, priority, resolve_due from ticket where tenant_id = $1 and breached_at is not null and status in ('new', 'in_progress', 'waiting_on_user') order by resolve_due`, [w.tenantId]);
  const recovery = await recoveryList(pool, w.tenantId);
  const { rows: maintenance } = await pool.query(
    `select j.id, j.due_on::text, p.title, a.tag, (j.due_on < current_date) as overdue from maintenance_job j join maintenance_plan p on p.id = j.plan_id join asset a on a.id = j.asset_id
      where j.tenant_id = $1 and j.status = 'open' and j.due_on <= current_date + 14 order by j.due_on`, [w.tenantId]);
  const { rows: failedAccess } = await pool.query(
    `select 'revocation' as kind, g.id, s.name as system, g.role, h.display_name as holder, g.status, coalesce(g.failure_note, g.revoke_reason) as note, coalesce(g.failed_at, g.revoke_requested_at) as since
       from access_grant g join access_system s on s.id = g.system_id join actor h on h.id = g.holder_id
      where g.tenant_id = $1 and (g.status = 'revoke_failed' or (g.status = 'revoking' and g.revoke_requested_at < now() - interval '24 hours'))
     union all
     select 'provisioning', r.id, s.name, r.role, h.display_name, r.status, r.failure_note, r.created_at
       from access_request r join access_system s on s.id = r.system_id join actor h on h.id = r.holder_id where r.tenant_id = $1 and r.status = 'failed'
     order by since`, [w.tenantId]);
  const { rows: pendingRevocations } = await pool.query<{ n: number }>(`select count(*)::int as n from access_grant where tenant_id = $1 and status = 'revoking'`, [w.tenantId]);
  const { rows: retros } = await pool.query(`select id, number, title from change_request where tenant_id = $1 and kind = 'emergency' and finished_at is not null and retrospective is null`, [w.tenantId]);
  const { rows: restricted } = await pool.query(`select id, tag, name, restricted_reason from asset where tenant_id = $1 and status = 'restricted'`, [w.tenantId]);
  return { backlog, aging, breached, recovery, maintenance, failedAccess, pendingRevocations: pendingRevocations[0]!.n, retrospectivesDue: retros, restricted };
}

export async function opsSummary(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query<{ mine: number; assets_to_ack: number; approvals: number; access_to_decide: number }>(
    `select (select count(*)::int from ticket where requester_id = $2 and status in ('waiting_on_user', 'resolved')) as mine,
            (select count(*)::int from asset_assignment s join asset a on a.id = s.asset_id where a.tenant_id = $1 and s.custodian_id = $2 and s.status = 'pending_ack') as assets_to_ack,
            (select count(*)::int from ticket where approver_id = $2 and status = 'awaiting_approval') as approvals,
            (select count(*)::int from access_request r join access_system s on s.id = r.system_id where r.tenant_id = $1 and s.owner_id = $2 and r.status = 'requested') as access_to_decide`,
    [w.tenantId, w.actorId]);
  let queue = 0;
  if (w.staff) {
    const { rows: q } = await pool.query<{ n: number }>(`select count(*)::int as n from ticket where tenant_id = $1 and team = any($2::text[]) and status in ('new', 'in_progress')`, [w.tenantId, w.admin ? ['it', 'facilities'] : w.teams]);
    queue = q[0]!.n;
  }
  return { ...rows[0], queue, staff: w.staff, admin: w.admin, teams: w.teams, role: w.role };
}
