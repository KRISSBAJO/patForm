/**
 * General Approvals: everyday requests that do not belong to a specialised
 * module (system access, use of a facility, a station's expenditure).
 *
 * An admin defines request types: the questions, the documents needed (some
 * only when a condition holds, like a quotation above an amount), and the
 * route. A route is a list of steps; a step can be the requester's manager,
 * named people, a team, an office found up the structure from the requester
 * (their Resident Pastor, the Area Pastor over them), or a committee (their
 * station's CMC). Steps can depend on the answers, and steps in the same
 * stage run side by side, so two committees can review at once.
 *
 * Each stage is worked out when it opens, not at submission, so it reaches
 * whoever holds the office then. The requester never decides their own
 * request. A person who already approved in another office counts once,
 * unless the step must be independent; then an assistant or the overseer
 * above takes it. An office's mandate caps what its holder may approve.
 */
import { createHash, randomUUID } from 'node:crypto';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { enabledModules } from './modules.js';
import { managerOf } from './org.js';
import { objectStore } from './object-store.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { alternateFor, holdingsAt, resolveCommittee, resolveOffice, unitOfActor } from './structure.js';

const value = (raw: unknown, max = 500) => typeof raw === 'string' ? raw.trim().slice(0, max) : '';
const UUID = /^[0-9a-f-]{36}$/;
type Field = { key: string; label: string; type: 'short_text' | 'long_text' | 'number' | 'date' | 'yes_no' | 'choice'; required: boolean; choices?: string[] };
/** A condition on one answer. */
type Cond = { field: string; op: 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'in' | 'yes' | 'no'; value?: number | string; values?: string[] };
type Rule =
  | { kind: 'manager' } | { kind: 'person'; actorId: string } | { kind: 'team'; team: 'hr' | 'it' | 'facilities' | 'finance' }
  | { kind: 'office'; office: string } | { kind: 'committee'; committee: string };
type Step = { name: string; responsible: Rule[]; mode: 'any' | 'all' | 'quorum' | 'majority'; required?: number; when?: Cond; parallel?: boolean; sameApprover?: 'once' | 'independent' };
type Doc = { key: string; label: string; when?: Cond };
type RequestType = { id: string; tenant_id: string; name: string; description: string | null; fields: Field[]; attachment_rule: 'none' | 'optional' | 'required'; steps: Step[]; active: boolean; category_id: string | null; amount_field: string | null; documents: Doc[] };
type Request = { id: string; tenant_id: string; type_id: string; requester_id: string; title: string; answers: Record<string, unknown>; status: string; round: number; current_step: number; type_snapshot: RequestType | null };
type Who = { tenantId: string; actorId: string };

async function member(pool: Pool | Client, principal: Principal) {
  if (principal.kind !== 'actor') throw new InvalidInput('sign in to use General approvals');
  if (!(await enabledModules(pool as Pool, principal.tenantId)).has('general_approvals')) throw new InvalidInput('General approvals is switched off for this workspace');
  const { rows } = await pool.query<{ workspace_role: string; active: boolean }>('select workspace_role, active from actor where id = $1 and tenant_id = $2', [principal.actorId, principal.tenantId]);
  if (!rows[0]?.active || ['pre_hire', 'auditor'].includes(rows[0].workspace_role)) throw new InvalidInput('your workspace access is not active');
  return { tenantId: principal.tenantId, actorId: principal.actorId, admin: ['owner', 'admin'].includes(rows[0].workspace_role) };
}
async function admin(pool: Pool, principal: Principal) {
  const who = await member(pool, principal);
  await requireWorkspaceCapability(pool, principal, 'administer', 'modules');
  return who;
}

// ---------------------------------------------------------------- parsing

