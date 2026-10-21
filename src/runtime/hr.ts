/**
 * Employee lifecycle and HR requests (PRD Module 7).
 *
 * Who sees what is the heart of it:
 *   HR        owners, admins and members of the HR team. Everything,
 *             including pay, restricted cases and every note.
 *   teams     IT, Facilities, Finance. The tasks for their team, and the
 *             basic facts about the person (name, dates, location, unit,
 *             title). Never pay, never notes that are not shared, and on a
 *             restricted case only their own task (acceptance 4).
 *   manager   the person's current manager from the directory: manager tasks.
 *   employee  their own tasks, leave and documents. A future employee holds
 *             the pre_hire role and nothing else until the activation task
 *             runs (acceptance 1).
 *
 * A case is built from a template of team tasks. A task may wait for other
 * tasks and for a date; the critical revocation in an offboarding waits for
 * nothing but the end date, and an urgent termination runs it at once
 * (acceptance 2). A transfer dates the new reporting line, so routing changes
 * on the day and past decisions keep the old manager (acceptance 3).
 */
import { inTransaction, type Client, type Pool } from './db.js';
import { randomUUID } from 'node:crypto';
import { InvalidInput } from './errors.js';
import { WORKSPACE_ROLES, requireWorkspaceCapability, type Principal, type WorkspaceRole } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { enabledModules } from './modules.js';
import { managerOf } from './org.js';
import { invite } from './workspace.js';
import { openCustody, queueRevocations } from './ops.js';

const UUID = /^[0-9a-f-]{36}$/;
const TEAMS = ['hr', 'it', 'facilities', 'finance'] as const;
const TASK_TEAMS = ['hr', 'it', 'facilities', 'finance', 'manager', 'employee'] as const;
type Team = (typeof TASK_TEAMS)[number];
const FIELDS = ['identity', 'employment_status', 'compensation', 'leave_balance', 'payroll_ref'] as const;
type OwnedField = (typeof FIELDS)[number];

export const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[, ]/g, '')); return Number.isFinite(n) ? n : NaN; };
const today = () => new Date().toISOString().slice(0, 10);
export function day(v: unknown, what: string, required = false): string | null {
  const s = text(v, 10);
  if (!s) { if (required) throw new InvalidInput(`${what} is required`); return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) throw new InvalidInput(`${what} must be a date`);
  return s;
}
export function currencyCode(v: unknown): string {
  const c = text(v, 10).toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new InvalidInput('currency must be a three-letter ISO code, like USD, GBP, EUR or NGN');
  return c;
}
export function countryCode(v: unknown): string {
  const c = text(v, 10).toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) throw new InvalidInput('country must be a two-letter ISO code, like US, GB, NG or KE');
  return c;
}
/** Working days as ISO weekday numbers, Monday 1 to Sunday 7. */
export function weekdays(v: unknown): number[] {
  if (!Array.isArray(v) || !v.length) throw new InvalidInput('workingDays must list the days of the working week, Monday 1 to Sunday 7');
  const out = [...new Set(v.map((x) => Math.trunc(num(x))))].filter((n) => n >= 1 && n <= 7).sort();
  if (!out.length) throw new InvalidInput('workingDays must list the days of the working week, Monday 1 to Sunday 7');
  return out;
}
export function id(v: unknown, what: string): string {
  const s = text(v, 36);
  if (!UUID.test(s)) throw new InvalidInput(`${what} must be an id`);
  return s;
}

// ------------------------------------------------------------------ access

export interface Who { tenantId: string; actorId: string; email: string; role: WorkspaceRole; teams: Set<string>; hr: boolean; admin: boolean }

export async function who(pool: Pool | Client, principal: Principal): Promise<Who> {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  if (!(await enabledModules(pool as Pool, principal.tenantId)).has('hr')) {
    throw new InvalidInput('the HR module is switched off for this workspace — an owner can switch it on in Settings');
  }
  const { rows } = await pool.query<{ email: string; workspace_role: WorkspaceRole; active: boolean }>(
    'select email, workspace_role, active from actor where id = $1 and tenant_id = $2', [principal.actorId, principal.tenantId]);
  if (!rows[0]?.active) throw new InvalidInput('signed-in members only');
  if (rows[0].workspace_role === 'auditor') throw new InvalidInput('auditors see only their engagement');
  const { rows: t } = await pool.query<{ team: string }>('select team from hr_team_member where tenant_id = $1 and actor_id = $2', [principal.tenantId, principal.actorId]);
  const teams = new Set(t.map((x) => x.team));
  const admin = ['owner', 'admin'].includes(rows[0].workspace_role);
  if (admin) teams.add('hr');
  return { tenantId: principal.tenantId, actorId: principal.actorId, email: rows[0].email, role: rows[0].workspace_role, teams, hr: teams.has('hr'), admin };
}
export function requireHr(w: Who) { if (!w.hr) throw new InvalidInput('only HR can do this'); }
export function requireHrAdmin(w: Who) { if (!w.hr || !w.admin) throw new InvalidInput('only an owner or admin in HR can do this'); }

// ---------------------------------------------------------------- settings

export async function hrSettings(client: Client | Pool, tenantId: string) {
  const { rows } = await client.query<{ field_owners: Record<string, string>; activation_role: WorkspaceRole; anniversary_notice_days: number; default_currency: string; default_country: string | null; working_days: number[] }>(
    'select field_owners, activation_role, anniversary_notice_days, default_currency, default_country, working_days from hr_settings where tenant_id = $1', [tenantId]);
  const r = rows[0];
  const owners: Record<OwnedField, string> = { identity: 'patform', employment_status: 'patform', compensation: 'patform', leave_balance: 'patform', payroll_ref: 'patform', ...(r?.field_owners ?? {}) };
  return { fieldOwners: owners, activationRole: r?.activation_role ?? 'read_only', anniversaryNoticeDays: r?.anniversary_notice_days ?? 14,
    defaultCurrency: r?.default_currency ?? 'USD', defaultCountry: r?.default_country ?? null, workingDays: r?.working_days ?? [1, 2, 3, 4, 5] };
}

export async function readHrSettings(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireHr(w);
  return hrSettings(pool, w.tenantId);
}

