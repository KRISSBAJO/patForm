/**
 * §12.1's two remaining authentication rows: verified email and password
 * reset.
 *
 * Both are the same mechanism — a single-use token, emailed, spent once — and
 * both are places where a small carelessness becomes an account takeover. The
 * three properties that matter, stated here because they are easy to lose in a
 * later edit:
 *
 *   1. Only the hash is stored. The link IS the credential; a dump of
 *      `auth_token` must not be replayable.
 *   2. Spending is a single UPDATE with `used_at is null` in its WHERE clause,
 *      so two simultaneous uses cannot both win. A read-then-write would let
 *      them.
 *   3. Nothing anywhere says whether an address has an account. Reset returns
 *      the same answer for a member and a stranger, and takes roughly the same
 *      time, because "we have sent you an email" to one address and "no such
 *      user" to another is an enumeration oracle (§12.3).
 *
 * Resetting also revokes every session. A password reset is what somebody does
 * when they think an account is compromised, and leaving the attacker's
 * existing cookie working would make it ceremony.
 */

import { randomBytes, createHash } from 'node:crypto';
import type { Pool, Client } from './db.js';
import { inTransaction } from './db.js';
import { setPassword } from './auth.js';
import { InvalidInput } from './errors.js';
import {
  resetMail,
  sendPlatformMail,
  sentRecently,
  verificationMail,
  type PlatformMailKind,
} from './platform-mail.js';
import { logIfEnabled } from './trace.js';

const VERIFY_TTL_HOURS = 48;
/** Short on purpose. A reset link is the strongest credential in the system. */
const RESET_TTL_MINUTES = 30;
/** Per address, per hour. Enough for a real person who mistypes; not a mail cannon. */
const MAX_PER_HOUR = 5;

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type Purpose = 'verify_email' | 'password_reset';

async function issueToken(
  db: Pool | Client,
  args: { actorId: string; purpose: Purpose; sentTo: string; ttlMinutes: number },
): Promise<{ token: string; expiresAt: Date }> {
  // Any older open token of the same purpose stops working. Two live reset
  // links means the older email — the one more likely to have been forwarded,
  // logged or left in a mailbox — still opens the account.
  await db.query(
    `update auth_token set used_at = now()
      where actor_id = $1 and purpose = $2 and used_at is null`,
    [args.actorId, args.purpose],
  );

  const token = `${args.purpose === 'verify_email' ? 'ver' : 'rst'}_${randomBytes(24).toString('base64url')}`;
  const { rows } = await db.query<{ id: string; expires_at: Date }>(
    `insert into auth_token (actor_id, purpose, token_hash, sent_to, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(mins => $5))
     returning id, expires_at`,
    [args.actorId, args.purpose, hash(token), args.sentTo, args.ttlMinutes],
  );
  return { token, expiresAt: rows[0]!.expires_at };
}

/**
 * Spends a token, or refuses.
 *
 * The refusal is one message for every reason. Distinguishing "expired" from
 * "never existed" tells somebody who guessed a token that they guessed the
 * right shape.
 */
async function spendToken(
  client: Client,
  token: string,
  purpose: Purpose,
): Promise<{ actorId: string; sentTo: string }> {
  const { rows } = await client.query<{ actor_id: string; sent_to: string }>(
    `update auth_token set used_at = now()
      where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
      returning actor_id, sent_to`,
    [hash(token), purpose],
  );
  if (!rows[0]) throw new InvalidInput('that link is not valid any more — ask for a new one');
  return { actorId: rows[0].actor_id, sentTo: rows[0].sent_to };
}

/** Shared by both flows: refuse to send more than a handful an hour to one address. */
async function throttled(pool: Pool, recipient: string, kind: PlatformMailKind): Promise<boolean> {
  return (await sentRecently(pool, { recipient, kind, withinMinutes: 60 })) >= MAX_PER_HOUR;
}

// ------------------------------------------------------------ verification

/**
 * Sends a verification link, if the address is not verified already.
 *
 * Returns the token so tests and the recovery drill can assert on the flow
 * without reading a mailbox. Nothing on the API surface returns it.
 */
export async function sendVerification(
  pool: Pool,
  args: { actorId: string },
): Promise<{ sent: boolean; token?: string; reason?: string }> {
  const { rows } = await pool.query<{
    email: string;
    tenant_id: string;
    email_verified_at: Date | null;
  }>('select email, tenant_id, email_verified_at from actor where id = $1', [args.actorId]);
  const actor = rows[0];
  if (!actor) throw new InvalidInput('no such account');
  if (actor.email_verified_at) return { sent: false, reason: 'already verified' };
  if (await throttled(pool, actor.email, 'verify_email')) {
    return { sent: false, reason: 'a link was sent recently — check your inbox, including spam' };
  }

  const { token, expiresAt } = await issueToken(pool, {
    actorId: args.actorId,
    purpose: 'verify_email',
    sentTo: actor.email,
    ttlMinutes: VERIFY_TTL_HOURS * 60,
  });

  const mail = verificationMail({ to: actor.email, token, expiresAt: expiresAt.toISOString() });
  await sendPlatformMail(pool, {
    kind: 'verify_email',
    to: actor.email,
    subject: mail.subject,
    text: mail.text,
    tenantId: actor.tenant_id,
    actorId: args.actorId,
    idempotencyKey: `verify:${hash(token).slice(0, 32)}`,
  });

  return { sent: true, token };
}

