'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RulesEditor } from './Rules';
import './builder.css';
import { FormPreview, TestsPanel, Versions, type VersionRow } from './SidePanel';
import { useDialog } from '../useDialog';

/**
 * The builder.
 *
 * §20.1 step 3 is one sentence — "the builder changes a field and approval
 * threshold, resolves warnings, and publishes" — and the whole argument of
 * this product lives in the word *resolves*. So the diagnostics panel is not
 * a dialog that appears when you press publish. It is always on screen, it
 * updates on every keystroke, and clicking an entry selects the thing that
 * caused it. You find out you have broken the process while you are still
 * looking at what you broke.
 *
 * Four requirements sit behind that: BLD-03 (edit without editing JSON),
 * BLD-04 (the compiler names what is wrong), BLD-05 (test against sample
 * records first), BLD-07 (publishing confirms schema and migration effects).
 *
 * What has a form editor: fields, states, approvals, tasks, roles. What does
 * not: intent, experience, communications, outputs, transitions and tests.
 * Those are reachable through the JSON tab, which is a stated gap rather than
 * a hidden one — transitions especially deserve a graph editor and do not
 * have one yet.
 */

// ------------------------------------------------------------------- types

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  at: string;
  fix?: string;
}

interface BpField {
  key: string;
  type: string;
  label: string;
  help?: string;
  required?: boolean;
  classification: string;
  constraints?: Record<string, unknown>;
  choices?: { value: string; label: string }[];
  setBy?: string;
  collectionReason?: string;
  fields?: BpField[];
}

interface BpState {
  key: string;
  name: string;
  type: string;
  outcome?: string;
  slaHours?: number;
  publicLabel?: string;
}

type Party =
  | { role: string }
  | { field: string }
  | { user: string }
  | { assignee: 'current' }
  | { submitter: true };

interface BpApproval {
  key: string;
  name: string;
  approvers: Party[];
  mode: 'single' | 'sequential' | 'any_of';
  allowRequestChanges?: boolean;
  reasonRequired?: boolean;
  contextFields?: string[];
  dueInHours?: number;
}

interface BpTask {
  key: string;
  name: string;
  description?: string;
  assignee: Party;
  dueInHours?: number;
  blocking?: boolean;
  completableBy?: 'assignee' | 'any_operator';
}

interface BpRole {
  key: string;
  name: string;
  kind: 'internal' | 'respondent';
  capabilities: string[];
  hiddenFields?: string[];
  editableFields?: string[];
}

interface BpBranding {
  title?: string;
  tagline?: string;
  logoUrl?: string;
  bannerUrl?: string;
  accent?: string;
  footer?: string;
}

interface BpSection {
  key: string;
  title?: string;
  description?: string;
  fields?: string[];
  /** Field key to 'full' | 'half' | 'third'. Absent means full. */
  widths?: Record<string, string>;
  [k: string]: unknown;
}

interface BpExperience {
  showProgress?: boolean;
  saveAndResume?: boolean;
  confirmation?: { message: string; showStatusLink?: boolean };
  branding?: BpBranding;
  pages?: { key: string; title: string; description?: string; sections?: BpSection[]; [k: string]: unknown }[];
  [k: string]: unknown;
}

interface Blueprint {
  key: string;
  name: string;
  description?: string;
  roles: BpRole[];
  data: { fields: BpField[]; [k: string]: unknown };
  workflow: {
    states: BpState[];
    transitions: { key: string; name?: string; from: string; to: string; [k: string]: unknown }[];
    approvals?: BpApproval[];
    tasks?: BpTask[];
    [k: string]: unknown;
  };
  /* Named rather than left in the index signature, because the preview reads
     it and an untyped `{}` gives it nothing to render. */
  experience?: BpExperience;
  /* Named rather than left in the index signature, because the automation
     editor offers these as choices and an untyped `{}` gives it nothing. */
  communications?: { email?: { key: string; name: string }[]; [k: string]: unknown };
  outputs?: { documents?: { key: string; name: string }[]; [k: string]: unknown };
  [k: string]: unknown;
}

interface DraftDetail {
  id: string;
  processKey: string;
  processName: string;
  basedOnVersion: number | null;
  updatedAt: string;
  createdBy: string;
  blueprint: Blueprint;
  diagnostics: Diagnostic[];
  publishable: boolean;
  decision?: string;
  audit?: { provider: string; model: string; durationMs: number; repairs: number };
}

interface ProcessRow {
  process_key: string;
  name: string;
  version: number | null;
  draft_id: string | null;
  instances: number;
}

interface PublishImpact {
  fromVersion: number | null;
  fields: { added: string[]; removed: string[]; retyped: { key: string; from: string; to: string }[] };
  states: { added: string[]; removed: string[] };
  inFlight: number;
  strandedData: string[];
  warnings: Diagnostic[];
}

interface ScenarioResult {
  process: string;
  test: string;
  kind: string;
  passed: boolean;
  failures: string[];
}

type Tab = 'fields' | 'states' | 'rules' | 'approvals' | 'tasks' | 'roles' | 'json';

/*
 * The right-hand column. `checks` is what it always was; the other three are
 * the things that used to be a modal, a missing endpoint and nothing at all.
 */
type Side = 'checks' | 'preview' | 'versions' | 'tests';

const SIDES: { key: Side; label: string; icon: 'checks' | 'preview' | 'versions' | 'tests' }[] = [
  { key: 'checks', label: 'Checks', icon: 'checks' },
  { key: 'preview', label: 'Preview', icon: 'preview' },
  { key: 'versions', label: 'Versions', icon: 'versions' },
  { key: 'tests', label: 'Tests', icon: 'tests' },
];

interface PackContents {
  fields: number;
  states: number;
  approvals: number;
  tasks: number;
  emails: number;
  documents: number;
  metrics: number;
  scenarios: number;
  roles: { key: string; name: string; kind: string }[];
  policy: {
    sensitivityCeiling: string;
    retentionDays: number | null;
    restrictedFields: number;
    fieldsHiddenFromSomeone: number;
  };
}

interface Pack {
  id: string;
  packKey: string;
  version: number;
  name: string;
  summary: string;
  category: string;
  audience: string;
  contents: PackContents;
  builtIn: boolean;
}

/** The same summary plus the blueprint, read only when one is chosen. */
interface PackDetail extends Pack {
  warnings: { code: string; message: string }[];
}

const FIELD_TYPES = [
  'short_text', 'long_text', 'email', 'phone', 'number', 'currency', 'url', 'address',
  'date', 'time', 'single_choice', 'multi_choice', 'dropdown', 'yes_no', 'rating',
  'matrix', 'file', 'signature_ack', 'content', 'hidden', 'calculated', 'repeating_group',
];
const CHOICE_TYPES = new Set(['single_choice', 'multi_choice', 'dropdown', 'matrix']);
const CLASSES = ['public', 'internal', 'confidential', 'restricted'];
const CAPABILITIES = ['submit', 'view', 'edit', 'approve', 'operate', 'report', 'administer'];

// --------------------------------------------------------------------- api

class Unauthenticated extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    /*
     * Announced, not just thrown.
     *
     * The builder checked the session once at load and never again, so a
     * session that ended while somebody was working — expired, revoked from
     * another device, or dropped by a schema reset in development — surfaced
     * as the words "sign in first" beside a disabled button. Every call site
     * would otherwise need the same branch; one event means none of them do.
     */
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('patform:signed-out'));
    }
    throw new Unauthenticated(body.error ?? 'sign in first');
  }
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

/**
 * Turns a diagnostic's dotted path into something selectable.
 *
 * A diagnostic that names `workflow.approvals[1].approvers[0]` is only useful
 * if pressing it puts that approval on screen. Anything this cannot parse
 * still shows — it just is not clickable, which is honest about the fact that
 * not every section has an editor yet.
 */
function locate(d: Diagnostic, bp: Blueprint | null): { tab: Tab; index: number } | null {
  const table: [RegExp, Tab][] = [
    [/^data\.fields\[(\d+)\]/, 'fields'],
    [/^workflow\.states\[(\d+)\]/, 'states'],
    [/^workflow\.approvals\[(\d+)\]/, 'approvals'],
    [/^workflow\.tasks\[(\d+)\]/, 'tasks'],
    [/^roles\[(\d+)\]/, 'roles'],
  ];
  for (const [pattern, tab] of table) {
    const m = d.at.match(pattern);
    if (m) return { tab, index: Number(m[1]) };
  }

  // Most diagnostics about an approval or a task are reported where the thing
  // is *used* — `workflow.transitions[0].actions[1]` — not where it is
  // defined, because that is where the compiler was standing when it noticed.
  // The path is therefore useless for navigation in exactly the cases that
  // matter most. The keys are in the message, so resolve by those instead.
  if (!bp) return null;
  for (const quoted of d.message.match(/"([a-z0-9_]+)"/g) ?? []) {
    const key = quoted.slice(1, -1);
    const lists: [Tab, { key: string }[]][] = [
      ['approvals', bp.workflow.approvals ?? []],
      ['tasks', bp.workflow.tasks ?? []],
      ['fields', bp.data.fields],
      ['states', bp.workflow.states],
      ['roles', bp.roles],
    ];
    for (const [tab, items] of lists) {
      const i = items.findIndex((item) => item.key === key);
      if (i >= 0) return { tab, index: i };
    }
  }
  return null;
}

function partyLabel(p: Party | undefined): string {
  if (!p) return '—';
  if ('role' in p) return `role: ${p.role}`;
  if ('field' in p) return `field: ${p.field}`;
  if ('user' in p) return p.user;
  if ('submitter' in p) return 'the submitter';
  return 'current assignee';
}

// ------------------------------------------------------------------- shell

