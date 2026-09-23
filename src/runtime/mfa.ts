/**
 * §12.1's last authentication row: an MFA option.
 *
 * Time-based one-time passwords (RFC 6238), because it is the second factor
 * somebody can set up in thirty seconds with an app they already have, and it
 * needs no vendor. Not SMS: §6.6's own reasoning about consent applies, and a
 * text message is the weakest factor on the list.
 *
 * Five properties that separate a real second factor from the appearance of
 * one. Each is a way this is usually got wrong:
 *
 *   1. **Enrolment is confirmed by a code, never by generating one.** An
 *      enrolment that turns on the moment a secret is created locks out
 *      everybody whose authenticator did not actually scan it.
 *   2. **A code cannot be used twice.** The step it was minted in is
 *      recorded, and a code from that step or earlier is refused — otherwise
 *      a code read over a shoulder or out of a log is good for another
 *      thirty seconds.
 *   3. **Attempts are counted and capped.** Six digits is a million
 *      possibilities; unlimited guesses against a thirty-second window is
 *      not a factor, it is a delay.
 *   4. **Recovery codes are single use and stored as hashes.** They are the
 *      credential when the phone is lost, which makes them exactly as
 *      valuable as the password.
 *   5. **Turning it off needs the password.** Otherwise a stolen session
 *      removes the control that the session was supposed to be protected by.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { open as openSecret, seal } from './secret-box.js';
import type { Client, Pool } from './db.js';
import { inTransaction } from './db.js';
import { InvalidInput } from './errors.js';
import { verifyPassword } from './auth.js';
import { logIfEnabled } from './trace.js';

/** RFC 6238's defaults, and what every authenticator app assumes. */
const DIGITS = 6;
const PERIOD_SECONDS = 30;
/** One step either side: a phone whose clock is half a minute out still works. */
const DRIFT_STEPS = 1;
const RECOVERY_CODES = 10;
/** Six digits is a million guesses. This is what makes that number mean something. */
const MAX_ATTEMPTS = 5;
const CHALLENGE_TTL_MINUTES = 10;

// ------------------------------------------------------------------ base32

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  // No padding. Authenticator apps accept unpadded secrets and padding is the
  // most common thing to get wrong when a person types one by hand.
  return out;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// -------------------------------------------------------------------- totp

/** The counter a code belongs to. Recorded so the same code cannot be spent twice. */
export function stepFor(nowMs: number): number {
  return Math.floor(nowMs / 1000 / PERIOD_SECONDS);
}

export function codeFor(secret: string, step: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', key).update(counter).digest();
  // RFC 4226's dynamic truncation: the low nibble of the last byte picks
  // which four bytes of the digest become the code.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Checks a code against the window, and says which step matched.
 *
 * The step comes back rather than a bare boolean because the caller has to
 * record it: without that, the same code works for every request inside its
 * thirty seconds.
 */
export function checkCode(
  secret: string,
  code: string,
  args: { nowMs: number; after?: number | null },
): { ok: boolean; step?: number; reason?: string } {
  const entered = code.replace(/\D/g, '');
  if (entered.length !== DIGITS) return { ok: false, reason: 'a six-digit code, please' };

  const current = stepFor(args.nowMs);
  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset++) {
    const step = current + offset;
    const expected = codeFor(secret, step);
    const a = Buffer.from(expected);
    const b = Buffer.from(entered);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      if (args.after != null && step <= args.after) {
        // The code is genuine and already spent. Refused as firmly as a wrong
        // one, and said plainly, because the person retyping their own code
        // deserves to know why it stopped working.
        return { ok: false, reason: 'that code has already been used — wait for the next one' };
      }
      return { ok: true, step };
    }
  }
  return { ok: false, reason: 'that code is not right' };
}

