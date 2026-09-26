import type { Blueprint } from '../blueprint/index.js';
import { inTransaction, type Pool } from './db.js';
import { exportProcessTable, tableToCsv, tablesToXlsx, XLSX_TYPE, type ExportFilters } from './export.js';
import { sendPlatformMail } from './platform-mail.js';
import { AuthorizationError, require_, requireWorkspaceCapability, type Principal } from './policy.js';

/**
 * Saved views, and the reports that come from them.
 *
 * A view is the Records page's filters with a name: still running or
 * finished, the order, the search text, one answer. Saved views belong to
 * the workspace, so "Unpaid invoices over a week old" is one thing everybody
 * opens rather than a recipe passed around. A scheduled report is a saved
 * view emailed to the person who scheduled it, daily, weekly or monthly, as
 * an Excel or CSV attachment.
 *
 * The report is rendered as that person: the export runs under their roles,
 * so a field their role may not see is not in the file, and a person who
 * loses the right to report on the process stops receiving it rather than
 * receiving a file they could no longer make themselves.
 */
export interface ViewParams {
  completed?: 'all' | 'open' | 'done';
  order?: 'newest' | 'oldest' | 'reference';
  query?: string;
  field?: string;
  value?: string;
}

export type Schedule = 'daily' | 'weekly' | 'monthly';

export interface SavedView {
  id: string;
  process_key: string;
  name: string;
  params: ViewParams;
  created_by: string;
  created_by_name: string | null;
  schedule: Schedule | null;
  format: 'csv' | 'xlsx';
  last_sent_at: string | null;
  created_at: string;
  /** True when the caller made it, so the page can offer to remove it. */
  mine: boolean;
}

const SCHEDULES = new Set<Schedule>(['daily', 'weekly', 'monthly']);

function toFilters(params: ViewParams): ExportFilters {
  return {
    completed: params.completed === 'open' ? false : params.completed === 'done' ? true : undefined,
    query: params.query?.trim() || undefined,
    answer: params.field && params.value ? { field: params.field, value: params.value } : undefined,
  };
}

async function blueprintFor(pool: Pool, tenantId: string, processKey: string): Promise<Blueprint> {
  const { rows } = await pool.query<{ blueprint: Blueprint }>(
    `select blueprint from process_version where tenant_id = $1 and process_key = $2 order by version desc limit 1`,
    [tenantId, processKey],
  );
  if (!rows[0]) throw new Error(`no published process "${processKey}"`);
  return rows[0].blueprint;
}

export async function listViews(pool: Pool, principal: Principal, processKey: string): Promise<SavedView[]> {
  if (principal.kind !== 'actor') throw new Error('sign in first');
  const bp = await blueprintFor(pool, principal.tenantId, processKey);
  await inTransaction(pool, (client) =>
    require_(client, { principal, action: 'view', tenantId: principal.tenantId, processKey, blueprint: bp }, pool),
  );
  const { rows } = await pool.query<Omit<SavedView, 'mine'> & { created_by: string }>(
    `select v.id, v.process_key, v.name, v.params, v.created_by, a.display_name as created_by_name,
            v.schedule, v.format, v.last_sent_at, v.created_at
       from saved_view v left join actor a on a.id = v.created_by
      where v.tenant_id = $1 and v.process_key = $2
      order by lower(v.name)`,
    [principal.tenantId, processKey],
  );
  return rows.map((r) => ({ ...r, mine: r.created_by === principal.actorId }));
}

