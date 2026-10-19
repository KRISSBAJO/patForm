import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { validate } from '../src/compiler/validate.js';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { runScenarios } from '../src/runtime/scenarios.js';
import { setModule } from '../src/runtime/modules.js';
import { managerOf, orgChart, reportingHistory, setManager } from '../src/runtime/org.js';
import { resolveSession, startSession } from '../src/runtime/auth.js';
import { listMembers } from '../src/runtime/workspace.js';
import { saveBudget } from '../src/runtime/expenses.js';
import {
  acknowledgeDocument, addCaseNote, cancelLeave, completeTask, createDocument, decideLeave, decideProbation, exceptTask, hrSummary, leaveToApprove,
  listCaseNotes, listCases, listCompensation, listEmployees, listHiring, listReconciliations, myDocuments, myLeave, myTasks, requestLeave,
  saveHoliday, saveTemplate, sendDocument, setCompensation, setTeamMember, startOffboarding, startOnboarding, startProbationReview, startTransfer,
  updateEmployee, updateHrSettings, upcoming, urgentTermination,
} from '../src/runtime/hr.js';
import type { Principal } from '../src/runtime/policy.js';

// PRD Module 7 and its four acceptance scenarios, plus JRN-01 and JRN-04.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('the hiring request compiles clean and passes its own scenarios', { skip: !localDatabase }, async () => {
  const bp = Blueprint.parse(JSON.parse(readFileSync('processes/hiring-request.blueprint.json', 'utf8')));
  const d = validate(bp);
  assert.equal(d.errors.length, 0, JSON.stringify(d.errors));
  assert.equal(d.warnings.length, 0, JSON.stringify(d.warnings));
  const pool = createPool(3);
  try {
    const results = await runScenarios(pool, bp);
    assert.ok(results.every((r) => r.passed), JSON.stringify(results.filter((r) => !r.passed)));
  } finally { await pool.end(); }
});