/**
 * Spends a verification link.
 *
 * The check nobody expects: the token records the address it was *sent to*,
 * and verifying compares it against the actor's address now. Otherwise a
 * verification issued for the old address would verify a new one — change the
 * address after requesting the link, follow the link, and an address you never
 * proved anything about is marked verified.
 */
export async function verifyEmail(pool: Pool, token: string): Promise<{ actorId: string; email: string }> {
  return inTransaction(pool, async (client) => {
    const { actorId, sentTo } = await spendToken(client, token, 'verify_email');

    const { rows } = await client.query<{ email: string }>(
      `update actor set email_verified_at = now()
        where id = $1 and lower(email) = lower($2)
        returning email`,
      [actorId, sentTo],
    );
    if (!rows[0]) {
      throw new InvalidInput('that link was for a different address — ask for a new one');
    }

    logIfEnabled('info', 'email.verified', { actorId });
    return { actorId, email: rows[0].email };
  });
}

export async function isVerified(db: Pool | Client, actorId: string): Promise<boolean> {
  const { rows } = await db.query<{ email_verified_at: Date | null }>(
    'select email_verified_at from actor where id = $1',
    [actorId],
  );
  return Boolean(rows[0]?.email_verified_at);
}

// ---------------------------------------------------------------- resets

/**
 * Asks for a reset link.
 *
 * Always resolves the same way. The caller has no way to learn whether the
 * address exists, whether the account is deactivated, or whether the throttle
 * stopped it — all four paths return `{ accepted: true }` and the API says
 * "if that address has an account, a link is on its way".
 *
 * `token` comes back only when one was actually issued, and only to
 * in-process callers; the HTTP handler drops it.
 */
export async function requestPasswordReset(
  pool: Pool,
  args: { email: string },
): Promise<{ accepted: true; token?: string }> {
  const email = args.email.trim().toLowerCase();

  const { rows } = await pool.query<{ id: string; tenant_id: string; email: string; active: boolean }>(
    'select id, tenant_id, email, active from actor where lower(email) = lower($1)',
    [email],
  );
  const actor = rows[0];

  // A deactivated account gets nothing: a reset would be the one way back in
  // for somebody an owner deliberately removed.
  if (!actor || !actor.active) return { accepted: true };
  if (await throttled(pool, actor.email, 'password_reset')) return { accepted: true };

  const { token, expiresAt } = await issueToken(pool, {
    actorId: actor.id,
    purpose: 'password_reset',
    sentTo: actor.email,
    ttlMinutes: RESET_TTL_MINUTES,
  });

  const mail = resetMail({ to: actor.email, token, expiresAt: expiresAt.toISOString() });
  await sendPlatformMail(pool, {
    kind: 'password_reset',
    to: actor.email,
    subject: mail.subject,
    text: mail.text,
    tenantId: actor.tenant_id,
    actorId: actor.id,
    idempotencyKey: `reset:${hash(token).slice(0, 32)}`,
  });

  return { accepted: true, token };
}

/**
 * Spends a reset link and sets the new password.
 *
 * All in one transaction, including the session revocation: a reset that set
 * the password and then failed to revoke would leave the person believing they
 * had locked everybody out.
 */
export async function resetPassword(
  pool: Pool,
  args: { token: string; password: string },
): Promise<{ actorId: string; sessionsRevoked: number }> {
  if (args.password.length < 12) throw new InvalidInput('a password of at least 12 characters, please');

  return inTransaction(pool, async (client) => {
    const { actorId, sentTo } = await spendToken(client, args.token, 'password_reset');

    const { rows } = await client.query<{ id: string }>(
      'select id from actor where id = $1 and lower(email) = lower($2) and active',
      [actorId, sentTo],
    );
    if (!rows[0]) throw new InvalidInput('that link is not valid any more — ask for a new one');

    await setPassword(client, actorId, args.password);

    const revoked = await client.query(
      'update session set revoked_at = now() where actor_id = $1 and revoked_at is null',
      [actorId],
    );

    /*
     * Reaching a reset link proves control of the address as thoroughly as a
     * verification link does. Asking for a second round trip to confirm
     * something already demonstrated is ceremony, not security.
     */
    await client.query(
      'update actor set email_verified_at = coalesce(email_verified_at, now()) where id = $1',
      [actorId],
    );

    logIfEnabled('info', 'password.reset', { actorId, sessionsRevoked: revoked.rowCount ?? 0 });
    return { actorId, sessionsRevoked: revoked.rowCount ?? 0 };
  });
}
