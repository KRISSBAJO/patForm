import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { earlierEvidence } from '../src/runtime/evidence-history.js';

test('prior correction photos remain available, but hidden photos stay hidden', () => {
  const bp = Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json', 'utf8')));
  bp.data.fields.push({ key: 'defects', label: 'Defects', type: 'repeating_group', setBy: 'respondent', classification: 'internal', fields: [
    { key: 'after_photo', label: 'After photo', type: 'file', setBy: 'operator', classification: 'confidential' },
    { key: 'private_photo', label: 'Private photo', type: 'file', setBy: 'operator', classification: 'restricted' },
  ] });
  const role = bp.roles.find(r => r.key === 'it_operator')!;
  role.hiddenFields = [...role.hiddenFields ?? [], 'private_photo'];
  const one = 'receipt-file:00000000-0000-4000-8000-000000000001';
  const two = 'receipt-file:00000000-0000-4000-8000-000000000002';
  const secret = 'receipt-file:00000000-0000-4000-8000-000000000003';
  const history = earlierEvidence(bp, ['it_operator'], 'member', { defects: [{ after_photo: two }] }, [
    { type: 'record_updated', payload: { task: 'reinspect', previous: { defects: [{ after_photo: one, private_photo: secret }] } }, occurred_at: '2026-09-27T12:00:00Z' },
    { type: 'record_updated', payload: { task: 'correct', previous: { defects: [{ after_photo: one }] } }, occurred_at: '2026-09-27T11:00:00Z' },
  ]);
  assert.deepEqual(history.map(item => item.id), [one.slice('receipt-file:'.length)]);
  assert.equal(history[0]?.row, 1);
  assert.equal(history[0]?.task, 'reinspect');
});
