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
