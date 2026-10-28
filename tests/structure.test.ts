import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { adoptTemplate, rerouteOffice, savePolicy, setApprovalMailerForTests } from '../src/runtime/approvals.js';
import { appoint, endAppointment, placeMember, readStructure, saveUnit, setDepartments, setupChurch, unitDetail, checkInviteScope } from '../src/runtime/structure.js';
import { invite, acceptInvitation, setMemberActive } from '../src/runtime/workspace.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const bp = () => Blueprint.parse(JSON.parse(readFileSync('processes/approval-request.blueprint.json', 'utf8')));
const reroute = (client: Parameters<typeof rerouteOffice>[0], t: string, u: string, o: string) => rerouteOffice(client, t, u, o).then(() => undefined);

async function church(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`church-${stamp()}`, { scenario: true });
  const mk = async (name: string, role: 'owner' | 'admin' | 'operator' | 'approver' | 'read_only' = 'approver') => {
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@church.test`;
    const id = await engine.createActor(tenantId, email, name, role);
    await pool.query('update actor set email_verified_at = now() where id = $1', [id]);
    return { id, email, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner');
  const version = await engine.publish(tenantId, bp(), 'test');
  const setup = await setupChurch(pool, owner.p, {}, (processKey) => adoptTemplate(pool, owner.p, { templateKey: 'church_line', processKey }));
  const s = await readStructure(pool, owner.p);
  const level = (k: string) => s.levels.find((l) => l.key === k)!.id;
  const office = (k: string) => s.officeTypes.find((o) => o.key === k)!.id;
  const unit = async (name: string, lv: string, parentId: string | null, by = owner.p) => (await saveUnit(pool, by, { name, levelId: level(lv), parentId })).id;
  const nat = await unit('Nigeria', 'national', null);
  const dist = await unit('District 01', 'district', nat);
  const zone = await unit('Zone 03', 'zone', dist);
  const zone2 = await unit('Zone 04', 'zone', dist);
  const area = await unit('Area 07', 'area', zone);
  const s1 = await unit('Ikeja Station', 'station', area);
  const s2 = await unit('Ojodu Station', 'station', area);
  const s3 = await unit('Agege Station', 'station', area);
  await saveUnit(pool, owner.p, { id: area, hostStationId: s1 });
  const people = {
    np: await mk('Nana National'), dp: await mk('Dele District'), zp: await mk('Zara Zonal'), ap: await mk('Ade Area'),
    rp2: await mk('Rita Resident'), assoc2: await mk('Ayo Associate'), cadmin2: await mk('Chi Admin', 'read_only'), aadmin: await mk('Ama AreaAdmin', 'read_only'),
    m1: await mk('Mo Member', 'read_only'), m2: await mk('Mary Member', 'read_only'), m3: await mk('Mike Member', 'read_only'),
  };
  const seat = (unitId: string, officeKey: string, actorId: string, extra: Record<string, unknown> = {}) => appoint(pool, owner.p, { unitId, officeTypeId: office(officeKey), actorId, ...extra }, reroute);
  await seat(nat, 'national_pastor', people.np.id); await seat(dist, 'district_pastor', people.dp.id); await seat(zone, 'zonal_pastor', people.zp.id);
  await seat(area, 'area_pastor', people.ap.id); await seat(s1, 'resident_pastor', people.ap.id);
  await seat(s2, 'resident_pastor', people.rp2.id); await seat(s2, 'associate_pastor', people.assoc2.id);
  await seat(s2, 'church_admin', people.cadmin2.id); await seat(area, 'area_admin', people.aadmin.id);
  for (const [who, at] of [[people.m1, s1], [people.m2, s2], [people.m3, s3], [people.rp2, s2], [people.assoc2, s2], [people.ap, s1]] as const) await pool.query('update actor set org_unit_id = $2 where id = $1', [who.id, at]);
  for (const a of Object.values(people)) await engine.grant({ tenantId, actorId: a.id, processKey: 'approval_request', roleKey: 'line_manager' });
  return { tenantId, owner, version, setup, level, office, units: { nat, dist, zone, zone2, area, s1, s2, s3 }, people, seat };
}

const now = new Date('2026-10-27T09:00:00Z');
async function submit(engine: Engine, pool: Pool, w: Awaited<ReturnType<typeof church>>, who: { email: string }, amount: number) {
  const r = await engine.submit({ version: w.version, now, answers: { requester_name: 'Someone', employee_email: who.email, title: `Request ${amount} ${stamp()}`, category: 'purchase', cost_centre: 'ops', amount, needed_by: '2026-12-01', description: 'Chairs for the children’s department before the harvest service.' } });
  assert.ok(r.instanceId, JSON.stringify(r));
  for (let i = 0; i < 40; i++) {
    await engine.drain(now, 'test', w.tenantId);
    const { rows } = await pool.query("select 1 from approval_request where instance_id = $1 and status = 'pending'", [r.instanceId]);
    if (rows[0]) return r.instanceId;
    await new Promise((x) => setTimeout(x, 150));
  }
  return r.instanceId;
}
const pending = async (pool: Pool, id: string) => (await pool.query<{ approvers: string[] }>("select approvers from approval_request where instance_id = $1 and status = 'pending' order by id desc limit 1", [id])).rows[0]?.approvers ?? null;
const state = async (pool: Pool, id: string) => (await pool.query<{ state: string }>('select state from instance where id = $1', [id])).rows[0]!.state;
const events = async (pool: Pool, id: string, type: string) => (await pool.query<{ payload: Record<string, unknown> }>('select payload from event where instance_id = $1 and type = $2 order by seq', [id, type])).rows.map((r) => r.payload);

test('church setup lays down levels, offices and the catalogue, and the church line becomes the default policy', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await church(pool, engine);
    assert.deepEqual(w.setup.adopted, ['approval_request']);
    const s = await readStructure(pool, w.owner.p);
    assert.deepEqual(s.levels.map((l) => l.key), ['national', 'district', 'zone', 'area', 'station']);
    assert.ok(s.officeTypes.some((o) => o.key === 'resident_pastor' && o.single));
    assert.ok(s.officeTypes.some((o) => o.key === 'associate_pastor' && !o.single));
    assert.equal(s.catalog.length, 15);
    const area = s.units.find((u) => u.id === w.units.area)!;
    assert.equal(area.host_station_id, w.units.s1);
    assert.equal(area.overseer?.name, 'Ade Area');
    assert.ok(!s.units.find((u) => u.id === w.units.s3)!.overseer, 'Agege has no Resident Pastor yet');
    assert.ok(s.units.find((u) => u.id === w.units.s3)!.vacant.length >= 1);
    await assert.rejects(setupChurch(pool, w.owner.p, {}, async () => undefined), /already has its levels/);
    // Levels are enforced: a zone cannot go under an area, nothing under a station.
    await assert.rejects(saveUnit(pool, w.owner.p, { name: 'Bad', levelId: w.level('zone'), parentId: w.units.area }), /cannot sit under/);
    await assert.rejects(saveUnit(pool, w.owner.p, { name: 'Bad', levelId: w.level('station'), parentId: w.units.s1 }), /cannot have units/);
  } finally { await pool.end(); }
});

test('admins act only inside their part of the tree, and only with the permissions their office carries', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await church(pool, engine); const { people: p, units: u } = w;
    // The Area Admin may add a station in their Area, but not in another Zone or at the top.
    const s4 = (await saveUnit(pool, p.aadmin.p, { name: 'Ogba Station', levelId: w.level('station'), parentId: u.area })).id;
    await assert.rejects(saveUnit(pool, p.aadmin.p, { name: 'Elsewhere', levelId: w.level('area'), parentId: u.zone2 }), /do not hold an office/);
    await assert.rejects(saveUnit(pool, p.aadmin.p, { name: 'Top', levelId: w.level('national'), parentId: null }), /owner or admin/);
    // The Church Administrator of Ojodu manages Ojodu only.
    await placeMember(pool, p.cadmin2.p, p.m3.id, { unitId: u.s2 }).then(() => assert.fail('m3 lives in Agege'), (e) => assert.match(String(e), /moving people out/));
    await appoint(pool, p.cadmin2.p, { unitId: u.s2, officeTypeId: w.office('cmc_secretary'), actorId: p.m2.id }, reroute);
    await assert.rejects(appoint(pool, p.cadmin2.p, { unitId: u.s1, officeTypeId: w.office('cmc_secretary'), actorId: p.m1.id }, reroute), /do not hold an office/);
    // A pastor holds no admin permission by title: the Associate Pastor cannot appoint.
    await assert.rejects(appoint(pool, p.assoc2.p, { unitId: u.s2, officeTypeId: w.office('unit_head'), actorId: p.m2.id }, reroute), /do not hold an office/);
    // An office must fit the level, and a single seat is replaced, never doubled.
    await assert.rejects(appoint(pool, w.owner.p, { unitId: u.s2, officeTypeId: w.office('area_pastor'), actorId: p.m2.id }, reroute), /not an office at this level/);
    await assert.rejects(appoint(pool, w.owner.p, { unitId: u.s2, officeTypeId: w.office('resident_pastor'), actorId: p.m2.id }, reroute), /holds this office; choose to replace/);
    // Departments come from the catalogue, and a unit head heads one of them.
    const s = await readStructure(pool, w.owner.p);
    const choir = s.catalog.find((c: { key: string }) => c.key === 'choir') as { id: string };
    await setDepartments(pool, p.cadmin2.p, u.s2, { catalogIds: [choir.id] });
    const d = await unitDetail(pool, p.cadmin2.p, u.s2);
    assert.equal(d.departments.length, 1);
    await appoint(pool, p.cadmin2.p, { unitId: u.s2, officeTypeId: w.office('unit_head'), actorId: p.m2.id, departmentId: d.departments[0].id }, reroute);
    assert.ok(d.can.appointments && !d.can.structure === false);
    assert.ok(s4);
  } finally { await pool.end(); }
});

test('approvals follow offices up the line; one pastor in two offices approves once; a pastor’s own request goes to someone else', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  setApprovalMailerForTests(async () => undefined);
  try {
    const w = await church(pool, engine); const { people: p, units: u } = w;
    const decide = (id: string, who: { p: Principal }) => engine.decide({ instanceId: id, approvalKey: 'policy_approval', decision: 'approved', reason: 'Agreed.', principal: who.p, now });
    const drainUntil = async (id: string, target: string) => { for (let i = 0; i < 30 && (await state(pool, id)) !== target; i++) { await engine.drain(now, 'test', w.tenantId); await new Promise((x) => setTimeout(x, 120)); } return state(pool, id); };

    // Ojodu member, 2,400: Resident Pastor, then the Area Pastor (above 1,000); the Zone is not needed below 5,000.
    const a = await submit(engine, pool, w, p.m2, 2400);
    assert.deepEqual(await pending(pool, a), [p.rp2.email.toLowerCase()]);
    await decide(a, p.rp2);
    assert.deepEqual(await pending(pool, a), [p.ap.email.toLowerCase()]);
    const as = await decide(a, p.ap);
    assert.equal(as.applied, true);
    assert.equal(await drainUntil(a, 'approved'), 'approved');
    const decided = await events(pool, a, 'approval_step_decided');
    assert.deepEqual((decided[1]!.as as { office: string }[]).map((x) => x.office), ['Area Pastor'], 'the record says in which office he decided');

    // Ikeja member: Ade is both Resident Pastor of Ikeja and Area Pastor. He approves once; the Area step is skipped, on the record.
    const b = await submit(engine, pool, w, p.m1, 2400);
    assert.deepEqual(await pending(pool, b), [p.ap.email.toLowerCase()]);
    await decide(b, p.ap);
    assert.equal(await drainUntil(b, 'approved'), 'approved');
    const skipped = await events(pool, b, 'approval_step_skipped');
    assert.equal(skipped.length, 1); assert.equal((skipped[0]!.step as { name: string }).name, 'Area Pastor');

    // Rita (Resident Pastor of Ojodu) asks for herself: not her own approver; her Associate Pastor takes it.
    const c = await submit(engine, pool, w, p.rp2, 600);
    assert.deepEqual(await pending(pool, c), [p.assoc2.email.toLowerCase()]);

    // Agege has no Resident Pastor: the seat is vacant, so it goes to the overseer above (the Area Pastor).
    const d = await submit(engine, pool, w, p.m3, 300);
    assert.deepEqual(await pending(pool, d), [p.ap.email.toLowerCase()]);
    const routed = await events(pool, d, 'approval_routed');
    assert.match(JSON.stringify(routed[0]!.via), /vacant/);
  } finally { setApprovalMailerForTests(null); await pool.end(); }
});

test('an independent step needs someone else; a transfer moves pending approvals; a mandate caps what an office may approve', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  setApprovalMailerForTests(async () => undefined);
  try {
    const w = await church(pool, engine); const { people: p, units: u } = w;
    // A policy with the Resident Pastor twice, the second independent: the Associate Pastor takes the second.
    await savePolicy(pool, w.owner.p, { processKey: 'approval_request', name: 'Two looks', steps: [
      { key: 'first', name: 'First look', responsible: [{ kind: 'office', office: 'resident_pastor' }] },
      { key: 'second', name: 'Independent look', responsible: [{ kind: 'office', office: 'resident_pastor' }], sameApprover: 'independent' },
    ] });
    const a = await submit(engine, pool, w, p.m2, 800);
    assert.deepEqual(await pending(pool, a), [p.rp2.email.toLowerCase()]);
    await engine.decide({ instanceId: a, approvalKey: 'policy_approval', decision: 'approved', reason: 'Fine.', principal: p.rp2.p, now });
    assert.deepEqual(await pending(pool, a), [p.assoc2.email.toLowerCase()]);

    // A transfer: Rita leaves Ojodu; the new Resident Pastor inherits what waits for the office.
    const b = await submit(engine, pool, w, p.m2, 900);
    assert.deepEqual(await pending(pool, b), [p.rp2.email.toLowerCase()]);
    const newRp = await engine.createActor(w.tenantId, `new.rp-${stamp()}@church.test`, 'Nkem NewResident', 'approver');
    await engine.grant({ tenantId: w.tenantId, actorId: newRp, processKey: 'approval_request', roleKey: 'line_manager' });
    await w.seat(u.s2, 'resident_pastor', newRp, { replace: true });
    const { rows: nr } = await pool.query<{ email: string }>('select lower(email) as email from actor where id = $1', [newRp]);
    assert.deepEqual(await pending(pool, b), [nr[0]!.email]);
    assert.equal((await events(pool, b, 'approval_rerouted')).length, 1);
    const detail = await unitDetail(pool, w.owner.p, u.s2);
    assert.ok(detail.holders.some((h: { name: string; live: boolean; end_reason: string | null }) => h.name === 'Rita Resident' && !h.live && h.end_reason === 'replaced'), 'history keeps Rita');

    // A mandate: the new Resident Pastor may approve up to 500.
    const holder = detail.holders.find((h: { name: string; live: boolean }) => h.name === 'Nkem NewResident' && h.live) as { id: string };
    await endAppointment(pool, w.owner.p, holder.id, { reason: 'mandate set' }, reroute);
    await w.seat(u.s2, 'resident_pastor', newRp, { mandateLimit: 500 });
    await assert.rejects(engine.decide({ instanceId: b, approvalKey: 'policy_approval', decision: 'approved', reason: 'Ok', principal: { kind: 'actor', tenantId: w.tenantId, actorId: newRp }, now }), /mandate as Resident Pastor of Ojodu Station is up to 500/);
  } finally { setApprovalMailerForTests(null); await pool.end(); }
});

test('a church admin invites someone into their station and office; they arrive seated', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await church(pool, engine); const { people: p, units: u } = w;
    await assert.rejects(checkInviteScope(pool, p.cadmin2.p, u.s1, null), /do not hold an office/);
    await checkInviteScope(pool, p.cadmin2.p, u.s2, w.office('associate_pastor'));
    const email = `new.associate-${stamp()}@church.test`;
    const sent = await invite(pool, { principal: p.cadmin2.p, email, workspaceRole: 'approver', unitId: u.s2, officeTypeId: w.office('associate_pastor'), scopeChecked: true });
    await assert.rejects(invite(pool, { principal: p.cadmin2.p, email: `x-${stamp()}@church.test`, workspaceRole: 'admin', unitId: u.s2, scopeChecked: true }), /member, approver or operator/);
    const joined = await acceptInvitation(pool, { token: sent.token, displayName: 'Bola Associate', password: 'a-long-enough-password-1' });
    const { rows } = await pool.query<{ org_unit_id: string }>('select org_unit_id from actor where id = $1', [joined.actorId]);
    assert.equal(rows[0]!.org_unit_id, u.s2);
    const d = await unitDetail(pool, w.owner.p, u.s2);
    assert.ok(d.holders.some((h: { name: string; live: boolean }) => h.name === 'Bola Associate' && h.live));
  } finally { await pool.end(); }
});

test('when someone leaves, their offices end and what waited for them moves on', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  setApprovalMailerForTests(async () => undefined);
  try {
    const w = await church(pool, engine); const { people: p, units: u } = w;
    const a = await submit(engine, pool, w, p.m2, 400);
    assert.deepEqual(await pending(pool, a), [p.rp2.email.toLowerCase()]);
    await setMemberActive(pool, { principal: w.owner.p, actorId: p.rp2.id, active: false });
    // The Resident Pastor seat of Ojodu is now vacant: it goes to the overseer above.
    assert.deepEqual(await pending(pool, a), [p.ap.email.toLowerCase()]);
    const d = await unitDetail(pool, w.owner.p, u.s2);
    assert.ok(d.holders.some((h: { name: string; live: boolean; end_reason: string | null }) => h.name === 'Rita Resident' && !h.live && h.end_reason === 'left'));
  } finally { setApprovalMailerForTests(null); await pool.end(); }
});
