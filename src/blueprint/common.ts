import { z } from 'zod';

/**
 * Keys are the only way one part of a blueprint refers to another. Every
 * reference is validated by the compiler, so the format is deliberately narrow.
 */
export const Key = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'must be lower_snake_case and start with a letter')
  .max(64);

export const DataClass = z.enum(['public', 'internal', 'confidential', 'restricted']);
export type DataClass = z.infer<typeof DataClass>;

/** Ordering used to compare a field's class against the process sensitivity ceiling. */
export const DATA_CLASS_RANK: Record<DataClass, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/**
 * Operands in the expression model. `field` is the only way to read record
 * data; there is no property access, indexing, or function call syntax, so an
 * expression cannot reach anything the compiler has not seen.
 */
export const Operand: z.ZodType<Operand> = z.lazy(() =>
  z.union([
    z.object({ field: Key }).strict(),
    z.object({ literal: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict(),
    z.object({ context: z.enum(['now', 'today', 'actor', 'current_state']) }).strict(),
  ]),
);
export type Operand =
  | { field: string }
  | { literal: string | number | boolean | null }
  | { context: 'now' | 'today' | 'actor' | 'current_state' };

const COMPARISONS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const;

/**
 * Typed boolean expression. Section 6.5 of the product document requires
 * conditions to be "typed comparisons and grouped AND or OR expressions; no
 * arbitrary code" — this is that model, and nothing else is accepted.
 */
export type Expr =
  | { op: 'and' | 'or'; operands: Expr[] }
  | { op: 'not'; operand: Expr }
  | { op: (typeof COMPARISONS)[number]; left: Operand; right: Operand }
  | { op: 'in' | 'not_in'; left: Operand; right: Operand[] }
  | { op: 'contains'; left: Operand; right: Operand }
  | { op: 'is_empty' | 'is_present'; left: Operand };

export const Expr: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(['and', 'or']), operands: z.array(Expr).min(1) }).strict(),
    z.object({ op: z.literal('not'), operand: Expr }).strict(),
    z.object({ op: z.enum(COMPARISONS), left: Operand, right: Operand }).strict(),
    z.object({ op: z.enum(['in', 'not_in']), left: Operand, right: z.array(Operand).min(1) }).strict(),
    z.object({ op: z.literal('contains'), left: Operand, right: Operand }).strict(),
    z.object({ op: z.enum(['is_empty', 'is_present']), left: Operand }).strict(),
  ]),
);

/**
 * Arithmetic for calculated fields only. Kept separate from Expr so that a
 * boolean condition can never appear where a number is expected.
 */
export type Calc =
  | { op: 'add' | 'subtract' | 'multiply' | 'divide'; operands: Calc[] }
  | { op: 'sum' | 'count'; over: string; of?: string }
  | { field: string }
  | { literal: number };

export const Calc: z.ZodType<Calc> = z.lazy(() =>
  z.union([
    z
      .object({ op: z.enum(['add', 'subtract', 'multiply', 'divide']), operands: z.array(Calc).min(2) })
      .strict(),
    z.object({ op: z.enum(['sum', 'count']), over: Key, of: Key.optional() }).strict(),
    z.object({ field: Key }).strict(),
    z.object({ literal: z.number() }).strict(),
  ]),
);

/** Collects every field key an expression reads, for reference validation. */
export function fieldsInExpr(expr: Expr): string[] {
  const out: string[] = [];
  const operand = (o: Operand) => {
    if ('field' in o) out.push(o.field);
  };
  const walk = (e: Expr): void => {
    switch (e.op) {
      case 'and':
      case 'or':
        e.operands.forEach(walk);
        return;
      case 'not':
        walk(e.operand);
        return;
      case 'in':
      case 'not_in':
        operand(e.left);
        e.right.forEach(operand);
        return;
      case 'is_empty':
      case 'is_present':
        operand(e.left);
        return;
      default:
        operand(e.left);
        operand(e.right);
    }
  };
  walk(expr);
  return out;
}

/** Collects every field key a calculation reads, including repeating-group sources. */
export function fieldsInCalc(calc: Calc): string[] {
  const out: string[] = [];
  const walk = (c: Calc): void => {
    if ('field' in c) {
      out.push(c.field);
      return;
    }
    if ('literal' in c) return;
    switch (c.op) {
      case 'sum':
      case 'count':
        out.push(c.over);
        if (c.of) out.push(c.of);
        return;
      default:
        c.operands.forEach(walk);
    }
  };
  walk(calc);
  return out;
}
