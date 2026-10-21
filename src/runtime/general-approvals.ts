/** Workspace requests that do not belong to a specialised module. */
import { createHash, randomUUID } from 'node:crypto';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { enabledModules } from './modules.js';
import { managerOf } from './org.js';
import { objectStore } from './object-store.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';

const value = (raw: unknown, max = 500) => typeof raw === 'string' ? raw.trim().slice(0, max) : '';
const UUID = /^[0-9a-f-]{36}$/;
type Field = { key: string; label: string; type: 'short_text' | 'long_text' | 'number' | 'date' | 'yes_no' | 'choice'; required: boolean; choices?: string[] };
type Rule = { kind: 'manager' | 'person' | 'team'; actorId?: string; team?: 'hr' | 'it' | 'facilities' | 'finance' };
type Step = { name: string; responsible: Rule[]; mode: 'any' | 'all' | 'quorum'; required?: number };
type RequestType = { id: string; tenant_id: string; name: string; description: string | null; fields: Field[]; attachment_rule: 'none' | 'optional' | 'required'; steps: Step[]; active: boolean };
type Request = { id: string; tenant_id: string; type_id: string; requester_id: string; title: string; answers: Record<string, unknown>; status: string; round: number; current_step: number; type_snapshot: RequestType | null };

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
function steps(raw: unknown): Step[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 8) throw new InvalidInput('add 1 to 8 approval steps');
  return raw.map((item, index) => {
    const s = (item ?? {}) as Record<string, unknown>; const name = value(s.name, 100);
    const mode = value(s.mode, 10) || 'any';
    if (!name || !['any', 'all', 'quorum'].includes(mode)) throw new InvalidInput(`approval step ${index + 1} needs a name and decision rule`);
    if (!Array.isArray(s.responsible) || !s.responsible.length || s.responsible.length > 20) throw new InvalidInput(`${name} needs at least one approver`);
    const responsible = s.responsible.map((item: unknown) => {
      const r = (item ?? {}) as Record<string, unknown>; const kind = value(r.kind, 20);
      if (kind === 'manager') return { kind } as Rule;
      if (kind === 'person' && UUID.test(value(r.actorId, 36))) return { kind, actorId: value(r.actorId, 36) } as Rule;
      if (kind === 'team' && ['hr', 'it', 'facilities', 'finance'].includes(value(r.team, 20))) return { kind, team: value(r.team, 20) as Rule['team'] } as Rule;
      throw new InvalidInput(`${name} has an invalid approver`);
    });
    const required = mode === 'quorum' ? Number(s.required) : undefined;
    if (mode === 'quorum' && (!Number.isInteger(required) || required! < 2 || required! > 20)) throw new InvalidInput(`${name} needs a quorum of 2 to 20 people`);
    return { name, responsible, mode: mode as Step['mode'], ...(required ? { required } : {}) };
  });
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
async function event(client: Client, who: { tenantId: string; actorId: string }, requestId: string, kind: string, detail: Record<string, unknown> = {}) {
  await client.query('insert into general_request_event (tenant_id,request_id,actor_id,kind,detail) values ($1,$2,$3,$4,$5)', [who.tenantId, requestId, who.actorId, kind, JSON.stringify(detail)]);
}
async function requestRow(pool: Pool | Client, tenantId: string, requestId: string, lock = false): Promise<Request> {
  const { rows } = await pool.query<Request>(`select * from general_request where id = $1 and tenant_id = $2${lock ? ' for update' : ''}`, [requestId, tenantId]);
  if (!rows[0]) throw new InvalidInput('no such request');
  return rows[0];
}
async function visible(pool: Pool | Client, who: { tenantId: string; actorId: string; admin: boolean }, request: Request) {
  if (who.admin || request.requester_id === who.actorId) return true;
  const { rows } = await pool.query('select 1 from general_request_step where request_id = $1 and $2 = any(approvers) limit 1', [request.id, who.actorId]);
  return !!rows[0];
}
export async function listTypes(pool: Pool, principal: Principal) {
  const who = await member(pool, principal);
  const { rows } = await pool.query<RequestType>('select * from general_request_type where tenant_id = $1 and (active or $2) order by name', [who.tenantId, who.admin]);
  return rows;
}
export async function saveType(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const who = await admin(pool, principal);
  const name = value(body.name, 120); if (!name) throw new InvalidInput('name this request type');
  const attachmentRule = value(body.attachmentRule, 12) || 'optional';
  if (!['none', 'optional', 'required'].includes(attachmentRule)) throw new InvalidInput('choose an attachment rule');
  const parsedFields = fields(body.fields); const parsedSteps = steps(body.steps);
  return inTransaction(pool, async (client) => {
    if (body.id) {
      const { rows } = await client.query<{ id: string }>(`update general_request_type set name=$3,description=$4,fields=$5,attachment_rule=$6,steps=$7,active=$8,updated_at=now() where id=$1 and tenant_id=$2 returning id`, [body.id, who.tenantId, name, value(body.description, 1000) || null, JSON.stringify(parsedFields), attachmentRule, JSON.stringify(parsedSteps), body.active !== false]);
      if (!rows[0]) throw new InvalidInput('no such request type');
      await recordWorkspaceAudit(client, { tenantId: who.tenantId, actorId: who.actorId, action: 'general_approvals.type_updated', targetId: rows[0].id, detail: { name } });
      return rows[0];
    }
    const { rows } = await client.query<{ id: string }>(`insert into general_request_type (tenant_id,name,description,fields,attachment_rule,steps,created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [who.tenantId, name, value(body.description, 1000) || null, JSON.stringify(parsedFields), attachmentRule, JSON.stringify(parsedSteps), who.actorId]);
    await recordWorkspaceAudit(client, { tenantId: who.tenantId, actorId: who.actorId, action: 'general_approvals.type_created', targetId: rows[0]!.id, detail: { name } });
    return rows[0];
  });
}
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
async function assignees(client: Client, who: { tenantId: string; actorId: string }, rule: Rule) {
  if (rule.kind === 'manager') {
    const manager = await managerOf(client, { tenantId: who.tenantId, actorId: who.actorId, at: new Date() });
    return manager ? [manager.id] : [];
  }
  if (rule.kind === 'person') {
    const { rows } = await client.query<{ id: string }>('select id from actor where id = $1 and tenant_id = $2 and active', [rule.actorId, who.tenantId]);
    return rows.map((r) => r.id);
  }
  const { rows } = await client.query<{ id: string }>('select a.id from hr_team_member t join actor a on a.id=t.actor_id where t.tenant_id=$1 and t.team=$2 and a.active', [who.tenantId, rule.team]);
  return rows.map((r) => r.id);
}
export async function submitRequest(pool: Pool, principal: Principal, requestId: string) {
  const who = await member(pool, principal);
  return inTransaction(pool, async (client) => {
    const request = await requestRow(client, who.tenantId, requestId, true);
    if (request.requester_id !== who.actorId || !['draft', 'returned'].includes(request.status)) throw new InvalidInput('only the requester can submit this draft');
    const { rows: types } = await client.query<RequestType>('select * from general_request_type where id=$1 and tenant_id=$2', [request.type_id, who.tenantId]);
    const type = types[0]!; if (!type.active) throw new InvalidInput('this request type is switched off');
    answersFor(type, request.answers, true);
    const { rows: fileCount } = await client.query<{ n: number }>('select count(*)::int as n from general_request_file where request_id=$1', [requestId]);
    if (type.attachment_rule === 'required' && !fileCount[0]?.n) throw new InvalidInput('attach a file before submitting');
    if (type.attachment_rule === 'none' && fileCount[0]?.n) throw new InvalidInput('this request type does not accept attachments');
    const nextRound = request.round + 1;
    for (let index = 0; index < type.steps.length; index++) {
      const step = type.steps[index]!; const ids = new Set<string>();
      for (const rule of step.responsible) for (const id of await assignees(client, who, rule)) if (id !== who.actorId) ids.add(id);
      const required = step.mode === 'all' ? ids.size : step.mode === 'quorum' ? step.required! : 1;
      if (!ids.size || required > ids.size) throw new InvalidInput(`${step.name} has no eligible approver. Ask an administrator to update its approval policy.`);
      await client.query(`insert into general_request_step (tenant_id,request_id,round,position,name,approvers,mode,required,status,opened_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [who.tenantId, requestId, nextRound, index, step.name, [...ids], step.mode, required, index === 0 ? 'pending' : 'waiting', index === 0 ? new Date() : null]);
    }
    await client.query(`update general_request set status='pending',type_snapshot=$2,round=$3,current_step=0,submitted_at=now(),updated_at=now() where id=$1`, [requestId, JSON.stringify(type), nextRound]);
    await event(client, who, requestId, 'submitted', { round: nextRound, steps: type.steps.length });
    return { id: requestId, status: 'pending' };
  });
}
export async function listRequests(pool: Pool, principal: Principal, scope: string) {
  const who = await member(pool, principal);
  if (!['mine', 'waiting', 'all'].includes(scope)) throw new InvalidInput('choose mine, waiting or all');
  if (scope === 'all' && !who.admin) throw new InvalidInput('only an administrator can see every request');
  const where = scope === 'mine' ? 'r.requester_id=$2' : scope === 'waiting' ? "r.status='pending' and exists (select 1 from general_request_step s where s.request_id=r.id and s.round=r.round and s.position=r.current_step and s.status='pending' and $2=any(s.approvers) and not exists (select 1 from general_request_vote v where v.step_id=s.id and v.actor_id=$2))" : 'true';
  const { rows } = await pool.query(`select r.id,r.title,r.status,r.created_at,r.updated_at,r.submitted_at,r.requester_id,r.current_step,t.name as type_name,a.display_name as requester,(select name from general_request_step s where s.request_id=r.id and s.round=r.round and s.position=r.current_step) as step_name from general_request r join general_request_type t on t.id=r.type_id join actor a on a.id=r.requester_id where r.tenant_id=$1 and ${where} order by r.updated_at desc limit 200`, scope === 'all' ? [who.tenantId] : [who.tenantId, who.actorId]);
  return rows;
}
export async function requestDetail(pool: Pool, principal: Principal, requestId: string) {
  const who = await member(pool, principal); const request = await requestRow(pool, who.tenantId, requestId);
  if (!(await visible(pool, who, request))) throw new InvalidInput('this request is not assigned to you');
  const [type, steps, events, files] = await Promise.all([
    pool.query<RequestType>('select * from general_request_type where id=$1', [request.type_id]),
    pool.query(`select s.id,s.round,s.position,s.name,s.mode,s.required,s.status,s.approvers,s.opened_at,s.closed_at,(select count(*)::int from general_request_vote v where v.step_id=s.id and v.decision='approve') as approvals,exists(select 1 from general_request_vote v where v.step_id=s.id and v.actor_id=$2) as viewer_voted from general_request_step s where s.request_id=$1 order by s.round,s.position`, [requestId, who.actorId]),
    pool.query(`select e.id,e.kind,e.detail,e.created_at,a.display_name as actor from general_request_event e left join actor a on a.id=e.actor_id where e.request_id=$1 order by e.id desc`, [requestId]),
    pool.query('select id,filename,byte_size,created_at from general_request_file where request_id=$1 order by created_at desc', [requestId]),
  ]);
  return { request, type: request.type_snapshot ?? type.rows[0], steps: steps.rows, events: events.rows, files: files.rows, viewer: { own: request.requester_id === who.actorId, admin: who.admin, canDecide: request.status === 'pending' && steps.rows.some((s: { round: number; position: number; status: string; approvers: string[]; viewer_voted: boolean }) => s.round === request.round && s.position === request.current_step && s.status === 'pending' && s.approvers.includes(who.actorId) && !s.viewer_voted) } };
}
export async function decideRequest(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const who = await member(pool, principal); const decision = value(body.decision, 10); const note = value(body.note, 2000);
  if (!['approve', 'reject', 'return'].includes(decision)) throw new InvalidInput('choose approve, reject or return');
  if (decision !== 'approve' && !note) throw new InvalidInput('explain why this request is rejected or returned');
  return inTransaction(pool, async (client) => {
    const request = await requestRow(client, who.tenantId, requestId, true);
    if (request.status !== 'pending' || request.requester_id === who.actorId) throw new InvalidInput('this request cannot be decided by you');
    const { rows } = await client.query<{ id: number; approvers: string[]; required: number; position: number; status: string }>(`select id,approvers,required,position,status from general_request_step where request_id=$1 and round=$2 and position=$3 for update`, [requestId, request.round, request.current_step]);
    const step = rows[0]; if (!step || step.status !== 'pending' || !step.approvers.includes(who.actorId)) throw new InvalidInput('you are not a named approver for this step');
    const voted = await client.query('select 1 from general_request_vote where step_id=$1 and actor_id=$2', [step.id, who.actorId]);
    if (voted.rows[0]) throw new InvalidInput('you have already decided this step');
    await client.query('insert into general_request_vote (step_id,actor_id,decision,note) values ($1,$2,$3,$4)', [step.id, who.actorId, decision, note || null]);
    await event(client, who, requestId, 'decision', { step: step.position + 1, decision, note });
    if (decision !== 'approve') {
      const status = decision === 'return' ? 'returned' : 'rejected';
      await client.query('update general_request_step set status=$2,closed_at=now() where id=$1', [step.id, status]);
      await client.query('update general_request set status=$2,updated_at=now() where id=$1', [requestId, status]);
      return { id: requestId, status };
    }
    const { rows: votes } = await client.query<{ n: number }>("select count(*)::int as n from general_request_vote where step_id=$1 and decision='approve'", [step.id]);
    if (votes[0]!.n < step.required) return { id: requestId, status: 'pending', approvals: votes[0]!.n, required: step.required };
    await client.query("update general_request_step set status='approved',closed_at=now() where id=$1", [step.id]);
    const next = await client.query<{ id: number; position: number }>("select id,position from general_request_step where request_id=$1 and round=$2 and position>$3 order by position limit 1", [requestId, request.round, step.position]);
    if (next.rows[0]) {
      await client.query("update general_request_step set status='pending',opened_at=now() where id=$1", [next.rows[0].id]);
      await client.query('update general_request set current_step=$2,updated_at=now() where id=$1', [requestId, next.rows[0].position]);
      return { id: requestId, status: 'pending', nextStep: next.rows[0].position };
    }
    await client.query("update general_request set status='approved',updated_at=now() where id=$1", [requestId]);
    return { id: requestId, status: 'approved' };
  });
}
export async function uploadFile(pool: Pool, principal: Principal, requestId: string, body: Record<string, unknown>) {
  const who = await member(pool, principal); const request = await requestRow(pool, who.tenantId, requestId);
  if (request.requester_id !== who.actorId || !['draft', 'returned'].includes(request.status)) throw new InvalidInput('files can be added while you prepare this request');
  const { rows: types } = await pool.query<RequestType>('select * from general_request_type where id=$1', [request.type_id]);
  if (types[0]?.attachment_rule === 'none') throw new InvalidInput('this request type does not accept attachments');
  const filename = value(body.filename, 180); const raw = typeof body.base64 === 'string' ? body.base64 : '';
  const MAX = 10 * 1024 * 1024;
  if (!filename || !raw || raw.length > Math.ceil(MAX * 4 / 3) + 8) throw new InvalidInput('choose a file up to 10 MB');
  const bytes = Buffer.from(raw, 'base64'); if (!bytes.length || bytes.length > MAX) throw new InvalidInput('choose a file up to 10 MB');
  const id = randomUUID(); const key = `general-approvals/${who.tenantId}/${requestId}/${id}`; const sha = createHash('sha256').update(bytes).digest('hex');
  await objectStore().put(key, bytes, 'application/octet-stream', { sha256: sha });
  await pool.query('insert into general_request_file (id,tenant_id,request_id,filename,byte_size,sha256,storage_key,uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8)', [id, who.tenantId, requestId, filename, bytes.length, sha, key, who.actorId]);
  return { id, filename, status: 'scanning' };
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