function fields(raw: unknown): Field[] {
  if (!Array.isArray(raw) || raw.length > 20) throw new InvalidInput('a request type can have up to 20 fields');
  const keys = new Set<string>();
  return raw.map((item, index) => {
    const f = (item ?? {}) as Record<string, unknown>;
    const label = value(f.label, 100); const key = value(f.key, 40).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const type = value(f.type, 20) as Field['type'];
    if (!label || !/^[a-z][a-z0-9_]*$/.test(key) || keys.has(key) || ['title', 'type', 'status'].includes(key)) throw new InvalidInput(`field ${index + 1} needs a unique name and key`);
    if (!['short_text', 'long_text', 'number', 'date', 'yes_no', 'choice'].includes(type)) throw new InvalidInput(`field ${index + 1} has an unsupported kind`);
    keys.add(key);
    const choices = type === 'choice' && Array.isArray(f.choices) ? f.choices.map((x) => value(x, 80)).filter(Boolean).slice(0, 30) : undefined;
    if (type === 'choice' && !choices?.length) throw new InvalidInput(`${label} needs choices`);
    return { key, label, type, required: f.required === true, ...(choices ? { choices: [...new Set(choices)] } : {}) };
  });
}
function cond(raw: unknown, fs: Field[], where: string): Cond | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const field = value(c.field, 40);
  if (!field) return undefined;
  const f = fs.find((x) => x.key === field);
  if (!f) throw new InvalidInput(`${where}: the condition names a question that is not on the form`);
  const op = value(c.op, 4) as Cond['op'];
  if (f.type === 'number') {
    if (!['gte', 'gt', 'lte', 'lt', 'eq'].includes(op)) throw new InvalidInput(`${where}: compare a number with at least, more than, at most, less than or equals`);
    const n = Number(c.value); if (!Number.isFinite(n)) throw new InvalidInput(`${where}: the condition needs a number`);
    return { field, op, value: n };
  }
  if (f.type === 'yes_no') return { field, op: op === 'no' ? 'no' : 'yes' };
  if (f.type === 'choice') {
    const values = Array.isArray(c.values) ? c.values.map((x) => value(x, 80)).filter((x) => f.choices?.includes(x)) : [];
    if (!values.length) throw new InvalidInput(`${where}: choose which answers the condition matches`);
    return { field, op: 'in', values };
  }
  throw new InvalidInput(`${where}: conditions work on number, yes/no and choice questions`);
}
export function matches(c: Cond | undefined, answers: Record<string, unknown>): boolean {
  if (!c) return true;
  const a = answers[c.field];
  if (c.op === 'yes') return a === true;
  if (c.op === 'no') return a === false;
  if (c.op === 'in') return typeof a === 'string' && !!c.values?.includes(a);
  const n = Number(a); const v = Number(c.value);
  if (a === undefined || a === null || a === '' || !Number.isFinite(n)) return false;
  return c.op === 'gte' ? n >= v : c.op === 'gt' ? n > v : c.op === 'lte' ? n <= v : c.op === 'lt' ? n < v : n === v;
}
function steps(raw: unknown, fs: Field[]): Step[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 12) throw new InvalidInput('add 1 to 12 approval steps');
  return raw.map((item, index) => {
    const s = (item ?? {}) as Record<string, unknown>; const name = value(s.name, 100);
    const mode = value(s.mode, 10) || 'any';
    if (!name || !['any', 'all', 'quorum', 'majority'].includes(mode)) throw new InvalidInput(`approval step ${index + 1} needs a name and decision rule`);
    if (!Array.isArray(s.responsible) || !s.responsible.length || s.responsible.length > 20) throw new InvalidInput(`${name} needs at least one approver`);
    const responsible = s.responsible.map((item: unknown): Rule => {
      const r = (item ?? {}) as Record<string, unknown>; const kind = value(r.kind, 20);
      if (kind === 'manager') return { kind };
      if (kind === 'person' && UUID.test(value(r.actorId, 36))) return { kind, actorId: value(r.actorId, 36) };
      if (kind === 'team' && ['hr', 'it', 'facilities', 'finance'].includes(value(r.team, 20))) return { kind, team: value(r.team, 20) as 'hr' };
      if (kind === 'office' && /^[a-z][a-z0-9_]*$/.test(value(r.office, 40))) return { kind, office: value(r.office, 40) };
      if (kind === 'committee' && /^[a-z][a-z0-9_]*$/.test(value(r.committee, 40))) return { kind, committee: value(r.committee, 40) };
      throw new InvalidInput(`${name} has an invalid approver`);
    });
    const required = mode === 'quorum' ? Number(s.required) : undefined;
    if (mode === 'quorum' && (!Number.isInteger(required) || required! < 2 || required! > 20)) throw new InvalidInput(`${name} needs a quorum of 2 to 20 people`);
    const when = cond(s.when, fs, name);
    return { name, responsible, mode: mode as Step['mode'], ...(required ? { required } : {}), ...(when ? { when } : {}), ...(index > 0 && s.parallel === true ? { parallel: true } : {}), ...(s.sameApprover === 'independent' ? { sameApprover: 'independent' as const } : {}) };
  });
}
function documents(raw: unknown, fs: Field[]): Doc[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 12) throw new InvalidInput('a request type can ask for up to 12 documents');
  const keys = new Set<string>();
  return raw.map((item, i) => {
    const d = (item ?? {}) as Record<string, unknown>;
    const label = value(d.label, 100);
    const key = (value(d.key, 40) || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!label || !key || keys.has(key)) throw new InvalidInput(`document ${i + 1} needs a unique name`);
    keys.add(key);
    const when = cond(d.when, fs, label);
    return { key, label, ...(when ? { when } : {}) };
  });
}
/** The stage each step runs in: a step marked parallel runs alongside the one before it. */
function stagesOf(ss: Step[]): number[] {
  const out: number[] = []; let stage = 0;
  ss.forEach((s, i) => { if (i > 0 && !s.parallel) stage++; out.push(stage); });
  return out;
}
function answersFor(type: RequestType, raw: unknown, strict: boolean) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const result: Record<string, unknown> = {};
  for (const f of type.fields) {
    const x = input[f.key]; const empty = x === undefined || x === null || x === '';
    if (empty) { if (strict && f.required) throw new InvalidInput(`${f.label} is required`); continue; }
    if (f.type === 'number') { const n = Number(x); if (!Number.isFinite(n)) throw new InvalidInput(`${f.label} must be a number`); result[f.key] = n; }
    else if (f.type === 'yes_no') { if (typeof x !== 'boolean') throw new InvalidInput(`${f.label} must be yes or no`); result[f.key] = x; }
    else if (f.type === 'date') { if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || Number.isNaN(Date.parse(`${x}T00:00:00Z`))) throw new InvalidInput(`${f.label} needs a valid date`); result[f.key] = x; }
    else { const v = value(x, f.type === 'long_text' ? 4000 : 500); if (!v || (f.type === 'choice' && !f.choices?.includes(v))) throw new InvalidInput(`${f.label} is invalid`); result[f.key] = v; }
  }
  return result;
}
async function event(client: Client, who: { tenantId: string; actorId: string | null }, requestId: string, kind: string, detail: Record<string, unknown> = {}) {
  await client.query('insert into general_request_event (tenant_id,request_id,actor_id,kind,detail) values ($1,$2,$3,$4,$5)', [who.tenantId, requestId, who.actorId, kind, JSON.stringify(detail)]);
}
async function requestRow(pool: Pool | Client, tenantId: string, requestId: string, lock = false): Promise<Request> {
  const { rows } = await pool.query<Request>(`select * from general_request where id = $1 and tenant_id = $2${lock ? ' for update' : ''}`, [requestId, tenantId]);
  if (!rows[0]) throw new InvalidInput('no such request');
  return rows[0];
}
async function visible(pool: Pool | Client, who: { tenantId: string; actorId: string; admin: boolean }, request: Request) {
  if (who.admin || request.requester_id === who.actorId) return true;
  const { rows } = await pool.query(`select 1 where exists
    (select 1 from general_request_step where request_id=$1 and $2=any(approvers))
    or exists (select 1 from general_request_share where request_id=$1 and actor_id=$2)`, [request.id, who.actorId]);
  return !!rows[0];
}

// -------------------------------------------------------------- categories

