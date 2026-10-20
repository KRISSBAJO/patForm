/**
 * The deeper HR record (PRD Module 7, second pass): a full employee profile
 * with contact and emergency details, a timeline built from everything that
 * happened to the person, files on the record, a file on each document that
 * is sent out, the leave calendar and ledger, and the org chart.
 *
 * Who sees what follows hr.ts: HR sees all of it; a manager sees their
 * reports' basic record, timeline entries meant for managers, and leave; a
 * person sees their own record and what HR chose to share with them. Pay
 * still comes only through the pay endpoint, for HR admins.
 */
import { createHash, randomUUID } from 'node:crypto';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import type { Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { objectStore } from './object-store.js';
import { balances, countryCode, currencyCode, currentManager, day, employeeFor, ensureLeaveTypes, hrSettings, id, num, ownedElsewhere, recordForActor, requireHr, requireHrAdmin, text, weekdays, who, type Who } from './hr.js';

const UUID = /^[0-9a-f-]{36}$/;
const MAX_FILE = 5 * 1024 * 1024;
const FILE_CATEGORIES = ['contract', 'identity', 'certificate', 'letter', 'payslip', 'other'] as const;
const EVENT_KINDS = ['note', 'recognition', 'warning', 'training', 'milestone', 'change'] as const;

type Tier = 'hr' | 'manager' | 'self';

/** How the caller stands to this person: HR, their current manager, or themselves. */
async function tierFor(client: Client | Pool, w: Who, employee: { actor_id: string | null }): Promise<Tier> {
  if (w.hr) return 'hr';
  if (employee.actor_id === w.actorId) return 'self';
  if (employee.actor_id && (await currentManager(client, w.tenantId, employee.actor_id)) === w.actorId) return 'manager';
  throw new InvalidInput('no such employee');
}

function sniff(bytes: Buffer, filename: string): string | null {
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 2).toString('ascii') === 'PK' && /\.docx$/i.test(filename)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return null;
}

function readUpload(body: Record<string, unknown>) {
  const filename = text(body.filename, 200); const base64 = typeof body.base64 === 'string' ? body.base64 : '';
  if (!filename || !base64 || base64.length > Math.ceil(MAX_FILE * 4 / 3) + 8) throw new InvalidInput('Choose a PDF, Word (.docx), JPEG, PNG or WebP file up to 5 MB.');
  const bytes = Buffer.from(base64, 'base64');
  const type = sniff(bytes, filename);
  if (!type || !bytes.length || bytes.length > MAX_FILE) throw new InvalidInput('Choose a PDF, Word (.docx), JPEG, PNG or WebP file up to 5 MB.');
  return { filename, bytes, type, sha: createHash('sha256').update(bytes).digest('hex') };
}

/** Refresh the stored scan state and hand out a short link, or say why not. */
async function linkFor(pool: Pool, table: 'employee_file' | 'hr_document', rowId: string, f: { storage_key: string; content_type: string; filename: string; scan_status: string }) {
  const store = objectStore();
  const scan = await store.scan(f.storage_key);
  const stored = scan === 'scanning' ? 'unscanned' : scan;
  if (stored !== f.scan_status) await pool.query(`update ${table} set scan_status = $2 where id = $1`, [rowId, stored]);
  if (scan === 'scanning') throw new InvalidInput('The file is still being checked for malware. Try again in a minute.');
  if (scan === 'quarantined') throw new InvalidInput('The file did not pass its malware check and cannot be shown.');
  return { url: await store.link(f.storage_key, { contentType: f.content_type, filename: f.filename }), filename: f.filename };
}

// ------------------------------------------------------------- the record

const PROFILE_COLS = `e.id, e.actor_id, e.email, e.name, e.employment_type, e.status, e.location, e.start_date::text, e.end_date::text, e.probation_end::text,
  e.payroll_ref, e.external_ref, e.branch_id, b.name as branch_name, b.country as branch_country, b.currency as branch_currency, b.timezone as branch_timezone, e.phone, e.personal_email, e.date_of_birth::text, e.address, e.emergency_name, e.emergency_phone, e.emergency_relation, e.grade, e.work_pattern, e.bio,
  e.created_at, e.updated_at, a.workspace_role, a.active, a.position_title, a.org_unit_id, u.name as unit_name,
  (select m.id from reporting_line r join actor m on m.id = r.manager_id where r.actor_id = e.actor_id and r.kind = 'primary' and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now()) limit 1) as manager_id,
  (select m.display_name from reporting_line r join actor m on m.id = r.manager_id where r.actor_id = e.actor_id and r.kind = 'primary' and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now()) limit 1) as manager_name`;

