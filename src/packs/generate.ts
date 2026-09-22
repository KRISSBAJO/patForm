/**
 * A pack catalogue, generated rather than hand-written.
 *
 * Fifty processes hand-authored would be fifty chances to get the compiler's
 * fifty rules wrong, and fifty places to fix anything the schema learns next.
 * So each pack is a short declaration of what makes it *different* — its
 * fields, who approves, how long it is kept — and the shape every business
 * process shares is generated around it.
 *
 * The shape is genuinely shared, which is the only reason this is honest:
 *
 *     submitted ─▶ in review ─▶ (second review) ─▶ done
 *          │            │                │
 *          │            └─▶ rejected ◀───┘
 *          └─▶ withdrawn                └─▶ expired (SLA)
 *
 * Everything the compiler insists on — a reachable terminal state, a way out
 * of every state, an SLA with something that fires when it passes, six kinds
 * of test scenario, a reason for every restricted field — is produced here
 * once, correctly, for all of them.
 *
 * What a generator cannot do is know somebody's process. These are starting
 * points that compile and run on day one, which is what a template is; the
 * builder is where they stop being generic.
 */

import type { Blueprint } from '../blueprint/index.js';
import { rulesFor, type CategoryRules } from './rules.js';

export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

export interface PackField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  classification?: Sensitivity;
  choices?: string[];
  /** Required by the compiler for anything restricted, and a good idea anyway. */
  reason?: string;
  help?: string;
}

export interface PackSpec {
  key: string;
  name: string;
  category: string;
  summary: string;
  audience: string;
  /** What "done" means, in the customer's words. */
  outcome: string;
  /** Who fills the form in. */
  respondents: string;
  /** The person or team who owns the outcome. */
  ownerName: string;
  /** Who decides. One entry is a single approval; two is a chain. */
  approvals: { key: string; name: string; byRole: string; dueInHours?: number }[];
  /** Work somebody does after the decision, before it is finished. */
  task?: { key: string; name: string; byRole: string };
  fields: PackField[];
  /** Days after completion. Null keeps the record forever, and says so. */
  retentionDays: number | null;
  sensitivityCeiling?: Sensitivity;
  volume?: { count: number; per: 'day' | 'week' | 'month' | 'quarter' | 'year' };
}

const OPERATOR_ROLE = 'process_owner';

/**
 * Two fields every one of these needs.
 *
 * `submitter_name` and `submitter_email` are the identity pair — the compiler
 * wants fields that together identify a duplicate submission, and a name and
 * an address is the pair that exists in every process here. They are also how
 * an acknowledgement reaches anybody: a process that cannot write back to the
 * person who submitted is not a process, it is a form.
 */
function standardFields(spec: PackSpec): PackField[] {
  return [
    {
      key: 'submitter_name',
      label: 'Your name',
      type: 'short_text',
      required: true,
      classification: 'confidential',
    },
    {
      key: 'submitter_email',
      label: 'Your email',
      type: 'email',
      required: true,
      classification: 'confidential',
      help: 'We write here when anything changes.',
    },
    ...spec.fields,
    {
      key: 'decision_note',
      label: 'Decision note',
      type: 'long_text',
      required: false,
      classification: 'internal',
      // `setBy: operator` in the emitted field — somebody fills this in later,
      // so it must not appear on the respondent's form.
    },
  ];
}

/**
 * The field a threshold tier attaches to.
 *
 * The pack's money field — the first one it asks for in currency. A pack with
 * no money has no tier, which is correct: a request to change a budget code
 * is not made riskier by being large.
 */
function moneyField(spec: PackSpec): string | null {
  return spec.fields.find((f) => f.type === 'currency' && f.required !== false)?.key ?? null;
}

