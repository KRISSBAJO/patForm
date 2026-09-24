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
  | { op: 'is_empty' | 'is_present'; left: Operand }
  | Quantifier;

/**
 * A condition over the rows of a repeating group: "any line item over £200",
 * "every item has a receipt".
 *
 * Inside `where`, a field is either one of that group's own questions — read
 * from the row being looked at — or an ordinary question from the rest of the
 * form, which reads the same on every row. Field keys are unique across the
 * whole process, groups included, so the two can never be confused.
 *
 * `all` over no rows is true, which is what "every item has a receipt" means
 * of a claim with no items. A rule that needs rows should say so too.
 */
export type Quantifier = { op: 'any' | 'all'; over: string; where: Expr };

export const Expr: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(['and', 'or']), operands: z.array(Expr).min(1) }).strict(),
    z.object({ op: z.literal('not'), operand: Expr }).strict(),
    z.object({ op: z.enum(COMPARISONS), left: Operand, right: Operand }).strict(),
    z.object({ op: z.enum(['in', 'not_in']), left: Operand, right: z.array(Operand).min(1) }).strict(),
    z.object({ op: z.literal('contains'), left: Operand, right: Operand }).strict(),
    z.object({ op: z.enum(['is_empty', 'is_present']), left: Operand }).strict(),
    z.object({ op: z.enum(['any', 'all']), over: Key, where: Expr }).strict(),
  ]),
);

/**
 * Arithmetic for calculated fields only. Kept separate from Expr so that a
 * boolean condition can never appear where a number is expected.
 */
export type Calc =
  | { op: 'add' | 'subtract' | 'multiply' | 'divide'; operands: Calc[] }
  | { op: 'sum' | 'count'; over: string; of?: string; where?: Expr }
  | { field: string }
  | { literal: number };

export const Calc: z.ZodType<Calc> = z.lazy(() =>
  z.union([
    z
      .object({ op: z.enum(['add', 'subtract', 'multiply', 'divide']), operands: z.array(Calc).min(2) })
      .strict(),
    z.object({ op: z.enum(['sum', 'count']), over: Key, of: Key.optional(), where: Expr.optional() }).strict(),
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
      case 'any':
      case 'all':
        out.push(e.over);
        walk(e.where);
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


// --------------------------------------------------------- evaluation

export type Answers = Record<string, unknown>;

export interface EvalContext {
  answers: Answers;
  now: Date;
  actor?: string;
  currentState?: string;
}

/**
 * Evaluates the typed expression model. There is no string parsing, no code
 * path that can reach anything except `answers`, and no way for a blueprint to
 * name a function. The compiler has already checked that every field key here
 * exists and that comparisons are type-compatible.
 */
export function evaluate(expr: Expr, ctx: EvalContext): boolean {
  switch (expr.op) {
    case 'and':
      return expr.operands.every((e) => evaluate(e, ctx));
    case 'or':
      return expr.operands.some((e) => evaluate(e, ctx));
    case 'not':
      return !evaluate(expr.operand, ctx);
    case 'any':
    case 'all': {
      const rows = ctx.answers[expr.over];
      const list = Array.isArray(rows) ? rows.filter((r): r is Answers => typeof r === 'object' && r !== null) : [];
      // Each row is read with the rest of the form around it, so a condition
      // can compare a row against an ordinary answer.
      const test = (row: Answers) => evaluate(expr.where, { ...ctx, answers: { ...ctx.answers, ...row } });
      return expr.op === 'any' ? list.some(test) : list.every(test);
    }
    case 'is_empty':
      return isEmpty(resolve(expr.left, ctx));
    case 'is_present':
      return !isEmpty(resolve(expr.left, ctx));
    case 'in':
      return expr.right.some((r) => same(resolve(expr.left, ctx), resolve(r, ctx)));
    case 'not_in':
      return !expr.right.some((r) => same(resolve(expr.left, ctx), resolve(r, ctx)));
    case 'contains': {
      const haystack = resolve(expr.left, ctx);
      const needle = resolve(expr.right, ctx);
      if (Array.isArray(haystack)) return haystack.some((v) => same(v, needle));
      if (typeof haystack === 'string' && typeof needle === 'string') return haystack.includes(needle);
      return false;
    }
    case 'eq':
      return same(resolve(expr.left, ctx), resolve(expr.right, ctx));
    case 'ne':
      return !same(resolve(expr.left, ctx), resolve(expr.right, ctx));
    default: {
      const left = resolve(expr.left, ctx);
      const right = resolve(expr.right, ctx);
      const order = compare(left, right);
      if (order === undefined) return false;
      switch (expr.op) {
        case 'gt':
          return order > 0;
        case 'gte':
          return order >= 0;
        case 'lt':
          return order < 0;
        case 'lte':
          return order <= 0;
      }
      return false;
    }
  }
}

function resolve(operand: Operand, ctx: EvalContext): unknown {
  if ('literal' in operand) return operand.literal;
  if ('field' in operand) return ctx.answers[operand.field];
  switch (operand.context) {
    case 'now':
      return ctx.now.toISOString();
    case 'today':
      return ctx.now.toISOString().slice(0, 10);
    case 'actor':
      return ctx.actor ?? null;
    case 'current_state':
      return ctx.currentState ?? null;
  }
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  return a === b;
}

/** Returns a sign, or undefined when the two values are not comparable. */
function compare(a: unknown, b: unknown): number | undefined {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  // ISO-8601 dates and times sort correctly as strings, which is why the
  // schema insists on that representation.
  if (typeof a === 'string' && typeof b === 'string') return a === b ? 0 : a < b ? -1 : 1;
  return undefined;
}

