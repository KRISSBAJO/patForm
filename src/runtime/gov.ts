/**
 * Contracts, compliance and audit (PRD Module 10).
 *
 * The rules that matter most:
 *   - Approvals belong to a contract version. A material revision (flagged,
 *     or any change to value, dates, notice, renewal or counterparty)
 *     invalidates the approvals the workspace's policy names, so the
 *     revision goes back for review (GOV-02, acceptance 1).
 *   - Signature is tracked apart from approval: only an approved version can
 *     go out, and a signed artifact is required to call it signed (GOV-03).
 *   - Renewal tasks are dated from the notice deadline — the end date less
 *     the notice period, in calendar or working days with the workspace's
 *     public holidays — and created once each (GOV-04, acceptance 2).
 *   - Auditors read only what their engagement covers, until it expires;
 *     every look, export and refusal is logged; export is a separate right;
 *     they can change nothing (GOV-10, acceptance 3).
 *   - Legal holds are visible only to owners and the legal team. Retention
 *     skips held records and records the blocked purge; a released hold
 *     still blocks until someone reviews it (GOV-09, acceptance 4; the purge
 *     side lives in retention.ts).
 *   - Storing controls here is not a certification (GOV-06).
 */
import { createHash } from 'node:crypto';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { enabledModules } from './modules.js';
import { managerOf } from './org.js';

const UUID = /^[0-9a-f-]{36}$/;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[, ]/g, '')); return Number.isFinite(n) ? n : NaN; };
const today = () => new Date().toISOString().slice(0, 10);
function id(v: unknown, what: string): string { const s = text(v, 36); if (!UUID.test(s)) throw new InvalidInput(`${what} must be an id`); return s; }
function day(v: unknown, what: string, required = false): string | null {
  const s = text(v, 10);
  if (!s) { if (required) throw new InvalidInput(`${what} is required`); return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new InvalidInput(`${what} must be a date`);
  return s;
}
const list = (v: unknown, max = 50) => (Array.isArray(v) ? v.map((x) => text(x, 200)).filter(Boolean).slice(0, max) : []);
const addDays = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const addMonths = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCMonth(t.getUTCMonth() + n); return t.toISOString().slice(0, 10); };

// ------------------------------------------------------------------ access

export type Team = 'legal' | 'compliance' | 'security' | 'finance';
interface Who { tenantId: string; actorId: string; role: string; admin: boolean; owner: boolean; teams: Team[]; auditor: boolean }
async function who(pool: Pool | Client, principal: Principal): Promise<Who> {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  if (!(await enabledModules(pool as Pool, principal.tenantId)).has('contracts')) {
    throw new InvalidInput('the Contracts and compliance module is switched off for this workspace — an owner can switch it on in Settings');
  }
  const { rows } = await pool.query<{ workspace_role: string; active: boolean }>('select workspace_role, active from actor where id = $1 and tenant_id = $2', [principal.actorId, principal.tenantId]);
  if (!rows[0]?.active || rows[0].workspace_role === 'pre_hire') throw new InvalidInput('this opens after your first day');
  const { rows: t } = await pool.query<{ team: Team }>('select team from gov_member where tenant_id = $1 and actor_id = $2', [principal.tenantId, principal.actorId]);
  const role = rows[0].workspace_role;
  return { tenantId: principal.tenantId, actorId: principal.actorId, role, admin: ['owner', 'admin'].includes(role), owner: role === 'owner', teams: t.map((r) => r.team), auditor: role === 'auditor' };
}
/** Everything except the auditor's read-only views goes through this. */
async function member(pool: Pool | Client, principal: Principal): Promise<Who> {
  const w = await who(pool, principal);
  if (w.auditor) throw new InvalidInput('auditors have read-only access to their engagement only');
  return w;
}
const inTeam = (w: Who, ...teams: Team[]) => w.admin || teams.some((t) => w.teams.includes(t));
const requireTeam = (w: Who, ...teams: Team[]) => { if (!inTeam(w, ...teams)) throw new InvalidInput(`only ${teams.join(' or ')} (or an admin) can do this`); };
const requireAdmin = (w: Who) => { if (!w.admin) throw new InvalidInput('only an owner or admin can do this'); };
/** Holds are seen only by owners and the legal team (GOV-09). */
const holdManager = (w: Who) => w.owner || w.teams.includes('legal');

async function nextNumber(client: Client, table: 'contract', tenantId: string) {
  await client.query('select pg_advisory_xact_lock(hashtext($1 || $2))', [table, tenantId]);
  const { rows } = await client.query<{ n: number }>(`select coalesce(max(number), 100) + 1 as n from ${table} where tenant_id = $1`, [tenantId]);
  return rows[0]!.n;
}

// ---------------------------------------------------------------- settings

export type Discipline = 'business' | 'legal' | 'security' | 'finance';
export interface GovSettings {
  /** Reviews every contract needs. */
  alwaysReview: Discipline[];
  /** Finance reviews contracts at or above this value; null means never by value. */
  financeAbove: number | null;
  /** Security reviews contracts that handle personal data. */
  securityForPersonalData: boolean;
  /** Which approvals a material revision cancels. */
  materialInvalidates: Discipline[];
  /** How many days before the notice deadline the renewal task appears. */
  renewalLeadDays: number;
  /** How many days ahead obligation tasks appear. */
  obligationLeadDays: number;
}
export const DEFAULT_GOV: GovSettings = { alwaysReview: ['business', 'legal'], financeAbove: 50000, securityForPersonalData: true, materialInvalidates: ['business', 'legal', 'security', 'finance'], renewalLeadDays: 30, obligationLeadDays: 14 };
const DISCIPLINES: Discipline[] = ['business', 'legal', 'security', 'finance'];

