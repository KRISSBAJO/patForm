import { z } from 'zod';
import { Expr, Key } from './common.js';
import { Party } from './workflow.js';

/**
 * Message class decides legal handling. Section 6.6 requires unsubscribe only
 * where the message class legally needs it, which means the class has to be
 * declared rather than inferred from the wording.
 */
export const MessageClass = z.enum(['transactional', 'reminder', 'notification', 'marketing']);

export const EmailTemplate = z
  .object({
    key: Key,
    name: z.string().min(1),
    class: MessageClass,
    to: z.array(Party).min(1),
    cc: z.array(Party).default([]),
    replyTo: Party.optional(),
    subject: z.string().min(1),
    /**
     * Body is a template string with {{field_key}} placeholders. The compiler
     * resolves every placeholder against the data schema and checks its
     * classification before the template can be published.
     */
    body: z.string().min(1),
    attachments: z.array(Key).default([]),
    /** Suppress when this is true, e.g. do not chase a withdrawn application. */
    skipWhen: Expr.optional(),
  })
  .strict();
export type EmailTemplate = z.infer<typeof EmailTemplate>;

export const Communications = z
  .object({
    email: z.array(EmailTemplate).default([]),
    /** Section 6.6: SMS is out of scope for MVP, but the slot is reserved. */
    sms: z.array(z.never()).default([]),
    fromName: z.string().min(1),
  })
  .strict();
export type Communications = z.infer<typeof Communications>;

/** Extracts {{placeholder}} names from a template string. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g)].map((m) => m[1]!);
}