const DEFAULT_CATEGORIES = ['Administration', 'Finance', 'Facilities', 'IT & access', 'People', 'Ministry'];
export async function listCategories(pool: Pool, principal: Principal) {
  const who = await member(pool, principal);
  const { rows: had } = await pool.query('select 1 from general_request_category where tenant_id = $1 limit 1', [who.tenantId]);
  if (!had.length) {
    let sort = 0;
    for (const name of DEFAULT_CATEGORIES) await pool.query('insert into general_request_category (tenant_id, name, sort) values ($1, $2, $3) on conflict do nothing', [who.tenantId, name, sort += 10]);
  }
  const { rows } = await pool.query('select id, name, sort, active from general_request_category where tenant_id = $1 order by sort, name', [who.tenantId]);
  return rows;
}
export async function saveCategory(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const who = await admin(pool, principal);
  const name = value(body.name, 60); if (!name) throw new InvalidInput('name the category');
  const id = value(body.id, 36);
  try {
    if (id) {
      const { rows } = await pool.query('update general_request_category set name=$3, sort=$4, active=$5 where id=$1 and tenant_id=$2 returning id', [id, who.tenantId, name, Math.trunc(Number(body.sort) || 0), body.active !== false]);
      if (!rows[0]) throw new InvalidInput('no such category');
    } else await pool.query('insert into general_request_category (tenant_id, name, sort) values ($1, $2, $3)', [who.tenantId, name, Math.trunc(Number(body.sort) || 100)]);
  } catch (e) { if ((e as { code?: string }).code === '23505') throw new InvalidInput('there is already a category with that name'); throw e; }
  await recordWorkspaceAudit(pool, { tenantId: who.tenantId, actorId: who.actorId, action: 'general_approvals.category_saved', detail: { name } });
  return { ok: true };
}

// ------------------------------------------------------------------ types

export async function listTypes(pool: Pool, principal: Principal) {
  const who = await member(pool, principal);
  const { rows } = await pool.query<RequestType & { category: string | null }>(
    `select t.*, c.name as category from general_request_type t left join general_request_category c on c.id = t.category_id
      where t.tenant_id = $1 and (t.active or $2) order by c.sort nulls last, t.name`, [who.tenantId, who.admin]);
  return rows;
}
export async function saveType(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const who = await admin(pool, principal);
  const name = value(body.name, 120); if (!name) throw new InvalidInput('name this request type');
  const attachmentRule = value(body.attachmentRule, 12) || 'optional';
  if (!['none', 'optional', 'required'].includes(attachmentRule)) throw new InvalidInput('choose an attachment rule');
  const parsedFields = fields(body.fields); const parsedSteps = steps(body.steps, parsedFields); const parsedDocs = documents(body.documents, parsedFields);
  const amountField = value(body.amountField, 40) || null;
  if (amountField && parsedFields.find((f) => f.key === amountField)?.type !== 'number') throw new InvalidInput('the amount must be one of the number questions');
  const categoryId = value(body.categoryId, 36) || null;
  if (categoryId) { const { rows } = await pool.query('select 1 from general_request_category where id = $1 and tenant_id = $2', [categoryId, who.tenantId]); if (!rows[0]) throw new InvalidInput('no such category'); }
  const params = [name, value(body.description, 1000) || null, JSON.stringify(parsedFields), attachmentRule, JSON.stringify(parsedSteps), body.active !== false, categoryId, amountField, JSON.stringify(parsedDocs)];
  return inTransaction(pool, async (client) => {
    if (body.id) {
      const { rows } = await client.query<{ id: string }>(`update general_request_type set name=$3,description=$4,fields=$5,attachment_rule=$6,steps=$7,active=$8,category_id=$9,amount_field=$10,documents=$11,updated_at=now() where id=$1 and tenant_id=$2 returning id`, [body.id, who.tenantId, ...params]);
      if (!rows[0]) throw new InvalidInput('no such request type');
      await recordWorkspaceAudit(client, { tenantId: who.tenantId, actorId: who.actorId, action: 'general_approvals.type_updated', targetId: rows[0].id, detail: { name } });
      return rows[0];
    }
    const { rows } = await client.query<{ id: string }>(`insert into general_request_type (tenant_id,name,description,fields,attachment_rule,steps,active,category_id,amount_field,documents,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`, [who.tenantId, ...params, who.actorId]);
    await recordWorkspaceAudit(client, { tenantId: who.tenantId, actorId: who.actorId, action: 'general_approvals.type_created', targetId: rows[0]!.id, detail: { name } });
    return rows[0];
  });
}

// --------------------------------------------------------------- requests

export async function createRequest(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const who = await member(pool, principal);
  const { rows: types } = await pool.query<RequestType>('select * from general_request_type where id = $1 and tenant_id = $2 and active', [body.typeId, who.tenantId]);
  const type = types[0]; if (!type) throw new InvalidInput('choose an active request type');
  const title = value(body.title, 200); if (!title) throw new InvalidInput('give the request a title');
  const answers = answersFor(type, body.answers, false);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(`insert into general_request (tenant_id,type_id,requester_id,title,answers) values ($1,$2,$3,$4,$5) returning id`, [who.tenantId, type.id, who.actorId, title, JSON.stringify(answers)]);
    await event(client, who, rows[0]!.id, 'draft_created');
    return { id: rows[0]!.id, status: 'draft' };
  });
}
export async function editRequest(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const who = await member(pool, principal);
  return inTransaction(pool, async (client) => {
    const request = await requestRow(client, who.tenantId, requestId, true);
    if (request.requester_id !== who.actorId || !['draft', 'returned'].includes(request.status)) throw new InvalidInput('only the requester can edit a draft or returned request');
    const { rows } = await client.query<RequestType>('select * from general_request_type where id = $1 and tenant_id = $2', [request.type_id, who.tenantId]);
    const type = rows[0]!; const title = body.title === undefined ? request.title : value(body.title, 200);
    if (!title) throw new InvalidInput('give the request a title');
    const answers = body.answers === undefined ? request.answers : answersFor(type, body.answers, false);
    await client.query('update general_request set title=$2,answers=$3,updated_at=now() where id=$1', [requestId, title, JSON.stringify(answers)]);
    await event(client, who, requestId, 'draft_updated');
    return { id: requestId, status: request.status };
  });
}

