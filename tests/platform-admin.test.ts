import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from '../src/runtime/db.js';
import { changePlatformPerson, renamePlatformWorkspace } from '../src/runtime/platform-admin.js';
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