async function workspace(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`hr-${stamp()}`, { scenario: true });
  const mk = async (name: string, role: 'owner' | 'admin' | 'operator' | 'approver' | 'read_only') => {
    const id = await engine.createActor(tenantId, `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@hr.test`, name, role);
    await pool.query('update actor set email_verified_at = now() where id = $1', [id]);
    return { id, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner');
  const hrAdmin = await mk('Hana HR', 'admin');
  const hrClerk = await mk('Hugo Clerk', 'operator');
  const it = await mk('Ivo IT', 'operator');
  const facilities = await mk('Fay Facilities', 'operator');
  const finance = await mk('Fin Finance', 'operator');
  const manager = await mk('Mo Manager', 'approver');
  const manager2 = await mk('Nia Newboss', 'approver');
  const staff = await mk('Sam Staff', 'read_only');
  await setModule(pool, owner.p, 'hr', { enabled: true });
  for (const [team, who] of [['hr', hrClerk], ['it', it], ['facilities', facilities], ['finance', finance]] as const) {
    await setTeamMember(pool, hrAdmin.p, { team, actorId: who.id });
  }
  await setManager(pool, owner.p, staff.id, { managerId: manager.id, effectiveFrom: '2026-01-01T00:00:00Z' });
  return { tenantId, owner, hrAdmin, hrClerk, it, facilities, finance, manager, manager2, staff };
}

const taskBy = async (pool: Pool, p: Principal, caseId: string, key: string) => {
  const c = (await listCases(pool, p)).find((x) => x.id === caseId)!;
  return c.tasks.find((t) => t.key === key)!;
};

test('acceptance 1 and 4, JRN-01: a future employee does only their own tasks; teams see no pay; access waits for checks and the start date', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    const email = `new.hire-${stamp()}@hr.test`;
    // Only HR starts an onboarding.
    await assert.rejects(startOnboarding(pool, w.manager.p, { email, name: 'Nora New', startDate: today() }), /only HR/);
    const ob = await startOnboarding(pool, w.hrClerk.p, { email, name: 'Nora New', startDate: addDays(3), managerId: w.manager.id, location: 'Lagos', probationEnd: addDays(90) });
    await setCompensation(pool, w.hrAdmin.p, ob.employeeId, { amount: 4800000, currency: 'NGN', effectiveFrom: addDays(3), reason: 'Offer letter' });

    // The pre-hire: signed in, holding no capability, seeing only their own task.
    const pre: Principal = { kind: 'actor', tenantId: w.tenantId, actorId: ob.actorId };
    const { rows: role } = await pool.query<{ workspace_role: string }>('select workspace_role from actor where id = $1', [ob.actorId]);
    assert.equal(role[0]!.workspace_role, 'pre_hire');
    await assert.rejects(listMembers(pool, pre), /first day/);
    await assert.rejects(orgChart(pool, pre), /first day/);
    await assert.rejects(myLeave(pool, pre), /after your first day/);
    const mine = await myTasks(pool, pre);
    assert.deepEqual(mine.map((t) => t.key), ['personal_details']);
    const preView = (await listCases(pool, pre))[0]!;
    assert.deepEqual(preView.tasks.map((t) => t.key), ['personal_details'], 'the pre-hire sees nothing of the other teams');
    await completeTask(pool, pre, mine[0]!.id, { note: 'Done' });

    // Facilities: their desk task and the basic facts; never pay or HR-only notes (acceptance 4).
    await addCaseNote(pool, w.hrAdmin.p, ob.caseId, { body: 'Salary negotiated up from the first offer', category: 'compensation' });
    await addCaseNote(pool, w.hrAdmin.p, ob.caseId, { body: 'Prefers a desk near the window', category: 'general', shared: true });
    await assert.rejects(addCaseNote(pool, w.hrAdmin.p, ob.caseId, { body: 'x', category: 'health', shared: true }), /never shared/);
    const fac = (await listCases(pool, w.facilities.p)).find((c) => c.id === ob.caseId)!;
    assert.equal(fac.employee.name, 'Nora New');
    assert.equal(fac.employee.location, 'Lagos');
    assert.ok(!JSON.stringify(fac).includes('4800000'), 'pay never reaches a team');
    await assert.rejects(listCompensation(pool, w.facilities.p, ob.employeeId), /only HR/);
    const facNotes = await listCaseNotes(pool, w.facilities.p, ob.caseId);
    assert.deepEqual(facNotes.map((n: { body: string }) => n.body), ['Prefers a desk near the window']);
    const desk = fac.tasks.find((t) => t.key === 'desk')!;
    await assert.rejects(completeTask(pool, w.it.p, desk.id, {}), /FACILITIES team/);
    await completeTask(pool, w.facilities.p, desk.id, { note: 'Desk 4B' });

    // Activation waits for identity, the contract and the start date.
    const activate = await taskBy(pool, w.hrAdmin.p, ob.caseId, 'activate');
    assert.ok(activate.blockedBy.length >= 2);
    await assert.rejects(completeTask(pool, w.it.p, activate.id, {}), /waits for "Check identity/);
    await assert.rejects(exceptTask(pool, w.hrAdmin.p, (await taskBy(pool, w.hrAdmin.p, ob.caseId, 'identity')).id, { reason: 'skip' }), /critical and cannot be waived/);
    await completeTask(pool, w.hrClerk.p, (await taskBy(pool, w.hrAdmin.p, ob.caseId, 'identity')).id, { evidenceRef: 'Passport checked' });
    await completeTask(pool, w.hrClerk.p, (await taskBy(pool, w.hrAdmin.p, ob.caseId, 'contract')).id, {});
    await assert.rejects(completeTask(pool, w.it.p, activate.id, {}), /waits until/);
    // On the start date it runs, and the person gets their ordinary role.
    await pool.query('update lifecycle_task set wait_until = current_date where id = $1', [activate.id]);
    await completeTask(pool, w.it.p, activate.id, {});
    const { rows: after } = await pool.query<{ workspace_role: string }>('select workspace_role from actor where id = $1', [ob.actorId]);
    assert.equal(after[0]!.workspace_role, 'read_only');
    assert.ok((await listMembers(pool, pre)).length > 0, 'after activation they see the workspace');

    // The rest, then the case closes with a readiness summary along the way.
    for (const key of ['equipment', 'payroll', 'first_week']) {
      const t = await taskBy(pool, w.hrAdmin.p, ob.caseId, key);
      const by = { equipment: w.it.p, payroll: w.finance.p, first_week: w.manager.p }[key]!;
      await completeTask(pool, by, t.id, {});
    }
    assert.equal((await listCases(pool, w.hrAdmin.p)).find((c) => c.id === ob.caseId)!.status, 'closed');
  } finally { await pool.end(); }
});

