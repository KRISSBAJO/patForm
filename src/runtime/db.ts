import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

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
  return new pg.Pool({
    connectionString: url,
    max,
    // A managed provider usually terminates TLS for you; when the URL asks for
    // TLS without pinning a CA, accept the provider's chain rather than failing
    // closed on a self-signed intermediate.
    ssl: url.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
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

/** Postgres error code for a unique-constraint violation. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}
