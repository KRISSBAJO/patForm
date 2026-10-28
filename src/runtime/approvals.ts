/**
 * Approval policies: the configurable approval layer every module shares.
 *
 * A policy belongs to a workspace and a process (optionally one branch of
 * the company) and is an ordered list of steps. Each step says who is
 * responsible (the submitter's manager, their manager's manager, a process
 * role, an HR team, a named person, the owner of the cost centre, or an
 * address on the form), when it applies (an amount band in the workspace
 * currency, categories, cost centres, branches), how it is settled (any one,
 * all of them, a quorum), what evidence the approver must attach (a note or
 * a file), the clock (remind after so many hours, escalate after so many to
 * somebody else), and what a rejection does (end the record, or send it
 * back to the person who asked).
 *
 * The one engine consults it: an approval a process marks `policy: true`
 * runs this chain inside its state. Each step is an ordinary approval
 * request, so everything that already works for approvals keeps working:
 * authority grants, delegations, separation of duties, the queue, the
 * record's history. When the last step passes, the process sees
 * `approval_decided` as if one approver had said yes.
 *
 * Templates are starting points an administrator adopts and then edits.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Blueprint } from '../blueprint/index.js';
import type { Approval } from '../blueprint/workflow.js';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { managerOf } from './org.js';
import { alternateFor, holdingsAt, resolveCommittee, resolveOffice, unitOfActor } from './structure.js';
import { expenseSettings } from './expenses.js';
import { procurementSettings } from './procurement.js';
import { objectStore } from './object-store.js';
import { sendPlatformMail, type PlatformMailKind } from './platform-mail.js';
import { appendEvent, resolveParty, submitterActor, submitterOf, type InstanceRow } from './engine.js';

const UUID = /^[0-9a-f-]{36}$/;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[, ]/g, '')); return Number.isFinite(n) ? n : NaN; };

// ------------------------------------------------------------------- model

export type Responsible =
  /** `fallback` is the process role that takes it when the submitter has no manager on file. */
  | { kind: 'manager'; fallback?: string }
  | { kind: 'skip_manager'; fallback?: string }
  | { kind: 'role'; role: string }
  | { kind: 'team'; team: 'hr' | 'it' | 'facilities' | 'finance' }
  | { kind: 'person'; email: string }
  | { kind: 'cost_centre_owner'; field?: string }
  | { kind: 'field'; field: string }
  | { kind: 'fallback' }
  /** The holder of an office, found up the tree from the requester's unit (for a church: their station). */
  | { kind: 'office'; office: string }
  /** The voting members of a committee, the one with this key nearest the requester (their station's CMC). */
  | { kind: 'committee'; committee: string };

export interface StepApplies { amountField?: string; minAmount?: number | null; maxAmount?: number | null; categoryField?: string; categories?: string[]; costCentreField?: string; costCentres?: string[]; branches?: string[] }
export interface StepSla { remindAfterHours?: number | null; escalateAfterHours?: number | null; escalateTo?: Responsible[]; escalateMode?: 'add' | 'replace' }
export interface Step {
  key: string; name: string; responsible: Responsible[]; mode: 'any' | 'all' | 'quorum'; required?: number;
  applies?: StepApplies; evidence: 'none' | 'note' | 'file'; notTheSubmitter: boolean; sla?: StepSla; onReject: 'end' | 'return';
  /** What the approver is told to check. */
  guidance?: string;
  /**
   * When the person this step reaches already approved an earlier step (one
   * person, two offices): `once` counts that approval and moves on;
   * `independent` needs someone else, an alternate or the level above.
   */
  sameApprover?: 'once' | 'independent';
}
export interface Policy { id: string; tenant_id: string; process_key: string; name: string; description: string | null; branch_id: string | null; steps: Step[]; cost_centre_owners: Record<string, string>; template_key: string | null; active: boolean; version: number }

const RESPONSIBLE_KINDS = ['manager', 'skip_manager', 'role', 'team', 'person', 'cost_centre_owner', 'field', 'fallback', 'office', 'committee'];
const TEAMS = ['hr', 'it', 'facilities', 'finance'];

function checkResponsible(raw: unknown, where: string): Responsible {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = text(r.kind, 20);
  if (!RESPONSIBLE_KINDS.includes(kind)) throw new InvalidInput(`${where}: responsible must be one of ${RESPONSIBLE_KINDS.join(', ')}`);
  if (kind === 'role') { const role = text(r.role, 60); if (!/^[a-z][a-z0-9_]*$/.test(role)) throw new InvalidInput(`${where}: name the role`); return { kind, role }; }
  if (kind === 'team') { const team = text(r.team, 20); if (!TEAMS.includes(team)) throw new InvalidInput(`${where}: team must be hr, it, facilities or finance`); return { kind, team: team as 'hr' }; }
  if (kind === 'person') { const email = text(r.email, 254).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new InvalidInput(`${where}: give the person's email`); return { kind, email }; }
  if (kind === 'field') { const field = text(r.field, 60); if (!field) throw new InvalidInput(`${where}: name the form field`); return { kind, field }; }
  if (kind === 'cost_centre_owner') return { kind, ...(text(r.field, 60) ? { field: text(r.field, 60) } : {}) };
  if (kind === 'office') { const office = text(r.office, 40); if (!/^[a-z][a-z0-9_]*$/.test(office)) throw new InvalidInput(`${where}: choose the office`); return { kind, office }; }
  if (kind === 'committee') { const committee = text(r.committee, 40); if (!/^[a-z][a-z0-9_]*$/.test(committee)) throw new InvalidInput(`${where}: name the committee`); return { kind, committee }; }
  if (kind === 'manager' || kind === 'skip_manager') { const fallback = text(r.fallback, 60); if (fallback && !/^[a-z][a-z0-9_]*$/.test(fallback)) throw new InvalidInput(`${where}: the fallback must be a process role`); return fallback ? { kind, fallback } : { kind }; }
  return { kind } as Responsible;
}

function hours(v: unknown, what: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = num(v);
  if (!(n > 0 && n <= 24 * 365)) throw new InvalidInput(`${what} must be a number of hours`);
  return n;
}

export function checkSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 12) throw new InvalidInput('a policy has 1 to 12 steps');
  const keys = new Set<string>();
  return raw.map((s, i) => {
    const r = (s ?? {}) as Record<string, unknown>;
    const where = `step ${i + 1}`;
    const name = text(r.name, 120);
    if (!name) throw new InvalidInput(`${where}: give it a name`);
    const key = (text(r.key, 40) || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `step_${i + 1}`;
    if (keys.has(key)) throw new InvalidInput(`${where}: two steps share the key ${key}`); keys.add(key);
    const responsible = Array.isArray(r.responsible) ? r.responsible.map((x, j) => checkResponsible(x, `${where}, responsible ${j + 1}`)) : [];
    if (!responsible.length) throw new InvalidInput(`${where}: say who is responsible`);
    const mode = text(r.mode, 10) || 'any';
    if (!['any', 'all', 'quorum'].includes(mode)) throw new InvalidInput(`${where}: mode must be any, all or quorum`);
    const required = mode === 'quorum' ? Math.trunc(num(r.required)) : undefined;
    if (mode === 'quorum' && !(required! >= 2 && required! <= 20)) throw new InvalidInput(`${where}: a quorum needs 2 to 20 approvals`);
    const a = (r.applies ?? {}) as Record<string, unknown>;
    const applies: StepApplies = {};
    if (text(a.amountField, 60)) applies.amountField = text(a.amountField, 60);
    for (const k of ['minAmount', 'maxAmount'] as const) { if (a[k] !== undefined && a[k] !== null && a[k] !== '') { const n = num(a[k]); if (!(n >= 0)) throw new InvalidInput(`${where}: ${k} must be a number`); applies[k] = n; } }
    if (typeof applies.minAmount === 'number' && typeof applies.maxAmount === 'number' && applies.maxAmount < applies.minAmount) throw new InvalidInput(`${where}: maxAmount is below minAmount`);
    if (text(a.categoryField, 60)) applies.categoryField = text(a.categoryField, 60);
    if (Array.isArray(a.categories) && a.categories.length) applies.categories = a.categories.map((c) => text(c, 60)).filter(Boolean);
    if (text(a.costCentreField, 60)) applies.costCentreField = text(a.costCentreField, 60);
    if (Array.isArray(a.costCentres) && a.costCentres.length) applies.costCentres = a.costCentres.map((c) => text(c, 60)).filter(Boolean);
    if (Array.isArray(a.branches) && a.branches.length) applies.branches = a.branches.map((c) => text(c, 36)).filter((c) => UUID.test(c));
    const evidence = text(r.evidence, 10) || 'none';
    if (!['none', 'note', 'file'].includes(evidence)) throw new InvalidInput(`${where}: evidence must be none, note or file`);
    const sl = (r.sla ?? {}) as Record<string, unknown>;
    const sla: StepSla = { remindAfterHours: hours(sl.remindAfterHours, `${where}: remindAfterHours`), escalateAfterHours: hours(sl.escalateAfterHours, `${where}: escalateAfterHours`), escalateMode: sl.escalateMode === 'replace' ? 'replace' : 'add' };
    if (Array.isArray(sl.escalateTo) && sl.escalateTo.length) sla.escalateTo = sl.escalateTo.map((x, j) => checkResponsible(x, `${where}, escalation ${j + 1}`));
    if (sla.escalateAfterHours && !sla.escalateTo?.length) throw new InvalidInput(`${where}: say who the escalation goes to`);
    if (sla.remindAfterHours && sla.escalateAfterHours && sla.remindAfterHours > sla.escalateAfterHours) throw new InvalidInput(`${where}: the reminder must come before the escalation`);
    const onReject = r.onReject === 'return' ? 'return' : 'end';
    const sameApprover = r.sameApprover === 'independent' ? 'independent' : 'once';
    return { key, name, responsible, mode: mode as Step['mode'], ...(required ? { required } : {}), applies, evidence: evidence as Step['evidence'], notTheSubmitter: r.notTheSubmitter !== false, sla, onReject, sameApprover, ...(text(r.guidance, 500) ? { guidance: text(r.guidance, 500) } : {}) };
  });
}

