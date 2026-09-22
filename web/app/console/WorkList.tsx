'use client';

/**
 * What needs you, when there is more of it than fits on a screen.
 *
 * The list was every approval followed by every task, in one order, with no
 * way to narrow it. That is fine for six rows and useless for sixty — and
 * sixty is the ordinary case for anybody running a real process, which is the
 * whole point of the product.
 *
 * Searching, filtering and sorting all happen here, on rows the server has
 * already decided this person may see. Nothing here widens what they can
 * reach: the list arrives filtered by the runtime's policy, and this narrows
 * it further.
 */

import { useMemo, useState } from 'react';
import { Icon } from './Icon';
import { who } from './format';

export interface WorkApproval {
  instanceId: string;
  reference: string;
  approvalKey: string;
  approvalName: string;
  stateName: string;
  waitingHours: number;
  late: boolean;
  summary: string;
}

export interface WorkTask {
  instanceId: string;
  reference: string;
  taskKey: string;
  taskName: string;
  assignee: string | null;
  late: boolean;
  summary: string;
}

type Row =
  | { kind: 'approval'; key: string; age: number; item: WorkApproval }
  | { kind: 'task'; key: string; age: number; item: WorkTask };

type Show = 'all' | 'approvals' | 'tasks' | 'late';
type Order = 'oldest' | 'newest' | 'reference';

const PAGE = 12;

