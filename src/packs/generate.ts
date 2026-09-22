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

function roles(spec: PackSpec) {
  const approverRoles = [...new Set(spec.approvals.map((a) => a.byRole))];
  const taskRole = spec.task?.byRole;

  const out = [
    {
      key: OPERATOR_ROLE,
      name: spec.ownerName,
      kind: 'internal' as 'internal' | 'respondent',
      capabilities: ['view', 'edit', 'operate', 'report', 'administer'],
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

/** The states, which depend only on how many approvals there are. */
function states(spec: PackSpec) {
  const out: Record<string, unknown>[] = [
    { key: 'draft', name: 'Not yet submitted', type: 'initial' },
    {
      key: 'review_1',
      name: `With ${titleOf(spec.approvals[0]!.byRole).toLowerCase()}`,
      type: 'active',
      slaHours: spec.approvals[0]!.dueInHours ?? 72,
      publicLabel: 'Being reviewed',
    },
  ];

  if (spec.approvals[1]) {
    out.push({
      key: 'review_2',
      name: `With ${titleOf(spec.approvals[1].byRole).toLowerCase()}`,
      type: 'active',
      slaHours: spec.approvals[1].dueInHours ?? 72,
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

function approvals(spec: PackSpec, contextFields: string[]) {
  return spec.approvals.map((a, i) => ({
    key: a.key,
    name: a.name,
    approvers: [{ role: a.byRole }],
    mode: 'single',
    allowRequestChanges: true,
    reasonRequired: true,
    contextFields: contextFields.slice(0, 6),
    dueInHours: a.dueInHours ?? (i === 0 ? 72 : 120),
  }));
}

/**
 * The transitions.
 *
 * Every rule the compiler enforces about the graph is satisfied structurally
 * rather than by review: one initial state, every state reachable, every
 * non-terminal state with a way out, nothing leaving a terminal state, and
 * every self-loop carrying a timer so it cannot fire forever.
 */
function transitions(spec: PackSpec) {
  const first = spec.approvals[0]!;
  const second = spec.approvals[1];
  const afterApprovals = spec.task ? 'doing' : 'done';

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
    // A self-loop with a timer: the SLA on review_1 has something that fires.
    {
      key: 'nudge_1',
      from: 'review_1',
      to: 'review_1',
      trigger: { on: 'timer', afterHoursInState: first.dueInHours ?? 72 },
      actions: [{ do: 'send_email', key: 'nudge_1', template: 'reminder' }],
    },
    {
      key: 'rejected_1',
      from: 'review_1',
      to: 'rejected',
      trigger: { on: 'approval_decided', approval: first.key, decision: 'rejected' },
      actions: [{ do: 'send_email', key: 'say_no', template: 'rejected' }],
    },
    // Nothing stalls forever: a review that is never decided expires.
    {
      key: 'give_up_1',
      from: 'review_1',
      to: 'withdrawn',
      trigger: { on: 'timer', afterHoursInState: (first.dueInHours ?? 72) * 10 },
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
        key: 'nudge_2',
        from: 'review_2',
        to: 'review_2',
        trigger: { on: 'timer', afterHoursInState: second.dueInHours ?? 120 },
        actions: [{ do: 'send_email', key: 'nudge_2', template: 'reminder' }],
      },
      {
        key: 'approved_2',
        from: 'review_2',
        to: afterApprovals,
        trigger: { on: 'approval_decided', approval: second.key, decision: 'approved' },
        actions: spec.task
          ? [{ do: 'create_task', key: 'do_work', task: spec.task.key }]
          : [{ do: 'send_email', key: 'say_yes', template: 'approved' }],
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
        trigger: { on: 'timer', afterHoursInState: (second.dueInHours ?? 120) * 10 },
        actions: [{ do: 'send_email', key: 'say_expired_2', template: 'expired' }],
      },
    );
  } else {
    out.push({
      key: 'approved_1',
      from: 'review_1',
      to: afterApprovals,
      trigger: { on: 'approval_decided', approval: first.key, decision: 'approved' },
      actions: spec.task
        ? [{ do: 'create_task', key: 'do_work', task: spec.task.key }]
        : [{ do: 'send_email', key: 'say_yes', template: 'approved' }],
    });
  }

  if (spec.task) {
    out.push(
      {
        key: 'nudge_task',
        from: 'doing',
        to: 'doing',
        trigger: { on: 'timer', afterHoursInState: 120 },
        actions: [{ do: 'send_email', key: 'nudge_task', template: 'reminder' }],
      },
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
        trigger: { on: 'timer', afterHoursInState: 1200 },
        actions: [{ do: 'send_email', key: 'say_expired_task', template: 'expired' }],
      },
    );
  }

  return out;
}

function emails(spec: PackSpec) {
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
      body: `{{submitter_name}} is waiting on a decision.\n\nOpen the record in the console to approve or decline it.`,
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
function tests(spec: PackSpec, answers: Record<string, unknown>) {
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
      name: 'Nobody decides, so it is chased and then closed',
      steps: [
        { step: 'submit', answers },
        { step: 'advance_hours', hours: (first.dueInHours ?? 72) + 1 },
      ],
      expect: { state: 'review_1', instanceCount: 1 },
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
      ...(spec.retentionDays === null ? {} : { retentionDays: spec.retentionDays }),
      assumptions: [
        {
          statement:
            'The approval chain is the one most organizations use for this. Yours may have more steps, or fewer.',
          affects: 'workflow',
        },
        {
          statement: 'Reminders go out after three days and the record closes itself after thirty.',
          affects: 'workflow',
        },
      ],
      openDecisions: [
        {
          question: 'Who exactly approves this where you work?',
          provisionally: `A role called "${titleOf(spec.approvals[0]!.byRole)}".`,
          importance: 'review',
        },
      ],
    },
    roles: roles(spec),
    data: {
      identity: ['submitter_email', 'submitter_name'],
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
          sections: [{ key: 'who', fields: ['submitter_name', 'submitter_email'] }],
        },
        {
          key: 'details',
          title: spec.name,
          sections: [{ key: 'what', fields: spec.fields.map((f) => f.key) }],
        },
      ],
    },
    workflow: {
      timezone: 'Europe/London',
      states: states(spec),
      approvals: approvals(spec, contextFields),
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
      transitions: transitions(spec),
    },
    communications: {
      fromName: spec.ownerName,
      sms: [],
      email: emails(spec),
    },
    outputs: {
      webhookEvents: [`${spec.key}.approved`, `${spec.key}.rejected`],
      exportFields: contextFields.slice(0, 8),
      documents: [],
      dashboard: {
        metrics: [
          { key: 'received', name: 'Received', kind: 'intake' },
          { key: 'cycle_time', name: 'Time from start to finish', kind: 'cycle_time' },
          { key: 'completion', name: 'Finished', kind: 'completion_rate' },
          { key: 'aging', name: 'Waiting the longest', kind: 'stage_aging' },
          { key: 'approval_time', name: 'Time waiting on a decision', kind: 'approval_time' },
        ],
      },
    },
    tests: tests(spec, answers),
  };
}