// --------------------------------------------------------------- templates

export interface Template {
  key: string; name: string; description: string; fits: string; steps: Step[];
  /** The process this template was written for; the editor preselects it. */
  process?: string;
  /** A step whose `applies.minAmount` is the module's own manager limit at the time of adoption. */
  limitFrom?: { step: string; module: 'expenses' | 'procurement' };
}

const h = (remind: number, escalate: number, to: Responsible[]): StepSla => ({ remindAfterHours: remind, escalateAfterHours: escalate, escalateTo: to, escalateMode: 'add' });

export const TEMPLATES: Template[] = [
  { key: 'manager_only', name: 'Manager approves', description: 'One step: the person’s manager. Reminded after a day, escalated to their manager after three.', fits: 'Leave, small requests, anything routine.',
    steps: [{ key: 'manager', name: 'Manager approval', responsible: [{ kind: 'manager' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: h(24, 72, [{ kind: 'skip_manager' }]), onReject: 'return', applies: {} }] },
  { key: 'manager_then_finance', name: 'Manager, then Finance above a limit', description: 'The manager approves everything; Finance also approves anything above the limit you set. Finance must attach a note.', fits: 'Expense claims, advances, purchases.',
    steps: [
      { key: 'manager', name: 'Manager approval', responsible: [{ kind: 'manager' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: h(24, 72, [{ kind: 'skip_manager' }]), onReject: 'return', applies: {} },
      { key: 'finance', name: 'Finance approval', responsible: [{ kind: 'team', team: 'finance' }, { kind: 'role', role: 'finance_approver' }], mode: 'any', evidence: 'note', notTheSubmitter: true, sla: h(48, 120, [{ kind: 'role', role: 'finance_ops' }]), onReject: 'end', applies: { minAmount: 1000 }, guidance: 'Check the receipts, the cost centre and the budget before approving.' },
    ] },
  { key: 'three_bands', name: 'Three bands: manager, Finance, executive', description: 'Manager for everything, Finance above the first limit, an executive sign-off above the second. The executive step needs a file as evidence.', fits: 'Larger organisations with a spending ladder.',
    steps: [
      { key: 'manager', name: 'Manager approval', responsible: [{ kind: 'manager' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: h(24, 72, [{ kind: 'skip_manager' }]), onReject: 'return', applies: {} },
      { key: 'finance', name: 'Finance approval', responsible: [{ kind: 'team', team: 'finance' }], mode: 'any', evidence: 'note', notTheSubmitter: true, sla: h(48, 96, [{ kind: 'role', role: 'finance_ops' }]), onReject: 'end', applies: { minAmount: 1000 } },
      { key: 'executive', name: 'Executive sign-off', responsible: [{ kind: 'person', email: 'cfo@example.com' }], mode: 'any', evidence: 'file', notTheSubmitter: true, sla: h(72, 168, [{ kind: 'person', email: 'ceo@example.com' }]), onReject: 'end', applies: { minAmount: 10000 }, guidance: 'Attach the business case or quote.' },
    ] },
  { key: 'two_signatures', name: 'Any two above a cap', description: 'The manager approves; above the cap, any two of the named approvers must both agree.', fits: 'Payments and contracts that need four eyes.',
    steps: [
      { key: 'manager', name: 'Manager approval', responsible: [{ kind: 'manager' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: h(24, 72, [{ kind: 'skip_manager' }]), onReject: 'return', applies: {} },
      { key: 'two_signatures', name: 'Two signatures', responsible: [{ kind: 'team', team: 'finance' }, { kind: 'role', role: 'finance_approver' }], mode: 'quorum', required: 2, evidence: 'note', notTheSubmitter: true, sla: h(48, 120, [{ kind: 'role', role: 'finance_ops' }]), onReject: 'end', applies: { minAmount: 5000 } },
    ] },
  { key: 'cost_centre_owner', name: 'Cost centre owner, then Finance', description: 'Whoever owns the cost centre approves first, then Finance above the limit. Name the owners on the policy.', fits: 'Budget-holder led organisations.',
    steps: [
      { key: 'owner', name: 'Cost centre owner', responsible: [{ kind: 'cost_centre_owner' }, { kind: 'manager' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: h(24, 72, [{ kind: 'skip_manager' }]), onReject: 'return', applies: {} },
      { key: 'finance', name: 'Finance approval', responsible: [{ kind: 'team', team: 'finance' }], mode: 'any', evidence: 'note', notTheSubmitter: true, sla: h(48, 120, [{ kind: 'role', role: 'finance_ops' }]), onReject: 'end', applies: { minAmount: 2000 } },
    ] },
  // The four module processes as they ship. Adopting one changes nothing
  // about who decides; it makes the chain editable: evidence, reminders,
  // escalation, bands, a second signature.
  { key: 'expense_claim_chain', name: 'Expense claim as shipped', process: 'staff_expense_claim', limitFrom: { step: 'finance', module: 'expenses' }, description: 'The claimant\u2019s manager approves; Finance also approves anything above the manager limit in Expenses settings. Reminded after three days, as the process does.', fits: 'Staff expense claims. Start here, then tighten.',
    steps: [
      { key: 'manager', name: 'Manager approval', responsible: [{ kind: 'manager', fallback: 'line_manager' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: { remindAfterHours: 72, escalateAfterHours: null, escalateTo: [], escalateMode: 'add' }, onReject: 'end', applies: {} },
      { key: 'finance', name: 'Finance approval', responsible: [{ kind: 'role', role: 'finance_approver' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: { remindAfterHours: 72, escalateAfterHours: null, escalateTo: [], escalateMode: 'add' }, onReject: 'end', applies: { minAmount: 1000 } },
    ] },
  { key: 'cash_advance_chain', name: 'Cash advance as shipped', process: 'cash_advance', limitFrom: { step: 'finance', module: 'expenses' }, description: 'The requester\u2019s manager approves; Finance also approves an advance above the manager limit in Expenses settings.', fits: 'Cash advances.',
    steps: [
      { key: 'manager', name: 'Manager approval', responsible: [{ kind: 'manager', fallback: 'line_manager' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: { remindAfterHours: 72, escalateAfterHours: null, escalateTo: [], escalateMode: 'add' }, onReject: 'end', applies: {} },
      { key: 'finance', name: 'Finance approval', responsible: [{ kind: 'role', role: 'finance_approver' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: { remindAfterHours: 72, escalateAfterHours: null, escalateTo: [], escalateMode: 'add' }, onReject: 'end', applies: { minAmount: 1000 } },
    ] },
  { key: 'purchase_chain', name: 'Purchase request as shipped', process: 'purchase_request', limitFrom: { step: 'procurement', module: 'procurement' }, description: 'The requester\u2019s manager approves; Procurement also approves a request above the manager limit in Procurement settings.', fits: 'Purchase requests.',
    steps: [
      { key: 'manager', name: 'Manager approval', responsible: [{ kind: 'manager', fallback: 'line_manager' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: { remindAfterHours: 72, escalateAfterHours: null, escalateTo: [], escalateMode: 'add' }, onReject: 'end', applies: {} },
      { key: 'procurement', name: 'Procurement approval', responsible: [{ kind: 'role', role: 'procurement_approver' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: { remindAfterHours: 72, escalateAfterHours: null, escalateTo: [], escalateMode: 'add' }, onReject: 'end', applies: { minAmount: 1000 } },
    ] },
  { key: 'hiring_chain', name: 'Hiring request as shipped', process: 'hiring_request', description: 'The requester\u2019s manager approves, then HR approves every request.', fits: 'Hiring requests.',
    steps: [
      { key: 'manager', name: 'Manager approval', responsible: [{ kind: 'manager', fallback: 'line_manager' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: { remindAfterHours: 72, escalateAfterHours: null, escalateTo: [], escalateMode: 'add' }, onReject: 'end', applies: {} },
      { key: 'hr', name: 'HR approval', responsible: [{ kind: 'role', role: 'hr_approver' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sla: { remindAfterHours: 72, escalateAfterHours: null, escalateTo: [], escalateMode: 'add' }, onReject: 'end', applies: {} },
    ] },
  // A church: the Resident Pastor of the requester's station, then up the line
  // as the amount grows. One pastor holding two offices approves once; a
  // pastor's own request goes to the level above.
  { key: 'church_line', name: 'Church: up the line by amount', description: 'The Resident Pastor of the requester\u2019s station approves; above the limits it also goes to the Area, Zonal, District and National Pastor in turn. Reminders after two days, escalation to the next pastor up after five.', fits: 'A church with stations, areas, zones, districts and a national office.',
    steps: [
      { key: 'resident_pastor', name: 'Resident Pastor', responsible: [{ kind: 'office', office: 'resident_pastor' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sameApprover: 'once', sla: h(48, 120, [{ kind: 'office', office: 'area_pastor' }]), onReject: 'return', applies: {} },
      { key: 'area_pastor', name: 'Area Pastor', responsible: [{ kind: 'office', office: 'area_pastor' }], mode: 'any', evidence: 'none', notTheSubmitter: true, sameApprover: 'once', sla: h(48, 120, [{ kind: 'office', office: 'zonal_pastor' }]), onReject: 'end', applies: { minAmount: 1000 } },
      { key: 'zonal_pastor', name: 'Zonal Pastor', responsible: [{ kind: 'office', office: 'zonal_pastor' }], mode: 'any', evidence: 'note', notTheSubmitter: true, sameApprover: 'once', sla: h(48, 120, [{ kind: 'office', office: 'district_pastor' }]), onReject: 'end', applies: { minAmount: 5000 } },
      { key: 'district_pastor', name: 'District Pastor', responsible: [{ kind: 'office', office: 'district_pastor' }], mode: 'any', evidence: 'note', notTheSubmitter: true, sameApprover: 'once', sla: h(72, 168, [{ kind: 'office', office: 'national_pastor' }]), onReject: 'end', applies: { minAmount: 20000 } },
      { key: 'national_pastor', name: 'National Pastor', responsible: [{ kind: 'office', office: 'national_pastor' }], mode: 'any', evidence: 'file', notTheSubmitter: true, sameApprover: 'independent', sla: { remindAfterHours: 72, escalateAfterHours: null, escalateTo: [], escalateMode: 'add' }, onReject: 'end', applies: { minAmount: 100000 } },
    ] },
  { key: 'hr_case', name: 'HR, then a director', description: 'HR approves; a director also approves when the category says so. Rejections end the request.', fits: 'HR requests: hiring, pay changes, contract changes.',
    steps: [
      { key: 'hr', name: 'HR approval', responsible: [{ kind: 'team', team: 'hr' }], mode: 'any', evidence: 'note', notTheSubmitter: true, sla: h(48, 96, [{ kind: 'skip_manager' }]), onReject: 'end', applies: {} },
      { key: 'director', name: 'Director approval', responsible: [{ kind: 'person', email: 'director@example.com' }], mode: 'any', evidence: 'file', notTheSubmitter: true, sla: h(72, 168, [{ kind: 'team', team: 'hr' }]), onReject: 'end', applies: { categories: ['hiring', 'pay_change'] } },
    ] },
];

// ------------------------------------------------------------------ access

async function admin(pool: Pool, principal: Principal) {
  await requireWorkspaceCapability(pool, principal, 'administer', 'processes');
  if (principal.kind !== 'actor') throw new Error('unreachable');
  return { tenantId: principal.tenantId, actorId: principal.actorId };
}
async function member(pool: Pool, principal: Principal) {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  return { tenantId: principal.tenantId, actorId: principal.actorId };
}

// ---------------------------------------------------------------- policies

export async function listPolicies(pool: Pool, principal: Principal) {
  const { tenantId } = await member(pool, principal);
  const { rows } = await pool.query(
    `select p.id, p.process_key, p.name, p.description, p.branch_id, b.name as branch, p.steps, p.cost_centre_owners, p.template_key, p.active, p.version, p.updated_at,
            (select v.blueprint->>'name' from process_version v where v.tenant_id = p.tenant_id and v.process_key = p.process_key order by v.version desc limit 1) as process_name,
            (select count(*)::int from approval_step_run r where r.policy_id = p.id and r.status = 'pending') as open_steps
       from approval_policy p left join hr_branch b on b.id = p.branch_id where p.tenant_id = $1 order by p.active desc, p.process_key, b.name nulls first`, [tenantId]);
  const { rows: processes } = await pool.query<{ process_key: string; name: string; approvals: unknown; finance: unknown }>(
    `select distinct on (process_key) process_key, blueprint->>'name' as name, blueprint->'workflow'->'approvals' as approvals, blueprint->'finance' as finance from process_version where tenant_id = $1 order by process_key, version desc`, [tenantId]);
  return { policies: rows, processes: processes.map((p) => ({ key: p.process_key, name: p.name, approvals: (p.approvals as { key: string; name: string; policy?: boolean }[] ?? []).map((a) => ({ key: a.key, name: a.name, policy: a.policy === true })), finance: p.finance })), templates: TEMPLATES };
}

export async function savePolicy(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const { tenantId, actorId } = await admin(pool, principal);
  const processKey = text(body.processKey, 80);
  if (!/^[a-z][a-z0-9_]*$/.test(processKey)) throw new InvalidInput('processKey must be a process key');
  const name = text(body.name, 120);
  if (!name) throw new InvalidInput('give the policy a name');
  const steps = checkSteps(body.steps);
  const branchId = body.branchId ? text(body.branchId, 36) : null;
  if (branchId && !UUID.test(branchId)) throw new InvalidInput('branchId must be an id');
  const owners: Record<string, string> = {};
  if (body.costCentreOwners && typeof body.costCentreOwners === 'object') {
    for (const [k, v] of Object.entries(body.costCentreOwners as Record<string, unknown>)) { const e = text(v, 254).toLowerCase(); if (k.trim() && e) owners[k.trim()] = e; }
  }
  const id = body.id ? text(body.id, 36) : null;
  return inTransaction(pool, async (client) => {
    if (id) {
      const { rows } = await client.query<{ id: string; version: number }>(
        `update approval_policy set name = $3, description = $4, branch_id = $5, steps = $6, cost_centre_owners = $7, active = $8, version = version + 1, updated_by = $9, updated_at = now()
          where id = $1 and tenant_id = $2 returning id, version`, [id, tenantId, name, text(body.description, 500) || null, branchId, JSON.stringify(steps), JSON.stringify(owners), body.active !== false, actorId]);
      if (!rows[0]) throw new InvalidInput('no such policy');
      await recordWorkspaceAudit(client, { tenantId, actorId, action: 'approvals.policy_updated', targetId: id, detail: { processKey, steps: steps.length, version: rows[0].version } });
      return { id, version: rows[0].version };
    }
    if (body.active !== false) await client.query('update approval_policy set active = false, updated_at = now() where tenant_id = $1 and process_key = $2 and branch_id is not distinct from $3 and active', [tenantId, processKey, branchId]);
    const { rows } = await client.query<{ id: string }>(
      `insert into approval_policy (tenant_id, process_key, name, description, branch_id, steps, cost_centre_owners, template_key, active, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) returning id`,
      [tenantId, processKey, name, text(body.description, 500) || null, branchId, JSON.stringify(steps), JSON.stringify(owners), text(body.templateKey, 40) || null, body.active !== false, actorId]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'approvals.policy_created', targetId: rows[0]!.id, detail: { processKey, steps: steps.length, branchId } });
    return { id: rows[0]!.id, version: 1 };
  });
}

/** Switch a policy on (turning any other active one for the same process and branch off) or off. */
export async function setPolicyActive(pool: Pool, principal: Principal, policyId: string, active: boolean) {
  const { tenantId, actorId } = await admin(pool, principal);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ process_key: string; branch_id: string | null }>('select process_key, branch_id from approval_policy where id = $1 and tenant_id = $2', [policyId, tenantId]);
    if (!rows[0]) throw new InvalidInput('no such policy');
    if (active) await client.query('update approval_policy set active = false where tenant_id = $1 and process_key = $2 and branch_id is not distinct from $3 and id <> $4', [tenantId, rows[0].process_key, rows[0].branch_id, policyId]);
    await client.query('update approval_policy set active = $3, updated_by = $4, updated_at = now() where id = $1 and tenant_id = $2', [policyId, tenantId, active, actorId]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: active ? 'approvals.policy_activated' : 'approvals.policy_deactivated', targetId: policyId, detail: {} });
    return { id: policyId, active };
  });
}

/** Copy a template into a policy for a process; the administrator edits it from there. */
export async function adoptTemplate(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const key = text(body.templateKey, 40);
  const t = TEMPLATES.find((x) => x.key === key);
  if (!t) throw new InvalidInput('no such template');
  let steps: Step[] = t.steps;
  if (t.limitFrom) {
    // The band starts where the module's own routing hands over today, so
    // adopting the template changes who decides nothing.
    const { tenantId } = await admin(pool, principal);
    const limit = t.limitFrom.module === 'procurement' ? (await procurementSettings(pool, tenantId)).managerLimit : (await expenseSettings(pool, tenantId)).managerLimit;
    steps = t.steps.map((s) => s.key === t.limitFrom!.step ? { ...s, applies: { ...s.applies, minAmount: limit } } : s);
  }
  return savePolicy(pool, principal, { processKey: body.processKey || t.process, name: text(body.name, 120) || t.name, description: t.description, branchId: body.branchId, steps, templateKey: t.key, costCentreOwners: body.costCentreOwners, active: body.active });
}

// ----------------------------------------------------------------- lookup

export async function policyFor(client: Client | Pool, tenantId: string, processKey: string, branchId: string | null): Promise<Policy | null> {
  const { rows } = await client.query<Policy>(
    `select * from approval_policy where tenant_id = $1 and process_key = $2 and active and (branch_id = $3 or branch_id is null) order by (branch_id is not null) desc, updated_at desc limit 1`, [tenantId, processKey, branchId]);
  return rows[0] ?? null;
}

async function branchOfSubmitter(client: Client, bp: Blueprint, instance: InstanceRow): Promise<string | null> {
  const actorId = await submitterActor(client, bp, instance);
  if (!actorId) return null;
  const { rows } = await client.query<{ branch_id: string | null }>('select branch_id from employee_record where actor_id = $1', [actorId]);
  return rows[0]?.branch_id ?? null;
}

function fieldValue(instance: InstanceRow, field: string | undefined): string {
  if (!field) return '';
  const v = instance.data[field];
  return v === undefined || v === null ? '' : String(v);
}
function amountValue(instance: InstanceRow, bp: Blueprint, step: Step): number {
  const field = step.applies?.amountField || bp.finance?.baseAmountField || bp.finance?.amountField || 'amount';
  const n = num(instance.data[field]);
  return Number.isFinite(n) ? n : 0;
}

/** Which steps of the policy this record goes through. */
export function applicableSteps(policy: Policy, instance: InstanceRow, bp: Blueprint, branchId: string | null): Step[] {
  return policy.steps.filter((s) => {
    const a = s.applies ?? {};
    const amount = amountValue(instance, bp, s);
    if (a.minAmount !== undefined && a.minAmount !== null && amount < a.minAmount) return false;
    if (a.maxAmount !== undefined && a.maxAmount !== null && amount > a.maxAmount) return false;
    if (a.categories?.length) { const c = fieldValue(instance, a.categoryField || bp.finance?.categoryField || 'category'); if (!a.categories.includes(c)) return false; }
    if (a.costCentres?.length) { const c = fieldValue(instance, a.costCentreField || bp.finance?.costCentreField || 'cost_centre'); if (!a.costCentres.includes(c)) return false; }
    if (a.branches?.length && !(branchId && a.branches.includes(branchId))) return false;
    return true;
  });
}

/** Who a responsible party is, as the engine addresses approvers: emails, or `role:<key>` for a process role. */
export async function resolveResponsible(client: Client, r: Responsible, args: { instance: InstanceRow; bp: Blueprint; approval: Approval; policy: Policy; now: Date }): Promise<string[]> {
  const { instance, bp, now } = args;
  switch (r.kind) {
    case 'manager': return resolveParty(client, { manager: 'submitter', ...(r.fallback ? { fallback: r.fallback } : {}) }, instance, bp, now);
    case 'skip_manager': {
      const submitter = await submitterActor(client, bp, instance);
      const m1 = submitter ? await managerOf(client, { tenantId: instance.tenant_id, actorId: submitter, at: now }) : null;
      const m2 = m1 ? await managerOf(client, { tenantId: instance.tenant_id, actorId: m1.id, at: now }) : null;
      if (m2) return [m2.email];
      if (m1) return [m1.email];
      return r.fallback ? [`role:${r.fallback}`] : [];
    }
    case 'role': return [`role:${r.role}`];
    case 'team': {
      const { rows } = await client.query<{ email: string }>(`select lower(a.email) as email from hr_team_member m join actor a on a.id = m.actor_id where m.tenant_id = $1 and m.team = $2 and a.active`, [instance.tenant_id, r.team]);
      if (rows.length) return rows.map((x) => x.email);
      // Owners and admins are always HR; for other teams nobody named means nobody.
      if (r.team === 'hr') { const { rows: adm } = await client.query<{ email: string }>(`select lower(email) as email from actor where tenant_id = $1 and active and workspace_role in ('owner', 'admin')`, [instance.tenant_id]); return adm.map((x) => x.email); }
      return [];
    }
    case 'person': return [r.email];
    case 'cost_centre_owner': {
      const cc = fieldValue(instance, r.field || bp.finance?.costCentreField || 'cost_centre');
      const owner = args.policy.cost_centre_owners[cc];
      return owner ? [owner] : [];
    }
    case 'field': { const v = fieldValue(instance, r.field); return v && v.includes('@') ? [v.toLowerCase()] : []; }
    case 'fallback': { const out: string[] = []; for (const p of args.approval.approvers) for (const who of await resolveParty(client, p, instance, bp, now)) if (!out.includes(who)) out.push(who); return out; }
    case 'office': { const at = await unitOfActor(client, await submitterActor(client, bp, instance)); return (await resolveOffice(client, instance.tenant_id, at, r.office)).holders.map((h) => h.email.toLowerCase()); }
    case 'committee': { const at = await unitOfActor(client, await submitterActor(client, bp, instance)); return (await resolveCommittee(client, instance.tenant_id, at, r.committee)).emails; }
  }
}

/** Emails behind a list of approvers, roles included, for notifications. */
async function emailsFor(client: Client | Pool, tenantId: string, processKey: string, approvers: string[]): Promise<string[]> {
  const out = new Set<string>();
  const roles = approvers.filter((a) => a.startsWith('role:')).map((a) => a.slice(5));
  for (const a of approvers) if (!a.startsWith('role:') && a.includes('@')) out.add(a.toLowerCase());
  if (roles.length) {
    const { rows } = await client.query<{ email: string }>(`select distinct lower(a.email) as email from membership m join actor a on a.id = m.actor_id where m.tenant_id = $1 and m.process_key = $2 and m.role_key = any($3::text[]) and a.active`, [tenantId, processKey, roles]);
    for (const r of rows) out.add(r.email);
  }
  return [...out];
}

type Mail = { kind: PlatformMailKind; to: string; subject: string; text: string; tenantId: string; idempotencyKey: string };
let mailer: (pool: Pool | Client, m: Mail) => Promise<void> = async (pool, m) => { await sendPlatformMail(pool as Pool, m); };
export function setApprovalMailerForTests(fn: ((pool: Pool | Client, m: Mail) => Promise<void>) | null) { mailer = fn ?? (async (pool, m) => { await sendPlatformMail(pool as Pool, m); }); }

async function notify(client: Client | Pool, args: { tenantId: string; processKey: string; approvers: string[]; kind: PlatformMailKind; subject: string; text: string; key: string }) {
  for (const to of await emailsFor(client, args.tenantId, args.processKey, args.approvers)) {
    await mailer(client, { kind: args.kind, to, subject: args.subject, text: args.text, tenantId: args.tenantId, idempotencyKey: `${args.key}:${to}` });
  }
}

// ------------------------------------------------------------- the chain

const modeOf = (s: Step): 'any_of' | 'sequential' | 'quorum' => (s.mode === 'all' ? 'sequential' : s.mode === 'quorum' ? 'quorum' : 'any_of');

/** Create the approval request for one step and the step run that tracks its clock. */
interface Resolved { approvers: string[]; offices: { unitId: string; officeTypeId: string }[]; via: { responsible: Responsible; resolved: string[]; note?: string }[]; notes: string[]; skip: { reason: string; by: string[] } | null }

/** The emails of everyone who approved an earlier step of the chain this record is on now. */
async function earlierApprovers(client: Client, instance: InstanceRow, approvalKey: string, index: number): Promise<string[]> {
  const { rows } = await client.query<{ email: string }>(
    `with start as (select max(started_at) as at from approval_step_run where instance_id = $1 and approval_key = $2 and step_index = 0)
     select distinct lower(a.email) as email from approval_step_run r, start, actor a
      where r.instance_id = $1 and r.approval_key = $2 and r.step_index < $3 and r.status = 'approved' and r.started_at >= start.at
        and a.id::text = substring(r.decided_by from 7) and r.decided_by like 'actor:%'`, [instance.id, approvalKey, index]);
  return rows.map((r) => r.email);
}

/**
 * Who a step goes to. Offices are found up the tree from the requester; the
 * requester never decides their own request; a person who already approved
 * an earlier step either counts once (the step is skipped, on the record) or,
 * when the step must be independent, is replaced by an alternate: an
 * assistant at the same unit, else the overseer above.
 */
async function resolveStep(client: Client, args: { instance: InstanceRow; bp: Blueprint; approval: Approval; policy: Policy; step: Step; index: number; now: Date }): Promise<Resolved> {
  const { instance, bp, approval, policy, step, index, now } = args;
  const out: Resolved = { approvers: [], offices: [], via: [], notes: [], skip: null };
  let fromUnit: string | null | undefined;
  const unitOfRequester = async () => (fromUnit === undefined ? (fromUnit = await unitOfActor(client, await submitterActor(client, bp, instance))) : fromUnit);
  for (const r of step.responsible) {
    if (r.kind === 'office') {
      const o = await resolveOffice(client, instance.tenant_id, await unitOfRequester(), r.office);
      if (o.unitId && o.officeTypeId) out.offices.push({ unitId: o.unitId, officeTypeId: o.officeTypeId });
      const emails = o.holders.map((h) => h.email.toLowerCase());
      out.via.push({ responsible: r, resolved: emails, ...(o.vacant ? { note: o.wentTo ? `${o.office} is vacant; it went to the overseer of ${o.wentTo.unit}` : `${o.office} is vacant and nobody above holds an office` } : !o.unitId ? { note: `the requester has no unit with a ${o.office}` } : {}) });
      for (const e of emails) if (!out.approvers.includes(e)) out.approvers.push(e);
    } else {
      const emails = r.kind === 'committee'
        ? (await resolveCommittee(client, instance.tenant_id, await unitOfRequester(), r.committee)).emails
        : await resolveResponsible(client, r, { instance, bp, approval, policy, now });
      out.via.push({ responsible: r, resolved: emails });
      for (const e of emails) if (!out.approvers.includes(e)) out.approvers.push(e);
    }
  }
  const submitter = (submitterOf(bp, instance) ?? '').toLowerCase();
  const earlier = index > 0 ? await earlierApprovers(client, instance, approval.key, index) : [];
  const exclude: string[] = [];
  if (step.notTheSubmitter && submitter && out.approvers.includes(submitter)) { exclude.push(submitter); out.notes.push('the requester holds this office, so it goes to someone else'); }
  const already = out.approvers.filter((e) => earlier.includes(e) && !exclude.includes(e));
  if (already.length) {
    const others = out.approvers.filter((e) => !earlier.includes(e) && !exclude.includes(e));
    if ((step.sameApprover ?? 'once') === 'once' && !others.length && !exclude.length) {
      out.skip = { reason: 'already approved this record in another office', by: already };
      return out;
    }
    exclude.push(...already);
    out.notes.push((step.sameApprover ?? 'once') === 'independent' ? 'this step must be independent of earlier approvals' : 'an earlier approver is not counted twice');
  }
  out.approvers = out.approvers.filter((e) => !exclude.includes(e));
  if (!out.approvers.length && exclude.length) {
    for (const seat of out.offices) {
      const alt = await alternateFor(client, instance.tenant_id, seat.unitId, [...exclude, submitter].filter(Boolean));
      if (alt) { out.approvers = alt.holders.map((h) => h.email.toLowerCase()); out.notes.push(alt.how === 'assistant' ? `an assistant at ${alt.unit} takes it` : `it goes up to the overseer of ${alt.unit}`); break; }
    }
  }
  if (!out.approvers.length) {
    // Nobody resolved: the process's own approvers take it, so nothing waits on an empty seat.
    for (const p of approval.approvers) for (const who of await resolveParty(client, p, instance, bp, now)) if (!out.approvers.includes(who) && who.toLowerCase() !== submitter) out.approvers.push(who);
    if (out.approvers.length) out.notes.push('nobody holds the office, so the process\u2019s own approvers take it');
  }
  return out;
}

async function openStep(client: Client, args: { instance: InstanceRow; bp: Blueprint; approval: Approval; policy: Policy; steps: Step[]; index: number; runId: number | null; now: Date; actor: string }): Promise<'opened' | 'skipped'> {
  const { instance, bp, approval, policy, steps, index, now } = args;
  const step = steps[index]!;
  const res = await resolveStep(client, { instance, bp, approval, policy, step, index, now });
  if (res.skip) {
    await client.query(
      `insert into approval_step_run (tenant_id, instance_id, approval_key, request_id, policy_id, policy_version, step_index, step_key, step_name, step, started_at, status, decided_at, decided_by, offices)
       values ($1, $2, $3, null, $4, $5, $6, $7, $8, $9, $10, 'skipped', $10, 'system:policy', $11)`,
      [instance.tenant_id, instance.id, approval.key, policy.id, policy.version, index, step.key, step.name, JSON.stringify(step), now, JSON.stringify(res.offices)]);
    await appendEvent(client, { tenantId: instance.tenant_id, instanceId: instance.id, type: 'approval_step_skipped', actor: args.actor, now,
      payload: { approval: approval.key, step: { index: index + 1, of: steps.length, key: step.key, name: step.name }, reason: res.skip.reason, by: res.skip.by } });
    return 'skipped';
  }
  const approvers = res.approvers;
  const mode = modeOf(step);
  const sla = step.sla ?? {};
  const remindAt = sla.remindAfterHours ? new Date(now.getTime() + sla.remindAfterHours * 3_600_000) : null;
  const escalateAt = sla.escalateAfterHours ? new Date(now.getTime() + sla.escalateAfterHours * 3_600_000) : null;
  const dueAt = escalateAt ?? remindAt ?? (approval.dueInHours ? new Date(now.getTime() + approval.dueInHours * 3_600_000) : null);
  const required = mode === 'quorum' ? Math.min(step.required ?? 2, Math.max(1, approvers.length)) : null;
  const { rows } = await client.query<{ id: string }>(
    `insert into approval_request (tenant_id, instance_id, action_run_id, approval_key, approvers, mode, due_at, created_at, required, electorate) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null) returning id`,
    [instance.tenant_id, instance.id, args.runId, approval.key, approvers, mode, dueAt, now, required]);
  await client.query(
    `insert into approval_step_run (tenant_id, instance_id, approval_key, request_id, policy_id, policy_version, step_index, step_key, step_name, step, started_at, remind_at, escalate_at, offices)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [instance.tenant_id, instance.id, approval.key, rows[0]!.id, policy.id, policy.version, index, step.key, step.name, JSON.stringify(step), now, remindAt, escalateAt, JSON.stringify(res.offices)]);
  await appendEvent(client, {
    tenantId: instance.tenant_id, instanceId: instance.id, type: approvers.length ? 'approval_routed' : 'routing_unresolved', actor: args.actor, now,
    payload: { approval: approval.key, approvers, policy: { id: policy.id, name: policy.name, version: policy.version }, step: { index: index + 1, of: steps.length, key: step.key, name: step.name, mode: step.mode, evidence: step.evidence }, via: res.via, ...(res.notes.length ? { notes: res.notes } : {}) },
  });
  await notify(client, { tenantId: instance.tenant_id, processKey: instance.process_key, approvers, kind: 'approval_requested', key: `apr-req:${instance.id}:${approval.key}:${index}:${now.getTime()}`,
    subject: `${bp.name}: ${step.name} needed`, text: `A ${bp.name} record is waiting for your decision (${step.name}, step ${index + 1} of ${steps.length}).${step.guidance ? `\n\n${step.guidance}` : ''}\n\nOpen your work queue in Patform to decide.` });
  return 'opened';
}

/**
 * A holder of an office changed (appointed, replaced, ended). Every open step
 * addressed to that office is worked out again, so the approval waits with
 * whoever holds it now; the record says it moved and why.
 */
export async function rerouteOffice(client: Client, tenantId: string, unitId: string, officeTypeId: string, now = new Date()): Promise<number> {
  const { rows: runs } = await client.query<{ id: number; instance_id: string; approval_key: string; request_id: string; policy_id: string; step_index: number; step: Step }>(
    `select id, instance_id, approval_key, request_id, policy_id, step_index, step from approval_step_run
      where tenant_id = $1 and status = 'pending' and offices @> $2::jsonb`, [tenantId, JSON.stringify([{ unitId, officeTypeId }])]);
  let moved = 0;
  for (const run of runs) {
    const { rows: inst } = await client.query<InstanceRow>(`select id, tenant_id, process_key, process_version_id, state, data, assignee, outcome, state_entered_at, completed_at from instance where id = $1`, [run.instance_id]);
    const { rows: ver } = await client.query<{ blueprint: Blueprint }>('select blueprint from process_version where id = $1', [inst[0]!.process_version_id]);
    const { rows: pol } = await client.query<Policy>('select * from approval_policy where id = $1', [run.policy_id]);
    const bp = ver[0]!.blueprint; const approval = bp.workflow.approvals.find((a) => a.key === run.approval_key);
    if (!approval || !pol[0]) continue;
    const res = await resolveStep(client, { instance: inst[0]!, bp, approval, policy: pol[0], step: run.step, index: run.step_index, now });
    if (res.skip || !res.approvers.length) continue;
    const { rows: req } = await client.query<{ approvers: string[] }>(`select approvers from approval_request where id = $1 and status = 'pending'`, [run.request_id]);
    if (!req[0] || [...req[0].approvers].sort().join() === [...res.approvers].sort().join()) continue;
    await client.query(`update approval_request set approvers = $2 where id = $1 and status = 'pending'`, [run.request_id, res.approvers]);
    await client.query('update approval_step_run set offices = $2 where id = $1', [run.id, JSON.stringify(res.offices)]);
    await appendEvent(client, { tenantId, instanceId: run.instance_id, type: 'approval_rerouted', actor: 'system:structure', now, payload: { approval: run.approval_key, step: run.step.name, from: req[0].approvers, to: res.approvers, reason: 'the holder of the office changed', notes: res.notes } });
    await notify(client, { tenantId, processKey: inst[0]!.process_key, approvers: res.approvers.filter((e) => !req[0]!.approvers.includes(e)), kind: 'approval_requested', key: `apr-reroute:${run.id}:${now.getTime()}`,
      subject: `${bp.name}: ${run.step.name} needed`, text: `A ${bp.name} record now waits for your decision (${run.step.name}), because the office changed hands.\n\nOpen your work queue in Patform to decide.` });
    moved++;
  }
  return moved;
}

/**
 * A holder deciding in an office with a mandate may approve up to it. The
 * office the decider holds among those the step was addressed to is what
 * counts; someone deciding as an alternate or by escalation is not held to it.
 */
export async function checkOfficeMandate(client: Client, args: { run: StepRunRow; instance: InstanceRow; bp: Blueprint; actorId: string }): Promise<{ office: string; unit: string; acting: boolean }[]> {
  const held = await holdingsAt(client, args.instance.tenant_id, args.actorId, args.run.offices ?? []);
  if (!held.length) return [];
  const limits = held.map((h) => (h.mandate_limit === null ? Infinity : Number(h.mandate_limit)));
  const amount = amountValue(args.instance, args.bp, args.run.step);
  const best = Math.max(...limits);
  if (amount > best) throw new InvalidInput(`your mandate as ${held[0]!.office} of ${held[0]!.unit} is up to ${best.toLocaleString()}; this is ${amount.toLocaleString()}. Send it back, or it waits for someone with a higher mandate.`);
  return held.map((h) => ({ office: h.office, unit: h.unit, acting: h.acting }));
}

/**
 * Called by the engine when a policy-driven approval is requested. Returns
 * true when a policy took it; false means fall back to the blueprint's own
 * approvers.
 */
/**
 * A process may ask for a second gate after the first (the shipped modules
 * route "over the manager limit" to Finance or Procurement). When an active
 * policy already ran its whole chain on this record, that later gate is
 * covered: the organisation's policy decided it in full, and nobody should
 * be asked twice. Covered only while nothing changed on the record since.
 */
export async function policyCoveredDecision(client: Client, instance: InstanceRow): Promise<{ chain: unknown; by: unknown; policy: unknown } | null> {
  const { rows } = await client.query<{ type: string; payload: { decision?: string; policyChain?: unknown; by?: unknown; policy?: unknown } }>(
    `select type, payload from event where instance_id = $1 and type in ('approval_decided', 'record_updated', 'approval_covered') order by seq desc limit 1`, [instance.id]);
  const e = rows[0];
  if (!e) return null;
  if (e.type === 'approval_covered') return { chain: e.payload.policyChain, by: e.payload.by, policy: e.payload.policy };
  if (e.type === 'approval_decided' && e.payload.decision === 'approved' && e.payload.policyChain) return { chain: e.payload.policyChain, by: e.payload.by, policy: e.payload.policy ?? null };
  return null;
}

export async function startPolicyChain(client: Client, args: { instance: InstanceRow; bp: Blueprint; approval: Approval; runId: number; now: Date }): Promise<boolean> {
  const branchId = await branchOfSubmitter(client, args.bp, args.instance);
  const policy = await policyFor(client, args.instance.tenant_id, args.instance.process_key, branchId);
  if (!policy) return false;
  const steps = applicableSteps(policy, args.instance, args.bp, branchId);
  if (!steps.length) {
    // Nothing applies: the record passes without a human, and the history says so.
    await appendEvent(client, { tenantId: args.instance.tenant_id, instanceId: args.instance.id, type: 'approval_policy_waived', actor: 'system:policy', now: args.now, payload: { approval: args.approval.key, policy: { id: policy.id, name: policy.name } } });
    return false;
  }
  for (let i = 0; i < steps.length; i++) if ((await openStep(client, { ...args, policy, steps, index: i, actor: 'system:policy' })) === 'opened') return true;
  // Every step counted an approval already given: nothing more to ask.
  await appendEvent(client, { tenantId: args.instance.tenant_id, instanceId: args.instance.id, type: 'approval_policy_waived', actor: 'system:policy', now: args.now, payload: { approval: args.approval.key, policy: { id: policy.id, name: policy.name }, reason: 'every step was already approved' } });
  return false;
}

export interface StepRunRow { id: number; policy_id: string; policy_version: number; step_index: number; step_key: string; step_name: string; step: Step; status: string; offices?: { unitId: string; officeTypeId: string }[] }

/** The open step behind a pending request, if the request came from a policy. */
export async function stepRunFor(client: Client, requestId: string | number): Promise<StepRunRow | null> {
  const { rows } = await client.query<StepRunRow>(`select id, policy_id, policy_version, step_index, step_key, step_name, step, status, offices from approval_step_run where request_id = $1 and status = 'pending'`, [requestId]);
  return rows[0] ?? null;
}

/** Evidence an approver has put on this approval, for the engine's check. */
export async function evidenceCount(client: Client, instanceId: string, approvalKey: string, actor: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from approval_evidence where instance_id = $1 and approval_key = $2 and actor = $3 and scan_status <> 'quarantined'`, [instanceId, approvalKey, actor]);
  return rows[0]!.n;
}

/**
 * Called by the engine once a step's request is settled. Opens the next
 * applicable step, or says which decision the process should now see.
 */
export async function continuePolicyChain(client: Client, args: { instance: InstanceRow; bp: Blueprint; approval: Approval; run: StepRunRow; decision: 'approved' | 'rejected' | 'changes_requested'; actor: string; now: Date; as?: { office: string; unit: string; acting: boolean }[] }): Promise<{ fire: 'approved' | 'rejected' | 'changes_requested' | null; step: number; of: number; stepName?: string }> {
  const { instance, bp, run, decision, now } = args;
  const { rows: pol } = await client.query<Policy>('select * from approval_policy where id = $1', [run.policy_id]);
  const policy = pol[0]!;
  const branchId = await branchOfSubmitter(client, bp, instance);
  const steps = applicableSteps({ ...policy, steps: policy.steps }, instance, bp, branchId);
  // The chain the record started on, not a policy edited since: steps are matched by key.
  const order = steps.length ? steps : [run.step];
  const at = Math.max(0, order.findIndex((s) => s.key === run.step_key));
  await client.query(`update approval_step_run set status = $2, decided_at = $3, decided_by = $4 where id = $1`, [run.id, decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'returned', now, args.actor]);
  if (decision !== 'approved') {
    const back = run.step.onReject === 'return' && args.approval.allowRequestChanges;
    await appendEvent(client, { tenantId: instance.tenant_id, instanceId: instance.id, type: 'approval_step_decided', actor: args.actor, now, payload: { approval: args.approval.key, step: { index: at + 1, of: order.length, key: run.step_key, name: run.step_name }, decision, outcome: back ? 'returned to the requester' : 'ended' } });
    return { fire: back ? 'changes_requested' : 'rejected', step: at + 1, of: order.length };
  }
  await appendEvent(client, { tenantId: instance.tenant_id, instanceId: instance.id, type: 'approval_step_decided', actor: args.actor, now, payload: { approval: args.approval.key, step: { index: at + 1, of: order.length, key: run.step_key, name: run.step_name }, decision, ...(args.as?.length ? { as: args.as } : {}) } });
  for (let i = at + 1; i < order.length; i++) {
    if ((await openStep(client, { instance, bp, approval: args.approval, policy, steps: order, index: i, runId: null, now, actor: 'system:policy' })) === 'opened') return { fire: null, step: i + 1, of: order.length, stepName: order[i]!.name };
  }
  return { fire: 'approved', step: order.length, of: order.length };
}

// -------------------------------------------------------------- evidence

function sniff(bytes: Buffer, filename: string): string | null {
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 2).toString('ascii') === 'PK' && /\.(docx|xlsx)$/i.test(filename)) return /\.xlsx$/i.test(filename) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return null;
}

/** An approver attaches a file to the approval they are about to decide. */
export async function uploadEvidence(pool: Pool, principal: Principal, instanceId: string, approvalKey: string, body: Record<string, unknown>) {
  const { tenantId, actorId } = await member(pool, principal);
  if (!UUID.test(instanceId)) throw new InvalidInput('no such record');
  const { rows: pending } = await pool.query(`select a.id from approval_request a join instance i on i.id = a.instance_id where a.instance_id = $1 and a.approval_key = $2 and a.status = 'pending' and i.tenant_id = $3`, [instanceId, approvalKey, tenantId]);
  if (!pending[0]) throw new InvalidInput('that approval is not open');
  const filename = text(body.filename, 200); const base64 = typeof body.base64 === 'string' ? body.base64 : '';
  const MAX = 5 * 1024 * 1024;
  if (!filename || !base64 || base64.length > Math.ceil(MAX * 4 / 3) + 8) throw new InvalidInput('Choose a PDF, Word, Excel, JPEG or PNG file up to 5 MB.');
  const bytes = Buffer.from(base64, 'base64');
  const type = sniff(bytes, filename);
  if (!type || !bytes.length || bytes.length > MAX) throw new InvalidInput('Choose a PDF, Word, Excel, JPEG or PNG file up to 5 MB.');
  const id = randomUUID(); const key = `approvals/${tenantId}/${instanceId}/${id}`;
  const sha = createHash('sha256').update(bytes).digest('hex');
  await objectStore().put(key, bytes, type, { sha256: sha });
  await pool.query(`insert into approval_evidence (id, tenant_id, instance_id, approval_key, actor, filename, content_type, byte_size, sha256, storage_key) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, tenantId, instanceId, approvalKey, `actor:${actorId}`, filename, type, bytes.length, sha, key]);
  return { id, filename, sha256: sha, status: 'scanning' as const };
}

export async function listEvidence(pool: Pool, principal: Principal, instanceId: string, approvalKey: string) {
  const { tenantId } = await member(pool, principal);
  const { rows } = await pool.query(`select e.id, e.actor, e.filename, e.content_type, e.byte_size, e.scan_status, e.created_at, a.display_name as by from approval_evidence e left join actor a on ('actor:' || a.id::text) = e.actor where e.tenant_id = $1 and e.instance_id = $2 and e.approval_key = $3 order by e.created_at`, [tenantId, instanceId, approvalKey]);
  return rows;
}

export async function evidenceLink(pool: Pool, principal: Principal, evidenceId: string) {
  const { tenantId } = await member(pool, principal);
  const { rows } = await pool.query<{ storage_key: string; content_type: string; filename: string; scan_status: string }>('select storage_key, content_type, filename, scan_status from approval_evidence where id = $1 and tenant_id = $2', [evidenceId, tenantId]);
  const f = rows[0];
  if (!f) throw new InvalidInput('no such file');
  const store = objectStore();
  const scan = await store.scan(f.storage_key);
  const stored = scan === 'scanning' ? 'unscanned' : scan;
  if (stored !== f.scan_status) await pool.query('update approval_evidence set scan_status = $2 where id = $1', [evidenceId, stored]);
  if (scan === 'scanning') throw new InvalidInput('The file is still being checked for malware. Try again in a minute.');
  if (scan === 'quarantined') throw new InvalidInput('The file did not pass its malware check and cannot be shown.');
  return { url: await store.link(f.storage_key, { contentType: f.content_type, filename: f.filename }), filename: f.filename };
}

// ------------------------------------------------------------------ sweep

/** Reminders and escalations for steps that have waited too long. Runs from the worker. */
export async function sweepApprovals(pool: Pool, now = new Date()): Promise<{ reminded: number; escalated: number }> {
  let reminded = 0; let escalated = 0;
  const { rows } = await pool.query<{ id: number; tenant_id: string; instance_id: string; approval_key: string; request_id: string; step: Step; step_name: string; step_index: number; remind_at: Date | null; reminded_at: Date | null; escalate_at: Date | null; escalated_at: Date | null; policy_id: string }>(
    `select r.id, r.tenant_id, r.instance_id, r.approval_key, r.request_id, r.step, r.step_name, r.step_index, r.remind_at, r.reminded_at, r.escalate_at, r.escalated_at, r.policy_id
       from approval_step_run r join approval_request a on a.id = r.request_id
      where r.status = 'pending' and a.status = 'pending' and ((r.remind_at <= $1 and r.reminded_at is null) or (r.escalate_at <= $1 and r.escalated_at is null))
        and not exists (select 1 from tenant t where t.id = r.tenant_id and t.is_scenario) order by r.id limit 200`, [now]);
  for (const r of rows) {
    await inTransaction(pool, async (client) => {
      const { rows: req } = await client.query<{ approvers: string[]; process_key: string; name: string }>(`select a.approvers, i.process_key, v.blueprint->>'name' as name from approval_request a join instance i on i.id = a.instance_id join process_version v on v.id = i.process_version_id where a.id = $1 and a.status = 'pending' for update of a`, [r.request_id]);
      if (!req[0]) return;
      const hoursOpen = Math.round((now.getTime() - (r.remind_at ? r.remind_at.getTime() - (r.step.sla?.remindAfterHours ?? 0) * 3_600_000 : now.getTime())) / 3_600_000);
      if (r.remind_at && r.remind_at <= now && !r.reminded_at) {
        await notify(client, { tenantId: r.tenant_id, processKey: req[0].process_key, approvers: req[0].approvers, kind: 'approval_reminder', key: `apr-remind:${r.id}`, subject: `Reminder: ${r.step_name} still needed`, text: `A ${req[0].name} record has waited ${hoursOpen} hour(s) for ${r.step_name}. Please decide it in Patform.` });
        await client.query('update approval_step_run set reminded_at = $2 where id = $1', [r.id, now]);
        await appendEvent(client, { tenantId: r.tenant_id, instanceId: r.instance_id, type: 'approval_reminded', actor: 'system:policy', now, payload: { approval: r.approval_key, step: r.step_name, approvers: req[0].approvers } });
        reminded++;
      }
      if (r.escalate_at && r.escalate_at <= now && !r.escalated_at && r.step.sla?.escalateTo?.length) {
        const { rows: inst } = await client.query<InstanceRow>('select id, tenant_id, process_key, process_version_id, state, data, assignee, outcome, state_entered_at, completed_at from instance where id = $1', [r.instance_id]);
        const { rows: ver } = await client.query<{ blueprint: Blueprint }>('select blueprint from process_version where id = $1', [inst[0]!.process_version_id]);
        const { rows: pol } = await client.query<Policy>('select * from approval_policy where id = $1', [r.policy_id]);
        const bp = ver[0]!.blueprint; const approval = bp.workflow.approvals.find((a) => a.key === r.approval_key)!;
        const to: string[] = [];
        for (const t of r.step.sla.escalateTo) for (const who of await resolveResponsible(client, t, { instance: inst[0]!, bp, approval, policy: pol[0]!, now })) if (!to.includes(who)) to.push(who);
        const approvers = r.step.sla.escalateMode === 'replace' ? (to.length ? to : req[0].approvers) : [...new Set([...req[0].approvers, ...to])];
        await client.query('update approval_request set approvers = $2 where id = $1', [r.request_id, approvers]);
        await client.query('update approval_step_run set escalated_at = $2, escalated_to = $3 where id = $1', [r.id, now, to]);
        await appendEvent(client, { tenantId: r.tenant_id, instanceId: r.instance_id, type: 'approval_escalated', actor: 'system:policy', now, payload: { approval: r.approval_key, step: r.step_name, from: req[0].approvers, to, mode: r.step.sla.escalateMode ?? 'add', reason: `no decision after ${r.step.sla.escalateAfterHours} hours` } });
        await notify(client, { tenantId: r.tenant_id, processKey: req[0].process_key, approvers: to, kind: 'approval_escalated', key: `apr-esc:${r.id}`, subject: `Escalated to you: ${r.step_name}`, text: `A ${req[0].name} record has waited ${r.step.sla.escalateAfterHours} hours for ${r.step_name} and has been escalated to you. Please decide it in Patform.` });
        escalated++;
      }
    });
  }
  return { reminded, escalated };
}

// --------------------------------------------------------------- overview

/** What is waiting, overdue and escalated across every process, for the administrator's dashboard. */
export async function approvalsOverview(pool: Pool, principal: Principal) {
  const { tenantId } = await member(pool, principal);
  const { rows } = await pool.query(
    `select r.id, r.instance_id, r.approval_key, r.step_name, r.step_index, r.started_at, r.remind_at, r.reminded_at, r.escalate_at, r.escalated_at, r.escalated_to, a.approvers, a.mode, i.process_key, i.state, v.blueprint->>'name' as process_name, p.name as policy_name,
            coalesce(i.data->>'claimant_name', i.data->>'requester_name', i.data->>'employee_email', '') as who, coalesce(i.data->>'approval_amount_base', i.data->>'expense_total', i.data->>'amount', '') as amount
       from approval_step_run r join approval_request a on a.id = r.request_id join instance i on i.id = r.instance_id join process_version v on v.id = i.process_version_id left join approval_policy p on p.id = r.policy_id
      where r.tenant_id = $1 and r.status = 'pending' and a.status = 'pending' order by r.started_at`, [tenantId]);
  const now = Date.now();
  const items = rows.map((r) => ({ ...r, hoursOpen: Math.round((now - new Date(r.started_at).getTime()) / 3_600_000), overdue: !!(r.escalate_at && new Date(r.escalate_at).getTime() < now) || !!(r.remind_at && new Date(r.remind_at).getTime() < now) }));
  const { rows: done } = await pool.query<{ n: string; avg_hours: string; rejected: string; returned: string }>(
    `select count(*) as n, coalesce(avg(extract(epoch from (decided_at - started_at)) / 3600), 0) as avg_hours, count(*) filter (where status = 'rejected') as rejected, count(*) filter (where status = 'returned') as returned
       from approval_step_run where tenant_id = $1 and status <> 'pending' and decided_at > now() - interval '90 days'`, [tenantId]);
  return { open: items, counts: { open: items.length, overdue: items.filter((i) => i.overdue).length, escalated: items.filter((i) => i.escalated_at).length }, last90Days: { decided: Number(done[0]!.n), averageHours: Math.round(Number(done[0]!.avg_hours) * 10) / 10, rejected: Number(done[0]!.rejected), returned: Number(done[0]!.returned) } };
}

/** Try a policy against a made-up record: which steps apply and who would take them. */
export async function simulatePolicy(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const { tenantId } = await member(pool, principal);
  const steps = checkSteps(body.steps);
  const amount = num(body.amount ?? 0) || 0;
  const category = text(body.category, 60); const costCentre = text(body.costCentre, 60); const branchId = text(body.branchId, 36) || null;
  const owners = (body.costCentreOwners && typeof body.costCentreOwners === 'object' ? body.costCentreOwners : {}) as Record<string, string>;
  const fake: InstanceRow = { id: '00000000-0000-0000-0000-000000000000', tenant_id: tenantId, process_key: text(body.processKey, 80), process_version_id: '', state: 'simulated', data: { amount, approval_amount_base: amount, expense_total: amount, category, cost_centre: costCentre }, assignee: null, outcome: null, state_entered_at: new Date(), completed_at: null };
  const bp = { finance: { amountField: 'amount', categoryField: 'category', costCentreField: 'cost_centre' } } as unknown as Blueprint;
  const policy: Policy = { id: 'simulated', tenant_id: tenantId, process_key: fake.process_key, name: 'simulated', description: null, branch_id: branchId, steps, cost_centre_owners: owners, template_key: null, active: true, version: 0 };
  const applicable = applicableSteps(policy, fake, bp, branchId);
  const describe = (r: Responsible) => r.kind === 'manager' ? 'the submitter’s manager' : r.kind === 'skip_manager' ? 'the manager’s manager' : r.kind === 'role' ? `anyone holding the ${r.role} role` : r.kind === 'team' ? `the ${r.team.toUpperCase()} team` : r.kind === 'person' ? r.email : r.kind === 'cost_centre_owner' ? (owners[costCentre] ? `${owners[costCentre]} (owner of ${costCentre})` : `the owner of ${costCentre || 'the cost centre'} (none named)`) : r.kind === 'field' ? `the address in ${r.field}` : r.kind === 'office' ? `the ${r.office.replace(/_/g, ' ')} over the requester` : r.kind === 'committee' ? `the ${r.committee.replace(/_/g, ' ')} committee nearest the requester` : 'the process’s own approvers';
  return { amount, category, costCentre, steps: steps.map((s) => ({ key: s.key, name: s.name, applies: applicable.includes(s), who: s.responsible.map(describe), mode: s.mode, required: s.required, evidence: s.evidence, remindAfterHours: s.sla?.remindAfterHours ?? null, escalateAfterHours: s.sla?.escalateAfterHours ?? null, escalateTo: (s.sla?.escalateTo ?? []).map(describe), onReject: s.onReject })) };
}

/**
 * Someone leaves (deactivated, or access revoked by HR): every office they
 * hold ends today, on the record, and what waited for them moves to whoever
 * the office falls to now.
 */
export async function endOfficesOfMember(client: Client, tenantId: string, actorId: string, by: string | null, reason: string): Promise<number> {
  const { rows } = await client.query<{ id: string; unit_id: string; office_type_id: string }>(
    `update office_holder set ends_on = greatest(starts_on, current_date), ended_by = $3, end_reason = $4
      where tenant_id = $1 and actor_id = $2 and (ends_on is null or ends_on > current_date) returning id, unit_id, office_type_id`, [tenantId, actorId, by, reason]);
  for (const h of rows) await rerouteOffice(client, tenantId, h.unit_id, h.office_type_id);
  if (rows.length) await recordWorkspaceAudit(client, { tenantId, actorId: by, action: 'structure.offices_ended_on_leaving', targetId: actorId, detail: { offices: rows.length, reason } });
  return rows.length;
}
