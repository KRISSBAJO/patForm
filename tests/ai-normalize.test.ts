import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { normalizeBlueprint } from '../src/ai/normalize.js';
import { qualityDiagnostics } from '../src/compiler/quality.js';
import { validate } from '../src/compiler/validate.js';
import { calculate } from '../src/runtime/expr.js';

const onboarding = () =>
  Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json', 'utf8')));

test('a yes/no compared against "yes" is read as true', () => {
  const bp = onboarding();
  bp.data.fields.push({ key: 'is_regulated', type: 'yes_no', label: 'Regulated?', required: false, classification: 'internal', setBy: 'operator' });
  bp.workflow.transitions[1]!.when = { op: 'eq', left: { field: 'is_regulated' }, right: { literal: 'Yes' } };
  const { blueprint, changes } = normalizeBlueprint(bp);
  assert.deepEqual(blueprint.workflow.transitions[1]!.when, { op: 'eq', left: { field: 'is_regulated' }, right: { literal: true } });
  assert.equal(changes.length, 1);
  assert.match(changes[0]!.change, /read as true/);
});

test('a choice written as its label, or in another case, becomes the choice value', () => {
  const bp = onboarding();
  const field = bp.data.fields.find((f) => f.type === 'dropdown' || f.type === 'single_choice');
  assert.ok(field?.choices?.length, 'the fixture needs a choice field');
  const choice = field!.choices![0]!;
  bp.workflow.transitions[1]!.when = {
    op: 'in',
    left: { field: field!.key },
    right: [{ literal: choice.label.toUpperCase() }, { literal: 'not_a_choice_at_all' }],
  };
  const { blueprint } = normalizeBlueprint(bp);
  const when = blueprint.workflow.transitions[1]!.when as { right: { literal: unknown }[] };
  assert.equal(when.right[0]!.literal, choice.value);
  // Something that matches nothing is left for the compiler to refuse.
  assert.equal(when.right[1]!.literal, 'not_a_choice_at_all');
});

test('check-out minus check-in over two times becomes a duration in hours', () => {
  const bp = onboarding();
  bp.data.fields.push(
    { key: 'in_at', type: 'time', label: 'In', required: false, classification: 'internal' },
    { key: 'out_at', type: 'time', label: 'Out', required: false, classification: 'internal' },
    {
      key: 'hours_in',
      type: 'calculated',
      label: 'Hours',
      classification: 'internal',
      compute: { op: 'subtract', operands: [{ field: 'out_at' }, { field: 'in_at' }] },
    },
  );
  const { blueprint } = normalizeBlueprint(bp);
  const calc = blueprint.data.fields.find((f) => f.key === 'hours_in')!.compute;
  assert.deepEqual(calc, { op: 'duration', from: 'in_at', to: 'out_at', unit: 'hours' });
  // And the compiler accepts what it produced.
  assert.ok(!validate(blueprint).items.some((d) => d.code === 'TYPE004'));
});

test('a duration measures times within a day, across midnight, and dates in days', () => {
  const hours = { op: 'duration' as const, from: 'in_at', to: 'out_at', unit: 'hours' as const };
  assert.equal(calculate(hours, { in_at: '09:00', out_at: '17:30' }), 8.5);
  assert.equal(calculate({ ...hours, unit: 'minutes' }, { in_at: '22:00', out_at: '01:00' }), 180);
  assert.equal(calculate({ op: 'duration', from: 'start', to: 'end', unit: 'days' }, { start: '2026-09-01', end: '2026-09-15' }), 14);
  assert.equal(calculate(hours, { in_at: '', out_at: '17:30' }), 0);
});

test('a duration between a time and a date, or over numbers, is refused', () => {
  const bp = onboarding();
  bp.data.fields.push(
    { key: 'in_at', type: 'time', label: 'In', required: false, classification: 'internal' },
    { key: 'on_day', type: 'date', label: 'Day', required: false, classification: 'internal' },
    { key: 'bad', type: 'calculated', label: 'Bad', classification: 'internal', compute: { op: 'duration', from: 'in_at', to: 'on_day', unit: 'hours' } },
  );
  assert.ok(validate(bp).items.some((d) => d.code === 'TYPE004'));
});

test('recording assessment scores is not a quiz; asking questions is', () => {
  const bp = onboarding();
  const training = readFileSync('evals/prompts/training-attendance.txt', 'utf8');
  assert.deepEqual(qualityDiagnostics(bp, training).map((d) => d.code), []);
  const quiz = 'A safety quiz with 10 multiple choice questions, scored as a percentage with correct answers shown.';
  assert.ok(qualityDiagnostics(bp, quiz).some((d) => d.code === 'AIQ001'));
});

test('a task may collect a choice, a yes/no or a number from the person completing it', () => {
  const bp = onboarding();
  const task = bp.workflow.tasks[0]!;
  bp.data.fields.push(
    { key: 'outcome_choice', type: 'dropdown', label: 'Outcome', required: false, classification: 'internal', setBy: 'operator', choices: [{ value: 'passed', label: 'Passed' }, { value: 'failed', label: 'Failed' }] },
    { key: 'competent', type: 'yes_no', label: 'Competent', required: false, classification: 'internal', setBy: 'operator' },
    { key: 'evidence', type: 'file', label: 'Evidence', required: false, classification: 'internal', setBy: 'operator' },
  );
  const role = bp.roles.find((r) => 'role' in task.assignee && r.key === (task.assignee as { role: string }).role)!;
  role.capabilities = [...new Set([...role.capabilities, 'edit'])] as typeof role.capabilities;
  role.editableFields = [...(role.editableFields ?? []), 'outcome_choice', 'competent', 'evidence'];
  task.requiredFields = ['outcome_choice', 'competent'];
  assert.ok(!validate(bp).items.some((d) => d.code === 'TASK001'), 'a choice and a yes/no are allowed');
  task.requiredFields = ['evidence'];
  assert.ok(validate(bp).items.some((d) => d.code === 'TASK001'), 'a file is not');
});

test('a field the runtime generates a reference into becomes system-set and leaves the form', () => {
  const bp = onboarding();
  bp.data.fields.push({ key: 'training_ref', type: 'short_text', label: 'Training ID', required: true, classification: 'internal' });
  bp.experience.pages[0]!.sections[0]!.fields.push('training_ref');
  bp.workflow.transitions[0]!.actions.push({ do: 'set_reference', key: 'ref', field: 'training_ref', prefix: 'TRN' } as never);
  const { blueprint, changes } = normalizeBlueprint(bp);
  const field = blueprint.data.fields.find((f) => f.key === 'training_ref')!;
  assert.equal(field.setBy, 'system');
  assert.ok(!blueprint.experience.pages[0]!.sections[0]!.fields.includes('training_ref'));
  assert.ok(changes.some((c) => /generated by the runtime/.test(c.change)));
});