// ------------------------------------------------------------- routing

async function idsForEmails(client: Client, tenantId: string, emails: string[]): Promise<string[]> {
  if (!emails.length) return [];
  const { rows } = await client.query<{ id: string }>('select id from actor where tenant_id = $1 and active and lower(email) = any($2::text[])', [tenantId, emails.map((e) => e.toLowerCase())]);
  return rows.map((r) => r.id);
}
async function ownerOrAdmin(client: Client, tenantId: string, exclude: string[]): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `select id from actor where tenant_id=$1 and active and not (id = any($2::uuid[])) and workspace_role in ('owner','admin')
      order by case workspace_role when 'owner' then 0 else 1 end, created_at, id limit 1`, [tenantId, exclude]);
  return rows.map((r) => r.id);
}

interface Resolved { approvers: string[]; offices: { unitId: string; officeTypeId: string }[]; notes: string[]; skip: string | null; majority: boolean }

/** Who a step goes to for this requester now. */
async function resolveStep(client: Client, args: { tenantId: string; requesterId: string; step: Step; earlier: string[] }): Promise<Resolved> {
  const { tenantId, requesterId, step, earlier } = args;
  const out: Resolved = { approvers: [], offices: [], notes: [], skip: null, majority: step.mode === 'majority' };
  const unit = await unitOfActor(client, requesterId);
  const add = (ids: string[]) => { for (const id of ids) if (!out.approvers.includes(id)) out.approvers.push(id); };
  for (const rule of step.responsible) {
    if (rule.kind === 'manager') {
      const m = await managerOf(client, { tenantId, actorId: requesterId, at: new Date() });
      if (m && m.id !== requesterId) add([m.id]);
      else { add(await ownerOrAdmin(client, tenantId, [requesterId])); out.notes.push('no manager on file, so a workspace owner or admin takes it'); }
    } else if (rule.kind === 'person') {
      const { rows } = await client.query<{ id: string }>('select id from actor where id = $1 and tenant_id = $2 and active', [rule.actorId, tenantId]);
      add(rows.map((r) => r.id));
    } else if (rule.kind === 'team') {
      const { rows } = await client.query<{ id: string }>('select a.id from hr_team_member t join actor a on a.id=t.actor_id where t.tenant_id=$1 and t.team=$2 and a.active', [tenantId, rule.team]);
      add(rows.map((r) => r.id));
    } else if (rule.kind === 'office') {
      const o = await resolveOffice(client, tenantId, unit, rule.office);
      if (o.unitId && o.officeTypeId) out.offices.push({ unitId: o.unitId, officeTypeId: o.officeTypeId });
      if (o.vacant) out.notes.push(o.wentTo ? `${o.office} is vacant; it went to the overseer of ${o.wentTo.unit}` : `${o.office} is vacant`);
      if (!o.unitId) out.notes.push(`the requester has no unit with a ${o.office}`);
      add(await idsForEmails(client, tenantId, o.holders.map((h) => h.email)));
    } else {
      const c = await resolveCommittee(client, tenantId, unit, rule.committee);
      if (!c.bodyId) out.notes.push(`no ${rule.committee} committee is linked for the requester`);
      add(await idsForEmails(client, tenantId, c.emails));
    }
  }
  const exclude: string[] = [];
  if (out.approvers.includes(requesterId)) { exclude.push(requesterId); out.notes.push('the requester holds this office, so it goes to someone else'); }
  const already = out.approvers.filter((id) => earlier.includes(id) && id !== requesterId);
  if (already.length) {
    const others = out.approvers.filter((id) => !earlier.includes(id) && id !== requesterId);
    if ((step.sameApprover ?? 'once') === 'once' && !others.length && !exclude.length) { out.skip = 'already approved this request in another office'; return out; }
    exclude.push(...already);
    out.notes.push(step.sameApprover === 'independent' ? 'this step must be independent of earlier approvals' : 'an earlier approver is not counted twice');
  }
  out.approvers = out.approvers.filter((id) => !exclude.includes(id));
  if (!out.approvers.length && exclude.length) {
    const { rows: ex } = await client.query<{ email: string }>('select lower(email) as email from actor where id = any($1::uuid[])', [[...exclude, requesterId]]);
    for (const seat of out.offices) {
      const alt = await alternateFor(client, tenantId, seat.unitId, ex.map((e) => e.email));
      if (alt) { out.approvers = await idsForEmails(client, tenantId, alt.holders.map((h) => h.email)); out.notes.push(alt.how === 'assistant' ? `an assistant at ${alt.unit} takes it` : `it goes up to the overseer of ${alt.unit}`); break; }
    }
  }
  if (!out.approvers.length) { out.approvers = await ownerOrAdmin(client, tenantId, [requesterId, ...exclude]); if (out.approvers.length) out.notes.push('nobody else could take it, so a workspace owner or admin does'); }
  return out;
}
const needed = (mode: string, required: number | undefined, n: number, majority: boolean) => (majority ? Math.floor(n / 2) + 1 : mode === 'all' ? n : mode === 'quorum' ? Math.min(required ?? 2, n) : 1);

/** Approvers who approved an earlier stage of this round. */
async function earlierApprovers(client: Client, requestId: string, round: number, stage: number): Promise<string[]> {
  const { rows } = await client.query<{ actor_id: string }>(
    `select distinct v.actor_id from general_request_vote v join general_request_step s on s.id = v.step_id
      where s.request_id = $1 and s.round = $2 and s.stage < $3 and v.decision = 'approve'`, [requestId, round, stage]);
  return rows.map((r) => r.actor_id);
}

/**
 * Opens the next stage that still has someone to ask. Returns true while the
 * request still waits on a stage, false when every stage is done.
 */
