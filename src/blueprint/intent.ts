import { z } from 'zod';
import { DataClass, Key } from './common.js';

export const Intent = z
  .object({
    /** The result the process exists to produce, in the customer's words. */
    outcome: z.string().min(10),
    owner: Key,
    respondents: z.string().min(1),
    expectedVolume: z
      .object({
        count: z.number().int().positive(),
        per: z.enum(['day', 'week', 'month', 'year']),
      })
      .strict(),
    /**
     * The highest data class this process is allowed to hold. The compiler
     * rejects any field classified above it, which is how section 12 keeps
     * unsupported regulated data out of a beta tenant.
     */
    sensitivityCeiling: DataClass,
    /** The terminal state that counts as success for completion metrics. */
    completionState: Key,
    /** Section 9.2: how long instances are kept after completion. */
    retentionDays: z.number().int().positive().optional(),

    /*
     * BLD-02: "Generated blueprint includes assumptions, missing decisions,
     * data fields, roles, stages, rules, messages, documents, and metrics."
     *
     * Everything after "missing decisions" was already modelled. These two
     * were not: the generator was told to record what it assumed *in
     * `outcome`*, which is prose in a field meant for the result the process
     * produces. Buried there, the compiler cannot check them, the builder
     * cannot list them, and the reviewer §1.3 depends on has nothing to
     * review — which defeats the only purpose they have.
     *
     * They are deliberately not blocking. An assumption is a statement, not
     * an error; a missing decision is a question, not a fault. The compiler
     * warns so that publishing with them unanswered is a choice somebody
     * made rather than something that happened.
     */

    /** What the model decided for you because the description did not say. */
    assumptions: z
      .array(
        z
          .object({
            /** The assumption itself, in the customer's language. */
            statement: z.string().min(5),
            /** Where in the blueprint it took effect, so it can be checked. */
            affects: z.string().min(1),
            /** Explicitly confirmed by an editor; the draft revision records who and when. */
            confirmed: z.boolean().optional(),
          })
          .strict(),
      )
      .default([]),

    /** What it could not decide, and needs a person to answer. */
    openDecisions: z
      .array(
        z
          .object({
            question: z.string().min(5),
            /** What it did in the meantime. */
            provisionally: z.string().min(1),
            /** How much it matters that this is still open. */
            importance: z.enum(['blocking', 'review', 'minor']).default('review'),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type Intent = z.infer<typeof Intent>;
