import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Blueprint } from '../src/blueprint/index.js';
import { qualityDiagnostics } from '../src/compiler/quality.js';
import { validate } from '../src/compiler/validate.js';
import { generateBlueprint } from '../src/ai/pipeline.js';
import { blueprintSchema } from '../src/ai/index.js';
import type { Provider } from '../src/ai/provider.js';

const request = 'Create an Exodus quiz with 10 multiple-choice questions. Each question should have four answer options and one correct answer. Automatically calculate the score and final percentage.';

function quiz() {
  const bp = Blueprint.parse(JSON.parse(readFileSync(new URL('../processes/expense-approval.blueprint.json', import.meta.url), 'utf8')));
  bp.name = 'Exodus quiz';
  bp.description = request;
  bp.intent.assumptions = [{ statement: 'The respondent may complete the quiz once.', affects: 'workflow' }];
  for (let index = 1; index <= 10; index++) {
    const key = `q${index}_answer`;
    bp.data.fields.push({ key, label: `${index}. What happened in Exodus?`, type: 'single_choice',
      classification: 'internal', required: true, correctValue: 'a',
      choices: ['a', 'b', 'c', 'd'].map((value) => ({ value, label: `Answer ${value}` })) });
    bp.experience.pages[0]!.sections[0]!.fields.push(key);
  }
  return bp;
}

test('a scored quiz request checks exact question and option counts, every answer key, and result placeholders', () => {
  const bp = quiz();
  bp.data.fields = bp.data.fields.filter((field) => field.key !== 'q10_answer');
  bp.data.fields.find((field) => field.key === 'q1_answer')!.correctValue = undefined;
  bp.data.fields.find((field) => field.key === 'q2_answer')!.choices!.pop();
  bp.data.fields.push({ key: 'score', label: 'Score', type: 'calculated', classification: 'internal',
    setBy: 'system', compute: { op: 'add', operands: [{ literal: 0 }, { literal: 0 }] } });
  const codes = new Set(qualityDiagnostics(bp, request).map((item) => item.code));
  assert.deepEqual([...codes].sort(), ['AIQ002', 'AIQ003', 'AIQ004', 'AIQ006']);
  assert.equal(validate(bp, request).publishable, false);
});

test('a missing quiz answer key is sent through the AI repair turn', async () => {
  const fixed = quiz();
  const broken = structuredClone(fixed);
  delete broken.data.fields.find((field) => field.key === 'q1_answer')!.correctValue;
  let calls = 0;
  const provider: Provider = { name: 'fixture', model: 'fixture', async generate(input) {
    calls++;
    if (calls === 2) assert.match(input.user, /Quiz question.*has no correct answer/);
    const parsed = calls === 1 ? broken : fixed;
    return { text: JSON.stringify(parsed), parsed,
      meta: { provider: 'fixture', model: 'fixture', mode: 'structured', latencyMs: 1 } };
  } };
  const result = await generateBlueprint(provider, blueprintSchema(), { description: request, maxRepairs: 1 });
  assert.equal(calls, 2);
  assert.equal(result.decision, 'publishable', JSON.stringify(result.diagnostics));
  assert.equal(result.blueprint?.data.fields.filter((field) => field.correctValue).length, 10);
});
