import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Pool } from '../src/runtime/db.js';
import { aiDraftStatus, queueAiDraft, revisionCandidate } from '../src/runtime/ai-drafts.js';
import { generateBlueprint, type GenerationOutcome } from '../src/ai/pipeline.js';
import { blueprintSchema } from '../src/ai/index.js';
import type { Provider } from '../src/ai/provider.js';

test('an AI draft job cannot be read outside its creator and workspace', async () => {
  const queries: { sql: string; params: unknown[] | undefined }[] = [];
  const pool = { query: async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    return { rows: [] };
  } } as unknown as Pool;
  await assert.rejects(aiDraftStatus(pool, { kind: 'actor', tenantId: 'other-workspace', actorId: 'other-person' }, 'job-id'),
    /Draft job not found/);
  assert.match(queries[0]!.sql, /j\.tenant_id = \$2 and j\.actor_id = \$3/);
  assert.deepEqual(queries[0]!.params, ['job-id', 'other-workspace', 'other-person']);
});

test('AI creation refuses oversized prompts before storing them', async () => {
  const pool = { query: async () => { throw new Error('database should not be touched'); } } as unknown as Pool;
  await assert.rejects(queueAiDraft(pool, { kind: 'actor', tenantId: 'workspace', actorId: 'person' },
    { key: 'long_prompt', description: 'x'.repeat(8001) }), /8,000 characters/);
});

test('shape-valid AI output with compiler errors remains an editable private draft', async () => {
  const broken = JSON.parse(readFileSync(new URL('../processes/_broken-example.blueprint.json', import.meta.url), 'utf8'));
  const provider: Provider = {
    name: 'fixture', model: 'fixture',
    async generate() { return { text: JSON.stringify(broken), parsed: broken,
      meta: { provider: 'fixture', model: 'fixture', mode: 'structured', latencyMs: 1 } }; },
  };
  const result = await generateBlueprint(provider, blueprintSchema(), { description: 'Create a review process.', maxRepairs: 0 });
  assert.equal(result.decision, 'blocked');
  assert.equal(result.blueprint, undefined);
  assert.ok(result.editable?.errors.length);
  assert.equal(result.editable?.blueprint.key, 'broken_example');
});

test('shape repair sees the full prior blueprint, including its last fields', async () => {
  const broken = JSON.parse(readFileSync(new URL('../processes/_broken-example.blueprint.json', import.meta.url), 'utf8'));
  const marker = 'FINAL_FIELD_TO_REPAIR';
  let calls = 0;
  const provider: Provider = {
    name: 'fixture', model: 'fixture',
    async generate(request) {
      calls += 1;
      if (calls === 2) assert.ok(request.user.includes(marker));
      const parsed = calls === 1 ? { padding: 'x'.repeat(2500), last_field: marker } : broken;
      return { text: JSON.stringify(parsed), parsed,
        meta: { provider: 'fixture', model: 'fixture', mode: 'structured', latencyMs: 1 } };
    },
  };
  const result = await generateBlueprint(provider, blueprintSchema(), { description: 'Create a review process.', maxRepairs: 1 });
  assert.equal(calls, 2);
  assert.ok(result.editable);
});

test('AI revision receives the selected blueprint and a request to preserve existing behavior', async () => {
  const source = JSON.parse(readFileSync(new URL('../processes/expense-approval.blueprint.json', import.meta.url), 'utf8'));
  let seen = false;
  const provider: Provider = {
    name: 'fixture', model: 'fixture',
    async generate(request) {
      assert.match(request.user, /Revise the EXISTING process blueprint/);
      assert.match(request.user, /Keep the same root key, preserve existing fields/);
      assert.ok(request.user.includes(`"key":"${source.key}"`));
      assert.ok(request.user.includes('Add a finance review above 2500'));
      seen = true;
      return { text: JSON.stringify(source), parsed: source,
        meta: { provider: 'fixture', model: 'fixture', mode: 'structured', latencyMs: 1 } };
    },
  };
  await generateBlueprint(provider, blueprintSchema(), {
    description: 'Add a finance review above 2500', sourceBlueprint: source, maxRepairs: 0,
  });
  assert.ok(seen);
});

test('revision fallback prefers a checked blueprint to one with compiler errors', () => {
  const blueprint = JSON.parse(readFileSync(new URL('../processes/expense-approval.blueprint.json', import.meta.url), 'utf8'));
  const editable = revisionCandidate({ editable: { blueprint, errors: [{ code: 'FLOW004', severity: 'error', at: 'workflow.states', message: 'Invalid transition' }] } } as GenerationOutcome);
  const checked = revisionCandidate({ blueprint } as GenerationOutcome);
  assert.ok(editable);
  assert.ok(checked);
  assert.ok(checked.score > editable.score);
});
