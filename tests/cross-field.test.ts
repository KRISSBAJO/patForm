import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blueprint } from '../src/blueprint/index.js';
import { validateAnswers } from '../src/blueprint/answers.js';
import { validate } from '../src/compiler/validate.js';
import { CATALOGUE } from '../src/packs/catalogue.js';
import { buildBlueprint } from '../src/packs/generate.js';

/**
 * One date not before another, one amount not above another.
 *
 * The commonest real mistake on a leave form is an end date before the start;
 * on a discount form, a "discounted" price above the list price. Neither was
 * expressible before: a constraint could only look at its own answer.
 */
const leave = () => Blueprint.parse(buildBlueprint(CATALOGUE.find((s) => s.key === 'leave_request')!));
const discount = () => Blueprint.parse(buildBlueprint(CATALOGUE.find((s) => s.key === 'discount_approval')!));
const sample = (bp: Blueprint) => bp.tests[0]!.steps[0]!.answers as Record<string, unknown>;

const day = (offset: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

test('leave cannot end before it starts, and may end the day it starts', () => {
  const bp = leave();
  const bad = { ...sample(bp), starts_on: day(10), ends_on: day(8) };
  const errors = validateAnswers(bp, bad);
  assert.ok(errors.some((e) => e.field === 'ends_on' && /before/i.test(e.message)), JSON.stringify(errors));
  const same = { ...sample(bp), starts_on: day(10), ends_on: day(10) };
  assert.deepEqual(validateAnswers(bp, same).filter((e) => e.field === 'ends_on'), []);
});

test('a proposed price cannot exceed the list price', () => {
  const bp = discount();
  const bad = { ...sample(bp), list_price: 100, proposed_price: 120 };
  assert.ok(validateAnswers(bp, bad).some((e) => e.field === 'proposed_price'));
  const ok = { ...sample(bp), list_price: 100, proposed_price: 90 };
  assert.deepEqual(validateAnswers(bp, ok).filter((e) => e.field === 'proposed_price'), []);
});

test('a comparison that names a missing or mistyped field does not compile', () => {
  const bp = leave();
  const ends = bp.data.fields.find((f) => f.key === 'ends_on')!;
  ends.constraints = { ...ends.constraints, notBefore: 'no_such_field' };
  assert.ok(validate(bp).errors.some((e) => e.code === 'TYPE009'), 'unknown target');
  ends.constraints = { ...ends.constraints, notBefore: 'leave_type' };
  assert.ok(validate(bp).errors.some((e) => e.code === 'TYPE009'), 'a date compared with a dropdown');
});

test('the catalogue itself passes its own comparisons', () => {
  let failures = 0;
  for (const spec of CATALOGUE) {
    const bp = Blueprint.parse(buildBlueprint(spec));
    if (validate(bp).errors.length) failures++;
    if (validateAnswers(bp, sample(bp)).length) failures++;
  }
  assert.equal(failures, 0);
});
