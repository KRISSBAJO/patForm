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

/**
 * A status as a mark, not a word.
 *
 * Three states, three shapes, three colours: a pencil in amber for a draft
 * in progress, a tick in green for published, a dotted ring in grey for
 * never published. The word is still there for a screen reader and as the
 * tooltip, and the filter above the table teaches the colours.
 */
export function StatusIcon({ p, size = 26 }: { p: ProcessTableRow; size?: number }) {
  const kind = statusOf(p);
  const label = statusLabel(p);
  const common = { width: size * 0.55, height: size * 0.55, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  return (
    <span className={`pt__mark pt__mark--${kind}`} style={{ width: size, height: size }} title={label}>
      {kind === 'draft' && (
        <svg {...common}>
          <path d="M4 16.2 4.9 12.6 13.4 4.1a1.6 1.6 0 0 1 2.3 0l.2.2a1.6 1.6 0 0 1 0 2.3L7.4 15.1 4 16.2Z" />
          <path d="m11.6 5.9 2.5 2.5" />
        </svg>
      )}
      {kind === 'published' && (
        <svg {...common}>
          <path d="m4.5 10.5 3.6 3.5L15.5 6" />
        </svg>
      )}
      {kind === 'unpublished' && (
        <svg {...common} strokeDasharray="2.6 2.6">
          <circle cx="10" cy="10" r="6.5" />
        </svg>
      )}
      <span className="pt__srOnly">{label}</span>
    </span>
  );
}

/** The one thing to do with a row: carry on with its draft, or open it. */
export function ActionIcon({ p, onClick, disabled }: { p: ProcessTableRow; onClick: () => void; disabled?: boolean }) {
  const name = p.name ?? p.process_key;
  const label = p.draft_id ? `Continue the draft of ${name}` : `Open ${name}`;
  return (
    <button type="button" className={`pt__act${p.draft_id ? ' pt__act--draft' : ''}`} aria-label={label} title={p.draft_id ? 'Continue draft' : 'Open'} disabled={disabled} onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 10h11M11 5.5 15.5 10 11 14.5" />
      </svg>
    </button>
  );
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
                {key !== 'all' && <span className={`pt__dot pt__dot--${key}`} aria-hidden="true" />}
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
                  <td className="pt__statusCell">
                    <StatusIcon p={p} />
                    {p.version !== null && p.draft_id && <span className="pt__from" title={`Opened from version ${p.version}`}>v{p.version}</span>}
                  </td>
                  <td className="pt__num">{p.instances ? <span className="pt__count">{p.instances}</span> : <span className="pt__none" aria-label="none">·</span>}</td>
                  <td className="pt__when">
                    {p.updated_at ? <time dateTime={p.updated_at} title={new Date(p.updated_at).toLocaleString()}>{ago(p.updated_at)}</time> : <span className="pt__none">·</span>}
                  </td>
                  <td className="pt__open">
                    <ActionIcon p={p} disabled={busy} onClick={() => onOpen(p)} />
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