export async function updateHrSettings(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHrAdmin(w);
  const cur = await hrSettings(pool, w.tenantId);
  const owners = { ...cur.fieldOwners };
  if (body.fieldOwners !== undefined) {
    if (!body.fieldOwners || typeof body.fieldOwners !== 'object') throw new InvalidInput('fieldOwners must map fields to owners');
    for (const [k, v] of Object.entries(body.fieldOwners as Record<string, unknown>)) {
      if (!(FIELDS as readonly string[]).includes(k)) throw new InvalidInput(`unknown field ${k}`);
      const owner = text(v, 60) || 'patform';
      if (!/^[A-Za-z0-9 ._-]+$/.test(owner)) throw new InvalidInput(`owner for ${k} may use letters, digits, spaces, dots and dashes`);
      owners[k as OwnedField] = owner.toLowerCase() === 'patform' ? 'patform' : owner;
    }
  }
  const activationRole = body.activationRole === undefined ? cur.activationRole : text(body.activationRole, 20) as WorkspaceRole;
  if (!WORKSPACE_ROLES.includes(activationRole) || ['owner', 'pre_hire'].includes(activationRole)) throw new InvalidInput('the activation role must be an ordinary role');
  const notice = body.anniversaryNoticeDays === undefined ? cur.anniversaryNoticeDays : Math.trunc(num(body.anniversaryNoticeDays));
  if (!(notice >= 1 && notice <= 120)) throw new InvalidInput('anniversaryNoticeDays must be 1 to 120');
  const currency = body.defaultCurrency === undefined ? cur.defaultCurrency : currencyCode(body.defaultCurrency);
  const country = body.defaultCountry === undefined ? cur.defaultCountry : (text(body.defaultCountry, 10) ? countryCode(body.defaultCountry) : null);
  const workingDays = body.workingDays === undefined ? cur.workingDays : weekdays(body.workingDays);
  await inTransaction(pool, async (client) => {
    await client.query(
      `insert into hr_settings (tenant_id, field_owners, activation_role, anniversary_notice_days, default_currency, default_country, working_days, updated_by, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (tenant_id) do update set field_owners = excluded.field_owners, activation_role = excluded.activation_role,
         anniversary_notice_days = excluded.anniversary_notice_days, default_currency = excluded.default_currency, default_country = excluded.default_country,
         working_days = excluded.working_days, updated_by = excluded.updated_by, updated_at = now()`,
      [w.tenantId, JSON.stringify(owners), activationRole, notice, currency, country, JSON.stringify(workingDays), w.actorId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.settings_changed', detail: { ...owners, activationRole, notice, currency, country } });
  });
  return hrSettings(pool, w.tenantId);
}

// ------------------------------------------------------------------- teams

export async function listTeams(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireHr(w);
  const { rows } = await pool.query(
    `select m.team, m.actor_id, a.display_name, a.email from hr_team_member m join actor a on a.id = m.actor_id
      where m.tenant_id = $1 order by m.team, a.display_name`, [w.tenantId]);
  return rows;
}

export async function setTeamMember(pool: Pool, principal: Principal, body: { team?: unknown; actorId?: unknown; member?: unknown }) {
  const w = await who(pool, principal); requireHrAdmin(w);
  const team = text(body.team, 20);
  if (!(TEAMS as readonly string[]).includes(team)) throw new InvalidInput('team must be hr, it, facilities or finance');
  const actorId = id(body.actorId, 'actorId');
  const { rows } = await pool.query('select 1 from actor where id = $1 and tenant_id = $2 and active', [actorId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such member');
  if (body.member === false) await pool.query('delete from hr_team_member where tenant_id = $1 and team = $2 and actor_id = $3', [w.tenantId, team, actorId]);
  else await pool.query('insert into hr_team_member (tenant_id, team, actor_id) values ($1, $2, $3) on conflict do nothing', [w.tenantId, team, actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: body.member === false ? 'hr.team_removed' : 'hr.team_added', targetId: actorId, detail: { team } });
  return { team, actorId, member: body.member !== false };
}

// --------------------------------------------------------------- templates

export interface TemplateTask { key: string; title: string; team: Team; critical?: boolean; after?: string[]; waitFor?: 'start' | 'end' | 'effective'; action?: 'activate_access' | 'revoke_access' | 'finance_clearance' | 'recover_assets' }

const DEFAULT_TEMPLATES: { kind: string; name: string; tasks: TemplateTask[] }[] = [
  { kind: 'onboarding', name: 'Standard onboarding', tasks: [
    { key: 'contract', title: 'Send the contract and receive it signed', team: 'hr' },
    { key: 'identity', title: 'Check identity and right to work', team: 'hr', critical: true },
    { key: 'personal_details', title: 'Fill in your personal and emergency contact details', team: 'employee' },
    { key: 'equipment', title: 'Prepare laptop, phone and accounts (not yet active)', team: 'it' },
    { key: 'desk', title: 'Assign a desk and building pass', team: 'facilities' },
    { key: 'payroll', title: 'Set up payroll', team: 'finance', after: ['contract'] },
    { key: 'first_week', title: 'Plan the first week and a buddy', team: 'manager' },
    { key: 'activate', title: 'Activate access on the first day', team: 'it', critical: true, after: ['identity', 'contract'], waitFor: 'start', action: 'activate_access' },
  ] },
  { kind: 'offboarding', name: 'Standard offboarding', tasks: [
    { key: 'revoke', title: 'Revoke all access', team: 'it', critical: true, waitFor: 'end', action: 'revoke_access' },
    { key: 'equipment', title: 'Recover laptop and phone', team: 'it', action: 'recover_assets' },
    { key: 'pass', title: 'Recover building pass and keys', team: 'facilities' },
    { key: 'handover', title: 'Hand over work and accounts', team: 'manager' },
    { key: 'clearance', title: 'Clear advances, claims and final pay', team: 'finance', action: 'finance_clearance' },
    { key: 'exit', title: 'Exit interview and final documents', team: 'hr' },
  ] },
  { kind: 'transfer', name: 'Transfer or promotion', tasks: [
    { key: 'confirm', title: 'Confirm the change in writing', team: 'hr' },
    { key: 'access', title: 'Adjust system access for the new role', team: 'it', waitFor: 'effective' },
    { key: 'move', title: 'Move desk if needed', team: 'facilities', waitFor: 'effective' },
    { key: 'cost_centre', title: 'Update cost centre in payroll', team: 'finance', waitFor: 'effective' },
  ] },
  { kind: 'probation', name: 'Probation review', tasks: [
    { key: 'checkin', title: 'Mid-probation check-in', team: 'manager' },
    { key: 'recommend', title: 'Recommend: confirm, extend or end', team: 'manager', after: ['checkin'] },
    { key: 'decide', title: 'Record the decision and tell the employee', team: 'hr', after: ['recommend'] },
  ] },
];

function checkTemplate(kind: string, tasks: unknown): TemplateTask[] {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 60) throw new InvalidInput('a template needs 1 to 60 tasks');
  const out: TemplateTask[] = tasks.map((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const key = text(t.key, 40) || `task_${i + 1}`;
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new InvalidInput(`task ${i + 1}: key must be lowercase letters, digits or underscores`);
    const title = text(t.title, 200);
    if (!title) throw new InvalidInput(`task ${i + 1}: give it a title`);
    const team = text(t.team, 20) as Team;
    if (!(TASK_TEAMS as readonly string[]).includes(team)) throw new InvalidInput(`task ${i + 1}: team must be one of ${TASK_TEAMS.join(', ')}`);
    const waitFor = t.waitFor ? text(t.waitFor, 12) : undefined;
    if (waitFor && !['start', 'end', 'effective'].includes(waitFor)) throw new InvalidInput(`task ${i + 1}: waitFor must be start, end or effective`);
    const action = t.action ? text(t.action, 30) : undefined;
    const allowed: Record<string, string> = { activate_access: 'onboarding', revoke_access: 'offboarding', finance_clearance: 'offboarding', recover_assets: 'offboarding' };
    if (action && allowed[action] !== kind) throw new InvalidInput(`task ${i + 1}: ${action} belongs in an ${allowed[action] ?? 'unknown'} template`);
    const after = Array.isArray(t.after) ? t.after.map((x) => text(x, 40)).filter(Boolean) : [];
    return { key, title, team, critical: t.critical === true, after, ...(waitFor ? { waitFor: waitFor as TemplateTask['waitFor'] } : {}), ...(action ? { action: action as TemplateTask['action'] } : {}) };
  });
  const keys = new Set<string>();
  for (const t of out) { if (keys.has(t.key)) throw new InvalidInput(`two tasks share the key ${t.key}`); keys.add(t.key); }
  for (const t of out) for (const a of t.after ?? []) if (!keys.has(a)) throw new InvalidInput(`${t.key} waits for ${a}, which is not in the template`);
  const byKey = new Map(out.map((t) => [t.key, t]));
  const visit = (k: string, path: string[]) => {
    if (path.includes(k)) throw new InvalidInput(`tasks wait for each other in a loop: ${[...path, k].join(' → ')}`);
    for (const a of byKey.get(k)?.after ?? []) visit(a, [...path, k]);
  };
  for (const t of out) visit(t.key, []);
  const revoke = out.find((t) => t.action === 'revoke_access');
  if (revoke?.after?.length) throw new InvalidInput('revoking access must not wait for other tasks (PRD HR-08)');
  if (kind === 'offboarding' && !revoke) throw new InvalidInput('an offboarding template needs a revoke_access task');
  if (kind === 'onboarding' && !out.some((t) => t.action === 'activate_access')) throw new InvalidInput('an onboarding template needs an activate_access task');
  return out;
}

async function ensureTemplates(client: Client | Pool, tenantId: string) {
  const { rows } = await client.query<{ n: number }>('select count(*)::int as n from lifecycle_template where tenant_id = $1', [tenantId]);
  if (rows[0]!.n) return;
  for (const t of DEFAULT_TEMPLATES) {
    await client.query('insert into lifecycle_template (tenant_id, kind, name, tasks) values ($1, $2, $3, $4)', [tenantId, t.kind, t.name, JSON.stringify(t.tasks)]);
  }
}

export async function listTemplates(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireHr(w);
  await ensureTemplates(pool, w.tenantId);
  const { rows } = await pool.query('select id, kind, name, employment_type, location, tasks, active, updated_at from lifecycle_template where tenant_id = $1 order by kind, name', [w.tenantId]);
  return rows;
}

export async function saveTemplate(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHrAdmin(w);
  const kind = text(body.kind, 20);
  if (!['onboarding', 'offboarding', 'transfer', 'probation'].includes(kind)) throw new InvalidInput('kind must be onboarding, offboarding, transfer or probation');
  const name = text(body.name, 120);
  if (!name) throw new InvalidInput('give the template a name');
  const tasks = checkTemplate(kind, body.tasks);
  const employmentType = text(body.employmentType, 20) || null;
  if (employmentType && !['employee', 'contractor', 'intern'].includes(employmentType)) throw new InvalidInput('employmentType must be employee, contractor or intern');
  const location = text(body.location, 120) || null;
  const templateId = body.id ? id(body.id, 'id') : null;
  if (templateId) {
    const { rowCount } = await pool.query(
      `update lifecycle_template set kind = $3, name = $4, employment_type = $5, location = $6, tasks = $7, active = $8, updated_by = $9, updated_at = now() where id = $1 and tenant_id = $2`,
      [templateId, w.tenantId, kind, name, employmentType, location, JSON.stringify(tasks), body.active !== false, w.actorId]);
    if (!rowCount) throw new InvalidInput('no such template');
  }
  const { rows } = templateId ? { rows: [{ id: templateId }] } : await pool.query<{ id: string }>(
    'insert into lifecycle_template (tenant_id, kind, name, employment_type, location, tasks, updated_by) values ($1, $2, $3, $4, $5, $6, $7) returning id',
    [w.tenantId, kind, name, employmentType, location, JSON.stringify(tasks), w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.template_saved', targetId: rows[0]!.id, detail: { kind, name, tasks: tasks.length } });
  return { id: rows[0]!.id, kind, name, tasks };
}

/** The most specific active template: matching type and location beat "any". */
async function pickTemplate(client: Client, tenantId: string, kind: string, employmentType: string | null, location: string | null): Promise<TemplateTask[]> {
  await ensureTemplates(client, tenantId);
  const { rows } = await client.query<{ tasks: TemplateTask[]; employment_type: string | null; location: string | null }>(
    `select tasks, employment_type, location from lifecycle_template
      where tenant_id = $1 and kind = $2 and active
        and (employment_type is null or employment_type = $3) and (location is null or lower(location) = lower($4))
      order by (employment_type is not null)::int + (location is not null)::int desc, updated_at desc limit 1`,
    [tenantId, kind, employmentType, location ?? '']);
  if (!rows[0]) throw new InvalidInput(`there is no active ${kind} template`);
  return rows[0].tasks;
}

async function createTasks(client: Client, caseId: string, tasks: TemplateTask[], dates: { start?: string | null; end?: string | null; effective?: string | null }) {
  for (const t of tasks) {
    const wait = t.waitFor ? dates[t.waitFor] ?? null : null;
    await client.query(
      `insert into lifecycle_task (case_id, key, title, team, critical, prerequisites, wait_until, action) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [caseId, t.key, t.title, t.team, t.critical === true, JSON.stringify(t.after ?? []), wait, t.action ?? null]);
  }
}

// --------------------------------------------------------------- employees

export async function employeeFor(client: Client | Pool, tenantId: string, employeeId: string) {
  const { rows } = await client.query<{ id: string; actor_id: string | null; email: string; name: string; status: string; employment_type: string; location: string | null; start_date: string | null; end_date: string | null; probation_end: string | null; branch_id: string | null }>(
    `select id, actor_id, email, name, status, employment_type, location, start_date::text, end_date::text, probation_end::text, branch_id from employee_record where id = $1 and tenant_id = $2`,
    [employeeId, tenantId]);
  if (!rows[0]) throw new InvalidInput('no such employee');
  return rows[0];
}

/** An employee record for a member who has none yet (for leave and documents). */
export async function recordForActor(client: Client | Pool, tenantId: string, actorId: string) {
  const { rows } = await client.query<{ id: string }>('select id from employee_record where actor_id = $1', [actorId]);
  if (rows[0]) return rows[0].id;
  const { rows: a } = await client.query<{ email: string; display_name: string; workspace_role: string }>('select email, display_name, workspace_role from actor where id = $1', [actorId]);
  const { rows: made } = await client.query<{ id: string }>(
    `insert into employee_record (tenant_id, actor_id, email, name, status) values ($1, $2, lower($3), $4, $5)
     on conflict (tenant_id, email) do update set actor_id = excluded.actor_id returning id`,
    [tenantId, actorId, a[0]!.email, a[0]!.display_name, a[0]!.workspace_role === 'pre_hire' ? 'pre_hire' : 'active']);
  return made[0]!.id;
}

export async function listEmployees(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireHr(w);
  const { rows } = await pool.query(
    `select e.id, e.actor_id, e.email, e.name, e.employment_type, e.status, e.location, e.start_date, e.end_date, e.probation_end, e.payroll_ref, e.external_ref, e.branch_id, e.grade,
            b.name as branch_name, b.country as branch_country, b.currency as branch_currency,
            a.workspace_role, a.active, a.position_title, u.name as unit_name,
            (select m.display_name from reporting_line r join actor m on m.id = r.manager_id
              where r.actor_id = e.actor_id and r.kind = 'primary' and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now()) limit 1) as manager_name
       from employee_record e left join actor a on a.id = e.actor_id left join org_unit u on u.id = a.org_unit_id left join hr_branch b on b.id = e.branch_id
      where e.tenant_id = $1 order by e.status = 'left', e.name`, [w.tenantId]);
  return rows;
}

/**
 * HR-12: a change to a field an outside system owns is not applied. It
 * becomes a reconciliation task for HR, so the source system stays the
 * source and nobody's update is silently lost.
 */
export async function ownedElsewhere(client: Client, w: Who, employeeId: string, field: OwnedField, current: string | null, proposed: string | null): Promise<boolean> {
  const owner = (await hrSettings(client, w.tenantId)).fieldOwners[field];
  if (owner === 'patform') return false;
  await client.query(
    `insert into hr_reconciliation (tenant_id, employee_id, field, owner, current_value, proposed_value, raised_by) values ($1, $2, $3, $4, $5, $6, $7)`,
    [w.tenantId, employeeId, field, owner, current, proposed, w.actorId]);
  return true;
}

export async function updateEmployee(pool: Pool, principal: Principal, employeeId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  return inTransaction(pool, async (client) => {
    const e = await employeeFor(client, w.tenantId, employeeId);
    const sets: string[] = []; const params: unknown[] = [e.id]; const queued: string[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (body.name !== undefined) {
      const name = text(body.name, 120);
      if (!name) throw new InvalidInput('a name is required');
      if (await ownedElsewhere(client, w, e.id, 'identity', e.name, name)) queued.push('name'); else set('name', name);
    }
    if (body.status !== undefined) {
      const status = text(body.status, 20);
      if (!['pre_hire', 'active', 'leaving', 'left'].includes(status)) throw new InvalidInput('status must be pre_hire, active, leaving or left');
      if (await ownedElsewhere(client, w, e.id, 'employment_status', e.status, status)) queued.push('status'); else set('status', status);
    }
    if (body.payrollRef !== undefined) {
      const ref = text(body.payrollRef, 60) || null;
      if (await ownedElsewhere(client, w, e.id, 'payroll_ref', null, ref)) queued.push('payroll reference'); else set('payroll_ref', ref);
    }
    if (body.employmentType !== undefined) {
      const t = text(body.employmentType, 20);
      if (!['employee', 'contractor', 'intern'].includes(t)) throw new InvalidInput('employmentType must be employee, contractor or intern');
      set('employment_type', t);
    }
    if (body.location !== undefined) set('location', text(body.location, 120) || null);
    if (body.probationEnd !== undefined) set('probation_end', day(body.probationEnd, 'probationEnd'));
    if (body.externalRef !== undefined) set('external_ref', text(body.externalRef, 120) || null);
    if (sets.length) await client.query(`update employee_record set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.employee_updated', targetId: e.id, detail: { fields: Object.keys(body), queued } });
    return { id: e.id, updated: sets.length, queuedForReconciliation: queued };
  });
}

/** HR-06: pay, in its own table, read and written by HR only. */
export async function setCompensation(pool: Pool, principal: Principal, employeeId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHrAdmin(w);
  const amount = num(body.amount);
  if (!(amount >= 0)) throw new InvalidInput('give the amount');
  const period = text(body.period, 10) || 'year';
  if (!['year', 'month', 'week', 'day', 'hour', 'once'].includes(period)) throw new InvalidInput('period must be year, month, week, day, hour or once');
  const kind = text(body.kind, 20) || 'base';
  if (!['base', 'allowance', 'bonus', 'deduction'].includes(kind)) throw new InvalidInput('kind must be base, allowance, bonus or deduction');
  const label = text(body.label, 80) || (kind === 'base' ? 'Base pay' : '');
  if (!label) throw new InvalidInput(`give the ${kind} a name, like Housing allowance`);
  const endedOn = day(body.endedOn, 'endedOn');
  const effectiveFrom = day(body.effectiveFrom, 'effectiveFrom', true)!;
  return inTransaction(pool, async (client) => {
    const e = await employeeFor(client, w.tenantId, employeeId);
    let currency = text(body.currency, 10) ? currencyCode(body.currency) : '';
    if (!currency && e.branch_id) { const { rows: b } = await client.query<{ currency: string }>('select currency from hr_branch where id = $1', [e.branch_id]); currency = b[0]?.currency ?? ''; }
    if (!currency) currency = (await hrSettings(client, w.tenantId)).defaultCurrency;
    if (await ownedElsewhere(client, w, e.id, 'compensation', null, `${amount} ${currency}/${period} from ${effectiveFrom}`)) {
      return { queuedForReconciliation: true };
    }
    if (body.endId !== undefined) {
      // Close a component: the line stays in the history with its end date.
      await client.query('update employee_compensation set ended_on = $3 where tenant_id = $1 and id = $2', [w.tenantId, Math.trunc(num(body.endId)), endedOn ?? effectiveFrom]);
    } else {
      await client.query(
        `insert into employee_compensation (tenant_id, employee_id, amount, currency, period, effective_from, reason, entered_by, kind, label, ended_on) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [w.tenantId, e.id, amount, currency, period, effectiveFrom, text(body.reason, 300) || null, w.actorId, kind, label, endedOn]);
    }
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.compensation_set', targetId: e.id, detail: { effectiveFrom } });
    return { queuedForReconciliation: false };
  });
}

export async function listCompensation(pool: Pool, principal: Principal, employeeId: string) {
  const w = await who(pool, principal); requireHr(w);
  const { rows } = await pool.query(
    `select c.id, c.kind, c.label, c.amount, c.currency, c.period, c.effective_from::text, c.ended_on::text, c.reason, c.created_at, a.display_name as entered_by
       from employee_compensation c left join actor a on a.id = c.entered_by where c.tenant_id = $1 and c.employee_id = $2 order by c.kind = 'base' desc, c.effective_from desc, c.id desc`,
    [w.tenantId, employeeId]);
  return rows;
}

export async function addCertification(pool: Pool, principal: Principal, employeeId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const name = text(body.name, 120);
  if (!name) throw new InvalidInput('name the certification');
  const expires = day(body.expiresOn, 'expiresOn', true);
  await employeeFor(pool, w.tenantId, employeeId);
  const { rows } = await pool.query<{ id: string }>('insert into employee_certification (tenant_id, employee_id, name, expires_on) values ($1, $2, $3, $4) returning id', [w.tenantId, employeeId, name, expires]);
  return { id: rows[0]!.id };
}

// ------------------------------------------------------------------- cases

async function newCase(client: Client, w: Who, args: { employeeId: string; kind: string; restricted?: boolean; effective?: string | null; summary?: string | null; changes?: unknown; hiringId?: string | null; authorizedBy?: string | null }) {
  const { rows } = await client.query<{ id: string }>(
    `insert into lifecycle_case (tenant_id, employee_id, kind, restricted, effective_date, summary, changes, created_by, hiring_id, authorized_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [w.tenantId, args.employeeId, args.kind, args.restricted === true, args.effective ?? null, args.summary ?? null,
      args.changes === undefined ? null : JSON.stringify(args.changes), w.actorId, args.hiringId ?? null, args.authorizedBy ?? null]);
  return rows[0]!.id;
}

/**
 * HR-02, JRN-01. The person is created at once as a pre-hire (no capability),
 * with their manager and unit, so the right people get their tasks; the
 * activation task gives them their real role on the first day.
 */
export async function startOnboarding(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const email = text(body.email, 254).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new InvalidInput('give a valid work email');
  const name = text(body.name, 120);
  if (!name) throw new InvalidInput('give their name');
  const employmentType = text(body.employmentType, 20) || 'employee';
  if (!['employee', 'contractor', 'intern'].includes(employmentType)) throw new InvalidInput('employmentType must be employee, contractor or intern');
  const startDate = day(body.startDate, 'startDate', true)!;
  const branchId = body.branchId ? id(body.branchId, 'branchId') : null;
  if (branchId) { const { rows: b } = await pool.query('select 1 from hr_branch where id = $1 and tenant_id = $2 and active', [branchId, w.tenantId]); if (!b[0]) throw new InvalidInput('no such branch'); }
  const location = text(body.location, 120) || null;
  const probationEnd = day(body.probationEnd, 'probationEnd');
  if (probationEnd && probationEnd < startDate) throw new InvalidInput('probation end must be after the start date');
  const managerId = body.managerId ? id(body.managerId, 'managerId') : null;
  const unitId = body.unitId ? id(body.unitId, 'unitId') : null;
  const hiringId = body.hiringId ? id(body.hiringId, 'hiringId') : null;
  const out = await inTransaction(pool, async (client) => {
    await client.query('select id from tenant where id = $1 for update', [w.tenantId]);
    const { rows: existing } = await client.query<{ id: string; active: boolean; workspace_role: string }>('select id, active, workspace_role from actor where tenant_id = $1 and lower(email) = $2', [w.tenantId, email]);
    const existingMember = Boolean(existing[0]?.active && existing[0].workspace_role !== 'pre_hire');
    if (existingMember && body.onboardExisting !== true) throw new InvalidInput('this email already belongs to a member; choose onboarding for an existing member');
    if (existing[0] && !existing[0].active) throw new InvalidInput('that email belongs to a deactivated member; reactivate them on the People page for a rehire');
    if (existing[0]) {
      const { rows: openCases } = await client.query('select 1 from lifecycle_case c join employee_record e on e.id = c.employee_id where e.tenant_id = $1 and lower(e.email) = $2 and c.kind = $3 and c.status = $4 limit 1', [w.tenantId, email, 'onboarding', 'open']);
      if (openCases.length) throw new InvalidInput('onboarding is already open for this member');
    }
    if (hiringId) {
      const { rows: h } = await client.query<{ headcount: number; filled: number; status: string }>('select headcount, filled, status from hiring_requisition where id = $1 and tenant_id = $2 for update', [hiringId, w.tenantId]);
      if (!h[0]) throw new InvalidInput('no such hiring request');
      if (h[0].status !== 'open' || h[0].filled >= h[0].headcount) throw new InvalidInput('that hiring request is already filled');
      await client.query(`update hiring_requisition set filled = filled + 1, status = case when filled + 1 >= headcount then 'filled' else status end where id = $1`, [hiringId]);
    }
    let actorId = existing[0]?.id;
    if (!actorId) {
      const { rows } = await client.query<{ id: string }>(`insert into actor (tenant_id, email, display_name, workspace_role, provisioned_by) values ($1, $2, $3, 'pre_hire', 'import') returning id`, [w.tenantId, email, name]);
      actorId = rows[0]!.id;
    }
    if (unitId) {
      const { rows: u } = await client.query('select 1 from org_unit where id = $1 and tenant_id = $2', [unitId, w.tenantId]);
      if (!u[0]) throw new InvalidInput('no such unit');
    }
    await client.query('update actor set display_name = $2, org_unit_id = coalesce($3, org_unit_id), position_title = coalesce($4, position_title) where id = $1', [actorId, name, unitId, text(body.title, 120) || null]);
    if (managerId) {
      if (managerId === actorId) throw new InvalidInput('a person cannot be their own manager');
      const { rows: m } = await client.query('select 1 from actor where id = $1 and tenant_id = $2 and active', [managerId, w.tenantId]);
      if (!m[0]) throw new InvalidInput('no such manager');
      await client.query(`update reporting_line set effective_to = greatest(now(), effective_from) where actor_id = $1 and kind = 'primary' and effective_to is null`, [actorId]);
      await client.query(`insert into reporting_line (tenant_id, actor_id, manager_id, kind, effective_from, created_by) values ($1, $2, $3, 'primary', now(), $4)`, [w.tenantId, actorId, managerId, w.actorId]);
    }
    const { rows: rec } = await client.query<{ id: string }>(
      `insert into employee_record (tenant_id, actor_id, email, name, employment_type, status, location, start_date, probation_end, branch_id, grade)
       values ($1, $2, $3, $4, $5, $11, $6, $7, $8, $9, $10)
       on conflict (tenant_id, email) do update set actor_id = excluded.actor_id, name = excluded.name, employment_type = excluded.employment_type,
         status = excluded.status, location = excluded.location, start_date = excluded.start_date, probation_end = excluded.probation_end, branch_id = excluded.branch_id, grade = excluded.grade, updated_at = now()
       returning id`, [w.tenantId, actorId, email, name, employmentType, location, startDate, probationEnd, branchId, text(body.grade, 40) || null, existingMember ? 'active' : 'pre_hire']);
    const tasks = await pickTemplate(client, w.tenantId, 'onboarding', employmentType, location);
    const caseId = await newCase(client, w, { employeeId: rec[0]!.id, kind: 'onboarding', effective: startDate, summary: text(body.summary, 500) || null, hiringId });
    await createTasks(client, caseId, tasks, { start: startDate });
    if (existingMember) await client.query(`update lifecycle_task set status = 'done', note = 'Workspace access was already active before onboarding', completed_by = $2, completed_at = now() where case_id = $1 and action = 'activate_access'`, [caseId, w.actorId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.onboarding_started', targetId: caseId, detail: { email, startDate, employmentType } });
    return { caseId, employeeId: rec[0]!.id, actorId, existingMember };
  });
  let invited: string | null = null;
  if (body.sendInvitation === true && !out.existingMember) {
    try { invited = (await invite(pool, { principal, email, workspaceRole: 'pre_hire' })).delivered; }
    catch (err) { invited = err instanceof Error ? err.message : String(err); }
  }
  return { ...out, invitation: invited };
}

/** HR-08, JRN-04. Revocation waits only for the end date. */
export async function startOffboarding(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const employeeId = id(body.employeeId, 'employeeId');
  const endDate = day(body.endDate, 'endDate', true)!;
  return inTransaction(pool, async (client) => {
    const e = await employeeFor(client, w.tenantId, employeeId);
    if (e.status === 'left') throw new InvalidInput('this person has already left');
    const { rows: open } = await client.query(`select 1 from lifecycle_case where employee_id = $1 and kind in ('offboarding', 'urgent_termination') and status = 'open'`, [e.id]);
    if (open[0]) throw new InvalidInput('an offboarding is already open for this person');
    await client.query(`update employee_record set status = 'leaving', end_date = $2, updated_at = now() where id = $1`, [e.id, endDate]);
    const tasks = await pickTemplate(client, w.tenantId, 'offboarding', e.employment_type, e.location);
    const caseId = await newCase(client, w, { employeeId: e.id, kind: 'offboarding', effective: endDate, summary: text(body.summary, 500) || null });
    await createTasks(client, caseId, tasks, { end: endDate });
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.offboarding_started', targetId: caseId, detail: { employee: e.email, endDate } });
    return { caseId };
  });
}

/**
 * HR-09. Only an owner or admin in HR can authorise it: a manager can ask
 * but not bypass the authority. Access is revoked in the same transaction,
 * whatever else is outstanding (acceptance 2). The case is restricted: other
 * teams see only their own task.
 */
export async function urgentTermination(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  if (!w.hr || !w.admin) throw new InvalidInput('an urgent termination needs an owner or admin in HR to authorise it');
  const employeeId = id(body.employeeId, 'employeeId');
  const reason = text(body.reason, 1000);
  if (!reason) throw new InvalidInput('record the reason; it is kept in a restricted HR note');
  return inTransaction(pool, async (client) => {
    const e = await employeeFor(client, w.tenantId, employeeId);
    if (e.actor_id === w.actorId) throw new InvalidInput('you cannot terminate yourself');
    if (e.status === 'left') throw new InvalidInput('this person has already left');
    const t = today();
    await client.query(`update lifecycle_case set status = 'cancelled', closed_at = now() where employee_id = $1 and kind = 'offboarding' and status = 'open'`, [e.id]);
    await client.query(`update employee_record set status = 'leaving', end_date = $2, updated_at = now() where id = $1`, [e.id, t]);
    const tasks = (await pickTemplate(client, w.tenantId, 'offboarding', e.employment_type, e.location)).map((x) => x.action === 'revoke_access' ? { ...x, waitFor: undefined } : x);
    const caseId = await newCase(client, w, { employeeId: e.id, kind: 'urgent_termination', restricted: true, effective: t, authorizedBy: w.actorId });
    await createTasks(client, caseId, tasks, { end: t });
    await client.query(`insert into case_note (case_id, category, shared, body, author_id) values ($1, 'disciplinary', false, $2, $3)`, [caseId, reason, w.actorId]);
    // Critical revocation now, by the system, on HR's authority.
    if (e.actor_id) await revokeAccess(client, w, e.actor_id);
    await client.query(`update lifecycle_task set status = 'done', completed_by = $2, completed_at = now(), note = 'Revoked at once under urgent termination' where case_id = $1 and action = 'revoke_access'`, [caseId, w.actorId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.urgent_termination', targetId: caseId, detail: { employee: e.email } });
    return { caseId, accessRevoked: !!e.actor_id };
  });
}

/**
 * HR-06, acceptance 3. The new reporting line is dated from the effective
 * date: routing changes on the day and the history keeps the old manager.
 * Unit and title change on the day too (applyDueChanges).
 */
export async function startTransfer(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHrAdmin(w);
  const employeeId = id(body.employeeId, 'employeeId');
  const effective = day(body.effectiveDate, 'effectiveDate', true)!;
  const reason = text(body.reason, 500);
  if (!reason) throw new InvalidInput('say what the change is');
  const changes = {
    managerId: body.managerId ? id(body.managerId, 'managerId') : null,
    unitId: body.unitId ? id(body.unitId, 'unitId') : null,
    title: text(body.title, 120) || null,
    legalEntityId: body.legalEntityId ? id(body.legalEntityId, 'legalEntityId') : null,
    costCentre: text(body.costCentre, 60) || null,
  };
  if (!Object.values(changes).some(Boolean)) throw new InvalidInput('a transfer must change something: manager, unit, title, entity or cost centre');
  return inTransaction(pool, async (client) => {
    const e = await employeeFor(client, w.tenantId, employeeId);
    if (!e.actor_id) throw new InvalidInput('this person has no account to transfer');
    if (changes.managerId) {
      if (changes.managerId === e.actor_id) throw new InvalidInput('nobody can be their own manager');
      const { rows: m } = await client.query('select 1 from actor where id = $1 and tenant_id = $2 and active', [changes.managerId, w.tenantId]);
      if (!m[0]) throw new InvalidInput('no such manager');
      const at = `${effective}T00:00:00Z`;
      const { rows: open } = await client.query<{ id: string; effective_from: Date }>(
        `select id, effective_from from reporting_line where actor_id = $1 and kind = 'primary' and effective_to is null for update`, [e.actor_id]);
      if (open[0]) await client.query('update reporting_line set effective_to = greatest($2::timestamptz, effective_from) where id = $1', [open[0].id, at]);
      await client.query(`insert into reporting_line (tenant_id, actor_id, manager_id, kind, effective_from, created_by) values ($1, $2, $3, 'primary', $4, $5)`, [w.tenantId, e.actor_id, changes.managerId, at, w.actorId]);
    }
    for (const [k, table] of [['unitId', 'org_unit'], ['legalEntityId', 'legal_entity']] as const) {
      const v = changes[k];
      if (v) { const { rows } = await client.query(`select 1 from ${table} where id = $1 and tenant_id = $2`, [v, w.tenantId]); if (!rows[0]) throw new InvalidInput(`no such ${k === 'unitId' ? 'unit' : 'legal entity'}`); }
    }
    const tasks = await pickTemplate(client, w.tenantId, 'transfer', e.employment_type, e.location);
    const caseId = await newCase(client, w, { employeeId: e.id, kind: 'transfer', effective, summary: reason, changes });
    await createTasks(client, caseId, tasks, { effective });
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.transfer_started', targetId: caseId, detail: { employee: e.email, effective, ...changes } });
    await applyDueChanges(client, w.tenantId);
    return { caseId };
  });
}

/** Unit, title and entity changes whose day has come. Run by the worker and on read. */
export async function applyDueChanges(client: Client | Pool, tenantId?: string): Promise<number> {
  const { rows } = await client.query<{ id: string; tenant_id: string; actor_id: string; changes: { unitId?: string; title?: string; legalEntityId?: string } }>(
    `select c.id, c.tenant_id, e.actor_id, c.changes from lifecycle_case c join employee_record e on e.id = c.employee_id
      where c.kind = 'transfer' and c.applied_at is null and c.status <> 'cancelled' and c.effective_date <= current_date and e.actor_id is not null
        and ($1::uuid is null or c.tenant_id = $1)`, [tenantId ?? null]);
  for (const r of rows) {
    await client.query(`update actor set org_unit_id = coalesce($2, org_unit_id), position_title = coalesce($3, position_title), legal_entity_id = coalesce($4, legal_entity_id) where id = $1`,
      [r.actor_id, r.changes?.unitId ?? null, r.changes?.title ?? null, r.changes?.legalEntityId ?? null]);
    await client.query('update lifecycle_case set applied_at = now() where id = $1', [r.id]);
  }
  return rows.length;
}

export async function startProbationReview(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const employeeId = id(body.employeeId, 'employeeId');
  return inTransaction(pool, async (client) => {
    const e = await employeeFor(client, w.tenantId, employeeId);
    if (!e.probation_end) throw new InvalidInput('set a probation end date first');
    const tasks = await pickTemplate(client, w.tenantId, 'probation', e.employment_type, e.location);
    const caseId = await newCase(client, w, { employeeId: e.id, kind: 'probation', effective: e.probation_end });
    await createTasks(client, caseId, tasks, { effective: e.probation_end });
    return { caseId };
  });
}

/** HR-04: confirm, extend (needs an owner or admin in HR and a new date) or end. */
export async function decideProbation(pool: Pool, principal: Principal, caseId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const outcome = text(body.outcome, 10);
  const reason = text(body.reason, 1000);
  if (!['confirm', 'extend', 'end'].includes(outcome)) throw new InvalidInput('outcome must be confirm, extend or end');
  if (!reason) throw new InvalidInput('record the reason');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ employee_id: string; kind: string; status: string }>('select employee_id, kind, status from lifecycle_case where id = $1 and tenant_id = $2 for update', [caseId, w.tenantId]);
    if (!rows[0] || rows[0].kind !== 'probation') throw new InvalidInput('no such probation review');
    if (rows[0].status !== 'open') throw new InvalidInput('this review is already closed');
    if (outcome === 'extend') {
      requireHrAdmin(w);
      const until = day(body.newEnd, 'newEnd', true)!;
      await client.query('update employee_record set probation_end = $2, updated_at = now() where id = $1', [rows[0].employee_id, until]);
    }
    if (outcome === 'confirm') await client.query('update employee_record set probation_end = null, updated_at = now() where id = $1', [rows[0].employee_id]);
    await client.query(`insert into case_note (case_id, category, shared, body, author_id) values ($1, 'general', false, $2, $3)`, [caseId, `Probation ${outcome}: ${reason}`, w.actorId]);
    await client.query(`update lifecycle_task set status = 'done', completed_by = $2, completed_at = now(), note = $3 where case_id = $1 and status = 'open'`, [caseId, w.actorId, `Decision: ${outcome}`]);
    await client.query(`update lifecycle_case set status = 'closed', closed_at = now() where id = $1`, [caseId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.probation_decided', targetId: caseId, detail: { outcome } });
    return { caseId, outcome };
  });
}

// ------------------------------------------------------------ case views

interface TaskRow { id: string; case_id: string; key: string; title: string; details: string | null; correction_of: string | null; team: Team; critical: boolean; prerequisites: string[]; wait_until: string | null; action: string | null; status: string; note: string | null; evidence_ref: string | null; completed_at: Date | null; completed_by_name: string | null }

function blockers(t: TaskRow, all: TaskRow[]): string[] {
  if (t.status !== 'open') return [];
  const out: string[] = [];
  for (const k of t.prerequisites ?? []) {
    const p = all.find((x) => x.key === k);
    if (p && p.status === 'open') out.push(`waits for "${p.title}"`);
  }
  if (t.wait_until && t.wait_until > today()) out.push(`waits until ${t.wait_until}`);
  return out;
}

export async function currentManager(client: Client | Pool, tenantId: string, actorId: string | null) {
  if (!actorId) return null;
  return (await managerOf(client, { tenantId, actorId, at: new Date() }))?.id ?? null;
}

async function canDoTask(client: Client | Pool, w: Who, team: Team, employee: { actor_id: string | null; tenant_id?: string }): Promise<boolean> {
  if (team === 'employee') return employee.actor_id === w.actorId;
  if (team === 'manager') return (await currentManager(client, w.tenantId, employee.actor_id)) === w.actorId || w.hr;
  return w.teams.has(team);
}

/**
 * The cases this person may see, with tasks and a readiness summary. Pay is
 * never selected here; notes come separately; restricted cases show only the
 * caller's own tasks unless they are HR.
 */
export async function listCases(pool: Pool, principal: Principal, opts: { status?: string } = {}) {
  const w = await who(pool, principal);
  await applyDueChanges(pool, w.tenantId);
  const { rows: cases } = await pool.query<{
    id: string; kind: string; status: string; restricted: boolean; effective_date: string | null; summary: string | null; changes: unknown; created_at: Date;
    employee_id: string; actor_id: string | null; name: string; email: string; employment_type: string; location: string | null; start_date: string | null; end_date: string | null;
    unit_name: string | null; title: string | null;
  }>(
    `select c.id, c.kind, c.status, c.restricted, c.effective_date::text, c.summary, c.changes, c.created_at,
            e.id as employee_id, e.actor_id, e.name, e.email, e.employment_type, e.location, e.start_date::text, e.end_date::text,
            u.name as unit_name, a.position_title as title
       from lifecycle_case c join employee_record e on e.id = c.employee_id
       left join actor a on a.id = e.actor_id left join org_unit u on u.id = a.org_unit_id
      where c.tenant_id = $1 and ($2::text is null or c.status = $2) order by c.status <> 'open', c.effective_date nulls last, c.created_at desc limit 500`,
    [w.tenantId, opts.status ?? null]);
  if (!cases.length) return [];
  const { rows: tasks } = await pool.query<TaskRow>(
    `select t.id, t.case_id, t.key, t.title, t.details, t.correction_of, t.team, t.critical, t.prerequisites, t.wait_until::text, t.action, t.status, t.note, t.evidence_ref, t.completed_at,
            a.display_name as completed_by_name
       from lifecycle_task t left join actor a on a.id = t.completed_by where t.case_id = any($1::uuid[]) order by t.case_id, t.critical desc, t.key`,
    [cases.map((c) => c.id)]);
  const out = [];
  for (const c of cases) {
    const all = tasks.filter((t) => t.case_id === c.id);
    const mine: TaskRow[] = [];
    for (const t of all) if (await canDoTask(pool, w, t.team, c)) mine.push(t);
    const isEmployee = c.actor_id === w.actorId;
    if (!w.hr && !mine.length) continue;
    // The person a case is about does not see it when it is restricted, or
    // anything but their own tasks otherwise.
    const visible = w.hr ? all : c.restricted || isEmployee ? mine : all.filter((t) => mine.includes(t) || t.team !== 'employee');
    const shown = visible.map((t) => ({ ...t, mine: mine.includes(t), blockedBy: blockers(t, all) }));
    const done = all.filter((t) => t.status !== 'open').length;
    out.push({
      id: c.id, kind: !w.hr && c.restricted ? 'offboarding' : c.kind, status: c.status, restricted: w.hr ? c.restricted : undefined,
      effectiveDate: c.effective_date, summary: w.hr || !c.restricted ? c.summary : null, changes: w.hr ? c.changes : undefined,
      employee: { id: c.employee_id, name: c.name, email: c.email, employmentType: c.employment_type, location: c.location, startDate: c.start_date, endDate: c.end_date, unit: c.unit_name, title: c.title },
      progress: { done, total: all.length },
      readiness: w.hr || !c.restricted ? all.filter((t) => t.status === 'open' && (t.critical || blockers(t, all).length)).map((t) => ({ title: t.title, team: t.team, critical: t.critical, blockedBy: blockers(t, all) })) : [],
      tasks: shown,
    });
  }
  return out;
}

/** The pre-hire's (or anyone's) own tasks: what they need to do, nothing else. */
export async function myTasks(pool: Pool, principal: Principal) {
  const cases = await listCases(pool, principal, { status: 'open' });
  return cases.flatMap((c) => c.tasks.filter((t) => t.mine && t.status === 'open').map((t) => ({ ...t, caseId: c.id, kind: c.kind, employee: c.employee.name, effectiveDate: c.effectiveDate })));
}

/** Read-only history of the caller's own finished lifecycle tasks. */
export async function myTaskHistory(pool: Pool, principal: Principal) {
  const cases = await listCases(pool, principal);
  return cases.flatMap((c) => c.tasks.filter((t) => t.mine && t.status !== 'open').map((t) => ({ ...t, caseId: c.id, kind: c.kind, employee: c.employee.name, effectiveDate: c.effectiveDate })))
    .sort((a, b) => String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? '')));
}

/** HR may assign work or grant a correction while keeping completed records unchanged. */
export async function addOnboardingTask(pool: Pool, principal: Principal, caseId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  if (!UUID.test(caseId)) throw new InvalidInput('no such onboarding');
  const title = text(body.title, 200);
  if (title.length < 4) throw new InvalidInput('give the task a clear title');
  const details = text(body.details, 2000) || null;
  const correctionOf = body.correctionOf === undefined ? null : id(body.correctionOf, 'the task to correct');
  if (correctionOf && !details) throw new InvalidInput('say what needs correcting');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; status: string; kind: string; actor_id: string | null }>(
      `select c.id, c.status, c.kind, e.actor_id from lifecycle_case c join employee_record e on e.id = c.employee_id where c.id = $1 and c.tenant_id = $2 for update of c`,
      [caseId, w.tenantId]);
    const c = rows[0];
    if (!c || c.kind !== 'onboarding') throw new InvalidInput('no such onboarding');
    if (!['open', 'closed'].includes(c.status)) throw new InvalidInput('this onboarding cannot take new tasks');
    if (!c.actor_id) throw new InvalidInput('invite this person before assigning their tasks');
    if (correctionOf) {
      const { rows: previous } = await client.query<{ id: string }>(
        `select id from lifecycle_task where id = $1 and case_id = $2 and team = 'employee' and status = 'done'`,
        [correctionOf, caseId]);
      if (!previous[0]) throw new InvalidInput('choose a completed employee task from this onboarding');
    }
    const { rows: count } = await client.query<{ n: number }>('select count(*)::int as n from lifecycle_task where case_id = $1', [caseId]);
    if (count[0]!.n >= 60) throw new InvalidInput('this onboarding already has 60 tasks');
    const key = `employee_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const { rows: added } = await client.query<{ id: string }>(
      `insert into lifecycle_task (case_id, key, title, details, correction_of, team) values ($1, $2, $3, $4, $5, 'employee') returning id`,
      [caseId, key, title, details, correctionOf]);
    if (c.status === 'closed') await client.query(`update lifecycle_case set status = 'open', closed_at = null where id = $1`, [caseId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: correctionOf ? 'hr.onboarding_correction_requested' : 'hr.onboarding_task_added', targetId: added[0]!.id, detail: { caseId, title, details, correctionOf, reopened: c.status === 'closed' } });
    return { id: added[0]!.id, caseId, title, status: 'open' };
  });
}

async function revokeAccess(client: Client, w: Who, actorId: string) {
  await client.query('update actor set active = false where id = $1 and tenant_id = $2', [actorId, w.tenantId]);
  await client.query('update session set revoked_at = now() where actor_id = $1 and revoked_at is null', [actorId]);
  await client.query('update api_key set revoked_at = now() where actor_id = $1 and revoked_at is null', [actorId]);
  await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'member.deactivated', targetId: actorId, detail: { via: 'hr' } });
  // Access in other systems goes to revocation, tracked apart from this case (PRD OPS-05).
  await queueRevocations(client, w.tenantId, actorId, 'access revoked by HR');
}

/** Open cash advances and unpaid claims for a person; empty when Expenses is not used. */
async function financeOutstanding(client: Client, tenantId: string, email: string): Promise<string[]> {
  const out: string[] = [];
  const { rows: adv } = await client.query<{ reference: string; outstanding: string; currency: string }>(
    `select reference, outstanding, currency from cash_advance where tenant_id = $1 and lower(holder) = lower($2) and status in ('approved', 'disbursed', 'awaiting_return')`,
    [tenantId, email]);
  for (const a of adv) out.push(`advance ${a.reference}: ${a.currency} ${Number(a.outstanding).toFixed(2)} still held`);
  const { rows: set } = await client.query<{ n: number }>(
    `select count(*)::int as n from expense_settlement where tenant_id = $1 and lower(claimant) = lower($2) and status in ('awaiting_payment', 'failed')`,
    [tenantId, email]);
  if (set[0]!.n) out.push(`${set[0]!.n} approved claim(s) not yet paid`);
  return out;
}

/** Done by the team it belongs to, once nothing it waits for is open; actions run here. */
export async function completeTask(pool: Pool, principal: Principal, taskId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  if (!UUID.test(taskId)) throw new InvalidInput('no such task');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<TaskRow & { tenant_id: string; employee_actor: string | null; employee_email: string; employee_id: string; kind: string; case_status: string }>(
      `select t.*, t.wait_until::text, c.tenant_id, c.kind, c.status as case_status, e.actor_id as employee_actor, e.email as employee_email, e.id as employee_id
         from lifecycle_task t join lifecycle_case c on c.id = t.case_id join employee_record e on e.id = c.employee_id
        where t.id = $1 and c.tenant_id = $2 for update of t`, [taskId, w.tenantId]);
    const t = rows[0];
    if (!t) throw new InvalidInput('no such task');
    if (t.case_status !== 'open') throw new InvalidInput('this case is closed');
    if (t.status !== 'open') throw new InvalidInput('this task is already done');
    if (!(await canDoTask(client, w, t.team, { actor_id: t.employee_actor }))) throw new InvalidInput(`this is a task for ${t.team === 'manager' ? "the person's manager" : t.team === 'employee' ? 'the employee' : `the ${t.team.toUpperCase()} team`}`);
    const { rows: all } = await client.query<TaskRow>('select *, wait_until::text from lifecycle_task where case_id = $1', [t.case_id]);
    const blocked = blockers(t, all);
    if (blocked.length) throw new InvalidInput(`not yet: this task ${blocked.join(' and ')}`);
    if (t.action === 'finance_clearance') {
      const owed = await financeOutstanding(client, w.tenantId, t.employee_email);
      if (owed.length) throw new InvalidInput(`not cleared: ${owed.join('; ')}. Settle them on the Expenses page, or HR can record an exception`);
    }
    if (t.action === 'recover_assets' && t.employee_actor && (await enabledModules(client as unknown as Pool, w.tenantId)).has('assets')) {
      const held = await openCustody(client, w.tenantId, t.employee_actor);
      if (held.length) throw new InvalidInput(`still held: ${held.join(', ')}. Record each return on the Assets page first`);
    }
    if (t.action === 'activate_access' && t.employee_actor) {
      const { activationRole } = await hrSettings(client, w.tenantId);
      await client.query(`update actor set workspace_role = $2 where id = $1 and workspace_role = 'pre_hire'`, [t.employee_actor, activationRole]);
      await client.query(`update employee_record set status = 'active', updated_at = now() where id = $1`, [t.employee_id]);
      await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'member.role_changed', targetId: t.employee_actor, detail: { from: 'pre_hire', to: activationRole, via: 'onboarding' } });
    }
    if (t.action === 'revoke_access' && t.employee_actor) await revokeAccess(client, w, t.employee_actor);
    await client.query(`update lifecycle_task set status = 'done', note = $2, evidence_ref = $3, completed_by = $4, completed_at = now() where id = $1`,
      [t.id, text(body.note, 1000) || null, text(body.evidenceRef, 300) || null, w.actorId]);
    await closeIfFinished(client, t.case_id);
    return { id: t.id, status: 'done' };
  });
}

/** An owner or admin in HR may waive a non-critical task, with a reason. */
export async function exceptTask(pool: Pool, principal: Principal, taskId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHrAdmin(w);
  const reason = text(body.reason, 1000);
  if (!reason) throw new InvalidInput('record why this task is waived');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; case_id: string; critical: boolean; status: string; title: string }>(
      `select t.id, t.case_id, t.critical, t.status, t.title from lifecycle_task t join lifecycle_case c on c.id = t.case_id where t.id = $1 and c.tenant_id = $2 for update of t`, [taskId, w.tenantId]);
    const t = rows[0];
    if (!t) throw new InvalidInput('no such task');
    if (t.status !== 'open') throw new InvalidInput('this task is already done');
    if (t.critical) throw new InvalidInput(`"${t.title}" is critical and cannot be waived`);
    await client.query(`update lifecycle_task set status = 'excepted', note = $2, completed_by = $3, completed_at = now() where id = $1`, [t.id, `Exception: ${reason}`, w.actorId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.task_excepted', targetId: t.id, detail: { title: t.title, reason } });
    await closeIfFinished(client, t.case_id);
    return { id: t.id, status: 'excepted' };
  });
}

async function closeIfFinished(client: Client, caseId: string) {
  const { rows } = await client.query<{ open: number }>(`select count(*)::int as open from lifecycle_task where case_id = $1 and status = 'open'`, [caseId]);
  if (rows[0]!.open) return;
  const { rows: c } = await client.query<{ kind: string; employee_id: string }>(`update lifecycle_case set status = 'closed', closed_at = now() where id = $1 and status = 'open' returning kind, employee_id`, [caseId]);
  if (c[0] && ['offboarding', 'urgent_termination'].includes(c[0].kind)) await client.query(`update employee_record set status = 'left', updated_at = now() where id = $1`, [c[0].employee_id]);
}

// ------------------------------------------------------------------- notes

export async function addCaseNote(pool: Pool, principal: Principal, caseId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const text_ = text(body.body, 4000);
  if (!text_) throw new InvalidInput('the note is empty');
  const category = text(body.category, 20) || 'general';
  if (!['general', 'health', 'disciplinary', 'compensation'].includes(category)) throw new InvalidInput('category must be general, health, disciplinary or compensation');
  const shared = body.shared === true;
  if (shared && category !== 'general') throw new InvalidInput('health, disciplinary and pay notes are never shared outside HR');
  const { rows } = await pool.query('select 1 from lifecycle_case where id = $1 and tenant_id = $2', [caseId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such case');
  await pool.query('insert into case_note (case_id, category, shared, body, author_id) values ($1, $2, $3, $4, $5)', [caseId, category, shared, text_, w.actorId]);
  return { ok: true };
}

export async function listCaseNotes(pool: Pool, principal: Principal, caseId: string) {
  const w = await who(pool, principal);
  const visible = await listCases(pool, principal);
  const c = visible.find((x) => x.id === caseId);
  if (!c) throw new InvalidInput('no such case');
  const { rows } = await pool.query(
    `select n.id, n.category, n.shared, n.body, n.created_at, a.display_name as author from case_note n left join actor a on a.id = n.author_id
      where n.case_id = $1 and ($2 or (n.shared and n.category = 'general')) order by n.id`, [caseId, w.hr]);
  return rows;
}

// ------------------------------------------------------------------- leave

const DEFAULT_LEAVE = [
  { key: 'annual', name: 'Annual leave', days: 20, unlimited: false },
  { key: 'sick', name: 'Sick leave', days: 10, unlimited: false },
  { key: 'unpaid', name: 'Unpaid leave', days: 0, unlimited: true },
];
export async function ensureLeaveTypes(client: Client | Pool, tenantId: string) {
  for (const t of DEFAULT_LEAVE) {
    await client.query('insert into leave_type (tenant_id, key, name, annual_days, unlimited) values ($1, $2, $3, $4, $5) on conflict (tenant_id, key) do nothing', [tenantId, t.key, t.name, t.days, t.unlimited]);
  }
}

export async function listLeaveTypes(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  await ensureLeaveTypes(pool, w.tenantId);
  const { rows } = await pool.query('select t.id, t.key, t.name, t.annual_days, t.unlimited, t.active, t.accrual_mode, t.carry_over_max, t.prorate_first_year, t.branch_id, b.name as branch_name from leave_type t left join hr_branch b on b.id = t.branch_id where t.tenant_id = $1 order by t.name', [w.tenantId]);
  return rows;
}

export async function saveLeaveType(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHrAdmin(w);
  const key = text(body.key, 30).toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new InvalidInput('key must be lowercase letters, digits or underscores');
  const name = text(body.name, 80);
  if (!name) throw new InvalidInput('give the leave type a name');
  const days = num(body.annualDays ?? 0);
  if (!(days >= 0 && days <= 366)) throw new InvalidInput('annualDays must be 0 to 366');
  const accrual = body.accrualMode === 'monthly' ? 'monthly' : 'upfront';
  const branchId = body.branchId ? id(body.branchId, 'branchId') : null;
  if (branchId) { const { rows: b } = await pool.query('select 1 from hr_branch where id = $1 and tenant_id = $2', [branchId, w.tenantId]); if (!b[0]) throw new InvalidInput('no such branch'); }
  const carry = num(body.carryOverMax ?? 0);
  if (!(carry >= 0 && carry <= 366)) throw new InvalidInput('carryOverMax must be 0 to 366');
  await pool.query(
    `insert into leave_type (tenant_id, key, name, annual_days, unlimited, active, accrual_mode, carry_over_max, prorate_first_year, branch_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (tenant_id, key) do update set name = excluded.name, annual_days = excluded.annual_days, unlimited = excluded.unlimited, active = excluded.active,
       accrual_mode = excluded.accrual_mode, carry_over_max = excluded.carry_over_max, prorate_first_year = excluded.prorate_first_year, branch_id = excluded.branch_id`,
    [w.tenantId, key, name, days, body.unlimited === true, body.active !== false, accrual, carry, body.prorateFirstYear === true, branchId]);
  return { key };
}

export async function listHolidays(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query(`select h.day::text, h.name, h.branch_id, b.name as branch_name from public_holiday h left join hr_branch b on b.id = h.branch_id where h.tenant_id = $1 and h.day >= current_date - 30 order by h.day`, [w.tenantId]);
  return rows;
}

export async function saveHoliday(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const d = day(body.day, 'day', true)!;
  const branchId = body.branchId ? id(body.branchId, 'branchId') : null;
  if (body.remove === true) { await pool.query('delete from public_holiday where tenant_id = $1 and day = $2 and branch_id is not distinct from $3', [w.tenantId, d, branchId]); return { day: d, removed: true }; }
  const name = text(body.name, 80);
  if (!name) throw new InvalidInput('name the holiday');
  if (branchId) { const { rows: b } = await pool.query('select 1 from hr_branch where id = $1 and tenant_id = $2', [branchId, w.tenantId]); if (!b[0]) throw new InvalidInput('no such branch'); }
  await pool.query(`insert into public_holiday (tenant_id, day, name, branch_id) values ($1, $2, $3, $4)
    on conflict (tenant_id, day, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update set name = excluded.name`, [w.tenantId, d, name, branchId]);
  return { day: d, name, branchId };
}

/** Working days in a range: weekdays that are not public holidays. */
export async function workingDays(client: Client | Pool, tenantId: string, start: string, end: string, branchId: string | null = null): Promise<number> {
  const { rows } = await client.query<{ day: string }>(
    'select day::text from public_holiday where tenant_id = $1 and day between $2 and $3 and (branch_id is null or branch_id = $4)', [tenantId, start, end, branchId]);
  const holidays = new Set(rows.map((r) => r.day));
  let week = (await hrSettings(client, tenantId)).workingDays;
  if (branchId) {
    const { rows: b } = await client.query<{ working_days: number[] }>('select working_days from hr_branch where id = $1', [branchId]);
    if (b[0]) week = b[0].working_days;
  }
  let n = 0;
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    if (week.includes(iso) && !holidays.has(d.toISOString().slice(0, 10))) n++;
  }
  return n;
}

export interface Balance { typeId: string; key: string; name: string; unlimited: boolean; accrualMode: 'upfront' | 'monthly'; entitled: number; accrued: number; carriedOver: number; adjusted: number; taken: number; pending: number; left: number | null }

const half = (n: number) => Math.round(n * 2) / 2;

/**
 * One year's balance per leave type. The entitlement is the year's days
 * (explicit, or the type's default), prorated for a first year when the type
 * says so; a monthly type releases it a twelfth at a time; carry-over brings
 * in last year's unused days up to the cap; adjustments are HR's manual
 * corrections with a reason. What is left is what can still be asked for.
 */
export async function balances(client: Client | Pool, tenantId: string, employeeId: string, year: number, at: Date = new Date()): Promise<Balance[]> {
  await ensureLeaveTypes(client, tenantId);
  const { rows: emp } = await client.query<{ start_date: string | null; branch_id: string | null }>('select start_date::text, branch_id from employee_record where id = $1', [employeeId]);
  const branchId = emp[0]?.branch_id ?? null;
  const started = emp[0]?.start_date ?? null;
  const startYear = started ? Number(started.slice(0, 4)) : null;
  const startMonth = started ? Number(started.slice(5, 7)) : 1;
  const { rows } = await client.query<{ id: string; key: string; name: string; annual_days: string; unlimited: boolean; accrual_mode: 'upfront' | 'monthly'; carry_over_max: string; prorate_first_year: boolean; entitled: string | null; prev_entitled: string | null; taken: string; pending: string; prev_taken: string; adjusted: string; prev_adjusted: string }>(
    `select t.id, t.key, t.name, t.annual_days, t.unlimited, t.accrual_mode, t.carry_over_max, t.prorate_first_year,
            (select days from leave_entitlement x where x.employee_id = $2 and x.leave_type_id = t.id and x.year = $3) as entitled,
            (select days from leave_entitlement x where x.employee_id = $2 and x.leave_type_id = t.id and x.year = $3 - 1) as prev_entitled,
            coalesce((select sum(days) from leave_request r where r.employee_id = $2 and r.leave_type_id = t.id and r.status = 'approved' and extract(year from r.start_date) = $3), 0) as taken,
            coalesce((select sum(days) from leave_request r where r.employee_id = $2 and r.leave_type_id = t.id and r.status = 'requested' and extract(year from r.start_date) = $3), 0) as pending,
            coalesce((select sum(days) from leave_request r where r.employee_id = $2 and r.leave_type_id = t.id and r.status = 'approved' and extract(year from r.start_date) = $3 - 1), 0) as prev_taken,
            coalesce((select sum(days) from leave_adjustment j where j.employee_id = $2 and j.leave_type_id = t.id and j.year = $3), 0) as adjusted,
            coalesce((select sum(days) from leave_adjustment j where j.employee_id = $2 and j.leave_type_id = t.id and j.year = $3 - 1), 0) as prev_adjusted
       from leave_type t where t.tenant_id = $1 and t.active and (t.branch_id is null or t.branch_id = $4) order by t.name`, [tenantId, employeeId, year, branchId]);
  const nowYear = at.getUTCFullYear(); const nowMonth = at.getUTCMonth() + 1;
  return rows.map((r) => {
    const base = (y: number, explicit: string | null) => {
      let days = explicit === null ? Number(r.annual_days) : Number(explicit);
      if (r.prorate_first_year && startYear === y && explicit === null) days = half(days * (13 - startMonth) / 12);
      return days;
    };
    const entitled = base(year, r.entitled);
    // Monthly accrual: the share of the year's months that have begun, counted from the start month in a first year.
    let accrued = entitled;
    if (r.accrual_mode === 'monthly') {
      const firstMonth = startYear === year ? startMonth : 1;
      const monthsInYear = 13 - firstMonth;
      const monthsSoFar = year < nowYear ? monthsInYear : year > nowYear ? 0 : Math.max(0, nowMonth - firstMonth + 1);
      accrued = half(entitled * Math.min(monthsSoFar, monthsInYear) / monthsInYear);
    }
    let carriedOver = 0;
    const cap = Number(r.carry_over_max);
    if (cap > 0 && !r.unlimited && (startYear === null || startYear < year)) {
      const prevLeft = base(year - 1, r.prev_entitled) + Number(r.prev_adjusted) - Number(r.prev_taken);
      carriedOver = Math.min(cap, Math.max(0, prevLeft));
    }
    const adjusted = Number(r.adjusted); const taken = Number(r.taken); const pending = Number(r.pending);
    const left = r.unlimited ? null : accrued + carriedOver + adjusted - taken - pending;
    return { typeId: r.id, key: r.key, name: r.name, unlimited: r.unlimited, accrualMode: r.accrual_mode, entitled, accrued, carriedOver, adjusted, taken, pending, left };
  });
}

export async function myLeave(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  if (w.role === 'pre_hire') throw new InvalidInput('leave starts after your first day');
  const employeeId = await recordForActor(pool, w.tenantId, w.actorId);
  const year = new Date().getUTCFullYear();
  const { rows } = await pool.query(
    `select r.id, t.name as type, r.start_date::text, r.end_date::text, r.days, r.status, r.reason, r.decision_note, a.display_name as approver
       from leave_request r join leave_type t on t.id = r.leave_type_id left join actor a on a.id = coalesce(r.decided_by, r.approver_id)
      where r.employee_id = $1 order by r.start_date desc limit 100`, [employeeId]);
  const owner = (await hrSettings(pool, w.tenantId)).fieldOwners.leave_balance;
  return { year, balances: await balances(pool, w.tenantId, employeeId, year), requests: rows, balanceOwner: owner };
}

/**
 * HR-05. Working days only; no overlap with your own leave; within your
 * balance unless the type is unlimited or another system owns balances (then
 * it is the manager's call and the balance is shown as advisory). Goes to
 * your manager from the directory, or to HR if you have none.
 */
export async function requestLeave(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  if (w.role === 'pre_hire') throw new InvalidInput('leave starts after your first day');
  const start = day(body.startDate, 'startDate', true)!;
  const end = day(body.endDate, 'endDate', true)!;
  if (end < start) throw new InvalidInput('the end date is before the start date');
  const typeKey = text(body.type, 30);
  return inTransaction(pool, async (client) => {
    const employeeId = await recordForActor(client, w.tenantId, w.actorId);
    await client.query('select id from employee_record where id = $1 for update', [employeeId]);
    await ensureLeaveTypes(client, w.tenantId);
    const { rows: br } = await client.query<{ branch_id: string | null }>('select branch_id from employee_record where id = $1', [employeeId]);
    const branchId = br[0]?.branch_id ?? null;
    const { rows: t } = await client.query<{ id: string; name: string; unlimited: boolean }>(
      'select id, name, unlimited from leave_type where tenant_id = $1 and key = $2 and active and (branch_id is null or branch_id = $3) order by branch_id nulls last limit 1', [w.tenantId, typeKey, branchId]);
    if (!t[0]) throw new InvalidInput('choose a leave type');
    const days = await workingDays(client, w.tenantId, start, end, branchId);
    if (!days) throw new InvalidInput('those dates are all weekends or public holidays');
    const { rows: clash } = await client.query<{ start_date: string; end_date: string }>(
      `select start_date::text, end_date::text from leave_request where employee_id = $1 and status in ('requested', 'approved') and start_date <= $3 and end_date >= $2 limit 1`, [employeeId, start, end]);
    if (clash[0]) throw new InvalidInput(`you already have leave from ${clash[0].start_date} to ${clash[0].end_date}`);
    const owner = (await hrSettings(client, w.tenantId)).fieldOwners.leave_balance;
    if (!t[0].unlimited && owner === 'patform') {
      const b = (await balances(client, w.tenantId, employeeId, Number(start.slice(0, 4)))).find((x) => x.typeId === t[0]!.id)!;
      if (days > (b.left ?? 0)) throw new InvalidInput(`${t[0].name}: you have ${b.left} day(s) left this year and asked for ${days}`);
    }
    const approver = await currentManager(client, w.tenantId, w.actorId);
    const { rows } = await client.query<{ id: string }>(
      `insert into leave_request (tenant_id, employee_id, leave_type_id, start_date, end_date, days, reason, approver_id) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [w.tenantId, employeeId, t[0].id, start, end, days, text(body.reason, 500) || null, approver]);
    return { id: rows[0]!.id, days, approver: approver ? 'your manager' : 'HR' };
  });
}

/** Requests waiting for me, with who else in the same unit is away then. */
export async function leaveToApprove(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query<{ id: string; employee_name: string; actor_id: string | null; type: string; start_date: string; end_date: string; days: string; reason: string | null; created_at: Date }>(
    `select r.id, e.name as employee_name, e.actor_id, t.name as type, r.start_date::text, r.end_date::text, r.days, r.reason, r.created_at
       from leave_request r join employee_record e on e.id = r.employee_id join leave_type t on t.id = r.leave_type_id
      where r.tenant_id = $1 and r.status = 'requested' and (r.approver_id = $2 or (r.approver_id is null and $3)) and e.actor_id is distinct from $2
      order by r.start_date`, [w.tenantId, w.actorId, w.hr]);
  const out = [];
  for (const r of rows) {
    const { rows: overlap } = await pool.query<{ name: string; start_date: string; end_date: string }>(
      `select e.name, r.start_date::text, r.end_date::text from leave_request r join employee_record e on e.id = r.employee_id
         join actor a on a.id = e.actor_id
        where r.tenant_id = $1 and r.status in ('approved', 'requested') and r.id <> $2 and r.start_date <= $4 and r.end_date >= $3
          and a.org_unit_id is not null and a.org_unit_id = (select org_unit_id from actor where id = $5)`,
      [w.tenantId, r.id, r.start_date, r.end_date, r.actor_id]);
    out.push({ ...r, days: Number(r.days), sameUnitAway: overlap });
  }
  return out;
}

export async function decideLeave(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const decision = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : null;
  if (!decision) throw new InvalidInput('decide approve or reject');
  const note = text(body.note, 500) || null;
  if (decision === 'rejected' && !note) throw new InvalidInput('say why');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; approver_id: string | null; actor_id: string | null }>(
      `select r.status, r.approver_id, e.actor_id from leave_request r join employee_record e on e.id = r.employee_id where r.id = $1 and r.tenant_id = $2 for update of r`, [requestId, w.tenantId]);
    const r = rows[0];
    if (!r) throw new InvalidInput('no such request');
    if (r.status !== 'requested') throw new InvalidInput('this request is already decided');
    if (r.actor_id === w.actorId) throw new InvalidInput('you cannot decide your own leave');
    if (!(r.approver_id === w.actorId || w.hr)) throw new InvalidInput("only the person's manager or HR can decide this");
    await client.query('update leave_request set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1', [requestId, decision, w.actorId, note]);
    return { id: requestId, status: decision };
  });
}

/** Your own leave before it starts; HR at any time. */
export async function cancelLeave(pool: Pool, principal: Principal, requestId: string) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; start_date: string; actor_id: string | null }>(
      `select r.status, r.start_date::text, e.actor_id from leave_request r join employee_record e on e.id = r.employee_id where r.id = $1 and r.tenant_id = $2 for update of r`, [requestId, w.tenantId]);
    const r = rows[0];
    if (!r) throw new InvalidInput('no such request');
    if (!['requested', 'approved'].includes(r.status)) throw new InvalidInput('this request is not active');
    const own = r.actor_id === w.actorId;
    if (!own && !w.hr) throw new InvalidInput('only the person themselves or HR can cancel leave');
    if (own && !w.hr && r.start_date <= today()) throw new InvalidInput('leave that has started can only be cancelled by HR');
    await client.query(`update leave_request set status = 'cancelled', decided_by = $2, decided_at = now() where id = $1`, [requestId, w.actorId]);
    return { id: requestId, status: 'cancelled' };
  });
}

