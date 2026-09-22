import { z } from 'zod';
import { Expr, Key } from './common.js';

export const State = z
  .object({
    key: Key,
    name: z.string().min(1),
    type: z.enum(['initial', 'active', 'waiting', 'terminal']),
    /**
     * Terminal states must say what kind of ending they are. Completion rate
     * and cycle time (section 13.1) are otherwise not computable.
     */
    outcome: z.enum(['success', 'rejected', 'cancelled', 'expired']).optional(),
    /** Hours after entry at which the record is considered late. */
    slaHours: z.number().positive().optional(),
    /** Shown to the respondent on the status page, if one is enabled. */
    publicLabel: z.string().optional(),
  })
  .strict();
export type State = z.infer<typeof State>;

/** Who a task, approval, or message is aimed at. Resolved at runtime, checked at compile time. */
export const Party = z.union([
  z.object({ role: Key }).strict(),
  /** An email address supplied by the respondent, e.g. their manager. */
  z.object({ field: Key }).strict(),
  z.object({ user: z.string().email() }).strict(),
  z.object({ assignee: z.literal('current') }).strict(),
  z.object({ submitter: z.literal(true) }).strict(),
]);
export type Party = z.infer<typeof Party>;

export const Approval = z
  .object({
    key: Key,
    name: z.string().min(1),
    approvers: z.array(Party).min(1),
    /** `sequential` runs approvers in the order listed (section 6.5). */
    mode: z.enum(['single', 'sequential', 'any_of']),
    /** Section 6.5: approve, reject, request changes. */
    allowRequestChanges: z.boolean().default(true),
    reasonRequired: z.boolean().default(false),
    /**
     * Separation of duties: the person who submitted the record may not decide
     * this approval, however they are addressed.
     *
     * Declared on the approval rather than on the party, which is where the
     * first sketch of this put it. How an approver is *addressed* — a role, a
     * field the respondent typed, a named user — is a different question from
     * whether the submitter may be one. Put it on the party and an approval
     * addressed two ways needs the flag twice and can carry it once.
     *
     * The most likely fraud in an expense process is a claimant typing their
     * own address into "your manager's email", and nothing in this schema
     * could describe the control that stops it.
     */
    notTheSubmitter: z.boolean().default(false),
    /** Fields the approver needs to decide; drives the approval queue summary. */
    contextFields: z.array(Key).optional(),
    dueInHours: z.number().positive().optional(),
  })
  .strict();
export type Approval = z.infer<typeof Approval>;

export const Task = z
  .object({
    key: Key,
    name: z.string().min(1),
    description: z.string().optional(),
    assignee: Party,
    dueInHours: z.number().positive().optional(),
    /** A task that blocks progress keeps the record out of its next state. */
    blocking: z.boolean().default(true),
    /**
     * Who may mark it done.
     *
     * `assignee` (the default) means the person it is assigned to: literally
     * them when it is addressed to an email, or anyone holding the role when
     * it is addressed to a role — which is the ordinary case and not as tight
     * as it sounds. `any_operator` opens it to anyone who may operate the
     * process, for shared queues where whoever is free picks the next thing up.
     */
    completableBy: z.enum(['assignee', 'any_operator']).default('assignee'),
  })
  .strict();
export type Task = z.infer<typeof Task>;

/**
 * Every action carries an `key` so the runtime can build a stable idempotency
 * key from (instance, transition, action) and satisfy section 6.5: no duplicate
 * emails, documents, webhooks, or charges.
 */
