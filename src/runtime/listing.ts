/**
 * One way to list anything big: a page at a time, sorted by a column the
 * caller is allowed to sort on, narrowed by a search box and typed filters,
 * with the total so the screen can page. Every module's big lists (people,
 * claims, orders, invoices, assets) go through this, so the table on the
 * screen behaves the same everywhere and the database does the work.
 *
 *   GET …?page=2&size=50&sort=name:asc&q=ada&status=active,leaving&branch=<id>
 *   GET …?format=csv          the same list, every row, as a file
 *
 * The caller describes the columns once: which SQL expression each one is,
 * whether it can be sorted or searched, and how a filter on it is applied.
 */
import { InvalidInput } from './errors.js';
import type { Client, Pool } from './db.js';

export type FilterKind = 'eq' | 'in' | 'like' | 'date_from' | 'date_to' | 'num_min' | 'num_max' | 'bool';

export interface ListColumn {
  /** The SQL expression (with table aliases) this column reads. */
  sql: string;
  sortable?: boolean;
  /** The expression filters compare against when it differs from the shown one (an id behind a name). */
  filterSql?: string;
  /** Part of the free-text search (ILIKE on the expression). */
  searchable?: boolean;
  /** Query parameters that filter on this column, each with how it is applied. */
  filters?: Record<string, FilterKind>;
}

export interface ListSpec {
  columns: Record<string, ListColumn>;
  defaultSort: string;
  maxSize?: number;
}

export interface ListQuery { page: number; size: number; sort: { column: string; dir: 'asc' | 'desc' }; q: string; filters: Record<string, string>; format: 'json' | 'csv' }

/** Read the listing parameters off a URL, refusing anything the spec does not allow. */
export function readListQuery(params: URLSearchParams, spec: ListSpec): ListQuery {
  const page = Math.max(1, Math.trunc(Number(params.get('page') ?? 1)) || 1);
  const size = Math.min(spec.maxSize ?? 200, Math.max(1, Math.trunc(Number(params.get('size') ?? 25)) || 25));
  const [col, dirRaw] = (params.get('sort') ?? spec.defaultSort).split(':');
  const column = col && spec.columns[col]?.sortable ? col : spec.defaultSort.split(':')[0]!;
  const dir: 'asc' | 'desc' = dirRaw === 'desc' ? 'desc' : 'asc';
  const q = (params.get('q') ?? '').trim().slice(0, 120);
  const filters: Record<string, string> = {};
  for (const c of Object.values(spec.columns)) for (const key of Object.keys(c.filters ?? {})) {
    const v = params.get(key);
    if (v !== null && v !== '') filters[key] = v.slice(0, 400);
  }
  const format = params.get('format') === 'csv' ? 'csv' : 'json';
  return { page, size, sort: { column, dir }, q, filters, format };
}

/** The WHERE fragments and ORDER BY the query adds, with their parameters appended after `params`. */
export function buildList(spec: ListSpec, query: ListQuery, params: unknown[]): { where: string[]; orderBy: string; params: unknown[]; limit: string } {
  const where: string[] = [];
  const p = [...params];
  const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  if (query.q) {
    const cols = Object.values(spec.columns).filter((c) => c.searchable).map((c) => c.sql);
    if (cols.length) { const ph = add(`%${query.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`); where.push(`(${cols.map((c) => `${c}::text ilike ${ph}`).join(' or ')})`); }
  }
  for (const c of Object.values(spec.columns)) for (const [key, kind] of Object.entries(c.filters ?? {})) {
    const v = query.filters[key];
    if (v === undefined) continue;
    const col = c.filterSql ?? c.sql;
    switch (kind) {
      case 'eq': where.push(`${col}::text = ${add(v)}`); break;
      case 'in': where.push(`${col}::text = any(${add(v.split(',').map((x) => x.trim()).filter(Boolean))}::text[])`); break;
      case 'like': where.push(`${col}::text ilike ${add(`%${v}%`)}`); break;
      case 'date_from': if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new InvalidInput(`${key} must be a date`); where.push(`${col} >= ${add(v)}`); break;
      case 'date_to': if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new InvalidInput(`${key} must be a date`); where.push(`${col} <= ${add(v)}`); break;
      case 'num_min': if (!Number.isFinite(Number(v))) throw new InvalidInput(`${key} must be a number`); where.push(`${col} >= ${add(Number(v))}`); break;
      case 'num_max': if (!Number.isFinite(Number(v))) throw new InvalidInput(`${key} must be a number`); where.push(`${col} <= ${add(Number(v))}`); break;
      case 'bool': where.push(`${col} = ${add(v === 'true' || v === '1' || v === 'yes')}`); break;
    }
  }
  const sortSql = spec.columns[query.sort.column]!.sql;
  const orderBy = `order by ${sortSql} ${query.sort.dir} nulls last`;
  const limit = query.format === 'csv' ? '' : `limit ${query.size} offset ${(query.page - 1) * query.size}`;
  return { where, orderBy, params: p, limit };
}

export interface Page<T> { rows: T[]; total: number; page: number; size: number; pages: number; sort: string; q: string; filters: Record<string, string> }

/**
 * Run a listing: `from` is the FROM … JOIN … clause, `select` the column
 * list, `base` any WHERE fragments that always apply (tenant, visibility)
 * using $1…$n from `params`.
 */
export async function runList<T extends Record<string, unknown>>(client: Client | Pool, args: { select: string; from: string; base: string[]; params: unknown[]; spec: ListSpec; query: ListQuery; countExpr?: string }): Promise<Page<T>> {
  const built = buildList(args.spec, args.query, args.params);
  const where = [...args.base, ...built.where];
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const { rows: count } = await client.query<{ n: string }>(`select count(${args.countExpr ?? '*'}) as n from ${args.from} ${whereSql}`, built.params);
  const total = Number(count[0]?.n ?? 0);
  const { rows } = await client.query<T>(`select ${args.select} from ${args.from} ${whereSql} ${built.orderBy} ${built.limit}`, built.params);
  const size = args.query.size;
  return { rows, total, page: args.query.page, size, pages: Math.max(1, Math.ceil(total / size)), sort: `${args.query.sort.column}:${args.query.sort.dir}`, q: args.query.q, filters: args.query.filters };
}

/** Rows as a CSV file, with a header of the given labels. */
export function toCsv(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
  const cell = (v: unknown) => { const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map((c) => cell(c.label)).join(','), ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(','))].join('\r\n') + '\r\n';
}