export async function setEntitlement(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const employeeId = id(body.employeeId, 'employeeId');
  const typeKey = text(body.type, 30);
  const year = Math.trunc(num(body.year));
  const days = num(body.days);
  if (!(year >= 2000 && year <= 2100)) throw new InvalidInput('give the year');
  if (!(days >= 0 && days <= 366)) throw new InvalidInput('days must be 0 to 366');
  return inTransaction(pool, async (client) => {
    const e = await employeeFor(client, w.tenantId, employeeId);
    const { rows: t } = await client.query<{ id: string }>('select id from leave_type where tenant_id = $1 and key = $2', [w.tenantId, typeKey]);
    if (!t[0]) throw new InvalidInput('no such leave type');
    if (await ownedElsewhere(client, w, e.id, 'leave_balance', null, `${typeKey} ${year}: ${days}`)) return { queuedForReconciliation: true };
    await client.query(`insert into leave_entitlement (tenant_id, employee_id, leave_type_id, year, days) values ($1, $2, $3, $4, $5)
      on conflict (employee_id, leave_type_id, year) do update set days = excluded.days`, [w.tenantId, e.id, t[0].id, year, days]);
    return { queuedForReconciliation: false };
  });
}

// --------------------------------------------------------------- documents

export async function createDocument(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const title = text(body.title, 200); const version = text(body.version, 40);
  if (!title || !version) throw new InvalidInput('give the title and version');
  const kind = body.kind === 'agreement' ? 'agreement' : 'receipt';
  const { rows } = await pool.query<{ id: string }>(
    `insert into hr_document (tenant_id, title, version, kind, document_ref, created_by) values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, title, version) do nothing returning id`, [w.tenantId, title, version, kind, text(body.documentRef, 300) || null, w.actorId]);
  if (!rows[0]) throw new InvalidInput(`${title} version ${version} already exists; give the new version a new number`);
  return { id: rows[0].id };
}

