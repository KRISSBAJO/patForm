import { readFileSync } from 'node:fs';
import { createPool, describeTarget } from './runtime/db.js';
import { suppressDelivery } from './runtime/email.js';
import { listPacks, publishPack } from './runtime/packs.js';
import { CATALOGUE as GENERATED } from './packs/catalogue.js';
import { buildBlueprint } from './packs/generate.js';
import { Blueprint } from './blueprint/index.js';

/**
 * Publishes the reference blueprints as built-in packs.
 *
 *   npm run packs                 publish the catalogue
 *   npm run packs -- --list       show what is there
 *   npm run packs -- --catalogue  publish changed generated templates and the
 *                                 Finance reference process, and nothing else
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

/**
 * JSON with its keys sorted. Postgres stores jsonb with its own key order, so
 * comparing plain JSON.stringify output called every stored template changed.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );
}

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

  /*
   * The generated catalogue, brought up to date without a re-seed.
   *
   * The seed is the only thing that ever wrote these, and re-seeding a
   * development database signs everybody out. A template fixed in code was
   * therefore invisible in a running workspace until somebody accepted that.
   * This publishes a new version of each template whose generated blueprint
   * differs from the newest one stored, and leaves the rest alone, so running
   * it twice publishes nothing the second time. Workspaces that installed an
   * older version keep it, and are told a newer one exists.
   */
  if (process.argv.includes('--catalogue')) {
    console.log(`\n${BOLD}Updating generated templates${OFF} ${DIM}- ${describeTarget()}${OFF}\n`);
    let published = 0;
    for (const spec of GENERATED) {
      const blueprint = Blueprint.parse(buildBlueprint(spec));
      const { rows } = await pool.query<{ blueprint: unknown }>(
        `select blueprint from pack where pack_key = $1 and tenant_id is null
          order by version desc limit 1`,
        [spec.key],
      );
      if (rows[0] && canonical(Blueprint.parse(rows[0].blueprint)) === canonical(blueprint)) continue;
      const result = await publishPack(pool, {
        principal: 'system',
        packKey: spec.key,
        name: spec.name,
        summary: spec.summary,
        category: spec.category,
        audience: spec.audience,
        blueprint,
        builtIn: true,
      });
      published++;
      console.log(`  ${GREEN}published${OFF} ${BOLD}${spec.name}${OFF} ${DIM}v${result.version}${OFF}`);
    }
    // The hand-built Expense Approval pack is also in Finance. Keep its card in
    // step with its blueprint without republishing unrelated reference packs.
    const reference = CATALOGUE.find((item) => item.packKey === 'expense_approval')!;
    const referenceBlueprint = Blueprint.parse(JSON.parse(readFileSync(reference.file, 'utf8')));
    const { rows: referenceRows } = await pool.query<{ blueprint: unknown }>(
      `select blueprint from pack where pack_key = $1 and tenant_id is null order by version desc limit 1`,
      [reference.packKey],
    );
    if (!referenceRows[0] || canonical(Blueprint.parse(referenceRows[0].blueprint)) !== canonical(referenceBlueprint)) {
      const result = await publishPack(pool, {
        principal: 'system', packKey: reference.packKey, name: reference.name,
        summary: reference.summary, category: reference.category, audience: reference.audience,
        blueprint: referenceBlueprint, builtIn: true,
      });
      published++;
      console.log(`  ${GREEN}published${OFF} ${BOLD}${reference.name}${OFF} ${DIM}v${result.version}${OFF}`);
    }
    console.log(`\n${published ? GREEN : DIM}${published} of ${GENERATED.length + 1} Finance and generated templates changed${OFF}\n`);
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
