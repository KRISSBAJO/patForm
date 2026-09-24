import assert from 'node:assert/strict';
import { applyUpgrades, createPool } from '../src/runtime/db.js';
import { platformAudit, platformJobs, platformMail, platformOverview, platformWorkspaces, requirePlatformRole } from '../src/runtime/platform-admin.js';

const pool = createPool(2);
try {
  await applyUpgrades(pool);
  await applyUpgrades(pool);
  const actor = await pool.query<{ id: string }>(
    `select a.id from actor a left join platform_operator p on p.actor_id = a.id and p.revoked_at is null
     where p.actor_id is null limit 1`,
  );
  if (actor.rows[0]) {
    await assert.rejects(requirePlatformRole(pool, actor.rows[0].id), /platform access requires/);
  }
  const [overview, workspaces, jobs, mail, audit] = await Promise.all([
    platformOverview(pool), platformWorkspaces(pool, '', 1), platformJobs(pool, 1), platformMail(pool), platformAudit(pool, 1),
  ]);
  assert.ok(overview.counts.workspaces >= 0);
  assert.ok(Array.isArray(workspaces.rows));
  assert.ok(Array.isArray(jobs.rows));
  assert.ok(Array.isArray(mail.process));
  assert.ok(Array.isArray(audit.rows));
  assert.ok(!JSON.stringify({ overview, workspaces, jobs, mail, audit }).includes('password_hash'));
  console.log('Platform migration, repeatability, access denial and read models: OK');
} finally {
  await pool.end();
}
