import { createPool } from './runtime/db.js';
import { Engine } from './runtime/engine.js';
import { runRetention } from './runtime/retention.js';

/**
 * Runs a retention pass. Previews by default: `--apply` is the only way to
 * delete anything, because a deletion job whose dry run is opt-in is a
 * deletion job that will one day be run by accident.
 */
async function main(): Promise<void> {
  const [processKey, email] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');
  if (!processKey || !email) {
    console.error('usage: npm run retention -- <process_key> <admin@email> [--apply]');
    process.exit(2);
  }

  const pool = createPool(4);
  const engine = new Engine(pool);

  const { rows } = await pool.query<{ id: string; tenant_id: string }>(
    'select id, tenant_id from actor where lower(email) = lower($1)',
    [email],
  );
  if (!rows.length) {
    console.error(`no actor with email ${email}`);
    process.exit(1);
  }
  const actor = rows[0]!;
  void engine;

  const result = await runRetention(pool, {
    principal: { kind: 'actor', tenantId: actor.tenant_id, actorId: actor.id },
    tenantId: actor.tenant_id,
    processKey,
    preview: !apply,
  });

  console.log(`\n  ${result.preview ? 'Would delete' : 'Deleted'} from "${result.processKey}"`);
  console.log(`  retention   ${result.retentionDays} days`);
  console.log(`  records     ${result.instances}`);
  console.log(`  events      ${result.events}`);
  if (result.oldest) console.log(`  completed   ${result.oldest.slice(0, 10)} to ${result.newest?.slice(0, 10)}`);
  if (result.preview) console.log(`\n  Nothing was removed. Add --apply to run it.\n`);
  else console.log('');

  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