export async function sendDocument(pool: Pool, principal: Principal, documentId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const due = day(body.dueDate, 'dueDate');
  const ids = body.employeeIds === 'all' ? null : Array.isArray(body.employeeIds) ? body.employeeIds.map((x) => id(x, 'employeeId')) : [];
  if (ids && !ids.length) throw new InvalidInput('choose who it goes to');
  const { rows: doc } = await pool.query('select 1 from hr_document where id = $1 and tenant_id = $2', [documentId, w.tenantId]);
  if (!doc[0]) throw new InvalidInput('no such document');
  const { rowCount } = await pool.query(
    `insert into document_request (tenant_id, document_id, employee_id, due_date)
     select $1, $2, e.id, $3 from employee_record e where e.tenant_id = $1 and e.status in ('pre_hire', 'active') and ($4::uuid[] is null or e.id = any($4::uuid[]))
     on conflict (document_id, employee_id) do nothing`, [w.tenantId, documentId, due, ids]);
  return { sent: rowCount ?? 0 };
}

export async function listDocuments(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireHr(w);
  const { rows } = await pool.query(
    `select d.id, d.title, d.version, d.kind, d.document_ref, d.created_at, d.filename, d.byte_size, d.scan_status,
            count(r.*)::int as sent, count(r.*) filter (where r.status = 'acknowledged')::int as acknowledged,
            count(r.*) filter (where r.status = 'sent' and r.due_date < current_date)::int as overdue
       from hr_document d left join document_request r on r.document_id = d.id where d.tenant_id = $1 group by d.id order by d.created_at desc`, [w.tenantId]);
  return rows;
}

