'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EmptyState } from './module-shell';

/*
 * The data table every big list uses. The server does the paging, sorting,
 * searching and filtering (runtime/listing.ts); this draws the result with
 * sortable headers, a search box, a filter bar with counted options, a page
 * bar, a page-size choice, a cards view for small screens or a visual
 * browse, column hiding, and a CSV of the whole filtered list.
 */

export type Facet = { kind: string; id: string | null; name: string; n: number };
export interface Column<T> { key: string; label: string; sortable?: boolean; width?: number | string; align?: 'left' | 'right'; render?: (row: T) => ReactNode; hide?: boolean }
export interface FilterDef { key: string; label: string; kind: 'facet' | 'text' | 'date_from' | 'date_to' | 'select'; facet?: string; options?: [string, string][]; multi?: boolean }
export interface Page<T> { rows: T[]; total: number; page: number; size: number; pages: number; sort: string; facets?: Facet[] }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export function DataTable<T extends { id: string }>({ path, columns, filters = [], defaultSort, defaultSize = 25, onRow, card, title, empty, toolbar, refreshKey, defaultView = 'table' }: {
  path: string; columns: Column<T>[]; filters?: FilterDef[]; defaultSort: string; defaultSize?: number; onRow?: (row: T) => void; card?: (row: T) => ReactNode;
  title?: string; empty?: { title: string; text: string; action?: { label: string; onClick: () => void } }; toolbar?: ReactNode; refreshKey?: unknown; defaultView?: 'table' | 'cards';
}) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(defaultSize);
  const [sort, setSort] = useState(defaultSort);
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [active, setActive] = useState<Record<string, string>>({});
  const [view, setView] = useState<'table' | 'cards'>(defaultView);
  const [hidden, setHidden] = useState<Set<string>>(new Set(columns.filter((c) => c.hide).map((c) => c.key)));
  const [showCols, setShowCols] = useState(false);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [data, setData] = useState<Page<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyCsv, setBusyCsv] = useState(false);
  const facetsRef = useRef<Facet[]>([]);
  const query = useMemo(() => { const p = new URLSearchParams({ page: String(page), size: String(size), sort }); if (q) p.set('q', q); for (const [k, v] of Object.entries(active)) if (v) p.set(k, v); return p.toString(); }, [page, size, sort, q, active]);
  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await get<Page<T>>(`${path}${path.includes('?') ? '&' : '?'}${query}`); setData(d); if (d.facets) facetsRef.current = d.facets; setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }, [path, query]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { const t = setTimeout(() => { setQ(qLive.trim()); setPage(1); }, 250); return () => clearTimeout(t); }, [qLive]);
  const [sortCol, sortDir] = sort.split(':');
  const toggleSort = (key: string) => { setSort(sortCol === key && sortDir === 'asc' ? `${key}:desc` : `${key}:asc`); setPage(1); };
  const setFilter = (key: string, value: string) => { setActive((a) => ({ ...a, [key]: value })); setPage(1); };
  const facetsFor = (name: string) => facetsRef.current.filter((f) => f.kind === name);
  const chips = filters.filter((f) => active[f.key]);
  const visible = columns.filter((c) => !hidden.has(c.key));
  const exportCsv = async () => {
    setBusyCsv(true);
    try {
      const p = new URLSearchParams(query); p.set('format', 'csv'); p.delete('page'); p.delete('size');
      const out = await get<{ filename: string; csv: string }>(`${path}${path.includes('?') ? '&' : '?'}${p.toString()}`);
      const url = URL.createObjectURL(new Blob([out.csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = out.filename; a.click(); URL.revokeObjectURL(url);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusyCsv(false); }
  };
  const from = data ? (data.total ? (data.page - 1) * data.size + 1 : 0) : 0;
  const to = data ? Math.min(data.total, data.page * data.size) : 0;
  const pageNumbers = useMemo(() => { if (!data) return []; const n = data.pages, c = data.page; const set = new Set<number>([1, n, c, c - 1, c + 1, c - 2, c + 2]); return [...set].filter((x) => x >= 1 && x <= n).sort((a, b) => a - b); }, [data]);

  return <div className="mx__card dt">
    <div className="dt__bar">
      {title && <h3 className="dt__title">{title}<small>{data ? `${data.total.toLocaleString()} ${data.total === 1 ? 'record' : 'records'}` : ''}</small></h3>}
      <div className="dt__search"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg><input value={qLive} onChange={(e) => setQLive(e.target.value)} placeholder="Search" aria-label="Search" />{qLive && <button type="button" aria-label="Clear search" onClick={() => setQLive('')}>×</button>}</div>
      <div className="dt__tools">
        {filters.map((f) => <div key={f.key} className="dt__filter">
          <button type="button" className={`mx__seg ${active[f.key] ? 'is-on' : ''}`} aria-expanded={openFilter === f.key} onClick={() => setOpenFilter(openFilter === f.key ? null : f.key)}>{f.label}{active[f.key] && f.kind === 'facet' ? ` · ${active[f.key].split(',').length}` : ''} ▾</button>
          {openFilter === f.key && <div className="dt__pop" role="dialog" aria-label={f.label}>
            {f.kind === 'facet' && <ul>{facetsFor(f.facet ?? f.key).map((o) => { const id = o.id ?? o.name; const on = (active[f.key] ?? '').split(',').includes(id); return <li key={id}><label><input type="checkbox" checked={on} onChange={() => { const cur = (active[f.key] ?? '').split(',').filter(Boolean); setFilter(f.key, (on ? cur.filter((x) => x !== id) : [...cur, id]).join(',')); }} /><span>{o.name.replace(/_/g, ' ')}</span><small>{o.n}</small></label></li>; })}{!facetsFor(f.facet ?? f.key).length && <li><small>Nothing to filter by yet.</small></li>}</ul>}
            {f.kind === 'select' && <ul>{(f.options ?? []).map(([v, label]) => <li key={v}><label><input type="radio" name={f.key} checked={active[f.key] === v} onChange={() => setFilter(f.key, v)} /><span>{label}</span></label></li>)}</ul>}
            {f.kind === 'text' && <input className="mx__input" autoFocus placeholder={f.label} value={active[f.key] ?? ''} onChange={(e) => setFilter(f.key, e.target.value)} />}
            {(f.kind === 'date_from' || f.kind === 'date_to') && <input className="mx__input" type="date" autoFocus value={active[f.key] ?? ''} onChange={(e) => setFilter(f.key, e.target.value)} />}
            <div className="dt__popFoot"><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setFilter(f.key, '')}>Clear</button><button type="button" className="mx__btn mx__btn--sm" onClick={() => setOpenFilter(null)}>Done</button></div>
          </div>}
        </div>)}
        <div className="dt__filter"><button type="button" className="mx__seg" aria-expanded={showCols} onClick={() => setShowCols(!showCols)}>Columns ▾</button>{showCols && <div className="dt__pop"><ul>{columns.map((c) => <li key={c.key}><label><input type="checkbox" checked={!hidden.has(c.key)} onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n; })} /><span>{c.label}</span></label></li>)}</ul><div className="dt__popFoot"><button type="button" className="mx__btn mx__btn--sm" onClick={() => setShowCols(false)}>Done</button></div></div>}</div>
        {card && <div className="mx__segs"><button type="button" className={`mx__seg ${view === 'table' ? 'is-on' : ''}`} onClick={() => setView('table')} title="Table">☰</button><button type="button" className={`mx__seg ${view === 'cards' ? 'is-on' : ''}`} onClick={() => setView('cards')} title="Cards">▦</button></div>}
        <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busyCsv || !data?.total} onClick={() => void exportCsv()}>{busyCsv ? 'Preparing…' : 'Export CSV'}</button>
        {toolbar}
      </div>
    </div>
    {(chips.length > 0 || q) && <div className="dt__chips">{q && <span className="dt__chip">“{q}”<button type="button" aria-label="Clear search" onClick={() => setQLive('')}>×</button></span>}{chips.map((f) => <span key={f.key} className="dt__chip">{f.label}: {f.kind === 'facet' ? active[f.key]!.split(',').map((id) => facetsFor(f.facet ?? f.key).find((o) => (o.id ?? o.name) === id)?.name ?? id).join(', ').replace(/_/g, ' ') : f.kind === 'select' ? (f.options?.find(([v]) => v === active[f.key])?.[1] ?? active[f.key]) : active[f.key]}<button type="button" aria-label={`Clear ${f.label}`} onClick={() => setFilter(f.key, '')}>×</button></span>)}<button type="button" className="mx__link" onClick={() => { setActive({}); setQLive(''); }}>Clear all</button></div>}
    {error && <p className="mx__notice mx__notice--err" style={{ margin: '0 20px 12px' }} role="alert">{error}</p>}
    {data && !data.total && <EmptyState icon="search" title={q || chips.length ? 'No match' : empty?.title ?? 'Nothing here yet'} text={q || chips.length ? 'Try another search or clear a filter.' : empty?.text ?? ''} action={q || chips.length ? { label: 'Clear filters', onClick: () => { setActive({}); setQLive(''); } } : empty?.action} />}
    {data && data.total > 0 && view === 'table' && <div className={`dt__scroll ${loading ? 'is-loading' : ''}`}><table className="dt__table"><thead><tr>{visible.map((c) => <th key={c.key} scope="col" style={{ width: c.width, textAlign: c.align }} aria-sort={sortCol === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>{c.sortable ? <button type="button" className={`dt__sort ${sortCol === c.key ? 'is-on' : ''}`} onClick={() => toggleSort(c.key)}>{c.label}<span aria-hidden="true">{sortCol === c.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'}</span></button> : c.label}</th>)}</tr></thead>
      <tbody>{data.rows.map((r) => <tr key={r.id} className={onRow ? 'is-link' : ''} onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (e) => { if (e.key === 'Enter') onRow(r); } : undefined}>{visible.map((c) => <td key={c.key} style={{ textAlign: c.align }}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '')}</td>)}</tr>)}</tbody></table></div>}
    {data && data.total > 0 && view === 'cards' && card && <div className={`dt__cards ${loading ? 'is-loading' : ''}`}>{data.rows.map((r) => <div key={r.id} onClick={onRow ? () => onRow(r) : undefined} role={onRow ? 'button' : undefined}>{card(r)}</div>)}</div>}
    {data && data.total > 0 && <div className="dt__foot">
      <small>{from.toLocaleString()}–{to.toLocaleString()} of {data.total.toLocaleString()}</small>
      <div className="dt__pages"><button type="button" className="mx__seg" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>‹</button>{pageNumbers.map((n, i) => <span key={n} style={{ display: 'contents' }}>{i > 0 && n - pageNumbers[i - 1]! > 1 && <span className="dt__gap">…</span>}<button type="button" className={`mx__seg ${n === data.page ? 'is-on' : ''}`} onClick={() => setPage(n)}>{n}</button></span>)}<button type="button" className="mx__seg" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>›</button></div>
      <label className="dt__size">Rows<select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }}>{[10, 25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
    </div>}
  </div>;
}