function roles(spec: PackSpec, rules: CategoryRules) {
  const approverRoles = [...new Set(spec.approvals.map((a) => a.byRole))];
  const taskRole = spec.task?.byRole;
  const restricted = spec.fields.filter((f) => f.classification === 'restricted').map((f) => f.key);

  const out = [
    {
      key: OPERATOR_ROLE,
      name: spec.ownerName,
      kind: 'internal' as 'internal' | 'respondent',
      capabilities: ['view', 'edit', 'operate', 'report', 'administer'],
      /*
       * What the owner may actually correct.
       *
       * `edit` with no `editableFields` grants nothing — an omission reads as
       * "may change nothing", which is the safe default and made the
       * capability decorative on all eighty-eight packs. The owner gets the
       * operator-set fields, which are the ones that exist to be filled in
       * after submission. `decision_note` is the only one the generator makes
       * — the note an operator writes on the record — and it is deliberately
       * not the restricted fields: an owner correcting somebody's bank
       * account is not a correction anybody asked for.
       */
      editableFields: ['decision_note'],
    },
    ...approverRoles.map((key) => ({
      key,
      name: titleOf(key),
      kind: 'internal' as 'internal' | 'respondent',
      // `approve` and nothing else that would let them edit what they are
      // judging. SEC009 refuses an approver who cannot approve; this refuses
      // an approver who could rewrite the answer first.
      capabilities: ['view', 'approve'],
    })),
  ];

  if (taskRole && !approverRoles.includes(taskRole) && taskRole !== OPERATOR_ROLE) {
    out.push({
      key: taskRole,
      name: titleOf(taskRole),
      kind: 'internal' as 'internal' | 'respondent',
      capabilities: ['view', 'operate'],
    });
  }

  /*
   * The escalation role.
   *
   * It exists because the category says somebody is told when nobody decides,
   * and it is the role restricted fields are hidden from: escalating is about
   * *that nothing has happened*, not about what the record says. Somebody
   * chasing a decision does not need to read a medical note to chase it.
   */
  if (
    rules.escalateTo !== OPERATOR_ROLE &&
    !approverRoles.includes(rules.escalateTo) &&
    rules.escalateTo !== taskRole
  ) {
    out.push({
      key: rules.escalateTo,
      name: titleOf(rules.escalateTo),
      kind: 'internal' as 'internal' | 'respondent',
      capabilities: ['view', 'approve'],
      ...(restricted.length ? { hiddenFields: restricted } : {}),
    });
  }

  const threshold = rules.threshold && moneyField(spec) ? rules.threshold : null;
  if (threshold && !out.some((r) => r.key === threshold.approval.byRole)) {
    out.push({
      key: threshold.approval.byRole,
      name: titleOf(threshold.approval.byRole),
      kind: 'internal' as 'internal' | 'respondent',
      capabilities: ['view', 'approve'],
    });
  }

  out.push({
    key: 'submitter',
    name: 'The person submitting',
    kind: 'respondent' as 'internal' | 'respondent',
    // A respondent never holds `operate` or `administer`; the compiler refuses
    // it, and it would be wrong anyway.
    capabilities: ['submit', 'view'],
  });

  return out;
}

