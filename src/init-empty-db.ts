import { applyUpgrades, createPool, describeTarget, initializeEmptySchema } from './runtime/db.js';

/** One-time schema install. Refuses any database with an existing public object. */
if (process.argv[2] !== '--confirm-empty-staging-db') {
  throw new Error('Pass --confirm-empty-staging-db after setting DATABASE_URL to a new, empty staging database');
}

const pool = createPool(1);
try {
  if (!await initializeEmptySchema(pool)) {
    throw new Error(`Refusing to initialize nonempty database ${describeTarget()}`);
  }
  console.log(`Initialized empty database ${describeTarget()}`);
  await applyUpgrades(pool);
} finally {
  await pool.end();
}
