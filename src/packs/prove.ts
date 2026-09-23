import { Blueprint } from '../blueprint/index.js';
import { CATALOGUE } from './catalogue.js';
import { buildBlueprint } from './generate.js';
import { createPool, resetSchema } from '../runtime/db.js';
import { runScenarios } from '../runtime/scenarios.js';
import { suppressDelivery } from '../runtime/email.js';

const proofUrl = process.env.PROOF_DATABASE_URL;
if (!proofUrl || proofUrl === process.env.DATABASE_URL || !new URL(proofUrl).pathname.includes('proof')) {
  throw new Error('Set PROOF_DATABASE_URL to a separate proof database before running catalogue scenarios.');
}

suppressDelivery('catalogue scenarios must not deliver to real inboxes');
const pool = createPool(16, proofUrl);
const selected = new Set(process.argv.slice(2));
const specs = selected.size ? CATALOGUE.filter((spec) => selected.has(spec.key)) : CATALOGUE;
if (selected.size && specs.length !== selected.size) throw new Error('An unknown pack key was selected.');
let total = 0;
let failures = 0;

try {
  await resetSchema(pool);
  for (const spec of specs) {
    const results = await runScenarios(pool, Blueprint.parse(buildBlueprint(spec)));
    total += results.length;
    for (const result of results.filter((item) => !item.passed)) {
      failures++;
      console.error(`${result.process}/${result.test}: ${result.failures.join('; ')}`);
    }
  }
  console.log(`${total - failures}/${total} scenarios passed across ${specs.length} generated templates.`);
  if (failures) process.exitCode = 1;
} finally {
  await pool.end();
}
