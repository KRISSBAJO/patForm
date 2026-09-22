'use client';

/**
 * The automation, as rules somebody can read.
 *
 * Fields, states, roles, approvals and tasks all had editors. The one thing
 * that could not be changed without hand-editing JSON was the part that makes
 * this a process rather than a form: **when something happens, if something is
 * true, do these things.**
 *
 * A rule list rather than a node canvas, and for a reason that outlives the
 * aesthetics: a transition already *is* a rule, so the mapping is one to one,
 * and the compiler's diagnostics point at transition keys — which means every
 * error can be shown against the rule that caused it rather than translated
 * onto a shape. A canvas would have to invent that correspondence.
 *
 * Two things the editor knows that a JSON tab cannot:
 *
 *   - **Only one timer may leave a state.** Entering a state cancels the
 *     previous occupancy's timers, so a second timer on the same state never
 *     fires. The compiler has no opinion — it is a property of the runtime —
 *     so the warning lives here, where somebody is about to add the second
 *     one.
 *   - **Every action key must be distinct within its rule.** They become
 *     idempotency keys, and two the same collapse into one run.
 */

import { useMemo, useState } from 'react';
import type { Diagnostic } from './Builder';
import './rules.css';

type Expr = Record<string, unknown>;

export interface Transition {
  key: string;
  from: string;
  to: string;
  trigger: Record<string, unknown>;
  when?: Expr;
  actions: Record<string, unknown>[];
}

export interface RuleContext {
  states: { key: string; name: string; type: string }[];
  approvals: { key: string; name: string }[];
  tasks: { key: string; name: string }[];
  templates: { key: string; name: string }[];
  documents: { key: string; name: string }[];
  fields: { key: string; label: string; type: string }[];
  roles: { key: string; name: string }[];
}

const TRIGGERS = [
  { on: 'submission', label: 'the form is submitted' },
  { on: 'record_updated', label: 'somebody edits the record' },
  { on: 'approval_decided', label: 'a decision is made' },
  { on: 'task_completed', label: 'a task is finished' },
  { on: 'timer', label: 'time passes in this state' },
  { on: 'inbound_webhook', label: 'another system tells us' },
  { on: 'manual', label: 'somebody presses a button' },
];

const ACTIONS = [
  { do: 'send_email', label: 'Send an email' },
  { do: 'request_approval', label: 'Ask somebody to decide' },
  { do: 'create_task', label: 'Create a task' },
  { do: 'generate_document', label: 'Generate a document' },
  { do: 'call_webhook', label: 'Tell another system' },
  { do: 'assign', label: 'Assign it to somebody' },
  { do: 'wait', label: 'Wait' },
];

const COMPARISONS = [
  { op: 'eq', label: 'is' },
  { op: 'ne', label: 'is not' },
  { op: 'gt', label: 'is more than' },
  { op: 'gte', label: 'is at least' },
  { op: 'lt', label: 'is less than' },
  { op: 'lte', label: 'is at most' },
  { op: 'is_present', label: 'was answered' },
  { op: 'is_empty', label: 'was left blank' },
];

/** The numeric comparisons only make sense against a number-like field. */
const NUMERIC = new Set(['gt', 'gte', 'lt', 'lte']);
const NUMERIC_FIELDS = new Set(['number', 'currency', 'rating', 'date', 'time']);

function label(list: { key: string; name?: string; label?: string }[], key: string): string {
  const found = list.find((x) => x.key === key);
  return found?.name ?? found?.label ?? key;
}

/** A rule in a sentence, which is what somebody scans the list for. */
export function ruleSentence(t: Transition, ctx: RuleContext): string {
  const trigger = t.trigger as Record<string, string | number>;
  const when =
    trigger.on === 'approval_decided'
      ? `${label(ctx.approvals, String(trigger.approval))} is ${trigger.decision}`
      : trigger.on === 'task_completed'
        ? `${label(ctx.tasks, String(trigger.task))} is finished`
        : trigger.on === 'timer'
          ? `${trigger.afterHoursInState} hours pass`
          : trigger.on === 'manual'
            ? 'somebody presses a button'
            : trigger.on === 'inbound_webhook'
              ? `${trigger.event} arrives`
              : trigger.on === 'record_updated'
                ? 'the record is edited'
                : 'the form is submitted';

  return `When ${when}, move to ${label(ctx.states, t.to)}`;
}

