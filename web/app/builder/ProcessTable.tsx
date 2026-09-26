'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * Every process the workspace has, as a table.
 *
 * The start screen shows the four most recent. A workspace that has been
 * going for a year has hundreds, and a list of hundreds is not a list, it is
 * a search box with rows under it. So: search by name or key, a status
 * filter, sortable columns, and pages of twenty-five. The whole list is
 * already in memory for the rail's switcher, so this filters and sorts it
 * there rather than asking the server for every keystroke; a few hundred
 * rows is nothing to a browser.
 */
export interface ProcessTableRow {
  process_key: string;
  name: string | null;
  version: number | null;
  draft_id: string | null;
  instances: number;
  updated_at: string | null;
}

type Status = 'all' | 'draft' | 'published' | 'unpublished';
type SortKey = 'name' | 'status' | 'instances' | 'updated';

const PAGE = 25;

export function statusOf(p: ProcessTableRow): 'draft' | 'published' | 'unpublished' {
  if (p.draft_id) return 'draft';
  return p.version ? 'published' : 'unpublished';
}

export function statusLabel(p: ProcessTableRow): string {
  if (p.draft_id) return p.version ? `draft, from v${p.version}` : 'draft in progress';
  return p.version ? `published v${p.version}` : 'not published yet';
}

/** "just now", "3 hours ago", "yesterday", "12 Mar": for a column, not a caption. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ProcessTable({
  processes,
  onOpen,
  busy,
}: {
  processes: ProcessTableRow[];
  onOpen: (p: ProcessTableRow) => void;
  busy: boolean;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'updated', dir: 'desc' });
  const [page, setPage] = useState(1);

  const counts = useMemo(() => {
    const c = { all: processes.length, draft: 0, published: 0, unpublished: 0 };
    for (const p of processes) c[statusOf(p)]++;
    return c;
  }, [processes]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = processes.filter((p) => {
      if (status !== 'all' && statusOf(p) !== status) return false;
      if (!q) return true;
      return (p.name ?? '').toLowerCase().includes(q) || p.process_key.toLowerCase().includes(q);
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    const order = { draft: 0, published: 1, unpublished: 2 };
    rows.sort((a, b) => {
      switch (sort.key) {
        case 'name':
          return dir * (a.name ?? a.process_key).localeCompare(b.name ?? b.process_key);
        case 'status':
          return dir * (order[statusOf(a)] - order[statusOf(b)]) || (a.name ?? '').localeCompare(b.name ?? '');
        case 'instances':
          return dir * (a.instances - b.instances) || (a.name ?? '').localeCompare(b.name ?? '');
        case 'updated':
        default:
          return dir * ((a.updated_at ?? '').localeCompare(b.updated_at ?? '')) || (a.name ?? '').localeCompare(b.name ?? '');
      }
    });
    return rows;
  }, [processes, query, status, sort]);

  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE));
  const current = Math.min(page, pageCount);
  const pageRows = shown.slice((current - 1) * PAGE, current * PAGE);

  // A new search or filter starts at page one; page five of a search that
  // returns three rows is an empty table.
  useEffect(() => { setPage(1); }, [query, status]);

  const toggle = (key: SortKey) =>
    setSort((was) => (was.key === key ? { key, dir: was.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  const ariaSort = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') as 'ascending' | 'descending' | 'none';

  const head = (key: SortKey, label: string, className?: string) => (
    <th scope="col" aria-sort={ariaSort(key)} className={className}>
      <button type="button" className={`pt__sort${sort.key === key ? ' pt__sort--on' : ''}`} onClick={() => toggle(key)}>
        {label}
        <span aria-hidden="true" className="pt__sortMark">{sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</span>
      </button>
    </th>
  );

  const first = shown.length ? (current - 1) * PAGE + 1 : 0;
  const last = Math.min(current * PAGE, shown.length);

  return (
    <div className="bd__start">
      <div className="bd__startInner bd__startInner--wide">
        <header className="pt__head">
          <div>
            <a className="pt__back" href="/builder">← Builder</a>
            <h1>All processes</h1>
            <p>{counts.all === 1 ? 'One process' : `${counts.all} processes`} in this workspace: {counts.draft} with a draft open, {counts.published} published, {counts.unpublished} never published.</p>
          </div>
          <a className="pt__new" href="/builder/new">+ New process</a>
        </header>

        <div className="pt__tools" role="search">
          <label className="pt__search">
            <span className="pt__srOnly">Search processes</span>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
              <circle cx="9" cy="9" r="5.5" />
              <path d="m13.2 13.2 3.6 3.6" />
            </svg>
            <input type="search" value={query} placeholder="Search by name or key" onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="pt__filters" role="group" aria-label="Show">
            {(
              [
                ['all', 'All'],
                ['draft', 'Drafts'],
                ['published', 'Published'],
                ['unpublished', 'Unpublished'],
              ] as [Status, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`pt__filter${status === key ? ' pt__filter--on' : ''}`}
                aria-pressed={status === key}
                onClick={() => setStatus(key)}
              >
                {label} <span className="pt__filterCount">{counts[key]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="pt__tableWrap">
          <table className="pt__table">
            <thead>
              <tr>
                {head('name', 'Process')}
                {head('status', 'Status')}
                {head('instances', 'Open items', 'pt__num')}
                {head('updated', 'Last edited')}
                <th scope="col"><span className="pt__srOnly">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((p) => (
                <tr key={p.process_key}>
                  <td>
                    <button type="button" className="pt__name" disabled={busy} onClick={() => onOpen(p)}>
                      <span className="bd__recentMark bd__recentMark--sm" aria-hidden="true">{(p.name ?? p.process_key).slice(0, 1).toUpperCase()}</span>
                      <span className="pt__nameText">
                        <span>{p.name ?? p.process_key}</span>
                        <code>{p.process_key}</code>
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className={`pt__status pt__status--${statusOf(p)}`}>{statusLabel(p)}</span>
                  </td>
                  <td className="pt__num">{p.instances || '—'}</td>
                  <td>
                    {p.updated_at ? <time dateTime={p.updated_at} title={new Date(p.updated_at).toLocaleString()}>{ago(p.updated_at)}</time> : '—'}
                  </td>
                  <td className="pt__open">
                    <button type="button" className="pt__btn" disabled={busy} onClick={() => onOpen(p)}>
                      {p.draft_id ? 'Continue' : 'Open'}
                    </button>
                  </td>
                </tr>
              ))}
              {!pageRows.length && (
                <tr>
                  <td colSpan={5} className="pt__empty">
                    {processes.length ? 'Nothing matches that.' : 'Nothing here yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="pt__pager">
          <span aria-live="polite">{shown.length ? `${first}–${last} of ${shown.length}` : 'No processes shown'}</span>
          {pageCount > 1 && (
            <span className="pt__pagerButtons">
              <button type="button" className="pt__btn" disabled={current === 1} onClick={() => setPage(current - 1)}>Previous</button>
              <span>Page {current} of {pageCount}</span>
              <button type="button" className="pt__btn" disabled={current === pageCount} onClick={() => setPage(current + 1)}>Next</button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
