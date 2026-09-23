import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE } from '../src/packs/catalogue.js';
import { RULES } from '../src/packs/rules.js';
import { REFERENCES } from '../src/packs/sync-builtins.js';

test('every category offers at least five distinct process templates', () => {
  const keys = new Set<string>();
  for (const pack of CATALOGUE) {
    assert.ok(!keys.has(pack.key), `duplicate template key: ${pack.key}`);
    keys.add(pack.key);
  }
  const categories = new Set([...Object.keys(RULES), ...REFERENCES.map((reference) => reference.category)]);
  for (const category of categories) {
    const packs = CATALOGUE.filter((pack) => pack.category === category);
    const count = packs.length + REFERENCES.filter((reference) => reference.category === category).length;
    assert.ok(count >= 5, `${category} has only ${count} templates`);
    for (const pack of packs) {
      assert.ok(pack.task?.requiredFields?.length, `${pack.key} has no completion evidence`);
      assert.ok(pack.fields.some((field) => field.setBy !== 'operator'), `${pack.key} has no respondent questions`);
    }
  }
});
