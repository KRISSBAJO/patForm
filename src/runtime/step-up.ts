import type { Pool } from './db.js';
import { verifyPassword } from './auth.js';
import { InvalidInput } from './errors.js';
import { isEnabled, verifyCurrentCode } from './mfa.js';
import { logIfEnabled } from './trace.js';

/**
 * Asking again before the actions that matter.
 *
 * The second factor was asked for at sign-in and never again, so a session
 * — left open on a shared machine, or its cookie lifted — could issue an API
 * key, add a webhook that ships records elsewhere, promote somebody to owner
 * or run a retention deletion, with nothing between the cookie and the act.
 *
 * The rule for what asks: anything that *grants* access or *destroys* data.
 * Never anything that *reduces* access — revoking a key, a grant, an
 * invitation or a session, deactivating somebody — because in an incident
 * those have to be one click, and a prompt in front of them protects the
 * attacker's foothold rather than the workspace.
 *
 * "Recent" is ten minutes since the session last proved who it was. Proving
 * it is the password, and the authenticator code if two-step is on — the
 * same two things signing in asks for. Five wrong answers end the session:
 * whoever is guessing inside it does not get to keep it.
 */

export const FRESH_MINUTES = 10;
const MAX_FAILURES = 5;

/** Thrown by a route that needs a fresher sign-in; the API answers 403 `reauthenticate`. */
export class ReauthRequired extends Error {
  constructor(readonly mfa: boolean) {
    super('confirm it is you to continue');
  }
}

export function isFresh(authenticatedAt: Date, nowMs = Date.now()): boolean {
  return nowMs - authenticatedAt.getTime() <= FRESH_MINUTES * 60_000;
}

export async function requireFresh(
  pool: Pool,
  session: { actorId: string; authenticatedAt: Date },
  nowMs = Date.now(),
): Promise<void> {
  if (isFresh(session.authenticatedAt, nowMs)) return;
  throw new ReauthRequired(await isEnabled(pool, session.actorId));
}

/**
 * Proves it is still the same person, and marks the session fresh.
 *
 * Every wrong answer is counted against the session in its own statement,
 * outside anything that might roll back — the same lesson as the second
 * factor's attempt counter, which once incremented inside a transaction that
 * undid it on every wrong code.
 */
export async function reauthenticate(
  pool: Pool,
  args: { sessionId: string; actorId: string; password: string; code?: string; nowMs?: number },
): Promise<{ freshUntil: string }> {
  const fail = async (reason: string): Promise<never> => {
    const { rows } = await pool.query<{ reauth_failures: number }>(
      `update session set reauth_failures = reauth_failures + 1 where id = $1 returning reauth_failures`,
      [args.sessionId],
    );
    const failures = rows[0]?.reauth_failures ?? MAX_FAILURES;
    if (failures >= MAX_FAILURES) {
      await pool.query('update session set revoked_at = now() where id = $1', [args.sessionId]);
      logIfEnabled('warn', 'auth.step_up_locked', { actorId: args.actorId });
      throw new InvalidInput('too many wrong answers — you have been signed out');
    }
    throw new InvalidInput(reason);
  };

  const { rows } = await pool.query<{ password_hash: string }>(
    'select password_hash from credential where actor_id = $1',
    [args.actorId],
  );
  if (!rows[0] || !(await verifyPassword(args.password, rows[0].password_hash))) {
    return fail('that password is not right');
  }

  if (await isEnabled(pool, args.actorId)) {
    if (!args.code) return fail('the code from your authenticator, please');
    const check = await verifyCurrentCode(pool, { actorId: args.actorId, code: args.code, nowMs: args.nowMs });
    if (!check.ok) return fail(check.reason ?? 'that code is not right');
  }

  const { rows: fresh } = await pool.query<{ authenticated_at: Date }>(
    `update session set authenticated_at = now(), reauth_failures = 0 where id = $1 returning authenticated_at`,
    [args.sessionId],
  );
  logIfEnabled('info', 'auth.step_up', { actorId: args.actorId });
  return { freshUntil: new Date(fresh[0]!.authenticated_at.getTime() + FRESH_MINUTES * 60_000).toISOString() };
}

/**
 * Which requests ask. Matched on method and path, and for retention only when
 * it is deleting rather than previewing what it would delete.
 */
export const STEP_UP: { method: string; test: RegExp; when?: (body: unknown) => boolean; what: string }[] = [
  { method: 'POST', test: /^\/api\/platform\/workspaces\/[0-9a-f-]{36}\/rename$/, what: 'rename a workspace' },
  { method: 'POST', test: /^\/api\/platform\/workspaces\/[0-9a-f-]{36}\/people\/[0-9a-f-]{36}\/access$/, what: 'change workspace access across the site' },
  { method: 'POST', test: /^\/api\/platform\/jobs\/\d+\/retry$/, what: 'retry a platform job' },
  { method: 'POST', test: /^\/api\/platform\/people\/[0-9a-f-]{36}\/revoke-sessions$/, what: 'revoke sessions across a workspace' },
  { method: 'POST', test: /^\/api\/platform\/operators$/, what: 'grant site admin access' },
  { method: 'POST', test: /^\/api\/platform\/operators\/[0-9a-f-]{36}\/revoke$/, what: 'revoke site admin access' },
  { method: 'POST', test: /^\/api\/keys$/, what: 'issue an API key' },
  { method: 'POST', test: /^\/api\/webhooks$/, what: 'send records to a new webhook' },
  { method: 'POST', test: /^\/api\/webhooks\/[0-9a-f-]{36}\/rotate$/, what: 'issue a new webhook secret' },
  { method: 'POST', test: /^\/api\/oauth\/clients$/, what: 'register an application' },
  { method: 'POST', test: /^\/api\/invitations$/, what: 'invite somebody' },
  {
    method: 'POST',
    test: /^\/api\/invitations\/bulk$/,
    when: (body) => (body as { dryRun?: boolean })?.dryRun !== true,
    what: 'invite these people',
  },
  { method: 'POST', test: /^\/api\/members\/[0-9a-f-]{36}\/role$/, what: "change somebody's role" },
  { method: 'POST', test: /^\/api\/members\/[0-9a-f-]{36}\/reactivate$/, what: 'let somebody back in' },
  { method: 'POST', test: /^\/api\/account\/mfa\/begin$/, what: 'set up a new authenticator' },
  {
    method: 'POST',
    test: /^\/api\/retention$/,
    when: (body) => (body as { preview?: boolean })?.preview === false,
    what: 'delete records',
  },
];

export function stepUpFor(method: string, path: string, body: unknown) {
  return STEP_UP.find((r) => r.method === method && r.test.test(path) && (!r.when || r.when(body))) ?? null;
}