export function Builder() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [showProcesses, setShowProcesses] = useState(false);
  const [processes, setProcesses] = useState<ProcessRow[]>([]);
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [publishable, setPublishable] = useState(false);
  const [tab, setTab] = useState<Tab>('fields');
  const [side, setSide] = useState<Side>('checks');
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<{ results: ScenarioResult[]; passed: number; total: number } | null>(null);
  const [impact, setImpact] = useState<PublishImpact | null>(null);
  const [published, setPublished] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Blueprint | null>(null);

  const refreshList = useCallback(async () => {
    setProcesses(await call<ProcessRow[]>('/api/builder/processes'));
  }, []);

  // A session that ends at any point puts the whole builder back on the
  // sign-in screen, rather than leaving a working-looking editor that refuses
  // every save.
  useEffect(() => {
    const onSignedOut = () => setSignedIn(false);
    window.addEventListener('patform:signed-out', onSignedOut);
    return () => window.removeEventListener('patform:signed-out', onSignedOut);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await call('/api/session');
        setSignedIn(true);
        await refreshList();
      } catch (err) {
        if (err instanceof Unauthenticated) setSignedIn(false);
        else setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [refreshList]);

  const adopt = useCallback((detail: DraftDetail) => {
    setDraft(detail);
    setBlueprint(detail.blueprint);
    setDiagnostics(detail.diagnostics);
    setPublishable(detail.publishable);
    setTab('fields');
    setSide('checks');
    setIndex(0);
    setTests(null);
    setImpact(null);
    setPublished(null);
    setStatus('idle');
  }, []);

  /**
   * Saves on a delay, and saves whatever the latest edit was rather than
   * whatever the edit that started the timer was. The server stores drafts
   * that do not compile on purpose, so there is no state in which typing
   * loses work.
   */
  const scheduleSave = useCallback((next: Blueprint, draftId: string) => {
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    setStatus('saving');
    timer.current = setTimeout(async () => {
      const body = pending.current;
      if (!body) return;
      try {
        const res = await call<{ diagnostics: Diagnostic[]; publishable: boolean }>(
          `/api/builder/drafts/${draftId}/save`,
          { method: 'POST', body: JSON.stringify({ blueprint: body }) },
        );
        setDiagnostics(res.diagnostics);
        setPublishable(res.publishable);
        setStatus('saved');
        setError(null);
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 600);
  }, []);

  const mutate = useCallback(
    (fn: (bp: Blueprint) => void) => {
      if (!blueprint || !draft) return;
      const next = structuredClone(blueprint);
      fn(next);
      setBlueprint(next);
      scheduleSave(next, draft.id);
    },
    [blueprint, draft, scheduleSave],
  );

  const open = async (processKey: string) => {
    setBusy('open');
    try {
      adopt(await call<DraftDetail>('/api/builder/open', { method: 'POST', body: JSON.stringify({ processKey }) }));
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const runTests = async () => {
    if (!draft) return;
    setBusy('test');
    setImpact(null);
    setSide('tests');
    try {
      setTests(await call(`/api/builder/drafts/${draft.id}/test`, { method: 'POST' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const reviewPublish = async () => {
    if (!draft) return;
    setBusy('impact');
    setTests(null);
    try {
      setImpact(await call(`/api/builder/drafts/${draft.id}/impact`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const confirmPublish = async () => {
    if (!draft) return;
    setBusy('publish');
    try {
      const res = await call<{ version: number }>(`/api/builder/drafts/${draft.id}/publish`, { method: 'POST' });
      setPublished(res.version);
      setImpact(null);
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    if (!draft) return;
    if (!confirm('Throw this draft away? Everything since you opened it is lost.')) return;
    setBusy('discard');
    try {
      await call(`/api/builder/drafts/${draft.id}/discard`, { method: 'POST' });
      setDraft(null);
      setBlueprint(null);
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const errors = useMemo(() => diagnostics.filter((d) => d.severity === 'error'), [diagnostics]);
  const warnings = useMemo(() => diagnostics.filter((d) => d.severity === 'warning'), [diagnostics]);

  if (signedIn === null) return <div className="bd__boot">Loading…</div>;
  if (signedIn === false) {
    return (
      <div className="bd__gate">
        <div className="bd__gateCard">
          <div className="bd__gateBrand">
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
              <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="var(--green)" strokeWidth="1.8" />
              <path
                d="M7 13.2L11 17L19 9"
                stroke="var(--green)"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Patform
          </div>
          <h1>Sign in to keep building</h1>
          <p>
            Your session ended. Nothing you were working on is lost — drafts are stored on the
            server as you type, so the one you had open is where you left it.
          </p>
          <a className="bd__gateBtn" href="/console">
            Sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="bd">
      <a className="skip-link" href="#builder-main">
        Skip to the editor
      </a>

      {/* The same product bar the console carries. Without it the two halves
          of one product have two different tops. */}
      <header className="bd__top">
        <span className="bd__topBrand">
          <svg width="20" height="20" viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="var(--green-mint)" strokeWidth="1.8" />
            <path d="M7 13.2L11 17L19 9" stroke="var(--green-mint)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Patform
        </span>
        <span className="bd__topDivider" aria-hidden="true" />
        <span className="bd__topWhere">Builder</span>
        <span style={{ flexGrow: 1 }} />
        <a className="bd__topLink" href="/console">
          Back to the console
        </a>
      </header>

      <div className="bd__shell">
      {/*
        * An icon rail, not a column.
        *
        * Two hundred and thirty pixels of a three-column editor were spent
        * listing two processes. The rail is sixty-four: the four things
        * somebody does here, each a destination rather than a row, and the
        * process list opens over the editor when it is wanted instead of
        * standing beside it permanently.
        */}
      <nav className="bd__rail" aria-label="Builder">
        <button
          type="button"
          className={`bd__railItem${showProcesses ? ' bd__railItem--on' : ''}`}
          aria-expanded={showProcesses}
          aria-controls="process-switcher"
          onClick={() => setShowProcesses((was) => !was)}
        >
          <RailIcon name="processes" />
          <span>Processes</span>
          {processes.length > 0 && <span className="bd__railCount">{processes.length}</span>}
        </button>

        <a className="bd__railItem" href="/builder/new">
          <RailIcon name="new" />
          <span>New</span>
        </a>

        <a className="bd__railItem" href="/builder/new">
          <RailIcon name="catalogue" />
          <span>Catalogue</span>
        </a>

        {/*
          * Three destinations rather than three buttons hidden in a header.
          * They are disabled with nothing open because there is genuinely
          * nothing to preview, version or test — a control that does nothing
          * is worse than one that is not there.
          */}
        <span className="bd__railRule" aria-hidden="true" />

        {SIDES.filter((s2) => s2.key !== 'checks').map((s2) => (
          <button
            type="button"
            key={s2.key}
            className={`bd__railItem${side === s2.key && draft ? ' bd__railItem--on' : ''}`}
            disabled={!draft}
            aria-pressed={side === s2.key && Boolean(draft)}
            onClick={() => {
              setSide(s2.key);
              if (s2.key === 'tests' && !tests && publishable) void runTests();
            }}
          >
            <RailIcon name={s2.icon} />
            <span>{s2.label}</span>
          </button>
        ))}

        <span className="bd__railSpacer" />

        <a className="bd__railItem" href="/console">
          <RailIcon name="console" />
          <span>Console</span>
        </a>
      </nav>

      {showProcesses && (
        <div className="bd__switcher" id="process-switcher">
          <div className="bd__switcherHead">
            <h2>Your processes</h2>
            <button type="button" className="bd__switcherClose" onClick={() => setShowProcesses(false)}>
              Close
            </button>
          </div>
          <ul className="bd__switcherList">
            {processes.map((p) => (
              <li key={p.process_key}>
                <button
                  type="button"
                  className="bd__switcherItem"
                  aria-current={draft?.processKey === p.process_key ? 'page' : undefined}
                  disabled={busy !== null}
                  onClick={() => {
                    setShowProcesses(false);
                    return p.draft_id ? openById(p.draft_id) : open(p.process_key);
                  }}
                >
                  <span className="bd__switcherMark" aria-hidden="true">
                    {(p.name ?? p.process_key).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="bd__switcherText">
                    <span className="bd__switcherName">{p.name ?? p.process_key}</span>
                    <span className="bd__switcherMeta">
                      {p.version === null ? 'unpublished' : `published v${p.version}`}
                      {p.draft_id ? ' · draft open' : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {!processes.length && <li className="bd__empty">Nothing here yet.</li>}
          </ul>
          <a className="bd__switcherNew" href="/builder/new">
            + New process
          </a>
        </div>
      )}

      <main className="bd__main" id="builder-main" tabIndex={-1}>
        {error && (
          <div className="bd__banner bd__banner--bad" role="alert">
            {error}
            <button onClick={() => setError(null)}>dismiss</button>
          </div>
        )}
        {published !== null && (
          <div className="bd__banner bd__banner--good" role="status">
            Published as version {published}. Records already running stay on the version they started under.
            <button onClick={() => setPublished(null)}>dismiss</button>
          </div>
        )}

        {!draft || !blueprint ? (
          <Welcome
            onNew={() => setCreating(true)}
            processes={processes}
            onOpen={(p) => (p.draft_id ? openById(p.draft_id) : open(p.process_key))}
          />
        ) : (
          <>
            <header className="bd__head">
              <div>
                <h1 className="bd__title">{blueprint.name}</h1>
                <p className="bd__sub">
                  <code>{draft.processKey}</code>
                  {draft.basedOnVersion === null ? ' · new process' : ` · editing from v${draft.basedOnVersion}`}
                  {' · '}
                  <SaveState status={status} />
                </p>
                {/*
                  * The link the whole thing exists to produce.
                  *
                  * A published process serves its form here, and the builder
                  * never mentioned it — so somebody could design a process and
                  * have no idea how anybody would reach it. Unpublished shows
                  * the link it *will* have, greyed, because the key is being
                  * chosen now and it cannot change afterwards.
                  */}
                <FormLink processKey={draft.processKey} live={draft.basedOnVersion !== null} />
              </div>
              <div className="bd__actions">
                <button className="bd__btn" onClick={discard} disabled={busy !== null}>
                  Discard
                </button>
                <button className="bd__btn" onClick={runTests} disabled={busy !== null || !publishable}>
                  {busy === 'test' ? 'Running…' : 'Test'}
                </button>
                <button
                  className="bd__btn bd__btn--primary"
                  onClick={reviewPublish}
                  disabled={busy !== null || !publishable}
                  title={publishable ? undefined : 'resolve the errors first'}
                >
                  Publish…
                </button>
              </div>
            </header>

            <div className="bd__body" data-side={side}>
              <Outline
                blueprint={blueprint}
                tab={tab}
                index={index}
                onSelect={(t, i) => {
                  setTab(t);
                  setIndex(i);
                }}
                onAdd={(t) => addItem(t)}
              />

              <section className="bd__editor">
                {tab === 'fields' && (
                  <FieldEditor
                    field={blueprint.data.fields[index]}
                    width={widthFor(blueprint, blueprint.data.fields[index]?.key)}
                    onWidth={
                      sectionHolding(blueprint, blueprint.data.fields[index]?.key)
                        ? (next) =>
                            mutate((bp) => {
                              const key = bp.data.fields[index]?.key;
                              const section = key ? sectionHolding(bp, key) : undefined;
                              if (!key || !section) return;
                              const widths = { ...(section.widths ?? {}) };
                              if (next === 'full') delete widths[key];
                              else widths[key] = next;
                              if (Object.keys(widths).length) section.widths = widths;
                              else delete section.widths;
                            })
                        : undefined
                    }
                    onChange={(fn) => mutate((bp) => fn(bp.data.fields[index]!))}
                    onRemove={() => removeAt('fields', index)}
                  />
                )}
                {tab === 'states' && (
                  <StateEditor
                    state={blueprint.workflow.states[index]}
                    transitions={blueprint.workflow.transitions}
                    onChange={(fn) => mutate((bp) => fn(bp.workflow.states[index]!))}
                    onRemove={() => removeAt('states', index)}
                  />
                )}
                {tab === 'approvals' && (
                  <ApprovalEditor
                    approval={(blueprint.workflow.approvals ?? [])[index]}
                    roles={blueprint.roles}
                    fields={blueprint.data.fields}
                    onChange={(fn) => mutate((bp) => fn(bp.workflow.approvals![index]!))}
                    onRemove={() => removeAt('approvals', index)}
                  />
                )}
                {tab === 'tasks' && (
                  <TaskEditor
                    task={(blueprint.workflow.tasks ?? [])[index]}
                    roles={blueprint.roles}
                    fields={blueprint.data.fields}
                    onChange={(fn) => mutate((bp) => fn(bp.workflow.tasks![index]!))}
                    onRemove={() => removeAt('tasks', index)}
                  />
                )}
                {tab === 'roles' && (
                  <RoleEditor
                    role={blueprint.roles[index]}
                    fields={blueprint.data.fields}
                    onChange={(fn) => mutate((bp) => fn(bp.roles[index]!))}
                    onRemove={() => removeAt('roles', index)}
                  />
                )}
                {tab === 'rules' && (
                  <RulesEditor
                    transitions={(blueprint.workflow.transitions ?? []) as never}
                    ctx={{
                      states: blueprint.workflow.states.map((s2) => ({ key: s2.key, name: s2.name, type: s2.type })),
                      approvals: (blueprint.workflow.approvals ?? []).map((a) => ({ key: a.key, name: a.name })),
                      tasks: (blueprint.workflow.tasks ?? []).map((t) => ({ key: t.key, name: t.name })),
                      templates: (blueprint.communications?.email ?? []).map((e) => ({ key: e.key, name: e.name })),
                      documents: (blueprint.outputs?.documents ?? []).map((d) => ({ key: d.key, name: d.name })),
                      fields: blueprint.data.fields.map((f) => ({ key: f.key, label: f.label, type: f.type })),
                      roles: blueprint.roles.map((r) => ({ key: r.key, name: r.name })),
                    }}
                    diagnostics={diagnostics}
                    draftId={draft?.id}
                    onAppend={(rule) =>
                      mutate((bp) => {
                        bp.workflow.transitions = [...(bp.workflow.transitions ?? []), rule as never];
                      })
                    }
                    onChange={(i, next) =>
                      mutate((bp) => {
                        bp.workflow.transitions[i] = next as never;
                      })
                    }
                    onAdd={() => addItem('rules')}
                    onRemove={(i) =>
                      mutate((bp) => {
                        bp.workflow.transitions.splice(i, 1);
                      })
                    }
                  />
                )}
                {tab === 'json' && <JsonEditor blueprint={blueprint} onReplace={(bp) => replaceAll(bp)} />}
              </section>

              {/*
                * One column, four things. They were a panel, a modal, an
                * endpoint that did not exist and nothing — which is why
                * somebody could design a whole form and never see it.
                */}
              <aside className="sp">
                <div className="sp__tabs" role="tablist" aria-label="Beside the editor">
                  {SIDES.map((s2) => (
                    <button
                      type="button"
                      key={s2.key}
                      role="tab"
                      className="sp__tab"
                      aria-selected={side === s2.key}
                      onClick={() => {
                        setSide(s2.key);
                        if (s2.key === 'tests' && !tests && publishable) void runTests();
                      }}
                    >
                      {s2.label}
                      {s2.key === 'checks' && errors.length > 0 && ` (${errors.length})`}
                    </button>
                  ))}
                </div>

                <div className="sp__scroll">
                  {side === 'checks' && (
                    <DiagnosticsPanel
                      blueprint={blueprint}
                      errors={errors}
                      warnings={warnings}
                      onGo={(where) => {
                        setTab(where.tab);
                        setIndex(where.index);
                      }}
                    />
                  )}
                  {side === 'preview' && (
                    <FormPreview
                      blueprint={blueprint}
                      onBranding={(next) =>
                        mutate((bp) => {
                          bp.experience = { ...(bp.experience ?? {}), branding: next };
                        })
                      }
                    />
                  )}
                  {side === 'versions' && (
                    <Versions
                      processKey={draft.processKey}
                      load={(key) => call<VersionRow[]>(`/api/builder/processes/${encodeURIComponent(key)}/versions`)}
                    />
                  )}
                  {side === 'tests' && (
                    <TestsPanel
                      tests={tests}
                      busy={busy === 'test'}
                      publishable={publishable}
                      onRun={() => void runTests()}
                    />
                  )}
                </div>
              </aside>
            </div>
          </>
        )}

        {impact && (
          <PublishDrawer
            impact={impact}
            busy={busy === 'publish'}
            onConfirm={confirmPublish}
            onClose={() => setImpact(null)}
          />
        )}
        {creating && (
          <NewProcessDialog
            processes={processes}
            onClose={() => setCreating(false)}
            onCreated={async (detail) => {
              setCreating(false);
              adopt(detail);
              await refreshList();
            }}
          />
        )}
      </main>
      </div>
    </div>
  );

  // -- helpers that need the closures above ------------------------------

  async function openById(draftId: string) {
    setBusy('open');
    try {
      adopt(await call<DraftDetail>(`/api/builder/drafts/${draftId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function replaceAll(next: Blueprint) {
    if (!draft) return;
    setBlueprint(next);
    scheduleSave(next, draft.id);
  }

  function removeAt(which: Tab, at: number) {
    mutate((bp) => {
      if (which === 'fields') bp.data.fields.splice(at, 1);
      if (which === 'states') bp.workflow.states.splice(at, 1);
      if (which === 'approvals') bp.workflow.approvals?.splice(at, 1);
      if (which === 'tasks') bp.workflow.tasks?.splice(at, 1);
      if (which === 'roles') bp.roles.splice(at, 1);
    });
    setIndex(Math.max(0, at - 1));
  }

  function addItem(which: Tab) {
    if (!blueprint) return;
    const n = Date.now().toString(36).slice(-4);
    mutate((bp) => {
      if (which === 'fields') {
        bp.data.fields.push({
          key: `new_field_${n}`,
          type: 'short_text',
          label: 'New field',
          classification: 'internal',
          setBy: 'respondent',
        });
      }
      if (which === 'states') {
        bp.workflow.states.push({ key: `new_state_${n}`, name: 'New state', type: 'active' });
      }
      if (which === 'rules') {
        bp.workflow.transitions = bp.workflow.transitions ?? [];
        const first = bp.workflow.states.find((st) => st.type === 'initial') ?? bp.workflow.states[0];
        const target = bp.workflow.states.find((st) => st.key !== first?.key) ?? first;
        bp.workflow.transitions.push({
          key: `new_rule_${n}`,
          from: first?.key ?? '',
          to: target?.key ?? '',
          trigger: { on: 'submission' },
          actions: [],
        });
      }
      if (which === 'approvals') {
        bp.workflow.approvals = bp.workflow.approvals ?? [];
        bp.workflow.approvals.push({
          key: `new_approval_${n}`,
          name: 'New approval',
          approvers: [{ role: bp.roles.find((r) => r.kind === 'internal')?.key ?? 'reviewer' }],
          mode: 'single',
          allowRequestChanges: true,
          reasonRequired: false,
        });
      }
      if (which === 'tasks') {
        bp.workflow.tasks = bp.workflow.tasks ?? [];
        bp.workflow.tasks.push({
          key: `new_task_${n}`,
          name: 'New task',
          assignee: { role: bp.roles.find((r) => r.kind === 'internal')?.key ?? 'operator' },
          blocking: true,
          completableBy: 'assignee',
        });
      }
      if (which === 'roles') {
        bp.roles.push({ key: `new_role_${n}`, name: 'New role', kind: 'internal', capabilities: ['view'] });
      }
    });
    const counts: Record<string, number> = {
      fields: blueprint.data.fields.length,
      states: blueprint.workflow.states.length,
      approvals: blueprint.workflow.approvals?.length ?? 0,
      tasks: blueprint.workflow.tasks?.length ?? 0,
      roles: blueprint.roles.length,
    };
    setTab(which);
    setIndex(counts[which] ?? 0);
  }
}

// ----------------------------------------------------------------- pieces

/**
 * 4.1.3 Status Messages. This changes without focus moving, so a screen
 * reader is told about it politely rather than never.
 */
function SaveState({ status }: { status: string }) {
  const text =
    status === 'saving' ? 'saving…' : status === 'saved' ? 'saved' : status === 'error' ? 'not saved' : 'up to date';
  const className = status === 'saving' ? 'bd__saving' : status === 'error' ? 'bd__savedBad' : 'bd__saved';
  return (
    <span className={className} role="status" aria-live="polite">
      {text}
    </span>
  );
}

/**
 * The start screen.
 *
 * It was a centred paragraph in an empty page, which reads as an application
 * that has not loaded. A builder's first screen should show the work: what
 * you already have, and the three ways to begin — each with a picture of what
 * it produces rather than a button with a verb on it.
 */
/**
 * The rail's icons. Beside a label, never instead of one — an icon-only rail
 * is a memory test, and Viva's works because every icon has its word under it.
 */
/** Where the form lives, and whether it is live yet. */
function FormLink({ processKey, live }: { processKey: string; live: boolean }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === 'undefined' ? '' : `${window.location.origin}/f/${processKey}`;

  return (
    <p className={`bd__formLink${live ? '' : ' bd__formLink--pending'}`}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M8.6 11.4 6.4 13.6a2.8 2.8 0 0 0 4 4l2.2-2.2" />
        <path d="M11.4 8.6l2.8-2.8a2.9 2.9 0 0 0-4.1-4.1L7.4 4.6" transform="translate(0,1)" />
        <path d="M7.8 12.2l4.4-4.4" />
      </svg>
      {live ? (
        <a href={url} target="_blank" rel="noreferrer">
          /f/{processKey}
        </a>
      ) : (
        <span>/f/{processKey}</span>
      )}
      <button
        type="button"
        className="bd__formCopy"
        onClick={() => {
          void navigator.clipboard?.writeText(url);
          setCopied(true);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {!live && <span className="bd__formNote">once you publish</span>}
    </p>
  );
}

/**
 * Which section a field is placed in, if any.
 *
 * A field can exist without being on a page — an operator sets it, or nobody
 * has placed it yet — and in that case there is no width to choose, which is
 * why this returns nothing rather than inventing a section.
 */
function sectionHolding(bp: Blueprint, key: string | undefined): BpSection | undefined {
  if (!key) return undefined;
  for (const page of bp.experience?.pages ?? []) {
    for (const section of page.sections ?? []) {
      if ((section.fields ?? []).includes(key)) return section;
    }
  }
  return undefined;
}

function widthFor(bp: Blueprint, key: string | undefined): string | undefined {
  return key ? sectionHolding(bp, key)?.widths?.[key] : undefined;
}

function RailIcon({
  name,
}: {
  name: 'processes' | 'new' | 'catalogue' | 'console' | 'checks' | 'preview' | 'versions' | 'tests';
}) {
  const p = {
    width: 20,
    height: 20,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'processes':
      return (
        <svg {...p}>
          <rect x="2.6" y="3" width="6" height="4.4" rx="1.2" />
          <rect x="11.4" y="12.6" width="6" height="4.4" rx="1.2" />
          <path d="M5.6 7.4v4.2a1.4 1.4 0 0 0 1.4 1.4h4.4" />
        </svg>
      );
    case 'new':
      return (
        <svg {...p}>
          <path d="M10 4.2v11.6M4.2 10h11.6" />
        </svg>
      );
    case 'catalogue':
      return (
        <svg {...p}>
          <rect x="2.8" y="3.2" width="6" height="6" rx="1.3" />
          <rect x="11.2" y="3.2" width="6" height="6" rx="1.3" />
          <rect x="2.8" y="11.6" width="6" height="6" rx="1.3" />
          <rect x="11.2" y="11.6" width="6" height="6" rx="1.3" />
        </svg>
      );
    case 'console':
      return (
        <svg {...p}>
          <rect x="2.6" y="4" width="14.8" height="12" rx="2" />
          <path d="M2.6 8h14.8M6.4 12h7.2" />
        </svg>
      );
    case 'checks':
      return (
        <svg {...p}>
          <path d="M3.4 10.4 7 14l9.6-9.6" />
        </svg>
      );
    case 'preview':
      return (
        <svg {...p}>
          <path d="M1.8 10S4.8 4.6 10 4.6 18.2 10 18.2 10 15.2 15.4 10 15.4 1.8 10 1.8 10Z" />
          <circle cx="10" cy="10" r="2.4" />
        </svg>
      );
    case 'versions':
      return (
        <svg {...p}>
          <circle cx="6" cy="4.8" r="1.9" />
          <circle cx="6" cy="15.2" r="1.9" />
          <path d="M6 6.7v6.6M9.4 4.8h5.2M9.4 15.2h5.2" />
        </svg>
      );
    case 'tests':
      return (
        <svg {...p}>
          <path d="M7.6 2.6v5.1L3.6 15a1.5 1.5 0 0 0 1.3 2.3h10.2A1.5 1.5 0 0 0 16.4 15l-4-7.3V2.6" />
          <path d="M6.6 2.6h6.8M7.2 11.4h5.6" />
        </svg>
      );
  }
}

function Welcome({
  onNew,
  processes,
  onOpen,
}: {
  onNew: () => void;
  processes: ProcessRow[];
  onOpen: (p: ProcessRow) => void;
}) {
  return (
    <div className="bd__start">
      <div className="bd__startInner">
        <header className="bd__startHead">
          <h1>What do you want to build?</h1>
          <p>
            Every edit is compiled as you make it. Errors stop a publish; warnings do not. Nothing
            you type is lost while it is invalid — a draft that does not compile is still a draft.
          </p>
        </header>

        {processes.length > 0 && (
          <section className="bd__startSection">
            <h2>Carry on with</h2>
            {/*
              * A list, not a gallery. Work you already have is identified by
              * its name; a picture of a generic process adds nothing and
              * leaves an empty row whenever somebody has one or two.
              */}
            <ul className="bd__recent">
              {processes.slice(0, 8).map((p) => (
                <li key={p.process_key}>
                  <button type="button" className="bd__recentRow" onClick={() => onOpen(p)}>
                    <span className="bd__recentMark" aria-hidden="true">
                      {(p.name ?? p.process_key).slice(0, 1).toUpperCase()}
                    </span>
                    <span className="bd__recentText">
                      <span className="bd__recentName">{p.name ?? p.process_key}</span>
                      <span className="bd__recentMeta">
                        {p.draft_id
                          ? 'draft in progress'
                          : p.version
                            ? `published v${p.version}`
                            : 'not published yet'}
                      </span>
                    </span>
                    {p.draft_id && <span className="bd__recentTag">draft</span>}
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className="bd__recentArrow"
                    >
                      <path d="m8 5 5 5-5 5" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="bd__startSection">
          <h2>Start something new</h2>
          <ul className="bd__startGrid">
            <li>
              <a className="bd__startCard" href="/builder/new">
                <span className="bd__startCardTop">
                  <Sketch kind="catalogue" />
                </span>
                <span className="bd__startCardName">From the catalogue</span>
                <span className="bd__startCardMeta">
                  88 processes with their approvals, reminders and retention already set
                </span>
              </a>
            </li>
            <li>
              <button type="button" className="bd__startCard" onClick={onNew}>
                <span className="bd__startCardTop">
                  <Sketch kind="describe" />
                </span>
                <span className="bd__startCardName">Describe it</span>
                <span className="bd__startCardMeta">
                  Say what happens in a sentence or two and it is drafted for you to review
                </span>
              </button>
            </li>
            <li>
              <button type="button" className="bd__startCard" onClick={onNew}>
                <span className="bd__startCardTop">
                  <Sketch kind="copy" />
                </span>
                <span className="bd__startCardName">Copy one you have</span>
                <span className="bd__startCardMeta">
                  Start from a process that already works and change what differs
                </span>
              </button>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

/**
 * A small drawing per route in.
 *
 * `aria-hidden` throughout: the name and the sentence under each card say
 * everything these do, and a screen reader announcing three abstract diagrams
 * would be noise.
 */
function Sketch({ kind }: { kind: 'process' | 'catalogue' | 'describe' | 'copy' }) {
  const common = {
    viewBox: '0 0 160 92',
    fill: 'none',
    'aria-hidden': true,
    className: 'bd__sketch',
  };

  // Brand green at three weights, so the drawings read as one family rather
  // than as four separate diagrams.
  const ink = '#14663f';
  const mid = '#9dc2ac';
  const pale = '#d9e8df';

  if (kind === 'process') {
    return (
      <svg {...common}>
        <rect x="10" y="16" width="46" height="60" rx="5" fill="#fff" stroke={pale} strokeWidth="1.5" />
        <rect x="18" y="26" width="22" height="4" rx="2" fill={ink} />
        <rect x="18" y="38" width="30" height="3" rx="1.5" fill={pale} />
        <rect x="18" y="46" width="24" height="3" rx="1.5" fill={pale} />
        <rect x="18" y="54" width="28" height="3" rx="1.5" fill={pale} />
        <rect x="18" y="64" width="16" height="6" rx="3" fill={ink} />

        <path d="M60 46h14" stroke={mid} strokeWidth="1.5" strokeDasharray="3 3" />

        <rect x="78" y="10" width="68" height="20" rx="5" fill="#fff" stroke={pale} strokeWidth="1.5" />
        <circle cx="90" cy="20" r="4" fill="#c99a2e" />
        <rect x="100" y="18" width="34" height="4" rx="2" fill={pale} />

        <path d="M96 30v6" stroke={mid} strokeWidth="1.5" />

        <rect x="78" y="36" width="68" height="20" rx="5" fill="#fff" stroke={pale} strokeWidth="1.5" />
        <circle cx="90" cy="46" r="4" fill="#c99a2e" />
        <rect x="100" y="44" width="26" height="4" rx="2" fill={pale} />

        <path d="M96 56v6" stroke={mid} strokeWidth="1.5" />

        <rect x="78" y="62" width="68" height="20" rx="5" fill="#f2f8f4" stroke={ink} strokeWidth="1.5" />
        <circle cx="90" cy="72" r="4" fill={ink} />
        <rect x="100" y="70" width="30" height="4" rx="2" fill={mid} />
      </svg>
    );
  }

  if (kind === 'catalogue') {
    return (
      <svg {...common}>
        {[0, 1, 2, 3].map((col) =>
          [0, 1].map((row) => {
            const lit = col === 1 && row === 0;
            return (
              <g key={`${col}-${row}`}>
                <rect
                  x={10 + col * 37}
                  y={14 + row * 38}
                  width="31"
                  height="30"
                  rx="4"
                  fill={lit ? '#f2f8f4' : '#fff'}
                  stroke={lit ? ink : pale}
                  strokeWidth="1.5"
                />
                <rect
                  x={16 + col * 37}
                  y={21 + row * 38}
                  width={lit ? 16 : 13}
                  height="3.5"
                  rx="1.75"
                  fill={lit ? ink : pale}
                />
                <rect
                  x={16 + col * 37}
                  y={29 + row * 38}
                  width="19"
                  height="2.5"
                  rx="1.25"
                  fill={pale}
                />
                <rect
                  x={16 + col * 37}
                  y={35 + row * 38}
                  width="11"
                  height="2.5"
                  rx="1.25"
                  fill={pale}
                />
              </g>
            );
          }),
        )}
      </svg>
    );
  }

  if (kind === 'describe') {
    return (
      <svg {...common}>
        <rect x="8" y="20" width="62" height="52" rx="5" fill="#fff" stroke={pale} strokeWidth="1.5" />
        <rect x="16" y="30" width="44" height="3.5" rx="1.75" fill={mid} />
        <rect x="16" y="39" width="38" height="3.5" rx="1.75" fill={mid} />
        <rect x="16" y="48" width="46" height="3.5" rx="1.75" fill={mid} />
        <rect x="16" y="57" width="22" height="3.5" rx="1.75" fill={mid} />

        {/* The arrow is the argument: a sentence becomes a structure. */}
        <path d="M76 46h12m0 0-4-4m4 4-4 4" stroke={ink} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />

        <rect x="96" y="12" width="52" height="68" rx="5" fill="#f2f8f4" stroke={ink} strokeWidth="1.5" />
        <rect x="104" y="22" width="24" height="4" rx="2" fill={ink} />
        <rect x="104" y="33" width="36" height="3" rx="1.5" fill={mid} />
        <rect x="104" y="41" width="30" height="3" rx="1.5" fill={mid} />
        <circle cx="107" cy="54" r="3" fill={ink} />
        <rect x="114" y="52" width="26" height="3" rx="1.5" fill={mid} />
        <circle cx="107" cy="65" r="3" fill={ink} />
        <rect x="114" y="63" width="20" height="3" rx="1.5" fill={mid} />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <rect x="10" y="26" width="62" height="54" rx="5" fill="#fff" stroke={pale} strokeWidth="1.5" />
      <rect x="20" y="38" width="30" height="3.5" rx="1.75" fill={pale} />
      <rect x="20" y="47" width="40" height="3" rx="1.5" fill={pale} />
      <rect x="20" y="55" width="24" height="3" rx="1.5" fill={pale} />
      <rect x="20" y="63" width="34" height="3" rx="1.5" fill={pale} />

      <rect x="60" y="12" width="62" height="54" rx="5" fill="#f2f8f4" stroke={ink} strokeWidth="1.5" />
      <rect x="70" y="24" width="30" height="4" rx="2" fill={ink} />
      <rect x="70" y="34" width="40" height="3" rx="1.5" fill={mid} />
      <rect x="70" y="42" width="24" height="3" rx="1.5" fill={mid} />
      <rect x="70" y="50" width="34" height="3" rx="1.5" fill={mid} />

      <path d="M130 30v22m0 0-4-4m4 4 4-4" stroke={mid} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Outline({
  blueprint,
  tab,
  index,
  onSelect,
  onAdd,
}: {
  blueprint: Blueprint;
  tab: Tab;
  index: number;
  onSelect: (t: Tab, i: number) => void;
  onAdd: (t: Tab) => void;
}) {
  const groups: { tab: Tab; label: string; items: { key: string; name: string; note?: string }[] }[] = [
    {
      tab: 'fields',
      label: 'Fields',
      items: blueprint.data.fields.map((f) => ({ key: f.key, name: f.label, note: f.type })),
    },
    {
      tab: 'states',
      label: 'States',
      items: blueprint.workflow.states.map((s) => ({ key: s.key, name: s.name, note: s.type })),
    },
    {
      tab: 'rules',
      label: 'Automation',
      // What the process does on its own. It was editable only as raw JSON,
      // which meant the part that makes this more than a form was the part
      // nobody could change.
      items: (blueprint.workflow.transitions ?? []).map((t) => ({
        key: t.key,
        name: t.key.replace(/_/g, ' '),
        note: (t.trigger as { on: string }).on.replace(/_/g, ' '),
      })),
    },
    {
      tab: 'approvals',
      label: 'Approvals',
      items: (blueprint.workflow.approvals ?? []).map((a) => ({ key: a.key, name: a.name, note: a.mode })),
    },
    {
      tab: 'tasks',
      label: 'Tasks',
      items: (blueprint.workflow.tasks ?? []).map((t) => ({
        key: t.key,
        name: t.name,
        note: partyLabel(t.assignee),
      })),
    },
    {
      tab: 'roles',
      label: 'Roles',
      items: blueprint.roles.map((r) => ({ key: r.key, name: r.name, note: r.kind })),
    },
  ];

  return (
    <nav className="bd__outline">
      {groups.map((g) => (
        <section key={g.tab} className="bd__group">
          <header className="bd__groupHead">
            <span>{g.label}</span>
            <span className="bd__count">{g.items.length}</span>
            <button className="bd__add" onClick={() => onAdd(g.tab)} title={`Add a ${g.label.slice(0, -1).toLowerCase()}`}>
              +
            </button>
          </header>
          {g.items.map((item, i) => (
            <button
              key={item.key + i}
              className="bd__outlineItem"
              aria-current={tab === g.tab && index === i ? 'true' : undefined}
              onClick={() => onSelect(g.tab, i)}
            >
              <span className="bd__outlineName">{item.name}</span>
              {item.note && <span className="bd__outlineNote">{item.note}</span>}
            </button>
          ))}
        </section>
      ))}

      <section className="bd__group">
        <header className="bd__groupHead">
          <span>Everything else</span>
        </header>
        <button
          className="bd__outlineItem"
          aria-current={tab === 'json' ? 'true' : undefined}
          onClick={() => onSelect('json', 0)}
        >
          <span className="bd__outlineName">Blueprint JSON</span>
          <span className="bd__outlineNote">transitions, messages, outputs</span>
        </button>
      </section>
    </nav>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="bd__row">
      <span className="bd__rowLabel">
        {label}
        {hint && <em>{hint}</em>}
      </span>
      {children}
    </label>
  );
}

function num(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// ------------------------------------------------------------ field editor

function FieldEditor({
  field,
  width,
  onWidth,
  onChange,
  onRemove,
}: {
  field: BpField | undefined;
  /** Absent when this field is not on any form page, so there is no width to set. */
  width?: string;
  onWidth?: (next: string) => void;
  onChange: (fn: (f: BpField) => void) => void;
  onRemove: () => void;
}) {
  if (!field) return <p className="bd__none">No field selected.</p>;
  const c = field.constraints ?? {};

  return (
    <>
      <EditorHead title={field.label || field.key} kind="Field" onRemove={onRemove} />

      <Row label="Label">
        <input className="bd__input" value={field.label} onChange={(e) => onChange((f) => void (f.label = e.target.value))} />
      </Row>

      <Row label="Key" hint="how everything else refers to this field">
        <input
          className="bd__input bd__mono"
          value={field.key}
          onChange={(e) => onChange((f) => void (f.key = e.target.value))}
        />
      </Row>

      <div className="bd__pair">
        <Row label="Type">
          <select className="bd__input" value={field.type} onChange={(e) => onChange((f) => void (f.type = e.target.value))}>
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Classification" hint="checked against the process ceiling">
          <select
            className="bd__input"
            value={field.classification}
            onChange={(e) => onChange((f) => void (f.classification = e.target.value))}
          >
            {CLASSES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Row>
      </div>

      {/*
        * Width is a property of where the field sits, not of the field, so it
        * is stored on the section. A first and last name that share a line
        * read as one question; the same two stacked read as two.
        */}
      {onWidth && (
        <Row label="Width on the form" hint="phones always get one column, whatever this says">
          <select className="bd__input" value={width ?? 'full'} onChange={(e) => onWidth(e.target.value)}>
            <option value="full">the full width</option>
            <option value="half">a half — two share a line</option>
            <option value="third">a third — three share a line</option>
          </select>
        </Row>
      )}

      <div className="bd__pair">
        <Row label="Filled in by">
          <select
            className="bd__input"
            value={field.setBy ?? 'respondent'}
            onChange={(e) => onChange((f) => void (f.setBy = e.target.value))}
          >
            <option value="respondent">the respondent</option>
            <option value="operator">an operator</option>
            <option value="system">the runtime</option>
          </select>
        </Row>

        <Row label="Required">
          <label className="bd__check">
            <input
              type="checkbox"
              checked={field.required ?? false}
              onChange={(e) => onChange((f) => void (f.required = e.target.checked))}
            />
            <span>must be answered</span>
          </label>
        </Row>
      </div>

      <Row label="Help text" hint="shown under the field">
        <input className="bd__input" value={field.help ?? ''} onChange={(e) => onChange((f) => void (f.help = e.target.value || undefined))} />
      </Row>

      {(field.classification === 'confidential' || field.classification === 'restricted') && (
        <Row label="Why this is collected" hint="over-collection should be visible in review, not in an audit">
          <input
            className="bd__input"
            value={field.collectionReason ?? ''}
            onChange={(e) => onChange((f) => void (f.collectionReason = e.target.value || undefined))}
          />
        </Row>
      )}

      {CHOICE_TYPES.has(field.type) && (
        <fieldset className="bd__fieldset">
          <legend>Choices</legend>
          {(field.choices ?? []).map((choice, i) => (
            <div className="bd__choice" key={i}>
              <input
                className="bd__input bd__mono"
                value={choice.value}
                placeholder="value"
                onChange={(e) => onChange((f) => void (f.choices![i]!.value = e.target.value))}
              />
              <input
                className="bd__input"
                value={choice.label}
                placeholder="label"
                onChange={(e) => onChange((f) => void (f.choices![i]!.label = e.target.value))}
              />
              <button className="bd__iconBtn" onClick={() => onChange((f) => void f.choices!.splice(i, 1))} title="Remove">
                ×
              </button>
            </div>
          ))}
          <button
            className="bd__btn bd__btn--small"
            onClick={() =>
              onChange((f) => {
                f.choices = f.choices ?? [];
                f.choices.push({ value: `option_${f.choices.length + 1}`, label: `Option ${f.choices.length + 1}` });
              })
            }
          >
            Add a choice
          </button>
        </fieldset>
      )}

      <fieldset className="bd__fieldset">
        <legend>Constraints</legend>
        <div className="bd__pair">
          {(field.type === 'number' || field.type === 'currency') && (
            <>
              <Row label="Minimum">
                <input
                  className="bd__input"
                  type="number"
                  value={(c.min as number) ?? ''}
                  onChange={(e) => onChange((f) => setConstraint(f, 'min', num(e.target.value)))}
                />
              </Row>
              <Row label="Maximum">
                <input
                  className="bd__input"
                  type="number"
                  value={(c.max as number) ?? ''}
                  onChange={(e) => onChange((f) => setConstraint(f, 'max', num(e.target.value)))}
                />
              </Row>
            </>
          )}
          {(field.type === 'short_text' || field.type === 'long_text') && (
            <>
              <Row label="Shortest">
                <input
                  className="bd__input"
                  type="number"
                  value={(c.minLength as number) ?? ''}
                  onChange={(e) => onChange((f) => setConstraint(f, 'minLength', num(e.target.value)))}
                />
              </Row>
              <Row label="Longest">
                <input
                  className="bd__input"
                  type="number"
                  value={(c.maxLength as number) ?? ''}
                  onChange={(e) => onChange((f) => setConstraint(f, 'maxLength', num(e.target.value)))}
                />
              </Row>
            </>
          )}
          {field.type === 'currency' && (
            <Row label="Currency" hint="three letters">
              <input
                className="bd__input bd__mono"
                maxLength={3}
                value={(c.currencyCode as string) ?? ''}
                onChange={(e) => onChange((f) => setConstraint(f, 'currencyCode', e.target.value.toUpperCase() || undefined))}
              />
            </Row>
          )}
          {field.type === 'rating' && (
            <Row label="Scale" hint="2 to 10">
              <input
                className="bd__input"
                type="number"
                value={(c.scale as number) ?? ''}
                onChange={(e) => onChange((f) => setConstraint(f, 'scale', num(e.target.value)))}
              />
            </Row>
          )}
          {field.type === 'file' && (
            <>
              <Row label="Largest file" hint="MB">
                <input
                  className="bd__input"
                  type="number"
                  value={(c.maxSizeMb as number) ?? ''}
                  onChange={(e) => onChange((f) => setConstraint(f, 'maxSizeMb', num(e.target.value)))}
                />
              </Row>
              <Row label="Accepted types" hint="comma separated">
                <input
                  className="bd__input bd__mono"
                  value={((c.accept as string[]) ?? []).join(', ')}
                  onChange={(e) =>
                    onChange((f) =>
                      setConstraint(
                        f,
                        'accept',
                        e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                      ),
                    )
                  }
                />
              </Row>
            </>
          )}
          {field.type === 'date' && (
            <>
              <Row label="Not before" hint="days from today, may be negative">
                <input
                  className="bd__input"
                  type="number"
                  value={(c.minDaysFromToday as number) ?? ''}
                  onChange={(e) => onChange((f) => setConstraint(f, 'minDaysFromToday', num(e.target.value)))}
                />
              </Row>
              <Row label="Not after" hint="days from today">
                <input
                  className="bd__input"
                  type="number"
                  value={(c.maxDaysFromToday as number) ?? ''}
                  onChange={(e) => onChange((f) => setConstraint(f, 'maxDaysFromToday', num(e.target.value)))}
                />
              </Row>
            </>
          )}
        </div>
        <Row label="Message when it fails" hint="what the respondent reads">
          <input
            className="bd__input"
            value={(c.message as string) ?? ''}
            onChange={(e) => onChange((f) => setConstraint(f, 'message', e.target.value || undefined))}
          />
        </Row>
      </fieldset>
    </>
  );
}

function setConstraint(f: BpField, key: string, value: unknown): void {
  f.constraints = f.constraints ?? {};
  if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) delete f.constraints[key];
  else f.constraints[key] = value;
  if (!Object.keys(f.constraints).length) delete f.constraints;
}

// ------------------------------------------------------------ state editor

function StateEditor({
  state,
  transitions,
  onChange,
  onRemove,
}: {
  state: BpState | undefined;
  transitions: { key: string; name?: string; from: string; to: string }[];
  onChange: (fn: (s: BpState) => void) => void;
  onRemove: () => void;
}) {
  if (!state) return <p className="bd__none">No state selected.</p>;
  const out = transitions.filter((t) => t.from === state.key);
  const into = transitions.filter((t) => t.to === state.key);

  return (
    <>
      <EditorHead title={state.name || state.key} kind="State" onRemove={onRemove} />

      <Row label="Name">
        <input className="bd__input" value={state.name} onChange={(e) => onChange((s) => void (s.name = e.target.value))} />
      </Row>
      <Row label="Key">
        <input className="bd__input bd__mono" value={state.key} onChange={(e) => onChange((s) => void (s.key = e.target.value))} />
      </Row>

      <div className="bd__pair">
        <Row label="Kind">
          <select className="bd__input" value={state.type} onChange={(e) => onChange((s) => void (s.type = e.target.value))}>
            <option value="initial">initial</option>
            <option value="active">active</option>
            <option value="waiting">waiting</option>
            <option value="terminal">terminal</option>
          </select>
        </Row>
        {state.type === 'terminal' && (
          <Row label="Outcome" hint="completion rate is not computable without it">
            <select
              className="bd__input"
              value={state.outcome ?? ''}
              onChange={(e) => onChange((s) => void (s.outcome = e.target.value || undefined))}
            >
              <option value="">—</option>
              <option value="success">success</option>
              <option value="rejected">rejected</option>
              <option value="cancelled">cancelled</option>
              <option value="expired">expired</option>
            </select>
          </Row>
        )}
      </div>

      <div className="bd__pair">
        <Row label="Late after" hint="hours in this state">
          <input
            className="bd__input"
            type="number"
            value={state.slaHours ?? ''}
            onChange={(e) => onChange((s) => void (s.slaHours = num(e.target.value)))}
          />
        </Row>
        <Row label="Shown to the respondent as">
          <input
            className="bd__input"
            value={state.publicLabel ?? ''}
            onChange={(e) => onChange((s) => void (s.publicLabel = e.target.value || undefined))}
          />
        </Row>
      </div>

      <fieldset className="bd__fieldset">
        <legend>Transitions</legend>
        <p className="bd__note">
          Edited in the JSON tab for now. A state with nothing leaving it and no terminal kind is where records
          get stuck, which is what the compiler is checking for.
        </p>
        <dl className="bd__defs">
          <dt>In</dt>
          <dd>{into.length ? into.map((t) => t.key).join(', ') : <em>nothing reaches this state</em>}</dd>
          <dt>Out</dt>
          <dd>{out.length ? out.map((t) => `${t.key} → ${t.to}`).join(', ') : <em>nothing leaves this state</em>}</dd>
        </dl>
      </fieldset>
    </>
  );
}

// --------------------------------------------------------- approval editor

function PartyPicker({
  party,
  roles,
  fields,
  onChange,
}: {
  party: Party;
  roles: BpRole[];
  fields: BpField[];
  onChange: (next: Party) => void;
}) {
  const kind = 'role' in party ? 'role' : 'field' in party ? 'field' : 'user' in party ? 'user' : 'submitter' in party ? 'submitter' : 'assignee';
  const emailFields = fields.filter((f) => f.type === 'email');

  return (
    <div className="bd__party">
      <select
        className="bd__input"
        value={kind}
        onChange={(e) => {
          const next = e.target.value;
          if (next === 'role') onChange({ role: roles[0]?.key ?? 'reviewer' });
          else if (next === 'field') onChange({ field: emailFields[0]?.key ?? fields[0]?.key ?? '' });
          else if (next === 'user') onChange({ user: '' });
          else if (next === 'submitter') onChange({ submitter: true });
          else onChange({ assignee: 'current' });
        }}
      >
        <option value="role">whoever holds a role</option>
        <option value="field">an address on the record</option>
        <option value="user">a named person</option>
        <option value="submitter">the person who submitted it</option>
        <option value="assignee">the current assignee</option>
      </select>

      {'role' in party && (
        <select className="bd__input" value={party.role} onChange={(e) => onChange({ role: e.target.value })}>
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.name}
            </option>
          ))}
        </select>
      )}
      {'field' in party && (
        <select className="bd__input" value={party.field} onChange={(e) => onChange({ field: e.target.value })}>
          {(emailFields.length ? emailFields : fields).map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      )}
      {'user' in party && (
        <input
          className="bd__input"
          type="email"
          placeholder="someone@example.com"
          value={party.user}
          onChange={(e) => onChange({ user: e.target.value })}
        />
      )}
    </div>
  );
}

function ApprovalEditor({
  approval,
  roles,
  fields,
  onChange,
  onRemove,
}: {
  approval: BpApproval | undefined;
  roles: BpRole[];
  fields: BpField[];
  onChange: (fn: (a: BpApproval) => void) => void;
  onRemove: () => void;
}) {
  if (!approval) return <p className="bd__none">No approval selected.</p>;
  const internal = roles.filter((r) => r.kind === 'internal');

  return (
    <>
      <EditorHead title={approval.name || approval.key} kind="Approval" onRemove={onRemove} />

      <Row label="Name">
        <input className="bd__input" value={approval.name} onChange={(e) => onChange((a) => void (a.name = e.target.value))} />
      </Row>
      <Row label="Key">
        <input className="bd__input bd__mono" value={approval.key} onChange={(e) => onChange((a) => void (a.key = e.target.value))} />
      </Row>

      <Row label="How it clears" hint="the threshold">
        <select className="bd__input" value={approval.mode} onChange={(e) => onChange((a) => void (a.mode = e.target.value as BpApproval['mode']))}>
          <option value="single">one approver decides</option>
          <option value="sequential">each in turn, in the order listed</option>
          <option value="any_of">any one of them is enough</option>
        </select>
      </Row>

      <fieldset className="bd__fieldset">
        <legend>Approvers</legend>
        {approval.approvers.map((party, i) => (
          <div className="bd__partyRow" key={i}>
            <span className="bd__ordinal">{approval.mode === 'sequential' ? `${i + 1}.` : '·'}</span>
            <PartyPicker
              party={party}
              roles={internal.length ? internal : roles}
              fields={fields}
              onChange={(next) => onChange((a) => void (a.approvers[i] = next))}
            />
            <button
              className="bd__iconBtn"
              onClick={() => onChange((a) => void a.approvers.splice(i, 1))}
              disabled={approval.approvers.length === 1}
              title={approval.approvers.length === 1 ? 'an approval needs at least one approver' : 'Remove'}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="bd__btn bd__btn--small"
          onClick={() => onChange((a) => void a.approvers.push({ role: internal[0]?.key ?? roles[0]?.key ?? '' }))}
        >
          Add an approver
        </button>
      </fieldset>

      <div className="bd__pair">
        <Row label="Due after" hint="hours">
          <input
            className="bd__input"
            type="number"
            value={approval.dueInHours ?? ''}
            onChange={(e) => onChange((a) => void (a.dueInHours = num(e.target.value)))}
          />
        </Row>
        <Row label="Options">
          <>
            <label className="bd__check">
              <input
                type="checkbox"
                checked={approval.allowRequestChanges ?? true}
                onChange={(e) => onChange((a) => void (a.allowRequestChanges = e.target.checked))}
              />
              <span>may ask for changes</span>
            </label>
            <label className="bd__check">
              <input
                type="checkbox"
                checked={approval.reasonRequired ?? false}
                onChange={(e) => onChange((a) => void (a.reasonRequired = e.target.checked))}
              />
              <span>must give a reason</span>
            </label>
          </>
        </Row>
      </div>

      <fieldset className="bd__fieldset">
        <legend>What the approver sees</legend>
        <p className="bd__note">The fields on the approval queue summary. Choose what the decision actually turns on.</p>
        <div className="bd__chips">
          {fields.map((f) => {
            const on = (approval.contextFields ?? []).includes(f.key);
            return (
              <button
                key={f.key}
                className={`bd__chip${on ? ' bd__chip--on' : ''}`}
                onClick={() =>
                  onChange((a) => {
                    const list = new Set(a.contextFields ?? []);
                    if (on) list.delete(f.key);
                    else list.add(f.key);
                    a.contextFields = list.size ? [...list] : undefined;
                  })
                }
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </fieldset>
    </>
  );
}

// ------------------------------------------------------------- task editor

function TaskEditor({
  task,
  roles,
  fields,
  onChange,
  onRemove,
}: {
  task: BpTask | undefined;
  roles: BpRole[];
  fields: BpField[];
  onChange: (fn: (t: BpTask) => void) => void;
  onRemove: () => void;
}) {
  if (!task) return <p className="bd__none">No task selected.</p>;

  return (
    <>
      <EditorHead title={task.name || task.key} kind="Task" onRemove={onRemove} />

      <Row label="Name">
        <input className="bd__input" value={task.name} onChange={(e) => onChange((t) => void (t.name = e.target.value))} />
      </Row>
      <Row label="Key">
        <input className="bd__input bd__mono" value={task.key} onChange={(e) => onChange((t) => void (t.key = e.target.value))} />
      </Row>
      <Row label="Description">
        <textarea
          className="bd__input bd__textarea"
          rows={3}
          value={task.description ?? ''}
          onChange={(e) => onChange((t) => void (t.description = e.target.value || undefined))}
        />
      </Row>

      <Row label="Assigned to">
        <PartyPicker
          party={task.assignee}
          roles={roles}
          fields={fields}
          onChange={(next) => onChange((t) => void (t.assignee = next))}
        />
      </Row>

      <div className="bd__pair">
        <Row label="Due after" hint="hours">
          <input
            className="bd__input"
            type="number"
            value={task.dueInHours ?? ''}
            onChange={(e) => onChange((t) => void (t.dueInHours = num(e.target.value)))}
          />
        </Row>
        <Row label="Who may complete it">
          <select
            className="bd__input"
            value={task.completableBy ?? 'assignee'}
            onChange={(e) => onChange((t) => void (t.completableBy = e.target.value as BpTask['completableBy']))}
          >
            <option value="assignee">only whoever it is assigned to</option>
            <option value="any_operator">anyone who may operate this process</option>
          </select>
        </Row>
      </div>

      <Row label="Blocking" hint="a blocking task keeps the record out of its next state">
        <label className="bd__check">
          <input
            type="checkbox"
            checked={task.blocking ?? true}
            onChange={(e) => onChange((t) => void (t.blocking = e.target.checked))}
          />
          <span>the process waits for this</span>
        </label>
      </Row>
    </>
  );
}

// ------------------------------------------------------------- role editor

function RoleEditor({
  role,
  fields,
  onChange,
  onRemove,
}: {
  role: BpRole | undefined;
  fields: BpField[];
  onChange: (fn: (r: BpRole) => void) => void;
  onRemove: () => void;
}) {
  if (!role) return <p className="bd__none">No role selected.</p>;

  const toggleList = (which: 'hiddenFields' | 'editableFields', key: string) =>
    onChange((r) => {
      const list = new Set(r[which] ?? []);
      if (list.has(key)) list.delete(key);
      else list.add(key);
      r[which] = list.size ? [...list] : undefined;
    });

  return (
    <>
      <EditorHead title={role.name || role.key} kind="Role" onRemove={onRemove} />

      <Row label="Name">
        <input className="bd__input" value={role.name} onChange={(e) => onChange((r) => void (r.name = e.target.value))} />
      </Row>
      <Row label="Key">
        <input className="bd__input bd__mono" value={role.key} onChange={(e) => onChange((r) => void (r.key = e.target.value))} />
      </Row>
      <Row label="Kind" hint="respondents are people outside the workspace">
        <select className="bd__input" value={role.kind} onChange={(e) => onChange((r) => void (r.kind = e.target.value as BpRole['kind']))}>
          <option value="internal">internal</option>
          <option value="respondent">respondent</option>
        </select>
      </Row>

      <fieldset className="bd__fieldset">
        <legend>Capabilities</legend>
        <div className="bd__chips">
          {CAPABILITIES.map((cap) => {
            const on = role.capabilities.includes(cap);
            return (
              <button
                key={cap}
                className={`bd__chip${on ? ' bd__chip--on' : ''}`}
                onClick={() =>
                  onChange((r) => {
                    const list = new Set(r.capabilities);
                    if (on) list.delete(cap);
                    else list.add(cap);
                    r.capabilities = [...list];
                  })
                }
              >
                {cap}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="bd__fieldset">
        <legend>Never shown to this role</legend>
        <p className="bd__note">Redaction happens on read, in the runtime — not in the browser.</p>
        <div className="bd__chips">
          {fields.map((f) => (
            <button
              key={f.key}
              className={`bd__chip${(role.hiddenFields ?? []).includes(f.key) ? ' bd__chip--on' : ''}`}
              onClick={() => toggleList('hiddenFields', f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="bd__fieldset">
        <legend>May be changed by this role after submission</legend>
        <p className="bd__note">
          A respondent role with nothing here cannot answer a request for changes — the approval loop stops dead.
        </p>
        <div className="bd__chips">
          {fields.map((f) => (
            <button
              key={f.key}
              className={`bd__chip${(role.editableFields ?? []).includes(f.key) ? ' bd__chip--on' : ''}`}
              onClick={() => toggleList('editableFields', f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </fieldset>
    </>
  );
}

function EditorHead({ title, kind, onRemove }: { title: string; kind: string; onRemove: () => void }) {
  return (
    <header className="bd__editorHead">
      <div>
        <span className="bd__kind">{kind}</span>
        <h2>{title}</h2>
      </div>
      <button className="bd__btn bd__btn--small bd__btn--danger" onClick={onRemove}>
        Remove
      </button>
    </header>
  );
}

// ------------------------------------------------------------- json escape

function JsonEditor({ blueprint, onReplace }: { blueprint: Blueprint; onReplace: (bp: Blueprint) => void }) {
  const [text, setText] = useState(() => JSON.stringify(blueprint, null, 2));
  const [bad, setBad] = useState<string | null>(null);

  // Reset when a different draft is opened, but not on every keystroke — the
  // textarea is the source of truth while it is focused.
  useEffect(() => {
    setText(JSON.stringify(blueprint, null, 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blueprint.key]);

  return (
    <>
      <header className="bd__editorHead">
        <div>
          <span className="bd__kind">Everything else</span>
          <h2>Blueprint JSON</h2>
        </div>
      </header>
      <p className="bd__note">
        Intent, the form experience, transitions, messages, documents and scenario tests have no form editor
        yet. They are edited here. Malformed JSON is not sent — the compiler cannot tell you anything useful
        about text that is not a blueprint.
      </p>
      <textarea
        className="bd__json"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value);
            setBad(null);
            onReplace(parsed as Blueprint);
          } catch (err) {
            setBad(err instanceof Error ? err.message : 'that is not JSON');
          }
        }}
      />
      {bad && <p className="bd__jsonBad">{bad}</p>}
    </>
  );
}

// ------------------------------------------------------------ diagnostics

function DiagnosticsPanel({
  blueprint,
  errors,
  warnings,
  onGo,
}: {
  blueprint: Blueprint;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  onGo: (where: { tab: Tab; index: number }) => void;
}) {
  return (
    <aside className="bd__diag">
      {/* The tally is the thing a builder is watching, and it changes on every
          keystroke without focus moving — 4.1.3 again. `atomic` so it is read
          as one sentence rather than two numbers. */}
      <header className="bd__diagHead" role="status" aria-live="polite" aria-atomic="true">
        <span className={errors.length ? 'bd__tallyBad' : 'bd__tallyOk'}>
          {errors.length} {errors.length === 1 ? 'error' : 'errors'}
        </span>
        <span className="bd__tallyWarn">
          {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
        </span>
      </header>

      {!errors.length && !warnings.length && (
        <p className="bd__diagClean">
          Compiles clean. Errors stop a publish; warnings do not.
        </p>
      )}

      {[...errors, ...warnings].map((d, i) => {
        const where = locate(d, blueprint);
        return (
          <article
            key={`${d.code}-${d.at}-${i}`}
            className={`bd__diagItem bd__diagItem--${d.severity}${where ? ' bd__diagItem--go' : ''}`}
            onClick={where ? () => onGo(where) : undefined}
          >
            <header>
              <code>{d.code}</code>
              <span className="bd__diagAt">{d.at}</span>
            </header>
            <p>{d.message}</p>
            {d.fix && <p className="bd__diagFix">{d.fix}</p>}
          </article>
        );
      })}
    </aside>
  );
}

// ---------------------------------------------------------------- drawers

function PublishDrawer({
  impact,
  busy,
  onConfirm,
  onClose,
}: {
  impact: PublishImpact;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const box = useDialog(onClose);
  const nothing =
    !impact.fields.added.length &&
    !impact.fields.removed.length &&
    !impact.fields.retyped.length &&
    !impact.states.added.length &&
    !impact.states.removed.length;

  return (
    <div className="bd__drawer" role="dialog" aria-modal="true" aria-labelledby="publish-drawer-title">
      <div className="bd__drawerBox" ref={box} tabIndex={-1}>
        <header className="bd__drawerHead">
          <h2 id="publish-drawer-title">
            Publish {impact.fromVersion === null ? 'version 1' : `version ${impact.fromVersion + 1}`}
          </h2>
          <button className="bd__iconBtn" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="bd__impactBig">
          <strong>{impact.inFlight}</strong>
          <span>
            {impact.inFlight === 1 ? 'record is' : 'records are'} still running. They stay on the version they
            started under and will not pick this up.
          </span>
        </div>

        {nothing && <p className="bd__none">No schema or state changes — this version differs only in behaviour.</p>}

        {impact.fields.added.length > 0 && (
          <Change label="Fields added" tone="ok" items={impact.fields.added} />
        )}
        {impact.fields.removed.length > 0 && (
          <Change label="Fields removed" tone="bad" items={impact.fields.removed} />
        )}
        {impact.fields.retyped.length > 0 && (
          <Change
            label="Fields retyped"
            tone="warn"
            items={impact.fields.retyped.map((r) => `${r.key}: ${r.from} → ${r.to}`)}
          />
        )}
        {impact.states.added.length > 0 && <Change label="States added" tone="ok" items={impact.states.added} />}
        {impact.states.removed.length > 0 && <Change label="States removed" tone="bad" items={impact.states.removed} />}

        {impact.strandedData.length > 0 && (
          <div className="bd__stranded">
            <strong>Records still hold values for fields you removed.</strong>
            <p>
              The data is not deleted — it stays readable under retention, but nothing in the new version
              displays it: {impact.strandedData.join(', ')}.
            </p>
          </div>
        )}

        {impact.warnings.length > 0 && (
          <div className="bd__warnList">
            <strong>{impact.warnings.length} unresolved {impact.warnings.length === 1 ? 'warning' : 'warnings'}</strong>
            {impact.warnings.map((w, i) => (
              <p key={i}>
                <code>{w.code}</code> {w.message}
              </p>
            ))}
          </div>
        )}

        <div className="bd__drawerActions">
          <button className="bd__btn" onClick={onClose} disabled={busy}>
            Not yet
          </button>
          <button className="bd__btn bd__btn--primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Change({ label, tone, items }: { label: string; tone: string; items: string[] }) {
  return (
    <div className={`bd__change bd__change--${tone}`}>
      <strong>{label}</strong>
      <p>{items.join(', ')}</p>
    </div>
  );
}

// ---------------------------------------------------------- new process

function NewProcessDialog({
  processes,
  onClose,
  onCreated,
}: {
  processes: ProcessRow[];
  onClose: () => void;
  onCreated: (detail: DraftDetail) => void;
}) {
  const [mode, setMode] = useState<'pack' | 'describe' | 'copy'>('pack');
  // null until the catalogue answers. An empty array is a real answer
  // (there are none) and must not be confused with not having asked.
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [chosen, setChosen] = useState<Pack | null>(null);
  const [detail, setDetail] = useState<PackDetail | null>(null);

  /*
   * If the catalogue turns out to be empty, do not sit on a tab that offers
   * nothing. The dialog opened on "From a pack" and said "No packs
   * available", which is a first screen that answers its own question with
   * a dead end.
   */
  const [movedOff, setMovedOff] = useState(false);


  useEffect(() => {
    if (!movedOff && mode === 'pack' && packs !== null && packs.length === 0) {
      setMode('describe');
      setMovedOff(true);
    }
  }, [packs, mode, movedOff]);


  // Read when one is chosen rather than for the whole catalogue: a list of
  // twenty packs does not need twenty blueprints parsed to draw a card.
  useEffect(() => {
    if (!chosen) return setDetail(null);
    let live = true;
    call<PackDetail>(`/api/packs/${chosen.id}`)
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [chosen]);

  useEffect(() => {
    void (async () => {
      try {
        setPacks(await call<Pack[]>('/api/packs'));
      } catch {
        // A catalogue that will not load is not a reason to block the other
        // two routes into a new process.
        setPacks([]);
      }
    })();
  }, []);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [copyFrom, setCopyFrom] = useState(processes.find((p) => p.version !== null)?.process_key ?? '');

  /** What is still missing, or null when the form is ready. */
  const blocker =
    key.length < 3
      ? 'A key of at least three characters, please.'
      : mode === 'pack'
        ? chosen
          ? null
          : packs !== null && packs.length === 0
            ? 'No packs are published yet — use "Describe it" instead.'
            : 'Choose a pack above.'
        : mode === 'describe'
          ? description.trim().length < 20
            ? 'Describe the process in a sentence or two.'
            : null
          : copyFrom
            ? null
            : 'Choose a process to copy.';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useDialog(onClose);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (mode === 'pack') {
        if (!chosen) throw new Error('choose a pack');
        // Installing gives a draft, not a live process. §1.3's review before
        // publish applies to something we wrote as much as to a generated one.
        const installed = await call<{ draftId: string }>(`/api/packs/${chosen.id}/install`, {
          method: 'POST',
          body: JSON.stringify({ processKey: key, name: name || undefined }),
        });
        onCreated(await call<DraftDetail>(`/api/builder/drafts/${installed.draftId}`));
        return;
      }
      const detail = await call<DraftDetail>('/api/builder/create', {
        method: 'POST',
        body: JSON.stringify(
          mode === 'describe'
            ? { key, name: name || undefined, description }
            : { key, name: name || undefined, copyFrom },
        ),
      });
      onCreated(detail);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bd__drawer" role="dialog" aria-modal="true" aria-labelledby="new-drawer-title">
      <div className="bd__drawerBox" ref={box} tabIndex={-1}>
        <header className="bd__drawerHead">
          <h2 id="new-drawer-title">New process</h2>
          <button className="bd__iconBtn" onClick={onClose} disabled={busy}>
            ×
          </button>
        </header>

        <div className="bd__modes">
          <button className={`bd__mode${mode === 'pack' ? ' bd__mode--on' : ''}`} onClick={() => setMode('pack')}>
            From a pack
          </button>
          <button className={`bd__mode${mode === 'describe' ? ' bd__mode--on' : ''}`} onClick={() => setMode('describe')}>
            Describe it
          </button>
          <button className={`bd__mode${mode === 'copy' ? ' bd__mode--on' : ''}`} onClick={() => setMode('copy')}>
            Copy an existing one
          </button>
        </div>

        <Row label="Key" hint="lowercase, underscores — this ends up in the public form URL">
          <input
            className="bd__input bd__mono"
            value={key}
            placeholder="contractor_onboarding"
            onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
          />
        </Row>
        <Row label="Name" hint="optional">
          <input className="bd__input" value={name} onChange={(e) => setName(e.target.value)} />
        </Row>

        {mode === 'pack' ? (
          <>
            <div className="bd__packs">
              {(packs ?? []).map((p) => (
                <button
                  key={p.id}
                  className={`bd__pack${chosen?.id === p.id ? ' bd__pack--on' : ''}`}
                  onClick={() => {
                    setChosen(p);
                    if (!key) setKey(p.packKey);
                  }}
                  aria-pressed={chosen?.id === p.id}
                >
                  <span className="bd__packCategory">{p.category}</span>
                  <strong>{p.name}</strong>
                  <span className="bd__packSummary">{p.summary}</span>
                  {/* Counted from the blueprint at publish, so a card cannot
                      claim something installing does not give you. */}
                  <span className="bd__packContents">
                    {p.contents.fields} fields · {p.contents.states} states · {p.contents.approvals} approvals ·{' '}
                    {p.contents.tasks} tasks · {p.contents.emails} messages · {p.contents.documents} documents ·{' '}
                    {p.contents.scenarios} scenarios
                  </span>
                  <span className="bd__packPolicy">
                    {p.contents.policy.restrictedFields} restricted, {p.contents.policy.fieldsHiddenFromSomeone} hidden
                    from at least one role
                    {p.contents.policy.retentionDays
                      ? `, kept ${Math.round(p.contents.policy.retentionDays / 365)} years`
                      : ', kept indefinitely'}
                  </span>
                </button>
              ))}
              {packs !== null && packs.length === 0 && (
                <p className="bd__note">
                  No packs are published yet. Describe what you need instead — that tab is open.
                </p>
              )}
              {packs === null && <p className="bd__note">Loading the catalogue…</p>}
            </div>
            {chosen && (
              <p className="bd__note">
                <strong>{chosen.audience}</strong> Installing opens it here as a draft — nothing goes live until you
                publish it.
              </p>
            )}

            {/*
              * What is actually inside, before you take it.
              *
              * Every count is derived from the blueprint, so a pack cannot
              * claim something installing it does not give you — and the
              * policy row is the part §1.2 says a form template can never
              * carry.
              */}
            {detail && (
              <div className="bd__packDetail">
                <strong>Inside this pack</strong>
                <ul>
                  <li>
                    {detail.contents.fields} fields, {detail.contents.states} states,{' '}
                    {detail.contents.approvals} approvals, {detail.contents.tasks} tasks
                  </li>
                  <li>
                    {detail.contents.emails} email templates, {detail.contents.documents} documents,{' '}
                    {detail.contents.metrics} dashboard metrics
                  </li>
                  <li>
                    Roles: {detail.contents.roles.map((r) => r.name).join(', ') || 'none declared'}
                  </li>
                  <li>
                    Policy: holds up to <strong>{detail.contents.policy.sensitivityCeiling}</strong> data,{' '}
                    {detail.contents.policy.restrictedFields} restricted field(s),{' '}
                    {detail.contents.policy.retentionDays
                      ? `kept ${detail.contents.policy.retentionDays} days`
                      : 'kept indefinitely'}
                  </li>
                </ul>
                {detail.warnings.length > 0 && (
                  <p className="bd__packWarn">
                    {detail.warnings.length} warning(s) the compiler raised on this pack — you will
                    see them again before you publish.
                  </p>
                )}
              </div>
            )}
          </>
        ) : mode === 'describe' ? (
          <>
            <Row label="What is this process" hint="who starts it, who decides, what happens at the end">
              <textarea
                className="bd__input bd__textarea"
                rows={7}
                value={description}
                placeholder="Contractors submit right-to-work documents and a day rate. Their hiring manager approves, then finance approves anything over £600 a day. IT sets up access and the contractor gets a welcome pack."
                onChange={(e) => setDescription(e.target.value)}
              />
            </Row>
            <p className="bd__note">
              The proposal is compiled and its scenarios are run before you see it. A model that cannot produce
              something that compiles does not get to hand you a draft — you get the reason instead. This takes
              a while.
            </p>
          </>
        ) : (
          <Row label="Copy from">
            <select className="bd__input" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
              {processes
                .filter((p) => p.version !== null)
                .map((p) => (
                  <option key={p.process_key} value={p.process_key}>
                    {p.name} (v{p.version})
                  </option>
                ))}
            </select>
          </Row>
        )}

        {err && <p className="bd__jsonBad">{err}</p>}

        <div className="bd__drawerActions">
          {/*
            * A disabled button that does not say why is a dead end with a
            * cursor on it. This says what is still needed, in the same place
            * somebody is looking when they wonder.
            */}
          {blocker && (
            <span className="bd__blocker" role="status">
              {blocker}
            </span>
          )}
          <button className="bd__btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="bd__btn bd__btn--primary"
            onClick={submit}
            disabled={busy || blocker !== null}
          >
            {busy ? 'Working…' : mode === 'pack' ? 'Install as a draft' : 'Create draft'}
          </button>
        </div>
      </div>
    </div>
  );
}