export async function govSettings(client: Client | Pool, tenantId: string): Promise<GovSettings> {
  const { rows } = await client.query<{ settings: Partial<GovSettings> }>('select settings from gov_settings where tenant_id = $1', [tenantId]);
  return { ...DEFAULT_GOV, ...(rows[0]?.settings ?? {}) };
}
export async function readGovSettings(pool: Pool, principal: Principal) {
  const w = await member(pool, principal);
  const { rows } = await pool.query(`select m.team, m.actor_id, a.display_name from gov_member m join actor a on a.id = m.actor_id where m.tenant_id = $1 order by m.team, a.display_name`, [w.tenantId]);
  return { settings: await govSettings(pool, w.tenantId), teams: rows, me: { admin: w.admin, owner: w.owner, teams: w.teams, holds: holdManager(w) } };
}
export async function updateGovSettings(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireAdmin(w);
  const cur = await govSettings(pool, w.tenantId);
  const next: GovSettings = { ...cur };
  const pick = (v: unknown) => list(v).filter((d): d is Discipline => DISCIPLINES.includes(d as Discipline));
  if (body.alwaysReview !== undefined) { next.alwaysReview = pick(body.alwaysReview); if (!next.alwaysReview.length) throw new InvalidInput('every contract needs at least one review'); }
  if (body.materialInvalidates !== undefined) { next.materialInvalidates = pick(body.materialInvalidates); if (!next.materialInvalidates.includes('legal')) throw new InvalidInput('a material change must at least send the contract back to Legal'); }
  if (body.financeAbove !== undefined) { const n = body.financeAbove === null || body.financeAbove === '' ? null : num(body.financeAbove); if (n !== null && !(n >= 0)) throw new InvalidInput('financeAbove must be 0 or more'); next.financeAbove = n; }
  if (body.securityForPersonalData !== undefined) next.securityForPersonalData = body.securityForPersonalData === true;
  for (const k of ['renewalLeadDays', 'obligationLeadDays'] as const) if (body[k] !== undefined) { const n = Math.trunc(num(body[k])); if (!(n >= 0 && n <= 365)) throw new InvalidInput(`${k} must be 0 to 365`); next[k] = n; }
  await pool.query(`insert into gov_settings (tenant_id, settings, updated_by) values ($1, $2, $3) on conflict (tenant_id) do update set settings = excluded.settings, updated_by = excluded.updated_by, updated_at = now()`, [w.tenantId, JSON.stringify(next), w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'gov.settings_changed', targetId: w.tenantId, detail: { before: cur, after: next } });
  return next;
}
export async function setGovTeamMember(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireAdmin(w);
  const team = text(body.team, 20);
  if (!['legal', 'compliance', 'security', 'finance'].includes(team)) throw new InvalidInput('team must be legal, compliance, security or finance');
  const actorId = id(body.actorId, 'actorId');
  const { rows } = await pool.query<{ workspace_role: string }>('select workspace_role from actor where id = $1 and tenant_id = $2 and active', [actorId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such member');
  if (rows[0].workspace_role === 'auditor') throw new InvalidInput('an auditor cannot join an internal team');
  if (body.remove === true) await pool.query('delete from gov_member where tenant_id = $1 and team = $2 and actor_id = $3', [w.tenantId, team, actorId]);
  else await pool.query('insert into gov_member (tenant_id, team, actor_id) values ($1, $2, $3) on conflict do nothing', [w.tenantId, team, actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: body.remove === true ? 'gov.team_removed' : 'gov.team_added', targetId: actorId, detail: { team } });
  return { team, actorId };
}

// --------------------------------------------------------------- contracts

interface Terms { counterparty: string; value: number | null; currency: string | null; start_date: string | null; end_date: string | null; notice_days: number | null; auto_renews: boolean }
const TERM_KEYS: (keyof Terms)[] = ['counterparty', 'value', 'currency', 'start_date', 'end_date', 'notice_days', 'auto_renews'];

function readTerms(body: Record<string, unknown>, base?: Terms): Terms {
  const t: Terms = base ? { ...base } : { counterparty: '', value: null, currency: null, start_date: null, end_date: null, notice_days: null, auto_renews: false };
  if (body.counterparty !== undefined) t.counterparty = text(body.counterparty, 200);
  if (body.value !== undefined) { const v = body.value === null || body.value === '' ? null : num(body.value); if (v !== null && !(v >= 0)) throw new InvalidInput('value must be 0 or more'); t.value = v; }
  if (body.currency !== undefined) t.currency = text(body.currency, 3).toUpperCase() || null;
  if (body.startDate !== undefined) t.start_date = day(body.startDate, 'startDate');
  if (body.endDate !== undefined) t.end_date = day(body.endDate, 'endDate');
  if (body.noticeDays !== undefined) { const n = body.noticeDays === null || body.noticeDays === '' ? null : Math.trunc(num(body.noticeDays)); if (n !== null && !(n >= 0 && n <= 3650)) throw new InvalidInput('noticeDays must be 0 to 3650'); t.notice_days = n; }
  if (body.autoRenews !== undefined) t.auto_renews = body.autoRenews === true;
  if (!t.counterparty) throw new InvalidInput('name the other party');
  if (t.start_date && t.end_date && t.end_date < t.start_date) throw new InvalidInput('the contract ends before it starts');
  if (t.value !== null && !t.currency) throw new InvalidInput('give the currency of the value');
  return t;
}

function requiredReviews(s: GovSettings, c: { value: string | number | null; personal_data: boolean }): Discipline[] {
  const out = new Set<Discipline>(s.alwaysReview);
  if (s.financeAbove !== null && c.value !== null && Number(c.value) >= s.financeAbove) out.add('finance');
  if (s.securityForPersonalData && c.personal_data) out.add('security');
  return DISCIPLINES.filter((d) => out.has(d));
}

async function contractFor(client: Client | Pool, w: Who, contractId: string, lock = false) {
  if (!UUID.test(contractId)) throw new InvalidInput('no such contract');
  const { rows } = await client.query<{ id: string; number: number; title: string; owner_id: string; status: string; current_version: number; value: string | null; personal_data: boolean; counterparty: string; currency: string | null; start_date: string | null; end_date: string | null; notice_days: number | null; auto_renews: boolean; notice_calendar: string }>(
    `select *, start_date::text, end_date::text from contract where id = $1 and tenant_id = $2 ${lock ? 'for update' : ''}`, [contractId, w.tenantId]);
  const c = rows[0];
  if (!c) throw new InvalidInput('no such contract');
  // The owner, the review teams, and the owner's manager (who gives the business review).
  if (!(c.owner_id === w.actorId || inTeam(w, 'legal', 'compliance', 'finance', 'security')
        || (await managerOf(client, { tenantId: w.tenantId, actorId: c.owner_id, at: new Date() }))?.id === w.actorId)) throw new InvalidInput('no such contract');
  return c;
}

export async function listContracts(pool: Pool, principal: Principal) {
  const w = await member(pool, principal);
  const all = inTeam(w, 'legal', 'compliance', 'finance', 'security');
  const { rows } = await pool.query(
    `select c.id, c.number, c.title, c.counterparty, c.status, c.current_version, c.value, c.currency, c.start_date::text, c.end_date::text, c.notice_days, c.notice_calendar, c.auto_renews,
            o.display_name as owner, v.name as vendor
       from contract c join actor o on o.id = c.owner_id left join vendor v on v.id = c.vendor_id
      where c.tenant_id = $1 and ($2 or c.owner_id = $3) order by c.status in ('expired', 'terminated'), c.end_date nulls last`, [w.tenantId, all, w.actorId]);
  return rows;
}

export async function createContract(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const title = text(body.title, 200);
  if (!title) throw new InvalidInput('give the contract a title');
  const terms = readTerms(body);
  const ownerId = body.ownerId ? id(body.ownerId, 'ownerId') : w.actorId;
  const calendar = body.noticeCalendar === 'business' ? 'business' : 'calendar';
  return inTransaction(pool, async (client) => {
    const { rows: o } = await client.query('select 1 from actor where id = $1 and tenant_id = $2 and active', [ownerId, w.tenantId]);
    if (!o[0]) throw new InvalidInput('no such owner');
    let vendorId: string | null = null;
    if (body.vendorId) { vendorId = id(body.vendorId, 'vendorId'); const { rows } = await client.query('select 1 from vendor where id = $1 and tenant_id = $2', [vendorId, w.tenantId]); if (!rows[0]) throw new InvalidInput('no such supplier'); }
    const number = await nextNumber(client, 'contract', w.tenantId);
    const { rows } = await client.query<{ id: string }>(
      `insert into contract (tenant_id, number, title, counterparty, vendor_id, entity, project, owner_id, value, currency, start_date, end_date, auto_renews, notice_days, notice_calendar, personal_data, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) returning id`,
      [w.tenantId, number, title, terms.counterparty, vendorId, text(body.entity, 120) || null, text(body.project, 120) || null, ownerId, terms.value, terms.currency, terms.start_date, terms.end_date,
        terms.auto_renews, terms.notice_days, calendar, body.personalData === true, w.actorId]);
    await client.query(`insert into contract_version (contract_id, version, document_ref, changes, material, terms, created_by) values ($1, 1, $2, 'First version', true, $3, $4)`,
      [rows[0]!.id, text(body.documentRef, 500) || null, JSON.stringify(terms), w.actorId]);
    return { id: rows[0]!.id, number };
  });
}

async function reviewState(client: Client | Pool, w: Who, c: { id: string; current_version: number; value: string | number | null; personal_data: boolean }) {
  const s = await govSettings(client, w.tenantId);
  const required = requiredReviews(s, c);
  const { rows } = await client.query<{ discipline: Discipline; decision: string; reviewer: string; decided_at: Date; note: string | null }>(
    `select distinct on (r.discipline) r.discipline, r.decision, a.display_name as reviewer, r.decided_at, r.note from contract_review r join actor a on a.id = r.reviewer_id
      where r.contract_id = $1 and r.version = $2 and r.invalidated_at is null order by r.discipline, r.decided_at desc`, [c.id, c.current_version]);
  const by = new Map(rows.map((r) => [r.discipline, r]));
  return { required, decisions: required.map((d) => ({ ...(by.get(d) ?? { decision: 'waiting' }), discipline: d })), approved: required.every((d) => by.get(d)?.decision === 'approved') };
}

export async function contractDetail(pool: Pool, principal: Principal, contractId: string) {
  const w = await member(pool, principal);
  const c = await contractFor(pool, w, contractId);
  const { rows: versions } = await pool.query(`select v.version, v.document_ref, v.changes, v.material, v.terms, v.created_at, a.display_name as by from contract_version v left join actor a on a.id = v.created_by where v.contract_id = $1 order by v.version desc`, [contractId]);
  const { rows: reviews } = await pool.query(`select r.version, r.discipline, r.decision, r.note, r.decided_at, r.invalidated_at, r.invalidated_reason, a.display_name as reviewer from contract_review r join actor a on a.id = r.reviewer_id where r.contract_id = $1 order by r.decided_at desc`, [contractId]);
  const { rows: envelopes } = await pool.query(`select id, version, provider, envelope_ref, status, signed_artifact_ref, history, updated_at from contract_envelope where contract_id = $1 order by created_at desc`, [contractId]);
  const { rows: tasks } = await pool.query(`select t.id, t.kind, t.title, t.due_on::text, t.notice_deadline::text, t.status, t.evidence, t.note, a.display_name as owner from obligation_task t join actor a on a.id = t.owner_id where t.contract_id = $1 order by t.due_on desc`, [contractId]);
  const { rows: obligations } = await pool.query(`select o.id, o.title, o.kind, o.every_months, o.next_due::text, o.active, a.display_name as owner from obligation o join actor a on a.id = o.owner_id where o.contract_id = $1`, [contractId]);
  const holidays = await holidaysFor(pool, w.tenantId);
  return { contract: c, versions, reviews, envelopes, tasks, obligations, review: await reviewState(pool, w, c), noticeDeadline: c.end_date && c.notice_days !== null ? noticeDeadline(c.end_date, c.notice_days, c.notice_calendar as 'calendar' | 'business', holidays) : null };
}

/**
 * GOV-02, acceptance 1. A new version. Material when flagged, or when any
 * key term changes; then the approvals the policy names are cancelled and
 * the contract goes back for review. A non-material change carries the
 * still-valid approvals forward, saying so.
 */
export async function reviseContract(pool: Pool, principal: Principal, contractId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const changes = text(body.changes, 2000);
  if (!changes) throw new InvalidInput('describe what changed');
  return inTransaction(pool, async (client) => {
    const c = await contractFor(client, w, contractId, true);
    if (!(c.owner_id === w.actorId || inTeam(w, 'legal'))) throw new InvalidInput('the owner or Legal revises a contract');
    if (['signed', 'expired', 'terminated'].includes(c.status)) throw new InvalidInput(`a ${c.status} contract is changed by an amendment, as a new contract`);
    const { rows: prev } = await client.query<{ terms: Terms }>('select terms from contract_version where contract_id = $1 and version = $2', [contractId, c.current_version]);
    const before = prev[0]!.terms;
    const after = readTerms(body, before);
    const changed = TERM_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const material = body.material === true || changed.length > 0;
    const version = c.current_version + 1;
    await client.query(`insert into contract_version (contract_id, version, document_ref, changes, material, terms, created_by) values ($1, $2, $3, $4, $5, $6, $7)`,
      [contractId, version, text(body.documentRef, 500) || null, changes, material, JSON.stringify(after), w.actorId]);
    await client.query(`update contract set current_version = $2, counterparty = $3, value = $4, currency = $5, start_date = $6, end_date = $7, notice_days = $8, auto_renews = $9, updated_at = now() where id = $1`,
      [contractId, version, after.counterparty, after.value, after.currency, after.start_date, after.end_date, after.notice_days, after.auto_renews]);
    const s = await govSettings(client, w.tenantId);
    const { rows: valid } = await client.query<{ id: string; discipline: Discipline; reviewer_id: string; decision: string; note: string | null }>(
      `select distinct on (discipline) id, discipline, reviewer_id, decision, note from contract_review where contract_id = $1 and version = $2 and invalidated_at is null order by discipline, decided_at desc`, [contractId, c.current_version]);
    const reason = `material revision v${version}${changed.length ? ` (${changed.join(', ').replace(/_/g, ' ')})` : ''}`;
    const cancelled: string[] = [];
    for (const r of valid) {
      if (material && s.materialInvalidates.includes(r.discipline)) {
        await client.query('update contract_review set invalidated_at = now(), invalidated_reason = $2 where id = $1', [r.id, reason]);
        cancelled.push(r.discipline);
      } else {
        await client.query(`insert into contract_review (contract_id, version, discipline, reviewer_id, decision, note) values ($1, $2, $3, $4, $5, $6)`,
          [contractId, version, r.discipline, r.reviewer_id, r.decision, `carried over from v${c.current_version}${material ? '' : ' (non-material change)'}${r.note ? `: ${r.note}` : ''}`]);
      }
    }
    // Anything out for signature was for the old version.
    await client.query(`update contract_envelope set status = 'voided', updated_at = now(), history = history || $2::jsonb where contract_id = $1 and status in ('sent', 'delivered')`,
      [contractId, JSON.stringify([{ at: new Date().toISOString(), status: 'voided', note: `superseded by v${version}` }])]);
    const state = await reviewState(client, w, { ...c, current_version: version });
    const status = c.status === 'draft' ? 'draft' : state.approved ? 'approved' : 'in_review';
    await client.query('update contract set status = $2 where id = $1', [contractId, status]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'gov.contract_revised', targetId: contractId, detail: { version, material, changed, cancelled } });
    return { version, material, changed, cancelled, status };
  });
}

export async function submitContract(pool: Pool, principal: Principal, contractId: string) {
  const w = await member(pool, principal);
  return inTransaction(pool, async (client) => {
    const c = await contractFor(client, w, contractId, true);
    if (c.owner_id !== w.actorId && !w.admin) throw new InvalidInput('the owner sends the contract for review');
    if (c.status !== 'draft') throw new InvalidInput('only a draft is sent for review');
    const state = await reviewState(client, w, c);
    await client.query('update contract set status = $2, updated_at = now() where id = $1', [contractId, state.approved ? 'approved' : 'in_review']);
    return { status: state.approved ? 'approved' : 'in_review', required: state.required };
  });
}

/** Who may give each kind of review: the business owner's manager or an admin; the legal, security or finance team. */
async function canReview(client: Client, w: Who, discipline: Discipline, ownerId: string): Promise<boolean> {
  if (discipline === 'business') return w.admin || (await managerOf(client, { tenantId: w.tenantId, actorId: ownerId, at: new Date() }))?.id === w.actorId;
  return w.teams.includes(discipline as Team) || w.admin;
}

export async function reviewContract(pool: Pool, principal: Principal, contractId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const discipline = text(body.discipline, 20) as Discipline;
  if (!DISCIPLINES.includes(discipline)) throw new InvalidInput('discipline must be business, legal, security or finance');
  const decision = body.decision === 'approve' ? 'approved' : body.decision === 'changes' ? 'changes_requested' : null;
  if (!decision) throw new InvalidInput('decide approve or changes');
  const note = text(body.note, 2000);
  if (decision === 'changes_requested' && !note) throw new InvalidInput('say what needs to change');
  return inTransaction(pool, async (client) => {
    const c = await contractFor(client, w, contractId, true);
    if (c.status !== 'in_review') throw new InvalidInput(c.status === 'draft' ? 'the owner has not sent it for review yet' : `this contract is ${c.status.replace(/_/g, ' ')}`);
    const state = await reviewState(client, w, c);
    if (!state.required.includes(discipline)) throw new InvalidInput(`this contract does not need a ${discipline} review`);
    if (!(await canReview(client, w, discipline, c.owner_id))) throw new InvalidInput(discipline === 'business' ? "the owner's manager or an admin gives the business review" : `only the ${discipline} team gives this review`);
    const { rows: author } = await client.query<{ created_by: string | null }>('select created_by from contract_version where contract_id = $1 and version = $2', [contractId, c.current_version]);
    if (author[0]?.created_by === w.actorId) throw new InvalidInput('someone other than the author of this version reviews it');
    await client.query(`insert into contract_review (contract_id, version, discipline, reviewer_id, decision, note) values ($1, $2, $3, $4, $5, $6)`, [contractId, c.current_version, discipline, w.actorId, decision, note || null]);
    const after = await reviewState(client, w, c);
    if (after.approved) await client.query(`update contract set status = 'approved', updated_at = now() where id = $1`, [contractId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: `gov.contract_${decision}`, targetId: contractId, detail: { version: c.current_version, discipline, note } });
    return { status: after.approved ? 'approved' : 'in_review', decisions: after.decisions };
  });
}

/** GOV-03: an envelope for the approved version, tracked apart from approval. */
export async function sendForSignature(pool: Pool, principal: Principal, contractId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const provider = text(body.provider, 80); const ref = text(body.envelopeRef, 200);
  if (!provider || !ref) throw new InvalidInput('give the signature provider and the envelope reference');
  return inTransaction(pool, async (client) => {
    const c = await contractFor(client, w, contractId, true);
    if (c.owner_id !== w.actorId && !inTeam(w, 'legal')) throw new InvalidInput('the owner or Legal sends it for signature');
    if (c.status !== 'approved') throw new InvalidInput('only a contract approved in its current version can go for signature');
    const { rows } = await client.query<{ id: string }>(`insert into contract_envelope (contract_id, version, provider, envelope_ref, history, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [contractId, c.current_version, provider, ref, JSON.stringify([{ at: new Date().toISOString(), status: 'sent' }]), w.actorId]);
    await client.query(`update contract set status = 'out_for_signature', updated_at = now() where id = $1`, [contractId]);
    return { id: rows[0]!.id, version: c.current_version };
  });
}

export async function updateEnvelope(pool: Pool, principal: Principal, envelopeId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const status = text(body.status, 20);
  if (!['delivered', 'completed', 'declined', 'voided'].includes(status)) throw new InvalidInput('status must be delivered, completed, declined or voided');
  const artifact = text(body.signedArtifactRef, 500);
  if (status === 'completed' && !artifact) throw new InvalidInput('a completed envelope needs the signed document reference');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ contract_id: string; version: number; status: string }>(
      `select e.contract_id, e.version, e.status from contract_envelope e join contract c on c.id = e.contract_id where e.id = $1 and c.tenant_id = $2 for update of e`, [envelopeId, w.tenantId]);
    const e = rows[0];
    if (!e) throw new InvalidInput('no such envelope');
    const c = await contractFor(client, w, e.contract_id, true);
    if (['completed', 'declined', 'voided'].includes(e.status)) throw new InvalidInput(`this envelope is already ${e.status}`);
    if (status === 'completed' && e.version !== c.current_version) throw new InvalidInput(`this envelope is for v${e.version}; the contract is now v${c.current_version}`);
    await client.query(`update contract_envelope set status = $2, signed_artifact_ref = coalesce($3, signed_artifact_ref), updated_at = now(), history = history || $4::jsonb where id = $1`,
      [envelopeId, status, artifact || null, JSON.stringify([{ at: new Date().toISOString(), status, by: w.actorId }])]);
    const next = status === 'completed' ? 'signed' : status === 'delivered' ? 'out_for_signature' : 'approved';
    await client.query('update contract set status = $2, updated_at = now() where id = $1', [e.contract_id, next]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: `gov.envelope_${status}`, targetId: envelopeId, detail: { contract: e.contract_id, artifact } });
    return { status, contract: next };
  });
}

// ------------------------------------------------- obligations and renewals

async function holidaysFor(client: Client | Pool, tenantId: string): Promise<Set<string>> {
  const { rows } = await client.query<{ day: string }>('select day::text from public_holiday where tenant_id = $1', [tenantId]);
  return new Set(rows.map((r) => r.day));
}

/**
 * The last day notice can be given: the end date less the notice period.
 * In working days, weekends and the workspace's public holidays do not
 * count, and a deadline that lands on one moves earlier, never later.
 */
export function noticeDeadline(endDate: string, noticeDays: number, calendar: 'calendar' | 'business', holidays: Set<string>): string {
  const working = (d: string) => { const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); return wd !== 0 && wd !== 6 && !holidays.has(d); };
  if (calendar === 'calendar') {
    let d = addDays(endDate, -noticeDays);
    while (!working(d)) d = addDays(d, -1);
    return d;
  }
  let d = endDate; let left = noticeDays;
  while (left > 0) { d = addDays(d, -1); if (working(d)) left--; }
  while (!working(d)) d = addDays(d, -1);
  return d;
}

export async function createObligation(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const title = text(body.title, 200);
  if (!title) throw new InvalidInput('describe the obligation');
  const kind = text(body.kind, 20);
  if (!['recurring', 'one_off', 'event'].includes(kind)) throw new InvalidInput('kind must be recurring, one_off or event');
  const everyMonths = kind === 'recurring' ? Math.trunc(num(body.everyMonths)) : null;
  if (kind === 'recurring' && !(everyMonths! >= 1 && everyMonths! <= 120)) throw new InvalidInput('everyMonths must be 1 to 120');
  const nextDue = kind === 'event' ? null : day(body.firstDue, 'firstDue', true);
  const ownerId = body.ownerId ? id(body.ownerId, 'ownerId') : w.actorId;
  const contractId = body.contractId ? id(body.contractId, 'contractId') : null;
  if (contractId) await contractFor(pool, w, contractId);
  else requireTeam(w, 'compliance', 'legal');
  const escalateTo = body.escalateTo ? id(body.escalateTo, 'escalateTo') : null;
  const { rows } = await pool.query<{ id: string }>(
    `insert into obligation (tenant_id, contract_id, title, owner_id, kind, every_months, next_due, evidence_required, escalate_after_days, escalate_to, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [w.tenantId, contractId, title, ownerId, kind, everyMonths, nextDue, body.evidenceRequired !== false, body.escalateAfterDays === undefined ? 7 : Math.trunc(num(body.escalateAfterDays)), escalateTo, w.actorId]);
  return { id: rows[0]!.id };
}

/** An event-driven obligation: something happened, so the task is due now plus N days. */
export async function triggerObligation(pool: Pool, principal: Principal, obligationId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const note = text(body.note, 1000);
  if (!note) throw new InvalidInput('say what happened');
  const { rows } = await pool.query<{ kind: string; title: string; owner_id: string; contract_id: string | null }>('select kind, title, owner_id, contract_id from obligation where id = $1 and tenant_id = $2 and active', [obligationId, w.tenantId]);
  const o = rows[0];
  if (!o) throw new InvalidInput('no such obligation');
  if (o.kind !== 'event') throw new InvalidInput('only an event-driven obligation is triggered by hand');
  const due = addDays(today(), Math.max(0, Math.trunc(num(body.dueInDays ?? 7))));
  const { rows: t } = await pool.query<{ id: string }>(
    `insert into obligation_task (tenant_id, obligation_id, contract_id, kind, title, due_on, owner_id, note) values ($1, $2, $3, 'obligation', $4, $5, $6, $7) on conflict do nothing returning id`,
    [w.tenantId, obligationId, o.contract_id, o.title, due, o.owner_id, note]);
  if (!t[0]) throw new InvalidInput('a task for this obligation is already due that day');
  return { id: t[0].id, due };
}

/**
 * The daily sweep: renewal tasks before notice deadlines, obligation tasks
 * ahead of their dates, escalation of overdue work, contract expiry. Every
 * insert is keyed so a second run, or two at once, adds nothing.
 */
export async function sweepGov(pool: Pool | Client, opts: { tenantId?: string; on?: string } = {}) {
  const on = opts.on ?? today();
  let renewals = 0; let tasks = 0;
  const { rows: tenants } = await pool.query<{ tenant_id: string }>(
    `select distinct tenant_id from tenant_module where module_key = 'contracts' and enabled and ($1::uuid is null or tenant_id = $1)`, [opts.tenantId ?? null]);
  for (const { tenant_id } of tenants) {
    const s = await govSettings(pool, tenant_id);
    const holidays = await holidaysFor(pool, tenant_id);
    const { rows: contracts } = await pool.query<{ id: string; title: string; owner_id: string; end_date: string; notice_days: number; notice_calendar: 'calendar' | 'business'; auto_renews: boolean }>(
      `select id, title, owner_id, end_date::text, notice_days, notice_calendar, auto_renews from contract
        where tenant_id = $1 and status = 'signed' and end_date is not null and notice_days is not null and end_date >= $2::date`, [tenant_id, on]);
    for (const c of contracts) {
      const deadline = noticeDeadline(c.end_date, c.notice_days, c.notice_calendar, holidays);
      if (on < addDays(deadline, -s.renewalLeadDays)) continue;
      const title = `${c.auto_renews ? 'Renews automatically' : 'Ends'} ${c.end_date}: decide on "${c.title}" — notice due by ${deadline}`;
      const ins = await pool.query(
        `insert into obligation_task (tenant_id, contract_id, kind, title, due_on, notice_deadline, owner_id) values ($1, $2, 'renewal', $3, $4, $4, $5) on conflict do nothing`,
        [tenant_id, c.id, title, deadline, c.owner_id]);
      renewals += ins.rowCount ?? 0;
    }
    const { rows: obligations } = await pool.query<{ id: string; contract_id: string | null; title: string; owner_id: string; kind: string; every_months: number | null; next_due: string }>(
      `select id, contract_id, title, owner_id, kind, every_months, next_due::text from obligation where tenant_id = $1 and active and kind in ('recurring', 'one_off') and next_due <= $2::date + make_interval(days => $3)`,
      [tenant_id, on, s.obligationLeadDays]);
    for (const o of obligations) {
      let due = o.next_due;
      for (let guard = 0; guard < 240 && due <= addDays(on, s.obligationLeadDays); guard++) {
        const ins = await pool.query(`insert into obligation_task (tenant_id, obligation_id, contract_id, kind, title, due_on, owner_id) values ($1, $2, $3, 'obligation', $4, $5, $6) on conflict do nothing`,
          [tenant_id, o.id, o.contract_id, o.title, due, o.owner_id]);
        tasks += ins.rowCount ?? 0;
        if (o.kind === 'one_off') { await pool.query('update obligation set active = false where id = $1 and next_due = $2', [o.id, due]); break; }
        const next = addMonths(due, o.every_months!);
        const moved = await pool.query('update obligation set next_due = $3 where id = $1 and next_due = $2', [o.id, due, next]);
        if (!moved.rowCount) break;
        due = next;
      }
    }
    await pool.query(
      `update obligation_task t set escalated_at = now() from obligation o
        where t.tenant_id = $1 and t.obligation_id = o.id and t.status = 'open' and t.escalated_at is null and t.due_on + o.escalate_after_days < $2::date`, [tenant_id, on]);
    await pool.query(`update obligation_task set escalated_at = now() where tenant_id = $1 and kind = 'renewal' and status = 'open' and escalated_at is null and due_on < $2::date`, [tenant_id, on]);
    const { rows: late } = await pool.query<{ id: string }>(
      `update finding set escalated_at = now() where tenant_id = $1 and status in ('open', 'remediating') and target_date < $2::date and escalated_at is null returning id`, [tenant_id, on]);
    for (const f of late) await pool.query(`insert into finding_action (finding_id, kind, body) values ($1, 'escalated', 'Past its target date')`, [f.id]);
    await pool.query(`update contract set status = 'expired', updated_at = now() where tenant_id = $1 and status = 'signed' and not auto_renews and end_date < $2::date`, [tenant_id, on]);
  }
  return { renewals, tasks };
}

export async function listTasks(pool: Pool, principal: Principal, opts: { scope?: string } = {}) {
  const w = await member(pool, principal);
  await sweepGov(pool, { tenantId: w.tenantId });
  const all = opts.scope === 'all' && inTeam(w, 'compliance', 'legal');
  const { rows } = await pool.query(
    `select t.id, t.kind, t.title, t.due_on::text, t.notice_deadline::text, t.status, t.escalated_at, t.evidence, t.note, a.display_name as owner, t.owner_id, c.title as contract, c.id as contract_id,
            coalesce(o.evidence_required, true) as evidence_required
       from obligation_task t join actor a on a.id = t.owner_id left join contract c on c.id = t.contract_id left join obligation o on o.id = t.obligation_id
      where t.tenant_id = $1 and ($2 or t.owner_id = $3) and (t.status = 'open' or t.completed_at > now() - interval '30 days')
      order by t.status <> 'open', t.due_on`, [w.tenantId, all, w.actorId]);
  return rows;
}

export async function completeGovTask(pool: Pool, principal: Principal, taskId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ owner_id: string; status: string; kind: string; evidence_required: boolean | null }>(
      `select t.owner_id, t.status, t.kind, o.evidence_required from obligation_task t left join obligation o on o.id = t.obligation_id where t.id = $1 and t.tenant_id = $2 for update of t`, [taskId, w.tenantId]);
    const t = rows[0];
    if (!t) throw new InvalidInput('no such task');
    if (t.owner_id !== w.actorId && !inTeam(w, 'compliance', 'legal')) throw new InvalidInput('the owner completes this');
    if (t.status !== 'open') throw new InvalidInput('already closed');
    if (body.waive === true) {
      requireAdmin(w);
      const why = text(body.note, 1000);
      if (!why) throw new InvalidInput('say why it is waived');
      await client.query(`update obligation_task set status = 'waived', note = $2, completed_by = $3, completed_at = now() where id = $1`, [taskId, why, w.actorId]);
      return { id: taskId, status: 'waived' };
    }
    const evidence = text(body.evidence, 2000);
    let note = text(body.note, 1000);
    if (t.kind === 'renewal') {
      const decision = text(body.decision, 20);
      if (!['renew', 'give_notice', 'let_lapse', 'renegotiate'].includes(decision)) throw new InvalidInput('decide: renew, give_notice, let_lapse or renegotiate');
      note = `${decision.replace('_', ' ')}${note ? `: ${note}` : ''}`;
      if (decision === 'give_notice' && !evidence) throw new InvalidInput('attach the notice you sent');
    } else if (t.evidence_required !== false && !evidence) throw new InvalidInput('this obligation needs evidence');
    await client.query(`update obligation_task set status = 'done', evidence = $2, note = $3, completed_by = $4, completed_at = now() where id = $1`, [taskId, evidence || null, note || null, w.actorId]);
    return { id: taskId, status: 'done' };
  });
}

// ---------------------------------------------------------------- policies

export async function listPolicies(pool: Pool, principal: Principal) {
  const w = await member(pool, principal);
  const manage = inTeam(w, 'compliance');
  const { rows } = await pool.query(
    `select p.id, p.title, o.display_name as owner,
            (select json_agg(json_build_object('id', v.id, 'version', v.version, 'status', v.status, 'summary', v.summary, 'document_ref', v.document_ref, 'effective_from', v.effective_from, 'approved_by', (select display_name from actor where id = v.approved_by)) order by v.version desc)
               from policy_version v where v.policy_id = p.id and ($2 or v.status in ('published', 'superseded'))) as versions,
            (select json_agg(json_build_object('id', c.id, 'version', v.version, 'due_on', c.due_on, 'audience', c.audience,
                     'acknowledged', (select count(*)::int from policy_ack k where k.campaign_id = c.id)))
               from policy_campaign c join policy_version v on v.id = c.policy_version_id where v.policy_id = p.id) as campaigns
       from policy p join actor o on o.id = p.owner_id where p.tenant_id = $1 order by p.title`, [w.tenantId, manage]);
  const audience = await audienceSize(pool, w.tenantId);
  return rows.map((r: { campaigns: { audience: { roles?: string[] } }[] | null }) => ({ ...r, campaigns: (r.campaigns ?? []).map((c) => ({ ...c, audienceSize: audience(c.audience) })) }));
}

async function audienceSize(pool: Pool | Client, tenantId: string) {
  const { rows } = await pool.query<{ workspace_role: string; n: number }>(`select workspace_role, count(*)::int as n from actor where tenant_id = $1 and active and workspace_role not in ('auditor', 'pre_hire') group by workspace_role`, [tenantId]);
  return (a: { roles?: string[] }) => rows.filter((r) => !a.roles?.length || a.roles.includes(r.workspace_role)).reduce((x, r) => x + r.n, 0);
}

export async function createPolicy(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireTeam(w, 'compliance');
  const title = text(body.title, 200); const summary = text(body.summary, 4000);
  if (!title || !summary) throw new InvalidInput('give the policy a title and a summary');
  const ownerId = body.ownerId ? id(body.ownerId, 'ownerId') : w.actorId;
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>('insert into policy (tenant_id, title, owner_id) values ($1, $2, $3) returning id', [w.tenantId, title, ownerId]);
    const { rows: v } = await client.query<{ id: string }>(`insert into policy_version (policy_id, version, summary, document_ref, created_by) values ($1, 1, $2, $3, $4) returning id`, [rows[0]!.id, summary, text(body.documentRef, 500) || null, w.actorId]);
    return { id: rows[0]!.id, versionId: v[0]!.id };
  });
}

