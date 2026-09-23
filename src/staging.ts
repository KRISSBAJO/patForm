import { applyUpgrades, createPool, describeTarget, initializeEmptySchema } from './runtime/db.js';
import { syncBuiltInPacks } from './packs/sync-builtins.js';

/**
 * Render Free can run one web service, but not a separate background worker.
 * Run both while the service is awake for a disposable staging environment.
 * Timers and delivery stop during Render's idle suspension.
 */
if (process.env.STAGING_COMBINED_SERVICE !== 'true') {
  throw new Error('STAGING_COMBINED_SERVICE=true is required for the combined staging service');
}

const pool = createPool(2);
try {
  if (await initializeEmptySchema(pool)) {
    console.log(`Initialized empty staging database ${describeTarget()}`);
  }
  await applyUpgrades(pool);
  const packs = await syncBuiltInPacks(pool);
  console.log(`Built-in packs: ${packs.total} available, ${packs.published} published or updated`);
} finally {
  await pool.end();
}

await Promise.all([import('./api/server.js'), import('./worker.js')]);
