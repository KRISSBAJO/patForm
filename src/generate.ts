import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { availableProviders, blueprintSchema, generateBlueprint, providerFor, type ProviderName } from './ai/index.js';
import { createPool } from './runtime/db.js';
import type { Pool } from './runtime/db.js';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

function usage(): never {
  console.error(`usage: npm run generate -- "<process description>" [options]

  --provider <anthropic|openai>   default: the first one with a key set
  --model <id>                    override the provider's default model
  --pack <name>                   bias the proposal towards a process pack
  --run                           also run the blueprint's scenarios against Postgres
  --out <path>                    write the blueprint here when it compiles

Available providers: ${availableProviders().join(', ') || 'none — no API key is set'}`);
  process.exit(2);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const description = process.argv[2];
  if (!description || description.startsWith('--')) usage();

  const available = availableProviders();
  if (!available.length) usage();

  const providerName = (flag('provider') ?? available[0]!) as ProviderName;
  const provider = providerFor(providerName, flag('model'));

  let pool: Pool | undefined;
  if (process.argv.includes('--run')) pool = createPool(8);

  console.log(`\n${BOLD}Generating a process blueprint${OFF}`);
  console.log(`${DIM}${provider.name} · ${provider.model}${OFF}\n`);
  console.log(`${DIM}"${description.length > 160 ? `${description.slice(0, 160)}…` : description}"${OFF}\n`);

  const outcome = await generateBlueprint(provider, blueprintSchema(), {
    description,
    pack: flag('pack'),
    pool,
  });

  for (const attempt of outcome.attempts) {
    const label = attempt.attempt === 1 ? 'first attempt' : `repair ${attempt.attempt - 1}`;
    const tokens = `${attempt.meta.inputTokens ?? '?'} in / ${attempt.meta.outputTokens ?? '?'} out`;
    console.log(
      `  ${BOLD}${label}${OFF} ${DIM}· ${attempt.meta.mode} · ${(attempt.meta.latencyMs / 1000).toFixed(1)}s · ${tokens}${OFF}`,
    );

    if (!attempt.shapeOk) {
      console.log(`    ${RED}not a blueprint${OFF}`);
      for (const issue of attempt.shapeIssues.slice(0, 6)) console.log(`      ${DIM}${issue}${OFF}`);
      continue;
    }

    if (!attempt.errors.length && !attempt.warnings.length) {
      console.log(`    ${GREEN}compiles clean${OFF}`);
      continue;
    }
    for (const d of attempt.errors.slice(0, 10)) {
      console.log(`    ${RED}error  ${OFF} ${BOLD}${d.code}${OFF} ${d.message} ${DIM}(${d.at})${OFF}`);
    }
    for (const d of attempt.warnings.slice(0, 6)) {
      console.log(`    ${YELLOW}warning${OFF} ${BOLD}${d.code}${OFF} ${d.message} ${DIM}(${d.at})${OFF}`);
    }
  }

  if (outcome.scenarios) {
    const passed = outcome.scenarios.filter((s) => s.passed).length;
    console.log(
      `\n  ${BOLD}scenarios${OFF} ${DIM}·${OFF} ${passed === outcome.scenarios.length ? GREEN : RED}${passed}/${outcome.scenarios.length} passed${OFF}`,
    );
    for (const s of outcome.scenarios.filter((x) => !x.passed)) {
      console.log(`    ${RED}${s.kind}/${s.test}${OFF}: ${s.failures.join('; ')}`);
    }
  }

  const { audit } = outcome;
  const cost = audit.totalCostUsd === undefined ? 'cost not configured' : `$${audit.totalCostUsd.toFixed(4)}`;
  console.log(
    `\n  ${DIM}${audit.promptVersion} · ${audit.repairs} repair(s) · ${(audit.durationMs / 1000).toFixed(1)}s · ` +
      `${audit.totalInputTokens} in / ${audit.totalOutputTokens} out · ${cost}${OFF}`,
  );

  switch (outcome.decision) {
    case 'publishable': {
      console.log(`\n  ${GREEN}${BOLD}publishable${OFF} — the compiler and its own scenarios both accept it.\n`);
      const out = flag('out') ?? join('output', `${outcome.blueprint!.key}.blueprint.json`);
      mkdirSync(join(out, '..'), { recursive: true });
      writeFileSync(out, `${JSON.stringify(outcome.blueprint, null, 2)}\n`);
      console.log(`  ${DIM}written to ${out}${OFF}\n`);
      break;
    }
    case 'blocked':
      console.log(`\n  ${RED}${BOLD}blocked${OFF} — ${outcome.diagnostics.filter((d) => d.severity === 'error').length} error(s) survived the repair attempt. Not publishable.\n`);
      break;
    case 'unparseable':
      console.log(`\n  ${RED}${BOLD}unparseable${OFF} — the model never returned something shaped like a blueprint.\n`);
      break;
    case 'refused':
      console.log(`\n  ${YELLOW}${BOLD}refused${OFF} — the provider declined this request.\n`);
      break;
  }

  await pool?.end();
  process.exit(outcome.decision === 'publishable' ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