export async function createView(
  pool: Pool,
  principal: Principal,
  args: { processKey: string; name: string; params: ViewParams; schedule?: Schedule | null; format?: 'csv' | 'xlsx' },
): Promise<SavedView> {
  if (principal.kind !== 'actor') throw new Error('sign in first');
  const name = args.name.trim().slice(0, 80);
  if (!name) throw new Error('give the view a name');
  const schedule = args.schedule && SCHEDULES.has(args.schedule) ? args.schedule : null;
  const format = args.format === 'csv' ? 'csv' : 'xlsx';
  const params: ViewParams = {
    completed: args.params.completed === 'open' || args.params.completed === 'done' ? args.params.completed : 'all',
    order: args.params.order === 'oldest' || args.params.order === 'reference' ? args.params.order : 'newest',
    ...(args.params.query?.trim() ? { query: args.params.query.trim().slice(0, 200) } : {}),
    ...(args.params.field && args.params.value ? { field: String(args.params.field).slice(0, 80), value: String(args.params.value).slice(0, 200) } : {}),
  };

  const bp = await blueprintFor(pool, principal.tenantId, args.processKey);
  await inTransaction(pool, (client) =>
    // Saving a view is viewing; scheduling one is reporting, because a file
    // leaves the system on a timer.
    require_(client, { principal, action: schedule ? 'report' : 'view', tenantId: principal.tenantId, processKey: args.processKey, blueprint: bp }, pool),
  );
  if (params.field) {
    // A filter on a field this person cannot see would be refused at every
    // run; better refused now, while they are looking.
    await exportProcessTable(pool, { principal, processKey: args.processKey, filters: { ...toFilters(params), query: undefined } }).catch((err: unknown) => {
      if (err instanceof Error && /filter by/.test(err.message)) throw err;
    });
  }

  const { rows } = await pool.query<{ id: string }>(
    `insert into saved_view (tenant_id, process_key, name, params, created_by, schedule, format)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [principal.tenantId, args.processKey, name, JSON.stringify(params), principal.actorId, schedule, format],
  );
  const all = await listViews(pool, principal, args.processKey);
  return all.find((v) => v.id === rows[0]!.id)!;
}

export async function deleteView(pool: Pool, principal: Principal, id: string): Promise<{ removed: boolean }> {
  if (principal.kind !== 'actor') throw new Error('sign in first');
  const own = await pool.query('delete from saved_view where tenant_id = $1 and id = $2 and created_by = $3', [principal.tenantId, id, principal.actorId]);
  if (own.rowCount) return { removed: true };
  // Somebody else's: an administrator may tidy up.
  await requireWorkspaceCapability(pool, principal, 'administer', 'saved-views');
  const any = await pool.query('delete from saved_view where tenant_id = $1 and id = $2', [principal.tenantId, id]);
  return { removed: Boolean(any.rowCount) };
}

/**
 * Sends every scheduled report that is due. Called by the worker on its sweep.
 *
 * Each view is claimed by moving its `last_sent_at` forward before the file
 * is made, so two workers cannot both send it, and a report that fails to
 * send is not retried every minute: it waits for the next period, and the
 * failure is on the platform email log where the operator looks.
 */
export async function runDueReports(pool: Pool, now = new Date()): Promise<number> {
  const { rows: due } = await pool.query<{
    id: string; tenant_id: string; process_key: string; name: string; params: ViewParams; created_by: string;
    schedule: Schedule; format: 'csv' | 'xlsx'; last_sent_at: Date | null; email: string; active: boolean;
  }>(
    `select v.id, v.tenant_id, v.process_key, v.name, v.params, v.created_by, v.schedule, v.format, v.last_sent_at,
            a.email, a.active
       from saved_view v join actor a on a.id = v.created_by
      where v.schedule is not null
        and (v.last_sent_at is null or v.last_sent_at < $1::timestamptz - case v.schedule
              when 'daily' then interval '23 hours'
              when 'weekly' then interval '6 days 23 hours'
              else interval '29 days 23 hours' end)
      order by v.last_sent_at nulls first
      limit 20`,
    [now],
  );

  let sent = 0;
  for (const v of due) {
    const claim = await pool.query(
      `update saved_view set last_sent_at = $2 where id = $1 and last_sent_at is not distinct from $3`,
      [v.id, now, v.last_sent_at],
    );
    if (!claim.rowCount) continue;
    if (!v.active) continue;

    const principal: Principal = { kind: 'actor', tenantId: v.tenant_id, actorId: v.created_by };
    let table;
    try {
      table = await exportProcessTable(pool, { principal, processKey: v.process_key, filters: toFilters(v.params), now });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        // They may no longer report on it. The schedule stops rather than
        // the file going out under a right they no longer hold.
        await pool.query('update saved_view set schedule = null where id = $1', [v.id]);
        continue;
      }
      throw err;
    }

    const stamp = now.toISOString().slice(0, 10);
    const attachment = v.format === 'csv'
      ? { filename: `${v.process_key}-${stamp}.csv`, content: Buffer.from(tableToCsv(table), 'utf8'), contentType: 'text/csv' }
      : { filename: `${v.process_key}-${stamp}.xlsx`, content: tablesToXlsx([table]), contentType: XLSX_TYPE };
    const withheld = table.withheld.length
      ? `\n\n${table.withheld.length} ${table.withheld.length === 1 ? 'field is' : 'fields are'} not in the file because your roles do not see ${table.withheld.length === 1 ? 'it' : 'them'}: ${table.withheld.join(', ')}.`
      : '';
    const result = await sendPlatformMail(pool, {
      kind: 'scheduled_report',
      to: v.email,
      subject: `${v.name}: ${table.count} ${table.count === 1 ? 'record' : 'records'} (${table.processName})`,
      text: `Your ${v.schedule} report "${v.name}" for ${table.processName}: ${table.count} ${table.count === 1 ? 'record' : 'records'}${table.truncated ? ', stopped at 50,000' : ''}. The file is attached.${withheld}\n\nTo change or stop this report, open ${table.processName} in the console, go to Records, and choose the view.`,
      attachments: [attachment],
      tenantId: v.tenant_id,
      actorId: v.created_by,
      idempotencyKey: `scheduled-report:${v.id}:${stamp}`,
    });
    if (result && result.status !== 'failed') sent++;
  }
  return sent;
}
