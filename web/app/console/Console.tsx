'use client';

import { useCallback, useEffect, useState } from 'react';
import './console.css';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3310';

/**
 * The seats you can sit in. There is no sign-in yet — the API reads an actor
 * header and believes it — so switching seat is the whole "login". It is also
 * the most useful thing on this screen: the same records, seen by four people
 * with different roles, show four different sets of actions.
 */
interface Seat {
  id: string;
  name: string;
  role: string;
  workspace: string;
}

interface Work {
  processKey: string;
  processName: string;
  counts: { arrived: number; needsYou: number; late: number; failed: number };
  approvals: {
    instanceId: string;
    reference: string;
    approvalKey: string;
    approvalName: string;
    stateName: string;
    waitingHours: number;
    late: boolean;
    summary: string;
  }[];
  tasks: {
    instanceId: string;
    reference: string;
    taskKey: string;
    taskName: string;
    assignee: string | null;
    late: boolean;
    summary: string;
  }[];
}

interface Health {
  totals: { runs: number; retried: number; suppressed: number; failing: number };
  failures: {
    outboxId: number;
    reference: string;
    transitionKey: string;
    attempts: number;
    lastError: string;
  }[];
}

interface RecordDetail {
  reference: string;
  processName: string;
  version: number;
  stateName: string;
  outcome: string | null;
  nextAction: string;
  viewerRoles: string[];
  fields: { key: string; label: string; classification: string; value: unknown }[];
  events: { seq: number; type: string; actor: string | null; occurred_at: string }[];
}

type Toast = { message: string; refused?: boolean } | null;

