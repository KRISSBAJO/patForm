import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { validate } from '../src/compiler/validate.js';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { setManager } from '../src/runtime/org.js';
import { listSettlements, saveBeneficiary, verifyBeneficiary } from '../src/runtime/expenses.js';
import { saveBranch, setEmployeeBranch } from '../src/runtime/hr-records.js';
import { allowance, cancelPaymentRun, createPaymentRun, expenseReport, listCategories, listRateCards, paymentRun, paymentRunBankFile, saveCategory, saveRateCard, searchAdvances, searchClaims, searchMyClaims, searchPaymentRuns, settlePaymentRun } from '../src/runtime/expenses-depth.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const claimBp = () => Blueprint.parse(JSON.parse(readFileSync('processes/staff-expense-claim.blueprint.json', 'utf8')));
const q = (s: string) => new URLSearchParams(s);
const now = new Date('2026-10-19T09:00:00Z');

test('the claim form with its note field still compiles clean', () => {
  const d = validate(claimBp());
  assert.equal(d.errors.length, 0, JSON.stringify(d.errors));
});

async function workspace(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`exp-depth-${stamp()}`, { scenario: true });
  const mk = async (name: string, role: 'owner' | 'operator' | 'approver' | 'read_only', email = `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@ex.test`) => { const id = await engine.createActor(tenantId, email, name, role); await pool.query('update actor set email_verified_at = now() where id = $1', [id]); return { id, email, p: { kind: 'actor', tenantId, actorId: id } as Principal }; };
  const owner = await mk('Owner', 'owner'); const finance = await mk('Fola Finance', 'operator'); const manager = await mk('Mo Manager', 'approver'); const sam = await mk('Sam Staff', 'read_only'); const pat = await mk('Pat Peer', 'read_only');
  await setModule(pool, owner.p, 'expenses', { enabled: true });
  await setModule(pool, owner.p, 'hr', { enabled: true });
  for (const s of [sam, pat]) await setManager(pool, owner.p, s.id, { managerId: manager.id, effectiveFrom: '2026-01-01T00:00:00Z' });
  const claim = await engine.publish(tenantId, claimBp(), 'test');
  await engine.grant({ tenantId, actorId: manager.id, processKey: 'staff_expense_claim', roleKey: 'line_manager' });
  await engine.grant({ tenantId, actorId: finance.id, processKey: 'staff_expense_claim', roleKey: 'finance_approver' });
  return { tenantId, owner, finance, manager, sam, pat, claim };
}
let n = 0;
const answers = (email: string, name: string, lines: number[], extra: Record<string, unknown> = {}) => ({
  claimant_name: name, employee_email: email, expense_date: `2026-09-${String(10 + (++n % 18)).padStart(2, '0')}`, cost_centre: ['eng', 'sales'][n % 2], category: 'travel',
  business_purpose: 'Client visit, taxis and lunch.', line_items: lines.map((amount, i) => ({ line_description: `Item ${i + 1}`, line_amount: amount })), receipt_reference: 'Scanned', ...extra,
});

