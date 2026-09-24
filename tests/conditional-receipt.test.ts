import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { validateAnswers } from '../src/blueprint/answers.js';
import { validate } from '../src/compiler/validate.js';
import { withCalculatedFields } from '../src/runtime/expr.js';

const reference = 'receipt-file:00000000-0000-4000-8000-000000000001';

function expense() {
  const bp = Blueprint.parse(JSON.parse(readFileSync('processes/expense-approval.blueprint.json', 'utf8')));
  const group = bp.data.fields.find((field) => field.key === 'line_items')!;
  group.fields!.push({ key: 'line_receipt', type: 'file', label: 'Receipt', classification: 'confidential',
    help: 'Required for an item of £25 or more.', collectionReason: 'Finance verifies the expense.',
    requiredWhen: { op: 'gte', left: { field: 'line_amount' }, right: { literal: 25 } },
    constraints: { accept: ['application/pdf', 'image/png', 'image/jpeg'], maxSizeMb: 5, maxFiles: 1 } });
  return bp;
}

test('conditional receipt in an expense row compiles', () => {
  const errors = validate(expense()).errors;
  assert.equal(errors.length, 0, errors.map((item) => `${item.code}: ${item.message}`).join('\n'));
});

test('receipt is required at £25, with a real upload reference', () => {
  const bp = expense();
  const errorsFor = (amount: number, receipt?: string) => validateAnswers(bp, {
    line_items: [{ line_description: 'Taxi', line_amount: amount, ...(receipt ? { line_receipt: receipt } : {}) }],
  }).filter((error) => error.field === 'line_items[0].line_receipt');
  assert.equal(errorsFor(24.99).length, 0);
  assert.equal(errorsFor(25).length, 1);
  assert.equal(errorsFor(25, 'taxi.pdf').length, 1);
  assert.equal(errorsFor(25, reference).length, 0);
});

test('expense totals include only personally paid rows', () => {
  const bp = expense();
  const total = bp.data.fields.find((field) => field.key === 'expense_total')!;
  total.compute = { op: 'sum', over: 'line_items', of: 'line_amount',
    where: { op: 'eq', left: { field: 'line_payment_method' }, right: { literal: 'personal_card' } } };
  const group = bp.data.fields.find((field) => field.key === 'line_items')!;
  group.fields!.push({ key: 'line_payment_method', type: 'dropdown', label: 'Paid with', classification: 'internal',
    choices: [{ value: 'personal_card', label: 'Personal card' }, { value: 'company_card', label: 'Company card' }] });
  assert.equal(validate(bp).errors.length, 0);
  const answers = withCalculatedFields(bp.data.fields, { line_items: [
    { line_amount: 50, line_payment_method: 'personal_card' },
    { line_amount: 100, line_payment_method: 'company_card' },
  ] });
  assert.equal(answers.expense_total, 50);
});
