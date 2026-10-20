/**
 * Every HR list that can grow, a page at a time (see listing.ts): cases,
 * leave, hiring, what is coming up, reconciliation, holidays and documents.
 * HR sees the whole workspace; the leave list also serves a manager with
 * their reports' requests. Each list exports the filtered rows as CSV.
 */
import type { Pool } from './db.js';
import type { Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { readListQuery, runList, toCsv, type ListSpec } from './listing.js';
import { hrSettings, requireHr, who, type Who } from './hr.js';

type Cols = { key: string; label: string }[];
const cols = (pairs: [string, string][]): Cols => pairs.map(([key, label]) => ({ key, label }));

async function paged(pool: Pool, w: Who, params: URLSearchParams, args: { spec: ListSpec; select: string; from: string; base: string[]; params: unknown[]; csv: { name: string; columns: Cols }; facets?: string }) {
  const query = readListQuery(params, args.spec);
  const page = await runList<Record<string, unknown>>(pool, { ...args, query });
  if (query.format === 'csv') {
    await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: `hr.${args.csv.name}_exported`, detail: { rows: page.total, q: query.q, filters: query.filters } });
    return { filename: `${args.csv.name}-${new Date().toISOString().slice(0, 10)}.csv`, csv: toCsv(page.rows, args.csv.columns), rows: page.total };
  }
  const facets = args.facets ? (await pool.query(args.facets, [args.params[0]])).rows : [];
  return { ...page, facets };
}

const BRANCH_FACET = `select 'branch' as kind, b.id::text, b.name, count(e.*)::int as n from hr_branch b left join employee_record e on e.branch_id = b.id and e.status <> 'left' where b.tenant_id = $1 and b.active group by b.id, b.name`;

// ------------------------------------------------------------------- cases

const CASES: ListSpec = { defaultSort: 'created_at:desc', columns: {
  name: { sql: 'e.name', sortable: true, searchable: true },
  kind: { sql: 'c.kind', sortable: true, filters: { kind: 'in' } },
  status: { sql: 'c.status', sortable: true, filters: { status: 'in' } },
  branch: { sql: 'b.name', filterSql: 'b.id', sortable: true, filters: { branch: 'in' } },
  unit: { sql: 'u.name', sortable: true, searchable: true },
  title: { sql: 'a.position_title', searchable: true },
  effective_date: { sql: 'c.effective_date', sortable: true, filters: { effective_from: 'date_from', effective_to: 'date_to' } },
  created_at: { sql: 'c.created_at', sortable: true },
  done: { sql: `(select count(*) from lifecycle_task t where t.case_id = c.id and t.status <> 'open')`, sortable: true },
  total: { sql: '(select count(*) from lifecycle_task t where t.case_id = c.id)' },
  summary: { sql: 'c.summary', searchable: true },
} };

export async function searchCases(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal); requireHr(w);
  return paged(pool, w, params, {
    spec: CASES, params: [w.tenantId], base: ['c.tenant_id = $1'],
    select: `c.id, c.kind, c.status, c.restricted, c.effective_date::text, c.created_at, c.summary, e.id as employee_id, e.name, a.position_title as title, u.name as unit, b.name as branch, b.country as branch_country,
             (select count(*)::int from lifecycle_task t where t.case_id = c.id and t.status <> 'open') as done, (select count(*)::int from lifecycle_task t where t.case_id = c.id) as total,
             (select count(*)::int from lifecycle_task t where t.case_id = c.id and t.status = 'open' and t.critical) as critical_open`,
    from: `lifecycle_case c join employee_record e on e.id = c.employee_id left join actor a on a.id = e.actor_id left join org_unit u on u.id = a.org_unit_id left join hr_branch b on b.id = e.branch_id`,
    csv: { name: 'cases', columns: cols([['name', 'Person'], ['kind', 'Case'], ['status', 'Status'], ['branch', 'Branch'], ['unit', 'Unit'], ['effective_date', 'Effective'], ['done', 'Tasks done'], ['total', 'Tasks'], ['summary', 'Summary']]) },
    facets: `${BRANCH_FACET} union all select 'kind', kind, kind, count(*)::int from lifecycle_case where tenant_id = $1 group by kind union all select 'status', status, status, count(*)::int from lifecycle_case where tenant_id = $1 group by status order by 1, 3`,
  });
}

// ------------------------------------------------------------------- leave

