import { readFileSync } from 'node:fs';
import { Blueprint } from '../blueprint/index.js';
import type { Pool } from '../runtime/db.js';
import { publishPack } from '../runtime/packs.js';
import { CATALOGUE } from './catalogue.js';
import { buildBlueprint } from './generate.js';

export const REFERENCES = [
  {
    file: 'employee-onboarding.blueprint.json',
    key: 'employee_onboarding',
    name: 'Employee onboarding',
    category: 'People',
    summary: 'A new hire submits their details, their manager and HR approve in sequence, IT provisions equipment and accounts, and a welcome packet is generated and sent.',
    audience: 'HR teams onboarding employees and contractors, where payroll and right-to-work data has to be collected once and seen by different people.',
  },
  {
    file: 'expense-approval.blueprint.json',
    key: 'expense_approval',
    name: 'Expense approval',
    category: 'Finance',
    summary: 'An employee claims an expense, the amount decides who approves it, and finance is notified when it is cleared for payment.',
    audience: 'Finance teams who need an approval threshold that changes with the amount, and a record of who approved what.',
  },
  {
    file: 'church-worker-onboarding.blueprint.json',
    key: 'volunteer_safeguarding',
    name: 'Volunteer onboarding with safeguarding',
    category: 'Safeguarding',
    summary: 'A volunteer applies, references are taken, a background check is recorded, and nobody is cleared to start until the safeguarding task is complete.',
    audience: 'Churches, schools and charities where a volunteer must not begin before a check has been signed off by a named person.',
  },
] as const;

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

/** Publish only missing or changed built-in packs. Existing installs are never edited. */
export async function syncBuiltInPacks(pool: Pool): Promise<{ published: number; total: number }> {
  // The old and new Render instances can briefly run together during a deploy.
  // Hold a database lock so both cannot choose the same next pack version.
  const lock = await pool.connect();
  let published = 0;
  let locked = false;
  try {
    await lock.query("select pg_advisory_lock(hashtext('patform:built-in-packs'))");
    locked = true;
    const specs = [
      ...CATALOGUE.map((spec) => ({
        key: spec.key, name: spec.name, summary: spec.summary,
        category: spec.category, audience: spec.audience,
        blueprint: Blueprint.parse(buildBlueprint(spec)),
      })),
      ...REFERENCES.map((spec) => ({
        key: spec.key, name: spec.name, summary: spec.summary,
        category: spec.category, audience: spec.audience,
        blueprint: Blueprint.parse(JSON.parse(readFileSync(`processes/${spec.file}`, 'utf8'))),
      })),
    ];
    for (const spec of specs) {
      const { rows } = await pool.query<{ blueprint: unknown }>(
        `select blueprint from pack where pack_key = $1 and tenant_id is null
          and withdrawn_at is null order by version desc limit 1`,
        [spec.key],
      );
      if (rows[0] && canonical(Blueprint.parse(rows[0].blueprint)) === canonical(spec.blueprint)) continue;
      await publishPack(pool, {
        principal: 'system', packKey: spec.key, name: spec.name,
        summary: spec.summary, category: spec.category, audience: spec.audience,
        blueprint: spec.blueprint, builtIn: true,
      });
      published++;
    }
    return { published, total: specs.length };
  } finally {
    try {
      if (locked) await lock.query("select pg_advisory_unlock(hashtext('patform:built-in-packs'))");
    } finally {
      lock.release();
    }
  }
}
