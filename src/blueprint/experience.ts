import { z } from 'zod';
import { Expr, Key } from './common.js';

/**
 * How wide a field sits on the page.
 *
 * Optional, defaulting to the full width, so every blueprint written before
 * this keeps compiling and keeps looking the same. `half` is what makes a
 * first and last name sit side by side instead of stacking into a column
 * twice as long as it needs to be — which is most of what separates a form
 * somebody finishes from one they abandon.
 */
export const FieldWidth = z.enum(['full', 'half', 'third']);
export type FieldWidth = z.infer<typeof FieldWidth>;

export const Section = z
  .object({
    key: Key,
    title: z.string().optional(),
    description: z.string().optional(),
    fields: z.array(Key).min(1),
    /**
     * Widths for the fields above, keyed by field.
     *
     * Beside the list rather than inside it, because `fields` is a list of
     * keys everywhere else in the schema and changing its shape would touch
     * every rule that reads it. A field with no entry is full width.
     */
    widths: z.record(Key, FieldWidth).optional(),
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
    /**
     * What the respondent sees at the top.
     *
     * A form with no header is a form that could be from anybody, which is
     * exactly the wrong impression when it is asking for a passport number.
     * All optional: a process that says nothing here gets its own name and
     * the platform's plain header, which is what every blueprint written
     * before this now does.
     */
    branding: z
      .object({
        /** Overrides the process name at the top of the form. */
        title: z.string().min(1).optional(),
        /** One line under the title. */
        tagline: z.string().max(200).optional(),
        /** An organization's mark, uploaded to workspace image storage. */
        logoUrl: z.string().url().optional(),
        /** A photograph behind the title. */
        bannerUrl: z.string().url().optional(),
        /**
         * The colour of the header and the submit button.
         *
         * Hex, and checked as hex — a colour that is not one would reach the
         * page as a style attribute, which is the shape of an injection.
         */
        accent: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, 'a six-digit hex colour like #14663f')
          .optional(),
        /** Shown in small print under the form. */
        footer: z.string().max(300).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Experience = z.infer<typeof Experience>;
