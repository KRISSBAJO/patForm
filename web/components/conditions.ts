/**
 * Conditions, evaluated in the browser for the builder's preview.
 *
 * The live form never uses this: it asks the server which fields are visible,
 * and the server's `evaluate` is the one that counts. The preview has no
 * server call per keystroke, and a preview that shows every conditional
 * section at once is a preview of a form nobody will see. So the same small
 * language is evaluated here, for showing and hiding only. A test holds the
 * two evaluators to the same answers on the same cases.
 */

export type Operand = { field: string } | { literal: string | number | boolean | null } | { context: string };
export type Expr =
  | { op: 'and' | 'or'; operands: Expr[] }
  | { op: 'not'; operand: Expr }
  | { op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; left: Operand; right: Operand }
  | { op: 'in' | 'not_in'; left: Operand; right: Operand[] }
  | { op: 'contains'; left: Operand; right: Operand }
  | { op: 'is_empty' | 'is_present'; left: Operand }
  | { op: 'any' | 'all'; over: string; where: Expr };

type Answers = Record<string, unknown>;

function read(o: Operand, answers: Answers): unknown {
  if ('literal' in o) return o.literal;
  if ('field' in o) return answers[o.field];
  if (o.context === 'today') return new Date().toISOString().slice(0, 10);
  if (o.context === 'now') return new Date().toISOString();
  return undefined;
}

function empty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function compare(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '' && a !== null && b !== null) return na - nb;
  return null;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  const c = compare(a, b);
  return c === 0;
}

/** True when the condition holds for these answers; an unreadable condition is false. */
export function holds(expr: unknown, answers: Answers): boolean {
  const e = expr as Expr | undefined;
  if (!e || typeof e !== 'object' || !('op' in e)) return false;
  switch (e.op) {
    case 'and':
      return e.operands.every((x) => holds(x, answers));
    case 'or':
      return e.operands.some((x) => holds(x, answers));
    case 'not':
      return !holds(e.operand, answers);
    case 'eq':
      return same(read(e.left, answers), read(e.right, answers));
    case 'ne':
      return !same(read(e.left, answers), read(e.right, answers));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const c = compare(read(e.left, answers), read(e.right, answers));
      if (c === null) return false;
      return e.op === 'gt' ? c > 0 : e.op === 'gte' ? c >= 0 : e.op === 'lt' ? c < 0 : c <= 0;
    }
    case 'in':
    case 'not_in': {
      const v = read(e.left, answers);
      const found = e.right.some((r) => same(v, read(r, answers)));
      return e.op === 'in' ? found : !found;
    }
    case 'contains': {
      const v = read(e.left, answers);
      const needle = read(e.right, answers);
      if (Array.isArray(v)) return v.some((x) => same(x, needle));
      if (typeof v === 'string' && typeof needle === 'string') return v.toLowerCase().includes(needle.toLowerCase());
      return false;
    }
    case 'is_empty':
      return empty(read(e.left, answers));
    case 'is_present':
      return !empty(read(e.left, answers));
    case 'any':
    case 'all': {
      const rows = answers[e.over];
      if (!Array.isArray(rows)) return e.op === 'all';
      const test = (row: unknown) => holds(e.where, { ...answers, ...(row && typeof row === 'object' ? (row as Answers) : {}) });
      return e.op === 'any' ? rows.some(test) : rows.every(test);
    }
    default:
      return false;
  }
}
