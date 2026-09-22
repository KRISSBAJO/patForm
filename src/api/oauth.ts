import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from '../runtime/db.js';
import { WORKSPACE_GRANTS, type WorkspaceRole } from '../runtime/policy.js';
import type { Capability } from '../blueprint/roles.js';

/**
 * OAuth 2.0 for installed integrations, §11.1.
 *
 * The other half of the credential story. A scoped API key is right for a
 * server somebody operates themselves: they hold it, they rotate it, nobody
 * else is involved. It is wrong for an integration a *third party* installs,
 * because issuing one means giving that third party a credential the customer
 * cannot see the shape of and cannot revoke without changing everything else
 * that uses it.
 *
 * Authorization code with PKCE, and no implicit grant. The reasons are
 * current practice rather than taste:
 *
 * **PKCE on every client, not only public ones.** RFC 9700 (OAuth 2.0
 * Security Best Current Practice) requires it for all clients. It costs a
 * hash and removes an entire class of code-interception attack.
 *
 * **No implicit grant, and no password grant.** Both are removed in OAuth 2.1.
 * Implicit puts the token in a URL, which means it is in browser history and
 * in every referrer; password grant requires the integration to handle the
 * customer's password, which is the thing OAuth exists to avoid.
 *
 * **Exact redirect URI matching.** Not prefix, not wildcard. A registered URI
 * is compared in full, because "starts with" matching is how an open redirect
 * on the client's own domain becomes a token exfiltration.
 *
 * **Refresh tokens rotate, and reuse is treated as theft.** A refresh token is
 * single-use; presenting a used one means either a race or a stolen token, and
 * since the two are indistinguishable the safe reading is theft — so the whole
 * grant is revoked rather than the one token refused.
 */

const CODE_TTL_SECONDS = 60;
const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_DAYS = 30;

export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// ------------------------------------------------------------------ clients

export async function registerClient(
  pool: Pool,
  args: { tenantId: string; name: string; redirectUris: string[]; confidential?: boolean },
): Promise<{ clientId: string; clientSecret: string | null }> {
  for (const uri of args.redirectUris) {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new OAuthError(400, 'invalid_redirect_uri', 'a redirect URI must be https, except on localhost');
    }
    // A fragment in a registered URI cannot be matched exactly, because the
    // browser never sends it. Refusing it here is clearer than failing later.
    if (parsed.hash) throw new OAuthError(400, 'invalid_redirect_uri', 'a redirect URI may not carry a fragment');
  }

  const clientId = `pat_client_${randomBytes(12).toString('base64url')}`;
  const clientSecret = args.confidential ? `pat_cs_${randomBytes(24).toString('base64url')}` : null;

  await pool.query(
    `insert into oauth_client (client_id, tenant_id, name, redirect_uris, secret_hash, confidential)
     values ($1, $2, $3, $4, $5, $6)`,
    [clientId, args.tenantId, args.name, args.redirectUris, clientSecret ? hash(clientSecret) : null, Boolean(args.confidential)],
  );

  return { clientId, clientSecret };
}

// ------------------------------------------------------------ authorization

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scopes: Capability[];
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

/**
 * The consent step, performed by a signed-in member.
 *
 * It takes the granting actor rather than looking one up: authorizing an
 * integration is something a person does while signed in, and a function that
 * could mint a code without one would be the whole vulnerability.
 *
 * Scopes are intersected with what that person actually holds. An integration
 * asking for `administer` gets it only if the member granting it has it —
 * which also means the consent screen can honestly say what will be shared.
 */
export async function authorize(
  pool: Pool,
  args: { request: AuthorizeRequest; tenantId: string; actorId: string },
): Promise<{ code: string; redirectTo: string; granted: Capability[] }> {
  const { request } = args;

  if (request.codeChallengeMethod !== 'S256') {
    // `plain` is permitted by the RFC and is worth nothing: the verifier and
    // the challenge are identical, so anybody who sees one has the other.
    throw new OAuthError(400, 'invalid_request', 'code_challenge_method must be S256');
  }
  if (!request.codeChallenge || request.codeChallenge.length < 43) {
    throw new OAuthError(400, 'invalid_request', 'code_challenge is missing or too short');
  }

  const { rows } = await pool.query<{ redirect_uris: string[]; tenant_id: string }>(
    'select redirect_uris, tenant_id from oauth_client where client_id = $1',
    [request.clientId],
  );
  const client = rows[0];
  if (!client) throw new OAuthError(400, 'invalid_client', 'no such client');
  if (client.tenant_id !== args.tenantId) {
    throw new OAuthError(400, 'invalid_client', 'that client belongs to another workspace');
  }

  // Exact match. Prefix matching is how an open redirect becomes a stolen
  // token, and "it is on our domain" is exactly the assumption that fails.
  if (!client.redirect_uris.includes(request.redirectUri)) {
    throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uri does not match a registered one exactly');
  }

  const { rows: actors } = await pool.query<{ workspace_role: WorkspaceRole }>(
    'select workspace_role from actor where id = $1 and tenant_id = $2 and active',
    [args.actorId, args.tenantId],
  );
  if (!actors[0]) throw new OAuthError(403, 'access_denied', 'no active member to grant this');

  const held = WORKSPACE_GRANTS[actors[0].workspace_role] as readonly Capability[];
  const granted = request.scopes.filter((s) => held.includes(s));
  if (!granted.length) {
    throw new OAuthError(403, 'access_denied', 'you hold none of the requested scopes');
  }

  const code = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into oauth_authorization
       (code_hash, client_id, tenant_id, actor_id, redirect_uri, scopes, code_challenge, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
    [
      hash(code),
      request.clientId,
      args.tenantId,
      args.actorId,
      request.redirectUri,
      granted,
      request.codeChallenge,
      CODE_TTL_SECONDS,
    ],
  );

  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set('code', code);
  if (request.state) redirect.searchParams.set('state', request.state);

  return { code, redirectTo: redirect.toString(), granted };
}

