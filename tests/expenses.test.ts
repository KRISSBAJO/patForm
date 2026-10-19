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
import {
  disburseAdvance, expenseSummary, listAdvances, listSettlements, moveSettlement, recordAdvanceReturn, updateExpenseSettings,
} from '../src/runtime/expenses.js';
import type { Principal } from '../src/runtime/policy.js';

// PRD Module 5. Approval and payment are separate facts; the policy is a
// workspace setting copied onto each claim; an advance is retired by a claim.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const claimBp = () => Blueprint.parse(JSON.parse(readFileSync('processes/staff-expense-claim.blueprint.json', 'utf8')));
const advanceBp = () => Blueprint.parse(JSON.parse(readFileSync('processes/cash-advance.blueprint.json', 'utf8')));

test('both expense processes compile clean', () => {
  for (const bp of [claimBp(), advanceBp()]) {
    const d = validate(bp);
    assert.equal(d.errors.length, 0, `${bp.key}: ${JSON.stringify(d.errors)}`);
    assert.equal(d.warnings.length, 0, `${bp.key}: ${JSON.stringify(d.warnings)}`);
  }
  // A policy field a respondent could type into is refused.
  const bad = claimBp();
  bad.data.fields.find((f) => f.key === 'policy_manager_limit')!.setBy = 'respondent';
  assert.ok(validate(bad).errors.some((e) => e.code === 'SEC013'));
});

test('both expense processes pass their own scenarios', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    for (const bp of [claimBp(), advanceBp()]) {
      const results = await runScenarios(pool, bp);
      assert.ok(results.every((r) => r.passed), `${bp.key}: ${JSON.stringify(results.filter((r) => !r.passed))}`);
    }
  } finally { await pool.end(); }
});

async function workspace(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`expenses-${stamp()}`, { scenario: true });
  const ownerId = await engine.createActor(tenantId, `owner-${stamp()}@ex.test`, 'Owner', 'owner');
  const owner: Principal = { kind: 'actor', tenantId, actorId: ownerId };
  const financeId = await engine.createActor(tenantId, `fin-${stamp()}@ex.test`, 'Fola Finance', 'operator');
  const finance: Principal = { kind: 'actor', tenantId, actorId: financeId };
  const managerId = await engine.createActor(tenantId, `mgr-${stamp()}@ex.test`, 'Mo Manager', 'approver');
  const staffEmail = `staff-${stamp()}@ex.test`;
  const staffId = await engine.createActor(tenantId, staffEmail, 'Sam Staff', 'read_only');
  await setManager(pool, owner, staffId, { managerId, effectiveFrom: '2026-01-01T00:00:00Z' });
  const claim = await engine.publish(tenantId, claimBp(), 'test');
  const advance = await engine.publish(tenantId, advanceBp(), 'test');
  for (const key of ['staff_expense_claim', 'cash_advance']) {
    await engine.grant({ tenantId, actorId: managerId, processKey: key, roleKey: 'line_manager' });
    await engine.grant({ tenantId, actorId: financeId, processKey: key, roleKey: 'finance_approver' });
  }
  return { tenantId, owner, finance, managerId, financeId, staffEmail, claim, advance };
}

const now = new Date('2026-10-19T09:00:00Z');
let n = 0;
const claimAnswers = (email: string, lines: number[], extra: Record<string, unknown> = {}) => ({
  claimant_name: 'Sam Staff', employee_email: email, expense_date: `2026-09-${String(10 + (++n % 18)).padStart(2, '0')}`,
  cost_centre: ['eng', 'sales', 'ops', 'admin'][n % 4], category: 'travel', business_purpose: 'Client visit in Lagos, taxis and lunch.',
  line_items: lines.map((amount, i) => ({ line_description: `Item ${i + 1}`, line_amount: amount })),
  receipt_reference: 'Scanned in the finance drive', ...extra,
});