export function WorkList({
  approvals,
  tasks,
  busy,
  onOpen,
  onDecide,
  onCompleteTask,
}: {
  approvals: WorkApproval[];
  tasks: WorkTask[];
  busy: string | null;
  onOpen: (instanceId: string) => void;
  onDecide: (instanceId: string, approvalKey: string, decision: 'approved' | 'rejected') => void;
  onCompleteTask: (instanceId: string, taskKey: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [order, setOrder] = useState<Order>('oldest');
  const [page, setPage] = useState(1);

  const all = useMemo<Row[]>(
    () => [
      ...approvals.map((a) => ({
        kind: 'approval' as const,
        key: `${a.instanceId}:${a.approvalKey}`,
        age: a.waitingHours,
        item: a,
      })),
      /*
       * A task carries no waiting time from the API, so it sorts as zero.
       * Left visibly at zero rather than guessed at: a made-up age would sort
       * tasks into positions that mean nothing, and somebody working oldest
       * first would trust the order.
       */
      ...tasks.map((t) => ({ kind: 'task' as const, key: `${t.instanceId}:${t.taskKey}`, age: 0, item: t })),
    ],
    [approvals, tasks],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();

    let out = all.filter((row) => {
      if (show === 'approvals' && row.kind !== 'approval') return false;
      if (show === 'tasks' && row.kind !== 'task') return false;
      if (show === 'late' && !row.item.late) return false;
      if (!needle) return true;

      // Reference, the person the record is about, and what is being asked.
      const haystack = [
        row.item.reference,
        row.item.summary,
        row.kind === 'approval' ? row.item.approvalName : row.item.taskName,
        row.kind === 'task' ? (row.item.assignee ?? '') : '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });

    out = [...out].sort((a, b) => {
      if (order === 'reference') return a.item.reference.localeCompare(b.item.reference);
      // Late first whichever way the rest is sorted: it is the one ordering
      // nobody would ever want overridden by a tiebreak.
      if (a.item.late !== b.item.late) return a.item.late ? -1 : 1;
      return order === 'oldest' ? b.age - a.age : a.age - b.age;
    });

    return out;
  }, [all, query, show, order]);

  const shown = rows.slice(0, page * PAGE);
  const filtering = query.trim() !== '' || show !== 'all';

  return (
    <div className="cs__panel">
      <div className="cs__panelHead">
        <h2 className="cs__tab">Needs you</h2>
        <span className="cs__sort">
          {filtering ? `${rows.length} of ${all.length}` : `${all.length} ${all.length === 1 ? 'item' : 'items'}`}
        </span>
      </div>

      {/* The controls appear once there is enough to need them. Three empty
          filters over four rows is furniture. */}
      {all.length > 4 && (
        <div className="wk__controls">
          <div className="wk__search">
            <Icon name="search" />
            <input
              className="wk__searchInput"
              type="search"
              value={query}
              placeholder="Search by reference, name or what is being asked"
              aria-label="Search what needs you"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>

          <label className="wk__pick">
            <span className="cs__srOnly">Show</span>
            <Icon name="filter" />
            <select
              className="wk__select"
              value={show}
              onChange={(e) => {
                setShow(e.target.value as Show);
                setPage(1);
              }}
            >
              <option value="all">Everything</option>
              <option value="approvals">Decisions only</option>
              <option value="tasks">Tasks only</option>
              <option value="late">Late only</option>
            </select>
          </label>

          <label className="wk__pick">
            <span className="cs__srOnly">Order</span>
            <Icon name="sort" />
            <select className="wk__select" value={order} onChange={(e) => setOrder(e.target.value as Order)}>
              <option value="oldest">Waiting longest first</option>
              <option value="newest">Newest first</option>
              <option value="reference">By reference</option>
            </select>
          </label>
        </div>
      )}

      {!rows.length ? (
        <div className="cs__empty">
          {filtering ? (
            <>
              Nothing matches that.{' '}
              <button
                type="button"
                className="cs__linkBtn cs__linkBtn--onLight"
                onClick={() => {
                  setQuery('');
                  setShow('all');
                }}
              >
                Clear the filters
              </button>
            </>
          ) : (
            'Nothing is waiting on you in this process.'
          )}
        </div>
      ) : (
        <>
          {shown.map((row) =>
            row.kind === 'approval' ? (
              <div className="cs__row" key={row.key}>
                <span className={`cs__stripe ${row.item.late ? 'cs__stripe--late' : 'cs__stripe--waiting'}`} />
                <span className="cs__ref">{row.item.reference}</span>
                <div className="cs__rowMain">
                  <div className="cs__rowTitle">{row.item.summary}</div>
                  <div className="cs__rowMeta">
                    {row.item.approvalName} · waiting {row.item.waitingHours}h
                    {row.item.late ? ' · past its SLA' : ''}
                  </div>
                </div>
                {/*
                  * Quiet, and all the same weight.
                  *
                  * These were three filled buttons per row, which on a list of
                  * twenty is sixty things asking to be pressed and no way to
                  * tell which matters. The emphasis belongs on the record
                  * page, where there is one decision and it is the reason the
                  * page exists. Here they are shortcuts.
                  */}
                <div className="cs__rowActions">
                  <button type="button" className="cs__act" onClick={() => onOpen(row.item.instanceId)}>
                    <Icon name="open" />
                    Open
                  </button>
                  <button
                    type="button"
                    className="cs__act"
                    disabled={busy !== null}
                    onClick={() => onDecide(row.item.instanceId, row.item.approvalKey, 'rejected')}
                  >
                    <Icon name="reject" />
                    Reject
                  </button>
                  <button
                    type="button"
                    className="cs__act cs__act--go"
                    disabled={busy !== null}
                    onClick={() => onDecide(row.item.instanceId, row.item.approvalKey, 'approved')}
                  >
                    <Icon name="approve" />
                    Approve
                  </button>
                </div>
              </div>
            ) : (
              <div className="cs__row" key={row.key}>
                <span className={`cs__stripe ${row.item.late ? 'cs__stripe--late' : ''}`} />
                <span className="cs__ref">{row.item.reference}</span>
                <div className="cs__rowMain">
                  <div className="cs__rowTitle">{row.item.summary}</div>
                  <div className="cs__rowMeta">
                    {row.item.taskName} · assigned to {who(row.item.assignee)}
                  </div>
                </div>
                <div className="cs__rowActions">
                  <button type="button" className="cs__act" onClick={() => onOpen(row.item.instanceId)}>
                    <Icon name="open" />
                    Open
                  </button>
                  <button
                    type="button"
                    className="cs__act cs__act--go"
                    disabled={busy !== null}
                    onClick={() => onCompleteTask(row.item.instanceId, row.item.taskKey)}
                  >
                    <Icon name="done" />
                    Mark done
                  </button>
                </div>
              </div>
            ),
          )}

          {rows.length > shown.length && (
            <div className="wk__more">
              <button type="button" className="cs__btn" onClick={() => setPage((p) => p + 1)}>
                Show {Math.min(PAGE, rows.length - shown.length)} more
              </button>
              <span className="wk__moreNote">
                {shown.length} of {rows.length}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