function titleOf(key: string): string {
  return key
    .split('_')
    .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * The states.
 *
 * Every non-terminal state has **exactly one** outgoing timer, and that is not
 * a style choice. Entering a state cancels the timers of the previous
 * occupancy and schedules the new ones, so a self-loop reminder restarts the
 * clock on everything — including the transition meant to close the record.
 * The first version of this generator had a 72-hour reminder loop and a
 * 720-hour expiry on the same state, and the expiry could never fire.
 *
 * Escalation is therefore a state rather than a second timer: not decided in
 * time, so more people are told, which is what escalation means anyway.
 */
function states(spec: PackSpec, rules: CategoryRules) {
  const firstSla = Math.min(spec.approvals[0]!.dueInHours ?? rules.decideWithinHours, rules.decideWithinHours);
  const out: Record<string, unknown>[] = [
    { key: 'draft', name: 'Not yet submitted', type: 'initial' },
    {
      key: 'review_1',
      name: `With ${titleOf(spec.approvals[0]!.byRole).toLowerCase()}`,
      type: 'active',
      slaHours: firstSla,
      publicLabel: 'Being reviewed',
    },
    {
      key: 'escalated',
      name: `Escalated to ${titleOf(rules.escalateTo).toLowerCase()}`,
      type: 'active',
      slaHours: rules.escalationHours,
      publicLabel: 'Being reviewed',
    },
  ];

  if (spec.approvals[1]) {
    out.push({
      key: 'review_2',
      name: `With ${titleOf(spec.approvals[1].byRole).toLowerCase()}`,
      type: 'active',
      slaHours: spec.approvals[1].dueInHours ?? rules.decideWithinHours,
      publicLabel: 'Being reviewed',
    });
  }

  // Only where the pack actually asks for money.
  if (rules.threshold && moneyField(spec)) {
    out.push({
      key: 'review_threshold',
      name: `With ${titleOf(rules.threshold.approval.byRole).toLowerCase()}`,
      type: 'active',
      slaHours: rules.threshold.approval.dueInHours,
      publicLabel: 'Being reviewed',
    });
  }

  if (spec.task) {
    out.push({
      key: 'doing',
      name: spec.task.name,
      type: 'active',
      slaHours: 120,
      publicLabel: 'Being arranged',
    });
  }

  out.push(
    { key: 'done', name: 'Finished', type: 'terminal', outcome: 'success', publicLabel: 'Complete' },
    { key: 'rejected', name: 'Not approved', type: 'terminal', outcome: 'rejected', publicLabel: 'Not approved' },
    { key: 'withdrawn', name: 'Withdrawn', type: 'terminal', outcome: 'cancelled', publicLabel: 'Withdrawn' },
  );

  return out;
}

function approvals(spec: PackSpec, contextFields: string[], rules: CategoryRules) {
  const threshold = rules.threshold && moneyField(spec) ? rules.threshold : null;

  const declared = spec.approvals.map((a, i) => ({
    key: a.key,
    name: a.name,
    approvers: [{ role: a.byRole }],
    mode: 'single',
    allowRequestChanges: true,
    reasonRequired: true,
    /*
     * Nobody approves their own request. Every approval here is addressed to
     * an internal role, and a submitter who happens to hold that role could
     * otherwise decide their own — which is the ordinary shape of expense
     * fraud and is not special to expenses.
     */
    notTheSubmitter: true,
    contextFields: contextFields.slice(0, 6),
    dueInHours: Math.min(a.dueInHours ?? rules.decideWithinHours, i === 0 ? rules.decideWithinHours : 336),
  }));

  return threshold
    ? [
        ...declared,
        {
          key: threshold.approval.key,
          name: threshold.approval.name,
          approvers: [{ role: threshold.approval.byRole }],
          mode: 'single',
          notTheSubmitter: true,
          allowRequestChanges: true,
          reasonRequired: true,
          contextFields: contextFields.slice(0, 6),
          dueInHours: threshold.approval.dueInHours,
        },
      ]
    : declared;
}

/**
 * The transitions.
 *
 * Every rule the compiler enforces about the graph is satisfied structurally
 * rather than by review: one initial state, every state reachable, every
 * non-terminal state with a way out, nothing leaving a terminal state, and
 * every self-loop carrying a timer so it cannot fire forever.
 */
function transitions(spec: PackSpec, rules: CategoryRules) {
  const first = spec.approvals[0]!;
  const second = spec.approvals[1];
  const threshold = rules.threshold;
  const thresholdOn = threshold ? moneyField(spec) : null;
  const hasThresholdField = Boolean(thresholdOn);

  const firstSla = Math.min(first.dueInHours ?? rules.decideWithinHours, rules.decideWithinHours);
  const done = spec.task ? 'doing' : 'done';
  /** Where a final approval lands: the threshold tier if this pack has one. */
  const afterLast = hasThresholdField ? 'review_threshold' : done;

  const out: Record<string, unknown>[] = [
    {
      key: 'submit',
      from: 'draft',
      to: 'review_1',
      trigger: { on: 'submission' },
      actions: [
        { do: 'send_email', key: 'ack', template: 'acknowledgement' },
        { do: 'request_approval', key: 'ask_1', approval: first.key },
      ],
    },
    /*
     * The only timer out of review_1.
     *
     * Not a reminder loop: entering a state cancels the previous occupancy's
     * timers, so a self-loop restarts the clock on everything else leaving
     * that state. The first version of this generator had a 72-hour reminder
     * loop and a 720-hour expiry on the same state, and the expiry could
     * never fire — the loop reset it every time.
     *
     * Escalating IS the reminder: it tells the original approver and somebody
     * above them at the same moment, which is what escalation means.
     */
    {
      key: 'escalate_1',
      from: 'review_1',
      to: 'escalated',
      trigger: { on: 'timer', afterHoursInState: firstSla },
      actions: [
        { do: 'send_email', key: 'nudge', template: 'reminder' },
        { do: 'send_email', key: 'escalate', template: 'escalation' },
      ],
    },
    {
      key: 'rejected_1',
      from: 'review_1',
      to: 'rejected',
      trigger: { on: 'approval_decided', approval: first.key, decision: 'rejected' },
      actions: [{ do: 'send_email', key: 'say_no', template: 'rejected' }],
    },

    // ---- the escalation. Still decidable, and it closes itself if it is not.
    {
      key: 'escalated_approved',
      from: 'escalated',
      to: second ? 'review_2' : afterLast,
      trigger: { on: 'approval_decided', approval: first.key, decision: 'approved' },
      actions: second
        ? [{ do: 'request_approval', key: 'ask_2_late', approval: second.key }]
        : landing(afterLast, spec, 'late', threshold?.approval.key),
    },
    {
      key: 'escalated_rejected',
      from: 'escalated',
      to: 'rejected',
      trigger: { on: 'approval_decided', approval: first.key, decision: 'rejected' },
      actions: [{ do: 'send_email', key: 'say_no_late', template: 'rejected' }],
    },
    {
      key: 'give_up',
      from: 'escalated',
      to: 'withdrawn',
      trigger: { on: 'timer', afterHoursInState: rules.escalationHours },
      actions: [{ do: 'send_email', key: 'say_expired', template: 'expired' }],
    },
  ];

  if (second) {
    out.push(
      {
        key: 'approved_1',
        from: 'review_1',
        to: 'review_2',
        trigger: { on: 'approval_decided', approval: first.key, decision: 'approved' },
        actions: [{ do: 'request_approval', key: 'ask_2', approval: second.key }],
      },
      {
        key: 'approved_2',
        from: 'review_2',
        to: afterLast,
        trigger: { on: 'approval_decided', approval: second.key, decision: 'approved' },
        actions: landing(afterLast, spec, 'second', threshold?.approval.key),
      },
      {
        key: 'rejected_2',
        from: 'review_2',
        to: 'rejected',
        trigger: { on: 'approval_decided', approval: second.key, decision: 'rejected' },
        actions: [{ do: 'send_email', key: 'say_no_2', template: 'rejected' }],
      },
      {
        key: 'give_up_2',
        from: 'review_2',
        to: 'withdrawn',
        trigger: { on: 'timer', afterHoursInState: (second.dueInHours ?? rules.decideWithinHours) * 4 },
        actions: [{ do: 'send_email', key: 'say_expired_2', template: 'expired' }],
      },
    );
  } else {
    out.push({
      key: 'approved_1',
      from: 'review_1',
      to: afterLast,
      trigger: { on: 'approval_decided', approval: first.key, decision: 'approved' },
      actions: landing(afterLast, spec, 'first', threshold?.approval.key),
    });
  }

  /*
   * The category's threshold tier.
   *
   * Only where the pack actually holds the field the rule names. A rule
   * firing on a field that does not exist is a compile error; a rule that
   * silently did nothing would be worse, which is why the audit checks that
   * every pack carrying the field also carries the tier.
   */
  if (hasThresholdField && threshold) {
    out.push(
      {
        key: 'threshold_approved',
        from: 'review_threshold',
        to: done,
        trigger: { on: 'approval_decided', approval: threshold.approval.key, decision: 'approved' },
        actions: landing(done, spec, 'big'),
      },
      {
        key: 'threshold_rejected',
        from: 'review_threshold',
        to: 'rejected',
        trigger: { on: 'approval_decided', approval: threshold.approval.key, decision: 'rejected' },
        actions: [{ do: 'send_email', key: 'say_no_threshold', template: 'rejected' }],
      },
      {
        key: 'give_up_threshold',
        from: 'review_threshold',
        to: 'withdrawn',
        trigger: { on: 'timer', afterHoursInState: threshold.approval.dueInHours * 4 },
        actions: [{ do: 'send_email', key: 'say_expired_threshold', template: 'expired' }],
      },
    );
  }

  if (spec.task) {
    out.push(
      {
        key: 'finished',
        from: 'doing',
        to: 'done',
        // A blocking task must have a transition triggered by its completion,
        // or it is a control nothing waits for.
        trigger: { on: 'task_completed', task: spec.task.key },
        actions: [{ do: 'send_email', key: 'say_yes', template: 'approved' }],
      },
      {
        key: 'give_up_task',
        from: 'doing',
        to: 'withdrawn',
        trigger: { on: 'timer', afterHoursInState: 720 },
        actions: [{ do: 'send_email', key: 'say_expired_task', template: 'expired' }],
      },
    );
  }

  return out;
}

/**
 * What happens on arriving at the state after the last approval.
 *
 * Named per arrival rather than shared, because every action inside one
 * transition needs a distinct key — they become idempotency keys, and two the
 * same would collapse into one run.
 */
/*
 * Short answers next to each other.
 *
 * A date, a number and a yes/no each need a fraction of a line, and a column
 * of them reads as a longer form than it is. Runs of short answers are paired
 * off; anything that needs room keeps the full width, and a run with an odd
 * one left over leaves it full rather than stranding half a line.
 *
 * Only ever a pair, never three: a third of a line is a judgement about
 * particular content, and this does not know the content.
 */
const SHORT_TYPES = new Set(['date', 'time', 'number', 'currency', 'phone', 'yes_no', 'dropdown', 'rating']);

function widths(fields: { key: string; type: string }[]): { widths?: Record<string, 'half'> } {
  const out: Record<string, 'half'> = {};
  let run: string[] = [];

  const pairOff = () => {
    for (let i = 0; i + 1 < run.length; i += 2) {
      out[run[i]!] = 'half';
      out[run[i + 1]!] = 'half';
    }
    run = [];
  };

  for (const field of fields) {
    if (SHORT_TYPES.has(field.type)) run.push(field.key);
    else pairOff();
  }
  pairOff();

  return Object.keys(out).length ? { widths: out } : {};
}

function landing(to: string, spec: PackSpec, tag: string, thresholdApproval?: string) {
  if (to === 'doing') return [{ do: 'create_task', key: `do_work_${tag}`, task: spec.task!.key }];
  if (to === 'done') return [{ do: 'send_email', key: `say_yes_${tag}`, template: 'approved' }];
  // Landing on the threshold tier: the approval is requested on arrival.
  return [{ do: 'request_approval', key: `ask_threshold_${tag}`, approval: thresholdApproval! }];
}

function emails(spec: PackSpec, rules: CategoryRules) {
  const first = spec.approvals[0]!;
  return [
    {
      key: 'acknowledgement',
      name: 'Received',
      class: 'transactional',
      to: [{ submitter: true }],
      cc: [],
      subject: `We have your ${spec.name.toLowerCase()}`,
      body: `Hello {{submitter_name}},\n\nWe have what you sent and it is with ${titleOf(first.byRole).toLowerCase()} now. You will hear from us when there is a decision.\n\nYou do not need to do anything.`,
    },
    {
      key: 'reminder',
      name: 'Still waiting',
      class: 'transactional',
      to: [{ role: first.byRole }],
      cc: [],
      subject: `Still waiting on you: ${spec.name.toLowerCase()}`,
      /*
       * No name in the body, and SEC002 is the reason.
       *
       * This goes to a *role* rather than to the person it is about, so
       * naming them puts a confidential value in front of whoever currently
       * holds that role — which is not the same set of people the record's
       * permissions allow. The record says who, behind a check.
       */
      body: `Somebody is waiting on a decision.\n\nOpen the record in the console to approve or decline it — it shows you who and what.`,
    },
    {
      key: 'escalation',
      name: 'Nobody has decided',
      class: 'transactional',
      to: [{ role: rules.escalateTo }],
      cc: [],
      subject: `Not decided in time: ${spec.name.toLowerCase()}`,
      // No name and no detail: this goes to somebody who is being asked to
      // chase, not to read. The record says who and what, behind a check.
      body: `Something has been waiting on a decision for longer than this kind of work allows.

Open it in the console — it is still decidable, and it closes itself if nobody does.`,
    },
    {
      key: 'approved',
      name: 'Approved',
      class: 'transactional',
      to: [{ submitter: true }],
      cc: [],
      subject: 'Approved',
      body: `Hello {{submitter_name}},\n\nThis has been approved and is complete. Nothing further is needed from you.`,
    },
    {
      key: 'rejected',
      name: 'Not approved',
      class: 'transactional',
      to: [{ submitter: true }],
      cc: [],
      subject: 'Not approved',
      body: `Hello {{submitter_name}},\n\nThis was not approved. If you think that is wrong, reply to this message and somebody will look again.`,
    },
    {
      key: 'expired',
      name: 'Closed without a decision',
      class: 'transactional',
      to: [{ submitter: true }],
      cc: [],
      subject: 'Closed without a decision',
      body: `Hello {{submitter_name}},\n\nThis was closed because nobody decided it in time. That is our failing rather than yours — send it again, or reply and we will look into it.`,
    },
  ];
}

/**
 * The six scenario kinds the compiler requires.
 *
 * Generated from the spec rather than written, so a pack cannot ship with the
 * happy path only — which is the state most templates are in, and the reason
 * most of them break the first time something goes wrong.
 */
function tests(spec: PackSpec, answers: Record<string, unknown>, rules: CategoryRules) {
  const first = spec.approvals[0]!;
  const second = spec.approvals[1];
  const lastApproval = second ?? first;
  const endState = spec.task ? 'doing' : 'done';

  const approveAll = [
    { step: 'submit', answers },
    { step: 'decide', approval: first.key, as: first.byRole, decision: 'approved' },
    ...(second ? [{ step: 'decide', approval: second.key, as: second.byRole, decision: 'approved' }] : []),
  ];

  const required = spec.fields.find((f) => f.required)?.key;
  const missing = { ...answers };
  if (required) delete (missing as Record<string, unknown>)[required];
  delete (missing as Record<string, unknown>).submitter_email;

  return [
    {
      key: 'happy_path',
      kind: 'happy_path',
      name: 'An ordinary one is approved and finishes',
      steps: approveAll,
      expect: { state: endState, instanceCount: 1 },
    },
    {
      key: 'rejection',
      kind: 'rejection',
      name: 'A declined one stops and the person is told why',
      steps: [
        { step: 'submit', answers },
        { step: 'decide', approval: first.key, as: first.byRole, decision: 'rejected', reason: 'Not eligible' },
      ],
      expect: { state: 'rejected', instanceCount: 1 },
    },
    {
      key: 'missing_data',
      kind: 'missing_data',
      name: 'An incomplete form never becomes a record',
      // An incomplete form never becomes an instance, so the whole assertion
      // is that nothing exists afterwards.
      steps: [{ step: 'submit', answers: missing }],
      expect: { instanceCount: 0 },
    },
    {
      key: 'timeout',
      kind: 'timeout',
      name: 'Nobody decides, so it escalates rather than sitting there',
      steps: [
        { step: 'submit', answers },
        { step: 'advance_hours', hours: Math.min(first.dueInHours ?? rules.decideWithinHours, rules.decideWithinHours) + 1 },
      ],
      // The escalation, not review_1: the whole point of the category rule is
      // that an undecided record moves rather than waits.
      expect: { state: 'escalated', instanceCount: 1 },
    },
    {
      key: 'duplicate',
      kind: 'duplicate',
      name: 'The same person sending the same thing twice makes one record',
      steps: [
        { step: 'submit', answers },
        { step: 'submit', answers },
      ],
      expect: { instanceCount: 1 },
    },
    {
      key: 'permission',
      kind: 'permission',
      name: 'Somebody submitting cannot approve their own',
      // Stated as its own scenario because it is the rule most likely to be
      // broken by an edit that looks like a convenience: only
      // `${titleOf(lastApproval.byRole)}` decides.
      steps: [
        { step: 'submit', answers },
        { step: 'attempt', as: 'submitter', action: 'approve', expectDenied: true },
      ],
      expect: { instanceCount: 1 },
    },
  ];
}

/** A plausible answer for each field, so the generated tests can run. */
function sampleAnswers(fields: PackField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.key === 'decision_note') continue;
    switch (f.type) {
      case 'email':
        out[f.key] = f.key === 'submitter_email' ? 'sam@example.com' : 'someone@example.com';
        break;
      case 'short_text':
        out[f.key] = f.key === 'submitter_name' ? 'Sam Trent' : 'Example';
        break;
      case 'long_text':
        out[f.key] = 'A short description of what is needed and why.';
        break;
      case 'number':
      case 'currency':
        out[f.key] = 120;
        break;
      case 'rating':
        out[f.key] = 4;
        break;
      case 'date':
        out[f.key] = '2026-11-02';
        break;
      case 'time':
        out[f.key] = '09:00';
        break;
      case 'yes_no':
        out[f.key] = true;
        break;
      case 'phone':
        out[f.key] = '+44 7700 900000';
        break;
      case 'url':
        out[f.key] = 'https://example.com';
        break;
      case 'single_choice':
      case 'dropdown':
        out[f.key] = f.choices?.[0] ?? 'one';
        break;
      case 'multi_choice':
        out[f.key] = [f.choices?.[0] ?? 'one'];
        break;
      default:
        out[f.key] = 'Example';
    }
  }
  return out;
}

