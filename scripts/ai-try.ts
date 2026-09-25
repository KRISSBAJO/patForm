/**
 * Runs one description through the same pipeline "Build with AI" uses, and
 * says exactly what came back: the decision, every attempt's errors, and the
 * blueprint itself, saved for reading.
 *
 *   npm run ai:try -- evals/prompts/training-attendance.txt
 *   AI_PROVIDER=anthropic MAX_REPAIRS=2 npm run ai:try -- <file>
 *
 * Scenarios run against PROOF_DATABASE_URL when it is set, so a trial never
 * leaves scratch tenants in the workspace database.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { blueprintSchema, generateBlueprint, preferredProvider, type ProviderName } from '../src/ai/index.js';
import { createPool } from '../src/runtime/db.js';
import { suppressDelivery } from '../src/runtime/email.js';

const file = process.argv[2];
if (!file) throw new Error('give the path of a file holding the description');
const description = readFileSync(file, 'utf8').trim();
suppressDelivery('a trial sends nothing');

const provider = preferredProvider(process.env.AI_PROVIDER as ProviderName | undefined);
const pool = createPool(4, process.env.PROOF_DATABASE_URL || undefined);
const started = Date.now();
console.log(`provider ${provider.name} (${provider.model}), repairs allowed: ${process.env.MAX_REPAIRS ?? 1}`);

const outcome = await generateBlueprint(provider, blueprintSchema(), {
  description,
  pool,
  maxRepairs: Number(process.env.MAX_REPAIRS ?? 1),
  onProgress: async (stage) => console.log(`  ${Math.round((Date.now() - started) / 1000)}s ${stage}`),
});

console.log(`\ndecision: ${outcome.decision} after ${outcome.attempts.length} attempt(s), ${Math.round(outcome.audit.durationMs / 1000)}s, ` +
  `${outcome.audit.totalInputTokens} in / ${outcome.audit.totalOutputTokens} out${outcome.audit.totalCostUsd !== undefined ? `, $${outcome.audit.totalCostUsd.toFixed(3)}` : ''}`);
for (const a of outcome.attempts) {
  console.log(`\nattempt ${a.attempt}: ${a.meta.model} shape ${a.shapeOk ? 'ok' : 'BAD'}, ${a.errors.length} errors, ${a.warnings.length} warnings`);
  for (const s of a.shapeIssues.slice(0, 12)) console.log(`  shape: ${s}`);
  for (const e of a.errors) console.log(`  [${e.code}] ${e.at}: ${e.message}`);
}
const failed = (outcome.scenarios ?? []).filter((s) => !s.passed);
if (outcome.scenarios) console.log(`\nscenarios: ${outcome.scenarios.length - failed.length}/${outcome.scenarios.length} passed`);
for (const s of failed) console.log(`  ${s.test} (${s.kind}): ${s.failures.join('; ')}`);

const bp = outcome.blueprint ?? outcome.reviewable?.blueprint ?? outcome.editable?.blueprint;
mkdirSync('output/ai', { recursive: true });
const out = `output/ai/${basename(file).replace(/\.\w+$/, '')}-${provider.name}-${Date.now()}.json`;
writeFileSync(out, JSON.stringify({ outcome: { ...outcome, blueprint: undefined, reviewable: undefined, editable: undefined }, blueprint: bp }, null, 1));
if (bp) {
  console.log(`\nblueprint: ${bp.data.fields.length} fields, ${bp.workflow.states.length} states, ${bp.workflow.transitions.length} transitions, ` +
    `${bp.workflow.approvals.length} approvals, ${bp.workflow.tasks.length} tasks, ${bp.communications.email.length} emails, ${bp.tests.length} tests`);
}
console.log(`saved ${out}`);
await pool.end();
