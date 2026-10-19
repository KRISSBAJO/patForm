import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { setManager } from '../src/runtime/org.js';
import { approveOrder, createOrder, createVendor, orderDetail, receiveGoods, setVendorStatus } from '../src/runtime/procurement.js';
import { completeTask, listCases, startOffboarding, urgentTermination } from '../src/runtime/hr.js';
import {
  acknowledgeAssignment, approveAssignment, assetDetail, assignAsset, awaitingRecovery, awaitingRegistration, checkPrecondition, completeJob, confirmProvisioning,
  confirmRevocation, createChange, createPlan, decideAccess, decideChange, decideTicket, failRevocation, finishChange, generateMaintenance, liftRestriction, listAccess,
  listMaintenance, listTickets, myAssets, openTicket, opsDashboard, registerAsset, requestAccess, requesterTicket, returnAsset, reviewEmergencyChange, reviewGrant, saveJobDraft,
  saveServiceType, saveSystem, setOpsTeamMember, startChange, ticketDetail, updateOpsSettings, workTicket,
} from '../src/runtime/ops.js';
import type { Principal } from '../src/runtime/policy.js';

// PRD Module 9 and its four acceptance scenarios.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function workspace(pool: Pool, engine: Engine, modules: string[] = []) {
  const tenantId = await engine.createTenant(`ops-${stamp()}`, { scenario: true });
  const mk = async (name: string, role: 'owner' | 'admin' | 'operator' | 'approver' | 'read_only') => {
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@ops.test`;
    const id = await engine.createActor(tenantId, email, name, role);
    return { id, name, email, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner');
  const admin = await mk('Ada Admin', 'admin');
  const it1 = await mk('Ivo IT', 'operator');
  const it2 = await mk('Ina IT', 'operator');
  const fac = await mk('Fay Facilities', 'operator');
  const manager = await mk('Mo Manager', 'approver');
  const sysOwner = await mk('Sola Owner', 'approver');
  const connector = await mk('Payroll Connector', 'operator');
  const staff = await mk('Sam Staff', 'read_only');
  const staff2 = await mk('Tia Two', 'read_only');
  for (const m of ['assets', ...modules]) await setModule(pool, owner.p, m, { enabled: true });
  await setOpsTeamMember(pool, admin.p, { team: 'it', actorId: it1.id });
  await setOpsTeamMember(pool, admin.p, { team: 'it', actorId: it2.id });
  await setOpsTeamMember(pool, admin.p, { team: 'facilities', actorId: fac.id });
  for (const s of [staff, staff2]) await setManager(pool, owner.p, s.id, { managerId: manager.id, effectiveFrom: '2026-01-01T00:00:00Z' });
  return { tenantId, owner, admin, it1, it2, fac, manager, sysOwner, connector, staff, staff2 };
}
type W = Awaited<ReturnType<typeof workspace>>;
const asset = (pool: Pool, w: W, tag: string, extra: Record<string, unknown> = {}) =>
  registerAsset(pool, w.it1.p, { tag: `${tag}-${stamp()}`, name: 'Laptop 16GB', category: 'Laptop', acquisitionRef: 'Cash purchase 2026-03', ...extra });

test('acceptance 1: a laptop bought through Procurement becomes an asset only after receiving and registration', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine, ['procurement']);
    const v = await createVendor(pool, w.it1.p, { name: `Laptops ${stamp()}`, taxId: `TIN-${stamp()}` });
    await setVendorStatus(pool, w.it1.p, v.id, { to: 'under_review' });
    await setVendorStatus(pool, w.admin.p, v.id, { to: 'approved' });
    let o = await createOrder(pool, w.owner.p, { vendorId: v.id, lines: [{ description: 'Laptop 16GB', quantity: 2, unitPrice: 900 }] });
    if (o.status === 'pending_approval') { await approveOrder(pool, w.admin.p, o.id); o = { ...o, status: 'issued' }; }
    const [line] = (await orderDetail(pool, w.owner.p, o.id)).lines;

    // Ordered is not received: nothing to register yet.
    await assert.rejects(registerAsset(pool, w.it1.p, { tag: `L-${stamp()}`, name: 'Laptop', category: 'Laptop', orderLineId: line!.id }), /has not been received yet/);
    assert.equal((await awaitingRegistration(pool, w.it1.p)).length, 0);

    await receiveGoods(pool, w.owner.p, o.id, { lines: [{ lineId: line!.id, accepted: 1, rejected: 1, reason: 'Dead on arrival' }], evidenceRef: 'GRN-7' });
    const waiting = await awaitingRegistration(pool, w.it1.p);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]!.waiting, 1);
    // Receiving alone does not create an asset.
    assert.equal((await pool.query('select count(*)::int as n from asset where tenant_id = $1', [w.tenantId])).rows[0].n, 0);

    await assert.rejects(registerAsset(pool, w.staff.p, { tag: 'x', name: 'x', category: 'Laptop', orderLineId: line!.id }), /only the IT or Facilities team/);
    const a = await registerAsset(pool, w.it1.p, { tag: `L-${stamp()}`, name: 'Laptop 16GB', category: 'Laptop', serial: 'SN-1', orderLineId: line!.id, warrantyUntil: addDays(700) });
    const detail = await assetDetail(pool, w.it1.p, a.id);
    assert.match(detail.asset.acquisition_ref, /^PO \d+$/);
    assert.equal(detail.history[0].kind, 'registered');
    // Only one was accepted, so only one can be registered.
    await assert.rejects(registerAsset(pool, w.it1.p, { tag: `L-${stamp()}`, name: 'Laptop', category: 'Laptop', orderLineId: line!.id }), /all 1 received on this line are already registered/);
    assert.equal((await awaitingRegistration(pool, w.it1.p)).length, 0);
    // Bought elsewhere needs its own reference; categories come from settings.
    await assert.rejects(registerAsset(pool, w.it1.p, { tag: `L-${stamp()}`, name: 'Laptop', category: 'Laptop' }), /purchase reference/);
    await assert.rejects(asset(pool, w, 'Z', { category: 'Spaceship' }), /category must be one of/);
    await assert.rejects(pool.query('delete from asset_event where asset_id = $1', [a.id]), /append-only/);
  } finally { await pool.end(); }
});

test('acceptance 2: approved access stays pending until the connector confirms or IT records evidence', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    const sys = await saveSystem(pool, w.admin.p, { name: `Payroll ${stamp()}`, ownerId: w.sysOwner.id, roles: ['viewer', 'editor'], maxDays: 90, connectorActorId: w.connector.id });
    await assert.rejects(requestAccess(pool, w.staff.p, { systemId: sys.id, role: 'editor', justification: 'Month-end' }), /expiresOn is required/);
    await assert.rejects(requestAccess(pool, w.staff.p, { systemId: sys.id, role: 'god', justification: 'x', expiresOn: addDays(30) }), /role must be one of/);
    await assert.rejects(requestAccess(pool, w.staff.p, { systemId: sys.id, role: 'editor', justification: 'x', expiresOn: addDays(200) }), /at most 90 days/);
    await assert.rejects(requestAccess(pool, w.staff2.p, { systemId: sys.id, role: 'editor', holderId: w.staff.id, justification: 'x', expiresOn: addDays(30) }), /yourself or the people who report to you/);
    const r = await requestAccess(pool, w.staff.p, { systemId: sys.id, role: 'editor', justification: 'Running month-end payroll checks', expiresOn: addDays(30) });

    await assert.rejects(confirmProvisioning(pool, w.connector.p, r.id, { via: 'connector' }), /not been approved/);
    await assert.rejects(decideAccess(pool, w.manager.p, r.id, { decision: 'approve' }), /system's owner/);
    const decided = await decideAccess(pool, w.sysOwner.p, r.id, { decision: 'approve' });
    assert.equal(decided.status, 'approved');
    // Approved is not access.
    let mine = await listAccess(pool, w.staff.p);
    assert.equal(mine.grants.length, 0);
    assert.equal(mine.requests[0].status, 'approved');

    await assert.rejects(confirmProvisioning(pool, w.it1.p, r.id, { via: 'connector' }), /only the .* connector can confirm/);
    await assert.rejects(confirmProvisioning(pool, w.staff.p, r.id, { via: 'manual', evidenceRef: 'x' }), /only the IT team/);
    await assert.rejects(confirmProvisioning(pool, w.it1.p, r.id, { via: 'manual' }), /record the evidence/);
    const done = await confirmProvisioning(pool, w.connector.p, r.id, { via: 'connector', externalRef: 'payroll-user-8812' });
    assert.equal(done.status, 'provisioned');
    mine = await listAccess(pool, w.staff.p);
    assert.equal(mine.grants.length, 1);
    assert.equal(mine.grants[0].status, 'active');

    // Manual route: someone in IT who is not the holder, with evidence.
    const r2 = await requestAccess(pool, w.it1.p, { systemId: sys.id, role: 'viewer', justification: 'Support tickets', expiresOn: addDays(30) });
    await decideAccess(pool, w.sysOwner.p, r2.id, { decision: 'approve' });
    await assert.rejects(confirmProvisioning(pool, w.it1.p, r2.id, { via: 'manual', evidenceRef: 'SNOW-1' }), /someone other than the person getting the access/);
    await confirmProvisioning(pool, w.it2.p, r2.id, { via: 'manual', evidenceRef: 'Screenshot of the user page, ticket 22' });
    // Access review by the owner.
    const grants = (await listAccess(pool, w.sysOwner.p)).grants;
    const g = grants.find((x: { holder: string }) => x.holder === 'Ivo IT')!;
    await reviewGrant(pool, w.sysOwner.p, g.id, { decision: 'revoke', note: 'No longer on the support rota' });
    assert.equal((await listAccess(pool, w.sysOwner.p)).grants.find((x: { id: string }) => x.id === g.id).status, 'revoking');
  } finally { await pool.end(); }
});

test('revocation: HR termination queues it, a failure stays a critical exception even after the HR case closes, and inactive holders are caught', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine, ['hr']);
    const sys = await saveSystem(pool, w.admin.p, { name: `Bank portal ${stamp()}`, ownerId: w.sysOwner.id, roles: ['payer'] });
    for (const s of [w.staff, w.staff2]) {
      const r = await requestAccess(pool, s.p, { systemId: sys.id, role: 'payer', justification: 'Supplier payments' });
      await decideAccess(pool, w.sysOwner.p, r.id, { decision: 'approve' });
      await confirmProvisioning(pool, w.it1.p, r.id, { via: 'manual', evidenceRef: 'Bank admin screen' });
    }
    const { rows } = await pool.query<{ id: string }>(`insert into employee_record (tenant_id, actor_id, email, name, status) values ($1, $2, $3, 'Sam Staff', 'active') returning id`, [w.tenantId, w.staff.id, w.staff.email]);
    await urgentTermination(pool, w.admin.p, { employeeId: rows[0]!.id, reason: 'Gross misconduct' });
    let all = (await listAccess(pool, w.it1.p)).grants;
    const sam = all.find((g: { holder: string }) => g.holder === 'Sam Staff')!;
    assert.equal(sam.status, 'revoking');
    assert.equal(sam.revoke_reason, 'access revoked by HR');

    await assert.rejects(failRevocation(pool, w.it1.p, sam.id, {}), /say what went wrong/);
    await failRevocation(pool, w.it1.p, sam.id, { note: 'Bank portal API returned 500' });
    // Close the HR case: the exception does not go away.
    await pool.query(`update lifecycle_case set status = 'closed', closed_at = now() where tenant_id = $1`, [w.tenantId]);
    let dash = await opsDashboard(pool, w.it1.p);
    assert.ok(dash.failedAccess.some((f: { id: string; status: string }) => f.id === sam.id && f.status === 'revoke_failed'));
    await assert.rejects(confirmRevocation(pool, w.it1.p, sam.id, {}), /record the evidence/);
    await confirmRevocation(pool, w.it1.p, sam.id, { evidenceRef: 'Removed by the bank helpdesk, ref 77812' });
    dash = await opsDashboard(pool, w.it1.p);
    assert.ok(!dash.failedAccess.some((f: { id: string }) => f.id === sam.id));

    // Deactivated outside HR: identity status still wins.
    await pool.query('update actor set active = false where id = $1', [w.staff2.id]);
    all = (await listAccess(pool, w.it1.p)).grants;
    const tia = all.find((g: { holder: string }) => g.holder === 'Tia Two')!;
    assert.equal(tia.status, 'revoking');
    assert.equal(tia.revoke_reason, 'the holder is no longer active');
  } finally { await pool.end(); }
});

test('acceptance 3: returning an asset through offboarding releases custody and keeps the history', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine, ['hr']);
    const a = await asset(pool, w, 'L');
    await assert.rejects(assignAsset(pool, w.staff.p, a.id, { custodianId: w.staff.id }), /only the IT or Facilities team/);
    const s1 = await assignAsset(pool, w.it1.p, a.id, { custodianId: w.staff.id, accessories: ['charger', 'bag'], handoverRef: 'Signed form 12' });
    assert.equal(s1.status, 'pending_ack');
    // One holder at a time unless the asset is shared.
    await assert.rejects(assignAsset(pool, w.it1.p, a.id, { custodianId: w.staff2.id }), /already with Sam Staff/);
    await assert.rejects(acknowledgeAssignment(pool, w.staff2.p, s1.id), /no such hand-out for you/);
    const ack = await acknowledgeAssignment(pool, w.staff.p, s1.id);
    assert.match(ack.statement, /I have received .* in new condition, with charger, bag/);
    assert.equal((await myAssets(pool, w.staff.p)).length, 1);

    const { rows } = await pool.query<{ id: string }>(`insert into employee_record (tenant_id, actor_id, email, name, status) values ($1, $2, $3, 'Sam Staff', 'active') returning id`, [w.tenantId, w.staff.id, w.staff.email]);
    await startOffboarding(pool, w.admin.p, { employeeId: rows[0]!.id, endDate: addDays(10) });
    assert.equal((await awaitingRecovery(pool, w.it1.p)).length, 1);
    const [c] = await listCases(pool, w.admin.p, { status: 'open' });
    const equipment = c!.tasks.find((t: { key: string }) => t.key === 'equipment')!;
    await assert.rejects(completeTask(pool, w.it1.p, equipment.id, {}), /still held: .*Laptop 16GB.*Record each return on the Assets page/);

    await assert.rejects(returnAsset(pool, w.it1.p, s1.id, {}), /condition it came back in/);
    const back = await returnAsset(pool, w.it1.p, s1.id, { condition: 'fair', accessories: ['charger'], returnRef: 'Exit checklist' });
    assert.deepEqual(back.missing, ['bag']);
    assert.equal(back.caseId, c!.id);
    const d = await assetDetail(pool, w.it1.p, a.id);
    assert.equal(d.asset.status, 'in_stock');
    assert.equal(d.asset.condition, 'fair');
    assert.equal(d.assignments.length, 1);
    assert.equal(d.assignments[0].status, 'returned');
    assert.equal(d.assignments[0].holder, 'Sam Staff');
    assert.equal(d.assignments[0].case_id, c!.id);
    assert.deepEqual(d.history.map((h: { kind: string }) => h.kind), ['returned', 'acknowledged', 'assigned', 'registered']);
    assert.equal((await awaitingRecovery(pool, w.it1.p)).length, 0);
    await completeTask(pool, w.it1.p, equipment.id, { note: 'All returned' });
    await assert.rejects(returnAsset(pool, w.it1.p, s1.id, { condition: 'good' }), /already been returned/);

    // Approval first when the workspace asks for it; the assigner cannot approve their own hand-out.
    await updateOpsSettings(pool, w.admin.p, { allocationNeedsApproval: true });
    const s2 = await assignAsset(pool, w.it1.p, a.id, { custodianId: w.staff2.id });
    assert.equal(s2.status, 'pending_approval');
    await assert.rejects(acknowledgeAssignment(pool, w.staff2.p, s2.id), /still waiting for approval/);
    await assert.rejects(approveAssignment(pool, w.it1.p, s2.id), /owner or admin/);
    await approveAssignment(pool, w.admin.p, s2.id);
    await acknowledgeAssignment(pool, w.staff2.p, s2.id);
    // A shared asset may have more than one holder.
    const shared = await asset(pool, w, 'PROJ', { category: 'Equipment', name: 'Projector', shared: true });
    await updateOpsSettings(pool, w.admin.p, { allocationNeedsApproval: false });
    await assignAsset(pool, w.it1.p, shared.id, { custodianId: w.staff.id });
    await assignAsset(pool, w.it1.p, shared.id, { custodianId: w.staff2.id });
  } finally { await pool.end(); }
});

test('acceptance 4: a recurring maintenance job is created once per occurrence even when the scheduler retries; a failed check restricts the asset', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    const a = await asset(pool, w, 'GEN', { category: 'Equipment', name: 'Generator' });
    const plan = await createPlan(pool, w.fac.p, { assetId: a.id, title: 'Weekly generator check', everyDays: 7, checklist: ['Oil level', 'Battery', 'Test run'], team: 'facilities', firstDue: addDays(-14) });
    // Three schedulers at once, then a retry.
    const made = await Promise.all([1, 2, 3].map(() => generateMaintenance(pool, { tenantId: w.tenantId })));
    assert.equal(made.reduce((x, y) => x + y, 0), 3);
    assert.equal(await generateMaintenance(pool, { tenantId: w.tenantId }), 0);
    const { rows } = await pool.query<{ due_on: string }>('select due_on::text from maintenance_job where plan_id = $1 order by due_on', [plan.id]);
    assert.deepEqual(rows.map((r) => r.due_on), [addDays(-14), addDays(-7), addDays(0)]);
    const { rows: p } = await pool.query<{ next_due: string }>('select next_due::text from maintenance_plan where id = $1', [plan.id]);
    assert.equal(p[0]!.next_due, addDays(7));

    const jobs = (await listMaintenance(pool, w.fac.p)).jobs;
    assert.equal(jobs.length, 3);
    const job = jobs[0];
    await assert.rejects(listMaintenance(pool, w.staff.p), /only the IT or Facilities team/);
    // Drafts carry a version; a stale copy cannot overwrite newer work.
    const d1 = await saveJobDraft(pool, w.fac.p, job.id, { version: 0, results: { 'Oil level': 'pass' } });
    assert.equal(d1.version, 1);
    await assert.rejects(saveJobDraft(pool, w.fac.p, job.id, { version: 0, results: { 'Oil level': 'fail' } }), /saved elsewhere since you opened it/);
    await assert.rejects(saveJobDraft(pool, w.fac.p, job.id, { version: 1, location: { lat: 6.5, lng: 3.4 } }), /location capture is switched off/);
    await assert.rejects(completeJob(pool, w.fac.p, job.id, { results: { 'Oil level': 'pass' } }), /answer every check: Battery, Test run/);
    await assert.rejects(completeJob(pool, w.fac.p, job.id, { results: { 'Oil level': 'pass', Battery: 'fail', 'Test run': 'pass' } }), /describe what failed/);
    const res = await completeJob(pool, w.fac.p, job.id, { results: { 'Oil level': 'pass', Battery: 'fail', 'Test run': 'pass' }, findings: 'Battery swollen', photos: ['photo-ref-1'] });
    assert.equal(res.outcome, 'fail');
    assert.ok(res.ticketId);

    // Restricted: cannot be handed out, and the restriction holds until the corrective work is resolved.
    await assert.rejects(assignAsset(pool, w.it1.p, a.id, { custodianId: w.staff.id }), /restricted: failed Weekly generator check: Battery/);
    await assert.rejects(liftRestriction(pool, w.fac.p, a.id, { note: 'New battery' }), /corrective work is still open/);
    await assert.rejects(workTicket(pool, w.it1.p, res.ticketId!, { action: 'resolve', resolution: 'x' }), /no such ticket|only the FACILITIES team/);
    await workTicket(pool, w.fac.p, res.ticketId!, { action: 'resolve', resolution: 'Battery replaced' });
    await liftRestriction(pool, w.fac.p, a.id, { note: 'New battery fitted and tested' });
    const d = await assetDetail(pool, w.fac.p, a.id);
    assert.equal(d.asset.status, 'in_stock');
    assert.equal(d.maintenance.length, 3);
    assert.equal(d.tickets.length, 1);
  } finally { await pool.end(); }
});

test('tickets: catalogue fields and approval, service targets pause while waiting on the requester, private work notes, reopen, breach escalation', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    const svc = await saveServiceType(pool, w.admin.p, { name: 'New laptop', team: 'it', approval: 'manager', fields: [{ label: 'Laptop model', required: true }, { label: 'Notes' }], respondHours: 4, resolveHours: 24, evidenceRequired: true });
    await assert.rejects(openTicket(pool, w.staff.p, { typeId: svc.id, title: 'Laptop please' }), /fill in: Laptop model/);
    const t = await openTicket(pool, w.staff.p, { typeId: svc.id, title: 'Laptop please', details: { laptop_model: '14 inch' } });
    assert.equal(t.status, 'awaiting_approval');
    await assert.rejects(workTicket(pool, w.it1.p, t.id, { action: 'assign' }), /awaiting approval/);
    await assert.rejects(decideTicket(pool, w.staff.p, t.id, { decision: 'approve' }), /manager approves/);
    await decideTicket(pool, w.manager.p, t.id, { decision: 'approve' });
    assert.ok((await listTickets(pool, w.it1.p)).some((x: { id: string }) => x.id === t.id));

    await workTicket(pool, w.it1.p, t.id, { action: 'assign' });
    await workTicket(pool, w.it1.p, t.id, { action: 'note', body: 'Stock is low; check with supplier' });
    await workTicket(pool, w.it1.p, t.id, { action: 'wait', body: 'Do you need a Windows or Mac build?' });
    const before = (await pool.query<{ resolve_due: Date }>('select resolve_due from ticket where id = $1', [t.id])).rows[0]!.resolve_due;
    await pool.query(`update ticket set paused_since = now() - interval '2 hours' where id = $1`, [t.id]);
    await requesterTicket(pool, w.staff.p, t.id, { action: 'reply', body: 'Windows please' });
    const after = (await pool.query<{ resolve_due: Date; paused_seconds: number; status: string }>('select resolve_due, paused_seconds, status from ticket where id = $1', [t.id])).rows[0]!;
    assert.equal(after.status, 'in_progress');
    assert.ok(after.paused_seconds >= 7200);
    assert.ok(after.resolve_due.getTime() - before.getTime() >= 7200_000 - 5000, 'the target moved by the time spent waiting');

    const asRequester = await ticketDetail(pool, w.staff.p, t.id);
    assert.ok(!asRequester.notes.some((n: { body: string }) => n.body.includes('Stock is low')));
    assert.ok((await ticketDetail(pool, w.it1.p, t.id)).notes.some((n: { body: string }) => n.body.includes('Stock is low')));
    await assert.rejects(ticketDetail(pool, w.fac.p, t.id), /no such ticket/);

    await assert.rejects(workTicket(pool, w.it1.p, t.id, { action: 'resolve', resolution: 'Delivered' }), /needs evidence of completion/);
    await workTicket(pool, w.it1.p, t.id, { action: 'resolve', resolution: 'Delivered to desk', evidenceRef: 'Handover form 31' });
    await assert.rejects(requesterTicket(pool, w.staff.p, t.id, { action: 'reopen' }), /still wrong/);
    await requesterTicket(pool, w.staff.p, t.id, { action: 'reopen', body: 'Charger missing' });
    await workTicket(pool, w.it1.p, t.id, { action: 'resolve', resolution: 'Charger delivered', evidenceRef: 'Form 32' });
    await requesterTicket(pool, w.staff.p, t.id, { action: 'confirm' });
    assert.equal((await pool.query('select status, reopened from ticket where id = $1', [t.id])).rows[0].reopened, 1);

    // An incident that misses its target is flagged and escalated once.
    const inc = await openTicket(pool, w.staff2.p, { title: 'Wi-Fi down on floor 2', team: 'it', impact: 1, urgency: 1 });
    assert.equal(inc.priority, 1);
    await pool.query(`update ticket set resolve_due = now() - interval '1 minute' where id = $1`, [inc.id]);
    const queue = await listTickets(pool, w.it2.p);
    const row = queue.find((x: { id: string }) => x.id === inc.id);
    assert.ok(row.breached_at && row.escalated_at);
    assert.ok((await ticketDetail(pool, w.it1.p, inc.id)).notes.some((n: { body: string }) => /Service target missed/.test(n.body)));
    assert.equal((await opsDashboard(pool, w.it1.p)).breached.length, 1);
  } finally { await pool.end(); }
});

test('changes: normal changes need approval, the window and preconditions; emergency changes start at once but need an independent review', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    await assert.rejects(createChange(pool, w.it1.p, { title: 'x', impact: 'y', risk: 'low' }), /rollback plan/);
    await assert.rejects(createChange(pool, w.it1.p, { title: 'x', impact: 'y', risk: 'low', rollbackPlan: 'z' }), /execution window/);
    const now = Date.now();
    const c = await createChange(pool, w.it1.p, { title: 'Upgrade the file server', impact: 'Shared drive offline 20 minutes', risk: 'medium', rollbackPlan: 'Restore the snapshot',
      preconditions: ['Snapshot taken', 'Users told'], windowStart: new Date(now - HOURS(1)).toISOString(), windowEnd: new Date(now + HOURS(1)).toISOString() });
    await assert.rejects(startChange(pool, w.it1.p, c.id), /only once approved/);
    await assert.rejects(decideChange(pool, w.it1.p, c.id, { decision: 'approve', note: 'ok' }), /owner, admin/);
    await assert.rejects(decideChange(pool, w.admin.p, c.id, { decision: 'approve' }), /record the reason/);
    await decideChange(pool, w.admin.p, c.id, { decision: 'approve', note: 'Low usage at this hour' });
    await assert.rejects(startChange(pool, w.it1.p, c.id), /preconditions not met: Snapshot taken; Users told/);
    await checkPrecondition(pool, w.it1.p, c.id, { index: 0 });
    await checkPrecondition(pool, w.it2.p, c.id, { index: 1 });
    await startChange(pool, w.it1.p, c.id);
    await assert.rejects(finishChange(pool, w.it1.p, c.id, { outcome: 'completed' }), /how the result was checked/);
    await finishChange(pool, w.it1.p, c.id, { outcome: 'completed', verification: 'Opened 5 files from two desks' });

    const later = await createChange(pool, w.it1.p, { title: 'Firewall rules', impact: 'None expected', risk: 'low', rollbackPlan: 'Revert rule set',
      windowStart: new Date(now + HOURS(24)).toISOString(), windowEnd: new Date(now + HOURS(25)).toISOString() });
    await decideChange(pool, w.admin.p, later.id, { decision: 'approve', note: 'Fine' });
    await assert.rejects(startChange(pool, w.it1.p, later.id), /outside the approved window/);

    const em = await createChange(pool, w.it1.p, { kind: 'emergency', title: 'Patch actively exploited VPN flaw', impact: 'VPN restarts', risk: 'high', rollbackPlan: 'Reinstall previous firmware' });
    await assert.rejects(decideChange(pool, w.admin.p, em.id, { decision: 'approve', note: 'x' }), /reviewed afterwards/);
    await assert.rejects(startChange(pool, w.staff.p, em.id), /only the IT or Facilities team/);
    await startChange(pool, w.it1.p, em.id);
    await finishChange(pool, w.it1.p, em.id, { outcome: 'completed', verification: 'Vendor scanner shows patched' });
    assert.equal((await opsDashboard(pool, w.it1.p)).retrospectivesDue.length, 1);
    await assert.rejects(reviewEmergencyChange(pool, w.it1.p, em.id, { review: 'x' }), /owner or admin/);
    await reviewEmergencyChange(pool, w.admin.p, em.id, { review: 'Correct call; add the VPN to the patch calendar' });
    assert.equal((await opsDashboard(pool, w.it1.p)).retrospectivesDue.length, 0);
  } finally { await pool.end(); }
});

test('the module gate holds and only admins change settings and teams', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    await assert.rejects(updateOpsSettings(pool, w.it1.p, { reopenDays: 3 }), /owner or admin/);
    await assert.rejects(setOpsTeamMember(pool, w.it1.p, { team: 'it', actorId: w.staff.id }), /owner or admin/);
    await assert.rejects(opsDashboard(pool, w.staff.p), /only the IT or Facilities team/);
    await setModule(pool, w.owner.p, 'assets', { enabled: false });
    await assert.rejects(myAssets(pool, w.staff.p), /switched off/);
  } finally { await pool.end(); }
});

function HOURS(n: number) { return n * 3600_000; }
