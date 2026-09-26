import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/blueprint/index.js';
import { holds } from '../web/components/conditions.js';

/**
 * The preview's evaluator and the server's, held to the same answers.
 *
 * The preview hides and shows sections with its own small evaluator, because
 * it has no server call per keystroke. If the two ever disagree, the builder
 * shows a form the respondent will not get.
 */
const answers = {
  leave_type: 'sick',
  working_days: 6,
  half_day: true,
  cover_agreed: false,
  setup_needed: ['screen_or_projector', 'catering'],
  severity: 'sev2',
  amount: 84.5,
  notes: '',
  line_items: [{ line_amount: 20 }, { line_amount: 300 }],
};

const cases: unknown[] = [
  { op: 'eq', left: { field: 'leave_type' }, right: { literal: 'sick' } },
  { op: 'eq', left: { field: 'leave_type' }, right: { literal: 'annual' } },
  { op: 'ne', left: { field: 'leave_type' }, right: { literal: 'annual' } },
  { op: 'eq', left: { field: 'half_day' }, right: { literal: true } },
  { op: 'eq', left: { field: 'cover_agreed' }, right: { literal: true } },
  { op: 'eq', left: { field: 'missing' }, right: { literal: true } },
  { op: 'gte', left: { field: 'working_days' }, right: { literal: 5 } },
  { op: 'lt', left: { field: 'working_days' }, right: { literal: 5 } },
  { op: 'gt', left: { field: 'amount' }, right: { literal: 100 } },
  { op: 'in', left: { field: 'severity' }, right: [{ literal: 'sev1' }, { literal: 'sev2' }] },
  { op: 'not_in', left: { field: 'severity' }, right: [{ literal: 'sev1' }, { literal: 'sev2' }] },
  { op: 'contains', left: { field: 'setup_needed' }, right: { literal: 'catering' } },
  { op: 'contains', left: { field: 'setup_needed' }, right: { literal: 'whiteboard' } },
  { op: 'is_empty', left: { field: 'notes' } },
  { op: 'is_present', left: { field: 'notes' } },
  { op: 'is_present', left: { field: 'leave_type' } },
  { op: 'and', operands: [{ op: 'eq', left: { field: 'leave_type' }, right: { literal: 'sick' } }, { op: 'gte', left: { field: 'working_days' }, right: { literal: 5 } }] },
  { op: 'or', operands: [{ op: 'eq', left: { field: 'leave_type' }, right: { literal: 'annual' } }, { op: 'eq', left: { field: 'half_day' }, right: { literal: true } }] },
  { op: 'not', operand: { op: 'eq', left: { field: 'half_day' }, right: { literal: true } } },
  { op: 'any', over: 'line_items', where: { op: 'gt', left: { field: 'line_amount' }, right: { literal: 200 } } },
  { op: 'all', over: 'line_items', where: { op: 'gt', left: { field: 'line_amount' }, right: { literal: 200 } } },
  { op: 'all', over: 'no_rows', where: { op: 'gt', left: { field: 'line_amount' }, right: { literal: 200 } } },
];

test('the preview evaluates every condition shape the way the server does', () => {
  const now = new Date();
  for (const expr of cases) {
    const server = Boolean(evaluate(expr as never, { answers, now }));
    const preview = holds(expr, answers);
    assert.equal(preview, server, `disagree on ${JSON.stringify(expr)}: preview ${preview}, server ${server}`);
  }
});

test('an unreadable condition is simply false in the preview', () => {
  assert.equal(holds(undefined, answers), false);
  assert.equal(holds({ op: 'nonsense' }, answers), false);
  assert.equal(holds('yes', answers), false);
});
