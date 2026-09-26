import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';

const onboarding = () => JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json', 'utf8'));

test('a form may name one of the five looks, and nothing else', () => {
  for (const style of ['classic', 'soft', 'minimal', 'rounded', 'bold']) {
    const bp = onboarding();
    bp.experience.branding = { ...(bp.experience.branding ?? {}), style };
    assert.ok(Blueprint.safeParse(bp).success, style);
  }
  const bp = onboarding();
  bp.experience.branding = { style: 'neon' };
  assert.ok(!Blueprint.safeParse(bp).success, 'an unknown look is refused');
});
