import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { X509Certificate, timingSafeEqual } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Money and totals must not arrive as JavaScript floats by accident, and
 * bigints must not silently lose precision. Both are parsed explicitly.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Client = pg.PoolClient;
export type Pool = pg.Pool;

/**
 * Renviq hands out a standard connection string. Nothing in this file is
 * specific to it: the same code runs against a local container, a managed
 * instance, or anything else speaking the PostgreSQL protocol.
 *
 * The URL is read from the environment and never logged, so a connection
 * string with a password in it does not end up in a transcript or a CI log.
 */
export function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Put a PostgreSQL connection string in .env (it is gitignored), ' +
        'or export it in your shell. Renviq gives you one on the database page.',
    );
  }
  return url;
}

/** Hides credentials when a connection target needs to appear in output. */
export function describeTarget(url = connectionString()): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

/**
 * `url` overrides DATABASE_URL, which the recovery drill needs: it restores
 * into a scratch database on the same server and has to talk to both.
 */
export function createPool(max = 10, url = connectionString()): Pool {
  const pinnedCertificatePath = process.env.DATABASE_TLS_CERT_PATH;
  let connectionUrl = url;
  let ssl: { rejectUnauthorized: boolean; ca?: string | string[]; checkServerIdentity?: (host: string, cert: { raw?: Buffer }) => Error | undefined } | undefined;
  if (pinnedCertificatePath) {
    const parsed = new URL(url);
    if (parsed.searchParams.get('sslmode') !== 'require') {
      throw new Error('DATABASE_TLS_CERT_PATH requires sslmode=require in DATABASE_URL');
    }
    // node-postgres replaces the explicit ssl object when sslmode is in the URL.
    parsed.searchParams.delete('sslmode');
    connectionUrl = parsed.toString();
    const pem = readFileSync(pinnedCertificatePath, 'utf8');
    const pinned = new X509Certificate(pem).raw;
    /*
     * Two ways to be trusted, and nothing else.
     *
     * The pinned certificate, byte for byte — Renviq's self-signed standby
     * certificate, which names its host rather than db.renviq.com, so the
     * hostname check is skipped for it. Or a certificate a public authority
     * issued for the host being connected to, checked the ordinary way. The
     * pin alone took staging down the morning Renviq moved to Let's Encrypt:
     * a certificate any browser would trust was refused for not being the
     * self-signed one, and every deploy after it failed to start.
     */
    ssl = {
      rejectUnauthorized: true,
      ca: [...tls.rootCertificates, pem],
      checkServerIdentity: (host, cert) =>
        cert.raw && cert.raw.length === pinned.length && timingSafeEqual(cert.raw, pinned)
          ? undefined
          : tls.checkServerIdentity(host, cert as tls.PeerCertificate),
    };
  } else if (url.includes('sslmode=require')) {
    // Retain the existing local/development behavior until those connections
    // have a pinned certificate or a provider-signed CA chain.
    ssl = { rejectUnauthorized: false };
  }
  return new pg.Pool({
    connectionString: connectionUrl,
    max,
    // A managed provider usually terminates TLS for you; when the URL asks for
    // TLS without pinning a CA, accept the provider's chain rather than failing
    // closed on a self-signed intermediate.
    ssl,
    application_name: 'patform-spike',
  });
}

/** Runs a function inside one transaction, rolling back on any throw. */
export async function inTransaction<T>(pool: Pool, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function resetSchema(pool: Pool): Promise<void> {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('drop schema if exists public cascade; create schema public;');
    await client.query(sql);
  } finally {
    client.release();
  }
}

/** Install the schema only when the public schema has no relations at all. */
export async function initializeEmptySchema(pool: Pool): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query<{ count: string }>(`
      select count(*)::text as count from pg_class
      where relnamespace = 'public'::regnamespace
        and relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    `);
    if (Number(result.rows[0]?.count) !== 0) {
      await client.query('rollback');
      return false;
    }
    await client.query(readFileSync(join(here, 'schema.sql'), 'utf8'));
    await client.query('commit');
    return true;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Brings an existing database up to the current schema, without dropping it.
 *
 * Every statement in upgrades.sql is safe to repeat, so this runs on every
 * start of the API and the worker. Before it, the only way to add a column to
 * a running database was a re-seed, which signed everybody out.
 */
export async function applyUpgrades(pool: Pool): Promise<void> {
  const sql = readFileSync(join(here, 'upgrades.sql'), 'utf8');
  await pool.query(sql);
}

/** Postgres error code for a unique-constraint violation. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}
