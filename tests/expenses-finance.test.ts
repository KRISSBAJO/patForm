import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { setManager } from '../src/runtime/org.js';
import { workspaceAudit } from '../src/runtime/authority.js';
import {
  addRate, disburseAdvance, exportPaid, listAdvances, listBudgets, listSettlements, moveSettlement, myBeneficiary,
  revealBeneficiary, reviewLines, saveBeneficiary, saveBudget, settlementLines, updateExpenseSettings, verifyBeneficiary,
} from '../src/runtime/expenses.js';
import type { Principal } from '../src/runtime/policy.js';

// PRD Module 5, second stage: EXP-04 currency, EXP-05 budgets, EXP-07 line
// decisions, EXP-09 bank details, EXP-10 accounting export.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const load = (f: string) => Blueprint.parse(JSON.parse(readFileSync(`processes/${f}`, 'utf8')));
const now = new Date('2026-10-19T09:00:00Z');

async function workspace(pool: Pool, engine: Engine, currency = 'GBP') {
  const tenantId = await engine.createTenant(`fin-${stamp()}`, { scenario: true });
  await pool.query('update tenant set default_currency = $2 where id = $1', [tenantId, currency]);
  const ownerId = await engine.createActor(tenantId, `owner-${stamp()}@fin.test`, 'Owner', 'owner');
  const owner: Principal = { kind: 'actor', tenantId, actorId: ownerId };
  const financeId = await engine.createActor(tenantId, `fin-${stamp()}@fin.test`, 'Fola Finance', 'operator');
  const finance: Principal = { kind: 'actor', tenantId, actorId: financeId };
  const managerId = await engine.createActor(tenantId, `mgr-${stamp()}@fin.test`, 'Mo Manager', 'approver');
  const staffEmail = `staff-${stamp()}@fin.test`;
  const staffId = await engine.createActor(tenantId, staffEmail, 'Sam Staff', 'read_only');
  const staff: Principal = { kind: 'actor', tenantId, actorId: staffId };
  await setManager(pool, owner, staffId, { managerId, effectiveFrom: '2026-01-01T00:00:00Z' });
  await setModule(pool, owner, 'expenses', { enabled: true });
  const claim = await engine.publish(tenantId, load('staff-expense-claim.blueprint.json'), 'test');
  const advance = await engine.publish(tenantId, load('cash-advance.blueprint.json'), 'test');
  for (const key of ['staff_expense_claim', 'cash_advance']) {
    await engine.grant({ tenantId, actorId: managerId, processKey: key, roleKey: 'line_manager' });
    await engine.grant({ tenantId, actorId: financeId, processKey: key, roleKey: 'finance_approver' });
  }
  const manager: Principal = { kind: 'actor', tenantId, actorId: managerId };
  return { tenantId, owner, finance, financeId, manager, managerId, staff, staffId, staffEmail, claim, advance };
}
type W = Awaited<ReturnType<typeof workspace>>;

let day = 0;
function claimAnswers(w: W, lines: (number | [string, number])[], extra: Record<string, unknown> = {}) {
  day += 1;
  return {
    claimant_name: 'Sam Staff', employee_email: w.staffEmail,
    expense_date: `2026-${String(8 + Math.floor(day / 28) % 2).padStart(2, '0')}-${String(1 + (day % 28)).padStart(2, '0')}`,
    cost_centre: 'ops', category: 'travel', business_purpose: 'Client visit: taxis, lunch and a hotel night.',
    line_items: lines.map((l, i) => Array.isArray(l) ? { line_description: l[0], line_amount: l[1] } : { line_description: `Item ${i + 1}`, line_amount: l }),
    receipt_reference: 'Scanned in the finance drive', ...extra,
  };
}

