import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from '../src/runtime/db.js';
import { changePlatformPerson, renamePlatformWorkspace, revokePlatformApiKey, setPlatformIntakePaused, setPlatformWebhookActive } from '../src/runtime/platform-admin.js';
import { requireIntakeOpen } from '../src/runtime/intake-control.js';
import { stepUpFor } from '../src/runtime/step-up.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const personId = '22222222-2222-4222-8222-222222222222';
const adminId = '33333333-3333-4333-8333-333333333333';

function fakePool(answer: (sql: string, params: unknown[] | undefined) => { rows: unknown[]; rowCount?: number }) {
  const calls: string[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => { calls.push(sql); return answer(sql, params); },
    release: () => {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, calls };
}

test('site access changes require a fresh identity check', () => {
  assert.ok(stepUpFor('POST', `/api/platform/workspaces/${tenantId}/rename`, {}));
  assert.ok(stepUpFor('POST', `/api/platform/workspaces/${tenantId}/people/${personId}/access`, {}));
  assert.ok(stepUpFor('POST', `/api/platform/workspaces/${tenantId}/intake`, {}));
  assert.ok(stepUpFor('POST', `/api/platform/workspaces/${tenantId}/webhooks/${personId}/status`, {}));
  assert.ok(stepUpFor('POST', `/api/platform/workspaces/${tenantId}/keys/${personId}/revoke`, {}));
});

test('a paused workspace refuses new submissions but an open workspace accepts them', async () => {
  const db = { query: async () => ({ rows: [{ intake_paused_at: new Date() }] }) } as unknown as Pool;
  await assert.rejects(requireIntakeOpen(db, tenantId, true), /new submissions are paused/);
  const open = { query: async () => ({ rows: [{ intake_paused_at: null }] }) } as unknown as Pool;
  await requireIntakeOpen(open, tenantId, true);
});

test('pausing workspace intake records a reason and can be reversed', async () => {
  let paused = false;
  const { pool, calls } = fakePool((sql, params) => {
    if (sql.startsWith('select intake_paused_at')) return { rows: [{ intake_paused_at: paused ? new Date() : null }] };
    if (sql.startsWith('update tenant set intake_paused_at')) paused = Boolean(params?.[0]);
    if (sql.includes('insert into platform_admin_audit')) assert.equal(JSON.parse(String(params?.[3])).reason, 'Investigating a spam campaign');
    return { rows: [] };
  });
  assert.deepEqual(await setPlatformIntakePaused(pool, adminId, tenantId, true, 'Investigating a spam campaign'), { changed: true, paused: true });
  assert.deepEqual(await setPlatformIntakePaused(pool, adminId, tenantId, false, 'Investigating a spam campaign'), { changed: true, paused: false });
  assert.equal(calls.filter((sql) => sql.includes('insert into platform_admin_audit')).length, 2);
});

test('site admin can disable a webhook with a reason, and revocation is scoped to a workspace', async () => {
  const { pool, calls } = fakePool((sql, params) => {
    if (sql.startsWith('select id from tenant')) return { rows: [{ id: tenantId }] };
    if (sql.startsWith('select active from webhook_endpoint')) return { rows: [{ active: true }] };
    if (sql.startsWith('select revoked_at from api_key')) return { rows: [] };
    if (sql.includes('insert into platform_admin_audit')) assert.equal(JSON.parse(String(params?.[4])).reason, 'Endpoint is compromised');
    return { rows: [] };
  });
  assert.deepEqual(await setPlatformWebhookActive(pool, adminId, tenantId, personId, false, 'Endpoint is compromised'), { changed: true, active: false });
  assert.ok(calls.some((sql) => sql.startsWith('update webhook_endpoint')));
  const revoked = await revokePlatformApiKey(pool, adminId, tenantId, personId, 'Endpoint is compromised');
  assert.equal(revoked.changed, false);
  assert.equal(calls.some((sql) => sql.startsWith('update api_key')), false);
});

test('site admin cannot remove the final workspace owner', async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.startsWith('select id from tenant')) return { rows: [{ id: tenantId }] };
    if (sql.startsWith('select active, workspace_role')) return { rows: [{ active: true, workspace_role: 'owner', display_name: 'Owner' }] };
    if (sql.includes('count(*)::int as count from actor')) return { rows: [{ count: 0 }] };
    return { rows: [] };
  });
  const result = await changePlatformPerson(pool, adminId, tenantId, personId,
    { active: false, reason: 'Account departure confirmed' });
  assert.equal(result.changed, false);
  assert.match(result.reason ?? '', /another active workspace owner/);
  assert.equal(calls.some((q) => q.startsWith('update actor')), false);
  assert.equal(calls.some((q) => q.includes('insert into platform_admin_audit')), false);
});

test('site admin cannot deactivate a person with an active platform grant', async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.startsWith('select id from tenant')) return { rows: [{ id: tenantId }] };
    if (sql.startsWith('select active, workspace_role')) return { rows: [{ active: true, workspace_role: 'admin', display_name: 'Admin' }] };
    if (sql.startsWith('select role from platform_operator')) return { rows: [{ role: 'operator' }] };
    return { rows: [] };
  });
  const result = await changePlatformPerson(pool, adminId, tenantId, personId,
    { active: false, reason: 'Account departure confirmed' });
  assert.equal(result.changed, false);
  assert.match(result.reason ?? '', /site admin grant/);
  assert.equal(calls.some((q) => q.startsWith('update actor')), false);
});

test('workspace rename records who changed it, before and after, and why', async () => {
  const { pool } = fakePool((sql, params) => {
    if (sql.startsWith('select name from tenant')) return { rows: [{ name: 'Old name' }] };
    if (sql.includes('insert into platform_admin_audit')) {
      assert.equal(params?.[0], adminId);
      assert.deepEqual(JSON.parse(String(params?.[2])), {
        from: 'Old name', to: 'New name', reason: 'Customer requested correction',
      });
    }
    return { rows: [] };
  });
  const result = await renamePlatformWorkspace(pool, adminId, tenantId, 'New name', 'Customer requested correction');
  assert.equal(result.changed, true);
});