test('acceptance 2, JRN-04: urgent termination revokes access at once; restricted; Finance clearance does not block revocation', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    const { rows: emp } = await pool.query<{ id: string }>(`insert into employee_record (tenant_id, actor_id, email, name, status, start_date) select $1, id, email, display_name, 'active', '2024-01-10' from actor where id = $2 returning id`, [w.tenantId, w.staff.id]);
    const session = (await startSession(pool, { actorId: w.staff.id }))!;
    // A manager cannot bypass the authority; nor can an HR clerk who is not an admin.
    await assert.rejects(urgentTermination(pool, w.manager.p, { employeeId: emp[0]!.id, reason: 'x' }), /owner or admin in HR/);
    await assert.rejects(urgentTermination(pool, w.hrClerk.p, { employeeId: emp[0]!.id, reason: 'x' }), /owner or admin in HR/);
    const ut = await urgentTermination(pool, w.hrAdmin.p, { employeeId: emp[0]!.id, reason: 'Gross misconduct under investigation' });
    assert.equal(ut.accessRevoked, true);
    assert.equal(await resolveSession(pool, session.token), null, 'signed out everywhere at once');
    const { rows: a } = await pool.query<{ active: boolean }>('select active from actor where id = $1', [w.staff.id]);
    assert.equal(a[0]!.active, false);
    // Asset recovery is still open; the critical revocation did not wait for it.
    const hrView = (await listCases(pool, w.hrAdmin.p)).find((c) => c.id === ut.caseId)!;
    assert.equal(hrView.kind, 'urgent_termination');
    assert.equal(hrView.tasks.find((t) => t.key === 'revoke')!.status, 'done');
    assert.equal(hrView.tasks.find((t) => t.key === 'equipment')!.status, 'open');
    // IT sees only its own tasks, not the reason, not that it is a termination.
    const itView = (await listCases(pool, w.it.p)).find((c) => c.id === ut.caseId)!;
    assert.equal(itView.kind, 'offboarding');
    assert.equal(itView.summary, null);
    assert.ok(itView.tasks.every((t) => t.team === 'it'));
    assert.deepEqual(await listCaseNotes(pool, w.it.p, ut.caseId), [], 'the disciplinary note stays in HR');
    // The manager has a handover task but cannot see the rest of a restricted case.
    const mView = (await listCases(pool, w.manager.p)).find((c) => c.id === ut.caseId)!;
    assert.ok(mView.tasks.every((t) => t.team === 'manager'));
  } finally { await pool.end(); }
});