export async function newPolicyVersion(pool: Pool, principal: Principal, policyId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireTeam(w, 'compliance');
  const summary = text(body.summary, 4000);
  if (!summary) throw new InvalidInput('summarise the new version');
  const { rows } = await pool.query<{ n: number }>(`select coalesce(max(v.version), 0) + 1 as n from policy_version v join policy p on p.id = v.policy_id where p.id = $1 and p.tenant_id = $2`, [policyId, w.tenantId]);
  if (rows[0]!.n === 1) throw new InvalidInput('no such policy');
  const { rows: v } = await pool.query<{ id: string }>(`insert into policy_version (policy_id, version, summary, document_ref, created_by) values ($1, $2, $3, $4, $5) returning id`, [policyId, rows[0]!.n, summary, text(body.documentRef, 500) || null, w.actorId]);
  return { id: v[0]!.id, version: rows[0]!.n };
}

async function policyVersion(client: Client | Pool, w: Who, versionId: string) {
  if (!UUID.test(versionId)) throw new InvalidInput('no such policy version');
  const { rows } = await client.query<{ id: string; policy_id: string; version: number; status: string; created_by: string | null; title: string }>(
    `select v.id, v.policy_id, v.version, v.status, v.created_by, p.title from policy_version v join policy p on p.id = v.policy_id where v.id = $1 and p.tenant_id = $2`, [versionId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such policy version');
  return rows[0];
}

export async function approvePolicyVersion(pool: Pool, principal: Principal, versionId: string) {
  const w = await member(pool, principal); requireTeam(w, 'compliance');
  const v = await policyVersion(pool, w, versionId);
  if (v.status !== 'draft') throw new InvalidInput('only a draft is approved');
  if (v.created_by === w.actorId) throw new InvalidInput('someone other than the author approves a policy');
  await pool.query(`update policy_version set status = 'approved', approved_by = $2, approved_at = now() where id = $1`, [versionId, w.actorId]);
  return { id: versionId, status: 'approved' };
}

/** Publishing replaces the published version, which becomes superseded and stays on record. */
export async function publishPolicyVersion(pool: Pool, principal: Principal, versionId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireTeam(w, 'compliance');
  const effective = day(body.effectiveFrom, 'effectiveFrom', true)!;
  return inTransaction(pool, async (client) => {
    const v = await policyVersion(client, w, versionId);
    if (v.status !== 'approved') throw new InvalidInput('approve the version before publishing it');
    await client.query(`update policy_version set status = 'superseded' where policy_id = $1 and status = 'published'`, [v.policy_id]);
    await client.query(`update policy_version set status = 'published', effective_from = $2, published_at = now() where id = $1`, [versionId, effective]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'gov.policy_published', targetId: versionId, detail: { title: v.title, version: v.version, effective } });
    return { id: versionId, status: 'published' };
  });
}

export async function startCampaign(pool: Pool, principal: Principal, versionId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireTeam(w, 'compliance');
  const v = await policyVersion(pool, w, versionId);
  if (v.status !== 'published') throw new InvalidInput('only a published version is sent for acknowledgement');
  const due = day(body.dueOn, 'dueOn', true)!;
  const roles = list(body.roles, 10);
  const { rows } = await pool.query<{ id: string }>(`insert into policy_campaign (tenant_id, policy_version_id, audience, due_on, created_by) values ($1, $2, $3, $4, $5) returning id`,
    [w.tenantId, versionId, JSON.stringify(roles.length ? { roles } : {}), due, w.actorId]);
  return { id: rows[0]!.id };
}

export async function myAcknowledgements(pool: Pool, principal: Principal) {
  const w = await member(pool, principal);
  const { rows } = await pool.query(
    `select c.id as campaign_id, c.due_on::text, p.title, v.version, v.summary, v.document_ref, v.status, k.acknowledged_at, k.statement
       from policy_campaign c join policy_version v on v.id = c.policy_version_id join policy p on p.id = v.policy_id
       left join policy_ack k on k.campaign_id = c.id and k.actor_id = $2
      where c.tenant_id = $1 and (c.audience->'roles' is null or c.audience->'roles' ? $3)
      order by k.acknowledged_at nulls first, c.due_on`, [w.tenantId, w.actorId, w.role]);
  return rows;
}

export async function acknowledgePolicy(pool: Pool, principal: Principal, campaignId: string) {
  const w = await member(pool, principal);
  const { rows } = await pool.query<{ title: string; version: number; status: string; audience: { roles?: string[] } }>(
    `select p.title, v.version, v.status, c.audience from policy_campaign c join policy_version v on v.id = c.policy_version_id join policy p on p.id = v.policy_id where c.id = $1 and c.tenant_id = $2`, [campaignId, w.tenantId]);
  const c = rows[0];
  if (!c || (c.audience.roles?.length && !c.audience.roles.includes(w.role))) throw new InvalidInput('nothing to acknowledge');
  if (c.status !== 'published') throw new InvalidInput('this version has been replaced; acknowledge the current one');
  const statement = `I have read and understood "${c.title}" version ${c.version}.`;
  const { rowCount } = await pool.query('insert into policy_ack (campaign_id, actor_id, statement) values ($1, $2, $3) on conflict do nothing', [campaignId, w.actorId, statement]);
  if (!rowCount) throw new InvalidInput('already acknowledged');
  return { statement };
}

// -------------------------------------------------------- controls, exceptions

export const CONTROLS_DISCLAIMER = 'Recording controls and tests here helps you run them. It is not a certification, and does not mean any standard has been met.';

export async function listControls(pool: Pool, principal: Principal) {
  const w = await member(pool, principal);
  const all = inTeam(w, 'compliance', 'security');
  const { rows } = await pool.query(
    `select g.id, g.ref, g.title, g.framework, g.evidence_type, g.frequency_days, g.next_test_due::text, g.status, o.display_name as owner, g.owner_id,
            (g.next_test_due < current_date) as overdue,
            (select json_agg(json_build_object('result', t.result, 'evidence_ref', t.evidence_ref, 'notes', t.notes, 'tested_at', t.tested_at, 'by', (select display_name from actor where id = t.tested_by)) order by t.tested_at desc)
               from (select * from control_test where control_id = g.id order by tested_at desc limit 5) t) as tests
       from gov_control g join actor o on o.id = g.owner_id where g.tenant_id = $1 and ($2 or g.owner_id = $3) order by g.ref`, [w.tenantId, all, w.actorId]);
  return { disclaimer: CONTROLS_DISCLAIMER, controls: rows };
}

export async function saveControl(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireTeam(w, 'compliance', 'security');
  const ref = text(body.ref, 40); const title = text(body.title, 300); const evidenceType = text(body.evidenceType, 200);
  if (!ref || !title || !evidenceType) throw new InvalidInput('give the control a reference, a title and the evidence it needs');
  const freq = Math.trunc(num(body.frequencyDays));
  if (!(freq >= 1 && freq <= 3660)) throw new InvalidInput('frequencyDays must be 1 to 3660');
  const ownerId = id(body.ownerId, 'ownerId');
  const firstDue = day(body.firstDue, 'firstDue') ?? addDays(today(), freq);
  const { rows } = await pool.query<{ id: string }>(
    `insert into gov_control (tenant_id, ref, title, owner_id, framework, evidence_type, frequency_days, next_test_due) values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (tenant_id, ref) do update set title = excluded.title, owner_id = excluded.owner_id, framework = excluded.framework, evidence_type = excluded.evidence_type, frequency_days = excluded.frequency_days returning id`,
    [w.tenantId, ref, title, ownerId, text(body.framework, 120) || null, evidenceType, freq, firstDue]);
  return { id: rows[0]!.id };
}

export async function recordControlTest(pool: Pool, principal: Principal, controlId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const result = body.result === 'pass' ? 'pass' : body.result === 'fail' ? 'fail' : null;
  if (!result) throw new InvalidInput('result must be pass or fail');
  const evidence = text(body.evidenceRef, 500);
  if (!evidence) throw new InvalidInput('a test needs its evidence');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ owner_id: string; frequency_days: number }>('select owner_id, frequency_days from gov_control where id = $1 and tenant_id = $2 for update', [controlId, w.tenantId]);
    if (!rows[0]) throw new InvalidInput('no such control');
    if (rows[0].owner_id !== w.actorId && !inTeam(w, 'compliance', 'security')) throw new InvalidInput("the control's owner or compliance records its tests");
    await client.query('insert into control_test (control_id, result, evidence_ref, notes, tested_by) values ($1, $2, $3, $4, $5)', [controlId, result, evidence, text(body.notes, 2000) || null, w.actorId]);
    await client.query(`update gov_control set status = $2, next_test_due = current_date + frequency_days where id = $1`, [controlId, result === 'pass' ? 'effective' : 'ineffective']);
    return { status: result === 'pass' ? 'effective' : 'ineffective' };
  });
}

