import { randomBytes, createHash, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Client, Pool } from './db.js';
import type { Principal } from './policy.js';
import { isEnabled, openChallenge } from './mfa.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * §12.1 authentication: "Modern password hashing, verified email, MFA option,
 * session/device management, OAuth/OIDC-ready model."
 *
 * Built here: scrypt password hashing, opaque session tokens with expiry and
 * revocation, and device listing. Not built: email verification, MFA, OAuth.
 * Those are named in the gaps section of the README rather than implied by
 * silence.
 *
 * Two deliberate properties:
 *
 *   - Only hashes are stored. The `session` table holds SHA-256 of the token,
 *     so a dump of it cannot be replayed as a login; the plaintext exists only
 *     in the cookie.
 *   - Comparison is timing-safe, and a login for an unknown email still does
 *     the scrypt work, so response time does not say whether an account exists.
 */

const SCRYPT_KEYLEN = 64;
const SESSION_DAYS = 14;
const RESUME_DAYS = 30;

/** A dummy hash, used so an unknown email costs the same as a wrong password. */
let dummyHash: string | null = null;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) {
    throw new Error('password must be at least 10 characters');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

// ------------------------------------------------------------------ passwords

/**
 * Takes a queryable rather than a pool, so a password can be set inside the
 * transaction that creates the account. On a pool it would commit separately,
 * and a rollback would leave an actor with no credential — an account that
 * exists, occupies its email address, and can never be signed into.
 */
export async function setPassword(pool: Pool | Client, actorId: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await pool.query(
    `insert into credential (actor_id, password_hash) values ($1, $2)
     on conflict (actor_id) do update set password_hash = excluded.password_hash, updated_at = now()`,
    [actorId, hash],
  );
}

export interface SignInResult {
  token: string;
  expiresAt: Date;
  actor: { id: string; tenantId: string; displayName: string; email: string; workspaceRole: string };
}

/**
 * A correct password on an account with a second factor.
 *
 * Returned instead of a session, never alongside one. The whole value of the
 * factor is that the password alone does not produce something that works.
 */
export interface MfaRequired {
  mfaRequired: true;
  challengeToken: string;
}

export function needsSecondFactor(result: SignInResult | MfaRequired | null): result is MfaRequired {
  return result !== null && 'mfaRequired' in result;
}

/** Issues the session itself, once whatever had to be proved has been. */
export async function startSession(
  pool: Pool,
  args: { actorId: string; userAgent?: string },
): Promise<SignInResult | null> {
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    display_name: string;
    email: string;
    workspace_role: string;
    active: boolean;
  }>(
    'select id, tenant_id, display_name, email, workspace_role, active from actor where id = $1',
    [args.actorId],
  );
  const actor = rows[0];
  if (!actor?.active) return null;

  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await pool.query(
    `insert into session (token_hash, actor_id, tenant_id, user_agent, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [sha256(token), actor.id, actor.tenant_id, args.userAgent?.slice(0, 200) ?? null, expiresAt],
  );

  return {
    token,
    expiresAt,
    actor: {
      id: actor.id,
      tenantId: actor.tenant_id,
      displayName: actor.display_name,
      email: actor.email,
      workspaceRole: actor.workspace_role,
    },
  };
}

/**
 * Returns null for every failure — wrong password, unknown email, deactivated
 * account — without saying which. Telling a stranger that an address exists is
 * an account-enumeration oracle (§12.3).
 */
export async function signIn(
  pool: Pool,
  args: { email: string; password: string; userAgent?: string },
): Promise<SignInResult | MfaRequired | null> {
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    display_name: string;
    email: string;
    workspace_role: string;
    active: boolean;
    password_hash: string | null;
  }>(
    `select a.id, a.tenant_id, a.display_name, a.email, a.workspace_role, a.active, c.password_hash
       from actor a left join credential c on c.actor_id = a.id
      where lower(a.email) = lower($1)`,
    [args.email],
  );

  const actor = rows[0];

  if (!actor?.password_hash) {
    // Spend the same time as a real check so the response does not leak
    // whether the account exists.
    dummyHash ??= await hashPassword('not-a-real-password-placeholder');
    await verifyPassword(args.password, dummyHash);
    return null;
  }

  const ok = await verifyPassword(args.password, actor.password_hash);
  if (!ok || !actor.active) return null;

  /*
   * The password was right, and on an account with a second factor that is
   * not enough to produce anything that works. A challenge token comes back
   * instead of a session — the point of the factor is that there is no
   * session yet to steal, forget to flag, or accidentally accept.
   */
  if (await isEnabled(pool, actor.id)) {
    return {
      mfaRequired: true,
      challengeToken: await openChallenge(pool, { actorId: actor.id, userAgent: args.userAgent }),
    };
  }

  return startSession(pool, { actorId: actor.id, userAgent: args.userAgent });
}

export interface SessionActor {
  sessionId: string;
  actorId: string;
  tenantId: string;
  displayName: string;
  email: string;
  workspaceRole: string;
}

/** Resolves a cookie value to an actor, or null. Expiry and revocation are checked in SQL. */
export async function resolveSession(pool: Pool, token: string): Promise<SessionActor | null> {
  if (!token) return null;
  const { rows } = await pool.query<{
    id: string;
    actor_id: string;
    tenant_id: string;
    display_name: string;
    email: string;
    workspace_role: string;
  }>(
    `select s.id, s.actor_id, s.tenant_id, a.display_name, a.email, a.workspace_role
       from session s join actor a on a.id = s.actor_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and a.active`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;

  // Cheap enough per request, and it is what makes "last seen" in device
  // management mean anything.
  await pool.query('update session set last_seen_at = now() where id = $1', [row.id]);

  return {
    sessionId: row.id,
    actorId: row.actor_id,
    tenantId: row.tenant_id,
    displayName: row.display_name,
    email: row.email,
    workspaceRole: row.workspace_role,
  };
}

export async function signOut(pool: Pool, token: string): Promise<void> {
  await pool.query('update session set revoked_at = now() where token_hash = $1 and revoked_at is null', [
    sha256(token),
  ]);
}

/** §6.1 IAM-04: owners can revoke sessions for users. */
export async function revokeAllSessions(pool: Pool, actorId: string): Promise<number> {
  const { rowCount } = await pool.query(
    'update session set revoked_at = now() where actor_id = $1 and revoked_at is null',
    [actorId],
  );
  return rowCount ?? 0;
}

export async function devicesFor(pool: Pool, actorId: string) {
  const { rows } = await pool.query(
    `select id, user_agent, created_at, last_seen_at, expires_at
       from session where actor_id = $1 and revoked_at is null and expires_at > now()
      order by last_seen_at desc`,
    [actorId],
  );
  return rows;
}

// -------------------------------------------------------------- resume tokens

/**
 * §6.3's secure resume link, and the thing that makes "a respondent may view
 * their own record" true rather than aspirational: without a token scoping
 * them to one instance, a respondent principal could read any record in the
 * tenant (§12.3, broken object authorization in public resume links).
 */
export async function issueResumeToken(
  client: Client,
  args: { tenantId: string; instanceId: string },
): Promise<string> {
  const token = newToken();
  await client.query(
    `insert into resume_token (token_hash, tenant_id, instance_id, expires_at)
     values ($1, $2, $3, now() + make_interval(days => $4))`,
    [sha256(token), args.tenantId, args.instanceId, RESUME_DAYS],
  );
  return token;
}

export async function resolveResumeToken(
  pool: Pool,
  token: string,
): Promise<{ tenantId: string; instanceId: string } | null> {
  if (!token) return null;
  const { rows } = await pool.query<{ tenant_id: string; instance_id: string }>(
    `select tenant_id, instance_id from resume_token
      where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [sha256(token)],
  );
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, instanceId: row.instance_id } : null;
}

/** Builds the principal a resume link stands for: one respondent, one record. */
export function respondentPrincipalFor(scope: { tenantId: string; instanceId: string }): Principal {
  return { kind: 'respondent', tenantId: scope.tenantId, instanceId: scope.instanceId };
}
