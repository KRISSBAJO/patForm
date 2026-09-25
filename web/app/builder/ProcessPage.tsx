'use client';

/**
 * Preview, Versions and Tests, each as a page of its own.
 *
 * They were three tabs of a 360-pixel column beside the editor, and the rail
 * buttons that led to them were greyed out until a draft was open — so the
 * builder's front door had three dead buttons on it, and the only way to see
 * a form was at 62% scale beside a list of settings. Here each one gets the
 * whole width, works without opening a draft, and can look at any version:
 * the draft in progress, what respondents get today, or version 2 when
 * somebody asks what the form said in March.
 *
 * Nothing here edits. The editor is still the only place a blueprint
 * changes; every page links back to it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BootScreen } from '../../components/boot-screen';
import { RailIcon } from './Builder';
import { FormPreview, type ScenarioResult, type VersionRow } from './SidePanel';
import './builder.css';
import './pages.css';

type Kind = 'preview' | 'versions' | 'tests';
type Which = 'draft' | 'latest' | number;

interface ProcessRow {
  process_key: string;
  name: string | null;
  version: number | null;
  draft_id: string | null;
  instances: number;
}

type PreviewShape = Parameters<typeof FormPreview>[0]['blueprint'];

interface Scenario {
  key: string;
  kind: string;
  name: string;
}

interface ProcessView {
  processKey: string;
  name: string;
  versions: number[];
  draftId: string | null;
  source: 'draft' | 'published';
  version: number | null;
  blueprint: PreviewShape & { tests?: Scenario[] };
  publishable: boolean;
}

interface TestRun {
  results: ScenarioResult[];
  passed: number;
  total: number;
}

class SignedOut extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new SignedOut(body.error ?? 'sign in first');
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

const TITLES: Record<Kind, { eyebrow: string; lede: string }> = {
  preview: {
    eyebrow: 'Preview',
    lede: 'The form exactly as somebody outside your workspace sees it. Type in it if you like: nothing is saved and nothing is sent.',
  },
  versions: {
    eyebrow: 'Versions',
    lede: 'Every published version, what changed in each, and who published it. Records keep running on the version they started under, which is why old versions stay.',
  },
  tests: {
    eyebrow: 'Tests',
    lede: 'Each scenario runs against the real engine in a scratch workspace: the same permission checks, transitions and effects. Nothing is simulated and nothing touches your records.',
  },
};

function readUrl(): { process: string | null; which: Which } {
  if (typeof window === 'undefined') return { process: null, which: 'latest' };
  const q = new URLSearchParams(window.location.search);
  const v = q.get('v');
  const which: Which = v === 'draft' ? 'draft' : v && /^\d+$/.test(v) ? Number(v) : 'latest';
  return { process: q.get('process'), which };
}

export function ProcessPage({ kind }: { kind: Kind }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [processes, setProcesses] = useState<ProcessRow[] | null>(null);
  const [processKey, setProcessKey] = useState<string | null>(null);
  const [which, setWhich] = useState<Which>('latest');
  const [view, setView] = useState<ProcessView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback((err: unknown) => {
    if (err instanceof SignedOut) setSignedIn(false);
    else setError(err instanceof Error ? err.message : String(err));
  }, []);

  // Who is here, and what they can look at. The process comes from the link
  // when there is one, so the editor's rail can hand over the process it had open.
  useEffect(() => {
    (async () => {
      try {
        await call('/api/session');
        setSignedIn(true);
        const rows = await call<ProcessRow[]>('/api/builder/processes');
        setProcesses(rows);
        const asked = readUrl();
        const key = rows.find((r) => r.process_key === asked.process)?.process_key ?? rows[0]?.process_key ?? null;
        setProcessKey(key);
        setWhich(key === asked.process ? asked.which : 'latest');
      } catch (err) {
        fail(err);
      }
    })();
  }, [fail]);

  useEffect(() => {
    if (!processKey) return;
    setView(null);
    setError(null);
    const q = new URLSearchParams({ process: processKey });
    if (which !== 'latest') q.set('v', String(which));
    window.history.replaceState(null, '', `${window.location.pathname}?${q}`);
    call<ProcessView>(`/api/builder/processes/${encodeURIComponent(processKey)}/view?which=${which}`)
      .then(setView)
      .catch(fail);
  }, [processKey, which, fail]);

  if (signedIn === null) return <BootScreen where="builder" label={`Opening ${TITLES[kind].eyebrow.toLowerCase()}`} />;
  if (signedIn === false) {
    return (
      <div className="bd__gate">
        <div className="bd__gateCard">
          <h1>Sign in to keep building</h1>
          <p>Your session ended. Sign in again and this page will be where you left it.</p>
          <a className="bd__gateBtn" href="/console">
            Sign in
          </a>
        </div>
      </div>
    );
  }

  const row = processes?.find((p) => p.process_key === processKey) ?? null;
  const editHref = row?.draft_id && which === 'draft'
    ? `/builder?draft=${row.draft_id}`
    : processKey ? `/builder?process=${encodeURIComponent(processKey)}` : '/builder';

  return (
    <div className="bd">
      <a className="skip-link" href="#page-main">
        Skip to the content
      </a>
      <header className="bd__top">
        <span className="bd__topBrand">
          <svg width="20" height="20" viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="var(--green-mint)" strokeWidth="1.8" />
            <path d="M7 13.2L11 17L19 9" stroke="var(--green-mint)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Patform
        </span>
        <span className="bd__topDivider" aria-hidden="true" />
        <span className="bd__topWhere">Builder · {TITLES[kind].eyebrow}</span>
        <span style={{ flexGrow: 1 }} />
        <a className="bd__topLink" href="/console">
          Back to the console
        </a>
      </header>

      <div className="bd__shell">
        <nav className="bd__rail" aria-label="Builder">
          <a className="bd__railItem" href={editHref}>
            <RailIcon name="processes" />
            <span>Editor</span>
          </a>
          <a className="bd__railItem" href="/builder/new">
            <RailIcon name="catalogue" />
            <span>Catalogue</span>
          </a>
          <span className="bd__railRule" aria-hidden="true" />
          {(['preview', 'versions', 'tests'] as const).map((k) => (
            <a
              key={k}
              className={`bd__railItem${k === kind ? ' bd__railItem--on' : ''}`}
              aria-current={k === kind ? 'page' : undefined}
              href={`/builder/${k}${processKey ? `?process=${encodeURIComponent(processKey)}${which !== 'latest' && k !== 'versions' ? `&v=${which}` : ''}` : ''}`}
            >
              <RailIcon name={k} />
              <span>{TITLES[k].eyebrow}</span>
            </a>
          ))}
          <span className="bd__railSpacer" />
          <a className="bd__railItem" href="/console">
            <RailIcon name="console" />
            <span>Console</span>
          </a>
        </nav>

        <main className="pg" id="page-main">
          <header className="pg__head">
            <div className="pg__heading">
              <p className="pg__eyebrow">{TITLES[kind].eyebrow}</p>
              <h1 className="pg__title">{view?.name ?? row?.name ?? processKey ?? 'Your processes'}</h1>
              <p className="pg__lede">{TITLES[kind].lede}</p>
            </div>
            {processes && processes.length > 0 && (
              <div className="pg__tools">
                <label className="pg__pick">
                  <span>Process</span>
                  <select
                    value={processKey ?? ''}
                    onChange={(e) => {
                      setProcessKey(e.target.value);
                      setWhich('latest');
                    }}
                  >
                    {processes.map((p) => (
                      <option key={p.process_key} value={p.process_key}>
                        {p.name ?? p.process_key}
                      </option>
                    ))}
                  </select>
                </label>
                <a className="bd__btn pg__edit" href={editHref}>
                  Open in the editor
                </a>
              </div>
            )}
          </header>

          {processes && processes.length === 0 && (
            <div className="pg__empty">
              <h2>Nothing to show yet</h2>
              <p>Start a process from the catalogue or describe one, and it will appear here.</p>
              <a className="bd__btn bd__btn--primary" href="/builder/new">
                Start a process
              </a>
            </div>
          )}

          {error && (
            <p className="pg__error" role="alert">
              {error}
            </p>
          )}

          {view && kind !== 'versions' && <VersionPicker view={view} which={which} onPick={setWhich} />}

          {processKey && !view && !error && <PageSkeleton />}

          {view && kind === 'preview' && <PreviewBody view={view} />}
          {view && kind === 'versions' && <VersionsBody view={view} />}
          {view && kind === 'tests' && <TestsBody view={view} key={`${view.processKey}:${view.source}:${view.version}`} />}
        </main>
      </div>
    </div>
  );
}

/** Draft, then every published version, newest first; the newest is the one live. */
function VersionPicker({ view, which, onPick }: { view: ProcessView; which: Which; onPick: (w: Which) => void }) {
  const current: Which = view.source === 'draft' ? 'draft' : view.version === view.versions[0] ? 'latest' : view.version!;
  const options: { which: Which; label: string; tag?: string }[] = [];
  if (view.draftId) options.push({ which: 'draft', label: 'Draft', tag: 'in progress' });
  view.versions.forEach((v, i) => options.push({ which: i === 0 ? 'latest' : v, label: `v${v}`, tag: i === 0 ? 'live' : undefined }));
  if (options.length < 2) {
    return (
      <p className="pg__showing">
        Showing {view.source === 'draft' ? 'the draft. Nothing is published yet.' : `version ${view.version}, the live one.`}
      </p>
    );
  }
  return (
    <div className="pg__versions" role="group" aria-label="Which version">
      {options.map((o) => (
        <button
          key={String(o.which)}
          type="button"
          className="pg__version"
          aria-pressed={o.which === current || (which === o.which && o.which !== 'latest')}
          onClick={() => onPick(o.which)}
        >
          {o.label}
          {o.tag && <span className={`pg__tag pg__tag--${o.tag === 'live' ? 'live' : 'draft'}`}>{o.tag}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- preview

const DEVICES = [
  { key: 'desktop', label: 'Desktop' },
  { key: 'tablet', label: 'Tablet' },
  { key: 'phone', label: 'Phone' },
] as const;

function PreviewBody({ view }: { view: ProcessView }) {
  const [device, setDevice] = useState<(typeof DEVICES)[number]['key']>('desktop');
  useEffect(() => {
    if (window.matchMedia('(max-width: 640px)').matches) setDevice('phone');
  }, []);
  const questions = view.blueprint.data.fields.length;
  const pages = view.blueprint.experience?.pages?.length ?? 0;
  return (
    <section className="pg__card" aria-label="The form">
      <div className="pg__cardBar">
        <p className="pg__stat">
          <strong>{questions}</strong> {questions === 1 ? 'question' : 'questions'} on <strong>{pages}</strong>{' '}
          {pages === 1 ? 'page' : 'pages'}
        </p>
        <div className="pg__devices" role="group" aria-label="Screen size">
          {DEVICES.map((d) => (
            <button key={d.key} type="button" className="pg__device" aria-pressed={device === d.key} onClick={() => setDevice(d.key)}>
              {d.label}
            </button>
          ))}
        </div>
      </div>
      <div className="pg__stage">
        <div className={`pv pv--${device}`}>
          <FormPreview blueprint={view.blueprint} hideDeviceSwitch />
        </div>
      </div>
    </section>
  );
}

// --------------------------------------------------------------- versions

function VersionsBody({ view }: { view: ProcessView }) {
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<VersionRow[]>(`/api/builder/processes/${encodeURIComponent(view.processKey)}/versions`)
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [view.processKey]);

  const key = encodeURIComponent(view.processKey);
  if (error) return <p className="pg__error">{error}</p>;
  if (!rows) return <PageSkeleton />;

  return (
    <ol className="vt">
      {view.draftId && (
        <li className="vt__item vt__item--draft">
          <span className="vt__dot" aria-hidden="true" />
          <div className="vt__card">
            <header className="vt__head">
              <h2 className="vt__name">Draft</h2>
              <span className="pg__tag pg__tag--draft">in progress</span>
            </header>
            <p className="vt__meta">
              Not published. {view.versions.length ? `Started from version ${view.versions[0]}.` : 'Publishing it makes version 1.'}
            </p>
            <div className="vt__actions">
              <a className="bd__btn" href={`/builder?process=${key}`}>
                Keep editing
              </a>
              <a className="vt__link" href={`/builder/preview?process=${key}&v=draft`}>
                Preview the draft
              </a>
              <a className="vt__link" href={`/builder/tests?process=${key}&v=draft`}>
                Test the draft
              </a>
            </div>
          </div>
        </li>
      )}
      {rows.map((r, i) => (
        <li className="vt__item" key={r.version}>
          <span className={`vt__dot${i === 0 ? ' vt__dot--live' : ''}`} aria-hidden="true" />
          <div className="vt__card">
            <header className="vt__head">
              <h2 className="vt__name">Version {r.version}</h2>
              {i === 0 && <span className="pg__tag pg__tag--live">live</span>}
              <span className="vt__when">{when(r.publishedAt)}</span>
            </header>
            <p className="vt__meta">
              Published by {r.publishedBy} · {r.records} {r.records === 1 ? 'record' : 'records'} started on it
            </p>
            {r.changes.length > 0 && (
              <ul className="vt__changes">
                {r.changes.map((c, n) => (
                  <li key={n}>{c}</li>
                ))}
              </ul>
            )}
            <div className="vt__actions">
              <a className="vt__link" href={`/builder/preview?process=${key}&v=${i === 0 ? 'latest' : r.version}`}>
                Preview this version
              </a>
              <a className="vt__link" href={`/builder/tests?process=${key}&v=${i === 0 ? 'latest' : r.version}`}>
                Run its tests
              </a>
            </div>
          </div>
        </li>
      ))}
      {!rows.length && !view.draftId && <p className="pg__showing">Nothing published yet.</p>}
    </ol>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ------------------------------------------------------------------ tests

const KIND_WORDS: Record<string, string> = {
  happy_path: 'Happy path',
  rejection: 'Rejection',
  missing_data: 'Missing data',
  timeout: 'Timeout',
  duplicate: 'Duplicate',
  permission: 'Permission',
};

function TestsBody({ view }: { view: ProcessView }) {
  const [run, setRun] = useState<TestRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const declared = view.blueprint.tests ?? [];
  const byName = useMemo(() => new Map((run?.results ?? []).map((r) => [r.test, r])), [run]);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      setRun(
        view.source === 'draft'
          ? await call<TestRun>(`/api/builder/drafts/${view.draftId}/test`, { method: 'POST' })
          : await call<TestRun>(
              `/api/builder/processes/${encodeURIComponent(view.processKey)}/versions/${view.version}/test`,
              { method: 'POST' },
            ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const allPassed = run && run.passed === run.total;
  return (
    <section className="pg__card" aria-label="Scenarios">
      <div className="pg__cardBar">
        <p className="pg__stat">
          <strong>{declared.length}</strong> {declared.length === 1 ? 'scenario' : 'scenarios'} in{' '}
          {view.source === 'draft' ? 'the draft' : `version ${view.version}`}
        </p>
        <button
          type="button"
          className="bd__btn bd__btn--primary"
          onClick={() => void go()}
          disabled={busy || !view.publishable || !declared.length}
        >
          {busy ? 'Running…' : run ? 'Run again' : 'Run the scenarios'}
        </button>
      </div>

      {!view.publishable && (
        <p className="pg__error">The draft does not compile yet. Fix its errors in the editor, then run it here.</p>
      )}
      {error && (
        <p className="pg__error" role="alert">
          {error}
        </p>
      )}

      {run && (
        <div className={`ts__summary ts__summary--${allPassed ? 'ok' : 'bad'}`} role="status">
          <strong>
            {run.passed} of {run.total} passed
          </strong>
          <span className="ts__meter" aria-hidden="true">
            <span style={{ width: `${run.total ? (run.passed / run.total) * 100 : 0}%` }} />
          </span>
          <span>{allPassed ? 'Every scenario behaved as written.' : 'Something no longer behaves as the scenario says.'}</span>
        </div>
      )}

      {!declared.length && (
        <p className="pg__showing">This process declares no scenarios, so there is nothing to run. Add them in the editor.</p>
      )}

      <ul className="ts__list">
        {declared.map((t) => {
          const result = byName.get(t.name) ?? byName.get(t.key);
          const state = busy ? 'running' : result ? (result.passed ? 'ok' : 'bad') : 'idle';
          return (
            <li key={t.key} className={`ts__item ts__item--${state}`}>
              <span className="ts__mark" aria-hidden="true">
                {state === 'ok' ? '✓' : state === 'bad' ? '✕' : state === 'running' ? '' : '•'}
              </span>
              <div className="ts__text">
                <p className="ts__name">{t.name}</p>
                <p className="ts__kind">
                  {KIND_WORDS[t.kind] ?? t.kind.replace(/_/g, ' ')}
                  {state === 'ok' && ' · passed'}
                  {state === 'bad' && ' · failed'}
                  {state === 'running' && ' · running'}
                </p>
                {result?.failures.map((f, i) => (
                  <p className="ts__failure" key={i}>
                    {f}
                  </p>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PageSkeleton() {
  return (
    <div className="pg__card pg__skeleton" aria-busy="true" aria-label="Loading">
      <span className="bt__line bt__shine" style={{ width: '32%' }} />
      <span className="bt__line bt__shine" style={{ width: '86%' }} />
      <span className="bt__line bt__shine" style={{ width: '72%' }} />
      <span className="bt__line bt__shine" style={{ width: '58%' }} />
    </div>
  );
}
