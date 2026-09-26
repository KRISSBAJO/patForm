/**
 * What the specs say often, named once.
 *
 * `when` is the handful of condition shapes a form needs: a section shown
 * only for sick leave, a question required only over a week. `CODE` is a
 * budget or cost-centre code as ledgers write them. Both catalogue files use
 * these, and the extra file cannot import the main one without a cycle.
 */
import type { Expr } from '../blueprint/common.js';

export const when = {
  is: (field: string, value: string | number | boolean): Expr => ({ op: 'eq', left: { field }, right: { literal: value } }),
  yes: (field: string): Expr => ({ op: 'eq', left: { field }, right: { literal: true } }),
  no: (field: string): Expr => ({ op: 'eq', left: { field }, right: { literal: false } }),
  oneOf: (field: string, values: string[]): Expr => ({ op: 'in', left: { field }, right: values.map((v) => ({ literal: v })) }),
  atLeast: (field: string, n: number): Expr => ({ op: 'gte', left: { field }, right: { literal: n } }),
  includes: (field: string, value: string): Expr => ({ op: 'contains', left: { field }, right: { literal: value } }),
};

export const CODE = {
  pattern: '^[A-Za-z0-9][A-Za-z0-9 ./-]{1,23}$',
  message: 'Use the code as it appears in the ledger: letters, numbers and dashes, up to 24 characters.',
};
