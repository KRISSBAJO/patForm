import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blueprint } from '../src/blueprint/index.js';
import { missingRequiredFields, validateAnswers } from '../src/blueprint/answers.js';
import { CATALOGUE } from '../src/packs/catalogue.js';
import { buildBlueprint } from '../src/packs/generate.js';

/**
 * A required question in a section the form is not showing is not missing.
 *
 * The volunteer application asks about background checks only when the role
 * involves children or vulnerable adults. With that answered "no", nothing in
 * that section can be required, whatever else the answers say.
 */
const bp = () => Blueprint.parse(buildBlueprint(CATALOGUE.find((s) => s.key === 'volunteer_application')!));
const base = () => bp().tests[0]!.steps[0]!.answers as Record<string, unknown>;

test('a hidden section asks for nothing, even when a stray answer would trigger a condition inside it', () => {
  const answers = { ...base(), children_or_vulnerable_adults: false, has_check: true };
  const missing = missingRequiredFields(bp(), answers);
  assert.deepEqual(missing, []);
  assert.deepEqual(validateAnswers(bp(), answers), []);
});

test('the same section, shown, asks for what it requires', () => {
  const answers = { ...base(), children_or_vulnerable_adults: true, has_check: true };
  const missing = missingRequiredFields(bp(), answers);
  assert.ok(missing.includes('check_issued'), `expected check_issued among ${missing.join(', ')}`);
  assert.ok(missing.includes('safeguarding_training'));
  // The page check and the submission check agree.
  const fromPages = validateAnswers(bp(), answers).map((e) => e.field).sort();
  assert.deepEqual([...missing].sort(), fromPages);
});

test('an ordinary required answer is still missing when blank', () => {
  const answers = { ...base(), commitment: '' };
  assert.ok(missingRequiredFields(bp(), answers).includes('commitment'));
});
