'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './builder.css';

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

interface Diagnostic {
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

type Tab = 'fields' | 'states' | 'approvals' | 'tasks' | 'roles' | 'json';

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
  if (res.status === 401) throw new Unauthenticated(body.error ?? 'sign in first');
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
  const [processes, setProcesses] = useState<ProcessRow[]>([]);
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [publishable, setPublishable] = useState(false);
  const [tab, setTab] = useState<Tab>('fields');
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
      <div className="bd__boot">
        <p>The builder needs a signed-in workspace member.</p>
        <a className="bd__btn bd__btn--primary" href="/console">
          Sign in
        </a>
      </div>
    );
  }

  return (
    <div className="bd">
      <aside className="bd__side">
        <div className="bd__brand">
          <svg width="22" height="22" viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="var(--green-mint)" strokeWidth="1.8" />
            <path d="M7 13.2L11 17L19 9" stroke="var(--green-mint)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Patform
        </div>
        <div className="bd__sideLabel">Builder</div>

        <nav className="bd__list">
          {processes.map((p) => (
            <button
              key={p.process_key}
              className="bd__listItem"
              aria-current={draft?.processKey === p.process_key ? 'page' : undefined}
              onClick={() => (p.draft_id ? openById(p.draft_id) : open(p.process_key))}
              disabled={busy !== null}
            >
              <span className="bd__listName">{p.name ?? p.process_key}</span>
              <span className="bd__listMeta">
                {p.version === null ? 'unpublished' : `v${p.version}`}
                {p.draft_id ? <span className="bd__dot" title="a draft is open" /> : null}
              </span>
            </button>
          ))}
          {!processes.length && <p className="bd__empty">Nothing here yet.</p>}
        </nav>

        <button className="bd__newBtn" onClick={() => setCreating(true)} disabled={busy !== null}>
          + New process
        </button>

        <a className="bd__sideLink" href="/console">
          Open the console →
        </a>
      </aside>

      <main className="bd__main">
        {error && (
          <div className="bd__banner bd__banner--bad">
            {error}
            <button onClick={() => setError(null)}>dismiss</button>
          </div>
        )}
        {published !== null && (
          <div className="bd__banner bd__banner--good">
            Published as version {published}. Records already running stay on the version they started under.
            <button onClick={() => setPublished(null)}>dismiss</button>
          </div>
        )}

        {!draft || !blueprint ? (
          <Welcome onNew={() => setCreating(true)} />
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

            <div className="bd__body">
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
                {tab === 'json' && <JsonEditor blueprint={blueprint} onReplace={(bp) => replaceAll(bp)} />}
              </section>

              <DiagnosticsPanel
                blueprint={blueprint}
                errors={errors}
                warnings={warnings}
                onGo={(where) => {
                  setTab(where.tab);
                  setIndex(where.index);
                }}
              />
            </div>
          </>
        )}

        {tests && <TestDrawer tests={tests} onClose={() => setTests(null)} />}
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

function SaveState({ status }: { status: string }) {
  if (status === 'saving') return <span className="bd__saving">saving…</span>;
  if (status === 'saved') return <span className="bd__saved">saved</span>;
  if (status === 'error') return <span className="bd__savedBad">not saved</span>;
  return <span className="bd__saved">up to date</span>;
}

function Welcome({ onNew }: { onNew: () => void }) {
  return (
    <div className="bd__welcome">
      <h1>Pick a process, or describe a new one.</h1>
      <p>
        Every edit is compiled as you make it. Errors stop a publish; warnings do not. Nothing you type is
        lost while it is invalid — a draft that does not compile is still a draft.
      </p>
      <button className="bd__btn bd__btn--primary" onClick={onNew}>
        Describe a new process
      </button>
    </div>
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
  onChange,
  onRemove,
}: {
  field: BpField | undefined;
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
      <header className="bd__diagHead">
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

function TestDrawer({
  tests,
  onClose,
}: {
  tests: { results: ScenarioResult[]; passed: number; total: number };
  onClose: () => void;
}) {
  return (
    <div className="bd__drawer" role="dialog" aria-modal="true">
      <div className="bd__drawerBox">
        <header className="bd__drawerHead">
          <h2>
            {tests.passed} of {tests.total} scenarios passed
          </h2>
          <button className="bd__iconBtn" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="bd__note">
          Each one ran against the real engine in a scratch workspace — the same policy checks, the same
          transitions, the same effects. Nothing here is simulated.
        </p>
        {!tests.total && <p className="bd__none">This blueprint declares no scenarios, so nothing was proved.</p>}
        {tests.results.map((r) => (
          <article key={r.test} className={`bd__test bd__test--${r.passed ? 'ok' : 'bad'}`}>
            <header>
              <strong>{r.test}</strong>
              <span>{r.kind}</span>
              <span className="bd__testMark">{r.passed ? 'passed' : 'failed'}</span>
            </header>
            {r.failures.map((f, i) => (
              <p key={i}>{f}</p>
            ))}
          </article>
        ))}
      </div>
    </div>
  );
}

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
  const nothing =
    !impact.fields.added.length &&
    !impact.fields.removed.length &&
    !impact.fields.retyped.length &&
    !impact.states.added.length &&
    !impact.states.removed.length;

  return (
    <div className="bd__drawer" role="dialog" aria-modal="true">
      <div className="bd__drawerBox">
        <header className="bd__drawerHead">
          <h2>
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
  const [mode, setMode] = useState<'describe' | 'copy'>('describe');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [copyFrom, setCopyFrom] = useState(processes.find((p) => p.version !== null)?.process_key ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
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
    <div className="bd__drawer" role="dialog" aria-modal="true">
      <div className="bd__drawerBox">
        <header className="bd__drawerHead">
          <h2>New process</h2>
          <button className="bd__iconBtn" onClick={onClose} disabled={busy}>
            ×
          </button>
        </header>

        <div className="bd__modes">
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

        {mode === 'describe' ? (
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
          <button className="bd__btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="bd__btn bd__btn--primary"
            onClick={submit}
            disabled={busy || key.length < 3 || (mode === 'describe' ? description.trim().length < 20 : !copyFrom)}
          >
            {busy ? 'Working…' : 'Create draft'}
          </button>
        </div>
      </div>
    </div>
  );
}