export const Action = z.discriminatedUnion('do', [
  z.object({ do: z.literal('set_state'), key: Key, state: Key }).strict(),
  z.object({ do: z.literal('assign'), key: Key, to: Party }).strict(),
  z.object({ do: z.literal('create_task'), key: Key, task: Key }).strict(),
  z.object({ do: z.literal('request_approval'), key: Key, approval: Key }).strict(),
  z.object({ do: z.literal('send_email'), key: Key, template: Key }).strict(),
  z.object({ do: z.literal('generate_document'), key: Key, document: Key }).strict(),
  z
    .object({
      do: z.literal('call_webhook'),
      key: Key,
      event: z.string().min(1),
      /** Section 11.2: sensitive payload fields are opt-in. */
      includeFields: z.array(Key).default([]),
    })
    .strict(),
  z.object({ do: z.literal('wait'), key: Key, hours: z.number().positive() }).strict(),
]);
export type Action = z.infer<typeof Action>;

export const Trigger = z.discriminatedUnion('on', [
  z.object({ on: z.literal('submission') }).strict(),
  z.object({ on: z.literal('record_updated') }).strict(),
  z.object({ on: z.literal('approval_decided'), approval: Key, decision: z.enum(['approved', 'rejected', 'changes_requested']) }).strict(),
  z.object({ on: z.literal('task_completed'), task: Key }).strict(),
  /*
   * A join: fires when the last of several tasks is done.
   *
   * Without it, work that genuinely happens in parallel has to be modelled as
   * a chain — finishing equipment creates the accounts task — which is slower
   * than the real process, breaks if the two are done in the other order, and
   * is a lie about what the organisation does.
   *
   * The set is named rather than inferred from "all blocking tasks in this
   * state". An inferred set is whatever `create_task` actions happened to run,
   * so a task created under a condition that did not hold would either hang
   * the record forever or be skipped silently, depending on data. Naming them
   * makes the blueprint say what it means and lets the compiler check it —
   * including the thing naming them costs you, which is forgetting to add the
   * fifth task to the set (BLOCK003).
   *
   * Two or more. A set of one is a `task_completed` and should say so.
   */
  z.object({ on: z.literal('tasks_completed'), tasks: z.array(Key).min(2) }).strict(),
  /*
   * A deadline, measured one of two ways.
   *
   * `afterHoursInState` hangs off the moment the record arrived, which is
   * right for a reminder — chase the approver three days after it reached
   * them — and wrong for anything the outside world dates. "Chase the
   * equipment three days before the start date" was inexpressible: the only
   * clock was when HR happened to approve, so a hire approved in March and
   * one approved the day before they start got the same reminder schedule.
   *
   * `relativeTo` names a date field and `offsetHours` moves off it, negative
   * for before. The runtime consequence is the interesting part and is
   * handled in the engine: the date can change after the timer is scheduled,
   * so editing it reschedules.
   *
   * Exactly one of the two forms, checked by the compiler rather than here —
   * a discriminated union cannot carry a refinement, and the compiler is
   * where this codebase says that sort of thing anyway.
   */
  z
    .object({
      on: z.literal('timer'),
      /** Hours after the record entered the `from` state. */
      afterHoursInState: z.number().positive().optional(),
      /** A date field the deadline hangs off instead of the state entry. */
      relativeTo: Key.optional(),
      /** Hours from that date. Negative is before it. */
      offsetHours: z.number().optional(),
    })
    .strict(),
  z.object({ on: z.literal('inbound_webhook'), event: z.string().min(1) }).strict(),
  z.object({ on: z.literal('manual'), by: z.array(Key).min(1) }).strict(),
]);
export type Trigger = z.infer<typeof Trigger>;

export const Transition = z
  .object({
    key: Key,
    from: Key,
    to: Key,
    trigger: Trigger,
    when: Expr.optional(),
    actions: z.array(Action).default([]),
  })
  .strict();
export type Transition = z.infer<typeof Transition>;

export const Workflow = z
  .object({
    states: z.array(State).min(2),
    transitions: z.array(Transition).min(1),
    approvals: z.array(Approval).default([]),
    tasks: z.array(Task).default([]),
    /** Section 6.5: tenant timezone for timers, stored canonically in UTC. */
    timezone: z.string().default('UTC'),
  })
  .strict();
export type Workflow = z.infer<typeof Workflow>;
