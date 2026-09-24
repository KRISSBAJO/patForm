'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import './console.css';
import { Ask } from './Ask';
import { DashboardView, HealthView, HeldView, RecordsView, SecurityView } from './Views';
import { PeopleView, ProcessesView } from './Manage';
import { InviteView } from './Invite';
import { BootScreen } from '../../components/boot-screen';
import { DataView, IntegrationsView } from './Settings';
import { RecordTrail } from './Trail';
import { RecordPage } from './Record';
import { WorkList } from './WorkList';
import { ReauthDialog } from './stepup';
import { PasswordInput } from './PasswordInput';
import { Icon } from './Icon';

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
  email_verified_at: string | null;
  workspace_name: string;
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
    description?: string;
    requiredFields?: { key: string; label: string; type: string }[];
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
  instanceId: string;
  reference: string;
  processKey: string;
  processName: string;
  version: number;
  stateName: string;
  nextAction: string;
  viewerRoles: string[];
  fields: { key: string; label: string; classification: string; value: unknown }[];
}

interface SessionInfo {
  actor: Me;
  processes: { process_key: string; name: string; version: number; open_records: number; roles: string[]; public_id: string }[];
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
  const [siteAdmin, setSiteAdmin] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [checking, setChecking] = useState(true);
  const [processKey, setProcessKey] = useState('');
  const [work, setWork] = useState<Work | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [view, setView] = useState<
    | 'work'
    | 'record'
    | 'ask'
    | 'records'
    | 'dashboard'
    | 'health'
    | 'security'
    | 'people'
    | 'invite'
    | 'processes'
    | 'integrations'
    | 'data'
    | 'held'
  >('work');
  /*
   * How many public submissions are waiting on a person. Fetched on its own:
   * it spans every process, where the work counts are per process, and a
   * member who cannot operate any of them simply gets zero.
   */
  const [heldCount, setHeldCount] = useState(0);
  /*
   * Whether this sign-in screen is a first visit or an ejection.
   *
   * The console used to swap silently from a working page to a login form,
   * which reads as the application having crashed. It is usually a session
   * that expired, was revoked from another device, or — in development —
   * disappeared with the schema.
   */
  const [wasSignedOut, setWasSignedOut] = useState(false);
  const [showTrail, setShowTrail] = useState(false);

