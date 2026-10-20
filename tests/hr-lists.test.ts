import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { setManager } from '../src/runtime/org.js';
import { createDocument, requestLeave, saveHoliday, sendDocument, startOffboarding, startOnboarding, updateEmployee } from '../src/runtime/hr.js';
import { saveBranch, setEmployeeBranch } from '../src/runtime/hr-records.js';
import { searchCases, searchDocuments, searchHiring, searchHolidays, searchLeave, searchReconciliation, searchUpcoming } from '../src/runtime/hr-lists.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const q = (s: string) => new URLSearchParams(s);

test('HR lists: cases, leave, holidays, documents, upcoming and reconciliation page, filter and export; a manager sees only their reports’ leave', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const tenantId = await engine.createTenant(`hr-lists-${stamp()}`, { scenario: true });
    const mk = async (name: string, role: 'owner' | 'approver' | 'read_only') => { const id = await engine.createActor(tenantId, `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@lists.test`, name, role); await pool.query('update actor set email_verified_at = now() where id = $1', [id]); return { id, p: { kind: 'actor', tenantId, actorId: id } as Principal }; };
    const owner = await mk('Owner', 'owner'); const mo = await mk('Mo Manager', 'approver'); const sam = await mk('Sam Staff', 'read_only'); const olu = await mk('Olu Other', 'read_only');
    await setModule(pool, owner.p, 'hr', { enabled: true });
    await setManager(pool, owner.p, sam.id, { managerId: mo.id, effectiveFrom: '2026-01-01T00:00:00Z' });
    const lagos = await saveBranch(pool, owner.p, { name: 'Lagos', country: 'NG', currency: 'NGN' });
    const emp = async (actorId: string) => (await pool.query<{ id: string }>(`insert into employee_record (tenant_id, actor_id, email, name, status, start_date) select $1, id, email, display_name, 'active', '2025-02-01' from actor where id = $2 returning id`, [tenantId, actorId])).rows[0]!.id;
    const samId = await emp(sam.id); const oluId = await emp(olu.id);
    await setEmployeeBranch(pool, owner.p, samId, { branchId: lagos.id });
    // Cases: two onboardings and an offboarding.
    for (let i = 0; i < 2; i++) await startOnboarding(pool, owner.p, { email: `new${i}-${stamp()}@lists.test`, name: `New Person ${i}`, startDate: addDays(5 + i), managerId: mo.id, branchId: lagos.id });
    await startOffboarding(pool, owner.p, { employeeId: oluId, endDate: addDays(20) });
    const cases = await searchCases(pool, owner.p, q('size=2&sort=name:asc'));
    assert.equal(cases.total, 3); assert.equal(cases.rows.length, 2); assert.equal(cases.rows[0]!.name, 'New Person 0');
    assert.ok(Number(cases.rows[0]!.total) > 0 && Number(cases.rows[0]!.done) === 0);
    const joining = await searchCases(pool, owner.p, q(`kind=onboarding&branch=${lagos.id}`));
    assert.equal(joining.total, 2);
    assert.ok((cases as { facets: { kind: string; name: string; n: number }[] }).facets.some((f) => f.kind === 'kind' && f.name === 'offboarding' && f.n === 1));
    await assert.rejects(searchCases(pool, mo.p, q('')), /only HR/);
    // Leave: Sam and Olu ask; Mo sees only Sam's; HR sees both and filters by status.
    await requestLeave(pool, sam.p, { type: 'annual', startDate: addDays(30), endDate: addDays(31) });
    await requestLeave(pool, olu.p, { type: 'annual', startDate: addDays(40), endDate: addDays(41) });
    const all = await searchLeave(pool, owner.p, q('status=requested&sort=name:asc'));
    assert.equal(all.total, 2); assert.equal(all.rows[0]!.name, 'Olu Other');
    assert.equal((await searchLeave(pool, owner.p, q(`branch=${lagos.id}`))).total, 1);
    const mine = await searchLeave(pool, mo.p, q(''));
    assert.deepEqual(mine.rows.map((r) => r.name), ['Sam Staff']);
    const csv = await searchLeave(pool, owner.p, q('format=csv')) as { csv: string; rows: number };
    assert.equal(csv.rows, 2); assert.match(csv.csv, /^Person,Type,From/);
    // Holidays default to this year; a branch filter narrows them.
    const year = new Date().getUTCFullYear();
    await saveHoliday(pool, owner.p, { day: `${year}-12-25`, name: 'Christmas' });
    await saveHoliday(pool, owner.p, { day: `${year}-10-01`, name: 'Independence Day', branchId: lagos.id });
    await saveHoliday(pool, owner.p, { day: `${year - 1}-12-25`, name: 'Old Christmas' });
    const hol = await searchHolidays(pool, sam.p, q(''));
    assert.deepEqual(hol.rows.map((r) => r.name), ['Independence Day', 'Christmas']);
    assert.equal((await searchHolidays(pool, sam.p, q(`branch=${lagos.id}`))).total, 1);
    assert.equal((await searchHolidays(pool, sam.p, q(`year=${year - 1}`))).total, 1);
    // Documents with counts and a has_file filter.
    const doc = await createDocument(pool, owner.p, { title: 'Code of conduct', version: '2', kind: 'agreement' });
    await sendDocument(pool, owner.p, doc.id, { employeeIds: [samId, oluId] });
    await createDocument(pool, owner.p, { title: 'Travel policy', version: '1', kind: 'receipt' });
    const docs = await searchDocuments(pool, owner.p, q('sort=sent:desc'));
    assert.equal(docs.total, 2); assert.equal(docs.rows[0]!.title, 'Code of conduct'); assert.equal(docs.rows[0]!.sent, 1, 'Olu is leaving, so only Sam got it');
    assert.equal((await searchDocuments(pool, owner.p, q('kind=receipt'))).total, 1);
    assert.equal((await searchDocuments(pool, owner.p, q('has_file=true'))).total, 0);
    // Upcoming: the two starts and the leaver.
    const soon = await searchUpcoming(pool, owner.p, q('kind=start,leaving'));
    assert.equal(soon.total, 3);
    assert.equal((await searchUpcoming(pool, owner.p, q(`kind=start&branch=${lagos.id}`))).total, 2);
    // Reconciliation: payroll owns the payroll reference, so a change becomes an item.
    await pool.query(`insert into hr_settings (tenant_id, field_owners) values ($1, '{"payroll_ref":"Payroll"}') on conflict (tenant_id) do update set field_owners = excluded.field_owners`, [tenantId]);
    await updateEmployee(pool, owner.p, samId, { payrollRef: 'P-100' });
    const recon = await searchReconciliation(pool, owner.p, q('status=open'));
    assert.equal(recon.total, 1); assert.equal(recon.rows[0]!.owner, 'Payroll'); assert.equal(recon.rows[0]!.name, 'Sam Staff');
    // Hiring list runs even when empty.
    assert.equal((await searchHiring(pool, owner.p, q(''))).total, 0);
  } finally { await pool.end(); }
});