test('offboarding: revocation waits only for the end date; Finance clearance names what is owed; waivers need a reason', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    const { rows: emp } = await pool.query<{ id: string; email: string }>(`insert into employee_record (tenant_id, actor_id, email, name, status) select $1, id, email, display_name, 'active' from actor where id = $2 returning id, email`, [w.tenantId, w.staff.id]);
    const ob = await startOffboarding(pool, w.hrClerk.p, { employeeId: emp[0]!.id, endDate: addDays(10) });
    await assert.rejects(startOffboarding(pool, w.hrClerk.p, { employeeId: emp[0]!.id, endDate: addDays(10) }), /already open/);
    const revoke = await taskBy(pool, w.hrAdmin.p, ob.caseId, 'revoke');
    assert.deepEqual(revoke.prerequisites, [], 'revocation waits for no other task');
    await assert.rejects(completeTask(pool, w.it.p, revoke.id, {}), /waits until/);
    // A cash advance still held blocks clearance with its reference.
    const { rows: pv } = await pool.query<{ id: string }>('select id from process_version limit 1');
    const { rows: inst } = await pool.query<{ id: string }>(`insert into instance (tenant_id, process_key, process_version_id, state, data) values ($1, 'cash_advance', $2, 'approved', '{}') returning id`, [w.tenantId, pv[0]!.id]);
    await pool.query(`insert into cash_advance (tenant_id, instance_id, reference, holder, amount, currency, outstanding, status) values ($1, $2, 'ADV-TEST01', $3, 500, 'NGN', 500, 'disbursed')`, [w.tenantId, inst[0]!.id, emp[0]!.email]);
    const clearance = await taskBy(pool, w.hrAdmin.p, ob.caseId, 'clearance');
    await assert.rejects(completeTask(pool, w.finance.p, clearance.id, {}), /advance ADV-TEST01: NGN 500\.00 still held/);
    await assert.rejects(exceptTask(pool, w.hrClerk.p, clearance.id, { reason: 'x' }), /owner or admin in HR/);
    await assert.rejects(exceptTask(pool, w.hrAdmin.p, clearance.id, {}), /record why/);
    await exceptTask(pool, w.hrAdmin.p, clearance.id, { reason: 'Deducted from final pay, agreed in writing' });
    // Templates refuse a revocation that waits for other tasks.
    await assert.rejects(saveTemplate(pool, w.hrAdmin.p, { kind: 'offboarding', name: 'Bad', tasks: [
      { key: 'assets', title: 'Assets', team: 'it' }, { key: 'revoke', title: 'Revoke', team: 'it', critical: true, action: 'revoke_access', after: ['assets'] },
    ] }), /must not wait/);
    await assert.rejects(saveTemplate(pool, w.hrAdmin.p, { kind: 'onboarding', name: 'Loop', tasks: [
      { key: 'a', title: 'A', team: 'hr', after: ['b'] }, { key: 'b', title: 'B', team: 'hr', after: ['a'] }, { key: 'c', title: 'C', team: 'it', action: 'activate_access' },
    ] }), /loop/);
  } finally { await pool.end(); }
});

test('acceptance 3: a transfer changes routing on its effective date and keeps the old manager in the history', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    const { rows: emp } = await pool.query<{ id: string }>(`insert into employee_record (tenant_id, actor_id, email, name, status) select $1, id, email, display_name, 'active' from actor where id = $2 returning id`, [w.tenantId, w.staff.id]);
    const effective = addDays(5);
    await assert.rejects(startTransfer(pool, w.hrClerk.p, { employeeId: emp[0]!.id, effectiveDate: effective, managerId: w.manager2.id, reason: 'x' }), /owner or admin in HR/);
    await startTransfer(pool, w.hrAdmin.p, { employeeId: emp[0]!.id, effectiveDate: effective, managerId: w.manager2.id, title: 'Senior officer', reason: 'Promotion to the Abuja team' });
    assert.equal((await managerOf(pool, { tenantId: w.tenantId, actorId: w.staff.id, at: new Date() }))!.id, w.manager.id, 'until the day, the old manager');
    assert.equal((await managerOf(pool, { tenantId: w.tenantId, actorId: w.staff.id, at: new Date(`${addDays(6)}T12:00:00Z`) }))!.id, w.manager2.id, 'from the day, the new one');
    const history = await reportingHistory(pool, w.owner.p, w.staff.id);
    assert.ok(history.some((h) => h.manager_id === w.manager.id && h.effective_to), 'the old line is kept, closed');
    const { rows: before } = await pool.query<{ position_title: string | null }>('select position_title from actor where id = $1', [w.staff.id]);
    assert.notEqual(before[0]!.position_title, 'Senior officer', 'the title waits for the day too');
  } finally { await pool.end(); }
});