async function call<T>(path: string, actorId: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-actor-id': actorId, ...(init?.headers ?? {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export function Console({ seats }: { seats: Seat[] }) {
  const [seatId, setSeatId] = useState(seats[0]?.id ?? '');
  const [processKey, setProcessKey] = useState('employee_onboarding');
  const [work, setWork] = useState<Work | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seat = seats.find((s) => s.id === seatId);

  const load = useCallback(async () => {
    if (!seatId) return;
    setError(null);
    try {
      const w = await call<Work>(`/api/work?process=${processKey}`, seatId);
      setWork(w);
    } catch (err) {
      setWork(null);
      setError(err instanceof Error ? err.message : String(err));
    }
    try {
      setHealth(await call<Health>(`/api/automation?process=${processKey}`, seatId));
    } catch {
      // Automation health needs `report`. A seat without it simply does not
      // get the panel, which is the right answer rather than an error.
      setHealth(null);
    }
  }, [seatId, processKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await fn();
      setToast({ message: success });
      await load();
      setRecord(null);
    } catch (err) {
      // A refusal is information, not a crash: it says whether to ask for
      // access or to ask a different person.
      setToast({ message: err instanceof Error ? err.message : String(err), refused: true });
    } finally {
      setBusy(null);
    }
  };

  const decide = (instanceId: string, approvalKey: string, decision: 'approved' | 'rejected') =>
    act(
      `${instanceId}:${approvalKey}:${decision}`,
      () =>
        call(`/api/records/${instanceId}/decide`, seatId, {
          method: 'POST',
          body: JSON.stringify({ approvalKey, decision, reason: `Decided in the console by ${seat?.name}` }),
        }),
      decision === 'approved' ? 'Approved. The process moved on.' : 'Rejected. The record is closed.',
    );

  const completeTask = (instanceId: string, taskKey: string) =>
    act(
      `${instanceId}:${taskKey}`,
      () => call(`/api/records/${instanceId}/tasks/${taskKey}/complete`, seatId, { method: 'POST' }),
      'Task completed.',
    );

  const replay = (outboxId: number) =>
    act(`replay:${outboxId}`, () => call(`/api/automation/${outboxId}/replay`, seatId, { method: 'POST' }), 'Queued for replay.');

  const open = async (instanceId: string) => {
    try {
      setRecord(await call<RecordDetail>(`/api/records/${instanceId}`, seatId));
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : String(err), refused: true });
    }
  };

  const counts = work?.counts ?? { arrived: 0, needsYou: 0, late: 0, failed: 0 };

  return (
    <div className="cs">
      {/* ------------------------------------------------------- sidebar */}
      <aside className="cs__side">
        <div className="cs__brand">
          <svg width="22" height="22" viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="var(--green-mint)" strokeWidth="1.8" />
            <path d="M7 13.2L11 17L19 9" stroke="var(--green-mint)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Patform
        </div>

        <nav className="cs__nav" aria-label="Console">
          <button type="button" className="cs__navItem" aria-current="page">
            My work
            {counts.needsYou > 0 && <span className="cs__navCount">{counts.needsYou}</span>}
          </button>
          <button type="button" className="cs__navItem" disabled title="Not built yet">
            Records
          </button>
          <button type="button" className="cs__navItem" disabled title="Not built yet">
            Dashboard
          </button>
          <button type="button" className="cs__navItem" disabled title="Not built yet">
            Automation health
            {counts.failed > 0 && <span className="cs__navCount cs__navCount--bad">{counts.failed}</span>}
          </button>
        </nav>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="cs__sectionLabel">PROCESSES</span>
          <button
            type="button"
            className="cs__process"
            aria-current={processKey === 'employee_onboarding'}
            onClick={() => setProcessKey('employee_onboarding')}
          >
            <span className="cs__dot" aria-hidden="true" />
            {work?.processName ?? 'Employee onboarding'}
          </button>
        </div>

        <div className="cs__seat">
          <div className="cs__seatRow">
            <span className="cs__avatar">
              {(seat?.name ?? '?')
                .split(' ')
                .map((p) => p[0])
                .join('')
                .slice(0, 2)}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="cs__seatName">{seat?.name ?? 'Nobody'}</div>
              <div className="cs__seatRole">
                {seat?.role} · {seat?.workspace}
              </div>
            </div>
          </div>
          <label>
            <span className="cs__seatNote" style={{ display: 'block', marginTop: 10 }}>
              Sit in another seat
            </span>
            <select className="cs__seatPicker" value={seatId} onChange={(e) => setSeatId(e.target.value)}>
              {seats.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.role}
                </option>
              ))}
            </select>
          </label>
          <p className="cs__seatNote">
            No sign-in yet. The API reads an actor header and believes it; everything past that header is
            really enforced.
          </p>
        </div>
      </aside>

      {/* ---------------------------------------------------------- main */}
      <main className="cs__main">
        <div className="cs__head">
          <h1>My work</h1>
          {work && <span className="cs__version">{work.processName}</span>}
          <span style={{ flexGrow: 1 }} />
          <button type="button" className="cs__btn" onClick={() => void load()}>
            Refresh
          </button>
        </div>

        <div className="cs__body">
          <div className="cs__left">
            {error ? (
              <div className="cs__panel">
                <div className="cs__empty">
                  <strong>Refused.</strong>
                  <div style={{ marginTop: 6, fontSize: 13 }}>{error}</div>
                </div>
              </div>
            ) : (
              <>
                <div className="cs__tiles">
                  <div className="cs__tile">
                    <div className="cs__tileLabel">ARRIVED</div>
                    <div className="cs__tileValue">
                      <span className="cs__tileNumber">{counts.arrived}</span>
                      <span className="cs__tileMeta">last 30 days</span>
                    </div>
                  </div>
                  <div className="cs__tile cs__tile--needs">
                    <div className="cs__tileLabel">NEEDS YOU</div>
                    <div className="cs__tileValue">
                      <span className="cs__tileNumber">{counts.needsYou}</span>
                      <span className="cs__tileMeta">
                        {work?.approvals.length ?? 0} approvals, {work?.tasks.length ?? 0} tasks
                      </span>
                    </div>
                  </div>
                  <div className="cs__tile cs__tile--late">
                    <div className="cs__tileLabel">LATE</div>
                    <div className="cs__tileValue">
                      <span className="cs__tileNumber">{counts.late}</span>
                      <span className="cs__tileMeta">past SLA</span>
                    </div>
                  </div>
                  <div className="cs__tile cs__tile--failed">
                    <div className="cs__tileLabel">FAILED</div>
                    <div className="cs__tileValue">
                      <span className="cs__tileNumber">{counts.failed}</span>
                      <span className="cs__tileMeta">safe to replay</span>
                    </div>
                  </div>
                </div>

                <div className="cs__panel">
                  <div className="cs__panelHead">
                    <button type="button" className="cs__tab" aria-selected="true">
                      Needs you
                    </button>
                    <span className="cs__sort">SORTED BY AGE</span>
                  </div>

                  {!work || (work.approvals.length === 0 && work.tasks.length === 0) ? (
                    <div className="cs__empty">Nothing is waiting on you in this process.</div>
                  ) : (
                    <>
                      {work.approvals.map((a) => (
                        <div className="cs__row" key={`${a.instanceId}:${a.approvalKey}`}>
                          <span className={`cs__stripe ${a.late ? 'cs__stripe--late' : 'cs__stripe--waiting'}`} />
                          <span className="cs__ref">{a.reference}</span>
                          <div className="cs__rowMain">
                            <div className="cs__rowTitle">{a.summary}</div>
                            <div className="cs__rowMeta">
                              {a.approvalName} · waiting {a.waitingHours}h
                              {a.late ? ' · past its SLA' : ''}
                            </div>
                          </div>
                          <button type="button" className="cs__btn" onClick={() => void open(a.instanceId)}>
                            Open
                          </button>
                          <button
                            type="button"
                            className="cs__btn cs__btn--danger"
                            disabled={busy !== null}
                            onClick={() => void decide(a.instanceId, a.approvalKey, 'rejected')}
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            className="cs__btn cs__btn--primary"
                            disabled={busy !== null}
                            onClick={() => void decide(a.instanceId, a.approvalKey, 'approved')}
                          >
                            Approve
                          </button>
                        </div>
                      ))}

                      {work.tasks.map((t) => (
                        <div className="cs__row" key={`${t.instanceId}:${t.taskKey}`}>
                          <span className={`cs__stripe ${t.late ? 'cs__stripe--late' : ''}`} />
                          <span className="cs__ref">{t.reference}</span>
                          <div className="cs__rowMain">
                            <div className="cs__rowTitle">{t.summary}</div>
                            <div className="cs__rowMeta">
                              {t.taskName} · assigned to {t.assignee ?? 'nobody'}
                            </div>
                          </div>
                          <button type="button" className="cs__btn" onClick={() => void open(t.instanceId)}>
                            Open
                          </button>
                          <button
                            type="button"
                            className="cs__btn cs__btn--primary"
                            disabled={busy !== null}
                            onClick={() => void completeTask(t.instanceId, t.taskKey)}
                          >
                            Mark done
                          </button>
                        </div>
                      ))}
                    </>
                  )}
                </div>

                {record && (
                  <div className="cs__panel">
                    <div className="cs__panelHead">
                      <button type="button" className="cs__tab" aria-selected="true">
                        {record.reference} · {record.stateName}
                      </button>
                      <span className="cs__sort">
                        v{record.version} · seen as {record.viewerRoles.join(', ') || 'no process role'}
                      </span>
                      <button type="button" className="cs__btn" style={{ marginLeft: 12 }} onClick={() => setRecord(null)}>
                        Close
                      </button>
                    </div>
                    <div style={{ padding: '14px 18px' }}>
                      <div className="cs__rowMeta" style={{ marginBottom: 12 }}>
                        <strong>Next:</strong> {record.nextAction}
                      </div>
                      {record.fields.map((f) => (
                        <div className="cs__field" key={f.key}>
                          <span className="cs__fieldLabel">{f.label}</span>
                          <span className="cs__fieldValue">
                            {f.value === '[redacted]' ? (
                              <span className="cs__redacted">hidden from your role</span>
                            ) : f.value === null || f.value === '' ? (
                              <span style={{ color: 'var(--muted-2)' }}>—</span>
                            ) : (
                              String(Array.isArray(f.value) ? f.value.join(', ') : f.value)
                            )}
                          </span>
                          <span className={`cs__class cs__class--${f.classification}`}>
                            {f.classification.slice(0, 4).toUpperCase()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ------------------------------------------------- right column */}
          <div className="cs__right">
            {health ? (
              <div className="cs__card">
                <span className="cs__cardLabel">AUTOMATION HEALTH</span>
                <div style={{ marginTop: 14 }}>
                  <div className="cs__stat">
                    Actions run <span className="cs__statValue">{health.totals.runs}</span>
                  </div>
                  <div className="cs__stat">
                    Retried and recovered <span className="cs__statValue">{health.totals.retried}</span>
                  </div>
                  <div className="cs__stat">
                    Duplicates suppressed <span className="cs__statValue">{health.totals.suppressed}</span>
                  </div>
                  <div className="cs__stat" style={{ color: health.totals.failing ? 'var(--red-text)' : undefined }}>
                    Permanently failed <span className="cs__statValue">{health.totals.failing}</span>
                  </div>
                </div>

                {health.failures.map((f) => (
                  <div className="cs__failure" key={f.outboxId}>
                    <div className="cs__failureTitle">Failed after {f.attempts} attempts</div>
                    <p className="cs__failureBody">
                      {f.reference} · {f.transitionKey} · {f.lastError}
                    </p>
                    <button
                      type="button"
                      className="cs__btn cs__btn--danger"
                      style={{ marginTop: 11 }}
                      disabled={busy !== null}
                      onClick={() => void replay(f.outboxId)}
                    >
                      Replay this action
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="cs__card">
                <span className="cs__cardLabel">AUTOMATION HEALTH</span>
                <p className="cs__failureBody" style={{ marginTop: 10 }}>
                  Your roles do not include reporting, so this panel is not shown. That is the policy engine,
                  not an error.
                </p>
              </div>
            )}

            <div className="cs__card cs__card--dark">
              <span className="cs__cardLabel">WHAT THIS SCREEN IS</span>
              <p style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.5, color: 'var(--on-dark-2)' }}>
                Four questions, in order: what arrived, what needs you, what is late, what failed. Change seat
                in the sidebar and the same records offer different actions — every one of them checked by the
                runtime, not by this page.
              </p>
            </div>
          </div>
        </div>
      </main>

      {toast && (
        <div className={`cs__toast ${toast.refused ? 'cs__toast--refused' : ''}`} role="status">
          <span className="cs__toastLabel">{toast.refused ? 'REFUSED BY THE POLICY ENGINE' : 'DONE'}</span>
          {toast.message}
        </div>
      )}
    </div>
  );
}