// ------------------------------------------------------------------- tokens

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

async function issueTokens(
  pool: Pool,
  args: { clientId: string; tenantId: string; actorId: string; scopes: Capability[]; grantId?: string },
): Promise<TokenSet> {
  const accessToken = `pat_at_${randomBytes(24).toString('base64url')}`;
  const refreshToken = `pat_rt_${randomBytes(24).toString('base64url')}`;

  /*
   * One grant, many token pairs.
   *
   * The grant is what the customer consented to and what they revoke; the
   * tokens are what a client happens to be holding right now. Keeping them
   * separate is what makes "revoke this integration" mean something, and what
   * lets a rotated refresh token be traced back to the grant it belongs to.
   */
  const grantId =
    args.grantId ??
    (
      await pool.query<{ id: string }>(
        `insert into oauth_grant (client_id, tenant_id, actor_id, scopes) values ($1, $2, $3, $4) returning id`,
        [args.clientId, args.tenantId, args.actorId, args.scopes],
      )
    ).rows[0]!.id;

  await pool.query(
    `insert into oauth_token (grant_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at)
     values ($1, $2, $3, now() + make_interval(secs => $4), now() + make_interval(days => $5))`,
    [grantId, hash(accessToken), hash(refreshToken), ACCESS_TTL_SECONDS, REFRESH_TTL_DAYS],
  );

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    scope: args.scopes.join(' '),
  };
}

export async function exchangeCode(
  pool: Pool,
  args: { code: string; clientId: string; clientSecret?: string; redirectUri: string; codeVerifier: string },
): Promise<TokenSet> {
  const { rows } = await pool.query<{
    id: string;
    client_id: string;
    tenant_id: string;
    actor_id: string;
    redirect_uri: string;
    scopes: Capability[];
    code_challenge: string;
    used_at: Date | null;
    expired: boolean;
  }>(
    `select id, client_id, tenant_id, actor_id, redirect_uri, scopes, code_challenge, used_at,
            (expires_at < now()) as expired
       from oauth_authorization where code_hash = $1`,
    [hash(args.code)],
  );
  const auth = rows[0];
  if (!auth) throw new OAuthError(400, 'invalid_grant', 'that code is not one we issued');

  /*
   * A code presented twice is not a retry.
   *
   * The RFC says a code MUST be single use. Treating reuse as theft — and
   * revoking everything issued from it — is the stronger reading, because the
   * legitimate client has no reason to present one twice and an attacker who
   * raced it does.
   */
  if (auth.used_at) {
    await pool.query(
      `update oauth_grant set revoked_at = now()
        where client_id = $1 and actor_id = $2 and revoked_at is null`,
      [auth.client_id, auth.actor_id],
    );
    throw new OAuthError(400, 'invalid_grant', 'that code was already used; every token from it has been revoked');
  }
  if (auth.expired) throw new OAuthError(400, 'invalid_grant', 'that code has expired');
  if (auth.client_id !== args.clientId) throw new OAuthError(400, 'invalid_grant', 'that code was issued to another client');
  if (auth.redirect_uri !== args.redirectUri) {
    throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match the one the code was issued for');
  }

  // PKCE. The verifier hashes to the challenge, or nothing is issued.
  const computed = createHash('sha256').update(args.codeVerifier).digest('base64url');
  if (!constantTimeEqual(computed, auth.code_challenge)) {
    throw new OAuthError(400, 'invalid_grant', 'code_verifier does not match the challenge');
  }

  await requireClientAuth(pool, args.clientId, args.clientSecret);
  await pool.query('update oauth_authorization set used_at = now() where id = $1', [auth.id]);

  return issueTokens(pool, {
    clientId: auth.client_id,
    tenantId: auth.tenant_id,
    actorId: auth.actor_id,
    scopes: auth.scopes,
  });
}

/**
 * Refresh, with rotation and reuse detection.
 *
 * A refresh token is single-use: exchanging one issues a new pair and marks
 * the old used. Presenting a used one is either a race or a stolen token, and
 * the two look identical from here — so the grant is revoked. A client that
 * loses its session is a nuisance; a client whose token was stolen and stays
 * live is an incident.
 */
