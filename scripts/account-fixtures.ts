/**
 * Live links for the accessibility scan, and the account state it needs.
 *
 * The three account pages cannot be audited from a static URL: each one is
 * driven by a single-use token, and a page holding an expired token renders a
 * different, much simpler screen than the one people actually see. So the scan
 * mints real tokens first.
 *
 * Delivery is suppressed before anything else happens. This reads the same
 * `.env` as the server, and without the guard every scan would post three
 * messages to a transactional provider.
 *
 *   npm run a11y:fixtures            mint, and clear the scan account's
 *                                    verification so the banner is on screen
 *   npm run a11y:fixtures restore    put the verification back
 */

import { suppressDelivery } from '../src/runtime/email.js';

suppressDelivery('minting fixtures for the accessibility scan');

const { createPool } = await import('../src/runtime/db.js');
const { requestPasswordReset, sendVerification } = await import('../src/runtime/account.js');
const { invite } = await import('../src/runtime/workspace.js');

const SCAN_EMAIL = process.env.A11Y_EMAIL ?? 'joy@example.test';

const pool = createPool();

async function actorFor(email: string) {
  const { rows } = await pool.query<{ id: string; tenant_id: string }>(
    'select id, tenant_id from actor where lower(email) = lower($1)',
    [email],
  );
  if (!rows[0]) throw new Error(`no seeded account for ${email} — run npm run seed first`);
  return rows[0];
}

if (process.argv[2] === 'restore') {
  await pool.query('update actor set email_verified_at = now() where lower(email) = lower($1)', [SCAN_EMAIL]);
  console.log('restored');
} else {
  const scan = await actorFor(SCAN_EMAIL);

  // An owner who is still verified, so the invitation can actually be issued.
  const { rows: owners } = await pool.query<{ id: string; tenant_id: string }>(
    `select id, tenant_id from actor
      where workspace_role = 'owner' and active and email_verified_at is not null
        and lower(email) <> lower($1)
      order by created_at limit 1`,
    [SCAN_EMAIL],
  );
  const owner = owners[0] ?? scan;

  const invitation = await invite(pool, {
    principal: { kind: 'actor', tenantId: owner.tenant_id, actorId: owner.id },
    email: `a11y+${Date.now()}@example.test`,
    workspaceRole: 'analyst',
    message: 'You will be handling the weekly onboarding report.',
  });

  // A throwaway account for the two links that spend themselves. Using the
  // scan account would sign it out mid-scan and revoke the tokens the reset
  // page needs.
  const { rows: spare } = await pool.query<{ id: string }>(
    `insert into actor (tenant_id, email, display_name, workspace_role, provisioned_by)
     values ($1, $2, 'Scan Fixture', 'read_only', 'seed') returning id`,
    [owner.tenant_id, `a11y-spare+${Date.now()}@example.test`],
  );
  const { rows: spareRow } = await pool.query<{ email: string }>('select email from actor where id = $1', [
    spare[0]!.id,
  ]);
  const verification = await sendVerification(pool, { actorId: spare[0]!.id });
  await pool.query('update actor set email_verified_at = now() where id = $1', [spare[0]!.id]);
  const reset = await requestPasswordReset(pool, { email: spareRow[0]!.email });

  // The banner only renders for an unverified account, so the scan needs one.
  await pool.query('update actor set email_verified_at = null where id = $1', [scan.id]);

  console.log(
    JSON.stringify({
      join: invitation.token,
      verify: verification.token,
      reset: reset.token,
    }),
  );
}

await pool.end();