export async function requestException(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const kind = body.kind === 'control' ? 'control' : body.kind === 'policy' ? 'policy' : null;
  if (!kind) throw new InvalidInput('kind must be policy or control');
  const targetId = id(body.targetId, 'targetId');
  const subject = text(body.subject, 300); const reason = text(body.reason, 2000);
  if (!subject || !reason) throw new InvalidInput('say who or what the exception covers, and why');
  const expires = day(body.expiresOn, 'expiresOn', true)!;
  if (expires <= today()) throw new InvalidInput('an exception must end in the future');
  const table = kind === 'policy' ? 'policy' : 'gov_control';
  const { rows } = await pool.query(`select 1 from ${table} where id = $1 and tenant_id = $2`, [targetId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput(`no such ${kind}`);
  const { rows: e } = await pool.query<{ id: string }>(`insert into gov_exception (tenant_id, kind, target_id, subject, reason, requested_by, expires_on) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [w.tenantId, kind, targetId, subject, reason, w.actorId, expires]);
  return { id: e[0]!.id };
}

export async function decideException(pool: Pool, principal: Principal, exceptionId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireTeam(w, 'compliance');
  const approve = body.decision === 'approve';
  const note = text(body.note, 1000);
  if (!note) throw new InvalidInput('record the reason');
  const { rows } = await pool.query<{ requested_by: string; status: string }>('select requested_by, status from gov_exception where id = $1 and tenant_id = $2', [exceptionId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such exception');
  if (rows[0].status !== 'requested') throw new InvalidInput('already decided');
  if (rows[0].requested_by === w.actorId) throw new InvalidInput('someone other than the person asking decides');
  await pool.query('update gov_exception set status = $2, decided_by = $3, decision_note = $4 where id = $1', [exceptionId, approve ? 'approved' : 'rejected', w.actorId, note]);
  return { id: exceptionId, status: approve ? 'approved' : 'rejected' };
}

export async function listExceptions(pool: Pool, principal: Principal) {
  const w = await member(pool, principal);
  const all = inTeam(w, 'compliance');
  const { rows } = await pool.query(
    `select e.id, e.kind, e.subject, e.reason, e.status, e.expires_on::text, e.decision_note, e.created_at, r.display_name as requested_by,
            coalesce((select title from policy where id = e.target_id), (select ref || ' ' || title from gov_control where id = e.target_id)) as target
       from gov_exception e left join actor r on r.id = e.requested_by where e.tenant_id = $1 and ($2 or e.requested_by = $3) order by e.status <> 'requested', e.created_at desc`, [w.tenantId, all, w.actorId]);
  return rows;
}

// ------------------------------------------------------------------ audits

interface Scope { processKeys: string[]; controlIds: string[]; contractIds: string[] }
const readScope = (v: unknown): Scope => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { processKeys: list(o.processKeys), controlIds: list(o.controlIds).filter((x) => UUID.test(x)), contractIds: list(o.contractIds).filter((x) => UUID.test(x)) };
};

export async function createEngagement(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireTeam(w, 'compliance');
  const title = text(body.title, 200);
  if (!title) throw new InvalidInput('name the engagement');
  const scope = readScope(body.scope);
  if (!scope.processKeys.length && !scope.controlIds.length && !scope.contractIds.length) throw new InvalidInput('an engagement needs a scope: processes, controls or contracts');
  const from = day(body.periodFrom, 'periodFrom', true)!; const to = day(body.periodTo, 'periodTo', true)!;
  if (to < from) throw new InvalidInput('the period ends before it starts');
  const leadId = body.leadId ? id(body.leadId, 'leadId') : w.actorId;
  const { rows } = await pool.query<{ id: string }>(`insert into engagement (tenant_id, title, scope, period_from, period_to, lead_id, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [w.tenantId, title, JSON.stringify(scope), from, to, leadId, w.actorId]);
  return { id: rows[0]!.id };
}

export async function updateEngagement(pool: Pool, principal: Principal, engagementId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireTeam(w, 'compliance');
  const sets: string[] = []; const vals: unknown[] = [];
  if (body.status !== undefined) { const s = text(body.status, 20); if (!['planning', 'fieldwork', 'reporting', 'closed'].includes(s)) throw new InvalidInput('status must be planning, fieldwork, reporting or closed'); sets.push('status'); vals.push(s); }
  if (body.samplingNotes !== undefined) { sets.push('sampling_notes'); vals.push(text(body.samplingNotes, 8000) || null); }
  if (!sets.length) return { id: engagementId };
  const { rowCount } = await pool.query(`update engagement set ${sets.map((k, i) => `${k} = $${i + 3}`).join(', ')} where id = $1 and tenant_id = $2`, [engagementId, w.tenantId, ...vals]);
  if (!rowCount) throw new InvalidInput('no such engagement');
  if (body.status === 'closed') await pool.query('update engagement_auditor set revoked_at = now() where engagement_id = $1 and revoked_at is null', [engagementId]);
  return { id: engagementId };
}

/** GOV-10: time-limited, read-only, scoped; export is a separate right. */
export async function grantAuditor(pool: Pool, principal: Principal, engagementId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireTeam(w, 'compliance');
  const actorId = id(body.actorId, 'actorId');
  const expires = new Date(String(body.expiresAt ?? ''));
  if (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now()) throw new InvalidInput('access must end at a future date and time');
  if (expires.getTime() - Date.now() > 180 * 86400000) throw new InvalidInput('auditor access lasts at most 180 days at a time');
  const { rows } = await pool.query('select 1 from engagement where id = $1 and tenant_id = $2 and status <> $3', [engagementId, w.tenantId, 'closed']);
  if (!rows[0]) throw new InvalidInput('no such open engagement');
  const { rows: a } = await pool.query('select 1 from actor where id = $1 and tenant_id = $2 and active', [actorId, w.tenantId]);
  if (!a[0]) throw new InvalidInput('no such member; invite the auditor with the Auditor role first');
  await pool.query(
    `insert into engagement_auditor (engagement_id, actor_id, expires_at, can_export, granted_by) values ($1, $2, $3, $4, $5)
     on conflict (engagement_id, actor_id) do update set expires_at = excluded.expires_at, can_export = excluded.can_export, granted_by = excluded.granted_by, granted_at = now(), revoked_at = null`,
    [engagementId, actorId, expires, body.canExport === true, w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'gov.auditor_granted', targetId: engagementId, detail: { actorId, expires: expires.toISOString(), canExport: body.canExport === true } });
  return { engagementId, actorId };
}

export async function revokeAuditor(pool: Pool, principal: Principal, engagementId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireTeam(w, 'compliance');
  const actorId = id(body.actorId, 'actorId');
  const { rowCount } = await pool.query(`update engagement_auditor ea set revoked_at = now() from engagement e where e.id = ea.engagement_id and e.tenant_id = $3 and ea.engagement_id = $1 and ea.actor_id = $2 and ea.revoked_at is null`, [engagementId, actorId, w.tenantId]);
  if (!rowCount) throw new InvalidInput('no such access');
  return { revoked: true };
}

/** Who may read an engagement, and how: internal compliance, the lead, or an auditor with live access. */
async function engagementAccess(pool: Pool | Client, w: Who, engagementId: string) {
  if (!UUID.test(engagementId)) throw new InvalidInput('no such engagement');
  const { rows } = await pool.query<{ id: string; title: string; scope: Scope; period_from: string; period_to: string; lead_id: string; status: string; sampling_notes: string | null }>(
    'select id, title, scope, period_from::text, period_to::text, lead_id, status, sampling_notes from engagement where id = $1 and tenant_id = $2', [engagementId, w.tenantId]);
  const e = rows[0];
  if (e && !w.auditor && (inTeam(w, 'compliance') || e.lead_id === w.actorId)) return { e, auditor: null as null | { can_export: boolean } };
  const { rows: g } = await pool.query<{ can_export: boolean }>(
    'select can_export from engagement_auditor where engagement_id = $1 and actor_id = $2 and revoked_at is null and expires_at > now()', [engagementId, w.actorId]);
  if (!e || !g[0]) {
    await logAccess(pool, w, e ? engagementId : null, 'denied', 'engagement', engagementId);
    throw new InvalidInput('no such engagement for you');
  }
  return { e, auditor: g[0] };
}
async function logAccess(pool: Pool | Client, w: Who, engagementId: string | null, action: 'view' | 'export' | 'denied', kind: string, target: string | null) {
  if (!w.auditor && action !== 'denied') return;
  await pool.query('insert into auditor_access_log (tenant_id, engagement_id, actor_id, action, target_kind, target_id) values ($1, $2, $3, $4, $5, $6)', [w.tenantId, engagementId, w.actorId, action, kind, target]);
}

export async function listEngagements(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  if (w.auditor) {
    const { rows } = await pool.query(
      `select e.id, e.title, e.status, e.period_from::text, e.period_to::text, ea.expires_at, ea.can_export from engagement e join engagement_auditor ea on ea.engagement_id = e.id
        where e.tenant_id = $1 and ea.actor_id = $2 and ea.revoked_at is null and ea.expires_at > now() order by e.created_at desc`, [w.tenantId, w.actorId]);
    return rows;
  }
  const { rows } = await pool.query(
    `select e.id, e.title, e.status, e.scope, e.period_from::text, e.period_to::text, l.display_name as lead,
            (select count(*)::int from finding f where f.engagement_id = e.id and f.status <> 'closed') as open_findings,
            (select count(*)::int from evidence_request r where r.engagement_id = e.id and r.status in ('open', 'rejected')) as open_requests,
            (select json_agg(json_build_object('actor_id', ea.actor_id, 'name', a.display_name, 'expires_at', ea.expires_at, 'can_export', ea.can_export)) from engagement_auditor ea join actor a on a.id = ea.actor_id
              where ea.engagement_id = e.id and ea.revoked_at is null and ea.expires_at > now()) as auditors
       from engagement e join actor l on l.id = e.lead_id where e.tenant_id = $1 and ($2 or e.lead_id = $3) order by e.created_at desc`, [w.tenantId, inTeam(w, 'compliance'), w.actorId]);
  return rows;
}

/** What an engagement covers, in one read: requests, findings, controls, contracts and the records in scope. */
export async function engagementView(pool: Pool, principal: Principal, engagementId: string) {
  const w = await who(pool, principal);
  const { e, auditor } = await engagementAccess(pool, w, engagementId);
  await logAccess(pool, w, engagementId, 'view', 'engagement', engagementId);
  const { rows: requests } = await pool.query(
    `select r.id, r.title, r.detail, r.due_on::text, r.status, r.evidence, r.decision_note, o.display_name as owner, r.owner_id from evidence_request r join actor o on o.id = r.owner_id where r.engagement_id = $1 order by r.created_at`, [engagementId]);
  const { rows: findings } = await pool.query(
    `select f.id, f.number, f.title, f.detail, f.severity, f.status, f.management_response, f.target_date::text, f.reopened, f.escalated_at, o.display_name as owner, f.owner_id, v.display_name as validated_by,
            (select json_agg(json_build_object('kind', a.kind, 'body', a.body, 'evidence_ref', a.evidence_ref, 'at', a.occurred_at, 'by', (select display_name from actor where id = a.actor_id)) order by a.id) from finding_action a where a.finding_id = f.id) as history
       from finding f join actor o on o.id = f.owner_id left join actor v on v.id = f.validated_by where f.engagement_id = $1 order by f.number`, [engagementId]);
  const { rows: controls } = await pool.query(
    `select g.id, g.ref, g.title, g.status, g.evidence_type, (select json_agg(json_build_object('result', t.result, 'evidence_ref', t.evidence_ref, 'tested_at', t.tested_at) order by t.tested_at desc) from control_test t where t.control_id = g.id and t.tested_at::date between $3 and $4) as tests
       from gov_control g where g.tenant_id = $1 and g.id = any($2::uuid[])`, [w.tenantId, e.scope.controlIds, e.period_from, e.period_to]);
  const { rows: contracts } = await pool.query(
    `select c.id, c.number, c.title, c.counterparty, c.status, c.current_version from contract c where c.tenant_id = $1 and c.id = any($2::uuid[])`, [w.tenantId, e.scope.contractIds]);
  const { rows: records } = await pool.query(
    `select i.id, i.process_key, i.state, i.created_at, i.completed_at from instance i
      where i.tenant_id = $1 and i.process_key = any($2::text[]) and i.created_at::date <= $4 and coalesce(i.completed_at, now())::date >= $3 order by i.created_at desc limit 500`,
    [w.tenantId, e.scope.processKeys, e.period_from, e.period_to]);
  return { engagement: e, readOnly: Boolean(auditor), canExport: auditor ? auditor.can_export : true, requests, findings, controls, contracts, records };
}

/** One record, if and only if it is in the engagement's scope and period; read-only; logged. */
export async function engagementRecord(pool: Pool, principal: Principal, engagementId: string, instanceId: string) {
  const w = await who(pool, principal);
  const { e } = await engagementAccess(pool, w, engagementId);
  const { rows } = UUID.test(instanceId)
    ? await pool.query<{ id: string; process_key: string; state: string; created_at: Date; completed_at: Date | null; answers: unknown }>(
      `select id, process_key, state, created_at, completed_at, data as answers from instance where id = $1 and tenant_id = $2`, [instanceId, w.tenantId])
    : { rows: [] };
  const i = rows[0];
  const inScope = i && e.scope.processKeys.includes(i.process_key) && i.created_at.toISOString().slice(0, 10) <= e.period_to && (i.completed_at ?? new Date()).toISOString().slice(0, 10) >= e.period_from;
  if (!inScope) {
    await logAccess(pool, w, engagementId, 'denied', 'record', instanceId);
    throw new InvalidInput('that record is outside this engagement');
  }
  await logAccess(pool, w, engagementId, 'view', 'record', instanceId);
  const { rows: events } = await pool.query(`select type, occurred_at, payload from event where instance_id = $1 order by id`, [instanceId]);
  return { record: i, events };
}

export async function addEvidenceRequest(pool: Pool, principal: Principal, engagementId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const { e } = await engagementAccess(pool, w, engagementId);
  if (e.status === 'closed') throw new InvalidInput('the engagement is closed');
  const title = text(body.title, 300);
  if (!title) throw new InvalidInput('say what evidence is needed');
  const ownerId = id(body.ownerId, 'ownerId');
  const { rows } = await pool.query<{ id: string }>(`insert into evidence_request (engagement_id, title, detail, owner_id, due_on, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
    [engagementId, title, text(body.detail, 2000) || null, ownerId, day(body.dueOn, 'dueOn'), w.actorId]);
  return { id: rows[0]!.id };
}

export async function submitEvidence(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const ref = text(body.evidenceRef, 500);
  if (!ref) throw new InvalidInput('give the evidence reference');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ owner_id: string; status: string }>(
      `select r.owner_id, r.status from evidence_request r join engagement e on e.id = r.engagement_id where r.id = $1 and e.tenant_id = $2 for update of r`, [requestId, w.tenantId]);
    if (!rows[0]) throw new InvalidInput('no such request');
    if (rows[0].owner_id !== w.actorId) throw new InvalidInput('the person the request is for submits the evidence');
    if (rows[0].status === 'accepted') throw new InvalidInput('this request is already accepted');
    await client.query(`update evidence_request set status = 'submitted', evidence = evidence || $2::jsonb where id = $1`,
      [requestId, JSON.stringify([{ ref, note: text(body.note, 1000) || null, at: new Date().toISOString(), by: w.actorId }])]);
    return { id: requestId, status: 'submitted' };
  });
}

export async function decideEvidence(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const accept = body.decision === 'accept';
  const note = text(body.note, 1000);
  if (!accept && !note) throw new InvalidInput('say what is missing');
  const { rows } = await pool.query<{ engagement_id: string; owner_id: string; status: string }>(
    `select r.engagement_id, r.owner_id, r.status from evidence_request r join engagement e on e.id = r.engagement_id where r.id = $1 and e.tenant_id = $2`, [requestId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such request');
  await engagementAccess(pool, w, rows[0].engagement_id);
  if (rows[0].status !== 'submitted') throw new InvalidInput('nothing submitted to decide');
  if (rows[0].owner_id === w.actorId) throw new InvalidInput('someone other than the person who submitted it decides');
  await pool.query('update evidence_request set status = $2, decided_by = $3, decision_note = $4 where id = $1', [requestId, accept ? 'accepted' : 'rejected', w.actorId, note || null]);
  return { id: requestId, status: accept ? 'accepted' : 'rejected' };
}

export async function raiseFinding(pool: Pool, principal: Principal, engagementId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const { e } = await engagementAccess(pool, w, engagementId);
  if (e.status === 'closed') throw new InvalidInput('the engagement is closed');
  const title = text(body.title, 300); const detail = text(body.detail, 4000);
  if (!title || !detail) throw new InvalidInput('give the finding a title and the detail');
  const severity = text(body.severity, 10);
  if (!['low', 'medium', 'high', 'critical'].includes(severity)) throw new InvalidInput('severity must be low, medium, high or critical');
  const ownerId = id(body.ownerId, 'ownerId');
  return inTransaction(pool, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`finding:${engagementId}`]);
    const { rows: n } = await client.query<{ n: number }>('select coalesce(max(number), 0) + 1 as n from finding where engagement_id = $1', [engagementId]);
    const { rows } = await client.query<{ id: string }>(
      `insert into finding (tenant_id, engagement_id, number, title, detail, severity, owner_id, target_date, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [w.tenantId, engagementId, n[0]!.n, title, detail, severity, ownerId, day(body.targetDate, 'targetDate'), w.actorId]);
    return { id: rows[0]!.id, number: n[0]!.n };
  });
}

async function findingFor(client: Client | Pool, w: Who, findingId: string, lock = false) {
  if (!UUID.test(findingId)) throw new InvalidInput('no such finding');
  const { rows } = await client.query<{ id: string; engagement_id: string; owner_id: string; status: string; target_date: string | null }>(
    `select id, engagement_id, owner_id, status, target_date::text from finding where id = $1 and tenant_id = $2 ${lock ? 'for update' : ''}`, [findingId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such finding');
  return rows[0];
}

/** GOV-07/08: the owner answers, plans and shows the fix; someone else validates it or sends it back. */
export async function workFinding(pool: Pool, principal: Principal, findingId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  const action = text(body.action, 20);
  return inTransaction(pool, async (client) => {
    const f = await findingFor(client, w, findingId, true);
    if (f.status === 'closed' && action !== 'note') throw new InvalidInput('this finding is closed');
    const owner = f.owner_id === w.actorId;
    const reviewer = !owner && (inTeam(w, 'compliance') || (await client.query('select 1 from engagement where id = $1 and lead_id = $2', [f.engagement_id, w.actorId])).rows.length > 0);
    const say = text(body.body, 4000);
    switch (action) {
      case 'respond': {
        if (!owner) throw new InvalidInput("the finding's owner gives the management response");
        if (!say) throw new InvalidInput('write the management response');
        const target = day(body.targetDate, 'targetDate', true)!;
        await client.query(`update finding set management_response = $2, target_date = $3, status = 'remediating' where id = $1`, [findingId, say, target]);
        await client.query(`insert into finding_action (finding_id, kind, body, actor_id) values ($1, 'response', $2, $3)`, [findingId, `${say} (target ${target})`, w.actorId]);
        return { status: 'remediating' };
      }
      case 'evidence': {
        if (!owner) throw new InvalidInput("the finding's owner submits remediation evidence");
        const ref = text(body.evidenceRef, 500);
        if (!ref) throw new InvalidInput('give the evidence that it is fixed');
        if (f.status === 'open') throw new InvalidInput('give the management response first');
        await client.query(`update finding set status = 'awaiting_validation' where id = $1`, [findingId]);
        await client.query(`insert into finding_action (finding_id, kind, body, evidence_ref, actor_id) values ($1, 'evidence', $2, $3, $4)`, [findingId, say || 'Remediation evidence', ref, w.actorId]);
        return { status: 'awaiting_validation' };
      }
      case 'validate': case 'reopen': {
        if (!reviewer) throw new InvalidInput("someone other than the owner, in compliance or leading the engagement, validates the fix");
        if (f.status !== 'awaiting_validation') throw new InvalidInput('there is no fix waiting to be validated');
        if (action === 'validate') {
          await client.query(`update finding set status = 'closed', validated_by = $2, validated_at = now() where id = $1`, [findingId, w.actorId]);
          await client.query(`insert into finding_action (finding_id, kind, body, actor_id) values ($1, 'validated', $2, $3)`, [findingId, say || 'Remediation validated', w.actorId]);
          return { status: 'closed' };
        }
        if (!say) throw new InvalidInput('say why the evidence is not enough');
        await client.query(`update finding set status = 'remediating', reopened = reopened + 1, escalated_at = null where id = $1`, [findingId]);
        await client.query(`insert into finding_action (finding_id, kind, body, actor_id) values ($1, 'reopened', $2, $3)`, [findingId, say, w.actorId]);
        return { status: 'remediating' };
      }
      case 'note': {
        if (!say) throw new InvalidInput('the note is empty');
        if (!owner && !reviewer) throw new InvalidInput('not your finding');
        await client.query(`insert into finding_action (finding_id, kind, body, actor_id) values ($1, 'note', $2, $3)`, [findingId, say, w.actorId]);
        return { status: f.status };
      }
      default: throw new InvalidInput('action must be respond, evidence, validate, reopen or note');
    }
  });
}

export async function myFindings(pool: Pool, principal: Principal) {
  const w = await member(pool, principal);
  const { rows } = await pool.query(
    `select f.id, f.number, f.title, f.detail, f.severity, f.status, f.target_date::text, f.management_response, f.escalated_at, e.title as engagement
       from finding f join engagement e on e.id = f.engagement_id where f.tenant_id = $1 and f.owner_id = $2 and f.status <> 'closed' order by f.target_date nulls first`, [w.tenantId, w.actorId]);
  return rows;
}

/**
 * GOV-11. Originals (versions, decisions, test evidence, submitted evidence,
 * record histories) are kept apart from derived summaries; every item has
 * its source, version and time, and the manifest lists a hash per item.
 */
export async function buildEvidencePack(pool: Pool, principal: Principal, engagementId: string) {
  const w = await who(pool, principal);
  const { e, auditor } = await engagementAccess(pool, w, engagementId);
  if (auditor && !auditor.can_export) {
    await logAccess(pool, w, engagementId, 'denied', 'export', engagementId);
    throw new InvalidInput('your access to this engagement does not include export');
  }
  const view = await engagementView(pool, principal, engagementId);
  const items: { id: string; kind: 'original' | 'derived'; source: string; version?: number | string; captured_at: string; data: unknown }[] = [];
  const now = new Date().toISOString();
  for (const c of view.contracts) {
    const { rows: versions } = await pool.query(`select id, version, document_ref, changes, material, terms, created_at from contract_version where contract_id = $1 order by version`, [c.id]);
    for (const v of versions) items.push({ id: `contract_version:${v.id}`, kind: 'original', source: `contract ${c.number} "${c.title}"`, version: v.version, captured_at: now, data: v });
    const { rows: reviews } = await pool.query(`select r.version, r.discipline, r.decision, r.note, r.decided_at, r.invalidated_at, r.invalidated_reason, a.display_name as reviewer from contract_review r join actor a on a.id = r.reviewer_id where r.contract_id = $1 order by r.decided_at`, [c.id]);
    items.push({ id: `contract_reviews:${c.id}`, kind: 'original', source: `decision history of contract ${c.number}`, captured_at: now, data: reviews });
  }
  for (const c of view.controls) items.push({ id: `control_tests:${c.id}`, kind: 'original', source: `control ${c.ref} tests in period`, captured_at: now, data: c.tests ?? [] });
  for (const r of view.requests) items.push({ id: `evidence_request:${r.id}`, kind: 'original', source: `evidence request "${r.title}" (${r.status})`, captured_at: now, data: { evidence: r.evidence, decision: r.decision_note } });
  for (const f of view.findings) items.push({ id: `finding:${f.id}`, kind: 'original', source: `finding ${f.number} "${f.title}"`, captured_at: now, data: f });
  for (const rec of view.records.slice(0, 200)) {
    const { rows: events } = await pool.query(`select type, occurred_at, payload from event where instance_id = $1 order by id`, [rec.id]);
    items.push({ id: `record:${rec.id}`, kind: 'original', source: `${rec.process_key} record history`, captured_at: now, data: { record: rec, events } });
  }
  items.push({ id: 'summary', kind: 'derived', source: 'summary prepared by Patform from the items above; not an original artifact', captured_at: now,
    data: { records: view.records.length, findingsBySeverity: view.findings.reduce((a: Record<string, number>, f: { severity: string }) => ({ ...a, [f.severity]: (a[f.severity] ?? 0) + 1 }), {}), requests: view.requests.length } });
  const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const manifest = {
    engagement: { id: e.id, title: e.title, scope: e.scope, period: [e.period_from, e.period_to] },
    generated_at: now, generated_by: w.actorId,
    note: 'Items marked "original" are copies of stored records at the time shown. Items marked "derived" are summaries Patform prepared and are not evidence in themselves.',
    items: items.map((i) => ({ id: i.id, kind: i.kind, source: i.source, version: i.version ?? null, captured_at: i.captured_at, sha256: hash(i.data) })),
  };
  const content = { manifest, items };
  const sha = hash(content);
  const { rows } = await pool.query<{ id: string }>(`insert into evidence_pack (tenant_id, engagement_id, manifest, content, sha256, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
    [w.tenantId, engagementId, JSON.stringify(manifest), JSON.stringify(content), sha, w.actorId]);
  await logAccess(pool, w, engagementId, 'export', 'evidence_pack', rows[0]!.id);
  return { id: rows[0]!.id, sha256: sha, ...content };
}

export async function auditorLog(pool: Pool, principal: Principal, engagementId: string) {
  const w = await member(pool, principal); requireTeam(w, 'compliance');
  const { rows } = await pool.query(
    `select l.action, l.target_kind, l.target_id, l.occurred_at, a.display_name as auditor from auditor_access_log l join actor a on a.id = l.actor_id where l.tenant_id = $1 and l.engagement_id = $2 order by l.id desc limit 500`, [w.tenantId, engagementId]);
  return rows;
}

// -------------------------------------------------------------- legal holds

export async function listHolds(pool: Pool, principal: Principal) {
  const w = await member(pool, principal);
  if (!holdManager(w)) throw new InvalidInput('legal holds are visible only to owners and the legal team');
  const { rows: holds } = await pool.query(
    `select h.id, h.title, h.reason, h.scope, h.status, h.created_at, h.released_at, h.release_reason, h.cleared_at, h.clear_note, c.display_name as created_by, r.display_name as released_by, x.display_name as cleared_by,
            (select coalesce(sum(held_records), 0)::int from retention_block b where b.hold_id = h.id) as blocked
       from legal_hold h left join actor c on c.id = h.created_by left join actor r on r.id = h.released_by left join actor x on x.id = h.cleared_by where h.tenant_id = $1 order by h.status = 'cleared', h.created_at desc`, [w.tenantId]);
  const { rows: blocks } = await pool.query(
    `select b.id, b.process_key, b.held_records, b.run_by, b.occurred_at, h.title as hold from retention_block b join legal_hold h on h.id = b.hold_id where b.tenant_id = $1 order by b.id desc limit 100`, [w.tenantId]);
  const { rows: schedules } = await pool.query(`select process_key, enabled, last_run_at from retention_schedule where tenant_id = $1 order by process_key`, [w.tenantId]);
  return { holds, blocks, schedules };
}

export async function createHold(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  if (!holdManager(w)) throw new InvalidInput('only an owner or the legal team places a legal hold');
  const title = text(body.title, 200); const reason = text(body.reason, 2000);
  if (!title || !reason) throw new InvalidInput('give the hold a title and the reason');
  const s = (body.scope ?? {}) as Record<string, unknown>;
  const scope = { processKeys: list(s.processKeys), instanceIds: list(s.instanceIds, 500).filter((x) => UUID.test(x)) };
  if (!scope.processKeys.length && !scope.instanceIds.length) throw new InvalidInput('say which processes or records the hold covers');
  const { rows } = await pool.query<{ id: string }>(`insert into legal_hold (tenant_id, title, reason, scope, created_by) values ($1, $2, $3, $4, $5) returning id`, [w.tenantId, title, reason, JSON.stringify(scope), w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'gov.hold_placed', targetId: rows[0]!.id, detail: { title, scope } });
  return { id: rows[0]!.id };
}

/** A release is recorded, and the hold keeps blocking until someone reviews what would become deletable. */
export async function releaseHold(pool: Pool, principal: Principal, holdId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  if (!holdManager(w)) throw new InvalidInput('only an owner or the legal team releases a legal hold');
  const reason = text(body.reason, 2000);
  if (!reason) throw new InvalidInput('record why the hold is released');
  const { rowCount } = await pool.query(`update legal_hold set status = 'released', released_by = $3, released_at = now(), release_reason = $4 where id = $1 and tenant_id = $2 and status = 'active'`, [holdId, w.tenantId, w.actorId, reason]);
  if (!rowCount) throw new InvalidInput('no such active hold');
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'gov.hold_released', targetId: holdId, detail: { reason } });
  return { id: holdId, status: 'released', next: 'Records stay protected until someone reviews the release and clears it for normal retention.' };
}

export async function clearHold(pool: Pool, principal: Principal, holdId: string, body: Record<string, unknown>) {
  const w = await member(pool, principal);
  if (!holdManager(w)) throw new InvalidInput('only an owner or the legal team clears a released hold');
  const note = text(body.note, 2000);
  if (!note) throw new InvalidInput('record the review');
  const { rows } = await pool.query<{ released_by: string | null; status: string }>('select released_by, status from legal_hold where id = $1 and tenant_id = $2', [holdId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such hold');
  if (rows[0].status !== 'released') throw new InvalidInput('release the hold first');
  if (rows[0].released_by === w.actorId) throw new InvalidInput('someone other than the person who released it reviews and clears it');
  await pool.query(`update legal_hold set status = 'cleared', cleared_by = $2, cleared_at = now(), clear_note = $3 where id = $1`, [holdId, w.actorId, note]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'gov.hold_cleared', targetId: holdId, detail: { note } });
  return { id: holdId, status: 'cleared' };
}

export async function setRetentionSchedule(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await member(pool, principal); requireAdmin(w);
  const key = text(body.processKey, 120);
  const { rows } = await pool.query<{ blueprint: { intent?: { retentionDays?: number } } }>('select blueprint from process_version where tenant_id = $1 and process_key = $2 order by version desc limit 1', [w.tenantId, key]);
  if (!rows[0]) throw new InvalidInput('no such process');
  if (!rows[0].blueprint.intent?.retentionDays) throw new InvalidInput('this process declares no retention period, so nothing would be deleted');
  await pool.query(`insert into retention_schedule (tenant_id, process_key, enabled, set_by) values ($1, $2, $3, $4) on conflict (tenant_id, process_key) do update set enabled = excluded.enabled, set_by = excluded.set_by`, [w.tenantId, key, body.enabled !== false, w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'gov.retention_scheduled', targetId: w.tenantId, detail: { processKey: key, enabled: body.enabled !== false } });
  return { processKey: key, enabled: body.enabled !== false };
}

// --------------------------------------------------------------- dashboard

/** GOV-12: what needs attention, limited to what this person may see. */
export async function govDashboard(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  if (w.auditor) return { auditor: true, engagements: await listEngagements(pool, principal) };
  await sweepGov(pool, { tenantId: w.tenantId });
  const all = inTeam(w, 'compliance', 'legal');
  const { rows: tasks } = await pool.query<{ due: number; overdue: number; escalated: number }>(
    `select count(*) filter (where due_on >= current_date)::int as due, count(*) filter (where due_on < current_date)::int as overdue, count(*) filter (where escalated_at is not null)::int as escalated
       from obligation_task where tenant_id = $1 and status = 'open' and ($2 or owner_id = $3)`, [w.tenantId, all, w.actorId]);
  const { rows: remediation } = await pool.query(
    `select f.id, f.number, f.title, f.severity, f.target_date::text, e.title as engagement from finding f join engagement e on e.id = f.engagement_id
      where f.tenant_id = $1 and f.status in ('open', 'remediating') and f.target_date < current_date and ($2 or f.owner_id = $3) order by f.target_date`, [w.tenantId, inTeam(w, 'compliance'), w.actorId]);
  const holidays = await holidaysFor(pool, w.tenantId);
  const { rows: contracts } = await pool.query<{ id: string; number: number; title: string; end_date: string; notice_days: number | null; notice_calendar: 'calendar' | 'business'; status: string }>(
    `select id, number, title, end_date::text, notice_days, notice_calendar, status from contract where tenant_id = $1 and status in ('signed', 'approved', 'out_for_signature') and end_date between current_date and current_date + 120
        and ($2 or owner_id = $3) order by end_date`, [w.tenantId, inTeam(w, 'legal', 'compliance', 'finance', 'security'), w.actorId]);
  const expiring = contracts.map((c) => ({ ...c, notice_deadline: c.notice_days !== null ? noticeDeadline(c.end_date, c.notice_days, c.notice_calendar, holidays) : null }));
  const policies = ((await listPolicies(pool, principal)) as unknown as { title: string; campaigns: { id: string; version: number; due_on: string; acknowledged: number; audienceSize: number }[] }[]).flatMap((p) =>
    p.campaigns.map((c) => ({ policy: p.title, version: c.version, due_on: c.due_on, acknowledged: c.acknowledged, audience: c.audienceSize })));
  const { rows: exceptions } = await pool.query<{ n: number }>(`select count(*)::int as n from gov_exception where tenant_id = $1 and status = 'requested' and ($2 or requested_by = $3)`, [w.tenantId, inTeam(w, 'compliance'), w.actorId]);
  const { rows: controls } = await pool.query<{ overdue: number; ineffective: number }>(
    `select count(*) filter (where next_test_due < current_date)::int as overdue, count(*) filter (where status = 'ineffective')::int as ineffective from gov_control where tenant_id = $1 and ($2 or owner_id = $3)`,
    [w.tenantId, inTeam(w, 'compliance', 'security'), w.actorId]);
  // Holds appear only for the people allowed to see them.
  const holds = holdManager(w) ? (await pool.query<{ active: number; released: number }>(`select count(*) filter (where status = 'active')::int as active, count(*) filter (where status = 'released')::int as released from legal_hold where tenant_id = $1`, [w.tenantId])).rows[0] : null;
  const { rows: acks } = await pool.query<{ n: number }>(
    `select count(*)::int as n from policy_campaign c join policy_version v on v.id = c.policy_version_id
      where c.tenant_id = $1 and v.status = 'published' and (c.audience->'roles' is null or c.audience->'roles' ? $3)
        and not exists (select 1 from policy_ack k where k.campaign_id = c.id and k.actor_id = $2)`, [w.tenantId, w.actorId, w.role]);
  return { tasks: tasks[0], remediation, expiring, policies, exceptions: exceptions[0]!.n, controls: controls[0], holds, myAcknowledgements: acks[0]!.n, disclaimer: CONTROLS_DISCLAIMER,
    me: { admin: w.admin, owner: w.owner, teams: w.teams, holds: holdManager(w) } };
}