async function openFrom(client: Client, request: Request, type: RequestType, stage: number, actor: string | null, strict = false): Promise<boolean> {
  const { rows: maxRow } = await client.query<{ max: number | null }>('select max(stage) as max from general_request_step where request_id = $1 and round = $2', [request.id, request.round]);
  for (let s = stage; s <= (maxRow[0]?.max ?? -1); s++) {
    const { rows: waiting } = await client.query<{ id: number; position: number }>(`select id, position from general_request_step where request_id = $1 and round = $2 and stage = $3 and status = 'waiting' order by position`, [request.id, request.round, s]);
    if (!waiting.length) continue;
    const earlier = await earlierApprovers(client, request.id, request.round, s);
    let open = 0;
    for (const w of waiting) {
      const step = type.steps[w.position]!;
      const r = await resolveStep(client, { tenantId: request.tenant_id, requesterId: request.requester_id, step, earlier });
      if (r.skip) {
        await client.query(`update general_request_step set status='skipped', closed_at=now(), note=$2, offices=$3 where id=$1`, [w.id, r.skip, JSON.stringify(r.offices)]);
        await event(client, { tenantId: request.tenant_id, actorId: actor }, request.id, 'step_skipped', { step: step.name, reason: r.skip });
        continue;
      }
      if (!r.approvers.length) {
        // At submission nobody waits on an empty step: say so now. Later, the step waits for an admin to reassign it.
        if (strict) throw new InvalidInput(`${step.name} needs another eligible approver. Assign a manager or ask a different owner/admin to join this workspace; you cannot approve your own request.`);
        r.notes.push('nobody can take this step; an admin must reassign it');
      }
      const required = needed(step.mode, step.required, r.approvers.length, r.majority);
      await client.query(`update general_request_step set status='pending', opened_at=now(), approvers=$2, required=$3, offices=$4, note=$5 where id=$1`, [w.id, r.approvers, Math.max(1, required), JSON.stringify(r.offices), r.notes.join('; ') || null]);
      if (r.notes.length) await event(client, { tenantId: request.tenant_id, actorId: actor }, request.id, 'routed', { step: step.name, notes: r.notes });
      open++;
    }
    if (open) { await client.query('update general_request set current_step=$2, updated_at=now() where id=$1', [request.id, s]); return true; }
  }
  return false;
}

export async function submitRequest(pool: Pool, principal: Principal, requestId: string) {
  const who = await member(pool, principal);
  return inTransaction(pool, async (client) => {
    const request = await requestRow(client, who.tenantId, requestId, true);
    if (request.requester_id !== who.actorId || !['draft', 'returned'].includes(request.status)) throw new InvalidInput('only the requester can submit this draft');
    const { rows: types } = await client.query<RequestType>('select * from general_request_type where id=$1 and tenant_id=$2', [request.type_id, who.tenantId]);
    const type = types[0]!; if (!type.active) throw new InvalidInput('this request type is switched off');
    answersFor(type, request.answers, true);
    const { rows: files } = await client.query<{ document_key: string | null }>('select document_key from general_request_file where request_id=$1', [requestId]);
    if (type.attachment_rule === 'required' && !files.length) throw new InvalidInput('attach a file before submitting');
    if (type.attachment_rule === 'none' && files.some((f) => !f.document_key)) throw new InvalidInput('this request type does not accept attachments');
    for (const d of type.documents ?? []) {
      if (matches(d.when, request.answers) && !files.some((f) => f.document_key === d.key)) throw new InvalidInput(`attach the ${d.label.toLowerCase()} before submitting`);
    }
    const nextRound = request.round + 1;
    const stages = stagesOf(type.steps);
    for (let index = 0; index < type.steps.length; index++) {
      const step = type.steps[index]!;
      const applies = matches(step.when, request.answers);
      await client.query(`insert into general_request_step (tenant_id,request_id,round,position,stage,name,approvers,mode,required,status,note) values ($1,$2,$3,$4,$5,$6,'{}',$7,1,$8,$9)`,
        [who.tenantId, requestId, nextRound, index, stages[index], step.name, step.mode === 'majority' ? 'quorum' : step.mode, applies ? 'waiting' : 'not_needed', applies ? null : 'not needed for this request']);
    }
    await client.query(`update general_request set status='pending',type_snapshot=$2,round=$3,submitted_at=now(),updated_at=now() where id=$1`, [requestId, JSON.stringify(type), nextRound]);
    const fresh = { ...request, round: nextRound, type_snapshot: type };
    const waits = await openFrom(client, fresh, type, 0, who.actorId, true);
    await event(client, who, requestId, 'submitted', { round: nextRound, steps: type.steps.length, needed: type.steps.filter((s) => matches(s.when, request.answers)).length });
    if (!waits) {
      await client.query("update general_request set status='approved',updated_at=now() where id=$1", [requestId]);
      await event(client, who, requestId, 'approved', { reason: 'every step was already approved or not needed' });
      return { id: requestId, status: 'approved' };
    }
    return { id: requestId, status: 'pending' };
  });
}