async function drainUntil(engine: Engine, pool: Pool, tenantId: string, instanceId: string, approvalKey: string) {
  for (let i = 0; i < 40; i++) {
    await engine.drain(now, 'test', tenantId);
    const { rows } = await pool.query("select 1 from approval_request where instance_id = $1 and approval_key = $2 and status = 'pending'", [instanceId, approvalKey]);
    if (rows[0]) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no pending ${approvalKey}`);
}

test('policy comes from settings, is copied onto the claim, and the module switch gates the money routes', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);

    // Module off: the money routes refuse, whatever your role.
    await assert.rejects(listSettlements(pool, w.owner), /switched off/);
    await setModule(pool, w.owner, 'expenses', { enabled: true });

    // Default auto-approve limit is 100: a 64.50 claim is approved at once and owed.
    const small = await engine.submit({ version: w.claim, answers: claimAnswers(w.staffEmail, [64.5]), now });
    assert.ok(small.instanceId);
    let owed = await listSettlements(pool, w.finance);
    assert.equal(owed.length, 1);
    assert.equal(Number(owed[0].amount), 64.5);
    assert.equal(owed[0].status, 'awaiting_payment');

    // Lower it to 50: the same amount now goes to the manager from the directory.
    await updateExpenseSettings(pool, w.owner, { autoApproveLimit: 50 });
    const routed = await engine.submit({ version: w.claim, answers: claimAnswers(w.staffEmail, [64.5]), now });
    await drainUntil(engine, pool, w.tenantId, routed.instanceId, 'manager_approval');
    const { rows: req } = await pool.query<{ approvers: string[] }>("select approvers from approval_request where instance_id = $1", [routed.instanceId]);
    const managerEmail = (await engine.actor(w.managerId))!.email;
    assert.deepEqual(req[0]!.approvers, [managerEmail]);
    // The number it was routed by is on the record; raising the limit now changes nothing for it.
    const { rows: data } = await pool.query<{ data: Record<string, unknown> }>('select data from instance where id = $1', [routed.instanceId]);
    assert.equal(data[0]!.data.policy_auto_approve_limit, 50);
    await updateExpenseSettings(pool, w.owner, { autoApproveLimit: 100 });
    const { rows: still } = await pool.query<{ state: string }>('select state from instance where id = $1', [routed.instanceId]);
    assert.equal(still[0]!.state, 'manager_review');

    // A respondent cannot send their own limit.
    const sneaky = await engine.submit({ version: w.claim, answers: { ...claimAnswers(w.staffEmail, [5000]), policy_manager_limit: 999999 }, now });
    assert.deepEqual(sneaky.rejected, ['policy_manager_limit']);

    // Receipt rule and categories are settings too.
    await updateExpenseSettings(pool, w.owner, { receiptThreshold: 20, categories: ['travel', 'training'] });
    const noReceipt = await engine.submit({ version: w.claim, answers: claimAnswers(w.staffEmail, [30], { receipt_reference: '' }), now });
    assert.deepEqual(noReceipt.rejected, ['receipt_reference']);
    assert.match(noReceipt.problems![0]!, /receipt is needed for claims over 20/);
    const tinyNoReceipt = await engine.submit({ version: w.claim, answers: claimAnswers(w.staffEmail, [15], { receipt_reference: '' }), now });
    assert.ok(tinyNoReceipt.instanceId, 'under the receipt threshold no receipt is needed');
    const badCategory = await engine.submit({ version: w.claim, answers: claimAnswers(w.staffEmail, [30], { category: 'equipment' }), now });
    assert.deepEqual(badCategory.rejected, ['category']);

    // Settings validation.
    await assert.rejects(updateExpenseSettings(pool, w.owner, { autoApproveLimit: 5000, managerLimit: 1000 }), /cannot be above/);
    await assert.rejects(updateExpenseSettings(pool, w.finance, { autoApproveLimit: 10 }), /administer/);
  } finally { await pool.end(); }
});

test('approval opens a settlement; payment needs a reference; a failed payment stays owed; paid cannot change', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    await setModule(pool, w.owner, 'expenses', { enabled: true });

    // 1,400 with a 850 line: manager, then Finance, then a settlement.
    const big = await engine.submit({ version: w.claim, answers: claimAnswers(w.staffEmail, [850, 310, 240]), now });
    await drainUntil(engine, pool, w.tenantId, big.instanceId, 'manager_approval');
    assert.equal((await listSettlements(pool, w.finance)).length, 0, 'nothing is owed before approval');
    await engine.decide({ instanceId: big.instanceId, approvalKey: 'manager_approval', decision: 'approved', reason: 'ok', principal: { kind: 'actor', tenantId: w.tenantId, actorId: w.managerId }, now });
    await drainUntil(engine, pool, w.tenantId, big.instanceId, 'finance_approval');
    await engine.decide({ instanceId: big.instanceId, approvalKey: 'finance_approval', decision: 'approved', reason: 'receipts match', principal: { kind: 'actor', tenantId: w.tenantId, actorId: w.financeId }, now });
    const [settlement] = await listSettlements(pool, w.finance);
    assert.equal(Number(settlement.amount), 1400);
    assert.equal(settlement.status, 'awaiting_payment');
    const events = (await engine.events(big.instanceId)).map((e) => e.type);
    assert.ok(events.includes('settlement_opened'));

    // Paid needs evidence; failed and void need a reason.
    await assert.rejects(moveSettlement(pool, w.finance, settlement.id, { to: 'paid' }), /payment reference/);
    await assert.rejects(moveSettlement(pool, w.finance, settlement.id, { to: 'failed' }), /reason/);
    // Failed: still approved, still owed, and shown that way.
    await moveSettlement(pool, w.finance, settlement.id, { to: 'failed', note: 'Bank returned it: wrong account' });
    const summary = await expenseSummary(pool, w.finance);
    assert.equal(summary.failed, 1);
    const { rows: state } = await pool.query<{ state: string }>('select state from instance where id = $1', [big.instanceId]);
    assert.equal(state[0]!.state, 'approved', 'a failed payment never un-approves the claim');
    // Retry and pay.
    await moveSettlement(pool, w.finance, settlement.id, { to: 'paid', reference: 'BATCH-2026-10-19' });
    await assert.rejects(moveSettlement(pool, w.finance, settlement.id, { to: 'void', note: 'oops' }), /already paid/);
    const paid = (await listSettlements(pool, w.finance, 'paid'))[0];
    assert.equal(paid.reference, 'BATCH-2026-10-19');
    assert.ok((await engine.events(big.instanceId)).some((e) => e.type === 'settlement_paid'));

    // Another workspace's Finance cannot touch it, even by id.
    const other = await workspace(pool, engine);
    await setModule(pool, other.owner, 'expenses', { enabled: true });
    assert.equal((await listSettlements(pool, other.finance)).length, 0);
    await assert.rejects(moveSettlement(pool, other.finance, settlement.id, { to: 'void', note: 'x' }), /no such settlement/);
    // A read-only member cannot see Finance's lists.
    const readerId = await engine.createActor(w.tenantId, `reader-${stamp()}@ex.test`, 'Reader', 'read_only');
    await assert.rejects(listSettlements(pool, { kind: 'actor', tenantId: w.tenantId, actorId: readerId }), /operate/);
  } finally { await pool.end(); }
});

test('an advance is paid out, retired by a claim, and the balance is returned or reimbursed', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    await setModule(pool, w.owner, 'expenses', { enabled: true });
    const managerPrincipal: Principal = { kind: 'actor', tenantId: w.tenantId, actorId: w.managerId };

    const ask = async (amount: number, day: string) => {
      const r = await engine.submit({ version: w.advance, now, answers: {
        claimant_name: 'Sam Staff', employee_email: w.staffEmail, needed_by: day, cost_centre: 'ops',
        purpose: 'Site visit to Abuja: transport, lodging and meals.', advance_amount: amount } });
      await drainUntil(engine, pool, w.tenantId, r.instanceId, 'manager_approval');
      await engine.decide({ instanceId: r.instanceId, approvalKey: 'manager_approval', decision: 'approved', reason: 'ok', principal: managerPrincipal, now });
      return (await listAdvances(pool, w.finance)).find((a) => a.instance_id === r.instanceId)!;
    };

    // 1. An approved advance of 500. Not paid out yet, so it cannot be retired.
    const first = await ask(500, '2026-11-01');
    assert.equal(first.status, 'approved');
    assert.match(first.reference, /^ADV-[0-9A-F]{8}$/);
    const tooEarly = await engine.submit({ version: w.claim, answers: claimAnswers(w.staffEmail, [120], { advance_reference: first.reference }), now });
    assert.deepEqual(tooEarly.rejected, ['advance_reference']);
    assert.match(tooEarly.problems![0]!, /not been paid out/);

    // Paid out: the retirement clock starts from the policy.
    const out = await disburseAdvance(pool, w.finance, first.id, { reference: 'TRF-001' });
    assert.equal(Math.round((out.dueAt.getTime() - Date.now()) / 86_400_000), 14);
    await assert.rejects(disburseAdvance(pool, w.finance, first.id, { reference: 'TRF-002' }), /only an approved advance/);

    // Someone else cannot quote it.
    const strangerEmail = `stranger-${stamp()}@ex.test`;
    await engine.createActor(w.tenantId, strangerEmail, 'Stranger', 'read_only');
    const notYours = await engine.submit({ version: w.claim, answers: claimAnswers(strangerEmail, [80], { advance_reference: first.reference }), now });
    assert.deepEqual(notYours.rejected, ['advance_reference']);

    // 2. Spent 80 of 500 (auto-approved): nothing to pay, 420 still to return.
    await engine.submit({ version: w.claim, answers: claimAnswers(w.staffEmail, [80], { advance_reference: first.reference }), now });
    let advance = (await listAdvances(pool, w.finance)).find((a) => a.id === first.id)!;
    assert.equal(Number(advance.outstanding), 420);
    assert.equal(Number(advance.spent), 80);
    assert.equal(advance.status, 'awaiting_return');
    const zero = (await listSettlements(pool, w.finance, 'paid')).find((s) => s.advance_reference === first.reference)!;
    assert.equal(Number(zero.amount), 0, 'fully covered by the advance: nothing is paid out');

    // 3. Returns: never more than is held; the last one retires it.
    await assert.rejects(recordAdvanceReturn(pool, w.finance, first.id, { amount: 500, reference: 'CASH-1' }), /only 420/);
    await recordAdvanceReturn(pool, w.finance, first.id, { amount: 400, reference: 'CASH-1' });
    await recordAdvanceReturn(pool, w.finance, first.id, { amount: 20, reference: 'CASH-2' });
    advance = (await listAdvances(pool, w.finance)).find((a) => a.id === first.id)!;
    assert.equal(advance.status, 'retired');
    assert.equal(Number(advance.returned), 420);
    // The movements are append-only.
    await assert.rejects(pool.query('delete from advance_movement where advance_id = $1', [first.id]), /append-only/);

    // 4. A second advance of 300, overspent by 90: the claim pays out only the 90.
    const second = await ask(300, '2026-11-02');
    await disburseAdvance(pool, w.finance, second.id, { reference: 'TRF-003' });
    const over = await engine.submit({ version: w.claim, answers: claimAnswers(w.staffEmail, [180, 190, 20], { advance_reference: second.reference }), now });
    await drainUntil(engine, pool, w.tenantId, over.instanceId, 'manager_approval');
    await engine.decide({ instanceId: over.instanceId, approvalKey: 'manager_approval', decision: 'approved', reason: 'ok', principal: managerPrincipal, now });
    const topUp = (await listSettlements(pool, w.finance)).find((s) => s.instance_id === over.instanceId)!;
    assert.equal(Number(topUp.amount), 90);
    assert.equal(topUp.status, 'awaiting_payment');
    advance = (await listAdvances(pool, w.finance)).find((a) => a.id === second.id)!;
    assert.equal(advance.status, 'retired');
    assert.equal(Number(advance.outstanding), 0);
    // A retired advance cannot be quoted again.
    const again = await engine.submit({ version: w.claim, answers: claimAnswers(w.staffEmail, [10], { advance_reference: second.reference }), now });
    assert.match(again.problems![0]!, /already settled/);

    const s = await expenseSummary(pool, w.finance);
    assert.equal(s.advancesOpen, 0);
    assert.equal(s.awaitingPayment, 1);
    assert.equal(s.awaitingAmount, 90);
  } finally { await pool.end(); }
});