  const endSession = useCallback(() => {
    setWasSignedOut(true);
    setSession(null);
  }, []);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
    try {
      const info = await call<SessionInfo>('/api/session');
      setSession(info);
      const requested = new URLSearchParams(window.location.search).get('process');
      setProcessKey((current) =>
        info.processes.find((process) => process.process_key === requested)?.process_key
        ?? info.processes.find((process) => process.process_key === current)?.process_key
        ?? info.processes[0]?.process_key
        ?? '',
      );
    } catch {
      setSession(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const checkSiteAdmin = useCallback(async () => {
    if (!session?.actor.id) { setSiteAdmin(false); return; }
    try {
      const response = await fetch('/api/platform/me', { credentials: 'same-origin' });
      setSiteAdmin(response.ok);
    } catch {
      setSiteAdmin(false);
    }
  }, [session?.actor.id]);

  useEffect(() => { void checkSiteAdmin(); }, [checkSiteAdmin]);

  /*
   * A record in the address bar is opened on arrival, and the browser's back
   * button closes it. Both directions, because a page that pushes history and
   * ignores it leaves the arrow pointing at a state the page will not return
   * to.
   */
  useEffect(() => {
    if (!session) return;
    const fromUrl = new URLSearchParams(window.location.search).get('record');
    if (fromUrl && !record) void open(fromUrl);

    const onPop = () => {
      const id = new URLSearchParams(window.location.search).get('record');
      if (id) void open(id);
      else {
        setRecord(null);
        setView('work');
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // `open` is recreated every render and would resubscribe forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const load = useCallback(async () => {
    if (!session) return;
    setError(null);
    if (processKey) {
      try {
        setWork(await call<Work>(`/api/work?process=${processKey}`));
      } catch (err) {
        setWork(null);
        if (err instanceof Unauthenticated) return endSession();
        setError(err instanceof Error ? err.message : String(err));
      }
    } else {
      setWork(null);
    }
    try {
      setHeldCount((await call<{ held: unknown[] }>('/api/held')).held.length);
    } catch {
      setHeldCount(0);
    }
    if (processKey) {
      try {
        setHealth(await call<Health>(`/api/automation?process=${processKey}`));
      } catch {
        // Automation health needs `report`. Someone without it does not get the
        // panel, which is the right answer rather than an error.
        setHealth(null);
      }
    } else {
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

  const act = async (key: string, fn: () => Promise<unknown>, success: string | ((result: unknown) => string)) => {
    setBusy(key);
    try {
      const result = await fn();
      setToast({ message: typeof success === 'function' ? success(result) : success });
      setRecord(null);
      await load();
    } catch (err) {
      if (err instanceof Unauthenticated) return endSession();
      // A refusal is information, not a crash: it says whether to ask for
      // access or to ask a different person.
      setToast({ message: err instanceof Error ? err.message : String(err), refused: true });
    } finally {
      setBusy(null);
    }
  };

  /*
   * The reason is written into the record's history and may be shown to the
   * applicant, so the record page asks for one on a rejection. The list's
   * quick buttons still send a default — a decision made in one click is
   * still a real decision and has to say where it came from.
   */
  const decide = (
    instanceId: string,
    approvalKey: string,
    decision: 'approved' | 'rejected' | 'changes_requested',
    reason = 'Decided in the console',
  ) =>
    act(
      `${instanceId}:${approvalKey}`,
      () =>
        call(`/api/records/${instanceId}/decide`, {
          method: 'POST',
          body: JSON.stringify({ approvalKey, decision, reason }),
        }),
      (result) => {
        /*
         * An approval that needs more than one person is counted, not
         * settled. Saying "the process moved on" when it is waiting for a
         * second director would send somebody to look for a step that has
         * not happened.
         */
        const progress = (result as { progress?: { have: number; need: number; against?: number; of?: number } })
          ?.progress;
        // A vote: say the tally, whichever way this one went.
        if (progress && progress.of !== undefined) {
          return `Your vote is counted: ${progress.have} for, ${progress.against ?? 0} against, of ${progress.of}. It passes at ${progress.need} in favour.`;
        }
        if (decision === 'approved' && progress) {
          const left = progress.need - progress.have;
          return `Approval recorded — ${progress.have} of ${progress.need}. It needs ${left === 1 ? 'one more person' : `${left} more people`}.`;
        }
        return decision === 'approved' ? 'Approved. The process moved on.' : 'Rejected. The record is closed.';
      },
    );

  const completeTask = (instanceId: string, taskKey: string, answers: Record<string, string> = {}) =>
    act(
      `${instanceId}:${taskKey}`,
      () => call(`/api/records/${instanceId}/tasks/${taskKey}/complete`, {
        method: 'POST', body: JSON.stringify({ answers }),
      }),
      'Task completed.',
    );

  const replay = (outboxId: number) =>
    act(`replay:${outboxId}`, () => call(`/api/automation/${outboxId}/replay`, { method: 'POST' }), 'Queued for replay.');

  /**
   * §20.1 step 11. The file is built server-side and downloaded here, so
   * nothing about who may see which field is decided in the browser — the
   * bundle arrives already redacted for whoever asked for it.
   */
  const exportRecord = async (instanceId: string, ref: string, format: 'json' | 'csv') => {
    try {
      const body = await call<Record<string, unknown> & { body?: string; filename?: string }>(
        `/api/records/${instanceId}/export${format === 'csv' ? '?format=csv' : ''}`,
      );
      const text = format === 'csv' ? String(body.body ?? '') : JSON.stringify(body, null, 2);
      const name = format === 'csv' ? String(body.filename ?? `${ref}.csv`) : `${ref}-export.json`;
      const url = URL.createObjectURL(new Blob([text], { type: format === 'csv' ? 'text/csv' : 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      const withheld = Array.isArray(body.withheld) ? (body.withheld as string[]) : [];
      setToast({
        message: withheld.length
          ? `Exported ${name}. ${withheld.length} field(s) withheld from your role: ${withheld.join(', ')}.`
          : `Exported ${name}.`,
      });
    } catch (err) {
      if (err instanceof Unauthenticated) return endSession();
      setToast({ message: err instanceof Error ? err.message : String(err), refused: true });
    }
  };

  /**
   * Opens a record as its own page.
   *
   * It also puts the record in the address bar. A console where the thing you
   * are looking at has no URL cannot be linked to in a ticket, cannot be
   * reopened from history, and loses your place on reload — and this is a page
   * people are sent to in order to decide something.
   */
  const open = async (instanceId: string) => {
    try {
      const detail = await call<RecordDetail>(`/api/records/${instanceId}`);
      setRecord(detail);
      setProcessKey(detail.processKey);
      setView('record');
      window.history.pushState({ record: instanceId }, '', `?record=${encodeURIComponent(instanceId)}`);
    } catch (err) {
      if (err instanceof Unauthenticated) return endSession();
      setToast({ message: err instanceof Error ? err.message : String(err), refused: true });
    }
  };

  /** Back to the work list, and out of the address bar with it. */
  const closeRecord = useCallback(() => {
    setRecord(null);
    setShowTrail(false);
    setView('work');
    window.history.pushState({}, '', window.location.pathname);
  }, []);

  const signOut = async () => {
    await call('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setSession(null);
    setWork(null);
    setHealth(null);
  };

  if (checking) return <BootScreen where="console" label="Opening the console" />;
  if (!session) return <SignIn onSignedIn={() => void refreshSession()} signedOut={wasSignedOut} />;

  const me = session.actor;
  const counts = work?.counts ?? { arrived: 0, needsYou: 0, late: 0, failed: 0 };

  return (
    <div className="cs">
      <a className="skip-link" href="#console-main">
        Skip to your work
      </a>

      {/*
        * The product bar. It carries the product name and the workspace
        * name side by side — the rail was stacking them in a narrow column,
        * which read as two brands rather than one application.
        */}
      <header className="cs__top">
        <button type="button" className="cs__menuToggle" aria-label="Open menu" aria-expanded={mobileNavOpen} aria-controls="console-navigation" onClick={() => setMobileNavOpen(true)}>
          <span aria-hidden="true">☰</span>
        </button>
        <span className="cs__topBrand">
          <svg width="20" height="20" viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="var(--green-mint)" strokeWidth="1.8" />
            <path d="M7 13.2L11 17L19 9" stroke="var(--green-mint)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Patform
        </span>
        <span className="cs__topDivider" aria-hidden="true" />
        <span className="cs__topWorkspace">{me.workspace_name}</span>
      </header>

      <ReauthDialog />
      <div className="cs__shell">
      {mobileNavOpen && <button type="button" className="cs__navBackdrop" aria-label="Close menu" onClick={() => setMobileNavOpen(false)} />}
      <aside id="console-navigation" className={`cs__side${mobileNavOpen ? ' cs__side--open' : ''}`} onClick={(event) => {
        if ((event.target as HTMLElement).closest('button, a')) setMobileNavOpen(false);
      }}>
        <div className="cs__mobileNavHead"><strong>Menu</strong><button type="button" aria-label="Close menu" onClick={() => setMobileNavOpen(false)}>×</button></div>
        <nav className="cs__nav" aria-label="Console">
          <button
            type="button"
            className="cs__navItem"
            aria-current={view === 'work' ? 'page' : undefined}
            onClick={() => setView('work')}
          >
            <NavIcon name="work" />
            <span className="cs__navText">My work</span>
            {counts.needsYou > 0 && <span className="cs__navCount">{counts.needsYou}</span>}
          </button>
          <button
            type="button"
            className="cs__navItem"
            aria-current={view === 'ask' ? 'page' : undefined}
            onClick={() => setView('ask')}
          >
            <NavIcon name="ask" />
            <span className="cs__navText">Ask</span>
          </button>
          <button
            type="button"
            className="cs__navItem"
            aria-current={view === 'records' ? 'page' : undefined}
            onClick={() => setView('records')}
          >
            <NavIcon name="records" />
            <span className="cs__navText">Records</span>
          </button>
          <button
            type="button"
            className="cs__navItem"
            aria-current={view === 'dashboard' ? 'page' : undefined}
            onClick={() => setView('dashboard')}
          >
            <NavIcon name="dashboard" />
            <span className="cs__navText">Dashboard</span>
          </button>
          <button
            type="button"
            className="cs__navItem"
            aria-current={view === 'health' ? 'page' : undefined}
            onClick={() => setView('health')}
          >
            <NavIcon name="health" />
            <span className="cs__navText">Automation health</span>
            {counts.failed > 0 && <span className="cs__navCount cs__navCount--bad">{counts.failed}</span>}
          </button>
          <button
            type="button"
            className="cs__navItem"
            aria-current={view === 'held' ? 'page' : undefined}
            onClick={() => setView('held')}
          >
            <NavIcon name="held" />
            <span className="cs__navText">Held submissions</span>
            {heldCount > 0 && (
              <span className="cs__navCount" aria-label={`${heldCount} waiting`}>
                {heldCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className="cs__navItem"
            aria-current={view === 'processes' ? 'page' : undefined}
            onClick={() => setView('processes')}
          >
            <NavIcon name="processes" />
            <span className="cs__navText">Processes &amp; forms</span>
          </button>
          <button
            type="button"
            className="cs__navItem"
            aria-current={view === 'people' || view === 'invite' ? 'page' : undefined}
            onClick={() => setView('people')}
          >
            <NavIcon name="people" />
            <span className="cs__navText">People</span>
          </button>
          {/* The builder is a different application, so a link rather than a
              view — and it was not linked from here at all, which is how
              somebody could use this console without ever learning that
              processes are designed rather than configured. */}
          <a className="cs__navItem" href="/builder">
            <NavIcon name="builder" />
            <span className="cs__navText">Builder</span>
          </a>

          <span className="cs__sectionLabel" style={{ marginTop: 10 }}>
            SETTINGS
          </span>
          <button
            type="button"
            className="cs__navItem"
            aria-current={view === 'integrations' ? 'page' : undefined}
            onClick={() => setView('integrations')}
          >
            <NavIcon name="integrations" />
            <span className="cs__navText">Integrations</span>
          </button>
          <button
            type="button"
            className="cs__navItem"
            aria-current={view === 'data' ? 'page' : undefined}
            onClick={() => setView('data')}
          >
            <NavIcon name="data" />
            <span className="cs__navText">Import &amp; data</span>
          </button>
        </nav>

        <div className="cs__processList">
          <span className="cs__sectionLabel">PROCESSES</span>
          {session.processes.map((p) => (
            <button
              key={p.process_key}
              type="button"
              className="cs__process"
              aria-current={processKey === p.process_key}
              /*
               * Switching process on a page that has nothing to do with a
               * process — Integrations, People, your account — changed a value
               * nothing on screen was showing, so the button read as broken.
               * It now takes you to that process's work, which is what
               * choosing a process is for.
               */
              onClick={() => {
                setProcessKey(p.process_key);
                setRecord(null);
                setView('work');
              }}
            >
              <span className="cs__dot" aria-hidden="true" />
              <span className="cs__processText">{p.name}</span>
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
          {/* Beside the seat rather than in the main nav: it is about the
              person signed in, not about the workspace's work. */}
          <button
            type="button"
            className="cs__seatPicker"
            aria-current={view === 'security' ? 'page' : undefined}
            onClick={() => setView('security')}
          >
            <Icon name="account" />
            <span>Your account</span>
          </button>
          <button type="button" className="cs__seatPicker" onClick={() => void signOut()}>
            <Icon name="logout" />
            <span>Sign out</span>
          </button>
          {siteAdmin && <a className="cs__seatPicker" href="/platform">Site administration ↗</a>}
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

      <main className="cs__main" id="console-main" tabIndex={-1}>
        {!me.email_verified_at && <VerifyBanner email={me.email} />}
        <div className="cs__head">
          <h1>
            {view === 'record'
              ? (record?.reference ?? 'Record')
              : view === 'ask'
                ? 'Ask'
              : view === 'records'
                ? 'Records'
                : view === 'dashboard'
                  ? 'Dashboard'
                  : view === 'health'
                    ? 'Automation health'
                  : view === 'held'
                    ? 'Held submissions'
                    : view === 'security'
                      ? 'Your account'
                      : view === 'people'
                        ? 'People'
                        : view === 'invite'
                          ? 'Invite people'
                        : view === 'processes'
                          ? 'Processes & forms'
                          : view === 'integrations'
                            ? 'Integrations'
                            : view === 'data'
                              ? 'Import & data'
                              : 'My work'}
          </h1>
          {/* The process pill is context for the record views. On People,
              Processes and Your account it named a process the page has
              nothing to do with. */}
          {['work', 'record', 'ask', 'records', 'dashboard'].includes(view) && (view === 'record' ? record : work) && (
            <span className="cs__version">{view === 'record' && record ? record.processName : work?.processName}</span>
          )}
          <span className="cs__headSpacer" />
          {view !== 'security' && <button type="button" className="cs__btn" onClick={() => void load()}>
            Refresh
          </button>}
        </div>

        <div className={`cs__body ${view === 'security' ? 'cs__body--security' : ''}`}>
          <div className="cs__left">
            {view === 'record' && record ? (
              <RecordPage
                key={`${record.instanceId}:${work?.tasks.find((t) => t.instanceId === record.instanceId)?.taskKey ?? ''}`}
                record={record}
                approval={work?.approvals.find((a) => a.instanceId === record.instanceId)}
                task={work?.tasks.find((t) => t.instanceId === record.instanceId)}
                busy={busy}
                onBack={closeRecord}
                onDecide={(id, key, decision, reason) => void decide(id, key, decision, reason)}
                onCompleteTask={(id, key, answers) => void completeTask(id, key, answers)}
                onExport={(id, ref, format) => void exportRecord(id, ref, format)}
              />
            ) : view === 'integrations' ? (
              <IntegrationsView />
            ) : view === 'data' ? (
              <DataView processes={session.processes} />
            ) : view === 'people' ? (
              <PeopleView
                canAdminister={['owner', 'admin', 'builder'].includes(me.workspace_role)}
                onInvite={() => setView('invite')}
              />
            ) : view === 'invite' ? (
              <InviteView onBack={() => setView('people')} />
            ) : view === 'processes' ? (
              <ProcessesView
                processes={session.processes}
                canAdminister={['owner', 'admin', 'builder'].includes(me.workspace_role)}
                onOpenRecord={(id) => {
                  void open(id);
                  setView('work');
                }}
              />
            ) : view === 'security' ? (
              <SecurityView onAccessChange={() => void checkSiteAdmin()} />
            ) : view === 'held' ? (
              <HeldView onChanged={setHeldCount} />
            ) : !processKey && ['work', 'records', 'dashboard', 'ask'].includes(view) ? (
              <div className="cs__panel">
                <div className="cs__empty">
                  <strong>Your workspace is ready</strong>
                  <p>Choose a template to set up your first process. Its form, approvals and tasks will appear here once it is published.</p>
                  <a className="cs__btn cs__btn--primary" href="/builder/new" style={{ display: 'inline-flex', alignItems: 'center', marginTop: 12 }}>Explore templates</a>
                </div>
              </div>
            ) : view === 'health' ? (
              // `administer` is what the lift endpoint requires, so the button
              // is only offered to somebody the server will accept it from.
              <HealthView canAdminister={['owner', 'admin', 'builder'].includes(me.workspace_role)} />
            ) : view === 'dashboard' ? (
              <DashboardView processKey={processKey} />
            ) : view === 'records' ? (
              <RecordsView
                processKey={processKey}
                /*
                 * The detail panel lives in the work view, so opening a record
                 * from anywhere else has to go there too. This one did not, and
                 * the result was a reference you could click all day: the record
                 * loaded, and it loaded behind a view nobody was looking at.
                 */
                onOpenRecord={(id) => {
                  void open(id);
                  setView('work');
                }}
              />
            ) : view === 'ask' ? (
              <Ask
                processKey={processKey}
                onOpenRecord={(id) => {
                  void open(id);
                  setView('work');
                }}
              />
            ) : error ? (
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

                <WorkList
                  approvals={work?.approvals ?? []}
                  tasks={work?.tasks ?? []}
                  busy={busy}
                  onOpen={(id) => void open(id)}
                  onDecide={(id, key, decision) => void decide(id, key, decision)}
                  onCompleteTask={(id, key) => void completeTask(id, key)}
                />
              </>
            )}
          </div>

          {/* The record page carries its own side column; two of them would
              be a column of cards about a different subject. */}
          {view !== 'record' && view !== 'security' && (
          <div className="cs__right">
            {!processKey ? null : health ? (
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
                    {f.outboxId > 0 ? <button
                      type="button"
                      className="cs__btn cs__btn--danger"
                      style={{ marginTop: 11 }}
                      disabled={busy !== null}
                      onClick={() => void replay(f.outboxId)}
                    >
                      Replay this action
                    </button> : <p className="cs__failureBody">This email failed outside the retry queue. Check its address and provider, then use a new test request.</p>}
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

            {/* The explainer described "My work" on every view, including the
                ones it was not describing. It follows the view now. */}
            <div className="cs__card cs__card--dark">
              <span className="cs__cardLabel">WHAT THIS SCREEN IS</span>
              <p style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.5, color: 'var(--on-dark-2)' }}>
                {view === 'health'
                  ? 'What the automation did, and who it can no longer reach. A hard bounce or a spam complaint stops this deployment writing to that address — the record will say "skipped" and this is the page that says why.'
                  : view === 'people'
                    ? 'Who is in this workspace and what they may do. An invitation is emailed, works once, and expires in seven days — the link is never shown here, because anybody who can invite could otherwise mint one for an address whose owner never sees it.'
                  : view === 'invite'
                    ? 'One person, a pasted list, or a spreadsheet. Every row is checked before anything is sent: typos, duplicates, people already here and roles you cannot give are set aside, and only the rest go. Each invitation works once and expires in seven days.'
                  : view === 'processes'
                    ? 'Where records come from. Each published process serves a form at its own link; every submission becomes a record, routed by that process’s own rules. Nobody needs an account to submit one.'
                  : view === 'integrations'
                    ? 'Everything outside this workspace that can reach it, or that it reaches. Keys and signing secrets are shown once and stored as hashes, so a copy of our database is not a set of working credentials.'
                  : view === 'data'
                    ? 'Getting records in from a spreadsheet, what this workspace holds and where each value travels, and deleting what is past its retention. The dry run executes the whole thing and rolls it back — the only honest way to answer what would this delete.'
                  : view === 'dashboard'
                    ? 'Nine measures from section 13.1, over the period you choose. A rate over fewer than five records is withheld rather than shown, because a percentage of three people identifies them.'
                    : view === 'records'
                      ? 'Every record you are allowed to see, newest first. The same cursor pagination the public API uses, so one behaviour is tested twice.'
                      : view === 'ask'
                        ? 'A question becomes a typed plan, the plan is shown to you before anything runs, and what executes is bound to what you confirmed.'
                        : 'Four questions, in order: what arrived, what needs you, what is late, what failed. Sign in as someone else and the same records offer different actions — every one of them checked by the runtime, not by this page.'}
              </p>
            </div>
          </div>
          )}
        </div>
      </main>
      </div>

      {toast && (
        <div
          className={`cs__toast ${toast.refused ? 'cs__toast--refused' : ''}`}
          role={toast.refused ? 'alert' : 'status'}
          aria-live={toast.refused ? 'assertive' : 'polite'}
        >
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

/**
 * Says what is actually blocked, and nothing else.
 *
 * A banner that says "please verify your email" without saying what it costs
 * you gets dismissed; one that says you cannot invite anybody gets acted on
 * the day somebody needs to invite somebody.
 */
function VerifyBanner({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [note, setNote] = useState<string | null>(null);

  const resend = async () => {
    setState('sending');
    try {
      const body = await call<{ sent: boolean; reason: string | null }>(
        '/api/account/resend-verification',
        { method: 'POST' },
      );
      setNote(body.sent ? null : body.reason);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'that did not work');
    } finally {
      setState('sent');
    }
  };

  return (
    <div className="cs__banner" role="status">
      <span>
        Confirm <strong>{email}</strong> to invite people into this workspace. Everything else works
        already.
      </span>
      {state === 'sent' ? (
        <span>{note ?? 'Sent — check your inbox, including spam.'}</span>
      ) : (
        <button type="button" className="cs__linkBtn cs__linkBtn--onLight" onClick={() => void resend()} disabled={state === 'sending'}>
          {state === 'sending' ? 'Sending…' : 'Send the link again'}
        </button>
      )}
    </div>
  );
}

/**
 * Signing in, and the screen somebody reaches when they cannot.
 *
 * Two screens rather than one form doing both jobs. The first version put the
 * reset control under the sign-in form and said "type your address above" —
 * which left a password field on screen that had nothing to do with what the
 * person was trying to do, and made the instruction a workaround for the
 * layout rather than a thing anybody would write.
 */
/**
 * The rail's icons.
 *
 * Inline rather than from an icon package: six shapes do not justify a
 * dependency, and `aria-hidden` is the important part — the label beside each
 * one already says what it is, so announcing the icon as well would read the
 * item twice.
 */
function NavIcon({
  name,
}: {
  name:
    | 'work'
    | 'ask'
    | 'records'
    | 'dashboard'
    | 'health'
    | 'held'
    | 'processes'
    | 'people'
    | 'builder'
    | 'integrations'
    | 'data';
}) {
  const common = {
    className: 'cs__navIcon',
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'work':
      return (
        <svg {...common}>
          <rect x="2.8" y="5.2" width="14.4" height="11" rx="1.8" />
          <path d="M7 5.2V4a1.2 1.2 0 0 1 1.2-1.2h3.6A1.2 1.2 0 0 1 13 4v1.2" />
          <path d="M2.8 9.6h14.4" />
        </svg>
      );
    case 'ask':
      return (
        <svg {...common}>
          <path d="M3 9.4c0-3 3.1-5.4 7-5.4s7 2.4 7 5.4-3.1 5.4-7 5.4a8.7 8.7 0 0 1-2.2-.3L4.2 16l.9-2.5A5.2 5.2 0 0 1 3 9.4Z" />
        </svg>
      );
    case 'records':
      return (
        <svg {...common}>
          <rect x="3.4" y="2.8" width="13.2" height="14.4" rx="1.8" />
          <path d="M6.6 7h6.8M6.6 10h6.8M6.6 13h4.2" />
        </svg>
      );
    case 'dashboard':
      return (
        <svg {...common}>
          <path d="M3.2 15.4h13.6" />
          <path d="M5.8 15.4V9.2M10 15.4V4.6M14.2 15.4v-4" />
        </svg>
      );
    case 'health':
      return (
        <svg {...common}>
          <path d="M2.8 10.4h3.3l1.7-4.6 2.6 8.6 1.9-5.3 1.1 1.3h3.8" />
        </svg>
      );
    case 'held':
      // A tray with something waiting in it.
      return (
        <svg {...common}>
          <path d="M2.8 11.4 4.6 4.4a1.2 1.2 0 0 1 1.2-.9h8.4a1.2 1.2 0 0 1 1.2.9l1.8 7" />
          <path d="M2.8 11.4v3.8a1.2 1.2 0 0 0 1.2 1.2h12a1.2 1.2 0 0 0 1.2-1.2v-3.8h-4.1l-1 1.8H7.9l-1-1.8Z" />
        </svg>
      );
    case 'processes':
      return (
        <svg {...common}>
          <rect x="2.6" y="3" width="6" height="4.4" rx="1.2" />
          <rect x="11.4" y="12.6" width="6" height="4.4" rx="1.2" />
          <path d="M5.6 7.4v4.2a1.4 1.4 0 0 0 1.4 1.4h4.4" />
        </svg>
      );
    case 'people':
      return (
        <svg {...common}>
          <circle cx="7.6" cy="7" r="2.7" />
          <path d="M2.8 16.2c0-2.5 2.1-4.2 4.8-4.2s4.8 1.7 4.8 4.2" />
          <path d="M13.2 5.1a2.7 2.7 0 0 1 0 5.2M14.4 12.4c1.7.5 2.8 1.8 2.8 3.8" />
        </svg>
      );
    case 'builder':
      return (
        <svg {...common}>
          <path d="M11.6 3.4a3.4 3.4 0 0 0 4.4 4.4l-8 8a1.9 1.9 0 0 1-2.7-2.7l8-8Z" />
          <path d="M4.2 14.2 3 17l2.8-1.2" />
        </svg>
      );
    case 'integrations':
      return (
        <svg {...common}>
          <path d="M8.4 11.6 5.6 14.4a2.9 2.9 0 0 0 4.1 4.1l2.1-2.1" transform="translate(0,-2.4)" />
          <path d="M11.6 8.4l2.8-2.8a2.9 2.9 0 0 0-4.1-4.1L8.2 3.6" transform="translate(0,2.4)" />
          <path d="M7.8 12.2l4.4-4.4" />
        </svg>
      );
    case 'data':
      return (
        <svg {...common}>
          <ellipse cx="10" cy="5.2" rx="6.2" ry="2.4" />
          <path d="M3.8 5.2v9.6c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4V5.2" />
          <path d="M3.8 10c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4" />
        </svg>
      );
  }
}

/**
 * Where to go after signing in, when somebody arrived from elsewhere.
 *
 * Only the consent screen, and only as a path on this site. A sign-in page
 * that followed any `next` would be an open redirect with this domain's name
 * on it — the link a phishing email wants.
 */
function returnPath(): string | null {
  if (typeof window === 'undefined') return null;
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next || !next.startsWith('/oauth/authorize?') || next.startsWith('//')) return null;
  return next;
}

function SignIn({ onSignedIn: signedIn, signedOut }: { onSignedIn: () => void; signedOut?: boolean }) {
  const onSignedIn = () => {
    const next = returnPath();
    if (next) window.location.assign(next);
    else signedIn();
  };
  const [mode, setMode] = useState<'signin' | 'forgot' | 'sent' | 'code'>('signin');
  const [challengeToken, setChallengeToken] = useState('');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailField = useRef<HTMLInputElement>(null);

  // 2.4.3: switching screens replaces what is on screen, and focus has to
  // follow. Otherwise the next Tab continues from a control that is gone.
  useEffect(() => {
    if (mode === 'forgot' || mode === 'code') emailField.current?.focus();
  }, [mode]);

  const askForReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await call('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email }) });
    } catch {
      // Swallowed on purpose. The screen that follows is the same one whatever
      // happened, including a network failure — anything that varies here
      // tells a stranger whether the address has an account.
    } finally {
      setMode('sent');
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ mfaRequired?: boolean; challengeToken?: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      // A correct password on an account with a second factor. No cookie was
      // set, so there is nothing to undo if this is abandoned here.
      if (result.mfaRequired && result.challengeToken) {
        setChallengeToken(result.challengeToken);
        setCode('');
        setMode('code');
        return;
      }
      onSignedIn();
    } catch (err) {
      // One message for every failure. Saying "no such account" would let a
      // stranger enumerate who works here.
      setError(err instanceof Error ? err.message : 'those details do not match an account');
    } finally {
      setBusy(false);
    }
  };

  const answerChallenge = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const done = await call<{ usedRecoveryCode: boolean; recoveryCodesLeft: number }>('/api/auth/mfa', {
        method: 'POST',
        body: JSON.stringify({ challengeToken, code }),
      });
      if (done.usedRecoveryCode) {
        // Said once, plainly, to the person least likely to check and most
        // likely to need the next one.
        window.sessionStorage.setItem('patform.recoveryLeft', String(done.recoveryCodesLeft));
      }
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'that code is not right');
      setBusy(false);
    }
  };

  const brand = (
    <div className="cs__brand" style={{ color: 'var(--ink)', padding: 0 }}>
      <svg width="24" height="24" viewBox="0 0 26 26" fill="none" aria-hidden="true">
        <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="var(--green)" strokeWidth="1.8" />
        <path d="M7 13.2L11 17L19 9" stroke="var(--green)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Patform
    </div>
  );

  // ---- the link has been sent, or would have been
  if (mode === 'sent') {
    return (
      <div className="cs__login">
        <div className="cs__loginBox">
          {brand}
          <h1 className="cs__loginTitle">Check your email</h1>
          <p className="cs__loginNote" style={{ marginTop: 0 }} role="status">
            If <strong style={{ overflowWrap: 'anywhere' }}>{email}</strong> has an account, a reset
            link is on its way. It works once and expires in half an hour.
          </p>
          <p className="cs__loginNote">
            Nothing arriving? Check spam, and make sure that is the address you signed up with — we
            cannot tell you whether it has an account, because that would let anybody find out who
            works here.
          </p>
          <button
            type="button"
            className="cs__btn cs__btn--primary"
            style={{ marginTop: 18, width: '100%', height: 44 }}
            onClick={() => {
              setMode('signin');
              setError(null);
            }}
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  // ---- the second step
  if (mode === 'code') {
    return (
      <div className="cs__login">
        <form className="cs__loginBox" onSubmit={answerChallenge}>
          {brand}
          <h1 className="cs__loginTitle">Enter your code</h1>
          <p className="cs__loginNote" style={{ marginTop: 0, marginBottom: 18 }}>
            Open your authenticator app and type the six-digit code for Patform. Lost your phone? A
            recovery code works here too.
          </p>

          <label className="cs__label" htmlFor="mfa-code">
            Code
          </label>
          <input
            ref={emailField}
            id="mfa-code"
            className="cs__input"
            type="text"
            /* `one-time-code` is what lets a phone offer the code from the
               notification, and inputMode numeric gets the right keypad —
               while still accepting a recovery code, which has letters. */
            autoComplete="one-time-code"
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />

          {error && (
            <p className="cs__loginError" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="cs__btn cs__btn--primary"
            style={{ marginTop: 18, width: '100%', height: 44 }}
            disabled={busy}
          >
            {busy ? 'Checking…' : 'Sign in'}
          </button>

          <p className="cs__loginNote">
            <button
              type="button"
              className="cs__linkBtn cs__linkBtn--onLight"
              onClick={() => {
                setMode('signin');
                setError(null);
                setPassword('');
              }}
            >
              Back to sign in
            </button>
          </p>
        </form>
      </div>
    );
  }

  // ---- one field, because one field is what this asks for
  if (mode === 'forgot') {
    return (
      <div className="cs__login">
        <form className="cs__loginBox" onSubmit={askForReset}>
          {brand}
          <h1 className="cs__loginTitle">Reset your password</h1>
          <p className="cs__loginNote" style={{ marginTop: 0, marginBottom: 18 }}>
            Tell us the address you sign in with and we will email you a link.
          </p>

          <label className="cs__label" htmlFor="forgot-email">
            Email
          </label>
          <input
            ref={emailField}
            id="forgot-email"
            className="cs__input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <button
            type="submit"
            className="cs__btn cs__btn--primary"
            style={{ marginTop: 18, width: '100%', height: 44 }}
            disabled={busy}
          >
            {busy ? 'Sending…' : 'Send me a reset link'}
          </button>

          <p className="cs__loginNote">
            <button
              type="button"
              className="cs__linkBtn cs__linkBtn--onLight"
              onClick={() => setMode('signin')}
            >
              Back to sign in
            </button>
          </p>
        </form>
      </div>
    );
  }

  // ---- signing in
  return (
    <div className="cs__login">
      <form className="cs__loginBox" onSubmit={submit}>
        {brand}
        <h1 className="cs__loginTitle">Sign in to the console</h1>

        {signedOut && (
          <p className="cs__loginNote" style={{ marginTop: 0, marginBottom: 16 }} role="status">
            Your session ended — it expired, or it was signed out from somewhere else. Nothing you
            saved is affected.
          </p>
        )}

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
        <PasswordInput
          id="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {/* 3.3.1: a screen-reader user submits this form and, without an
            alert, hears nothing at all — the page simply stays put. */}
        {error && (
          <p className="cs__loginError" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="cs__btn cs__btn--primary" style={{ marginTop: 18, width: '100%', height: 44 }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="cs__loginNote">
          <button
            type="button"
            className="cs__linkBtn cs__linkBtn--onLight"
            onClick={() => setMode('forgot')}
          >
            Forgotten your password?
          </button>
        </p>

        <p className="cs__loginNote">
          New here? <a href="/signup" style={{ textDecoration: 'underline' }}>Create a workspace</a>.
        </p>
      </form>
    </div>
  );
}
