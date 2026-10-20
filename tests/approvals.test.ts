import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { validate } from '../src/compiler/validate.js';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { runScenarios } from '../src/runtime/scenarios.js';
import { setModule } from '../src/runtime/modules.js';
import { setManager } from '../src/runtime/org.js';
import { memoryObjectStore, setObjectStoreForTests } from '../src/runtime/object-store.js';
import { setTeamMember } from '../src/runtime/hr.js';
import { saveBranch, setEmployeeBranch } from '../src/runtime/hr-records.js';
import { TEMPLATES, adoptTemplate, approvalsOverview, checkSteps, listPolicies, savePolicy, setApprovalMailerForTests, setPolicyActive, simulatePolicy, sweepApprovals, uploadEvidence } from '../src/runtime/approvals.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const bp = () => Blueprint.parse(JSON.parse(readFileSync('processes/approval-request.blueprint.json', 'utf8')));
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n').toString('base64');
const now = new Date('2026-10-20T09:00:00Z');
const later = (h: number) => new Date(now.getTime() + h * 3_600_000);

test('the approval request process compiles clean and passes its own scenarios without a policy', { skip: !localDatabase }, async () => {
  const d = validate(bp());
  assert.equal(d.errors.length, 0, JSON.stringify(d.errors)); assert.equal(d.warnings.length, 0, JSON.stringify(d.warnings));
  const pool = createPool(3);
  try { const results = await runScenarios(pool, bp()); assert.ok(results.every((r) => r.passed), JSON.stringify(results.filter((r) => !r.passed))); } finally { await pool.end(); }
});

test('steps are checked: responsible, modes, bands, evidence, clocks', () => {
  assert.throws(() => checkSteps([]), /1 to 12 steps/);
  assert.throws(() => checkSteps([{ name: 'x', responsible: [] }]), /who is responsible/);
  assert.throws(() => checkSteps([{ name: 'x', responsible: [{ kind: 'wizard' }] }]), /responsible must be one of/);
  assert.throws(() => checkSteps([{ name: 'x', responsible: [{ kind: 'manager' }], mode: 'quorum', required: 1 }]), /2 to 20/);
  assert.throws(() => checkSteps([{ name: 'x', responsible: [{ kind: 'manager' }], applies: { minAmount: 10, maxAmount: 5 } }]), /below minAmount/);
  assert.throws(() => checkSteps([{ name: 'x', responsible: [{ kind: 'manager' }], sla: { escalateAfterHours: 5 } }]), /who the escalation goes to/);
  assert.throws(() => checkSteps([{ name: 'x', responsible: [{ kind: 'manager' }], sla: { remindAfterHours: 50, escalateAfterHours: 5, escalateTo: [{ kind: 'skip_manager' }] } }]), /before the escalation/);
  const [s] = checkSteps([{ name: 'Finance approval', responsible: [{ kind: 'team', team: 'finance' }], mode: 'any', evidence: 'note', applies: { minAmount: '1,000' }, onReject: 'return' }]);
  assert.equal(s!.key, 'finance_approval'); assert.equal(s!.applies!.minAmount, 1000); assert.equal(s!.notTheSubmitter, true);
  for (const t of TEMPLATES) assert.doesNotThrow(() => checkSteps(t.steps), t.key);
});

