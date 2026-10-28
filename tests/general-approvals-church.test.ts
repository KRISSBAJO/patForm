import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { memoryObjectStore, setObjectStoreForTests } from '../src/runtime/object-store.js';
import { rerouteOffice } from '../src/runtime/approvals.js';
import { appoint, endAppointment, readStructure, saveUnit, setupChurch, unitDetail } from '../src/runtime/structure.js';
import { createRequest, decideRequest, listCategories, listTypes, matches, requestDetail, submitRequest, uploadFile } from '../src/runtime/general-approvals.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const reroute = (c: Parameters<typeof rerouteOffice>[0], t: string, u: string, o: string) => rerouteOffice(c, t, u, o).then(() => undefined);

async function church(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`ga-church-${stamp()}`, { scenario: true });
  const mk = async (name: string, role: 'owner' | 'approver' | 'read_only' = 'approver') => {
    const id = await engine.createActor(tenantId, `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@church.test`, name, role);
    await pool.query('update actor set email_verified_at = now() where id = $1', [id]);
    return { id, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner');
  await setModule(pool, owner.p, 'general_approvals', { enabled: true });
  const setup = await setupChurch(pool, owner.p, { adoptPolicy: false }, async () => undefined);
  const s = await readStructure(pool, owner.p);
  const lv = (k: string) => s.levels.find((l) => l.key === k)!.id;
  const of = (k: string) => s.officeTypes.find((o) => o.key === k)!.id;
  const unit = async (name: string, k: string, parentId: string | null) => (await saveUnit(pool, owner.p, { name, levelId: lv(k), parentId })).id;
  const nat = await unit('Nigeria', 'national', null); const dist = await unit('District 01', 'district', nat); const zone = await unit('Zone 03', 'zone', dist);
  const area = await unit('Area 07', 'area', zone); const s1 = await unit('Ikeja Station', 'station', area); const s2 = await unit('Ojodu Station', 'station', area);
  const p = {
    np: await mk('Nana National'), dp: await mk('Dele District'), zp: await mk('Zara Zonal'), ap: await mk('Ade Area'), aadmin: await mk('Ama AreaAdmin'),
    rp2: await mk('Rita Resident'), assoc2: await mk('Ayo Associate'), cadmin2: await mk('Chi Admin'), sec2: await mk('Sola Secretary'),
    m1: await mk('Mo Member', 'read_only'), m2: await mk('Mary Member', 'read_only'),
  };
  const seat = (u: string, k: string, who: string, extra: Record<string, unknown> = {}) => appoint(pool, owner.p, { unitId: u, officeTypeId: of(k), actorId: who, ...extra }, reroute);
  await seat(nat, 'national_pastor', p.np.id); await seat(dist, 'district_pastor', p.dp.id); await seat(zone, 'zonal_pastor', p.zp.id);
  await seat(area, 'area_pastor', p.ap.id); await seat(s1, 'resident_pastor', p.ap.id); await seat(area, 'area_admin', p.aadmin.id);
  await seat(s2, 'resident_pastor', p.rp2.id); await seat(s2, 'associate_pastor', p.assoc2.id); await seat(s2, 'church_admin', p.cadmin2.id);
  for (const [who, at] of [[p.m1, s1], [p.m2, s2]] as const) await pool.query('update actor set org_unit_id = $2 where id = $1', [who.id, at]);
  // Ojodu's Church Management Committee, linked so a step can ask "the CMC".
  const { rows: body } = await pool.query<{ id: string }>(`insert into mtg_body (tenant_id, name, kind, org_unit_id, structure_key) values ($1, 'Ojodu CMC', 'committee', $2, 'cmc') returning id`, [tenantId, s2]);
  for (const m of [p.assoc2, p.cadmin2, p.sec2]) await pool.query('insert into mtg_body_member (tenant_id, body_id, actor_id) values ($1, $2, $3)', [tenantId, body[0]!.id, m.id]);
  const types = await listTypes(pool, owner.p);
  const type = (seed: string) => types.find((t: { seed_key: string | null }) => t.seed_key === seed) as { id: string };
  return { tenantId, owner, setup, p, units: { s1, s2, area }, seat, type, of };
}
const pendingNames = async (pool: Pool, id: string) => (await pool.query<{ name: string }>(`select s.name from general_request_step s join general_request r on r.id = s.request_id and r.round = s.round where s.request_id = $1 and s.status = 'pending' order by s.position`, [id])).rows.map((r) => r.name);
const approvers = async (pool: Pool, id: string, name: string) => (await pool.query<{ approvers: string[] }>(`select s.approvers from general_request_step s join general_request r on r.id = s.request_id and r.round = s.round where s.request_id = $1 and s.name = $2`, [id, name])).rows[0]?.approvers ?? [];
const pdf = Buffer.from('%PDF-1.4 quotation').toString('base64');

test('conditions read the answers', () => {
  assert.equal(matches({ field: 'amount', op: 'gte', value: 5000 }, { amount: 5000 }), true);
  assert.equal(matches({ field: 'amount', op: 'gte', value: 5000 }, { amount: 4999 }), false);
  assert.equal(matches({ field: 'amount', op: 'gte', value: 5000 }, {}), false);
  assert.equal(matches({ field: 'level', op: 'in', values: ['Administrator'] }, { level: 'Administrator' }), true);
  assert.equal(matches({ field: 'outside', op: 'yes' }, { outside: false }), false);
  assert.equal(matches(undefined, {}), true);
});

test('a church starts with categories and three request types routed by office', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await church(pool, engine);
    assert.equal(w.setup.requestTypes, 3);
    const cats = await listCategories(pool, w.owner.p);
    assert.ok(cats.some((c: { name: string }) => c.name === 'Finance'));
    assert.ok(w.type('church_expenditure') && w.type('church_facility') && w.type('church_access'));
  } finally { await pool.end(); }
});