test('leave: balances, holidays, overlaps, manager decision, cancellation', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    // A Monday-to-Friday week with a public holiday on the Wednesday is 4 days.
    const monday = (() => { const d = new Date(Date.now() + 21 * 86400000); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d; })();
    const iso = (n: number) => new Date(monday.getTime() + n * 86400000).toISOString().slice(0, 10);
    await saveHoliday(pool, w.hrClerk.p, { day: iso(2), name: 'Test holiday' });
    const r = await requestLeave(pool, w.staff.p, { type: 'annual', startDate: iso(0), endDate: iso(4), reason: 'Family visit' });
    assert.equal(r.days, 4);
    assert.equal(r.approver, 'your manager');
    await assert.rejects(requestLeave(pool, w.staff.p, { type: 'annual', startDate: iso(3), endDate: iso(3) }), /already have leave/);
    await assert.rejects(requestLeave(pool, w.staff.p, { type: 'annual', startDate: iso(7), endDate: iso(7 + 40) }), /you have 16 day\(s\) left/);
    // The manager sees it; the person cannot decide their own; another manager cannot either.
    const queue = await leaveToApprove(pool, w.manager.p);
    assert.equal(queue.length, 1);
    await assert.rejects(decideLeave(pool, w.manager2.p, r.id, { decision: 'approve' }), /manager or HR/);
    await assert.rejects(decideLeave(pool, w.manager.p, r.id, { decision: 'reject' }), /say why/);
    await decideLeave(pool, w.manager.p, r.id, { decision: 'approve' });
    const mine = await myLeave(pool, w.staff.p);
    assert.equal(mine.balances.find((b) => b.key === 'annual')!.left, 16);
    await cancelLeave(pool, w.staff.p, r.id);
    assert.equal((await myLeave(pool, w.staff.p)).balances.find((b) => b.key === 'annual')!.left, 20);
    // Unlimited types have no balance check.
    assert.ok((await requestLeave(pool, w.staff.p, { type: 'unpaid', startDate: iso(14), endDate: iso(14 + 60) })).days > 30);
  } finally { await pool.end(); }
});