const LEAVE: ListSpec = { defaultSort: 'start_date:desc', columns: {
  name: { sql: 'e.name', sortable: true, searchable: true },
  type: { sql: 't.name', filterSql: 't.key', sortable: true, filters: { type: 'in' } },
  status: { sql: 'r.status', sortable: true, filters: { status: 'in' } },
  branch: { sql: 'b.name', filterSql: 'b.id', sortable: true, filters: { branch: 'in' } },
  unit: { sql: 'u.name', sortable: true, searchable: true },
  start_date: { sql: 'r.start_date', sortable: true, filters: { from: 'date_from' } },
  end_date: { sql: 'r.end_date', sortable: true, filters: { to: 'date_to' } },
  days: { sql: 'r.days', sortable: true, filters: { days_min: 'num_min', days_max: 'num_max' } },
  approver: { sql: 'ap.display_name', sortable: true, searchable: true },
  reason: { sql: 'r.reason', searchable: true },
  created_at: { sql: 'r.created_at', sortable: true },
} };

/** Every leave request HR can see; a manager sees their reports' and their own. */
export async function searchLeave(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal);
  const base = w.hr ? ['r.tenant_id = $1'] : ['r.tenant_id = $1', `(e.actor_id = $2 or exists (select 1 from reporting_line l where l.actor_id = e.actor_id and l.manager_id = $2 and l.kind = 'primary' and l.effective_to is null))`];
  return paged(pool, w, params, {
    spec: LEAVE, params: w.hr ? [w.tenantId] : [w.tenantId, w.actorId], base,
    select: `r.id, e.id as employee_id, e.name, t.name as type, t.key as type_key, r.start_date::text, r.end_date::text, r.days, r.status, r.reason, r.decision_note, r.created_at, r.decided_at,
             ap.display_name as approver, b.name as branch, b.country as branch_country, u.name as unit`,
    from: `leave_request r join employee_record e on e.id = r.employee_id join leave_type t on t.id = r.leave_type_id left join actor a on a.id = e.actor_id left join org_unit u on u.id = a.org_unit_id
           left join hr_branch b on b.id = e.branch_id left join actor ap on ap.id = coalesce(r.decided_by, r.approver_id)`,
    csv: { name: 'leave', columns: cols([['name', 'Person'], ['type', 'Type'], ['start_date', 'From'], ['end_date', 'To'], ['days', 'Days'], ['status', 'Status'], ['approver', 'Decided by'], ['branch', 'Branch'], ['unit', 'Unit'], ['reason', 'Reason'], ['decision_note', 'Note']]) },
    facets: w.hr ? `${BRANCH_FACET} union all select 'type', key, name, count(*)::int from leave_type where tenant_id = $1 and active group by key, name union all select 'status', status, status, count(*)::int from leave_request where tenant_id = $1 group by status order by 1, 3` : undefined,
  });
}

// ------------------------------------------------------------------ hiring

const HIRING: ListSpec = { defaultSort: 'created_at:desc', columns: {
  reference: { sql: 'h.reference', sortable: true, searchable: true },
  position: { sql: 'h.position', sortable: true, searchable: true },
  status: { sql: 'h.status', sortable: true, filters: { status: 'in' } },
  cost_centre: { sql: 'h.cost_centre', sortable: true, searchable: true, filters: { cost_centre: 'eq' } },
  headcount: { sql: 'h.headcount', sortable: true },
  filled: { sql: 'h.filled', sortable: true },
  amount: { sql: 'h.amount', sortable: true },
  created_at: { sql: 'h.created_at', sortable: true, filters: { from: 'date_from', to: 'date_to' } },
} };

export async function searchHiring(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal); requireHr(w);
  return paged(pool, w, params, {
    spec: HIRING, params: [w.tenantId], base: ['h.tenant_id = $1'],
    select: 'h.id, h.instance_id, h.reference, h.position, h.headcount, h.filled, h.cost_centre, h.amount, h.status, h.created_at',
    from: 'hiring_requisition h',
    csv: { name: 'hiring', columns: cols([['reference', 'Reference'], ['position', 'Position'], ['headcount', 'Headcount'], ['filled', 'Filled'], ['cost_centre', 'Cost centre'], ['amount', 'Amount'], ['status', 'Status'], ['created_at', 'Raised']]) },
    facets: `select 'status' as kind, status as id, status as name, count(*)::int as n from hiring_requisition where tenant_id = $1 group by status union all select 'cost_centre', cost_centre, cost_centre, count(*)::int from hiring_requisition where tenant_id = $1 and cost_centre is not null group by cost_centre order by 1, 3`,
  });
}