export function RulesEditor({
  transitions,
  ctx,
  diagnostics,
  draftId,
  onChange,
  onAdd,
  onAppend,
  onRemove,
}: {
  transitions: Transition[];
  ctx: RuleContext;
  diagnostics: Diagnostic[];
  /** Absent until a draft is open; the assistant needs one to read from. */
  draftId?: string;
  onChange: (index: number, next: Transition) => void;
  onAdd: () => void;
  onAppend: (rule: Transition) => void;
  onRemove: (index: number) => void;
}) {
  /*
   * States with more than one timer leaving them.
   *
   * Not a compiler rule, because it is not a property of the blueprint — it
   * is how the runtime schedules. Entering a state cancels that occupancy's
   * timers and schedules the new ones, so the shortest timer restarts every
   * other one and they never arrive. Surfaced here because this is where
   * somebody adds the second.
   */
  const timerClashes = useMemo(() => {
    const byState = new Map<string, number>();
    for (const t of transitions) {
      if ((t.trigger as { on: string }).on !== 'timer') continue;
      byState.set(t.from, (byState.get(t.from) ?? 0) + 1);
    }
    return new Set([...byState.entries()].filter(([, n]) => n > 1).map(([s]) => s));
  }, [transitions]);

  const byState = useMemo(() => {
    const groups = new Map<string, { index: number; transition: Transition }[]>();
    transitions.forEach((transition, index) => {
      groups.set(transition.from, [...(groups.get(transition.from) ?? []), { index, transition }]);
    });
    // In the order a record meets the states, not the order the rules happen
    // to be stored in.
    return ctx.states
      .filter((s) => groups.has(s.key))
      .map((s) => ({ state: s, rules: groups.get(s.key)! }));
  }, [transitions, ctx.states]);

  return (
    <div className="rl">
      <div className="rl__intro">
        <p>
          Everything the process does on its own. Each rule reads <strong>when</strong> something
          happens, <strong>if</strong> a condition holds, <strong>then</strong> these things run —
          and the record moves.
        </p>
        <button type="button" className="bd__btn" onClick={onAdd}>
          Add a rule
        </button>
      </div>

      {draftId && <Describe draftId={draftId} onAppend={onAppend} />}

      {byState.map(({ state, rules }) => (
        <section key={state.key} className="rl__group">
          <h3 className="rl__groupName">
            While the record is <strong>{state.name}</strong>
            {timerClashes.has(state.key) && (
              <span className="rl__clash" role="status">
                Two timers leave this state. Only the shortest will ever fire — entering a state
                restarts the others.
              </span>
            )}
          </h3>

          {rules.map(({ index, transition }) => (
            <Rule
              key={`${transition.key}-${index}`}
              transition={transition}
              ctx={ctx}
              diagnostics={diagnostics.filter((d) => d.at.includes(transition.key))}
              onChange={(next) => onChange(index, next)}
              onRemove={() => onRemove(index)}
            />
          ))}
        </section>
      ))}

      {!transitions.length && (
        <p className="rl__empty">
          Nothing happens on its own yet. A process with no rules is a form — add one, and the
          record starts moving by itself.
        </p>
      )}
    </div>
  );
}

/**
 * A sentence becomes a rule.
 *
 * The model proposes; a deterministic checker and the real compiler decide;
 * and nothing is added until somebody reads what it would do and presses a
 * button. The same boundary the copilot uses for actions, which is the only
 * reason a model is allowed near a published process at all.
 *
 * The reading is the point of the review step. "When 48 hours pass in With
 * hiring manager, move to With HR and send Manager reminder" is checkable by
 * somebody who has never seen the rule syntax — which is who this is for.
 */