export async function refresh(
  pool: Pool,
  args: { refreshToken: string; clientId: string; clientSecret?: string },
): Promise<TokenSet> {
  await requireClientAuth(pool, args.clientId, args.clientSecret);

  const { rows } = await pool.query<{
    id: string;
    grant_id: string;
    used_at: Date | null;
    expired: boolean;
    client_id: string;
    tenant_id: string;
    actor_id: string;
    scopes: Capability[];
    revoked_at: Date | null;
  }>(
    `select t.id, t.grant_id, t.used_at, (t.refresh_expires_at < now()) as expired,
            g.client_id, g.tenant_id, g.actor_id, g.scopes, g.revoked_at
       from oauth_token t join oauth_grant g on g.id = t.grant_id
      where t.refresh_hash = $1`,
    [hash(args.refreshToken)],
  );
  const token = rows[0];
  if (!token) throw new OAuthError(400, 'invalid_grant', 'that refresh token is not one we issued');
  if (token.client_id !== args.clientId) throw new OAuthError(400, 'invalid_grant', 'wrong client for this token');

  if (token.used_at) {
    await pool.query('update oauth_grant set revoked_at = now() where id = $1', [token.grant_id]);
    throw new OAuthError(
      400,
      'invalid_grant',
      'that refresh token was already used, so the whole grant has been revoked',
    );
  }
  if (token.revoked_at) throw new OAuthError(400, 'invalid_grant', 'that grant has been revoked');
  if (token.expired) throw new OAuthError(400, 'invalid_grant', 'that refresh token has expired');

  await pool.query('update oauth_token set used_at = now() where id = $1', [token.id]);

  return issueTokens(pool, {
    clientId: token.client_id,
    tenantId: token.tenant_id,
    actorId: token.actor_id,
    scopes: token.scopes,
    grantId: token.grant_id,
  });
}

async function requireClientAuth(pool: Pool, clientId: string, secret: string | undefined): Promise<void> {
  const { rows } = await pool.query<{ confidential: boolean; secret_hash: string | null }>(
    'select confidential, secret_hash from oauth_client where client_id = $1',
    [clientId],
  );
  const client = rows[0];
  if (!client) throw new OAuthError(401, 'invalid_client', 'no such client');
  if (!client.confidential) return; // a public client authenticates with PKCE alone
  if (!secret || !client.secret_hash || !constantTimeEqual(hash(secret), client.secret_hash)) {
    throw new OAuthError(401, 'invalid_client', 'client authentication failed');
  }
}

/**
 * Resolves an access token, for the API to act on.
 *
 * Scopes are intersected with what the granting member holds *now*, not with
 * what they held at consent. Somebody demoted this morning cannot leave an
 * integration behind that still acts with yesterday's authority — the same
 * rule as API keys, and the reason both reference an actor.
 */
export async function resolveAccessToken(
  pool: Pool,
  presented: string,
): Promise<{ tenantId: string; actorId: string; scopes: Capability[]; clientId: string } | null> {
  if (!presented.startsWith('pat_at_')) return null;

  const { rows } = await pool.query<{
    tenant_id: string;
    actor_id: string;
    scopes: Capability[];
    client_id: string;
    expired: boolean;
    revoked_at: Date | null;
    active: boolean;
    workspace_role: WorkspaceRole;
  }>(
    `select g.tenant_id, g.actor_id, g.scopes, g.client_id,
            (t.access_expires_at < now()) as expired, g.revoked_at, a.active, a.workspace_role
       from oauth_token t
       join oauth_grant g on g.id = t.grant_id
       join actor a on a.id = g.actor_id
      where t.access_hash = $1`,
    [hash(presented)],
  );
  const row = rows[0];
  if (!row || row.expired || row.revoked_at || !row.active) return null;

  const held = WORKSPACE_GRANTS[row.workspace_role] as readonly Capability[];
  const effective = row.scopes.filter((s) => held.includes(s));
  if (!effective.length) return null;

  return { tenantId: row.tenant_id, actorId: row.actor_id, scopes: effective, clientId: row.client_id };
}

/** What a customer sees and revokes: the integrations they have installed. */
export async function listGrants(pool: Pool, tenantId: string) {
  const { rows } = await pool.query(
    `select g.id, c.name as client_name, g.scopes, g.created_at, g.revoked_at, a.display_name as granted_by
       from oauth_grant g join oauth_client c on c.client_id = g.client_id
       join actor a on a.id = g.actor_id
      where g.tenant_id = $1 order by g.created_at desc`,
    [tenantId],
  );
  return rows;
}

export async function revokeGrant(pool: Pool, args: { tenantId: string; grantId: string }): Promise<boolean> {
  const { rowCount } = await pool.query(
    'update oauth_grant set revoked_at = now() where id = $1 and tenant_id = $2 and revoked_at is null',
    [args.grantId, args.tenantId],
  );
  return (rowCount ?? 0) > 0;
}