export async function listRequests(pool: Pool, principal: Principal, scope: string) {
  const who = await member(pool, principal);
  if (!['mine', 'waiting', 'shared', 'all'].includes(scope)) throw new InvalidInput('choose mine, waiting, shared or all');
  if (scope === 'all' && !who.admin) throw new InvalidInput('only an administrator can see every request');
  const where = scope === 'mine' ? 'r.requester_id=$2'
    : scope === 'waiting' ? "r.status='pending' and exists (select 1 from general_request_step s where s.request_id=r.id and s.round=r.round and s.stage=r.current_step and s.status='pending' and $2=any(s.approvers) and not exists (select 1 from general_request_vote v where v.step_id=s.id and v.actor_id=$2))"
      : scope === 'shared' ? 'exists (select 1 from general_request_share h where h.request_id=r.id and h.actor_id=$2)' : 'true';
  const { rows } = await pool.query(
    `select r.id,r.title,r.status,r.created_at,r.updated_at,r.submitted_at,r.requester_id,r.current_step,t.name as type_name,c.name as category,a.display_name as requester,
            (select string_agg(s.name, ' + ' order by s.position) from general_request_step s where s.request_id=r.id and s.round=r.round and s.stage=r.current_step and s.status='pending') as step_name
       from general_request r join general_request_type t on t.id=r.type_id left join general_request_category c on c.id=t.category_id join actor a on a.id=r.requester_id
      where r.tenant_id=$1 and ${where} order by r.updated_at desc limit 200`, scope === 'all' ? [who.tenantId] : [who.tenantId, who.actorId]);
  return rows;
}
export async function requestDetail(pool: Pool, principal: Principal, requestId: string) {
  const who = await member(pool, principal); const request = await requestRow(pool, who.tenantId, requestId);
  if (!(await visible(pool, who, request))) throw new InvalidInput('this request is not assigned to you');
  const [type, steps, events, files, shares] = await Promise.all([
    pool.query<RequestType>('select * from general_request_type where id=$1', [request.type_id]),
    pool.query(`select s.id,s.round,s.position,s.stage,s.name,s.mode,s.required,s.status,s.approvers,s.opened_at,s.closed_at,s.note,
                       (select count(*)::int from general_request_vote v where v.step_id=s.id and v.decision='approve') as approvals,
                       exists(select 1 from general_request_vote v where v.step_id=s.id and v.actor_id=$2) as viewer_voted,
                       (select coalesce(json_agg(json_build_object('name', a.display_name, 'decision', v.decision, 'note', v.note) order by v.created_at), '[]') from general_request_vote v join actor a on a.id = v.actor_id where v.step_id = s.id) as votes,
                       (select coalesce(json_agg(a.display_name order by a.display_name), '[]') from actor a where a.id = any(s.approvers)) as approver_names
                  from general_request_step s where s.request_id=$1 order by s.round,s.position`, [requestId, who.actorId]),
    pool.query(`select e.id,e.kind,e.detail,e.created_at,a.display_name as actor from general_request_event e left join actor a on a.id=e.actor_id where e.request_id=$1 order by e.id desc`, [requestId]),
    pool.query('select id,filename,byte_size,document_key,created_at from general_request_file where request_id=$1 order by created_at desc', [requestId]),
    pool.query('select h.actor_id,a.display_name,a.email from general_request_share h join actor a on a.id=h.actor_id where h.request_id=$1 order by h.created_at', [requestId]),
  ]);
  const { rows: req } = await pool.query<{ name: string }>('select display_name as name from actor where id = $1', [request.requester_id]);
  type S = { round: number; stage: number; status: string; approvers: string[]; viewer_voted: boolean };
  return {
    request, requester: req[0]?.name ?? null, type: request.type_snapshot ?? type.rows[0], steps: steps.rows, events: events.rows, files: files.rows, shares: shares.rows,
    viewer: { own: request.requester_id === who.actorId, admin: who.admin, canShare: request.status !== 'draft' && (request.requester_id === who.actorId || who.admin),
      canDecide: request.status === 'pending' && (steps.rows as S[]).some((s) => s.round === request.round && s.stage === request.current_step && s.status === 'pending' && s.approvers.includes(who.actorId) && !s.viewer_voted) },
  };
}
export async function setRequestShare(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const who = await member(pool, principal);
  const request = await requestRow(pool, who.tenantId, requestId);
  if (request.status === 'draft' || (!who.admin && request.requester_id !== who.actorId)) throw new InvalidInput('only the requester or a workspace admin can share a submitted request');
  const actorId = value(body.actorId, 36);
  if (!UUID.test(actorId) || actorId === request.requester_id) throw new InvalidInput('choose another workspace member');
  const { rows } = await pool.query('select 1 from actor where tenant_id=$1 and id=$2 and active', [who.tenantId, actorId]);
  if (!rows[0]) throw new InvalidInput('choose an active person in this workspace');
  return inTransaction(pool, async (client) => {
    if (body.shared === false) {
      await client.query('delete from general_request_share where tenant_id=$1 and request_id=$2 and actor_id=$3', [who.tenantId, requestId, actorId]);
      await event(client, who, requestId, 'access_removed', { actorId });
    } else {
      await client.query(`insert into general_request_share (tenant_id,request_id,actor_id,added_by) values ($1,$2,$3,$4)
        on conflict (request_id,actor_id) do nothing`, [who.tenantId, requestId, actorId, who.actorId]);
      await event(client, who, requestId, 'access_shared', { actorId });
    }
    return { requestId, actorId, shared: body.shared !== false };
  });
}

