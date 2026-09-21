'use client';

import { useCallback, useEffect, useState } from 'react';
import './console.css';

/**
 * Calls go to the same origin so the HttpOnly, SameSite=Lax session cookie is
 * actually sent — see app/api/[...path]/route.ts for why the API is not
 * called directly.
 */
interface Me {
  id: string;
  display_name: string;
  email: string;
  workspace_role: string;
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
  failures: { outboxId: number; reference: string; transitionKey: string; attempts: number; lastError: string }[];
}

interface RecordDetail {
  reference: string;
  version: number;
  stateName: string;
  nextAction: string;
  viewerRoles: string[];
  fields: { key: string; label: string; classification: string; value: unknown }[];
}

interface SessionInfo {
  actor: Me;
  processes: { process_key: string; name: string; version: number; open_records: number; roles: string[] }[];
  devices: { id: string; user_agent: string | null; last_seen_at: string }[];
}

type Toast = { message: string; refused?: boolean } | null;

class Unauthenticated extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Unauthenticated(body.error ?? 'sign in first');
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export function Console() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [processKey, setProcessKey] = useState('employee_onboarding');
  const [work, setWork] = useState<Work | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
    try {
      const info = await call<SessionInfo>('/api/session');
      setSession(info);
      if (info.processes[0]) setProcessKey((current) => current || info.processes[0]!.process_key);
    } catch {
      setSession(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const load = useCallback(async () => {
    if (!session) return;
    setError(null);
    try {
      setWork(await call<Work>(`/api/work?process=${processKey}`));
    } catch (err) {
      setWork(null);
      if (err instanceof Unauthenticated) return setSession(null);
      setError(err instanceof Error ? err.message : String(err));
    }
    try {
      setHealth(await call<Health>(`/api/automation?process=${processKey}`));
    } catch {
      // Automation health needs `report`. Someone without it does not get the
      // panel, which is the right answer rather than an error.
      setHealth(null);
    }
  }, [session, processKey]);

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
      setRecord(null);
      await load();
    } catch (err) {
      if (err instanceof Unauthenticated) return setSession(null);
      // A refusal is information, not a crash: it says whether to ask for
      // access or to ask a different person.
      setToast({ message: err instanceof Error ? err.message : String(err), refused: true });
    } finally {
      setBusy(null);
    }
  };

  const decide = (instanceId: string, approvalKey: string, decision: 'approved' | 'rejected') =>
    act(
      `${instanceId}:${approvalKey}`,
      () =>
        call(`/api/records/${instanceId}/decide`, {
          method: 'POST',
          body: JSON.stringify({ approvalKey, decision, reason: 'Decided in the console' }),
        }),
      decision === 'approved' ? 'Approved. The process moved on.' : 'Rejected. The record is closed.',
    );

  const completeTask = (instanceId: string, taskKey: string) =>
    act(
      `${instanceId}:${taskKey}`,
      () => call(`/api/records/${instanceId}/tasks/${taskKey}/complete`, { method: 'POST' }),
      'Task completed.',
    );

  const replay = (outboxId: number) =>
    act(`replay:${outboxId}`, () => call(`/api/automation/${outboxId}/replay`, { method: 'POST' }), 'Queued for replay.');

  const open = async (instanceId: string) => {
    try {
      setRecord(await call<RecordDetail>(`/api/records/${instanceId}`));
    } catch (err) {
      if (err instanceof Unauthenticated) return setSession(null);
      setToast({ message: err instanceof Error ? err.message : String(err), refused: true });
    }
  };

  const signOut = async () => {
    await call('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setSession(null);
    setWork(null);
    setHealth(null);
  };

  if (checking) return <div className="cs__boot">Checking your session…</div>;
  if (!session) return <SignIn onSignedIn={() => void refreshSession()} />;

  const me = session.actor;
  const counts = work?.counts ?? { arrived: 0, needsYou: 0, late: 0, failed: 0 };

  return (
    <div className="cs">
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
          {session.processes.map((p) => (
            <button
              key={p.process_key}
              type="button"
              className="cs__process"
              aria-current={processKey === p.process_key}
              onClick={() => setProcessKey(p.process_key)}
            >
              <span className="cs__dot" aria-hidden="true" />
              {p.name}
            </button>
          ))}
        </div>

        <div className="cs__seat">
          <div className="cs__seatRow">
            <span className="cs__avatar">
              {me.display_name
                .split(' ')
                .map((p) => p[0])
                .join('')
                .slice(0, 2)}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="cs__seatName">{me.display_name}</div>
              <div className="cs__seatRole">
                {session.processes[0]?.roles.join(', ') || 'no process role'} · {me.workspace_role}
              </div>
            </div>
          </div>
          <button type="button" className="cs__seatPicker" onClick={() => void signOut()}>
            Sign out
          </button>
          {session.devices.length > 1 && (
            <p className="cs__seatNote">
              {session.devices.length} active sessions.{' '}
              <button
                type="button"
                className="cs__linkBtn"
                onClick={() =>
                  void act('revoke', () => call('/api/session/revoke-all', { method: 'POST' }), 'Signed out everywhere.').then(
                    () => setSession(null),
                  )
                }
              >
                Sign out everywhere
              </button>
            </p>
          )}
        </div>
      </aside>

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
                  <Tile label="ARRIVED" value={counts.arrived} meta="last 30 days" />
                  <Tile
                    label="NEEDS YOU"
                    value={counts.needsYou}
                    meta={`${work?.approvals.length ?? 0} approvals, ${work?.tasks.length ?? 0} tasks`}
                    tone="needs"
                  />
                  <Tile label="LATE" value={counts.late} meta="past SLA" tone="late" />
                  <Tile label="FAILED" value={counts.failed} meta="safe to replay" tone="failed" />
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
                              {a.approvalName} · waiting {a.waitingHours}h{a.late ? ' · past its SLA' : ''}
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

          <div className="cs__right">
            {health ? (
              <div className="cs__card">
                <span className="cs__cardLabel">AUTOMATION HEALTH</span>
                <div style={{ marginTop: 14 }}>
                  <Stat label="Actions run" value={health.totals.runs} />
                  <Stat label="Retried and recovered" value={health.totals.retried} />
                  <Stat label="Duplicates suppressed" value={health.totals.suppressed} />
                  <Stat label="Permanently failed" value={health.totals.failing} bad={health.totals.failing > 0} />
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
                  Your roles do not include reporting, so this panel is not shown. That is the policy engine, not
                  an error.
                </p>
              </div>
            )}

            <div className="cs__card cs__card--dark">
              <span className="cs__cardLabel">WHAT THIS SCREEN IS</span>
              <p style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.5, color: 'var(--on-dark-2)' }}>
                Four questions, in order: what arrived, what needs you, what is late, what failed. Sign in as
                someone else and the same records offer different actions — every one of them checked by the
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

