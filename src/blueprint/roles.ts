import { z } from 'zod';
import { Key } from './common.js';

/**
 * Capabilities are coarse on purpose. Field-level restriction is expressed
 * separately so that "can open the record but must not see the ID number"
 * stays a single, reviewable statement (section 6.4).
 */
export const Capability = z.enum(['submit', 'view', 'edit', 'approve', 'operate', 'report', 'administer']);
export type Capability = z.infer<typeof Capability>;

export const Role = z
  .object({
    key: Key,
    name: z.string().min(1),
    /**
     * `respondent` roles are people outside the workspace acting through a
     * public link or token; `internal` roles are workspace members.
     */
    kind: z.enum(['internal', 'respondent']),
    capabilities: z.array(Capability).min(1),
    /** Field keys this role must never see, even on records it can open. */
    hiddenFields: z.array(Key).optional(),
    /** Field keys this role may change after submission. */
    editableFields: z.array(Key).optional(),
  })
  .strict();
export type Role = z.infer<typeof Role>;