// ---------------------------------------------------------------- upcoming

const UPCOMING: ListSpec = { defaultSort: 'on:asc', columns: {
  name: { sql: 'x.name', sortable: true, searchable: true },
  kind: { sql: 'x.kind', sortable: true, filters: { kind: 'in' } },
  on: { sql: 'x.on', sortable: true, filters: { from: 'date_from', to: 'date_to' } },
  detail: { sql: 'x.detail', searchable: true },
  branch: { sql: 'x.branch', filterSql: 'x.branch_id', sortable: true, filters: { branch: 'in' } },
} };

/** HR-11 dates as a list: starts, leavers, probation ends, certifications, anniversaries, within the window. */
export async function searchUpcoming(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal); requireHr(w);
  const { anniversaryNoticeDays } = await hrSettings(pool, w.tenantId);
  const days = Math.min(Math.max(Number(params.get('days') ?? 60) || 60, 7), 366);
  const from = `(select 'probation_end' as kind, e.id as employee_id, e.name, e.probation_end as on, null::text as detail, e.branch_id, b.name as branch from employee_record e left join hr_branch b on b.id = e.branch_id
       where e.tenant_id = $1 and e.status in ('pre_hire', 'active') and e.probation_end between current_date and current_date + $2::int
     union all select 'start', e.id, e.name, e.start_date, e.employment_type, e.branch_id, b.name from employee_record e left join hr_branch b on b.id = e.branch_id where e.tenant_id = $1 and e.status = 'pre_hire' and e.start_date between current_date and current_date + $2::int
     union all select 'leaving', e.id, e.name, e.end_date, null, e.branch_id, b.name from employee_record e left join hr_branch b on b.id = e.branch_id where e.tenant_id = $1 and e.status = 'leaving' and e.end_date between current_date and current_date + $2::int
     union all select 'certification', e.id, e.name, c.expires_on, c.name, e.branch_id, b.name from employee_certification c join employee_record e on e.id = c.employee_id left join hr_branch b on b.id = e.branch_id where c.tenant_id = $1 and e.status = 'active' and c.expires_on <= current_date + $2::int
     union all select 'anniversary', e.id, e.name, make_date(extract(year from current_date)::int, extract(month from e.start_date)::int, least(extract(day from e.start_date)::int, 28)), (extract(year from current_date)::int - extract(year from e.start_date)::int)::text || ' years', e.branch_id, b.name
       from employee_record e left join hr_branch b on b.id = e.branch_id where e.tenant_id = $1 and e.status = 'active' and e.start_date is not null and extract(year from e.start_date) < extract(year from current_date)
         and make_date(extract(year from current_date)::int, extract(month from e.start_date)::int, least(extract(day from e.start_date)::int, 28)) between current_date and current_date + $3::int) x`;
  return paged(pool, w, params, {
    spec: UPCOMING, params: [w.tenantId, days, anniversaryNoticeDays], base: [],
    select: `x.employee_id || ':' || x.kind || ':' || x.on::text as id, x.employee_id, x.kind, x.name, x.on::text, x.detail, x.branch, x.branch_id`, from,
    csv: { name: 'upcoming', columns: cols([['on', 'Date'], ['kind', 'What'], ['name', 'Person'], ['detail', 'Detail'], ['branch', 'Branch']]) },
    facets: `${BRANCH_FACET} order by 3`,
  });
}

// ---------------------------------------------------------- reconciliation

const RECON: ListSpec = { defaultSort: 'created_at:desc', columns: {
  name: { sql: 'e.name', sortable: true, searchable: true },
  field: { sql: 'r.field', sortable: true, filters: { field: 'in' } },
  owner: { sql: 'r.owner', sortable: true, searchable: true, filters: { owner: 'in' } },
  status: { sql: 'r.status', sortable: true, filters: { status: 'in' } },
  proposed: { sql: 'r.proposed_value', searchable: true },
  raised_by: { sql: 'a.display_name', sortable: true, searchable: true },
  created_at: { sql: 'r.created_at', sortable: true, filters: { from: 'date_from', to: 'date_to' } },
} };

