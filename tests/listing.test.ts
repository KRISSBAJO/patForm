import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { buildList, readListQuery, toCsv, type ListSpec } from '../src/runtime/listing.js';
import { saveBranch, searchEmployees } from '../src/runtime/hr-records.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const spec: ListSpec = { defaultSort: 'name:asc', columns: {
  name: { sql: 'e.name', sortable: true, searchable: true },
  status: { sql: 'e.status', filters: { status: 'in' } },
  start: { sql: 'e.start_date', sortable: true, filters: { from: 'date_from', to: 'date_to' } },
  secret: { sql: 'e.pay' },
} };

test('listing: only allowed sorts, bounded page sizes, typed filters, escaped search', () => {
  const q = readListQuery(new URLSearchParams('page=0&size=9999&sort=secret:desc&q=%25ada_&status=active,left&from=2026-01-01&bogus=1'), spec);
  assert.equal(q.page, 1); assert.equal(q.size, 200);
  assert.deepEqual(q.sort, { column: 'name', dir: 'desc' }, 'a column that cannot be sorted falls back to the default, keeping the direction');
  assert.deepEqual(q.filters, { status: 'active,left', from: '2026-01-01' });
  const b = buildList(spec, q, ['tenant']);
  assert.match(b.where[0]!, /e\.name::text ilike \$2/);
  assert.equal(b.params[1], '%\\%ada\\_%', 'wildcards in the search are escaped');
  assert.deepEqual(b.params[2], ['active', 'left']);
  assert.equal(b.params[3], '2026-01-01');
  assert.equal(b.orderBy, 'order by e.name desc nulls last');
  assert.equal(b.limit, 'limit 200 offset 0');
  assert.throws(() => buildList(spec, readListQuery(new URLSearchParams('from=yesterday'), spec), []), /must be a date/);
  assert.equal(toCsv([{ a: 'x,y', b: 'say "hi"' }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]), 'A,B\r\n"x,y","say ""hi"""\r\n');
});

test('people search: pages, sorts, filters by branch and status, searches, exports the filtered list', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const tenantId = await engine.createTenant(`list-${stamp()}`, { scenario: true });
    const ownerId = await engine.createActor(tenantId, `owner-${stamp()}@list.test`, 'Owner', 'owner');
    await pool.query('update actor set email_verified_at = now() where id = $1', [ownerId]);
    const owner: Principal = { kind: 'actor', tenantId, actorId: ownerId };
    await setModule(pool, owner, 'hr', { enabled: true });
    const lagos = await saveBranch(pool, owner, { name: 'Lagos', country: 'NG', currency: 'NGN' });
    const london = await saveBranch(pool, owner, { name: 'London', country: 'GB', currency: 'GBP' });
    for (let i = 0; i < 60; i++) {
      await pool.query(`insert into employee_record (tenant_id, email, name, status, employment_type, branch_id, start_date, grade) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, `p${i}-${stamp()}@list.test`, `Person ${String(i).padStart(2, '0')}`, i % 10 === 0 ? 'left' : 'active', i % 3 === 0 ? 'contractor' : 'employee', i % 2 ? lagos.id : london.id, `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, i % 4 === 0 ? 'G5' : 'G3']);
    }
    const p1 = await searchEmployees(pool, owner, new URLSearchParams('size=25'));
    assert.equal(p1.total, 60); assert.equal(p1.pages, 3); assert.equal(p1.rows.length, 25);
    assert.equal(p1.rows[0]!.name, 'Person 00');
    const p3 = await searchEmployees(pool, owner, new URLSearchParams('size=25&page=3&sort=name:desc'));
    assert.equal(p3.rows.length, 10); assert.equal(p3.rows[0]!.name, 'Person 09');
    const lagosActive = await searchEmployees(pool, owner, new URLSearchParams(`branch=${lagos.id}&status=active`));
    assert.equal(lagosActive.total, 30 - 0, 'odd indexes are Lagos; none of them is a multiple of ten');
    assert.ok(lagosActive.rows.every((r) => r.branch === 'Lagos' && r.status === 'active'));
    const found = await searchEmployees(pool, owner, new URLSearchParams('q=person 1'));
    assert.equal(found.total, 10, 'Person 10 to 19');
    const dated = await searchEmployees(pool, owner, new URLSearchParams('started_from=2026-01-27&sort=start_date:desc'));
    assert.ok(dated.total > 0 && dated.rows.every((r) => String(r.start_date) >= '2026-01-27'));
    const facets = (p1 as { facets: { kind: string; name: string; n: number }[] }).facets;
    assert.ok(facets.some((f) => f.kind === 'branch' && f.name === 'London' && f.n === 24));
    assert.ok(facets.some((f) => f.kind === 'status' && f.name === 'left' && f.n === 6));
    const csv = await searchEmployees(pool, owner, new URLSearchParams(`format=csv&branch=${london.id}`)) as { csv: string; rows: number };
    assert.equal(csv.rows, 30);
    assert.equal(csv.csv.split('\r\n').filter(Boolean).length, 31, 'every filtered row, not one page');
    assert.match(csv.csv, /^Name,Email,Job title/);
  } finally { await pool.end(); }
});