async function waitFor(engine: Engine, pool: Pool, w: W, instanceId: string, approvalKey: string) {
  for (let i = 0; i < 40; i++) {
    await engine.drain(now, 'test', w.tenantId);
    const { rows } = await pool.query("select 1 from approval_request where instance_id = $1 and approval_key = $2 and status = 'pending'", [instanceId, approvalKey]);
    if (rows[0]) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no pending ${approvalKey}`);
}

/** Submit, and approve as far as it needs, ending approved. */
async function approvedClaim(engine: Engine, pool: Pool, w: W, answers: Record<string, unknown>) {
  const r = await engine.submit({ version: w.claim, answers, now });
  assert.ok(r.instanceId, `submission refused: ${JSON.stringify(r)}`);
  const state = async () => (await pool.query<{ state: string }>('select state from instance where id = $1', [r.instanceId])).rows[0]!.state;
  if (await state() === 'manager_review') {
    await waitFor(engine, pool, w, r.instanceId, 'manager_approval');
    await engine.decide({ instanceId: r.instanceId, approvalKey: 'manager_approval', decision: 'approved', reason: 'ok', principal: w.manager, now });
  }
  if (await state() === 'finance_review') {
    await waitFor(engine, pool, w, r.instanceId, 'finance_approval');
    await engine.decide({ instanceId: r.instanceId, approvalKey: 'finance_approval', decision: 'approved', reason: 'ok', principal: w.finance, now });
  }
  assert.equal(await state(), 'approved');
  return (await listSettlements(pool, w.finance)).find((s) => s.instance_id === r.instanceId)!;
}

test('EXP-04: a foreign-currency claim keeps the rate it was submitted at', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine, 'NGN');
    await updateExpenseSettings(pool, w.owner, { autoApproveLimit: 10000, managerLimit: 500000, lineLimit: 200000 });

    // No rate on file: refused, with the reason.
    const none = await engine.submit({ version: w.claim, answers: claimAnswers(w, [50], { claim_currency: 'usd' }), now });
    assert.deepEqual(none.rejected, ['claim_currency']);
    assert.match(none.problems![0]!, /no USD to NGN exchange rate/);
    await assert.rejects(addRate(pool, w.finance, { from: 'USD', rate: 1500, source: 'x' }), /administer/);
    await assert.rejects(addRate(pool, w.owner, { from: 'NGN', rate: 1, source: 'x' }), /workspace currency/);
    await addRate(pool, w.owner, { from: 'USD', rate: 1500, source: 'CBN official, 1 Oct', effectiveFrom: '2026-10-01T00:00:00Z' });

    // 50 USD = 75,000 NGN. Limits in NGN are converted into USD for routing:
    // 10,000 NGN auto-approve is 6.67 USD, so this goes to the manager.
    const r = await engine.submit({ version: w.claim, answers: claimAnswers(w, [30, 20], { claim_currency: 'usd' }), now });
    assert.ok(r.instanceId);
    const data = (await pool.query<{ data: Record<string, unknown> }>('select data from instance where id = $1', [r.instanceId])).rows[0]!.data;
    assert.equal(data.claim_currency, 'USD');
    assert.equal(data.fx_rate, 1500);
    assert.equal(data.approval_amount_base, 75000);
    assert.equal(data.policy_auto_approve_limit, 6.67);

    // The rate changes before approval; the claim keeps 1,500 (acceptance scenario 1).
    await addRate(pool, w.owner, { from: 'USD', rate: 1700, source: 'CBN official, 15 Oct', effectiveFrom: '2026-10-15T00:00:00Z' });
    await waitFor(engine, pool, w, r.instanceId, 'manager_approval');
    await engine.decide({ instanceId: r.instanceId, approvalKey: 'manager_approval', decision: 'approved', reason: 'ok', principal: w.manager, now });
    const s = (await listSettlements(pool, w.finance)).find((x) => x.instance_id === r.instanceId)!;
    assert.equal(Number(s.amount), 75000);
    assert.equal(s.currency, 'NGN');
    assert.equal(s.original_currency, 'USD');
    assert.equal(Number(s.original_amount), 50);
    assert.equal(Number(s.fx_rate), 1500);

    // A claim in the workspace currency needs no rate.
    const local = await engine.submit({ version: w.claim, answers: claimAnswers(w, [5000]), now });
    assert.ok(local.instanceId);
  } finally { await pool.end(); }
});

test('EXP-05: an enforced budget cannot be overspent, even by two claims at once', { skip: !localDatabase }, async () => {
  const pool = createPool(6);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    await updateExpenseSettings(pool, w.owner, { autoApproveLimit: 0, managerLimit: 5000, lineLimit: 5000 });
    await saveBudget(pool, w.owner, { costCentre: 'ops', periodStart: '2026-10-01', periodEnd: '2026-12-31', amount: 1000, mode: 'enforced' });
    await assert.rejects(saveBudget(pool, w.owner, { costCentre: 'ops', periodStart: '2026-11-01', periodEnd: '2026-11-30', amount: 1, mode: 'advisory' }), /already covers/);

    // Two 600 claims at the same moment: exactly one gets the budget.
    const both = await Promise.all([
      engine.submit({ version: w.claim, answers: claimAnswers(w, [600]), now }),
      engine.submit({ version: w.claim, answers: claimAnswers(w, [600]), now }),
    ]);
    const won = both.filter((r) => r.instanceId);
    const lost = both.filter((r) => !r.instanceId);
    assert.equal(won.length, 1, JSON.stringify(both));
    assert.equal(lost.length, 1);
    assert.deepEqual(lost[0]!.rejected, ['cost_centre']);
    assert.match(lost[0]!.problems![0]!, /ops budget has 400\.00 left/);
    let [b] = await listBudgets(pool, w.finance);
    assert.equal(Number(b.reserved), 600);
    assert.equal(b.available, 400);

    // The manager rejects it: the hold is released and the money is free again.
    await waitFor(engine, pool, w, won[0]!.instanceId, 'manager_approval');
    await engine.decide({ instanceId: won[0]!.instanceId, approvalKey: 'manager_approval', decision: 'rejected', reason: 'no', principal: w.manager, now });
    [b] = await listBudgets(pool, w.finance);
    assert.equal(b.available, 1000);

    // Approved: consumed. A claim in another cost centre is not touched.
    const s = await approvedClaim(engine, pool, w, claimAnswers(w, [700]));
    [b] = await listBudgets(pool, w.finance);
    assert.equal(Number(b.consumed), 700);
    assert.ok((await engine.submit({ version: w.claim, answers: claimAnswers(w, [900], { cost_centre: 'eng' }), now })).instanceId);

    // Voiding gives it back.
    await moveSettlement(pool, w.finance, s.id, { to: 'void', note: 'duplicate of a payroll claim' });
    [b] = await listBudgets(pool, w.finance);
    assert.equal(Number(b.consumed), 0);

    // Advisory: allowed, but the record says it went over.
    await saveBudget(pool, w.owner, { costCentre: 'sales', periodStart: '2026-10-01', periodEnd: '2026-12-31', amount: 100, mode: 'advisory' });
    const over = await engine.submit({ version: w.claim, answers: claimAnswers(w, [250], { cost_centre: 'sales' }), now });
    assert.ok(over.instanceId);
    assert.ok((await engine.events(over.instanceId)).some((e) => e.type === 'budget_warning'));
  } finally { await pool.end(); }
});

test('EXP-07: Finance approves, cuts or rejects single lines; the submitted claim never changes', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    await updateExpenseSettings(pool, w.owner, { autoApproveLimit: 0, managerLimit: 5000, lineLimit: 5000 });
    await saveBudget(pool, w.owner, { costCentre: 'ops', periodStart: '2026-10-01', periodEnd: '2026-12-31', amount: 10000, mode: 'advisory' });
    const s = await approvedClaim(engine, pool, w, claimAnswers(w, [['Taxi', 100], ['Hotel', 200], ['Minibar', 300]]));
    assert.equal(Number(s.amount), 600);

    await assert.rejects(reviewLines(pool, w.finance, s.id, { lines: [{ index: 1, approved: 150 }] }), /give a reason/);
    await assert.rejects(reviewLines(pool, w.finance, s.id, { lines: [{ index: 1, approved: 250, reason: 'x' }] }), /between 0 and 200/);
    await assert.rejects(reviewLines(pool, w.finance, s.id, { lines: [{ index: 7, approved: 0, reason: 'x' }] }), /does not exist/);
    const done = await reviewLines(pool, w.finance, s.id, { lines: [
      { index: 1, approved: 150, reason: 'Policy rate for a hotel night is 150' },
      { index: 2, approved: 0, reason: 'Minibar is not claimable' },
    ] });
    assert.equal(done.amount, 250);
    const after = (await listSettlements(pool, w.finance)).find((x) => x.id === s.id)!;
    assert.equal(Number(after.requested_amount), 600, 'what was claimed is kept');
    assert.equal(Number(after.approved_amount), 250);
    const lines = await settlementLines(pool, w.finance, s.id);
    assert.deepEqual(lines.lines.map((l) => [l.description, l.requested, l.approved, l.status]),
      [['Taxi', 100, 100, 'pending'], ['Hotel', 200, 150, 'reduced'], ['Minibar', 300, 0, 'rejected']]);
    const data = (await pool.query<{ data: { line_items: { line_amount: number }[] } }>('select data from instance where id = $1', [s.instance_id])).rows[0]!.data;
    assert.deepEqual(data.line_items.map((l) => l.line_amount), [100, 200, 300], 'the claim as submitted is untouched');
    const [b] = await listBudgets(pool, w.finance);
    assert.equal(Number(b.consumed), 250, 'the budget follows the approved amount');

    // The claimant cannot review their own claim; nobody can after payment.
    await assert.rejects(reviewLines(pool, w.staff, s.id, { lines: [{ index: 0 }] }), /operate|own claim/);
    await saveBeneficiary(pool, w.staff, { accountName: 'Sam Staff', bankName: 'GTBank', accountNumber: '0123456789' });
    await verifyBeneficiary(pool, w.finance, s.id);
    await moveSettlement(pool, w.finance, s.id, { to: 'paid', reference: 'PAY-1' });
    await assert.rejects(reviewLines(pool, w.finance, s.id, { lines: [{ index: 0, approved: 0, reason: 'x' }] }), /before the claim is paid/);

    // Rejecting every line voids it and frees the budget.
    const s2 = await approvedClaim(engine, pool, w, claimAnswers(w, [['Gift', 80]]));
    const all = await reviewLines(pool, w.finance, s2.id, { lines: [{ index: 0, approved: 0, reason: 'Gifts are not claimable' }] });
    assert.equal(all.status, 'void');

    // Cutting a claim set against an advance puts the difference back on the advance.
    const adv = await engine.submit({ version: w.advance, now, answers: { claimant_name: 'Sam Staff', employee_email: w.staffEmail, needed_by: '2026-11-20', cost_centre: 'ops', purpose: 'Field trip: fuel, lodging and meals.', advance_amount: 500 } });
    await waitFor(engine, pool, w, adv.instanceId, 'manager_approval');
    await engine.decide({ instanceId: adv.instanceId, approvalKey: 'manager_approval', decision: 'approved', reason: 'ok', principal: w.manager, now });
    const a = (await listAdvances(pool, w.finance)).find((x) => x.instance_id === adv.instanceId)!;
    await disburseAdvance(pool, w.finance, a.id, { reference: 'TRF-9' });
    const s3 = await approvedClaim(engine, pool, w, claimAnswers(w, [['Fuel', 300], ['Lodging', 300]], { advance_reference: a.reference }));
    assert.equal(Number(s3.amount), 100);
    const cut = await reviewLines(pool, w.finance, s3.id, { lines: [{ index: 1, approved: 0, reason: 'Stayed with family' }] });
    assert.equal(cut.amount, 0);
    assert.equal(cut.status, 'paid', 'fully covered by the advance');
    const a2 = (await listAdvances(pool, w.finance)).find((x) => x.id === a.id)!;
    assert.equal(Number(a2.outstanding), 200);
    assert.equal(a2.status, 'awaiting_return');
  } finally { await pool.end(); }
});

test('EXP-09: bank details are sealed, masked, checked before payment, and re-checked after a change', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    await updateExpenseSettings(pool, w.owner, { autoApproveLimit: 1000 });
    const s = await approvedClaim(engine, pool, w, claimAnswers(w, [120]));

    await assert.rejects(saveBeneficiary(pool, w.staff, { accountName: 'Sam', bankName: 'GTB', accountNumber: '12' }), /6 to 34/);
    const saved = await saveBeneficiary(pool, w.staff, { accountName: 'Sam Staff', bankName: 'GTBank', bankCode: '058', accountNumber: '0123 456 789' });
    assert.equal(saved.account, '•••• 6789');
    assert.equal((await myBeneficiary(pool, w.staff))!.account, '•••• 6789');
    const raw = (await pool.query<{ account_sealed: string }>('select account_sealed from expense_beneficiary where tenant_id = $1', [w.tenantId])).rows[0]!;
    assert.ok(!raw.account_sealed.includes('0123456789'), 'the number is not stored in the clear');
    // Someone else cannot set your details without administer.
    const otherId = await engine.createActor(w.tenantId, `other-${stamp()}@fin.test`, 'Other', 'read_only');
    await assert.rejects(saveBeneficiary(pool, { kind: 'actor', tenantId: w.tenantId, actorId: otherId }, { holder: w.staffEmail, accountName: 'Thief', bankName: 'X', accountNumber: '99999999' }), /administer/);

    // Finance checks, and sees the number only through the audited reveal.
    const shown = await revealBeneficiary(pool, w.finance, s.id);
    assert.equal(shown.accountNumber, '0123456789');
    assert.ok((await workspaceAudit(pool, w.owner)).some((r: { action: string }) => r.action === 'beneficiary.revealed'));
    const listed = (await listSettlements(pool, w.finance)).find((x) => x.id === s.id)!;
    assert.equal(listed.bank_last4, '6789');
    assert.ok(!JSON.stringify(listed).includes('0123456789'), 'lists never carry the number');
    await verifyBeneficiary(pool, w.finance, s.id);

    // Changed after the check: payment is refused until checked again (acceptance scenario 4).
    await saveBeneficiary(pool, w.staff, { accountName: 'Sam Staff', bankName: 'Access Bank', accountNumber: '9876543210' });
    const changed = (await listSettlements(pool, w.finance)).find((x) => x.id === s.id)!;
    assert.equal(changed.bank_changed, true);
    assert.equal(changed.bank_verified, false);
    assert.ok((await engine.events(s.instance_id)).some((e) => e.type === 'beneficiary_changed'));
    await assert.rejects(moveSettlement(pool, w.finance, s.id, { to: 'paid', reference: 'PAY-2' }), /changed after they were checked/);
    await verifyBeneficiary(pool, w.finance, s.id);
    await moveSettlement(pool, w.finance, s.id, { to: 'paid', reference: 'PAY-2' });
    // The approval history is untouched by any of this.
    assert.ok((await engine.events(s.instance_id)).some((e) => e.type === 'settlement_opened'));
  } finally { await pool.end(); }
});

test('EXP-10: paid claims export once, in a numbered batch, with account codes and safe cells', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    await updateExpenseSettings(pool, w.owner, { autoApproveLimit: 1000, accountCodes: { travel: '6100-TRV' }, defaultAccountCode: '6999' });
    await addRate(pool, w.owner, { from: 'USD', rate: 1.5, source: 'test', effectiveFrom: '2026-01-01T00:00:00Z' });
    await saveBeneficiary(pool, w.staff, { accountName: 'Sam Staff', bankName: 'GTBank', accountNumber: '0123456789' });
    const pay = async (s: { id: string }, ref: string) => { await verifyBeneficiary(pool, w.finance, s.id); await moveSettlement(pool, w.finance, s.id, { to: 'paid', reference: ref }); };

    await assert.rejects(exportPaid(pool, w.finance, {}), /no paid claims/);
    const a = await approvedClaim(engine, pool, w, claimAnswers(w, [['=HYPERLINK("http://evil")', 40], ['Lunch', 20]]));
    const b = await approvedClaim(engine, pool, w, claimAnswers(w, [33.33, 33.33, 33.34], { claim_currency: 'USD', category: 'training' }));
    await pay(a, 'PAY-A'); await pay(b, 'PAY-B');
    // Approved but unpaid claims are not exported.
    await approvedClaim(engine, pool, w, claimAnswers(w, [10]));

    const out = await exportPaid(pool, w.finance, { from: '2026-01-01' });
    assert.equal(out.batchNo, 1);
    assert.equal(out.claims, 2);
    assert.equal(out.rows, 5);
    assert.equal(out.total, 210, '60 GBP plus 100 USD at 1.5');
    const lines = out.csv.trim().split('\r\n');
    assert.match(lines[0]!, /Account code/);
    assert.ok(out.csv.includes(`"'=HYPERLINK`), 'a formula is defused');
    assert.ok(out.csv.includes('"6100-TRV"') && out.csv.includes('"6999"'), 'category codes and the default are used');
    assert.ok(!out.csv.includes('0123456789'), 'bank details are never exported');
    // The USD claim's rows add up to exactly what was approved: 49.99 + 49.99 + 50.02.
    const usd = lines.filter((l) => l.includes('"USD"')).map((l) => Number(l.split(',')[13]));
    assert.equal(Math.round(usd.reduce((x, y) => x + y, 0) * 100) / 100, 150);

    // Exported once: a second run finds nothing; a new payment goes in batch 2.
    await assert.rejects(exportPaid(pool, w.finance, {}), /no paid claims/);
    const listed = (await listSettlements(pool, w.finance, 'paid')).find((x) => x.id === a.id)!;
    assert.equal(listed.export_batch, 1);
  } finally { await pool.end(); }
});