function Describe({
  draftId,
  onAppend,
}: {
  draftId: string;
  onAppend: (rule: Transition) => void;
}) {
  const [sentence, setSentence] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<{
    ok: boolean;
    transition?: Transition;
    reading?: string;
    refused?: string;
    diagnostics?: Diagnostic[];
  } | null>(null);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sentence.trim()) return;
    setBusy(true);
    setProposal(null);
    try {
      const res = await fetch(`/api/builder/drafts/${draftId}/rule`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sentence }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setProposal({ ok: false, refused: body.reason ?? body.error ?? `HTTP ${res.status}` });
      } else {
        setProposal(body);
      }
    } catch (err) {
      setProposal({ ok: false, refused: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rl__assist">
      <form className="rl__assistForm" onSubmit={ask}>
        <label className="rl__assistLabel" htmlFor="describe-rule">
          Or describe what should happen
        </label>
        <div className="rl__assistRow">
          <input
            id="describe-rule"
            className="rl__assistInput"
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
            placeholder="Escalate to HR if the manager has not decided in two days"
          />
          <button type="submit" className="bd__btn bd__btn--primary" disabled={busy || !sentence.trim()}>
            {busy ? 'Thinking…' : 'Draft it'}
          </button>
        </div>
      </form>

      {proposal && (
        <div className={`rl__proposal${proposal.ok ? '' : ' rl__proposal--no'}`} role="status">
          {proposal.ok ? (
            <>
              <p className="rl__reading">{proposal.reading}</p>
              {/* Warnings travel with an accepted proposal: they are
                  judgements, and whoever accepts it should see them. */}
              {proposal.diagnostics?.some((d) => d.severity === 'warning') && (
                <ul className="rl__proposalWarnings">
                  {proposal.diagnostics
                    .filter((d) => d.severity === 'warning')
                    .slice(0, 3)
                    .map((d, i) => (
                      <li key={i}>
                        <strong>{d.code}</strong> {d.message}
                      </li>
                    ))}
                </ul>
              )}
              <div className="rl__proposalActions">
                <button
                  type="button"
                  className="bd__btn bd__btn--primary"
                  onClick={() => {
                    onAppend(proposal.transition!);
                    setProposal(null);
                    setSentence('');
                  }}
                >
                  Add this rule
                </button>
                <button type="button" className="bd__btn" onClick={() => setProposal(null)}>
                  Discard
                </button>
              </div>
            </>
          ) : (
            <p className="rl__refused">{proposal.refused}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Rule({
  transition,
  ctx,
  diagnostics,
  onChange,
  onRemove,
}: {
  transition: Transition;
  ctx: RuleContext;
  diagnostics: Diagnostic[];
  onChange: (next: Transition) => void;
  onRemove: () => void;
}) {
  const trigger = transition.trigger as Record<string, string | number>;
  const on = String(trigger.on);
  const errors = diagnostics.filter((d) => d.severity === 'error');

  const set = (patch: Partial<Transition>) => onChange({ ...transition, ...patch });
  const setTrigger = (next: Record<string, unknown>) => set({ trigger: next });

  return (
    <article className={`rl__rule${errors.length ? ' rl__rule--bad' : ''}`}>
      <header className="rl__head">
        <span className="rl__sentence">{ruleSentence(transition, ctx)}</span>
        <button type="button" className="rl__remove" onClick={onRemove} aria-label={`Remove ${transition.key}`}>
          Remove
        </button>
      </header>

      <div className="rl__row">
        <span className="rl__word">When</span>
        <label className="vw__srOnly" htmlFor={`trigger-${transition.key}`}>
          What starts this rule
        </label>
        <select
          id={`trigger-${transition.key}`}
          className="bd__input"
          value={on}
          onChange={(e) => {
            const next = e.target.value;
            // Each trigger carries different fields, and the schema is strict
            // — so switching starts from a valid shape rather than keeping
            // whatever the last one had.
            setTrigger(
              next === 'approval_decided'
                ? { on: next, approval: ctx.approvals[0]?.key ?? '', decision: 'approved' }
                : next === 'task_completed'
                  ? { on: next, task: ctx.tasks[0]?.key ?? '' }
                  : next === 'timer'
                    ? { on: next, afterHoursInState: 72 }
                    : next === 'inbound_webhook'
                      ? { on: next, event: 'something.happened' }
                      : next === 'manual'
                        ? { on: next, by: [ctx.roles[0]?.key ?? ''] }
                        : { on: next },
            );
          }}
        >
          {TRIGGERS.map((t) => (
            <option key={t.on} value={t.on}>
              {t.label}
            </option>
          ))}
        </select>

        {on === 'approval_decided' && (
          <>
            <select
              className="bd__input"
              aria-label="Which approval"
              value={String(trigger.approval ?? '')}
              onChange={(e) => setTrigger({ ...trigger, approval: e.target.value })}
            >
              {ctx.approvals.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name}
                </option>
              ))}
            </select>
            <select
              className="bd__input"
              aria-label="Which decision"
              value={String(trigger.decision ?? 'approved')}
              onChange={(e) => setTrigger({ ...trigger, decision: e.target.value })}
            >
              <option value="approved">is approved</option>
              <option value="rejected">is rejected</option>
              <option value="changes_requested">needs changes</option>
            </select>
          </>
        )}

        {on === 'task_completed' && (
          <select
            className="bd__input"
            aria-label="Which task"
            value={String(trigger.task ?? '')}
            onChange={(e) => setTrigger({ ...trigger, task: e.target.value })}
          >
            {ctx.tasks.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        )}

        {on === 'timer' && (
          <>
            <input
              className="bd__input rl__hours"
              type="number"
              min={1}
              aria-label="Hours in this state"
              value={Number(trigger.afterHoursInState ?? 72)}
              onChange={(e) =>
                setTrigger({ ...trigger, afterHoursInState: Math.max(1, Number(e.target.value)) })
              }
            />
            <span className="rl__word">hours after arriving here</span>
          </>
        )}

        {on === 'inbound_webhook' && (
          <input
            className="bd__input"
            aria-label="Event name"
            value={String(trigger.event ?? '')}
            onChange={(e) => setTrigger({ ...trigger, event: e.target.value })}
          />
        )}
      </div>

      <Condition
        when={transition.when}
        ctx={ctx}
        onChange={(next) => set({ when: next })}
      />

      <div className="rl__row">
        <span className="rl__word">Then move to</span>
        <label className="vw__srOnly" htmlFor={`to-${transition.key}`}>
          Which state it moves to
        </label>
        <select
          id={`to-${transition.key}`}
          className="bd__input"
          value={transition.to}
          onChange={(e) => set({ to: e.target.value })}
        >
          {ctx.states.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <Actions
        actions={transition.actions}
        ctx={ctx}
        onChange={(next) => set({ actions: next })}
      />

      {diagnostics.length > 0 && (
        <ul className="rl__diagnostics">
          {diagnostics.map((d, i) => (
            <li key={i} className={d.severity === 'error' ? 'rl__error' : 'rl__warning'}>
              <strong>{d.code}</strong> {d.message}
              {d.fix && <span className="rl__fix"> {d.fix}</span>}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/**
 * The condition.
 *
 * One comparison, or none. The expression language nests — and/or/not over
 * further expressions — and an editor that exposed the whole tree would be a
 * worse JSON tab. A rule that needs more than one comparison is a rule that
 * wants splitting into two, which is also easier to read on the record.
 */
function Condition({
  when,
  ctx,
  onChange,
}: {
  when?: Expr;
  ctx: RuleContext;
  onChange: (next?: Expr) => void;
}) {
  const op = when ? String(when.op ?? '') : '';
  const left = when?.left as { field?: string } | undefined;
  const right = when?.right as { literal?: unknown } | undefined;
  const fieldKey = left?.field ?? '';
  const field = ctx.fields.find((f) => f.key === fieldKey);
  const nested = when && ['and', 'or', 'not', 'in', 'not_in', 'contains'].includes(op);

  if (nested) {
    // Something the JSON tab wrote that this editor would flatten. Shown
    // rather than silently replaced.
    return (
      <div className="rl__row rl__row--condition">
        <span className="rl__word">If</span>
        <span className="rl__complex">
          a condition this editor cannot show — edit it on the JSON tab, or clear it
        </span>
        <button type="button" className="bd__btn" onClick={() => onChange(undefined)}>
          Clear
        </button>
      </div>
    );
  }

  return (
    <div className="rl__row rl__row--condition">
      <span className="rl__word">If</span>
      <select
        className="bd__input"
        aria-label="Which answer the condition looks at"
        value={fieldKey}
        onChange={(e) =>
          onChange(
            e.target.value
              ? { op: op || 'eq', left: { field: e.target.value }, right: { literal: '' } }
              : undefined,
          )
        }
      >
        <option value="">always — no condition</option>
        {ctx.fields.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </select>

      {fieldKey && (
        <>
          <select
            className="bd__input"
            aria-label="How to compare"
            value={op}
            onChange={(e) => {
              const next = e.target.value;
              onChange(
                next === 'is_present' || next === 'is_empty'
                  ? { op: next, left: { field: fieldKey } }
                  : { op: next, left: { field: fieldKey }, right: right ?? { literal: '' } },
              );
            }}
          >
            {COMPARISONS.filter(
              // Comparing a name against "more than" is a type error the
              // compiler would reject, so it is not offered.
              (c) => !NUMERIC.has(c.op) || !field || NUMERIC_FIELDS.has(field.type),
            ).map((c) => (
              <option key={c.op} value={c.op}>
                {c.label}
              </option>
            ))}
          </select>

          {op !== 'is_present' && op !== 'is_empty' && (
            <input
              className="bd__input"
              aria-label="Compared with"
              value={String(right?.literal ?? '')}
              onChange={(e) => {
                const raw = e.target.value;
                const asNumber = Number(raw);
                onChange({
                  op,
                  left: { field: fieldKey },
                  // A number typed into a numeric comparison is a number. The
                  // compiler refuses `"1000"` against a currency field, and
                  // quoting it here would be a type error nobody typed.
                  right: { literal: raw !== '' && !Number.isNaN(asNumber) ? asNumber : raw },
                });
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function Actions({
  actions,
  ctx,
  onChange,
}: {
  actions: Record<string, unknown>[];
  ctx: RuleContext;
  onChange: (next: Record<string, unknown>[]) => void;
}) {
  const setAt = (i: number, next: Record<string, unknown>) =>
    onChange(actions.map((a, j) => (i === j ? next : a)));

  /** A key nothing else in this rule uses. They become idempotency keys. */
  const freeKey = (base: string) => {
    const used = new Set(actions.map((a) => String(a.key)));
    let n = 1;
    let key = base;
    while (used.has(key)) key = `${base}_${++n}`;
    return key;
  };

  return (
    <div className="rl__actions">
      <span className="rl__word">and</span>
      <div className="rl__actionList">
        {actions.map((action, i) => {
          const kind = String(action.do);
          return (
            <div className="rl__action" key={i}>
              <select
                className="bd__input"
                aria-label="What to do"
                value={kind}
                onChange={(e) => {
                  const next = e.target.value;
                  const key = String(action.key);
                  setAt(
                    i,
                    next === 'send_email'
                      ? { do: next, key, template: ctx.templates[0]?.key ?? '' }
                      : next === 'request_approval'
                        ? { do: next, key, approval: ctx.approvals[0]?.key ?? '' }
                        : next === 'create_task'
                          ? { do: next, key, task: ctx.tasks[0]?.key ?? '' }
                          : next === 'generate_document'
                            ? { do: next, key, document: ctx.documents[0]?.key ?? '' }
                            : next === 'call_webhook'
                              ? { do: next, key, event: 'something.happened', includeFields: [] }
                              : next === 'assign'
                                ? { do: next, key, to: { role: ctx.roles[0]?.key ?? '' } }
                                : { do: next, key, hours: 24 },
                  );
                }}
              >
                {ACTIONS.map((a) => (
                  <option key={a.do} value={a.do}>
                    {a.label}
                  </option>
                ))}
              </select>

              {kind === 'send_email' && (
                <select
                  className="bd__input"
                  aria-label="Which message"
                  value={String(action.template ?? '')}
                  onChange={(e) => setAt(i, { ...action, template: e.target.value })}
                >
                  {ctx.templates.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}

              {kind === 'request_approval' && (
                <select
                  className="bd__input"
                  aria-label="Which approval"
                  value={String(action.approval ?? '')}
                  onChange={(e) => setAt(i, { ...action, approval: e.target.value })}
                >
                  {ctx.approvals.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.name}
                    </option>
                  ))}
                </select>
              )}

              {kind === 'create_task' && (
                <select
                  className="bd__input"
                  aria-label="Which task"
                  value={String(action.task ?? '')}
                  onChange={(e) => setAt(i, { ...action, task: e.target.value })}
                >
                  {ctx.tasks.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}

              {kind === 'generate_document' && (
                <select
                  className="bd__input"
                  aria-label="Which document"
                  value={String(action.document ?? '')}
                  onChange={(e) => setAt(i, { ...action, document: e.target.value })}
                >
                  {ctx.documents.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.name}
                    </option>
                  ))}
                </select>
              )}

              {kind === 'call_webhook' && (
                <input
                  className="bd__input"
                  aria-label="Event name"
                  value={String(action.event ?? '')}
                  onChange={(e) => setAt(i, { ...action, event: e.target.value })}
                />
              )}

              {kind === 'assign' && (
                <select
                  className="bd__input"
                  aria-label="Assign to"
                  value={String((action.to as { role?: string })?.role ?? '')}
                  onChange={(e) => setAt(i, { ...action, to: { role: e.target.value } })}
                >
                  {ctx.roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </select>
              )}

              {kind === 'wait' && (
                <input
                  className="bd__input rl__hours"
                  type="number"
                  min={1}
                  aria-label="Hours to wait"
                  value={Number(action.hours ?? 24)}
                  onChange={(e) => setAt(i, { ...action, hours: Math.max(1, Number(e.target.value)) })}
                />
              )}

              <button
                type="button"
                className="rl__remove"
                onClick={() => onChange(actions.filter((_, j) => j !== i))}
                aria-label="Remove this action"
              >
                Remove
              </button>
            </div>
          );
        })}

        <button
          type="button"
          className="bd__btn"
          onClick={() =>
            onChange([
              ...actions,
              { do: 'send_email', key: freeKey('notify'), template: ctx.templates[0]?.key ?? '' },
            ])
          }
        >
          Add something to do
        </button>
      </div>
    </div>
  );
}
