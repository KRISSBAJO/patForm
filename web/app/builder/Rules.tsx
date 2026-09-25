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
import { ChoiceMenu } from './ChoiceMenu';
import './rules.css';
import { FlowMap } from './FlowMap';

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
  /** Top-level questions; a repeating group carries its own row questions. */
  fields: RuleField[];
  roles: { key: string; name: string }[];
}

export interface RuleField {
  key: string;
  label: string;
  type: string;
  fields?: { key: string; label: string; type: string }[];
}

const TRIGGERS = [
  { on: 'submission', label: 'the form is submitted' },
  { on: 'record_updated', label: 'somebody edits the record' },
  { on: 'approval_decided', label: 'a decision is made' },
  { on: 'task_completed', label: 'a task is finished' },
  { on: 'tasks_completed', label: 'several tasks are all finished' },
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

/** The tasks a join waits for, in words. */
function joined(t: Transition, ctx: RuleContext): string {
  const keys = Array.isArray((t.trigger as { tasks?: unknown }).tasks)
    ? ((t.trigger as { tasks: string[] }).tasks)
    : [];
  const names = keys.map((k) => label(ctx.tasks, k));
  if (names.length <= 1) return names[0] ?? 'nothing';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Every question, row questions included, for looking up a label. */
function allFields(ctx: RuleContext): { key: string; label: string; type: string }[] {
  return ctx.fields.flatMap((f) => [f, ...(f.fields ?? [])]);
}

function comparisonWords(e: Expr, ctx: RuleContext): string | null {
  const op = String(e.op ?? '');
  const left = (e.left as { field?: string } | undefined)?.field;
  const c = COMPARISONS.find((x) => x.op === op);
  if (!left || !c) return null;
  const name = label(allFields(ctx), left);
  if (op === 'is_present' || op === 'is_empty') return `${name} ${c.label}`;
  const right = e.right as { literal?: unknown; field?: string } | undefined;
  const value = right?.field ? label(allFields(ctx), right.field) : String(right?.literal ?? '');
  return `${name} ${c.label} ${value}`;
}

/** A condition in words. Anything the editor cannot draw is "a condition". */
export function conditionWords(e: Expr | undefined, ctx: RuleContext): string | null {
  if (!e) return null;
  const op = String(e.op ?? '');
  if ((op === 'and' || op === 'or') && Array.isArray(e.operands)) {
    return (e.operands as Expr[]).map((x) => conditionWords(x, ctx)).join(` ${op} `);
  }
  if (op === 'any' || op === 'all') {
    const group = label(ctx.fields, String(e.over));
    const inner = comparisonWords(e.where as Expr, ctx) ?? 'a condition holds';
    return `${op === 'any' ? 'any' : 'every'} row of ${group} where ${inner}`;
  }
  return comparisonWords(e, ctx) ?? 'a condition holds';
}

/** A rule in a sentence, which is what somebody scans the list for. */
export function ruleSentence(t: Transition, ctx: RuleContext): string {
  const trigger = t.trigger as Record<string, string | number>;
  const when =
    trigger.on === 'approval_decided'
      ? `${label(ctx.approvals, String(trigger.approval))} is ${trigger.decision}`
      : trigger.on === 'task_completed'
        ? `${label(ctx.tasks, String(trigger.task))} is finished`
        : trigger.on === 'tasks_completed'
          ? `${joined(t, ctx)} are all finished`
        : trigger.on === 'timer'
          ? `${trigger.afterHoursInState} hours pass`
          : trigger.on === 'manual'
            ? 'somebody presses a button'
            : trigger.on === 'inbound_webhook'
              ? `${trigger.event} arrives`
              : trigger.on === 'record_updated'
                ? 'the record is edited'
                : 'the form is submitted';

  const condition = conditionWords(t.when, ctx);
  return `When ${when}${condition ? `, if ${condition}` : ''}, move to ${label(ctx.states, t.to)}`;
}

export function RulesEditor({
  selectedIndex,
  onSelectRule,
  onBack,
  transitions,
  ctx,
  diagnostics,
  draftId,
  onChange,
  onAdd,
  onAppend,
  onRemove,
}: {
  selectedIndex: number | null;
  onSelectRule: (index: number) => void;
  onBack: () => void;
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

  /** Clicking a state on the map narrows the list to its rules. */
  const [focus, setFocus] = useState<string | null>(null);

  const byState = useMemo(() => {
    const groups = new Map<string, { index: number; transition: Transition }[]>();
    transitions.forEach((transition, index) => {
      groups.set(transition.from, [...(groups.get(transition.from) ?? []), { index, transition }]);
    });
    // In the order a record meets the states, not the order the rules happen
    // to be stored in.
    return ctx.states
      .filter((s) => groups.has(s.key) && (!focus || s.key === focus))
      .map((s) => ({ state: s, rules: groups.get(s.key)! }));
  }, [transitions, ctx.states, focus]);

  const issuesFor = (index: number, transition: Transition) => diagnostics.filter((d) =>
    d.at.startsWith(`workflow.transitions[${index}]`) || d.at.includes(transition.key));

  if (selectedIndex !== null) {
    const transition = transitions[selectedIndex];
    if (!transition) return <div className="rl rl--detail"><button type="button" className="rl__back" onClick={onBack}>← Back to workflow</button><p>This rule is no longer in the process.</p></div>;
    return <div className="rl rl--detail">
      <button type="button" className="rl__back" onClick={onBack}>← Back to workflow</button>
      <div className="rl__detailIntro">
        <span>Automation {selectedIndex + 1} of {transitions.length}</span>
        <h2>Edit this rule</h2>
        <p>Choose what starts it, when it applies, and what happens next. Changes save to this draft.</p>
      </div>
      <Rule
        transition={transition}
        ctx={ctx}
        diagnostics={issuesFor(selectedIndex, transition)}
        onChange={(next) => onChange(selectedIndex, next)}
        onRemove={() => onRemove(selectedIndex)}
      />
    </div>;
  }

  return (
    <div className="rl rl--overview">
      <div className="rl__intro">
        <div><span className="rl__eyebrow">Workflow</span><h2>Automation</h2><p>Decide what moves each record forward. Select a rule to edit its trigger, condition and outcome.</p></div>
        <button type="button" className="bd__btn" onClick={onAdd}>
          + Add rule
        </button>
      </div>

      {focus && (
        <p className="rl__focus" role="status">
          Showing only what happens in{' '}
          <strong>{ctx.states.find((s) => s.key === focus)?.name ?? focus}</strong>.{' '}
          <button type="button" className="rl__focusClear" onClick={() => setFocus(null)}>
            Show every rule
          </button>
        </p>
      )}

      {/*
        * The picture, and a read-only one. A draggable canvas would be a
        * second source of truth for the same graph; here the rules are the
        * truth and this is a rendering, so it cannot disagree with them.
        */}
      <FlowMap
        states={ctx.states}
        edges={transitions.map((t) => ({
          key: t.key,
          from: t.from,
          to: t.to,
          kind: String((t.trigger as { on?: string }).on ?? ''),
        }))}
        selected={focus ?? undefined}
        onSelect={(key) => setFocus(key === focus ? null : key)}
      />

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

          <div className="rl__ruleList">{rules.map(({ index, transition }) => (
            <button type="button" className="rl__ruleSummary" key={`${transition.key}-${index}`} onClick={() => onSelectRule(index)}>
              <span className="rl__ruleOrdinal">{String(index + 1).padStart(2, '0')}</span>
              <span className="rl__ruleSummaryText"><strong>{ruleSentence(transition, ctx)}</strong><small>{transition.actions.length ? `${transition.actions.length} additional ${transition.actions.length === 1 ? 'action' : 'actions'}` : 'Moves the record only'}</small></span>
              {issuesFor(index, transition).some((d) => d.severity === 'error') && <span className="rl__ruleIssue">Needs attention</span>}
              <span className="rl__ruleArrow" aria-hidden="true">→</span>
            </button>
          ))}</div>
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
  const changeTrigger = (next: string) => setTrigger(
    next === 'approval_decided'
      ? { on: next, approval: ctx.approvals[0]?.key ?? '', decision: 'approved' }
      : next === 'task_completed'
        ? { on: next, task: ctx.tasks[0]?.key ?? '' }
        : next === 'tasks_completed'
          ? { on: next, tasks: ctx.tasks.slice(0, 2).map((x) => x.key) }
          : next === 'timer'
            ? { on: next, afterHoursInState: 72 }
            : next === 'inbound_webhook'
              ? { on: next, event: 'something.happened' }
              : next === 'manual'
                ? { on: next, by: [ctx.roles[0]?.key ?? ''] }
                : { on: next },
  );

  return (
    <article className={`rl__rule${errors.length ? ' rl__rule--bad' : ''}`}>
      <header className="rl__head">
        <div><span className="rl__eyebrow">Current behavior</span><p className="rl__sentence">{ruleSentence(transition, ctx)}</p></div>
        <button type="button" className="rl__remove" onClick={onRemove} aria-label={`Remove ${transition.key}`}>
          Delete rule
        </button>
      </header>

      <section className="rl__stage">
        <div className="rl__stageHead"><span>01</span><div><h3>What starts this rule?</h3><p>Select the event the process waits for.</p></div></div>
      <div className="rl__row">
        <ChoiceMenu label="Event that starts this rule" value={on} groups={[{ label: 'Events', options: TRIGGERS.map((t) => ({ value: t.on, label: t.label })) }]} onChange={changeTrigger} />

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

        {/*
          * A join, as a set of checkboxes.
          *
          * A multi-select would be shorter and worse: the whole question here
          * is "which of these am I waiting for", and a list you can see all of
          * at once answers it. The compiler will refuse a join that leaves out
          * a blocking task created in the same state (BLOCK003), so getting
          * this wrong is a diagnostic rather than a record that completes with
          * work still open.
          */}
        {on === 'tasks_completed' && (
          <fieldset className="rl__set">
            <legend className="rl__setLegend">Wait for all of these</legend>
            {ctx.tasks.length < 2 ? (
              <p className="rl__setNote">
                A join needs at least two tasks. Add another task before using this.
              </p>
            ) : (
              ctx.tasks.map((task) => {
                const chosen = Array.isArray(trigger.tasks) ? (trigger.tasks as string[]) : [];
                const on_ = chosen.includes(task.key);
                return (
                  <label className="rl__setItem" key={task.key}>
                    <input
                      type="checkbox"
                      checked={on_}
                      onChange={() =>
                        setTrigger({
                          ...trigger,
                          tasks: on_ ? chosen.filter((k) => k !== task.key) : [...chosen, task.key],
                        })
                      }
                    />
                    <span>{task.name}</span>
                  </label>
                );
              })
            )}
          </fieldset>
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
      </section>

      <section className="rl__stage">
        <div className="rl__stageHead"><span>02</span><div><h3>When should it apply?</h3><p>Leave this as “Always” unless only some records should follow this rule.</p></div></div>
      <Condition
        when={transition.when}
        ctx={ctx}
        onChange={(next) => set({ when: next })}
      />
      </section>

      <section className="rl__stage">
        <div className="rl__stageHead"><span>03</span><div><h3>Where does the record go?</h3><p>Choose its next status after the event.</p></div></div>
      <div className="rl__row">
        <ChoiceMenu label="Next status" value={transition.to} groups={[{ label: 'Statuses', options: ctx.states.map((s) => ({ value: s.key, label: s.name, detail: s.type })) }]} onChange={(to) => set({ to })} />
      </div>
      </section>

      <section className="rl__stage">
        <div className="rl__stageHead"><span>04</span><div><h3>What else should happen?</h3><p>Messages, approvals and tasks run when this rule fires. This step is optional.</p></div></div>
      <Actions
        actions={transition.actions}
        ctx={ctx}
        onChange={(next) => set({ actions: next })}
      />
      </section>

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
 * One comparison, or none — on an answer, or on the rows of a repeating
 * group: "any row of Items claimed where Amount is more than 200". The
 * expression language nests further (and/or/not), and an editor that exposed
 * the whole tree would be a worse JSON tab. A rule that needs more than one
 * comparison is a rule that wants splitting into two, which is also easier to
 * read on the record.
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
  const outerOp = when ? String(when.op ?? '') : '';
  const quantified = outerOp === 'any' || outerOp === 'all';
  const group = quantified ? ctx.fields.find((f) => f.key === when!.over) : undefined;
  const inner = (quantified ? (when!.where as Expr | undefined) : when) ?? undefined;

  const op = inner ? String(inner.op ?? '') : '';
  const left = inner?.left as { field?: string } | undefined;
  const right = inner?.right as { literal?: unknown } | undefined;
  const fieldKey = left?.field ?? '';
  const pool = quantified ? (group?.fields ?? []) : ctx.fields;
  const field = pool.find((f) => f.key === fieldKey);

  const drawable = (e?: Expr) =>
    !e || !['and', 'or', 'not', 'in', 'not_in', 'contains', 'any', 'all'].includes(String(e.op ?? ''));
  const nested = when && (quantified ? !group || !drawable(inner) : !drawable(when));

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

  const groups = ctx.fields.filter((f) => f.type === 'repeating_group' && f.fields?.length);
  const subject = quantified ? `${outerOp}:${group!.key}` : fieldKey ? `f:${fieldKey}` : '';

  /** Wraps a comparison in the quantifier the subject asks for. */
  const build = (subj: string, comparison: Expr | undefined): Expr | undefined => {
    if (!comparison) return undefined;
    const [kind, key] = subj.split(':');
    return kind === 'any' || kind === 'all' ? { op: kind, over: key, where: comparison } : comparison;
  };
  const comparison = (key: string, nextOp: string, value?: unknown): Expr =>
    nextOp === 'is_present' || nextOp === 'is_empty'
      ? { op: nextOp, left: { field: key } }
      : { op: nextOp, left: { field: key }, right: { literal: value ?? '' } };

  return (
    <div className="rl__row rl__row--condition">
      <ChoiceMenu
        label="Condition"
        value={subject}
        groups={[
          { label: 'Default', options: [{ value: '', label: 'Always — no condition' }] },
          { label: 'Form answers', options: ctx.fields.filter((f) => f.type !== 'repeating_group').map((f) => ({ value: `f:${f.key}`, label: f.label })) },
          { label: 'Repeating rows', options: groups.flatMap((g) => [{ value: `any:${g.key}`, label: `Any row of ${g.label}` }, { value: `all:${g.key}`, label: `Every row of ${g.label}` }]) },
        ]}
        onChange={(next) => {
          if (!next) return onChange(undefined);
          const [kind, key] = next.split(':');
          if (kind === 'f') return onChange(comparison(key!, op || 'eq', ''));
          // A group: start on its first row question, so the rule is whole.
          const first = ctx.fields.find((f) => f.key === key)?.fields?.[0];
          onChange(first ? build(next, comparison(first.key, 'eq', '')) : undefined);
        }}
      />

      {quantified && (
        <>
          <span className="rl__word">where</span>
          <select
            className="bd__input"
            aria-label={`Which question in each row of ${group!.label}`}
            value={fieldKey}
            onChange={(e) => onChange(build(subject, comparison(e.target.value, op || 'eq', right?.literal)))}
          >
            {(group!.fields ?? []).map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </>
      )}

      {fieldKey && (
        <>
          <ChoiceMenu
            label="Comparison"
            value={op}
            onChange={(next) => onChange(build(subject, comparison(fieldKey, next, right?.literal)))}
            groups={[{ label: 'Compare answer', options: COMPARISONS.filter(
              // Comparing a name against "more than" is a type error the
              // compiler would reject, so it is not offered.
              (c) => !NUMERIC.has(c.op) || !field || NUMERIC_FIELDS.has(field.type),
            ).map((c) => ({ value: c.op, label: c.label })) }]}
          />

          {op !== 'is_present' && op !== 'is_empty' && (
            <input
              className="bd__input"
              aria-label="Compared with"
              value={String(right?.literal ?? '')}
              onChange={(e) => {
                const raw = e.target.value;
                const asNumber = Number(raw);
                // A number typed into a numeric comparison is a number. The
                // compiler refuses `"1000"` against a currency field, and
                // quoting it here would be a type error nobody typed.
                onChange(
                  build(subject, comparison(fieldKey, op, raw !== '' && !Number.isNaN(asNumber) ? asNumber : raw)),
                );
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
              <ChoiceMenu
                label="Action"
                value={kind}
                groups={[{ label: 'Actions', options: ACTIONS.map((a) => ({ value: a.do, label: a.label })) }]}
                onChange={(next) => {
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
              />

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
