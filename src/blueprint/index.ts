import { z } from 'zod';
import { Key } from './common.js';
import { Communications } from './communications.js';
import { DataSchema } from './data.js';
import { Experience } from './experience.js';
import { Intent } from './intent.js';
import { Outputs } from './outputs.js';
import { Role } from './roles.js';
import { ScenarioTest } from './tests.js';
import { Workflow } from './workflow.js';

/**
 * The process blueprint: the typed intermediate representation described in
 * section 7.2 of the product document. The AI proposes one of these; the
 * compiler in ../compiler decides whether it may become a published version.
 *
 * Nothing here is executable. There is no code, no expression string, and no
 * free-form reference — every link between sections is a declared key that the
 * compiler resolves.
 */
export const Blueprint = z
  .object({
    schemaVersion: z.literal('0.1'),
    key: Key,
    name: z.string().min(1),
    description: z.string().optional(),
    intent: Intent,
    roles: z.array(Role).min(1),
    data: DataSchema,
    experience: Experience,
    workflow: Workflow,
    communications: Communications,
    outputs: Outputs,
    tests: z.array(ScenarioTest).default([]),
    /**
     * PRD Module 5. Marks a process as an expense claim or a cash advance.
     *
     * On submission the engine copies the workspace's expense policy into
     * the `policy` fields (numbers with setBy system, so a respondent cannot send them), so routing
     * conditions compare against them and an old claim keeps the numbers it
     * was routed by. It also checks the receipt rule, the allowed categories
     * and, for a claim that retires an advance, that the advance is the
     * submitter's and still open. On reaching the success state it writes
     * the settlement (claim) or the advance record.
     */
    finance: z
      .object({
        kind: z.enum(['claim', 'advance']),
        amountField: Key,
        receiptField: Key.optional(),
        categoryField: Key.optional(),
        advanceReferenceField: Key.optional(),
        policy: z
          .object({
            autoApproveLimit: Key.optional(),
            managerLimit: Key.optional(),
            lineLimit: Key.optional(),
          })
          .strict()
          .default({}),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Blueprint = z.infer<typeof Blueprint>;

export * from './common.js';
export * from './communications.js';
export * from './data.js';
export * from './experience.js';
export * from './intent.js';
export * from './outputs.js';
export * from './roles.js';
export * from './tests.js';
export * from './workflow.js';