function Tile({
  label,
  value,
  meta,
  tone,
}: {
  label: string;
  value: number;
  meta: string;
  tone?: 'needs' | 'late' | 'failed';
}) {
  return (
    <div className={`cs__tile ${tone ? `cs__tile--${tone}` : ''}`}>
      <div className="cs__tileLabel">{label}</div>
      <div className="cs__tileValue">
        <span className="cs__tileNumber">{value}</span>
        <span className="cs__tileMeta">{meta}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div className="cs__stat" style={bad ? { color: 'var(--red-text)' } : undefined}>
      {label} <span className="cs__statValue">{value}</span>
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      onSignedIn();
    } catch (err) {
      // One message for every failure. Saying "no such account" would let a
      // stranger enumerate who works here.
      setError(err instanceof Error ? err.message : 'those details do not match an account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cs__login">
      <form className="cs__loginBox" onSubmit={submit}>
        <div className="cs__brand" style={{ color: 'var(--ink)', padding: 0 }}>
          <svg width="24" height="24" viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="var(--green)" strokeWidth="1.8" />
            <path d="M7 13.2L11 17L19 9" stroke="var(--green)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Patform
        </div>
        <h1 className="cs__loginTitle">Sign in to the console</h1>

        <label className="cs__label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="cs__input"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <label className="cs__label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="cs__input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && <p className="cs__loginError">{error}</p>}

        <button type="submit" className="cs__btn cs__btn--primary" style={{ marginTop: 18, width: '100%', height: 44 }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="cs__loginNote">
          A seeded workspace prints its accounts when you run <code>npm run seed</code>.
        </p>
      </form>
    </div>
  );
}
