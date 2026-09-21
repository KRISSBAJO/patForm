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
  })
  .strict();
export type Intent = z.infer<typeof Intent>;
