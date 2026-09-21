import { z } from 'zod';
import { Calc, DataClass, Expr, Key } from './common.js';

/** The initial field types listed in section 6.3 of the product document. */
export const FieldType = z.enum([
  'short_text',
  'long_text',
  'email',
  'phone',
  'number',
  'currency',
  'url',
  'address',
  'date',
  'time',
  'single_choice',
  'multi_choice',
  'dropdown',
  'yes_no',
  'rating',
  'matrix',
  'file',
  'signature_ack',
  'content',
  'hidden',
  'calculated',
  'repeating_group',
]);
export type FieldType = z.infer<typeof FieldType>;

/**
 * The value kind a field produces. Comparison operators are checked against
 * this, so "approve when amount > 500" fails to compile if amount is text.
 */
export const VALUE_KIND: Record<FieldType, 'text' | 'number' | 'boolean' | 'date' | 'time' | 'choice' | 'file' | 'none' | 'list'> = {
  short_text: 'text',
  long_text: 'text',
  email: 'text',
  phone: 'text',
  url: 'text',
  address: 'text',
  number: 'number',
  currency: 'number',
  rating: 'number',
  date: 'date',
  time: 'time',
  single_choice: 'choice',
  dropdown: 'choice',
  multi_choice: 'list',
  matrix: 'list',
  yes_no: 'boolean',
  signature_ack: 'boolean',
  file: 'file',
  content: 'none',
  hidden: 'text',
  calculated: 'number',
  repeating_group: 'list',
};

export const Choice = z
  .object({
    value: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

export const Constraints = z
  .object({
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
    /** Validation message shown when a constraint fails (section 6.3). */
    message: z.string().optional(),
    /** file only */
    accept: z.array(z.string()).optional(),
    maxSizeMb: z.number().positive().max(100).optional(),
    maxFiles: z.number().int().positive().optional(),
    /** currency only */
    currencyCode: z.string().length(3).optional(),
    /** rating only */
    scale: z.number().int().min(2).max(10).optional(),
    /** date only: bounds expressed relative to submission, in days */
    minDaysFromToday: z.number().int().optional(),
    maxDaysFromToday: z.number().int().optional(),
  })
  .strict();

export interface Field {
  key: string;
  type: FieldType;
  label: string;
  help?: string;
  required?: boolean;
  classification: DataClass;
  constraints?: z.infer<typeof Constraints>;
  choices?: z.infer<typeof Choice>[];
  default?: string | number | boolean | null;
  /** calculated fields only */
  compute?: Calc;
  /** repeating_group only */
  fields?: Field[];
  /**
   * Personal data that the process does not strictly need should not be
   * collected at all. Recording the reason makes over-collection visible in
   * review rather than discoverable later in an audit.
   */
  collectionReason?: string;
}

export const Field: z.ZodType<Field> = z.lazy(() =>
  z
    .object({
      key: Key,
      type: FieldType,
      label: z.string().min(1),
      help: z.string().optional(),
      required: z.boolean().optional(),
      classification: DataClass,
      constraints: Constraints.optional(),
      choices: z.array(Choice).optional(),
      default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
      compute: Calc.optional(),
      fields: z.array(Field).optional(),
      collectionReason: z.string().optional(),
    })
    .strict(),
);

export const DataSchema = z
  .object({
    fields: z.array(Field).min(1),
    /**
     * Fields whose combination identifies a duplicate submission. The runtime
     * needs this to satisfy the duplicate-handling requirement in section 4.2
     * without guessing.
     */
    identity: z.array(Key).optional(),
  })
  .strict();
export type DataSchema = z.infer<typeof DataSchema>;

/** Walks nested repeating-group fields so validation sees every declared key. */
export function flattenFields(fields: Field[], prefix = ''): { path: string; field: Field }[] {
  const out: { path: string; field: Field }[] = [];
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    out.push({ path, field });
    if (field.fields) out.push(...flattenFields(field.fields, path));
  }
  return out;
}

export { Expr };
