import { z } from 'zod';
import { Key } from '../blueprint/common.js';

/**
 * The query plan: what the model is allowed to ask for.
 *
 * §7.1 puts the boundary in one line — "translate natural language into an
 * approved query plan", with a "permission-filtered query service; no raw
 * model database access". This file is that boundary, and it is the same one
 * the blueprint draws: the model proposes a typed structure, and a
 * deterministic service decides whether it may run and what it may touch.
 *
 * So there is no SQL here, no column names, no table names, no operators the
 * compiler does not know, and no free text that reaches the database. A plan
 * names things from the blueprint — states, fields, tasks, approvals — and the
 * compiler resolves every one of them or refuses the whole plan.
 *
 * The narrowness is the point. A model that can emit `WHERE` can emit
 * `WHERE tenant_id <> $1`. A model that can only emit `{ kind: 'overdue' }`
 * cannot, whatever it has been told to do by something it read in a form
 * field — and it *will* read things in form fields, because respondents type
 * whatever they like and those answers end up in the record it is asked about.
 */

// ------------------------------------------------------------------ filters

const Duration = z.object({ hours: z.number().positive().max(24 * 365) }).strict();

/**
 * A comparison against an answer.
 *
 * The operator set is deliberately the same shape as the blueprint's `Expr`,
 * and the compiler type-checks `value` against the field's value kind exactly
 * as `Expr` does — so "amount > 500" fails to compile when amount is text,
 * here as well as there. One rule, one place, two callers.
 */
export const AnswerFilter = z
  .object({
    kind: z.literal('answer'),
    field: Key,
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_empty', 'is_not_empty', 'in']),
    value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]).optional(),
  })
  .strict();

export const Filter = z.union([
  /** Records sitting in one of these states. */
  z.object({ kind: z.literal('state'), is: z.array(Key).min(1) }).strict(),

  /** Records in any state of this kind — "still open", "finished". */
  z.object({ kind: z.literal('state_type'), is: z.array(z.enum(['initial', 'active', 'waiting', 'terminal'])).min(1) }).strict(),

  /**
   * Past the SLA the blueprint declares for the state the record is in.
   *
   * This is the filter behind "which records are overdue", and it is derived
   * rather than stored: the deadline is `state_entered_at + slaHours` for
   * whichever state the record currently occupies. A state with no SLA is
   * never overdue, which is a statement about the process, not the query.
   */
  z.object({ kind: z.literal('overdue'), is: z.boolean() }).strict(),

  /** Longer than N hours in the current state, SLA or no SLA. */
  z.object({ kind: z.literal('in_state_longer_than') }).merge(Duration).strict(),

  z.object({ kind: z.literal('created_within_days'), days: z.number().positive().max(3650) }).strict(),
  z.object({ kind: z.literal('completed'), is: z.boolean() }).strict(),
  z.object({ kind: z.literal('outcome'), is: z.array(z.enum(['success', 'rejected', 'cancelled', 'expired'])).min(1) }).strict(),

  /** An open task, optionally a particular one. */
  z.object({ kind: z.literal('has_open_task'), task: Key.optional() }).strict(),

  /** A pending approval request, optionally a particular one. */
  z.object({ kind: z.literal('has_pending_approval'), approval: Key.optional() }).strict(),

  /** A delivery that failed, or an action the outbox has given up on. */
  z.object({ kind: z.literal('has_failure'), is: z.boolean() }).strict(),

  /**
   * These records and no others — what the console sends when somebody ticks
   * rows on the Records page. It narrows; it never widens: the rest of the
   * plan, the tenant and the permission checks still apply to every id.
   */
  z.object({ kind: z.literal('records'), ids: z.array(z.string().uuid()).min(1).max(200) }).strict(),

  AnswerFilter,
]);
export type Filter = z.infer<typeof Filter>;

// --------------------------------------------------------------------- plan

export const ORDERABLE = ['state_entered_at', 'created_at', 'hours_in_state'] as const;

export const QueryPlan = z
  .object({
    /** Exactly one process. Cross-process questions are refused, not joined. */
    processKey: Key,
    filters: z.array(Filter).max(8).default([]),
    orderBy: z
      .object({ by: z.enum(ORDERABLE), direction: z.enum(['asc', 'desc']).default('desc') })
      .strict()
      .optional(),
    /**
     * Capped here as well as in the executor. §6.4 asks for rate limits on
     * bulk actions, and a limit the model chooses is not a limit.
     */
    limit: z.number().int().positive().max(200).default(50),
    /** Answer fields to show. Redaction still applies on top of this. */
    select: z.array(Key).max(12).optional(),
  })
  .strict();
export type QueryPlan = z.infer<typeof QueryPlan>;

// ------------------------------------------------------------------ actions

/**
 * What may be done to the records a plan matched.
 *
 * §20.1 step 9 needs one of these — "sends a confirmed reminder to authorized
 * targets" — and the rest of §7.1's list (assignment, status change) is named
 * here without being implemented, so the gap is visible in the type rather
 * than discovered when somebody asks for it.
 *
 * A reminder names a template from the blueprint. It cannot carry a body: a
 * model-written message sent to a respondent under the workspace's name is a
 * different product with a different risk, and §7.3 wants generated text that
 * touches employment or safeguarding decisions labelled and reviewed.
 */
export const ActionPlan = z.union([
  z
    .object({
      kind: z.literal('send_reminder'),
      /** A key from the blueprint's `communications.email`. */
      template: Key,
    })
    .strict(),
  /**
   * Hands a record's open task to somebody else.
   *
   * `to` is a member's email or `role:<key>`, the two forms a task assignee
   * already takes. Reassigning somebody's work is an administrator's call —
   * the policy has said so since assignment existed — and the new assignee
   * must be somebody who could actually complete it.
   */
  z.object({ kind: z.literal('assign'), task: Key, to: z.string().min(1).max(254) }).strict(),

  /**
   * Moves records to a state, by the process's own manual steps only.
   *
   * Not a raw state write. A manual transition carries its role list, its
   * guard and its actions — the emails, tasks and approvals the process
   * defines for that move — and writing the state directly would skip every
   * one of them. A record whose current state has no manual step to the
   * target is skipped and told why.
   */
  z.object({ kind: z.literal('change_state'), to: Key }).strict(),
]);
export type ActionPlan = z.infer<typeof ActionPlan>;

export const IMPLEMENTED_ACTIONS = new Set(['send_reminder', 'assign', 'change_state']);

/** What the model returns: a plan, and its own account of what it understood. */
export const Proposal = z
  .object({
    /** One sentence, in the operator's words, describing what the plan asks. */
    reading: z.string().min(1).max(400),
    query: QueryPlan,
    /** Present only when the question asked for something to be done. */
    action: ActionPlan.optional(),
  })
  .strict();
export type Proposal = z.infer<typeof Proposal>;