/** The whole record, trimmed to what the caller may see. */
export async function employeeDetail(pool: Pool, principal: Principal, employeeId: string) {
  const w = await who(pool, principal);
  if (!UUID.test(employeeId)) throw new InvalidInput('no such employee');
  const { rows } = await pool.query<Record<string, unknown> & { actor_id: string | null; id: string; start_date: string | null }>(
    `select ${PROFILE_COLS} from employee_record e left join actor a on a.id = e.actor_id left join org_unit u on u.id = a.org_unit_id left join hr_branch b on b.id = e.branch_id where e.id = $1 and e.tenant_id = $2`, [employeeId, w.tenantId]);
  const e = rows[0];
  if (!e) throw new InvalidInput('no such employee');
  const tier = await tierFor(pool, w, e);
  const year = new Date().getUTCFullYear();
  const basic = ['id', 'actor_id', 'email', 'name', 'employment_type', 'status', 'location', 'start_date', 'end_date', 'probation_end', 'workspace_role', 'active', 'position_title', 'org_unit_id', 'unit_name', 'manager_id', 'manager_name', 'grade', 'work_pattern', 'bio', 'branch_id', 'branch_name', 'branch_country', 'branch_timezone'];
  const profile: Record<string, unknown> = tier === 'manager' ? Object.fromEntries(basic.map((k) => [k, e[k]])) : { ...e };
  const [history, leave, requests, cases, certs, files, events, reports, docs] = await Promise.all([
    pool.query(`select r.kind, r.effective_from, r.effective_to, m.display_name as manager from reporting_line r join actor m on m.id = r.manager_id where r.tenant_id = $1 and r.actor_id = $2 order by r.effective_from desc`, [w.tenantId, e.actor_id]),
    balances(pool, w.tenantId, e.id, year),
    pool.query(`select r.id, t.name as type, r.start_date::text, r.end_date::text, r.days, r.status, r.reason, r.decision_note from leave_request r join leave_type t on t.id = r.leave_type_id where r.employee_id = $1 order by r.start_date desc limit 30`, [e.id]),
    tier === 'self' ? Promise.resolve({ rows: [] }) : pool.query(`select c.id, c.kind, c.status, c.effective_date::text, c.created_at, c.restricted from lifecycle_case c where c.employee_id = $1 and ($2 or not c.restricted) order by c.created_at desc`, [e.id, tier === 'hr']),
    pool.query('select id, name, expires_on::text from employee_certification where employee_id = $1 order by expires_on', [e.id]),
    tier === 'manager' ? Promise.resolve({ rows: [] }) : pool.query(`select f.id, f.category, f.title, f.filename, f.content_type, f.byte_size, f.scan_status, f.employee_can_see, f.created_at, a.display_name as uploaded_by from employee_file f left join actor a on a.id = f.uploaded_by where f.employee_id = $1 and ($2 or f.employee_can_see) order by f.created_at desc`, [e.id, tier === 'hr']),
    pool.query(`select v.id, v.kind, v.title, v.detail, v.visibility, v.occurred_on::text, v.created_at, a.display_name as by from employee_event v left join actor a on a.id = v.created_by where v.employee_id = $1 and v.visibility = any($2::text[]) order by v.occurred_on desc, v.created_at desc`,
      [e.id, tier === 'hr' ? ['hr', 'manager', 'employee'] : tier === 'manager' ? ['manager', 'employee'] : ['employee']]),
    pool.query(`select a.id, a.display_name as name, a.position_title from reporting_line r join actor a on a.id = r.actor_id where r.tenant_id = $1 and r.manager_id = $2 and r.kind = 'primary' and r.effective_to is null and a.active order by a.display_name`, [w.tenantId, e.actor_id]),
    tier === 'manager' ? Promise.resolve({ rows: [] }) : pool.query(`select q.id, d.title, d.version, d.kind, q.status, q.due_date::text, q.acknowledged_at, (d.storage_key is not null) as has_file, d.id as document_id from document_request q join hr_document d on d.id = q.document_id where q.employee_id = $1 order by q.created_at desc`, [e.id]),
  ]);
  const timeline = await timelineFor(pool, w.tenantId, e, tier);
  return { tier, profile, reportingHistory: history.rows, leave: { year, balances: leave, requests: requests.rows }, cases: cases.rows, certifications: certs.rows, files: files.rows, events: events.rows, reports: reports.rows, documents: docs.rows, timeline };
}