export function buildBlueprint(spec: PackSpec): unknown {
  const rules = rulesFor(spec.category);
  const fields = standardFields(spec);
  const placed = fields.filter((f) => f.key !== 'decision_note');
  const contextFields = placed.map((f) => f.key);
  const answers = sampleAnswers(placed);

  const ceiling =
    spec.sensitivityCeiling ??
    (fields.some((f) => f.classification === 'restricted')
      ? 'restricted'
      : fields.some((f) => f.classification === 'confidential')
        ? 'confidential'
        : 'internal');

  return {
    schemaVersion: '0.1',
    key: spec.key,
    name: spec.name,
    description: spec.summary,
    intent: {
      outcome: spec.outcome,
      owner: OPERATOR_ROLE,
      respondents: spec.respondents,
      expectedVolume: spec.volume ?? { count: 40, per: 'month' },
      sensitivityCeiling: ceiling,
      completionState: 'done',
      /*
       * Omitted rather than null when a record is kept forever.
       *
       * The schema takes a number or nothing, and "nothing" is what the rest
       * of the system already reads as "kept indefinitely" — the data map
       * says so in words rather than leaving a blank. A baptism register is
       * the case this exists for.
       */
      /*
       * The category's floor, applied rather than checked.
       *
       * A statutory period is not a preference — a pack that declares less
       * than its category requires is raised to it, and the audit verifies
       * the result. `null` still means forever, which is longer than any
       * floor and so is left alone.
       */
      ...(spec.retentionDays === null
        ? {}
        : {
            retentionDays: Math.max(spec.retentionDays, rules.retentionFloorDays ?? 0),
          }),
      assumptions: [
        {
          statement: `${spec.category}: ${rules.says}`,
          affects: 'workflow',
        },
        {
          statement:
            'The people in the chain are roles, not names. Map them to your own in the builder before publishing.',
          affects: 'roles',
        },
        ...(rules.threshold && moneyField(spec)
          ? [{ statement: rules.threshold.because, affects: 'workflow' }]
          : []),
      ],
      openDecisions: [
        {
          question: 'Who exactly approves this where you work?',
          provisionally: `A role called "${titleOf(spec.approvals[0]!.byRole)}".`,
          importance: 'review',
        },
      ],
    },
    roles: roles(spec, rules),
    data: {
      identity: ['submitter_email', 'submitter_name'],
      // Named, not guessed. The runtime used to take the first email field,
      // which is right here by luck of declaration order and would stop being
      // right the day a pack asked for somebody else's address first.
      submitterField: 'submitter_email',
      fields: fields.map((f) => ({
        key: f.key,
        type: f.type,
        label: f.label,
        required: f.required ?? false,
        classification: f.classification ?? 'internal',
        ...(f.choices ? { choices: f.choices.map((c) => ({ value: c, label: titleOf(c) })) } : {}),
        ...(f.reason ? { collectionReason: f.reason } : {}),
        ...(f.help ? { help: f.help } : {}),
        ...(f.key === 'decision_note' ? { setBy: 'operator' } : {}),
      })),
    },
    experience: {
      showProgress: true,
      saveAndResume: true,
      locales: ['en-GB'],
      confirmation: {
        message: 'Thank you. We have what you sent and will be in touch.',
        showStatusLink: true,
      },
      pages: [
        {
          key: 'you',
          title: 'About you',
          sections: [
            {
              key: 'who',
              fields: ['submitter_name', 'submitter_email'],
              widths: { submitter_name: 'half', submitter_email: 'half' },
            },
          ],
        },
        {
          key: 'details',
          title: spec.name,
          sections: [{ key: 'what', fields: spec.fields.map((f) => f.key), ...widths(spec.fields) }],
        },
      ],
    },
    workflow: {
      timezone: 'Europe/London',
      states: states(spec, rules),
      approvals: approvals(spec, contextFields, rules),
      tasks: spec.task
        ? [
            {
              key: spec.task.key,
              name: spec.task.name,
              assignee: { role: spec.task.byRole },
              blocking: true,
              dueInHours: 120,
            },
          ]
        : [],
      transitions: transitions(spec, rules),
    },
    communications: {
      fromName: spec.ownerName,
      sms: [],
      email: emails(spec, rules),
    },
    outputs: {
      webhookEvents: [`${spec.key}.approved`, `${spec.key}.rejected`],
      exportFields: contextFields.slice(0, 8),
      documents: [],
      dashboard: {
        // What this kind of work is worth watching for, from the category.
        metrics: rules.monitors,
      },
    },
    tests: tests(spec, answers, rules),
  };
}