test('a station expenditure: documents by amount, the Resident Pastor and the CMC side by side, then up the line', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  setObjectStoreForTests(memoryObjectStore().store);
  try {
    const w = await church(pool, engine); const { p } = w;
    const r = await createRequest(pool, p.m2.p, { typeId: w.type('church_expenditure').id, title: 'Chairs for the children', answers: { amount: 6000, purpose: 'Forty chairs for the children’s church.' } });
    await assert.rejects(submitRequest(pool, p.m2.p, r.id), /attach the quotation/);
    await uploadFile(pool, p.m2.p, r.id, { filename: 'quote.pdf', base64: pdf, documentKey: 'quotation' });
    await submitRequest(pool, p.m2.p, r.id);
    // Stage one: the Resident Pastor and the CMC at once (6,000 is above the CMC line).
    assert.deepEqual(await pendingNames(pool, r.id), ['Resident Pastor', 'CMC review']);
    assert.deepEqual(await approvers(pool, r.id, 'Resident Pastor'), [p.rp2.id]);
    await decideRequest(pool, p.rp2.p, r.id, { decision: 'approve' });
    assert.deepEqual(await pendingNames(pool, r.id), ['CMC review'], 'the stage waits for the committee');
    await decideRequest(pool, p.assoc2.p, r.id, { decision: 'approve' });
    const after = await decideRequest(pool, p.cadmin2.p, r.id, { decision: 'approve' });
    assert.deepEqual(after.next, ['Area Pastor'], 'two of three is a majority of the CMC');
    await decideRequest(pool, p.ap.p, r.id, { decision: 'approve' });
    assert.deepEqual(await pendingNames(pool, r.id), ['Zonal Pastor']);
    const done = await decideRequest(pool, p.zp.p, r.id, { decision: 'approve' });
    assert.equal(done.status, 'approved');
    const d = await requestDetail(pool, p.m2.p, r.id);
    assert.deepEqual(d.steps.filter((s: { status: string }) => s.status === 'not_needed').map((s: { name: string }) => s.name), ['District Pastor', 'National Pastor']);
    const zonal = d.events.find((e: { kind: string; detail: { step?: string } }) => e.kind === 'decision' && e.detail.step === 'Zonal Pastor') as { detail: { as: { office: string }[] } };
    assert.equal(zonal.detail.as[0]!.office, 'Zonal Pastor', 'the record says in which office they decided');
  } finally { setObjectStoreForTests(null); await pool.end(); }
});

