import { applyUpgrades, createPool, describeTarget, initializeEmptySchema } from './runtime/db.js';
import { syncBuiltInPacks } from './packs/sync-builtins.js';
import { bootstrapPlatformOwner, recordDeployment } from './runtime/platform-admin.js';

/**
 * Render Free can run one web service, but not a separate background worker.
 * Run both while the service is awake for a disposable staging environment.
 * Timers and delivery stop during Render's idle suspension.
 */
if (process.env.STAGING_COMBINED_SERVICE !== 'true') {
  throw new Error('STAGING_COMBINED_SERVICE=true is required for the combined staging service');
}

const serviceStartedAt = new Date();
const pool = createPool(2);
try {
  if (await initializeEmptySchema(pool)) {
    console.log(`Initialized empty staging database ${describeTarget()}`);
  }
  await applyUpgrades(pool);
  await bootstrapPlatformOwner(pool);
  await recordDeployment(pool);
  const packs = await syncBuiltInPacks(pool);
  console.log(`Built-in packs: ${packs.total} available, ${packs.published} published or updated`);
} finally {
  await pool.end();
}

await Promise.all([import('./api/server.js'), import('./worker.js')]);

// Render replaces the single combined service during a deploy. An AI call
// interrupted in the retired process must not sit in "running" for 30 minutes.
// Wait until the replacement is live, then recover only jobs started before it.
setTimeout(() => {
  void (async () => {
    const recoveryPool = createPool(1);
    try {
      const recovered = await recoveryPool.query(
        `update ai_draft_job set status = 'queued', stage = 'waiting', started_at = null
         where status = 'running' and started_at < $1`, [serviceStartedAt],
      );
      if (recovered.rowCount) console.log(`Recovered ${recovered.rowCount} interrupted AI draft job(s)`);
    } finally {
      await recoveryPool.end();
    }
  })().catch((error) => console.error('AI job recovery failed:', error instanceof Error ? error.message : error));
}, 90_000);
