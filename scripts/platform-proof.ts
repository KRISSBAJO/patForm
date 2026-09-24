import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectionString, createPool, resetSchema } from '../src/runtime/db.js';
import { bootstrapPlatformOwner, grantPlatformOperator, platformAudit, platformOperators,
  requirePlatformRole, revokePlatformOperator } from '../src/runtime/platform-admin.js';

const url = new URL(connectionString());
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Platform proof requires local PostgreSQL');
const database = `patform_platform_proof_${randomUUID().replaceAll('-', '')}`;
const admin = createPool(1);
const scratchUrl = new URL(url);
scratchUrl.pathname = `/${database}`;
let created = false;
try {
  await admin.query(`create database ${database}`);
  created = true;
  const pool = createPool(2, scratchUrl.toString());
  try {
    await resetSchema(pool);
    const tenant = await pool.query<{ id: string }>(`insert into tenant (name) values ('Proof') returning id`);
    const tenantId = tenant.rows[0]!.id;
    const owner = await pool.query<{ id: string }>(`insert into actor
      (tenant_id, email, display_name, workspace_role, email_verified_at)
      values ($1, 'site1@example.org', 'Site One', 'read_only', now()) returning id`, [tenantId]);
    const other = await pool.query<{ id: string }>(`insert into actor
      (tenant_id, email, display_name, workspace_role, email_verified_at)
      values ($1, 'site2@example.org', 'Site Two', 'owner', now()) returning id`, [tenantId]);
    const ownerId = owner.rows[0]!.id;
    const otherId = other.rows[0]!.id;
    await pool.query(`insert into credential (actor_id, password_hash) values ($1, 'proof'), ($2, 'proof')`, [ownerId, otherId]);
    await pool.query(`insert into mfa_enrolment (actor_id, secret, confirmed_at) values ($1, 'proof', now()), ($2, 'proof', now())`, [ownerId, otherId]);
    await assert.rejects(requirePlatformRole(pool, otherId), /platform access requires/);
    process.env.PLATFORM_BOOTSTRAP_EMAILS = 'site1@example.org';
    await bootstrapPlatformOwner(pool);
    await bootstrapPlatformOwner(pool);
    assert.equal(await requirePlatformRole(pool, ownerId, 'owner'), 'owner');
    assert.equal((await grantPlatformOperator(pool, ownerId, 'site2@example.org', 'operator')).granted, true);
    assert.equal(await requirePlatformRole(pool, otherId, 'operator'), 'operator');
    await assert.rejects(requirePlatformRole(pool, otherId, 'owner'), /platform access requires/);
    assert.equal((await revokePlatformOperator(pool, ownerId, ownerId)).revoked, false);
    assert.equal((await revokePlatformOperator(pool, ownerId, otherId)).revoked, true);
    await assert.rejects(requirePlatformRole(pool, otherId), /platform access requires/);
    assert.equal((await platformOperators(pool)).rows.length, 2);
    assert.equal((await platformAudit(pool, 1)).rows.length, 3);
    console.log('Platform proof: workspace owner denied; explicit grants, MFA, roles, last-owner protection and audit passed');
  } finally { await pool.end(); }
} finally {
  delete process.env.PLATFORM_BOOTSTRAP_EMAILS;
  if (created) await admin.query(`drop database ${database}`);
  await admin.end();
}