export async function searchReconciliation(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal); requireHr(w);
  return paged(pool, w, params, {
    spec: RECON, params: [w.tenantId], base: ['r.tenant_id = $1'],
    select: `r.id, r.field, r.owner, r.current_value, r.proposed_value, r.status, r.note, r.created_at, r.resolved_at, e.id as employee_id, e.name, a.display_name as raised_by`,
    from: 'hr_reconciliation r join employee_record e on e.id = r.employee_id left join actor a on a.id = r.raised_by',
    csv: { name: 'reconciliation', columns: cols([['name', 'Person'], ['field', 'Field'], ['owner', 'Owned by'], ['current_value', 'Now'], ['proposed_value', 'Proposed'], ['status', 'Status'], ['raised_by', 'Raised by'], ['created_at', 'Raised']]) },
    facets: `select 'status' as kind, status as id, status as name, count(*)::int as n from hr_reconciliation where tenant_id = $1 group by status union all select 'field', field, field, count(*)::int from hr_reconciliation where tenant_id = $1 group by field union all select 'owner', owner, owner, count(*)::int from hr_reconciliation where tenant_id = $1 group by owner order by 1, 3`,
  });
}

// ---------------------------------------------------------------- holidays

const HOLIDAYS: ListSpec = { defaultSort: 'day:asc', columns: {
  day: { sql: 'h.day', sortable: true, filters: { from: 'date_from', to: 'date_to' } },
  name: { sql: 'h.name', sortable: true, searchable: true },
  branch: { sql: 'b.name', filterSql: 'h.branch_id', sortable: true, filters: { branch: 'in' } },
  year: { sql: 'extract(year from h.day)', filters: { year: 'eq' } },
} };

export async function searchHolidays(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal);
  if (!params.has('from') && !params.has('year') && !params.has('to')) params.set('from', new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString().slice(0, 10));
  return paged(pool, w, params, {
    spec: HOLIDAYS, params: [w.tenantId], base: ['h.tenant_id = $1'],
    select: `h.day::text || ':' || coalesce(h.branch_id::text, 'all') as id, h.day::text, h.name, h.branch_id, b.name as branch, b.country as branch_country`,
    from: 'public_holiday h left join hr_branch b on b.id = h.branch_id',
    csv: { name: 'holidays', columns: cols([['day', 'Date'], ['name', 'Holiday'], ['branch', 'Branch']]) },
    facets: `${BRANCH_FACET} order by 3`,
  });
}

// --------------------------------------------------------------- documents

const DOCS: ListSpec = { defaultSort: 'created_at:desc', columns: {
  title: { sql: 'd.title', sortable: true, searchable: true },
  version: { sql: 'd.version', sortable: true, searchable: true },
  kind: { sql: 'd.kind', sortable: true, filters: { kind: 'in' } },
  sent: { sql: '(select count(*) from document_request r where r.document_id = d.id)', sortable: true },
  acknowledged: { sql: `(select count(*) from document_request r where r.document_id = d.id and r.status = 'acknowledged')`, sortable: true },
  overdue: { sql: `(select count(*) from document_request r where r.document_id = d.id and r.status = 'sent' and r.due_date < current_date)`, sortable: true },
  has_file: { sql: '(d.storage_key is not null)', filters: { has_file: 'bool' } },
  created_at: { sql: 'd.created_at', sortable: true },
} };

export async function searchDocuments(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal); requireHr(w);
  return paged(pool, w, params, {
    spec: DOCS, params: [w.tenantId], base: ['d.tenant_id = $1'],
    select: `d.id, d.title, d.version, d.kind, d.document_ref, d.created_at, d.filename, d.byte_size, d.scan_status, (d.storage_key is not null) as has_file,
             (select count(*)::int from document_request r where r.document_id = d.id) as sent,
             (select count(*)::int from document_request r where r.document_id = d.id and r.status = 'acknowledged') as acknowledged,
             (select count(*)::int from document_request r where r.document_id = d.id and r.status = 'sent' and r.due_date < current_date) as overdue`,
    from: 'hr_document d',
    csv: { name: 'documents', columns: cols([['title', 'Title'], ['version', 'Version'], ['kind', 'Kind'], ['sent', 'Sent'], ['acknowledged', 'Done'], ['overdue', 'Overdue'], ['filename', 'File'], ['created_at', 'Created']]) },
    facets: `select 'kind' as kind, kind as id, kind as name, count(*)::int as n from hr_document where tenant_id = $1 group by kind order by 3`,
  });
}