test('categories carry their own caps; rate cards follow the branch; claims and advances list by page; a payment run pays many claims under one reference', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    // Categories start from the settings list; an admin caps entertainment and makes it need a receipt.
    const cats = await listCategories(pool, w.finance.p);
    assert.ok(cats.categories.some((c: { key: string }) => c.key === 'travel'));
    assert.equal(cats.canEdit, false);
    await assert.rejects(saveCategory(pool, w.finance.p, { name: 'Entertainment' }), /owner or admin/);
    await saveCategory(pool, w.owner.p, { name: 'Entertainment', accountCode: '6400' });
    await saveCategory(pool, w.owner.p, { key: 'travel', name: 'Travel', accountCode: '6100', maxPerLine: 40, maxPerClaim: 80, receiptRequired: true });
    assert.ok((await listCategories(pool, w.finance.p)).categories.some((c: { key: string }) => c.key === 'entertainment'));
    // The claim form sees the new category and its rules.
    const ok = await engine.submit({ version: w.claim, answers: answers(w.sam.email, 'Sam Staff', [30, 30]), now });
    assert.ok(ok.instanceId, JSON.stringify(ok));
    assert.deepEqual((await engine.submit({ version: w.claim, answers: answers(w.sam.email, 'Sam Staff', [45]), now })).rejected, ['line_items'], 'one item over the cap');
    assert.deepEqual((await engine.submit({ version: w.claim, answers: answers(w.sam.email, 'Sam Staff', [30, 30, 30]), now })).rejected, ['expense_total'], 'the claim over the cap');
    assert.ok((await engine.submit({ version: w.claim, answers: answers(w.sam.email, 'Sam Staff', [20], { receipt_reference: '' }), now })).rejected.includes('receipt_reference'), 'no receipt');

    // Rate cards: a Lagos per diem, a country-wide Nigeria one, a global mileage rate. Sam is in Lagos.
    const lagos = await saveBranch(pool, w.owner.p, { name: 'Lagos', country: 'NG', currency: 'NGN' });
    const { rows: emp } = await pool.query<{ id: string }>(`insert into employee_record (tenant_id, actor_id, email, name, status) select $1, id, email, display_name, 'active' from actor where id = $2 returning id`, [w.tenantId, w.sam.id]);
    await setEmployeeBranch(pool, w.owner.p, emp[0]!.id, { branchId: lagos.id });
    await saveRateCard(pool, w.owner.p, { kind: 'per_diem', label: 'Lagos per diem', branchId: lagos.id, rate: 35000, currency: 'NGN', unit: 'day' });
    await saveRateCard(pool, w.owner.p, { kind: 'per_diem', label: 'Nigeria per diem', country: 'NG', rate: 25000, currency: 'NGN', unit: 'day' });
    await saveRateCard(pool, w.owner.p, { kind: 'mileage', label: 'Own car', rate: 0.45, currency: 'GBP', unit: 'mile' });
    await assert.rejects(saveRateCard(pool, w.owner.p, { kind: 'mileage', label: 'x', rate: 1, unit: 'day' }), /km or mile/);
    assert.equal((await listRateCards(pool, w.sam.p)).cards.length, 3);
    const sam3 = await allowance(pool, w.sam.p, q('kind=per_diem&quantity=3'));
    assert.equal(sam3.amount, 105000, 'the branch rate wins');
    assert.equal(sam3.card!.label, 'Lagos per diem');
    const pat2 = await allowance(pool, w.pat.p, q('kind=per_diem&quantity=2'));
    assert.equal(pat2.card, null, 'Pat has no branch, and no global per diem exists');
    assert.equal((await allowance(pool, w.pat.p, q('kind=mileage&quantity=120'))).amount, 54);

    // Three more claims (auto-approved under the default limit), bank details for Sam only.
    for (const amt of [64.5, 80, 20]) await engine.submit({ version: w.claim, answers: answers(w.sam.email, 'Sam Staff', [amt], { category: 'subsistence' }), now });
    await engine.submit({ version: w.claim, answers: answers(w.pat.email, 'Pat Peer', [50], { category: 'subsistence' }), now });
    const owed = await listSettlements(pool, w.finance.p);
    assert.equal(owed.length, 5);
    await saveBeneficiary(pool, w.sam.p, { accountName: 'Sam Staff', bankName: 'First Bank', accountNumber: '0123456789' });
    for (const s of owed.filter((x) => x.claimant === w.sam.email)) await verifyBeneficiary(pool, w.finance.p, s.id);
    // Claims list: pages, facets, filters on bank state and amount.
    const page = await searchClaims(pool, w.finance.p, q('size=2&sort=amount:desc'));
    assert.equal(page.total, 5); assert.equal(page.rows.length, 2); assert.equal(Number(page.rows[0]!.amount), 80);
    assert.equal((await searchClaims(pool, w.finance.p, q('bank_checked=true'))).total, 4);
    assert.equal((await searchClaims(pool, w.finance.p, q('amount_min=60'))).total, 3);
    assert.equal((await searchClaims(pool, w.finance.p, q('category=travel'))).total, 1);
    assert.ok((page as { facets: { kind: string; name: string; n: number }[] }).facets.some((f) => f.kind === 'cost_centre'));
    await assert.rejects(searchClaims(pool, w.sam.p, q('')), /only Finance/);
    // My claims: Sam sees four, Pat one; each with its payment state.
    const mine = await searchMyClaims(pool, w.sam.p, q(''));
    assert.equal(mine.total, 4); assert.ok(mine.rows.every((r) => r.settlement_status === 'awaiting_payment'));
    assert.equal((await searchMyClaims(pool, w.pat.p, q(''))).total, 1);
    assert.equal((await searchAdvances(pool, w.finance.p, q(''))).total, 0);

    // A payment run takes what is ready: Sam's four, not Pat's unchecked one.
    await assert.rejects(createPaymentRun(pool, w.sam.p, { settlementIds: 'all' }), /only Finance/);
    const run = await createPaymentRun(pool, w.finance.p, { settlementIds: 'all', note: 'October run' });
    assert.equal(run.count, 4); assert.equal(run.skipped, 1); assert.equal(run.total, 224.5);
    const detail = await paymentRun(pool, w.finance.p, run.id) as { status: string; items: { claimant_name: string; account_last4: string }[] };
    assert.equal(detail.status, 'draft'); assert.equal(detail.items.length, 4); assert.equal(detail.items[0]!.account_last4, '6789');
    await assert.rejects(paymentRunBankFile(pool, w.finance.p, run.id), /owner or admin/);
    const file = await paymentRunBankFile(pool, w.owner.p, run.id);
    assert.equal(file.lines, 4); assert.match(file.csv, /0123456789/); assert.match(file.csv, /^Payee,Account name,Bank/);
    // A second run finds nothing: those claims are already in a run.
    await assert.rejects(createPaymentRun(pool, w.finance.p, { settlementIds: 'all' }), /nothing ready|skipped/);
    // Cancel releases them; create again and pay the run under one reference.
    await cancelPaymentRun(pool, w.finance.p, run.id);
    const run2 = await createPaymentRun(pool, w.finance.p, { settlementIds: 'all' });
    assert.equal(run2.runNo, 2);
    await assert.rejects(settlePaymentRun(pool, w.finance.p, run2.id, {}), /bank reference/);
    const paid = await settlePaymentRun(pool, w.finance.p, run2.id, { reference: 'BANK-2026-10-A' });
    assert.equal(paid.paid, 4);
    const after = await searchClaims(pool, w.finance.p, q('status=paid'));
    assert.equal(after.total, 4); assert.ok(after.rows.every((r) => r.reference === 'BANK-2026-10-A' && r.run_no === 2));
    const runs = await searchPaymentRuns(pool, w.finance.p, q(''));
    assert.equal(runs.total, 2); assert.deepEqual(runs.rows.map((r) => r.status), ['paid', 'cancelled']);
    await assert.rejects(cancelPaymentRun(pool, w.finance.p, run2.id), /only a draft/);

    // The report adds it up by month, category, cost centre and claimant.
    const report = await expenseReport(pool, w.finance.p, q('from=2026-01-01&to=2026-12-31'));
    assert.equal(report.totals.claims, 5); assert.equal(report.totals.paid, 224.5);
    assert.ok(report.byCategory.some((c) => c.key === 'travel' && c.total === 60));
    assert.equal(report.byClaimant[0]!.key, 'Sam Staff');
    assert.ok(report.byMonth.length >= 1);
    const csv = await searchClaims(pool, w.finance.p, q('format=csv&status=paid')) as { csv: string; rows: number };
    assert.equal(csv.rows, 4); assert.match(csv.csv, /BANK-2026-10-A/);
  } finally { await pool.end(); }
});