export async function myDocuments(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const employeeId = await recordForActor(pool, w.tenantId, w.actorId);
  const { rows } = await pool.query(
    `select r.id, d.id as document_id, d.title, d.version, d.kind, d.document_ref, (d.storage_key is not null) as has_file, r.due_date::text, r.status, r.statement, r.acknowledged_at
       from document_request r join hr_document d on d.id = r.document_id where r.employee_id = $1 order by r.status = 'sent' desc, r.created_at desc`, [employeeId]);
  return rows;
}

/** HR-07: the words recorded say exactly what happened: received, or agreed. */
export async function acknowledgeDocument(pool: Pool, principal: Principal, requestId: string) {
  const w = await who(pool, principal);
  const employeeId = await recordForActor(pool, w.tenantId, w.actorId);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; title: string; version: string; kind: string }>(
      `select r.status, d.title, d.version, d.kind from document_request r join hr_document d on d.id = r.document_id where r.id = $1 and r.employee_id = $2 for update of r`, [requestId, employeeId]);
    const r = rows[0];
    if (!r) throw new InvalidInput('no such document for you');
    if (r.status !== 'sent') throw new InvalidInput('already done');
    const statement = r.kind === 'agreement' ? `I agree to ${r.title}, version ${r.version}.` : `I confirm I have received ${r.title}, version ${r.version}.`;
    await client.query(`update document_request set status = 'acknowledged', statement = $2, acknowledged_at = now() where id = $1`, [requestId, statement]);
    return { id: requestId, statement };
  });
}