export async function decideRequest(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const who = await member(pool, principal); const decision = value(body.decision, 10); const note = value(body.note, 2000);
  if (!['approve', 'reject', 'return'].includes(decision)) throw new InvalidInput('choose approve, reject or return');
  if (decision !== 'approve' && !note) throw new InvalidInput('explain why this request is rejected or returned');
  return inTransaction(pool, async (client) => {
    const request = await requestRow(client, who.tenantId, requestId, true);
    if (request.status !== 'pending' || request.requester_id === who.actorId) throw new InvalidInput('this request cannot be decided by you');
    const type = (request.type_snapshot ?? (await client.query<RequestType>('select * from general_request_type where id=$1', [request.type_id])).rows[0]) as RequestType;
    const { rows } = await client.query<{ id: number; approvers: string[]; required: number; position: number; status: string; offices: { unitId: string; officeTypeId: string }[]; name: string }>(
      `select s.id,s.approvers,s.required,s.position,s.status,s.offices,s.name from general_request_step s
        where s.request_id=$1 and s.round=$2 and s.stage=$3 and s.status='pending' and $4=any(s.approvers)
          and not exists (select 1 from general_request_vote v where v.step_id=s.id and v.actor_id=$4)
        order by s.position limit 1 for update`, [requestId, request.round, request.current_step, who.actorId]);
    const step = rows[0]; if (!step) throw new InvalidInput('you are not a named approver for a step that is open');
    // An office's mandate caps what its holder may approve in that office.
    const held = await holdingsAt(client, who.tenantId, who.actorId, step.offices ?? []);
    if (decision === 'approve' && held.length && type.amount_field) {
      const amount = Number(request.answers[type.amount_field] ?? 0);
      const limits = held.map((h) => (h.mandate_limit === null ? Infinity : Number(h.mandate_limit)));
      const best = Math.max(...limits);
      if (Number.isFinite(amount) && amount > best) throw new InvalidInput(`your mandate as ${held[0]!.office} of ${held[0]!.unit} is up to ${best.toLocaleString()}; this request is ${amount.toLocaleString()}`);
    }
    await client.query('insert into general_request_vote (step_id,actor_id,decision,note) values ($1,$2,$3,$4)', [step.id, who.actorId, decision, note || null]);
    await event(client, who, requestId, 'decision', { step: step.name, decision, note, ...(held.length ? { as: held.map((h) => ({ office: h.office, unit: h.unit, acting: h.acting })) } : {}) });
    if (decision !== 'approve') {
      const status = decision === 'return' ? 'returned' : 'rejected';
      await client.query('update general_request_step set status=$2,closed_at=now() where id=$1', [step.id, status]);
      await client.query(`update general_request_step set status='closed',closed_at=now() where request_id=$1 and round=$2 and status in ('pending','waiting')`, [requestId, request.round]);
      await client.query('update general_request set status=$2,updated_at=now() where id=$1', [requestId, status]);
      return { id: requestId, status };
    }
    const { rows: votes } = await client.query<{ n: number }>("select count(*)::int as n from general_request_vote where step_id=$1 and decision='approve'", [step.id]);
    if (votes[0]!.n < step.required) return { id: requestId, status: 'pending', approvals: votes[0]!.n, required: step.required };
    await client.query("update general_request_step set status='approved',closed_at=now() where id=$1", [step.id]);
    // The stage is done when every step in it is approved (or not needed, or skipped).
    const { rows: open } = await client.query<{ n: number }>(`select count(*)::int as n from general_request_step where request_id=$1 and round=$2 and stage=$3 and status='pending'`, [requestId, request.round, request.current_step]);
    if (open[0]!.n) return { id: requestId, status: 'pending', stageOpen: open[0]!.n };
    if (await openFrom(client, request, type, request.current_step + 1, who.actorId)) {
      const { rows: names } = await client.query<{ name: string }>(`select name from general_request_step where request_id=$1 and round=$2 and status='pending' order by position`, [requestId, request.round]);
      return { id: requestId, status: 'pending', next: names.map((n) => n.name) };
    }
    await client.query("update general_request set status='approved',updated_at=now() where id=$1", [requestId]);
    await event(client, who, requestId, 'approved');
    return { id: requestId, status: 'approved' };
  });
}

/**
 * An office changed hands. Every open step addressed to it is worked out
 * again, so it waits with whoever holds the office now.
 */
export async function rerouteGeneralOffice(client: Client, tenantId: string, unitId: string, officeTypeId: string): Promise<number> {
  const { rows } = await client.query<{ id: number; request_id: string; position: number; stage: number; approvers: string[]; name: string }>(
    `select id, request_id, position, stage, approvers, name from general_request_step where tenant_id = $1 and status = 'pending' and offices @> $2::jsonb`, [tenantId, JSON.stringify([{ unitId, officeTypeId }])]);
  let moved = 0;
  for (const s of rows) {
    const request = await requestRow(client, tenantId, s.request_id);
    const type = request.type_snapshot; if (!type) continue;
    const step = type.steps[s.position]; if (!step) continue;
    const r = await resolveStep(client, { tenantId, requesterId: request.requester_id, step, earlier: await earlierApprovers(client, request.id, request.round, s.stage) });
    if (r.skip || !r.approvers.length || [...r.approvers].sort().join() === [...s.approvers].sort().join()) continue;
    await client.query('update general_request_step set approvers = $2, required = least(required, $3), offices = $4 where id = $1', [s.id, r.approvers, Math.max(1, r.approvers.length), JSON.stringify(r.offices)]);
    await event(client, { tenantId, actorId: null }, request.id, 'rerouted', { step: s.name, reason: 'the holder of the office changed' });
    moved++;
  }
  return moved;
}

// ------------------------------------------------------------------ files