async function workspace(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`approvals-${stamp()}`, { scenario: true });
  const mk = async (name: string, role: 'owner' | 'admin' | 'operator' | 'approver' | 'read_only') => { const email = `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@apr.test`; const id = await engine.createActor(tenantId, email, name, role); await pool.query('update actor set email_verified_at = now() where id = $1', [id]); return { id, email, p: { kind: 'actor', tenantId, actorId: id } as Principal }; };
  const owner = await mk('Owner', 'owner'); const mo = await mk('Mo Manager', 'approver'); const boss = await mk('Bea Boss', 'approver'); const fin = await mk('Fola Finance', 'operator'); const fin2 = await mk('Femi Finance', 'operator'); const sam = await mk('Sam Staff', 'read_only');
  await setModule(pool, owner.p, 'hr', { enabled: true });
  await setManager(pool, owner.p, sam.id, { managerId: mo.id, effectiveFrom: '2026-01-01T00:00:00Z' });
  await setManager(pool, owner.p, mo.id, { managerId: boss.id, effectiveFrom: '2026-01-01T00:00:00Z' });
  for (const f of [fin, fin2]) await setTeamMember(pool, owner.p, { team: 'finance', actorId: f.id });
  const version = await engine.publish(tenantId, bp(), 'test');
  for (const a of [mo, boss]) await engine.grant({ tenantId, actorId: a.id, processKey: 'approval_request', roleKey: 'line_manager' });
  for (const f of [fin, fin2]) await engine.grant({ tenantId, actorId: f.id, processKey: 'approval_request', roleKey: 'finance_approver' });
  return { tenantId, owner, mo, boss, fin, fin2, sam, version };
}
const ask = (email: string, amount: number, extra: Record<string, unknown> = {}) => ({ requester_name: 'Sam Staff', employee_email: email, title: `Request for ${amount} ${stamp()}`, category: 'purchase', cost_centre: 'ops', amount, description: 'Two field officers start in December and need laptops to run the survey app offline.', ...extra });
async function drained(engine: Engine, pool: Pool, tenantId: string, instanceId: string) {
  for (let i = 0; i < 40; i++) {
    await engine.drain(now, 'test', tenantId);
    const { rows } = await pool.query("select 1 from approval_request where instance_id = $1 and status = 'pending'", [instanceId]);
    if (rows[0]) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('no pending approval after draining');
}
const pendingFor = async (pool: Pool, instanceId: string) => (await pool.query<{ approvers: string[]; mode: string; due_at: Date | null }>(`select approvers, mode, due_at from approval_request where instance_id = $1 and status = 'pending' order by id desc limit 1`, [instanceId])).rows[0] ?? null;

test('a policy chain: manager, then Finance above the limit with a note, then any two above the cap with a file; the process sees one decision', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const mails: { kind: string; to: string; subject: string }[] = [];
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store); setApprovalMailerForTests(async (_p, m) => { mails.push(m); });
  try {
    const engine = new Engine(pool); const w = await workspace(pool, engine);
    const steps = [
      { key: 'manager', name: 'Manager approval', responsible: [{ kind: 'manager' }], mode: 'any', evidence: 'none', sla: { remindAfterHours: 24, escalateAfterHours: 48, escalateTo: [{ kind: 'skip_manager' }] }, onReject: 'return' },
      { key: 'finance', name: 'Finance approval', responsible: [{ kind: 'team', team: 'finance' }], mode: 'any', evidence: 'note', applies: { minAmount: 1000 }, onReject: 'end' },
      { key: 'two', name: 'Two signatures', responsible: [{ kind: 'team', team: 'finance' }, { kind: 'person', email: w.boss.email }], mode: 'quorum', required: 2, evidence: 'file', applies: { minAmount: 5000 }, onReject: 'end' },
    ];
    await assert.rejects(savePolicy(pool, w.sam.p, { processKey: 'approval_request', name: 'x', steps }), /administer|not allowed|only/i);
    const policy = await savePolicy(pool, w.owner.p, { processKey: 'approval_request', name: 'Standard spend', steps });
    assert.equal(policy.version, 1);
    assert.ok((await listPolicies(pool, w.owner.p)).processes.some((p) => p.key === 'approval_request' && p.approvals[0]!.policy));

    // 400: only the manager. The record is approved after one decision.
    const small = await engine.submit({ version: w.version, answers: ask(w.sam.email, 400), now }); await drained(engine, pool, w.tenantId, small.instanceId);
    let pending = await pendingFor(pool, small.instanceId);
    assert.deepEqual(pending!.approvers, [w.mo.email]);
    assert.ok(mails.some((m) => m.kind === 'approval_requested' && m.to === w.mo.email), 'the manager is told');
    await assert.rejects(engine.decide({ instanceId: small.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.sam.p, reason: 'me', now }), /not named|submitter|refused|cannot|may not/i);
    const r1 = await engine.decide({ instanceId: small.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.mo.p, reason: 'ok', now });
    assert.equal(r1.applied, true); assert.deepEqual(r1.chain, { step: 1, of: 1 });
    assert.equal((await pool.query('select state from instance where id = $1', [small.instanceId])).rows[0].state, 'approved');

    // 2,400: manager, then Finance, who must write a note.
    const mid = await engine.submit({ version: w.version, answers: ask(w.sam.email, 2400), now }); await drained(engine, pool, w.tenantId, mid.instanceId);
    await engine.decide({ instanceId: mid.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.mo.p, reason: 'ok', now });
    assert.equal((await pool.query('select state from instance where id = $1', [mid.instanceId])).rows[0].state, 'under_review', 'still being decided');
    pending = await pendingFor(pool, mid.instanceId);
    assert.deepEqual([...pending!.approvers].sort(), [w.fin.email, w.fin2.email].sort());
    await assert.rejects(engine.decide({ instanceId: mid.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.fin.p, now }), /write a note/);
    await assert.rejects(engine.decide({ instanceId: mid.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.mo.p, reason: 'again', now }), /not named|refused|cannot|may not/i);
    const r2 = await engine.decide({ instanceId: mid.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.fin.p, reason: 'Budget checked, quote attached.', now });
    assert.deepEqual(r2.chain, { step: 2, of: 2 });
    assert.equal((await pool.query('select state from instance where id = $1', [mid.instanceId])).rows[0].state, 'approved');
    const { rows: events } = await pool.query<{ type: string; payload: Record<string, unknown> }>(`select type, payload from event where instance_id = $1 order by seq`, [mid.instanceId]);
    assert.deepEqual(events.filter((e) => e.type === 'approval_step_decided').map((e) => (e.payload.step as { name: string }).name), ['Manager approval', 'Finance approval']);
    assert.equal(events.filter((e) => e.type === 'approval_routed').length, 2);

    // 9,000: three steps; the last needs a file and two different people.
    const big = await engine.submit({ version: w.version, answers: ask(w.sam.email, 9000), now }); await drained(engine, pool, w.tenantId, big.instanceId);
    await engine.decide({ instanceId: big.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.mo.p, reason: 'ok', now });
    await engine.decide({ instanceId: big.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.fin.p, reason: 'Budget checked.', now });
    pending = await pendingFor(pool, big.instanceId);
    assert.equal(pending!.mode, 'quorum');
    await assert.rejects(engine.decide({ instanceId: big.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.fin2.p, reason: 'x', now }), /attach the evidence/);
    await uploadEvidence(pool, w.fin2.p, big.instanceId, 'policy_approval', { filename: 'quote.pdf', base64: PDF });
    const v1 = await engine.decide({ instanceId: big.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.fin2.p, reason: 'Quote matches.', now });
    assert.equal(v1.applied, false); assert.deepEqual(v1.progress, { have: 1, need: 2 });
    await uploadEvidence(pool, w.boss.p, big.instanceId, 'policy_approval', { filename: 'case.pdf', base64: PDF });
    const v2 = await engine.decide({ instanceId: big.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.boss.p, reason: 'Agreed.', now });
    assert.deepEqual(v2.chain, { step: 3, of: 3 });
    assert.equal((await pool.query('select state from instance where id = $1', [big.instanceId])).rows[0].state, 'approved');

    // A rejection at the manager step goes back to the requester; at Finance it ends.
    const back = await engine.submit({ version: w.version, answers: ask(w.sam.email, 3000), now }); await drained(engine, pool, w.tenantId, back.instanceId);
    await engine.decide({ instanceId: back.instanceId, approvalKey: 'policy_approval', decision: 'rejected', principal: w.mo.p, reason: 'Which room?', now });
    assert.equal((await pool.query('select state from instance where id = $1', [back.instanceId])).rows[0].state, 'returned', 'manager rejection returns it');
    await engine.grant({ tenantId: w.tenantId, actorId: w.owner.id, processKey: 'approval_request', roleKey: 'admin' });
    await engine.updateRecord({ instanceId: back.instanceId, patch: { cost_centre: 'eng' }, principal: w.owner.p, now });
    assert.equal((await pool.query('select state from instance where id = $1', [back.instanceId])).rows[0].state, 'under_review', 'resubmitted'); await drained(engine, pool, w.tenantId, back.instanceId);
    await engine.decide({ instanceId: back.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.mo.p, reason: 'ok', now });
    await engine.decide({ instanceId: back.instanceId, approvalKey: 'policy_approval', decision: 'rejected', principal: w.fin.p, reason: 'No budget.', now });
    assert.equal((await pool.query('select state from instance where id = $1', [back.instanceId])).rows[0].state, 'rejected', 'Finance rejection ends it');

    // Reminders and escalation: a request the manager ignores is chased after a day and escalated to their manager after two.
    mails.length = 0;
    const slow = await engine.submit({ version: w.version, answers: ask(w.sam.email, 500), now }); await drained(engine, pool, w.tenantId, slow.instanceId);
    assert.deepEqual(await sweepApprovals(pool, later(1)), { reminded: 0, escalated: 0 });
    await pool.query('update tenant set is_scenario = false where id = $1', [w.tenantId]);
    assert.deepEqual(await sweepApprovals(pool, later(25)), { reminded: 1, escalated: 0 });
    assert.ok(mails.some((m) => m.kind === 'approval_reminder' && m.to === w.mo.email));
    assert.deepEqual(await sweepApprovals(pool, later(26)), { reminded: 0, escalated: 0 }, 'reminded once');
    assert.deepEqual(await sweepApprovals(pool, later(49)), { reminded: 0, escalated: 1 });
    pending = await pendingFor(pool, slow.instanceId);
    assert.deepEqual([...pending!.approvers].sort(), [w.boss.email, w.mo.email].sort(), 'the manager’s manager is added');
    assert.ok(mails.some((m) => m.kind === 'approval_escalated' && m.to === w.boss.email));
    await pool.query('update tenant set is_scenario = true where id = $1', [w.tenantId]);
    const bossDecides = await engine.decide({ instanceId: slow.instanceId, approvalKey: 'policy_approval', decision: 'approved', principal: w.boss.p, reason: 'ok', now: later(50) });
    assert.equal(bossDecides.applied, true);
    const overview = await approvalsOverview(pool, w.owner.p);
    assert.equal(overview.counts.open, 0); assert.ok(overview.last90Days.decided >= 8);
  } finally { setObjectStoreForTests(undefined); setApprovalMailerForTests(null); await pool.end(); }
});

