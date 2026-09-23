import { z } from 'zod';
import { Key } from './common.js';

/**
 * Section 7.2 requires every generated blueprint to carry its own scenarios:
 * happy path, rejection, missing data, timeout, duplicate, and permission.
 * These run against the published version in test mode before publish
 * (requirement BLD-05) and again as regression tests after it.
 */
export const TestKind = z.enum([
  'happy_path',
  'rejection',
  'missing_data',
  'timeout',
  'duplicate',
  'permission',
]);
export type TestKind = z.infer<typeof TestKind>;

export const Step = z.discriminatedUnion('step', [
  z.object({ step: z.literal('submit'), answers: z.record(z.string(), z.unknown()) }).strict(),
  z
    .object({
      step: z.literal('decide'),
      approval: Key,
      as: Key,
      decision: z.enum(['approved', 'rejected', 'changes_requested']),
      reason: z.string().optional(),
    })
    .strict(),
  z.object({
    step: z.literal('complete_task'), task: Key, as: Key,
    answers: z.record(z.string(), z.unknown()).optional(),
    expectDenied: z.boolean().optional(),
  }).strict(),
  z.object({ step: z.literal('advance_hours'), hours: z.number().positive() }).strict(),
  z
    .object({
      step: z.literal('attempt'),
      as: Key,
      action: z.enum(['submit', 'view', 'edit', 'approve', 'export', 'operate']),
      /** Set when the point of the step is that it must be refused. */
      expectDenied: z.boolean().default(false),
    })
    .strict(),
]);

export const ScenarioTest = z
  .object({
    key: Key,
    kind: TestKind,
    name: z.string().min(1),
    steps: z.array(Step).min(1),
    expect: z
      .object({
        state: Key.optional(),
        emails: z.array(Key).optional(),
        documents: z.array(Key).optional(),
        openTasks: z.array(Key).optional(),
        /** Duplicate scenarios assert exactly one instance and one email. */
        instanceCount: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();
export type ScenarioTest = z.infer<typeof ScenarioTest>;
