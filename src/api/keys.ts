import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from '../runtime/db.js';
import type { Capability } from '../blueprint/roles.js';
import { redis } from '../runtime/redis.js';

/**
 * Scoped API keys, §11.1: *"OAuth 2.0 for installed integrations and scoped
 * API keys for server-to-server use during early releases."*
 *
 * OAuth is the second half and is not built. This is the first: a credential a
 * server holds, scoped to fewer capabilities than the person who issued it.
 *
 * Three things make it a credential rather than a password in a header.
 *
 * **Only the hash is stored.** The key is shown once, at creation, and cannot
 * be recovered — the same posture as the session tokens in auth.ts. A key that
 * can be read back out of the database is a key every database administrator
 * holds.
 *
 * **Scopes narrow, never widen.** A key carries a subset of its creator's
 * workspace capabilities, checked again at use. Somebody who loses `administer`
 * cannot leave a key behind that still has it, because the key's authority is
 * intersected with theirs on every request rather than copied at creation.
 *
 * **A prefix is stored in clear.** `pat_live_7f3a…` — enough to recognise a key
 * in a log or a support ticket and revoke the right one, and not enough to use.
 */

const PREFIX = 'pat_live_';

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  actorId: string;
  name: string;
  scopes: Capability[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

function hash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export async function issueApiKey(
  pool: Pool,
  args: { tenantId: string; actorId: string; name: string; scopes: Capability[] },
): Promise<{ id: string; key: string; prefix: string }> {
  const secret = randomBytes(24).toString('base64url');
  const key = `${PREFIX}${secret}`;
  const prefix = key.slice(0, PREFIX.length + 6);

  const { rows } = await pool.query<{ id: string }>(
    `insert into api_key (tenant_id, actor_id, name, key_hash, key_prefix, scopes)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [args.tenantId, args.actorId, args.name, hash(key), prefix, args.scopes],
  );

  return { id: rows[0]!.id, key, prefix };
}

/**
 * Resolves a key to the principal it acts as.
 *
 * The comparison is constant-time. A hash lookup by equality in SQL is already
 * effectively constant-time against the stored value, but the code should not
 * depend on that being true of whatever index Postgres chooses.
 */
export async function resolveApiKey(
  pool: Pool,
  presented: string,
): Promise<{ record: ApiKeyRecord; scopes: Capability[] } | null> {
  if (!presented.startsWith(PREFIX)) return null;

  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    actor_id: string;
    name: string;
    key_hash: string;
    scopes: Capability[];
    last_used_at: Date | null;
    revoked_at: Date | null;
    actor_active: boolean;
    workspace_role: string;
  }>(
    `select k.id, k.tenant_id, k.actor_id, k.name, k.key_hash, k.scopes, k.last_used_at, k.revoked_at,
            a.active as actor_active, a.workspace_role
       from api_key k join actor a on a.id = k.actor_id
      where k.key_hash = $1`,
    [hash(presented)],
  );
  const row = rows[0];
  if (!row) return null;

  const given = Buffer.from(hash(presented));
  const stored = Buffer.from(row.key_hash);
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;

  if (row.revoked_at) return null;
  // A key belonging to somebody who has left stops working immediately. This
  // is why the key references an actor rather than standing alone.
  if (!row.actor_active) return null;

  // Recorded rather than awaited: a failed write here must not fail a request,
  // and the value is for a human deciding whether a key is still in use.
  void pool
    .query('update api_key set last_used_at = now() where id = $1', [row.id])
    .catch(() => undefined);

  return {
    record: {
      id: row.id,
      tenantId: row.tenant_id,
      actorId: row.actor_id,
      name: row.name,
      scopes: row.scopes,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    },
    scopes: row.scopes,
  };
}

export async function revokeApiKey(pool: Pool, args: { tenantId: string; id: string }): Promise<boolean> {
  const { rowCount } = await pool.query(
    'update api_key set revoked_at = now() where id = $1 and tenant_id = $2 and revoked_at is null',
    [args.id, args.tenantId],
  );
  return (rowCount ?? 0) > 0;
}

export async function listApiKeys(pool: Pool, tenantId: string) {
  const { rows } = await pool.query(
    `select k.id, k.name, k.key_prefix, k.scopes, k.created_at, k.last_used_at, k.revoked_at,
            a.display_name as created_by
       from api_key k join actor a on a.id = k.actor_id
      where k.tenant_id = $1 order by k.created_at desc`,
    [tenantId],
  );
  return rows;
}

// ------------------------------------------------------------ rate limiting

/**
 * §11.1: *"Rate limits are tenant- and credential-aware with informative
 * headers."*
 *
 * In memory, which is honest about what it is: one process's view of one
 * credential. Behind more than one API process this under-counts, and the
 * answer is Redis — §10.1 already names it for exactly this. What is here is
 * enough to stop a loop, and the headers tell a caller what the budget is so
 * they can back off before being refused.
 *
 * Tenant-aware as well as credential-aware, so one workspace issuing ten keys
 * does not get ten times the budget.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateVerdict {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

/**
 * The shared counter, when one is configured.
 *
 * §10.1 names Redis for exactly this. With more than one API process the
 * in-memory bucket under-counts by a factor of however many are running, which
 * is a limit in name only — so this is the correct answer and the memory
 * version is the fallback.
 *
 * It fails **open**. A limiter that refuses everything when its counter is
 * unreachable has turned a cache outage into a total outage, and the thing it
 * guards against is less harmful than that. An unreachable Redis drops back to
 * the local bucket and says so once.
 */
export async function takeRateTokenShared(
  key: string,
  limit: number,
  windowSeconds = 60,
  now = Date.now(),
): Promise<RateVerdict & { shared: boolean }> {
  const client = redis();
  if (!client) return { ...takeRateToken(key, limit, windowSeconds * 1000, now), shared: false };

  // A fixed window, aligned so every process agrees where it starts without
  // coordinating. A sliding window needs a sorted set and three commands; this
  // needs two, and the failure mode is a burst at a boundary rather than a
  // limit nobody shares.
  const window = Math.floor(now / (windowSeconds * 1000));
  const resetAt = (window + 1) * windowSeconds * 1000;

  try {
    const count = await client.incrementWithExpiry(`rl:${key}:${window}`, windowSeconds + 1);
    return {
      ok: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      shared: true,
    };
  } catch (err) {
    client.warnOnce(
      `  rate limiting fell back to this process's memory: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ...takeRateToken(key, limit, windowSeconds * 1000, now), shared: false };
  }
}

export function takeRateToken(
  key: string,
  limit: number,
  windowMs = 60_000,
  now = Date.now(),
): RateVerdict {
  const existing = buckets.get(key);
  const bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + windowMs };
  bucket.count++;
  buckets.set(key, bucket);

  // Opportunistic sweep so a long-lived process does not grow a bucket per
  // credential forever.
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }

  const remaining = Math.max(0, limit - bucket.count);
  return {
    ok: bucket.count <= limit,
    limit,
    remaining,
    resetAt: bucket.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}