// ------------------------------------------------------- reconciliation

export async function listReconciliations(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireHr(w);
  const { rows } = await pool.query(
    `select r.id, r.field, r.owner, r.current_value, r.proposed_value, r.status, r.note, r.created_at, e.name as employee_name, a.display_name as raised_by
       from hr_reconciliation r join employee_record e on e.id = r.employee_id left join actor a on a.id = r.raised_by
      where r.tenant_id = $1 order by r.status <> 'open', r.created_at desc limit 200`, [w.tenantId]);
  return rows;
}

/** Closed once the source system has been updated (or the change dropped). */
export async function resolveReconciliation(pool: Pool, principal: Principal, recId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const status = body.outcome === 'applied' ? 'applied' : body.outcome === 'dismissed' ? 'dismissed' : null;
  if (!status) throw new InvalidInput('outcome must be applied (updated in the source system) or dismissed');
  const { rowCount } = await pool.query(
    `update hr_reconciliation set status = $3, note = $4, resolved_by = $5, resolved_at = now() where id = $1 and tenant_id = $2 and status = 'open'`,
    [recId, w.tenantId, status, text(body.note, 500) || null, w.actorId]);
  if (!rowCount) throw new InvalidInput('no such open item');
  return { id: recId, status };
}

// ------------------------------------------------------- upcoming, hiring