test('documents say received or agreed; outside-owned fields become reconciliation tasks; hiring opens onboarding; reminders', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    const { rows: emp } = await pool.query<{ id: string }>(`insert into employee_record (tenant_id, actor_id, email, name, status, start_date, probation_end) select $1, id, email, display_name, 'active', (current_date - interval '3 years' + interval '5 days')::date, current_date + 20 from actor where id = $2 returning id`, [w.tenantId, w.staff.id]);

    // HR-07.
    const handbook = await createDocument(pool, w.hrClerk.p, { title: 'Staff handbook', version: '2026.1', kind: 'receipt' });
    const nda = await createDocument(pool, w.hrClerk.p, { title: 'Confidentiality agreement', version: 'v3', kind: 'agreement' });
    await assert.rejects(createDocument(pool, w.hrClerk.p, { title: 'Staff handbook', version: '2026.1' }), /already exists/);
    await sendDocument(pool, w.hrClerk.p, handbook.id, { employeeIds: [emp[0]!.id], dueDate: addDays(7) });
    await sendDocument(pool, w.hrClerk.p, nda.id, { employeeIds: [emp[0]!.id] });
    const docs = await myDocuments(pool, w.staff.p);
    const statements = [];
    for (const d of docs) statements.push((await acknowledgeDocument(pool, w.staff.p, d.id)).statement);
    assert.ok(statements.includes('I confirm I have received Staff handbook, version 2026.1.'));
    assert.ok(statements.includes('I agree to Confidentiality agreement, version v3.'));

    // HR-12: payroll owns the payroll reference and pay.
    await updateHrSettings(pool, w.hrAdmin.p, { fieldOwners: { payroll_ref: 'SeamlessHR', compensation: 'SeamlessHR' } });
    const upd = await updateEmployee(pool, w.hrClerk.p, emp[0]!.id, { payrollRef: 'PR-777', location: 'Abuja' });
    assert.deepEqual(upd.queuedForReconciliation, ['payroll reference']);
    const pay = await setCompensation(pool, w.hrAdmin.p, emp[0]!.id, { amount: 1, currency: 'NGN', effectiveFrom: today() });
    assert.equal(pay.queuedForReconciliation, true);
    const rec = await listReconciliations(pool, w.hrClerk.p);
    assert.equal(rec.length, 2);
    assert.ok(rec.every((r: { owner: string }) => r.owner === 'SeamlessHR'));
    const e = (await listEmployees(pool, w.hrClerk.p)).find((x) => x.id === emp[0]!.id)!;
    assert.equal(e.payroll_ref, null, 'not overwritten');
    assert.equal(e.location, 'Abuja', 'fields HR owns still change');

    // HR-11 and HR-04.
    const soon = await upcoming(pool, w.hrClerk.p, 30);
    assert.ok(soon.some((x: { kind: string }) => x.kind === 'probation_end'));
    assert.ok(soon.some((x: { kind: string; detail: string }) => x.kind === 'anniversary' && x.detail === '3 years'));
    const pr = await startProbationReview(pool, w.hrClerk.p, { employeeId: emp[0]!.id });
    await assert.rejects(decideProbation(pool, w.hrClerk.p, pr.caseId, { outcome: 'extend', reason: 'More time', newEnd: addDays(60) }), /owner or admin/);
    await decideProbation(pool, w.hrAdmin.p, pr.caseId, { outcome: 'extend', reason: 'More time on the Abuja route', newEnd: addDays(60) });
    assert.equal((await listEmployees(pool, w.hrClerk.p)).find((x) => x.id === emp[0]!.id)!.probation_end.toISOString?.().slice(0, 10) ?? '', addDays(60));

    // HR-01: an approved hiring request opens a requisition; an onboarding fills it.
    await saveBudget(pool, w.owner.p, { costCentre: 'ops', periodStart: '2026-01-01', periodEnd: '2027-12-31', amount: 100000, mode: 'enforced' }).catch(() => undefined);
    const bp = Blueprint.parse(JSON.parse(readFileSync('processes/hiring-request.blueprint.json', 'utf8')));
    const version = await engine.publish(w.tenantId, bp, 'test');
    await engine.grant({ tenantId: w.tenantId, actorId: w.hrAdmin.id, processKey: 'hiring_request', roleKey: 'hr_approver' });
    await engine.grant({ tenantId: w.tenantId, actorId: w.owner.id, processKey: 'hiring_request', roleKey: 'line_manager' });
    await setManager(pool, w.owner.p, w.manager.id, { managerId: w.owner.id, effectiveFrom: '2026-01-01T00:00:00Z' });
    const mEmail = (await engine.actor(w.manager.id))!.email;
    const now = new Date();
    const sub = await engine.submit({ version, now, answers: { requester_name: 'Mo', employee_email: mEmail, position: 'Field officer', headcount: 1, employment_type: 'employee', cost_centre: 'ops', start_by: addDays(30), justification: 'Cover for the Abuja route from January onwards.', annual_cost: 9000 } });
    for (const key of ['manager_approval', 'hr_approval']) {
      for (let i = 0; i < 40; i++) {
        await engine.drain(now, 'test', w.tenantId);
        const { rows } = await pool.query("select 1 from approval_request where instance_id = $1 and approval_key = $2 and status = 'pending'", [sub.instanceId, key]);
        if (rows[0]) break;
        await new Promise((res) => setTimeout(res, 250));
      }
      await engine.decide({ instanceId: sub.instanceId, approvalKey: key, decision: 'approved', reason: 'ok', principal: key === 'hr_approval' ? w.hrAdmin.p : w.owner.p, now });
    }
    const [hiring] = await listHiring(pool, w.hrClerk.p);
    assert.equal(hiring.position, 'Field officer');
    await startOnboarding(pool, w.hrClerk.p, { email: `hire-${stamp()}@hr.test`, name: 'Hired Person', startDate: addDays(30), hiringId: hiring.id });
    assert.equal((await listHiring(pool, w.hrClerk.p))[0].status, 'filled');
    await assert.rejects(startOnboarding(pool, w.hrClerk.p, { email: `hire2-${stamp()}@hr.test`, name: 'Second', startDate: addDays(30), hiringId: hiring.id }), /already filled/);

    const s = await hrSummary(pool, w.hrClerk.p);
    assert.equal(s.hr, true);
    assert.equal(s.reconciliation, 2);
    const staffSummary = await hrSummary(pool, w.staff.p);
    assert.equal(staffSummary.hr, false);
  } finally { await pool.end(); }
});
