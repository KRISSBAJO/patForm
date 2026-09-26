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

/**
 * Date windows. A form asks about something that has happened or something
 * that will; a date on the wrong side of today is nearly always a typo in
 * the year, and the message says which side was expected.
 */
export const PAST_DATE = { maxDaysFromToday: 0, message: 'That date is in the future.' };
export const RECENT_DATE = { minDaysFromToday: -365, maxDaysFromToday: 0, message: 'A date in the last year, not in the future.' };
export const SOON_DATE = { minDaysFromToday: 0, maxDaysFromToday: 730, message: 'A date from today, within the next two years.' };
export const NEAR_DATE = { minDaysFromToday: -14, maxDaysFromToday: 90, message: 'Within the last two weeks or the next three months.' };
export const WIDE_DATE = { minDaysFromToday: -30, maxDaysFromToday: 400, message: 'Within the last month or the next year or so.' };
export const EITHER_SIDE = { minDaysFromToday: -60, maxDaysFromToday: 60, message: 'Within two months either side of today.' };

export const CODE = {
  pattern: '^[A-Za-z0-9][A-Za-z0-9 ./-]{1,23}$',
  message: 'Use the code as it appears in the ledger: letters, numbers and dashes, up to 24 characters.',
};
