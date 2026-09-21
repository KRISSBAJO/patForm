import { z } from 'zod';
import { Key } from './common.js';

export const DocumentTemplate = z
  .object({
    key: Key,
    name: z.string().min(1),
    /** Section 6.6: controlled DOCX or HTML-to-PDF templates. */
    source: z.enum(['docx', 'html']),
    templateRef: z.string().min(1),
    /** Placeholder in the template -> field key in the record. */
    mapping: z.record(z.string(), Key),
    filename: z.string().min(1),
    /** Attach to the record, email it, or both. */
    deliver: z.array(z.enum(['attach_to_record', 'email'])).min(1),
  })
  .strict();
export type DocumentTemplate = z.infer<typeof DocumentTemplate>;

export const Metric = z
  .object({
    key: Key,
    name: z.string().min(1),
    /** Section 13.1 operational metrics, defined once and versioned. */
    kind: z.enum([
      'intake',
      'completion_rate',
      'cycle_time',
      'stage_aging',
      'approval_time',
      'rework_rate',
      'automation_failure_rate',
      'manual_touch_rate',
      'abandonment',
    ]),
    /** Restricts the metric to one stage, where the kind supports it. */
    state: Key.optional(),
  })
  .strict();

export const Outputs = z
  .object({
    documents: z.array(DocumentTemplate).default([]),
    dashboard: z
      .object({
        metrics: z.array(Metric).min(1),
      })
      .strict(),
    /** Webhook event names this process promises to emit (section 11.2). */
    webhookEvents: z.array(z.string()).default([]),
    /** Field keys included in a CSV export, in order. */
    exportFields: z.array(Key).default([]),
  })
  .strict();
export type Outputs = z.infer<typeof Outputs>;
