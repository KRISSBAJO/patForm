import type { Calc, Expr, Field, Operand } from '../blueprint/index.js';

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

/**
 * Computes a calculated field. Kept separate from `evaluate` so a boolean can
 * never appear where a number is expected.
 */
export function calculate(calc: Calc, answers: Answers): number {
  if ('literal' in calc) return calc.literal;
  if ('field' in calc) return toNumber(answers[calc.field]);

  switch (calc.op) {
    case 'sum':
    case 'count': {
      const rows = answers[calc.over];
      if (!Array.isArray(rows)) return 0;
      if (calc.op === 'count') return rows.length;
      const of = calc.of;
      if (!of) return 0;
      return rows.reduce<number>((total, row) => {
        const cell = row && typeof row === 'object' ? (row as Record<string, unknown>)[of] : undefined;
        return total + toNumber(cell);
      }, 0);
    }
    default: {
      const values: number[] = calc.operands.map((o) => calculate(o, answers));
      switch (calc.op) {
        case 'add':
          return values.reduce((a, b) => a + b, 0);
        case 'subtract':
          return values.slice(1).reduce((a, b) => a - b, values[0] ?? 0);
        case 'multiply':
          return values.reduce((a, b) => a * b, 1);
        case 'divide':
          return values.slice(1).reduce((a, b) => (b === 0 ? a : a / b), values[0] ?? 0);
      }
    }
  }
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/** Fills in every calculated field so conditions can read them like any other. */
export function withCalculatedFields(fields: Field[], answers: Answers): Answers {
  const out: Answers = { ...answers };
  // Two passes so a calculated field may depend on another one. The compiler
  // has already rejected cycles, so this terminates with the right answer.
  for (let pass = 0; pass < 2; pass++) {
    for (const field of fields) {
      if (field.type === 'calculated' && field.compute) {
        out[field.key] = calculate(field.compute, out);
      }
    }
  }
  return out;
}

/** Substitutes {{field_key}} placeholders. Nothing else is interpreted. */
export function render(template: string, answers: Answers): string {
  return template.replace(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g, (_match, key: string) => {
    const value = answers[key];
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
    return String(value);
  });
}