/** HR-11: probation ends, anniversaries, certification renewals, starts and leavers. */
export async function upcoming(pool: Pool, principal: Principal, daysAhead = 60) {
  const w = await who(pool, principal); requireHr(w);
  const { anniversaryNoticeDays } = await hrSettings(pool, w.tenantId);
  const span = Math.min(Math.max(daysAhead, 7), 365);
  const { rows } = await pool.query<{ kind: string; name: string; on: string; detail: string | null }>(
    `select 'probation_end' as kind, name, probation_end::text as on, null as detail from employee_record
       where tenant_id = $1 and status in ('pre_hire', 'active') and probation_end between current_date and current_date + $2::int
     union all
     select 'start', name, start_date::text, employment_type from employee_record where tenant_id = $1 and status = 'pre_hire' and start_date between current_date and current_date + $2::int
     union all
     select 'leaving', name, end_date::text, null from employee_record where tenant_id = $1 and status = 'leaving' and end_date between current_date and current_date + $2::int
     union all
     select 'certification', e.name, c.expires_on::text, c.name from employee_certification c join employee_record e on e.id = c.employee_id
       where c.tenant_id = $1 and e.status = 'active' and c.expires_on <= current_date + $2::int
     union all
     select 'anniversary', name, (make_date(extract(year from current_date)::int, extract(month from start_date)::int, least(extract(day from start_date)::int, 28)))::text,
            (extract(year from current_date)::int - extract(year from start_date)::int)::text || ' years'
       from employee_record where tenant_id = $1 and status = 'active' and start_date is not null
         and extract(year from start_date) < extract(year from current_date)
         and make_date(extract(year from current_date)::int, extract(month from start_date)::int, least(extract(day from start_date)::int, 28)) between current_date and current_date + $3::int
     order by 3`, [w.tenantId, span, anniversaryNoticeDays]);
  return rows;
}