test('templates are adopted and edited; a branch policy beats the workspace one; simulate explains who decides', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool); const w = await workspace(pool, engine);
    const adopted = await adoptTemplate(pool, w.owner.p, { templateKey: 'manager_then_finance', processKey: 'approval_request' });
    const list = await listPolicies(pool, w.owner.p);
    const mine = list.policies.find((p: { id: string }) => p.id === adopted.id)!;
    assert.equal(mine.template_key, 'manager_then_finance'); assert.equal(mine.steps.length, 2); assert.equal(mine.active, true);
    // Edit the limit; the version moves on.
    const edited = await savePolicy(pool, w.owner.p, { id: adopted.id, processKey: 'approval_request', name: 'Standard spend', steps: mine.steps.map((s: { key: string; applies: Record<string, unknown> }) => s.key === 'finance' ? { ...s, applies: { minAmount: 250 } } : s) });
    assert.equal(edited.version, 2);
    // A Lagos branch policy with its own chain; Sam is in Lagos, Pat is not.
    const lagos = await saveBranch(pool, w.owner.p, { name: 'Lagos', country: 'NG', currency: 'NGN' });
    const { rows: emp } = await pool.query<{ id: string }>(`insert into employee_record (tenant_id, actor_id, email, name, status) select $1, id, email, display_name, 'active' from actor where id = $2 returning id`, [w.tenantId, w.sam.id]);
    await setEmployeeBranch(pool, w.owner.p, emp[0]!.id, { branchId: lagos.id });
    await savePolicy(pool, w.owner.p, { processKey: 'approval_request', name: 'Lagos spend', branchId: lagos.id, steps: [{ name: 'Country manager', responsible: [{ kind: 'person', email: w.boss.email }], mode: 'any', evidence: 'none', onReject: 'end' }] });
    const inLagos = await engine.submit({ version: w.version, answers: ask(w.sam.email, 300), now }); await drained(engine, pool, w.tenantId, inLagos.instanceId);
    assert.deepEqual((await pendingFor(pool, inLagos.instanceId))!.approvers, [w.boss.email], 'the branch policy routes to the country manager');
    // A second active policy for the same process and branch replaces the first.
    await savePolicy(pool, w.owner.p, { processKey: 'approval_request', name: 'Lagos spend v2', branchId: lagos.id, steps: [{ name: 'Manager', responsible: [{ kind: 'manager' }], mode: 'any', evidence: 'none', onReject: 'end' }] });
    const again = await listPolicies(pool, w.owner.p);
    assert.equal(again.policies.filter((p: { branch_id: string | null; active: boolean }) => p.branch_id === lagos.id && p.active).length, 1);
    // Switch the workspace policy off: the process falls back to its own approvers.
    await setPolicyActive(pool, w.owner.p, adopted.id, false);
    // Simulate: who decides a 6,000 purchase from ops, with a cost centre owner named.
    const sim = await simulatePolicy(pool, w.owner.p, { processKey: 'approval_request', amount: 6000, category: 'purchase', costCentre: 'ops', costCentreOwners: { ops: 'ops.owner@apr.test' }, steps: TEMPLATES.find((t) => t.key === 'cost_centre_owner')!.steps });
    assert.deepEqual(sim.steps.map((s) => [s.key, s.applies]), [['owner', true], ['finance', true]]);
    assert.ok(sim.steps[0]!.who[0]!.includes('ops.owner@apr.test'));
    const small = await simulatePolicy(pool, w.owner.p, { processKey: 'approval_request', amount: 100, steps: TEMPLATES.find((t) => t.key === 'cost_centre_owner')!.steps });
    assert.deepEqual(small.steps.map((s) => s.applies), [true, false]);
  } finally { await pool.end(); }
});
