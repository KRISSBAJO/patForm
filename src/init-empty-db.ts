import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyUpgrades, createPool, describeTarget } from './runtime/db.js';

/** One-time schema install. Refuses any database with an existing public object. */
if (process.argv[2] !== '--confirm-empty-staging-db') {
  throw new Error('Pass --confirm-empty-staging-db after setting DATABASE_URL to a new, empty staging database');
}

const pool = createPool(1);
try {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query<{ count: string }>(`
      select count(*)::text as count from pg_class
      where relnamespace = 'public'::regnamespace
        and relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    `);
    if (Number(result.rows[0]?.count) !== 0) {
      throw new Error(`Refusing to initialize nonempty database ${describeTarget()}`);
    }
    const here = dirname(fileURLToPath(import.meta.url));
    await client.query(readFileSync(join(here, 'runtime', 'schema.sql'), 'utf8'));
    await client.query('commit');
    console.log(`Initialized empty database ${describeTarget()}`);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await applyUpgrades(pool);
} finally {
  await pool.end();
}