test('one pastor in two offices approves once; administrator access adds the Area Admin; mandates cap; transfers move the step', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await church(pool, engine); const { p, units: u } = w;
    // Ikeja: Ade is Resident Pastor there and Area Pastor. 1,500 needs both; he decides once.
    const a = await createRequest(pool, p.m1.p, { typeId: w.type('church_expenditure').id, title: 'Generator repair', answers: { amount: 1500, purpose: 'Repair the generator before Sunday.' } });
    await submitRequest(pool, p.m1.p, a.id);
    assert.deepEqual(await pendingNames(pool, a.id), ['Resident Pastor']);
    const one = await decideRequest(pool, p.ap.p, a.id, { decision: 'approve' });
    assert.equal(one.status, 'approved');
    const da = await requestDetail(pool, p.m1.p, a.id);
    assert.equal(da.steps.find((s: { name: string }) => s.name === 'Area Pastor').status, 'skipped');

    // Access: Administrator level brings in the Area Admin after the Church Administrator.
    const b = await createRequest(pool, p.m2.p, { typeId: w.type('church_access').id, title: 'Website admin', answers: { system: 'Church website', level: 'Administrator', reason: 'I run the media unit.' } });
    await submitRequest(pool, p.m2.p, b.id);
    assert.deepEqual(await pendingNames(pool, b.id), ['Church Administrator']);
    const nb = await decideRequest(pool, p.cadmin2.p, b.id, { decision: 'approve' });
    assert.deepEqual(nb.next, ['Area Admin']);
    const c = await createRequest(pool, p.m2.p, { typeId: w.type('church_access').id, title: 'Website view', answers: { system: 'Church website', level: 'View', reason: 'Checking the schedule.' } });
    await submitRequest(pool, p.m2.p, c.id);
    assert.equal((await decideRequest(pool, p.cadmin2.p, c.id, { decision: 'approve' })).status, 'approved', 'view access needs only the Church Administrator');

    // A transfer: a new Resident Pastor at Ojodu inherits the open step.
    const e = await createRequest(pool, p.m2.p, { typeId: w.type('church_expenditure').id, title: 'Cleaning supplies', answers: { amount: 400, purpose: 'Monthly cleaning supplies.' } });
    await submitRequest(pool, p.m2.p, e.id);
    assert.deepEqual(await approvers(pool, e.id, 'Resident Pastor'), [p.rp2.id]);
    const newRp = await engine.createActor(w.tenantId, `nkem-${stamp()}@church.test`, 'Nkem NewResident', 'approver');
    await w.seat(u.s2, 'resident_pastor', newRp, { replace: true });
    assert.deepEqual(await approvers(pool, e.id, 'Resident Pastor'), [newRp]);
    assert.ok((await requestDetail(pool, p.m2.p, e.id)).events.some((x: { kind: string }) => x.kind === 'rerouted'));

    // A mandate: the new Resident Pastor may approve up to 300 in that office.
    const holder = (await unitDetail(pool, w.owner.p, u.s2)).holders.find((h: { name: string; live: boolean }) => h.name === 'Nkem NewResident' && h.live) as { id: string };
    await endAppointment(pool, w.owner.p, holder.id, { reason: 'ended' }, reroute);
    await w.seat(u.s2, 'resident_pastor', newRp, { mandateLimit: 300 });
    await assert.rejects(decideRequest(pool, { kind: 'actor', tenantId: w.tenantId, actorId: newRp }, e.id, { decision: 'approve' }), /mandate as Resident Pastor of Ojodu Station is up to 300/);
  } finally { await pool.end(); }
});