/** What a QR code encodes. The label is what the person sees in their app. */
export function otpauthUri(args: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${args.issuer}:${args.account}`);
  const params = new URLSearchParams({
    secret: args.secret,
    issuer: args.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// -------------------------------------------------------------- recovery

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * SHA-256 rather than scrypt, and deliberately.
 *
 * These are 40 bits of randomness we generated, not something a person chose,
 * so there is no dictionary to run and nothing for a slow hash to buy. The
 * reason to hash at all is that a database dump must not be a set of working
 * credentials.
 */
function newRecoveryCode(): string {
  const raw = randomBytes(5).toString('hex');
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

async function issueRecoveryCodes(db: Pool | Client, actorId: string): Promise<string[]> {
  await db.query('delete from mfa_recovery_code where actor_id = $1', [actorId]);
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  for (const code of codes) {
    await db.query('insert into mfa_recovery_code (actor_id, code_hash) values ($1, $2)', [
      actorId,
      hash(code),
    ]);
  }
  return codes;
}

// -------------------------------------------------------------- enrolment

export interface StartedEnrolment {
  secret: string;
  uri: string;
}

/**
 * Begins enrolment. Nothing is enforced yet.
 *
 * Starting again replaces an unconfirmed secret, which is what somebody does
 * when they abandon a half-finished setup — and it must not disturb a
 * confirmed one.
 */
export async function beginEnrolment(
  pool: Pool,
  args: { actorId: string; issuer?: string },
): Promise<StartedEnrolment> {
  const { rows } = await pool.query<{ email: string; confirmed_at: Date | null }>(
    `select a.email, m.confirmed_at from actor a
       left join mfa_enrolment m on m.actor_id = a.id
      where a.id = $1`,
    [args.actorId],
  );
  const actor = rows[0];
  if (!actor) throw new InvalidInput('no such account');
  if (actor.confirmed_at) {
    throw new InvalidInput('two-step verification is already on — turn it off first');
  }

  const secret = base32Encode(randomBytes(20));
  // Stored sealed and bound to this account; shown in the clear exactly once,
  // here, for the authenticator to scan. See secret-box.ts.
  await pool.query(
    `insert into mfa_enrolment (actor_id, secret) values ($1, $2)
     on conflict (actor_id) do update set secret = excluded.secret, created_at = now(),
       last_used_step = null`,
    [args.actorId, seal(secret, args.actorId)],
  );

  return {
    secret,
    uri: otpauthUri({ secret, account: actor.email, issuer: args.issuer ?? 'Patform' }),
  };
}

/**
 * Turns it on, and only on proof that the authenticator has the secret.
 *
 * The recovery codes are returned once. They are the only thing standing
 * between a lost phone and a support request nobody can safely honour.
 */
export async function confirmEnrolment(
  pool: Pool,
  args: { actorId: string; code: string; nowMs?: number },
): Promise<{ recoveryCodes: string[] }> {
  const nowMs = args.nowMs ?? Date.now();

  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ secret: string; confirmed_at: Date | null; last_used_step: string | null }>(
      'select secret, confirmed_at, last_used_step from mfa_enrolment where actor_id = $1 for update',
      [args.actorId],
    );
    const enrolment = rows[0];
    if (!enrolment) throw new InvalidInput('start setting up two-step verification first');
    if (enrolment.confirmed_at) throw new InvalidInput('two-step verification is already on');

    const secret = await readSecret(client, args.actorId, enrolment.secret);
    const check = checkCode(secret, args.code, {
      nowMs,
      after: enrolment.last_used_step == null ? null : Number(enrolment.last_used_step),
    });
    if (!check.ok) throw new InvalidInput(check.reason ?? 'that code is not right');

    await client.query(
      'update mfa_enrolment set confirmed_at = now(), last_used_step = $2 where actor_id = $1',
      [args.actorId, check.step],
    );
    const recoveryCodes = await issueRecoveryCodes(client, args.actorId);

    logIfEnabled('info', 'mfa.enabled', { actorId: args.actorId });
    return { recoveryCodes };
  });
}

/**
 * Turns it off, on the password.
 *
 * Not on a code: somebody with the phone but not the password is exactly the
 * person who should not be able to remove the factor. And not on the session
 * alone, because a stolen session would then remove the control the session
 * was protected by.
 */
export async function disable(
  pool: Pool,
  args: { actorId: string; password: string },
): Promise<void> {
  const { rows } = await pool.query<{ password_hash: string | null }>(
    'select password_hash from credential where actor_id = $1',
    [args.actorId],
  );
  const stored = rows[0]?.password_hash;
  if (!stored || !(await verifyPassword(args.password, stored))) {
    throw new InvalidInput('that password is not right');
  }
  await pool.query('delete from mfa_enrolment where actor_id = $1', [args.actorId]);
  await pool.query('delete from mfa_recovery_code where actor_id = $1', [args.actorId]);
  logIfEnabled('info', 'mfa.disabled', { actorId: args.actorId });
}

export async function statusFor(
  db: Pool | Client,
  actorId: string,
): Promise<{ enabled: boolean; pending: boolean; recoveryCodesLeft: number }> {
  const { rows } = await db.query<{ confirmed_at: Date | null }>(
    'select confirmed_at from mfa_enrolment where actor_id = $1',
    [actorId],
  );
  const { rows: left } = await db.query<{ count: number }>(
    'select count(*)::int as count from mfa_recovery_code where actor_id = $1 and used_at is null',
    [actorId],
  );
  return {
    enabled: Boolean(rows[0]?.confirmed_at),
    pending: rows.length > 0 && !rows[0]?.confirmed_at,
    recoveryCodesLeft: left[0]?.count ?? 0,
  };
}

export async function regenerateRecoveryCodes(
  pool: Pool,
  args: { actorId: string; password: string },
): Promise<string[]> {
  const { rows } = await pool.query<{ password_hash: string | null }>(
    'select password_hash from credential where actor_id = $1',
    [args.actorId],
  );
  const stored = rows[0]?.password_hash;
  if (!stored || !(await verifyPassword(args.password, stored))) {
    throw new InvalidInput('that password is not right');
  }
  return issueRecoveryCodes(pool, args.actorId);
}

// -------------------------------------------------------------- challenges

/**
 * The half-signed-in state between a correct password and a correct code.
 *
 * Its own short-lived token rather than a session with a flag on it. A session
 * that exists but "does not count yet" is one missing check away from being a
 * session that counts — and that check would have to be added to every route
 * rather than to this one place.
 */
export async function openChallenge(
  db: Pool | Client,
  args: { actorId: string; userAgent?: string },
): Promise<string> {
  const token = `mfa_${randomBytes(24).toString('base64url')}`;
  await db.query(
    `insert into mfa_challenge (token_hash, actor_id, user_agent, expires_at)
     values ($1, $2, $3, now() + make_interval(mins => $4))`,
    [hash(token), args.actorId, args.userAgent?.slice(0, 200) ?? null, CHALLENGE_TTL_MINUTES],
  );
  return token;
}

export interface Answered {
  actorId: string;
  usedRecoveryCode: boolean;
  recoveryCodesLeft: number;
}

/**
 * Answers a challenge with either a code or a recovery code.
 *
 * Both paths increment the attempt counter before checking, so a failure that
 * throws still costs an attempt. Doing it afterwards would mean the counter
 * only rises when the caller is polite enough to let the transaction commit.
 */
export async function answerChallenge(
  pool: Pool,
  args: { token: string; code: string; nowMs?: number },
): Promise<Answered> {
  const nowMs = args.nowMs ?? Date.now();

  /*
   * The attempt is claimed on the pool, BEFORE the verification transaction,
   * and deliberately not inside it.
   *
   * The first version incremented the counter as the transaction's first
   * statement. Every wrong code then threw, the transaction rolled back, and
   * the increment went with it — so the cap never fired and six digits had
   * unlimited guesses. This is the rule already in docs/failure-cases.md,
   * broken again: anything that has to survive a failed transaction cannot
   * live inside it.
   *
   * One statement does the claiming, so two simultaneous guesses cannot both
   * read `attempts` and both write the same value.
   */
  const { rows: claimed } = await pool.query<{ id: string; actor_id: string; attempts: number }>(
    `update mfa_challenge set attempts = attempts + 1
      where token_hash = $1 and used_at is null and expires_at > $2 and attempts < $3
      returning id, actor_id, attempts`,
    [hash(args.token), new Date(nowMs), MAX_ATTEMPTS],
  );

  if (!claimed[0]) {
    // Nothing was claimed. The holder already proved the password, so saying
    // which of the three it was costs nothing and saves a support message.
    const { rows: why } = await pool.query<{ attempts: number; used_at: Date | null; expires_at: Date }>(
      'select attempts, used_at, expires_at from mfa_challenge where token_hash = $1',
      [hash(args.token)],
    );
    if (why[0] && why[0].attempts >= MAX_ATTEMPTS && !why[0].used_at) {
      throw new InvalidInput('too many attempts — start again');
    }
    throw new InvalidInput('that sign-in attempt has expired — start again');
  }

  const challenge = claimed[0];
  const entered = args.code.trim();

  return inTransaction(pool, async (client) => {
    // ---- a recovery code, if it looks like one
    if (entered.includes('-')) {
      const { rows: used } = await client.query<{ id: string }>(
        `update mfa_recovery_code set used_at = now()
          where actor_id = $1 and code_hash = $2 and used_at is null
          returning id`,
        [challenge.actor_id, hash(entered.toLowerCase())],
      );
      if (!used[0]) throw new InvalidInput('that code is not right');

      await client.query('update mfa_challenge set used_at = now() where id = $1', [challenge.id]);
      const { rows: left } = await client.query<{ count: number }>(
        'select count(*)::int as count from mfa_recovery_code where actor_id = $1 and used_at is null',
        [challenge.actor_id],
      );
      logIfEnabled('warn', 'mfa.recovery_code_used', {
        actorId: challenge.actor_id,
        left: left[0]!.count,
      });
      return {
        actorId: challenge.actor_id,
        usedRecoveryCode: true,
        recoveryCodesLeft: left[0]!.count,
      };
    }

    // ---- otherwise a code from the authenticator
    const { rows: enrolments } = await client.query<{ secret: string; last_used_step: string | null }>(
      `select secret, last_used_step from mfa_enrolment
        where actor_id = $1 and confirmed_at is not null for update`,
      [challenge.actor_id],
    );
    const enrolment = enrolments[0];
    if (!enrolment) throw new InvalidInput('two-step verification is not set up on this account');

    const secret = await readSecret(client, challenge.actor_id, enrolment.secret);
    const check = checkCode(secret, entered, {
      nowMs,
      after: enrolment.last_used_step == null ? null : Number(enrolment.last_used_step),
    });
    if (!check.ok) throw new InvalidInput(check.reason ?? 'that code is not right');

    await client.query('update mfa_enrolment set last_used_step = $2 where actor_id = $1', [
      challenge.actor_id,
      check.step,
    ]);
    await client.query('update mfa_challenge set used_at = now() where id = $1', [challenge.id]);

    const { rows: left } = await client.query<{ count: number }>(
      'select count(*)::int as count from mfa_recovery_code where actor_id = $1 and used_at is null',
      [challenge.actor_id],
    );
    return {
      actorId: challenge.actor_id,
      usedRecoveryCode: false,
      recoveryCodesLeft: left[0]!.count,
    };
  });
}

/**
 * The secret, opened — and sealed again when it needs to be.
 *
 * A secret stored before encryption existed is read as it is and replaced
 * with a sealed one in the same transaction, so nobody enrolled earlier is
 * locked out and no plaintext outlives its next use. One sealed under the
 * previous key is moved to the current key the same way, which is how a key
 * is rotated without a migration: set the new key, keep the old one as
 * MFA_ENCRYPTION_KEY_PREVIOUS until everybody has signed in once.
 */
async function readSecret(client: Client, actorId: string, stored: string): Promise<string> {
  let opened: { plaintext: string; reseal: boolean };
  try {
    opened = openSecret(stored, actorId);
  } catch (err) {
    // Tampered with, copied from another account, or this deployment has the
    // wrong key. Said plainly, and logged loudly: it is either an attack or a
    // misconfiguration, and neither should look like "that code is not right".
    logIfEnabled('error', 'mfa.secret_unreadable', { actorId, detail: err instanceof Error ? err.message : String(err) });
    throw new InvalidInput(
      'the two-step verification for this account cannot be read — use a recovery code, or ask an owner to reset it',
    );
  }
  const { plaintext, reseal } = opened;
  if (reseal) {
    await client.query('update mfa_enrolment set secret = $2 where actor_id = $1', [actorId, seal(plaintext, actorId)]);
  }
  return plaintext;
}

export async function isEnabled(db: Pool | Client, actorId: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    'select true as ok from mfa_enrolment where actor_id = $1 and confirmed_at is not null',
    [actorId],
  );
  return Boolean(rows[0]);
}