/** My own record. */
export async function myProfile(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const employeeId = await recordForActor(pool, w.tenantId, w.actorId);
  return employeeDetail(pool, principal, employeeId);
}

const SELF_FIELDS = ['phone', 'personalEmail', 'address', 'emergencyName', 'emergencyPhone', 'emergencyRelation', 'bio'] as const;
const HR_FIELDS = [...SELF_FIELDS, 'dateOfBirth', 'grade', 'workPattern', 'location', 'startDate', 'endDate', 'probationEnd', 'externalRef', 'employmentType'] as const;
const COL: Record<string, string> = { phone: 'phone', personalEmail: 'personal_email', address: 'address', emergencyName: 'emergency_name', emergencyPhone: 'emergency_phone', emergencyRelation: 'emergency_relation', bio: 'bio', dateOfBirth: 'date_of_birth', grade: 'grade', workPattern: 'work_pattern', location: 'location', startDate: 'start_date', endDate: 'end_date', probationEnd: 'probation_end', externalRef: 'external_ref', employmentType: 'employment_type' };
const LIMIT: Record<string, number> = { phone: 40, personalEmail: 254, address: 500, emergencyName: 120, emergencyPhone: 40, emergencyRelation: 60, bio: 1000, grade: 40, workPattern: 120, location: 120, externalRef: 120, employmentType: 20 };

