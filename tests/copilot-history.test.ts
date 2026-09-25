import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from '../src/runtime/db.js';
import { recentRuns } from '../src/runtime/copilot.js';

test('Ask activity searches and pages within the selected workspace and process', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return calls.length === 1 ? { rows: [{ count: 200 }] } : { rows: [{ id: 'last-page-run' }] };
    },
  } as unknown as Pool;
  const search = "receipt%' OR true --";
  const result = await recentRuns(pool, { kind: 'actor', tenantId: 'workspace-1', actorId: 'person-1' }, {
    processKey: 'expense', query: search, page: 20, pageSize: 10,
  });

  assert.equal(result.total, 200);
  assert.equal(result.page, 20);
  assert.equal(result.pageSize, 10);
  assert.deepEqual(result.runs, [{ id: 'last-page-run' }]);
  assert.deepEqual(calls[0]?.params, ['workspace-1', 'expense', search]);
  assert.deepEqual(calls[1]?.params, ['workspace-1', 'expense', search, 10, 190]);
  assert.ok(calls.every(({ sql }) => sql.includes('r.tenant_id = $1') && sql.includes('r.process_key = $2')));
  assert.ok(calls.every(({ sql }) => !sql.includes(search)));
});

test('Ask activity issue filter includes failed and refused runs before pagination', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return calls.length === 1 ? { rows: [{ count: 2 }] } : { rows: [{ id: 'failed-1' }, { id: 'refused-1' }] };
    },
  } as unknown as Pool;
  const result = await recentRuns(pool, { kind: 'actor', tenantId: 'workspace-1', actorId: 'person-1' }, { status: 'issues' });
  assert.equal(result.total, 2);
  assert.equal(result.runs.length, 2);
  assert.ok(calls.every(({ sql }) => sql.includes("r.status in ('failed', 'refused')")));
  assert.deepEqual(calls[1]?.params, ['workspace-1', 10, 0]);
});
