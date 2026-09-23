import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { evaluate, type Expr } from '../src/blueprint/common.js';
import { validate } from '../src/compiler/validate.js';

const now = new Date('2026-09-23T10:00:00Z');
const over200: Expr = { op: 'gt', left: { field: 'line_amount' }, right: { literal: 200 } };
const items = (...amounts: number[]) => amounts.map((a, i) => ({ line_description: `item ${i}`, line_amount: a }));

test('"any" is true when one row matches, "all" only when every row does', () => {
  const answers = { line_items: items(40, 260, 90) };
  assert.equal(evaluate({ op: 'any', over: 'line_items', where: over200 }, { answers, now }), true);
  assert.equal(evaluate({ op: 'all', over: 'line_items', where: over200 }, { answers, now }), false);
  assert.equal(
    evaluate({ op: 'all', over: 'line_items', where: { op: 'lte', left: { field: 'line_amount' }, right: { literal: 300 } } }, { answers, now }),
    true,
  );
});

test('with no rows, "any" is false and "all" is true', () => {
  for (const answers of [{ line_items: [] }, {}]) {
    assert.equal(evaluate({ op: 'any', over: 'line_items', where: over200 }, { answers, now }), false);
    assert.equal(evaluate({ op: 'all', over: 'line_items', where: over200 }, { answers, now }), true);
  }
});

test('a row can be compared with an answer outside the group', () => {
  // "Any item over the limit the claimant was given."
  const where: Expr = { op: 'gt', left: { field: 'line_amount' }, right: { field: 'item_limit' } };
  const answers = { item_limit: 250, line_items: items(240, 100) };
  assert.equal(evaluate({ op: 'any', over: 'line_items', where }, { answers, now }), false);
  assert.equal(evaluate({ op: 'any', over: 'line_items', where }, { answers: { ...answers, item_limit: 200 }, now }), true);
});

test('quantifiers nest, for a group inside a group', () => {
  const expr: Expr = {
    op: 'any',
    over: 'trips',
    where: { op: 'any', over: 'legs', where: { op: 'eq', left: { field: 'mode' }, right: { literal: 'flight' } } },
  };
  const answers = { trips: [{ legs: [{ mode: 'train' }] }, { legs: [{ mode: 'train' }, { mode: 'flight' }] }] };
  assert.equal(evaluate(expr, { answers, now }), true);
  assert.equal(evaluate(expr, { answers: { trips: [{ legs: [{ mode: 'train' }] }] }, now }), false);
});

const expense = () =>
  Blueprint.parse(JSON.parse(readFileSync('processes/expense-approval.blueprint.json', 'utf8')));
const codes = (bp: Blueprint) => validate(bp).items.map((x) => x.code);
const withCondition = (when: Expr) => {
  const bp = expense();
  bp.workflow.transitions.find((t) => t.key === 'manager_approved_over_limit')!.when = when;
  return bp;
};

test('the expense process, with its "any item over £200" rule, compiles clean', () => {
  const d = validate(expense());
  assert.equal(d.errors.length, 0, JSON.stringify(d.errors));
  assert.ok(!codes(expense()).some((c) => c.startsWith('RPT')));
});

test('a row question read outside "any" or "all" is refused', () => {
  // It used to compile and then read nothing: there is no answer called
  // line_amount on the record, only one per row.
  assert.ok(codes(withCondition(over200)).includes('RPT001'));
});

test('"any" over something that is not a group is refused', () => {
  const bp = withCondition({ op: 'any', over: 'expense_total', where: over200 });
  assert.ok(codes(bp).includes('RPT002'));
});

test('a condition inside "any" that never reads the row is warned about', () => {
  const bp = withCondition({
    op: 'any',
    over: 'line_items',
    where: { op: 'gt', left: { field: 'expense_total' }, right: { literal: 1000 } },
  });
  assert.ok(codes(bp).includes('RPT003'));
});

test('a condition inside a quantifier is still type-checked', () => {
  const bp = withCondition({
    op: 'any',
    over: 'line_items',
    where: { op: 'gt', left: { field: 'line_description' }, right: { literal: 200 } },
  });
  assert.ok(codes(bp).includes('TYPE001'));
});