export async function listHiring(pool: Pool, principal: Principal) {
  const w = await who(pool, principal); requireHr(w);
  const { rows } = await pool.query(
    `select h.id, h.instance_id, h.reference, h.position, h.headcount, h.filled, h.cost_centre, h.amount, h.status, h.created_at
       from hiring_requisition h where h.tenant_id = $1 order by h.status = 'open' desc, h.created_at desc`, [w.tenantId]);
  return rows;
}

export async function hrSummary(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const mine = await myTasks(pool, principal);
  const toApprove = (await leaveToApprove(pool, principal)).length;
  if (!w.hr) return { hr: false, myTasks: mine.length, leaveToApprove: toApprove, teams: [...w.teams], role: w.role };
  const { rows } = await pool.query<Record<string, string>>(
    `select
       (select count(*) from lifecycle_case where tenant_id = $1 and status = 'open' and kind = 'onboarding') as onboarding,
       (select count(*) from lifecycle_case where tenant_id = $1 and status = 'open' and kind in ('offboarding', 'urgent_termination')) as offboarding,
       (select count(*) from lifecycle_case where tenant_id = $1 and status = 'open' and kind in ('transfer', 'probation')) as changes,
       (select count(*) from hr_reconciliation where tenant_id = $1 and status = 'open') as reconciliation,
       (select count(*) from hiring_requisition where tenant_id = $1 and status = 'open') as hiring`, [w.tenantId]);
  const r = rows[0]!;
  return { hr: true, admin: w.admin, role: w.role, teams: [...w.teams], myTasks: mine.length, leaveToApprove: toApprove,
    onboarding: Number(r.onboarding), offboarding: Number(r.offboarding), changes: Number(r.changes), reconciliation: Number(r.reconciliation), hiring: Number(r.hiring) };
}
