import { z } from 'zod';
import { Expr, Key } from './common.js';

export const Section = z
  .object({
    key: Key,
    title: z.string().optional(),
    description: z.string().optional(),
    fields: z.array(Key).min(1),
    visibleWhen: Expr.optional(),
  })
  .strict();

export const Page = z
  .object({
    key: Key,
    title: z.string().min(1),
    description: z.string().optional(),
    sections: z.array(Section).min(1),
    visibleWhen: Expr.optional(),
  })
  .strict();

export const Experience = z
  .object({
    pages: z.array(Page).min(1),
    showProgress: z.boolean().default(true),
    /** Section 6.3: autosave and secure resume link. */
    saveAndResume: z.boolean().default(false),
    confirmation: z
      .object({
        message: z.string().min(1),
        /** Section 6.3: optional respondent status page. */
        showStatusLink: z.boolean().default(false),
      })
      .strict(),
    locales: z.array(z.string()).default(['en']),
  })
  .strict();
export type Experience = z.infer<typeof Experience>;
