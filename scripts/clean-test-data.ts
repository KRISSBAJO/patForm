/**
 * Removes what the automated checks leave behind in a development workspace.
 *
 *   npm run clean:test-data
 *
 * The accessibility scan mints an invitation and a throwaway account on every
 * run, and until this nothing removed them: a workspace that had been scanned
 * eleven times showed eleven invitations waiting and a dozen "Scan Fixture"
 * members. Screenshots and dry runs leave drafts behind too. Everything here
 * is recognisable by name and was made by a script; nothing a person made is
 * touched.
 */
import { createPool, describeTarget } from '../src/runtime/db.js';
import { suppressDelivery } from '../src/runtime/email.js';

const SCAN_INVITE = 'a11y+%@example.test';
const SCAN_ACTOR = 'a11y-spare+%@example.test';
/** Drafts that scripts create under keys nobody would type. */
const SCRIPT_DRAFTS = ['zz\\_%', '%\\_qa', '%\\_test'];

export async function cleanTestData(pool: ReturnType<typeof createPool>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const client = await pool.connect();
  try {
    await client.query('begin');

    const inv = await client.query('delete from invitation where email like $1', [SCAN_INVITE]);
    out.invitations = inv.rowCount ?? 0;

    const { rows: actors } = await client.query<{ id: string }>('select id from actor where email like $1', [SCAN_ACTOR]);
    const ids = actors.map((a) => a.id);
    if (ids.length) {
      // Nothing of theirs is worth keeping: they existed to spend two links.
      for (const table of [
        'auth_token',
        'session',
        'credential',
        'membership',
        'actor_identity',
        'mfa_challenge',
        'mfa_recovery_code',
        'mfa_enrolment',
        'platform_email',
        'copilot_run',
      ]) {
        await client.query(`delete from ${table} where actor_id = any($1::uuid[])`, [ids]);
      }
      const gone = await client.query('delete from actor where id = any($1::uuid[])', [ids]);
      out.scanAccounts = gone.rowCount ?? 0;
    } else {
      out.scanAccounts = 0;
    }

    const drafts = await client.query(
      `delete from process_draft
        where published_as is null and (${SCRIPT_DRAFTS.map((_, i) => `process_key like $${i + 1}`).join(' or ')})`,
      SCRIPT_DRAFTS,
    );
    out.drafts = drafts.rowCount ?? 0;

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  return out;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/clean-test-data.ts');
if (isMain) {
  suppressDelivery('cleaning up sends nothing');
  const pool = createPool(2);
  console.log(`Cleaning test data - ${describeTarget()}`);
  const done = await cleanTestData(pool);
  console.log(`  removed ${done.invitations} scan invitation(s), ${done.scanAccounts} scan account(s), ${done.drafts} script draft(s)`);
  await pool.end();
}
