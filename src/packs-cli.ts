import { readFileSync } from 'node:fs';
import { createPool, describeTarget } from './runtime/db.js';
import { suppressDelivery } from './runtime/email.js';
import { listPacks, publishPack } from './runtime/packs.js';

/**
 * Publishes the reference blueprints as built-in packs.
 *
 *   npm run packs                 publish the catalogue
 *   npm run packs -- --list       show what is there
 *
 * The three reference processes are already hand-compiled, already carry
 * scenarios, and already compile clean — which is exactly what a pack has to
 * be. Making them packs rather than writing new ones means the catalogue is
 * made of processes that have been run, not of examples written to look good.
 */

const CATALOGUE = [
  {
    file: 'processes/employee-onboarding.blueprint.json',
    packKey: 'employee_onboarding',
    name: 'Employee onboarding',
    category: 'People',
    summary:
      'A new hire submits their details, their manager and HR approve in sequence, IT provisions equipment and accounts, and a welcome packet is generated and sent.',
    audience: 'HR teams onboarding employees and contractors, where payroll and right-to-work data has to be collected once and seen by different people.',
  },
  {
    file: 'processes/expense-approval.blueprint.json',
    packKey: 'expense_approval',
    name: 'Expense approval',
    category: 'Finance',
    summary:
      'An employee claims an expense, the amount decides who approves it, and finance is notified when it is cleared for payment.',
    audience: 'Finance teams who need an approval threshold that changes with the amount, and a record of who approved what.',
  },
  {
    file: 'processes/church-worker-onboarding.blueprint.json',
    packKey: 'volunteer_safeguarding',
    name: 'Volunteer onboarding with safeguarding',
    category: 'Safeguarding',
    summary:
      'A volunteer applies, references are taken, a background check is recorded, and nobody is cleared to start until the safeguarding task is complete.',
    audience: 'Churches, schools and charities where a volunteer must not begin before a check has been signed off by a named person.',
  },
];

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

async function main(): Promise<void> {
  suppressDelivery('publishing packs sends nothing');
  const pool = createPool(4);

  if (process.argv.includes('--list')) {
    const { rows } = await pool.query(
      `select pack_key, version, name, category, contents from pack
        where tenant_id is null and withdrawn_at is null order by category, pack_key`,
    );
    console.log(`\n${BOLD}Built-in packs${OFF} ${DIM}- ${describeTarget()}${OFF}\n`);
    for (const p of rows as Record<string, never>[]) {
      const c = p.contents as unknown as Record<string, number & Record<string, unknown>>;
      console.log(`  ${BOLD}${p.name}${OFF} ${DIM}${p.pack_key} v${p.version} · ${p.category}${OFF}`);
      console.log(
        `    ${DIM}${c.fields} fields · ${c.states} states · ${c.approvals} approvals · ${c.tasks} tasks · ` +
          `${c.emails} messages · ${c.documents} documents · ${c.metrics} metrics · ${c.scenarios} scenarios${OFF}`,
      );
    }
    console.log('');
    await pool.end();
    return;
  }

  console.log(`\n${BOLD}Publishing built-in packs${OFF} ${DIM}- ${describeTarget()}${OFF}`);
  console.log(`${DIM}Each one is compiled first. A pack that does not compile is not published.${OFF}\n`);

  let failed = 0;
  for (const entry of CATALOGUE) {
    try {
      const blueprint = JSON.parse(readFileSync(entry.file, 'utf8'));
      const result = await publishPack(pool, {
        principal: 'system',
        packKey: entry.packKey,
        name: entry.name,
        summary: entry.summary,
        category: entry.category,
        audience: entry.audience,
        blueprint,
        builtIn: true,
      });
      console.log(`  ${GREEN}published${OFF} ${BOLD}${entry.name}${OFF} ${DIM}v${result.version}${OFF}`);
      for (const w of result.diagnostics) {
        console.log(`    ${YELLOW}${w.code}${OFF} ${DIM}${w.message}${OFF}`);
      }
    } catch (err) {
      failed++;
      console.log(`  ${RED}refused${OFF}  ${BOLD}${entry.name}${OFF}`);
      console.log(`    ${RED}${err instanceof Error ? err.message : String(err)}${OFF}`);
    }
  }

  console.log(
    failed ? `\n${RED}${failed} pack(s) refused${OFF}\n` : `\n${GREEN}${CATALOGUE.length} packs published${OFF}\n`,
  );
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${RED}${err instanceof Error ? err.message : String(err)}${OFF}\n`);
  process.exit(1);
});