export async function uploadFile(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const who = await member(pool, principal); const request = await requestRow(pool, who.tenantId, requestId);
  if (request.requester_id !== who.actorId || !['draft', 'returned'].includes(request.status)) throw new InvalidInput('files can be added while you prepare this request');
  const { rows: types } = await pool.query<RequestType>('select * from general_request_type where id=$1', [request.type_id]);
  const documentKey = value(body.documentKey, 40) || null;
  if (documentKey && !(types[0]?.documents ?? []).some((d) => d.key === documentKey)) throw new InvalidInput('this request type does not ask for that document');
  if (!documentKey && types[0]?.attachment_rule === 'none') throw new InvalidInput('this request type does not accept attachments');
  const filename = value(body.filename, 180); const raw = typeof body.base64 === 'string' ? body.base64 : '';
  const MAX = 10 * 1024 * 1024;
  if (!filename || !raw || raw.length > Math.ceil(MAX * 4 / 3) + 8) throw new InvalidInput('choose a file up to 10 MB');
  const bytes = Buffer.from(raw, 'base64'); if (!bytes.length || bytes.length > MAX) throw new InvalidInput('choose a file up to 10 MB');
  const id = randomUUID(); const key = `general-approvals/${who.tenantId}/${requestId}/${id}`; const sha = createHash('sha256').update(bytes).digest('hex');
  await objectStore().put(key, bytes, 'application/octet-stream', { sha256: sha });
  await pool.query('insert into general_request_file (id,tenant_id,request_id,filename,byte_size,sha256,storage_key,uploaded_by,document_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, who.tenantId, requestId, filename, bytes.length, sha, key, who.actorId, documentKey]);
  return { id, filename, documentKey, status: 'scanning' };
}
export async function fileLink(pool: Pool, principal: Principal, requestId: string, fileId: string) {
  const who = await member(pool, principal); const request = await requestRow(pool, who.tenantId, requestId);
  if (!(await visible(pool, who, request))) throw new InvalidInput('this file is not assigned to you');
  const { rows } = await pool.query<{ filename: string; storage_key: string }>('select filename,storage_key from general_request_file where id=$1 and request_id=$2 and tenant_id=$3', [fileId, requestId, who.tenantId]);
  const file = rows[0]; if (!file) throw new InvalidInput('no such file');
  const store = objectStore(); const scan = await store.scan(file.storage_key);
  if (scan !== 'clean') throw new InvalidInput(scan === 'scanning' ? 'The file is still being checked. Try again shortly.' : 'The file did not pass its malware check.');
  return { url: await store.link(file.storage_key, { filename: file.filename, contentType: 'application/octet-stream' }), filename: file.filename };
}

// ------------------------------------------------------ church request types

/** Request types a church starts with: a station's expenditure, use of a facility, and access to a system. */
export async function seedChurchRequestTypes(client: Client, tenantId: string, createdBy: string | null) {
  // The full default set, so the admin sees every category, not only the ones these types use.
  let order = 0;
  for (const name of DEFAULT_CATEGORIES) await client.query('insert into general_request_category (tenant_id, name, sort) values ($1, $2, $3) on conflict do nothing', [tenantId, name, order += 10]);
  const cat = async (name: string) => {
    await client.query('insert into general_request_category (tenant_id, name, sort) values ($1, $2, $3) on conflict do nothing', [tenantId, name, DEFAULT_CATEGORIES.indexOf(name) * 10 + 10]);
    return (await client.query<{ id: string }>('select id from general_request_category where tenant_id = $1 and name = $2', [tenantId, name])).rows[0]!.id;
  };
  const types: { seed: string; name: string; category: string; description: string; fields: Field[]; amount: string | null; documents: Doc[]; steps: Step[]; attachments: string }[] = [
    { seed: 'church_expenditure', name: 'Station expenditure', category: 'Finance', attachments: 'optional', amount: 'amount',
      description: 'Spending by a station. The Resident Pastor approves; the CMC reviews larger amounts alongside; it goes up the line as the amount grows.',
      fields: [{ key: 'amount', label: 'Amount', type: 'number', required: true }, { key: 'purpose', label: 'What is it for?', type: 'long_text', required: true }, { key: 'vendor', label: 'Who will be paid?', type: 'short_text', required: false }, { key: 'needed_by', label: 'Needed by', type: 'date', required: false }],
      documents: [{ key: 'quotation', label: 'Quotation', when: { field: 'amount', op: 'gte', value: 5000 } }, { key: 'cmc_minutes', label: 'CMC minutes approving it', when: { field: 'amount', op: 'gte', value: 20000 } }],
      steps: [
        { name: 'Resident Pastor', responsible: [{ kind: 'office', office: 'resident_pastor' }], mode: 'any' },
        { name: 'CMC review', responsible: [{ kind: 'committee', committee: 'cmc' }], mode: 'majority', parallel: true, when: { field: 'amount', op: 'gte', value: 5000 } },
        { name: 'Area Pastor', responsible: [{ kind: 'office', office: 'area_pastor' }], mode: 'any', when: { field: 'amount', op: 'gte', value: 1000 } },
        { name: 'Zonal Pastor', responsible: [{ kind: 'office', office: 'zonal_pastor' }], mode: 'any', when: { field: 'amount', op: 'gte', value: 5000 } },
        { name: 'District Pastor', responsible: [{ kind: 'office', office: 'district_pastor' }], mode: 'any', when: { field: 'amount', op: 'gte', value: 20000 } },
        { name: 'National Pastor', responsible: [{ kind: 'office', office: 'national_pastor' }], mode: 'any', sameApprover: 'independent', when: { field: 'amount', op: 'gte', value: 100000 } },
      ] },
    { seed: 'church_facility', name: 'Use of a church facility', category: 'Facilities', attachments: 'none', amount: null,
      description: 'Booking the auditorium, a hall or the grounds. The Church Administrator checks the calendar; the Resident Pastor approves.',
      fields: [{ key: 'facility', label: 'Which facility?', type: 'choice', required: true, choices: ['Main auditorium', 'Hall', 'Classroom', 'Grounds'] }, { key: 'date', label: 'Date', type: 'date', required: true }, { key: 'purpose', label: 'What is it for?', type: 'long_text', required: true }, { key: 'outside_group', label: 'Is it for a group outside the church?', type: 'yes_no', required: true }],
      documents: [],
      steps: [
        { name: 'Church Administrator', responsible: [{ kind: 'office', office: 'church_admin' }], mode: 'any' },
        { name: 'Resident Pastor', responsible: [{ kind: 'office', office: 'resident_pastor' }], mode: 'any' },
        { name: 'Area Pastor', responsible: [{ kind: 'office', office: 'area_pastor' }], mode: 'any', when: { field: 'outside_group', op: 'yes' } },
      ] },
    { seed: 'church_access', name: 'Access to a system', category: 'IT & access', attachments: 'none', amount: null,
      description: 'Access to a church system or shared account. Administrator access also needs the Area Admin.',
      fields: [{ key: 'system', label: 'Which system?', type: 'short_text', required: true }, { key: 'level', label: 'Access needed', type: 'choice', required: true, choices: ['View', 'Edit', 'Administrator'] }, { key: 'reason', label: 'Why do you need it?', type: 'long_text', required: true }],
      documents: [],
      steps: [
        { name: 'Church Administrator', responsible: [{ kind: 'office', office: 'church_admin' }], mode: 'any' },
        { name: 'Area Admin', responsible: [{ kind: 'office', office: 'area_admin' }], mode: 'any', when: { field: 'level', op: 'in', values: ['Administrator'] } },
      ] },
  ];
  for (const t of types) {
    await client.query(
      `insert into general_request_type (tenant_id, seed_key, name, description, fields, attachment_rule, steps, category_id, amount_field, documents, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (tenant_id, seed_key) do nothing`,
      [tenantId, t.seed, t.name, t.description, JSON.stringify(t.fields), t.attachments, JSON.stringify(t.steps), await cat(t.category), t.amount, JSON.stringify(t.documents), createdBy]);
  }
  return types.length;
}