/** Contact, emergency and employment details. A person edits their own contact details; HR edits everything. Name, status, pay and payroll reference keep their own paths. */
export async function updateProfile(pool: Pool, principal: Principal, employeeId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const e = await employeeFor(client, w.tenantId, employeeId);
    const tier = await tierFor(client, w, e);
    if (tier === 'manager') throw new InvalidInput('only HR or the person themselves can change the record');
    const allowed: readonly string[] = tier === 'hr' ? HR_FIELDS : SELF_FIELDS;
    const sets: string[] = []; const params: unknown[] = [e.id]; const changed: string[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (!allowed.includes(k)) { if ((HR_FIELDS as readonly string[]).includes(k)) throw new InvalidInput(`only HR can change ${k}`); continue; }
      let value: unknown;
      if (['dateOfBirth', 'startDate', 'endDate', 'probationEnd'].includes(k)) value = day(v, k);
      else if (k === 'employmentType') { value = text(v, 20); if (!['employee', 'contractor', 'intern'].includes(value as string)) throw new InvalidInput('employmentType must be employee, contractor or intern'); }
      else if (k === 'personalEmail') { value = text(v, 254).toLowerCase() || null; if (value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value as string)) throw new InvalidInput('personalEmail must be an email address'); }
      else value = text(v, LIMIT[k]!) || null;
      params.push(value); sets.push(`${COL[k]} = $${params.length}`); changed.push(k);
    }
    if (!sets.length) throw new InvalidInput('nothing to change');
    await client.query(`update employee_record set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
    await client.query(`insert into employee_event (tenant_id, employee_id, kind, title, detail, visibility, created_by) values ($1, $2, 'change', $3, $4, 'hr', $5)`,
      [w.tenantId, e.id, tier === 'self' ? 'Updated their own details' : 'Record updated by HR', changed.join(', '), w.actorId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.profile_updated', targetId: e.id, detail: { fields: changed, self: tier === 'self' } });
    return { id: e.id, changed };
  });
}

/** A note, recognition, warning, training or milestone on the record, with who may see it. */
export async function addEmployeeEvent(pool: Pool, principal: Principal, employeeId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const e = await employeeFor(pool, w.tenantId, employeeId);
  const tier = await tierFor(pool, w, e);
  if (tier === 'self') throw new InvalidInput('only HR or your manager can add to the record');
  const kind = text(body.kind, 20);
  if (!(EVENT_KINDS as readonly string[]).includes(kind)) throw new InvalidInput(`kind must be one of ${EVENT_KINDS.join(', ')}`);
  if (tier === 'manager' && ['warning', 'change'].includes(kind)) throw new InvalidInput('only HR records a warning');
  const title = text(body.title, 200);
  if (!title) throw new InvalidInput('give it a title');
  const visibility = text(body.visibility, 12) || (tier === 'manager' ? 'manager' : 'hr');
  if (!['hr', 'manager', 'employee'].includes(visibility)) throw new InvalidInput('visibility must be hr, manager or employee');
  if (tier === 'manager' && visibility === 'hr') throw new InvalidInput('a manager\'s note is seen by managers and HR, or by the person too');
  const occurredOn = day(body.occurredOn, 'occurredOn') ?? new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query<{ id: string }>(
    `insert into employee_event (tenant_id, employee_id, kind, title, detail, visibility, occurred_on, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [w.tenantId, e.id, kind, title, text(body.detail, 2000) || null, visibility, occurredOn, w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.event_added', targetId: e.id, detail: { kind, visibility } });
  return { id: rows[0]!.id };
}

type TimelineItem = { on: string; kind: string; title: string; detail: string | null; by?: string | null };

/** Everything that happened to the person, in one list, filtered to the caller's tier. */
async function timelineFor(pool: Pool, tenantId: string, e: { id: string; actor_id: string | null; start_date: string | null; name?: unknown }, tier: Tier): Promise<TimelineItem[]> {
  const hr = tier === 'hr';
  const { rows } = await pool.query<TimelineItem>(
    `select * from (
       select v.occurred_on::text as on, v.kind, v.title, v.detail, a.display_name as by from employee_event v left join actor a on a.id = v.created_by
         where v.employee_id = $1 and v.visibility = any($3::text[])
       union all
       select coalesce(c.effective_date, c.created_at::date)::text, 'case', initcap(replace(c.kind, '_', ' ')) || case when c.status = 'closed' then ' completed' else ' started' end, c.summary, null
         from lifecycle_case c where c.employee_id = $1 and ($2 or (not c.restricted and $4))
       union all
       select r.start_date::text, 'leave', t.name || ' · ' || r.days || ' day' || case when r.days = 1 then '' else 's' end || ' · ' || r.status, r.reason, null
         from leave_request r join leave_type t on t.id = r.leave_type_id where r.employee_id = $1 and r.status in ('approved', 'rejected')
       union all
       select q.acknowledged_at::date::text, 'document', d.title || ' v' || d.version, q.statement, null
         from document_request q join hr_document d on d.id = q.document_id where q.employee_id = $1 and q.status = 'acknowledged' and $5
       union all
       select c.effective_from::text, 'pay', 'Pay set', c.reason, a.display_name from employee_compensation c left join actor a on a.id = c.entered_by where c.employee_id = $1 and $2
       union all
       select c.created_at::date::text, 'certification', c.name, 'expires ' || c.expires_on::text, null from employee_certification c where c.employee_id = $1
       union all
       select r.effective_from::date::text, 'manager', 'Reports to ' || m.display_name, case when r.effective_to is null then null else 'until ' || r.effective_to::date::text end, null
         from reporting_line r join actor m on m.id = r.manager_id where r.tenant_id = $6 and r.actor_id = $7 and r.kind = 'primary'
       union all
       select f.created_at::date::text, 'file', f.title, f.filename, a.display_name from employee_file f left join actor a on a.id = f.uploaded_by where f.employee_id = $1 and ($2 or (f.employee_can_see and $5))
     ) x order by x.on desc, x.kind`,
    [e.id, hr, hr ? ['hr', 'manager', 'employee'] : tier === 'manager' ? ['manager', 'employee'] : ['employee'], tier === 'manager', tier !== 'manager', tenantId, e.actor_id]);
  if (e.start_date) rows.push({ on: e.start_date, kind: 'joined', title: 'Joined', detail: null });
  return rows.sort((a, b) => (a.on < b.on ? 1 : a.on > b.on ? -1 : 0));
}

// ------------------------------------------------------------------ files

/** A file on the record: contract, identity check, certificate, letter, payslip. HR only; HR chooses whether the person can see it. */
export async function uploadEmployeeFile(pool: Pool, principal: Principal, employeeId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const e = await employeeFor(pool, w.tenantId, employeeId);
  const category = text(body.category, 20) || 'other';
  if (!(FILE_CATEGORIES as readonly string[]).includes(category)) throw new InvalidInput(`category must be one of ${FILE_CATEGORIES.join(', ')}`);
  const up = readUpload(body);
  const title = text(body.title, 200) || up.filename.replace(/\.[a-z0-9]+$/i, '');
  const fileId = randomUUID(); const key = `hr/files/${w.tenantId}/${fileId}`;
  await objectStore().put(key, up.bytes, up.type, { sha256: up.sha });
  await pool.query(
    `insert into employee_file (id, tenant_id, employee_id, category, title, filename, content_type, byte_size, sha256, storage_key, employee_can_see, uploaded_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [fileId, w.tenantId, e.id, category, title, up.filename, up.type, up.bytes.length, up.sha, key, body.employeeCanSee === true, w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.file_added', targetId: e.id, detail: { category, fileId } });
  return { id: fileId, title, filename: up.filename, sha256: up.sha, status: 'scanning' as const };
}

export async function employeeFileLink(pool: Pool, principal: Principal, fileId: string) {
  const w = await who(pool, principal);
  if (!UUID.test(fileId)) throw new InvalidInput('no such file');
  const { rows } = await pool.query<{ storage_key: string; content_type: string; filename: string; scan_status: string; employee_can_see: boolean; actor_id: string | null }>(
    `select f.storage_key, f.content_type, f.filename, f.scan_status, f.employee_can_see, e.actor_id from employee_file f join employee_record e on e.id = f.employee_id where f.id = $1 and f.tenant_id = $2`, [fileId, w.tenantId]);
  const f = rows[0];
  if (!f || !(w.hr || (f.employee_can_see && f.actor_id === w.actorId))) throw new InvalidInput('no such file');
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.file_opened', targetId: fileId, detail: {} });
  return linkFor(pool, 'employee_file', fileId, f);
}

export async function setEmployeeFileVisibility(pool: Pool, principal: Principal, fileId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const { rowCount } = await pool.query('update employee_file set employee_can_see = $3 where id = $1 and tenant_id = $2', [fileId, w.tenantId, body.employeeCanSee === true]);
  if (!rowCount) throw new InvalidInput('no such file');
  return { id: fileId, employeeCanSee: body.employeeCanSee === true };
}

export async function removeEmployeeFile(pool: Pool, principal: Principal, fileId: string) {
  const w = await who(pool, principal); requireHrAdmin(w);
  const { rows } = await pool.query<{ storage_key: string; employee_id: string }>('delete from employee_file where id = $1 and tenant_id = $2 returning storage_key, employee_id', [fileId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such file');
  await objectStore().remove(rows[0].storage_key).catch(() => undefined);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.file_removed', targetId: rows[0].employee_id, detail: { fileId } });
  return { id: fileId, removed: true };
}

/** The document itself, attached to an HR document people confirm or agree to. */
export async function uploadDocumentFile(pool: Pool, principal: Principal, documentId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const { rows } = await pool.query<{ storage_key: string | null }>('select storage_key from hr_document where id = $1 and tenant_id = $2', [documentId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such document');
  const up = readUpload(body);
  const key = `hr/documents/${w.tenantId}/${documentId}/${randomUUID()}`;
  await objectStore().put(key, up.bytes, up.type, { sha256: up.sha });
  await pool.query(`update hr_document set storage_key = $2, filename = $3, content_type = $4, byte_size = $5, sha256 = $6, scan_status = 'unscanned' where id = $1`, [documentId, key, up.filename, up.type, up.bytes.length, up.sha]);
  if (rows[0].storage_key) await objectStore().remove(rows[0].storage_key).catch(() => undefined);
  return { id: documentId, filename: up.filename, sha256: up.sha, status: 'scanning' as const };
}

/** HR, or anyone the document was sent to, opens it. */
export async function documentFileLink(pool: Pool, principal: Principal, documentId: string) {
  const w = await who(pool, principal);
  if (!UUID.test(documentId)) throw new InvalidInput('no such document');
  const { rows } = await pool.query<{ storage_key: string | null; content_type: string; filename: string; scan_status: string }>('select storage_key, content_type, filename, scan_status from hr_document where id = $1 and tenant_id = $2', [documentId, w.tenantId]);
  const d = rows[0];
  if (!d?.storage_key) throw new InvalidInput('this document has no file attached');
  if (!w.hr) {
    const employeeId = await recordForActor(pool, w.tenantId, w.actorId);
    const { rows: sent } = await pool.query('select 1 from document_request where document_id = $1 and employee_id = $2', [documentId, employeeId]);
    if (!sent[0]) throw new InvalidInput('no such document');
  }
  return linkFor(pool, 'hr_document', documentId, { ...d, storage_key: d.storage_key });
}

// ------------------------------------------------------------------ leave

/** Everyone away in a month, as the caller may see it: HR the whole workspace; others their unit, their reports and themselves. */
export async function leaveCalendar(pool: Pool, principal: Principal, month: string) {
  const w = await who(pool, principal);
  if (w.role === 'pre_hire') throw new InvalidInput('leave starts after your first day');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new InvalidInput('month must be YYYY-MM');
  const first = `${month}-01`;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const { rows: holidays } = await pool.query<{ day: string; name: string; branch: string | null }>('select h.day::text, h.name, b.name as branch from public_holiday h left join hr_branch b on b.id = h.branch_id where h.tenant_id = $1 and h.day between $2 and $3 order by h.day', [w.tenantId, first, last]);
  const { rows } = await pool.query<{ id: string; employee_id: string; name: string; unit: string | null; type: string; start_date: string; end_date: string; days: string; status: string; mine: boolean }>(
    `select r.id, e.id as employee_id, e.name, u.name as unit, br.name as branch, t.name as type, r.start_date::text, r.end_date::text, r.days, r.status, (e.actor_id = $4) as mine
       from leave_request r join employee_record e on e.id = r.employee_id join leave_type t on t.id = r.leave_type_id
       left join actor a on a.id = e.actor_id left join org_unit u on u.id = a.org_unit_id left join hr_branch br on br.id = e.branch_id
      where r.tenant_id = $1 and r.status in ('approved', 'requested') and r.start_date <= $3 and r.end_date >= $2
        and ($5 or e.actor_id = $4
             or (a.org_unit_id is not null and a.org_unit_id = (select org_unit_id from actor where id = $4))
             or exists (select 1 from reporting_line l where l.actor_id = e.actor_id and l.manager_id = $4 and l.kind = 'primary' and l.effective_to is null))
      order by r.start_date, e.name`, [w.tenantId, first, last, w.actorId, w.hr]);
  return { month, first, last, holidays, away: rows.map((r) => ({ ...r, days: Number(r.days) })), scope: w.hr ? 'workspace' : 'team' };
}

/** HR corrects a balance with a reason: days in lieu, a carried-over agreement, a deduction. */
export async function adjustLeave(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const employeeId = id(body.employeeId, 'employeeId');
  const typeKey = text(body.type, 30);
  const year = Math.trunc(num(body.year ?? new Date().getUTCFullYear()));
  const days = num(body.days);
  const reason = text(body.reason, 300);
  if (!(year >= 2000 && year <= 2100)) throw new InvalidInput('give the year');
  if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 366) throw new InvalidInput('days must be a non-zero number of days, negative to deduct');
  if (!reason) throw new InvalidInput('say why');
  return inTransaction(pool, async (client) => {
    const e = await employeeFor(client, w.tenantId, employeeId);
    await ensureLeaveTypes(client, w.tenantId);
    const { rows: t } = await client.query<{ id: string }>('select id from leave_type where tenant_id = $1 and key = $2', [w.tenantId, typeKey]);
    if (!t[0]) throw new InvalidInput('no such leave type');
    if (await ownedElsewhere(client, w, e.id, 'leave_balance', null, `${typeKey} ${year}: ${days > 0 ? '+' : ''}${days} (${reason})`)) return { queuedForReconciliation: true };
    await client.query('insert into leave_adjustment (tenant_id, employee_id, leave_type_id, year, days, reason, entered_by) values ($1, $2, $3, $4, $5, $6, $7)', [w.tenantId, e.id, t[0].id, year, days, reason, w.actorId]);
    await client.query(`insert into employee_event (tenant_id, employee_id, kind, title, detail, visibility, created_by) values ($1, $2, 'change', $3, $4, 'employee', $5)`,
      [w.tenantId, e.id, `Leave balance ${days > 0 ? 'increased' : 'reduced'} by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`, reason, w.actorId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.leave_adjusted', targetId: e.id, detail: { typeKey, year, days } });
    return { queuedForReconciliation: false };
  });
}

/** The ledger behind a balance: entitlement, accrual, carry-over, each adjustment and each request. */
export async function leaveLedger(pool: Pool, principal: Principal, employeeId: string | null, year: number) {
  const w = await who(pool, principal);
  const targetId = employeeId ?? (await recordForActor(pool, w.tenantId, w.actorId));
  const e = await employeeFor(pool, w.tenantId, targetId);
  await tierFor(pool, w, e);
  const y = year >= 2000 && year <= 2100 ? year : new Date().getUTCFullYear();
  const [bal, adj, req] = await Promise.all([
    balances(pool, w.tenantId, e.id, y),
    pool.query(`select j.id, t.key as type, j.days, j.reason, j.created_at, a.display_name as by from leave_adjustment j join leave_type t on t.id = j.leave_type_id left join actor a on a.id = j.entered_by where j.employee_id = $1 and j.year = $2 order by j.created_at desc`, [e.id, y]),
    pool.query(`select r.id, t.key as type, t.name as type_name, r.start_date::text, r.end_date::text, r.days, r.status, r.reason, r.decision_note from leave_request r join leave_type t on t.id = r.leave_type_id where r.employee_id = $1 and extract(year from r.start_date) = $2 order by r.start_date`, [e.id, y]),
  ]);
  const owner = (await hrSettings(pool, w.tenantId)).fieldOwners.leave_balance;
  return { employeeId: e.id, name: e.name, year: y, balances: bal, adjustments: adj.rows, requests: req.rows.map((r) => ({ ...r, days: Number(r.days) })), balanceOwner: owner };
}

// -------------------------------------------------------------- org chart

type Node = { id: string; actorId: string | null; name: string; title: string | null; unit: string | null; branch: string | null; status: string | null; email: string; reports: Node[] };

/** The reporting tree, every active member with their employee record alongside. */
export async function orgTree(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query<{ actor_id: string; name: string; email: string; title: string | null; unit: string | null; branch: string | null; status: string | null; employee_id: string | null; manager_id: string | null }>(
    `select a.id as actor_id, a.display_name as name, a.email, a.position_title as title, u.name as unit, br.name as branch, e.status, e.id as employee_id,
            (select r.manager_id from reporting_line r where r.actor_id = a.id and r.kind = 'primary' and r.effective_to is null limit 1) as manager_id
       from actor a left join org_unit u on u.id = a.org_unit_id left join employee_record e on e.actor_id = a.id left join hr_branch br on br.id = e.branch_id
      where a.tenant_id = $1 and a.active and a.workspace_role not in ('auditor') order by a.display_name`, [w.tenantId]);
  const nodes = new Map<string, Node>(rows.map((r) => [r.actor_id, { id: r.employee_id ?? r.actor_id, actorId: r.actor_id, name: r.name, title: r.title, unit: r.unit, branch: r.branch, status: r.status, email: r.email, reports: [] }]));
  const roots: Node[] = [];
  for (const r of rows) {
    const node = nodes.get(r.actor_id)!;
    const boss = r.manager_id ? nodes.get(r.manager_id) : undefined;
    if (boss && boss !== node) boss.reports.push(node); else roots.push(node);
  }
  // Anyone whose chain loops back is still shown once, at the top.
  const seen = new Set<string>();
  const prune = (n: Node): Node => { seen.add(n.actorId!); return { ...n, reports: n.reports.filter((c) => !seen.has(c.actorId!)).map(prune) }; };
  const tree = roots.map(prune);
  const { rows: units } = await pool.query<{ id: string; name: string; parent_id: string | null; members: number }>(
    `select u.id, u.name, u.parent_id, (select count(*)::int from actor a where a.org_unit_id = u.id and a.active) as members from org_unit u where u.tenant_id = $1 order by u.name`, [w.tenantId]);
  return { tree, units, people: rows.length, canEdit: w.hr };
}

// --------------------------------------------------------------- branches

const BRANCH_COLS = 'id, name, code, country, currency, timezone, address, working_days, active, created_at';

export async function listBranches(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query(
    `select ${BRANCH_COLS.split(', ').map((c) => `b.${c}`).join(', ')}, (select count(*)::int from employee_record e where e.branch_id = b.id and e.status <> 'left') as people
       from hr_branch b where b.tenant_id = $1 order by b.active desc, b.name`, [w.tenantId]);
  const settings = await hrSettings(pool, w.tenantId);
  return { branches: rows, defaultCurrency: settings.defaultCurrency, defaultCountry: settings.defaultCountry, workingDays: settings.workingDays, canEdit: w.hr && w.admin };
}

/** A branch: where people are employed, in which country and currency, with its own working week. */
export async function saveBranch(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHrAdmin(w);
  const name = text(body.name, 120);
  if (!name) throw new InvalidInput('give the branch a name');
  const country = countryCode(body.country);
  const currency = currencyCode(body.currency);
  const timezone = text(body.timezone, 64) || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new InvalidInput('timezone must be an IANA name, like Africa/Lagos, Europe/London or America/New_York'); }
  const workingDays = body.workingDays === undefined ? [1, 2, 3, 4, 5] : weekdays(body.workingDays);
  const branchId = body.id ? id(body.id, 'id') : null;
  const params = [w.tenantId, name, country, country, currency, timezone, text(body.address, 500) || null, JSON.stringify(workingDays), body.active !== false];
  try {
    if (branchId) {
      const { rows } = await pool.query<{ id: string }>(
        `update hr_branch set name = $2, code = $3, country = $4, currency = $5, timezone = $6, address = $7, working_days = $8, active = $9 where tenant_id = $1 and id = $10 returning id`, [...params, branchId]);
      if (!rows[0]) throw new InvalidInput('no such branch');
    } else {
      const { rows } = await pool.query<{ id: string }>(
        `insert into hr_branch (tenant_id, name, code, country, currency, timezone, address, working_days, active, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`, [...params, w.actorId]);
      await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.branch_created', targetId: rows[0]!.id, detail: { name, country, currency } });
      return { id: rows[0]!.id, name, country, currency };
    }
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new InvalidInput(`there is already a branch called ${name}`);
    throw err;
  }
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.branch_updated', targetId: branchId!, detail: { name, country, currency } });
  return { id: branchId, name, country, currency };
}

/** Move a person to a branch (HR). Their leave types, holidays and working week follow the branch from now on. */
export async function setEmployeeBranch(pool: Pool, principal: Principal, employeeId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireHr(w);
  const branchId = body.branchId ? id(body.branchId, 'branchId') : null;
  return inTransaction(pool, async (client) => {
    const e = await employeeFor(client, w.tenantId, employeeId);
    let name = 'no branch';
    if (branchId) {
      const { rows: b } = await client.query<{ name: string }>('select name from hr_branch where id = $1 and tenant_id = $2 and active', [branchId, w.tenantId]);
      if (!b[0]) throw new InvalidInput('no such branch');
      name = b[0].name;
    }
    await client.query('update employee_record set branch_id = $2, updated_at = now() where id = $1', [e.id, branchId]);
    await client.query(`insert into employee_event (tenant_id, employee_id, kind, title, detail, visibility, created_by) values ($1, $2, 'change', $3, null, 'manager', $4)`, [w.tenantId, e.id, `Moved to ${name}`, w.actorId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'hr.branch_assigned', targetId: e.id, detail: { branchId } });
    return { id: e.id, branchId };
  });
}
