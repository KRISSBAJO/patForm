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
import { listBudgets, saveBudget } from '../src/runtime/expenses.js';
import {
  addQuote, approveOrder, cancelOrder, createAgreement, createOrder, createVendor, enterInvoice, exportInvoices, listAgreements, listInvoices,
  listOrders, listQuotes, listRequisitions, listVendors, openQuotes, orderDetail, payInvoice, procurementSummary, receiveGoods, returnGoods,
  revealVendorBank, reviewInvoice, reviseOrder, saveVendorBank, selectQuote, setQuoteDeadline, setVendorStatus, updateProcurementSettings,
  updateVendor, verifyVendorBank,
} from '../src/runtime/procurement.js';
import type { Principal } from '../src/runtime/policy.js';

// PRD Module 6 and its four acceptance scenarios, plus JRN-02: purchase through settlement.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prBp = () => Blueprint.parse(JSON.parse(readFileSync('processes/purchase-request.blueprint.json', 'utf8')));
const now = new Date('2026-10-19T09:00:00Z');

test('the purchase request compiles clean and passes its own scenarios', { skip: !localDatabase }, async () => {
  const d = validate(prBp());
  assert.equal(d.errors.length, 0, JSON.stringify(d.errors));
  assert.equal(d.warnings.length, 0, JSON.stringify(d.warnings));
  const pool = createPool(3);
  try {
    const results = await runScenarios(pool, prBp());
    assert.ok(results.every((r) => r.passed), JSON.stringify(results.filter((r) => !r.passed)));
  } finally { await pool.end(); }
});

async function workspace(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`proc-${stamp()}`, { scenario: true });
  const mk = async (name: string, role: 'owner' | 'admin' | 'operator' | 'approver' | 'read_only') => {
    const id = await engine.createActor(tenantId, `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@proc.test`, name, role);
    return { id, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner');
  const admin = await mk('Ada Admin', 'admin');
  const buyer = await mk('Bola Buyer', 'operator');
  const buyer2 = await mk('Kemi Clerk', 'operator');
  const manager = await mk('Mo Manager', 'approver');
  const staff = await mk('Sam Staff', 'read_only');
  await setManager(pool, owner.p, staff.id, { managerId: manager.id, effectiveFrom: '2026-01-01T00:00:00Z' });
  await setModule(pool, owner.p, 'procurement', { enabled: true });
  const version = await engine.publish(tenantId, prBp(), 'test');
  await engine.grant({ tenantId, actorId: manager.id, processKey: 'purchase_request', roleKey: 'line_manager' });
  await engine.grant({ tenantId, actorId: admin.id, processKey: 'purchase_request', roleKey: 'procurement_approver' });
  const staffEmail = (await engine.actor(staff.id))!.email;
  return { tenantId, owner, admin, buyer, buyer2, manager, staff, staffEmail, version };
}
type W = Awaited<ReturnType<typeof workspace>>;

let d = 0;
async function approvedRequest(engine: Engine, pool: Pool, w: W, lines: [string, number, number][], cc = 'ops') {
  d += 1;
  const r = await engine.submit({ version: w.version, now, answers: {
    requester_name: 'Sam Staff', employee_email: w.staffEmail, title: `Request ${d}`, cost_centre: cc, needed_by: '2026-12-01',
    delivery_location: 'Lagos office', purpose: 'Equipment for the new field officers starting next month.',
    line_items: lines.map(([item_description, quantity, estimated_cost]) => ({ item_description, quantity, estimated_cost })),
  } });
  assert.ok(r.instanceId, JSON.stringify(r));
  for (let i = 0; i < 40; i++) {
    await engine.drain(now, 'test', w.tenantId);
    const { rows } = await pool.query("select 1 from approval_request where instance_id = $1 and status = 'pending'", [r.instanceId]);
    if (rows[0]) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  await engine.decide({ instanceId: r.instanceId, approvalKey: 'manager_approval', decision: 'approved', reason: 'ok', principal: w.manager.p, now });
  const state = (await pool.query<{ state: string }>('select state from instance where id = $1', [r.instanceId])).rows[0]!.state;
  if (state === 'procurement_review') {
    for (let i = 0; i < 40; i++) {
      await engine.drain(now, 'test', w.tenantId);
      const { rows } = await pool.query("select 1 from approval_request where instance_id = $1 and approval_key = 'procurement_approval' and status = 'pending'", [r.instanceId]);
      if (rows[0]) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    await engine.decide({ instanceId: r.instanceId, approvalKey: 'procurement_approval', decision: 'approved', reason: 'ok', principal: w.admin.p, now });
  }
  return (await listRequisitions(pool, w.buyer.p)).find((x) => x.instance_id === r.instanceId)!;
}

/** A supplier added by the buyer, approved by the admin, with bank details checked by a second buyer. */
async function approvedVendor(pool: Pool, w: W, name: string) {
  const v = await createVendor(pool, w.buyer.p, { name, taxId: `TIN-${stamp()}`, contactEmail: 'sales@supplier.test', categories: ['IT'] });
  await setVendorStatus(pool, w.buyer.p, v.id, { to: 'under_review' });
  await setVendorStatus(pool, w.admin.p, v.id, { to: 'approved' });
  await saveVendorBank(pool, w.buyer.p, v.id, { accountName: name, bankName: 'Zenith', accountNumber: '1029384756' });
  await verifyVendorBank(pool, w.buyer2.p, v.id);
  return v.id;
}

test('suppliers: separate approval and bank checks; suspended suppliers need an exception (acceptance 3 and 4)', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    const v = await createVendor(pool, w.buyer.p, { name: 'Acme Supplies', taxId: 'TIN-1' });
    await assert.rejects(createVendor(pool, w.buyer.p, { name: 'acme supplies' }), /already a supplier/);
    // Not orderable until approved; approval needs an admin who did not add it.
    await assert.rejects(createOrder(pool, w.admin.p, { vendorId: v.id, lines: [{ description: 'x', quantity: 1, unitPrice: 1 }] }), /not approved yet/);
    await setVendorStatus(pool, w.buyer.p, v.id, { to: 'under_review' });
    await assert.rejects(setVendorStatus(pool, w.buyer.p, v.id, { to: 'approved' }), /owner or admin/);
    const selfAdded = await createVendor(pool, w.admin.p, { name: 'Admin Added Ltd' });
    await setVendorStatus(pool, w.admin.p, selfAdded.id, { to: 'under_review' });
    await assert.rejects(setVendorStatus(pool, w.admin.p, selfAdded.id, { to: 'approved' }), /other than the person who added/);
    await setVendorStatus(pool, w.admin.p, v.id, { to: 'approved' });

    // Bank details: whoever entered them cannot check them (acceptance 4).
    await saveVendorBank(pool, w.buyer.p, v.id, { accountName: 'Acme', bankName: 'Zenith', accountNumber: '1029384756' });
    await assert.rejects(verifyVendorBank(pool, w.buyer.p, v.id), /other than the person who entered/);
    await verifyVendorBank(pool, w.buyer2.p, v.id);
    assert.equal((await listVendors(pool, w.buyer.p)).find((x) => x.id === v.id)!.bank_verified, true);
    assert.equal((await revealVendorBank(pool, w.buyer.p, v.id)).accountNumber, '1029384756');
    // A change un-checks them.
    await saveVendorBank(pool, w.buyer2.p, v.id, { accountName: 'Acme', bankName: 'GTBank', accountNumber: '5566778899' });
    assert.equal((await listVendors(pool, w.buyer.p)).find((x) => x.id === v.id)!.bank_verified, false);
    await verifyVendorBank(pool, w.buyer.p, v.id);

    // Changing the legal identity of an approved supplier sends it back for review.
    assert.equal((await updateVendor(pool, w.buyer.p, v.id, { taxId: 'TIN-2' })).status, 'under_review');
    await setVendorStatus(pool, w.admin.p, v.id, { to: 'approved' });

    // Suspended: no order without an admin's exception reason (acceptance 3).
    await assert.rejects(setVendorStatus(pool, w.admin.p, v.id, { to: 'suspended' }), /give a reason/);
    await setVendorStatus(pool, w.admin.p, v.id, { to: 'suspended', reason: 'Late deliveries under investigation' });
    const line = [{ description: 'Toner', quantity: 2, unitPrice: 50 }];
    await assert.rejects(createOrder(pool, w.admin.p, { vendorId: v.id, lines: line }), /suspended \(Late deliveries/);
    const req = await approvedRequest(engine, pool, w, [['Toner', 2, 100]]);
    await assert.rejects(createOrder(pool, w.buyer.p, { vendorId: v.id, requisitionId: req.id, lines: line, exceptionReason: 'only stockist' }), /only an owner or admin/);
    const o = await createOrder(pool, w.admin.p, { vendorId: v.id, requisitionId: req.id, lines: line, exceptionReason: 'Only stockist in Lagos this week' });
    assert.equal(o.status, 'issued');
    assert.ok((await listOrders(pool, w.buyer.p)).find((x) => x.id === o.id)!.exception_reason);
  } finally { await pool.end(); }
});

test('JRN-02: request, sealed quotes, order, partial delivery, invoice matching and payment (acceptance 1 and 2)', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    await updateProcurementSettings(pool, w.admin.p, { managerLimit: 5000, priceTolerancePct: 2, quotesRequired: 2, quotesRequiredOver: 1000, orderIncreasePct: 10 });
    await saveBudget(pool, w.admin.p, { costCentre: 'ops', periodStart: '2026-01-01', periodEnd: '2026-12-31', amount: 10000, mode: 'enforced' });
    const a = await approvedVendor(pool, w, 'Alpha Tech');
    const b = await approvedVendor(pool, w, 'Beta Tech');

    // 1. Request for 3 laptops at about 1,400: needs manager and procurement (over 5,000? no — 4,200 is within).
    const req = await approvedRequest(engine, pool, w, [['Laptop 16GB', 3, 4200]]);
    assert.equal(req.status, 'approved');
    assert.equal(Number(req.amount), 4200);
    assert.equal(Number((await listBudgets(pool, w.buyer.p))[0].consumed), 4200, 'the budget is held from approval');

    // 2. Sealed quotes: amounts hidden until opened after the deadline.
    const opens = new Date(Date.now() + 2000);
    await setQuoteDeadline(pool, w.buyer.p, req.id, { opensAt: opens.toISOString() });
    await addQuote(pool, w.buyer.p, req.id, { vendorId: a, amount: 4100, leadDays: 5 });
    await addQuote(pool, w.buyer.p, req.id, { vendorId: b, amount: 3900, leadDays: 12 });
    const hidden = await listQuotes(pool, w.buyer.p, req.id);
    assert.equal(hidden.sealed, true);
    assert.ok(hidden.quotes.every((q) => q.amount === null));
    await assert.rejects(openQuotes(pool, w.buyer.p, req.id), /cannot be opened before/);
    await assert.rejects(selectQuote(pool, w.buyer.p, req.id, { quoteId: hidden.quotes[0]!.id, reason: 'x' }), /open the sealed quotes/);
    await new Promise((res) => setTimeout(res, 2200));
    await assert.rejects(addQuote(pool, w.buyer.p, req.id, { vendorId: a, amount: 1 }), /deadline for quotes has passed/);
    await openQuotes(pool, w.buyer.p, req.id);
    const open = await listQuotes(pool, w.buyer.p, req.id);
    const alpha = open.quotes.find((q) => q.vendor_id === a)!;
    await assert.rejects(selectQuote(pool, w.buyer.p, req.id, { quoteId: alpha.id }), /say why/);
    await selectQuote(pool, w.buyer.p, req.id, { quoteId: alpha.id, reason: 'Five-day delivery; Beta cannot meet the start date' });
    // The requester's record says quotes arrived, never from whom or for how much.
    const ev = await pool.query<{ type: string; payload: unknown }>(`select type, payload from event where instance_id = $1 and type like 'quote%'`, [req.instance_id]);
    assert.ok(ev.rows.length > 0 && ev.rows.every((e) => JSON.stringify(e.payload) === '{}' || !JSON.stringify(e.payload).includes('4100')));

    // 3. The order must go to the chosen supplier.
    await assert.rejects(createOrder(pool, w.buyer.p, { requisitionId: req.id, vendorId: b, lines: [{ description: 'Laptop', quantity: 3, unitPrice: 1300 }] }), /chosen/);
    const o = await createOrder(pool, w.buyer.p, { requisitionId: req.id, vendorId: a, expectedBy: '2026-12-01', lines: [{ description: 'Laptop 16GB', quantity: 3, unitPrice: 1366.67 }] });
    assert.equal(o.status, 'issued');
    assert.equal(Number((await listBudgets(pool, w.buyer.p))[0].consumed), 4100.01, 'the hold follows the order');

    // 4. Partial delivery: 2 arrive, 1 of them damaged (acceptance 1).
    const [line] = (await orderDetail(pool, w.buyer.p, o.id)).lines;
    await assert.rejects(receiveGoods(pool, w.buyer.p, o.id, { lines: [{ lineId: line!.id, accepted: 4 }] }), /only 3 still to come/);
    await assert.rejects(receiveGoods(pool, w.buyer.p, o.id, { lines: [{ lineId: line!.id, accepted: 1, rejected: 1 }] }), /reason/);
    const got = await receiveGoods(pool, w.buyer.p, o.id, { lines: [{ lineId: line!.id, accepted: 1, rejected: 1, reason: 'Cracked screen' }], evidenceRef: 'GRN-001 photo' });
    assert.equal(got.status, 'partially_received');

    // 5. The supplier invoices all 3: held, with the reason (acceptance 2).
    const inv = await enterInvoice(pool, w.buyer.p, { orderId: o.id, invoiceNo: 'INV-77', invoiceDate: '2026-10-19', lines: [{ lineId: line!.id, quantity: 3, unitPrice: 1366.67 }] });
    assert.equal(inv.status, 'held');
    assert.match(inv.mismatches.join(' '), /invoiced 3, but only 1 accepted/);
    await assert.rejects(payInvoice(pool, w.buyer.p, inv.id, { reference: 'X' }), /held/);
    await assert.rejects(enterInvoice(pool, w.buyer.p, { orderId: o.id, invoiceNo: 'inv-77', invoiceDate: '2026-10-19', lines: [{ lineId: line!.id, quantity: 1, unitPrice: 1 }] }), /already been entered/);
    // Reviewed by someone who did not enter it: rejected; the supplier sends a correct one.
    await assert.rejects(reviewInvoice(pool, w.buyer.p, inv.id, { decision: 'reject', reason: 'x' }), /administer/);
    await reviewInvoice(pool, w.admin.p, inv.id, { decision: 'reject', reason: 'Only one laptop accepted so far' });
    // A price above the tolerance is held too.
    const pricey = await enterInvoice(pool, w.buyer.p, { orderId: o.id, invoiceNo: 'INV-78', invoiceDate: '2026-10-19', lines: [{ lineId: line!.id, quantity: 1, unitPrice: 1500 }] });
    assert.equal(pricey.status, 'held');
    assert.match(pricey.mismatches.join(' '), /above the order price/);
    await reviewInvoice(pool, w.admin.p, pricey.id, { decision: 'reject', reason: 'Price not agreed' });
    // Payment only for the accepted quantity at the order price: approved straight away.
    const good = await enterInvoice(pool, w.buyer.p, { orderId: o.id, invoiceNo: 'INV-79', invoiceDate: '2026-10-19', lines: [{ lineId: line!.id, quantity: 1, unitPrice: 1366.67 }] });
    assert.equal(good.status, 'approved');

    // 6. Paid against the checked bank details; a change after the check blocks payment.
    await saveVendorBank(pool, w.buyer.p, a, { accountName: 'Alpha Tech', bankName: 'Access', accountNumber: '9999888877' });
    await assert.rejects(payInvoice(pool, w.buyer.p, good.id, { reference: 'TRF-1' }), /changed or were never checked/);
    await verifyVendorBank(pool, w.buyer2.p, a);
    await payInvoice(pool, w.buyer.p, good.id, { reference: 'TRF-1' });
    const paid = (await listInvoices(pool, w.buyer.p)).find((x) => x.id === good.id)!;
    assert.equal(paid.status, 'paid');

    // 7. The rest arrives; it can then be invoiced and the order closes once paid.
    await receiveGoods(pool, w.buyer.p, o.id, { lines: [{ lineId: line!.id, accepted: 2 }] });
    const rest = await enterInvoice(pool, w.buyer.p, { orderId: o.id, invoiceNo: 'INV-80', invoiceDate: '2026-10-20', lines: [{ lineId: line!.id, quantity: 2, unitPrice: 1366.67 }] });
    assert.equal(rest.status, 'approved');
    await payInvoice(pool, w.buyer.p, rest.id, { reference: 'TRF-2' });
    assert.equal((await listOrders(pool, w.buyer.p)).find((x) => x.id === o.id)!.status, 'closed');

    // 8. Export: paid invoices once, with references, without bank details.
    const out = await exportInvoices(pool, w.buyer.p);
    assert.equal(out.invoices, 2);
    assert.ok(out.csv.includes('INV-79') && out.csv.includes('INV-80'));
    assert.ok(!out.csv.includes('9999888877') && !out.csv.includes('1029384756'));
    await assert.rejects(exportInvoices(pool, w.buyer.p), /no paid invoices/);

    const s = await procurementSummary(pool, w.buyer.p);
    assert.equal(s.invoicesHeld, 0);
  } finally { await pool.end(); }
});

test('revisions need re-approval past the tolerance; agreements cap orders; cancellation releases the budget', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    await updateProcurementSettings(pool, w.admin.p, { managerLimit: 100000, orderIncreasePct: 10 });
    await saveBudget(pool, w.admin.p, { costCentre: 'ops', periodStart: '2026-01-01', periodEnd: '2026-12-31', amount: 2000, mode: 'enforced' });
    const v = await approvedVendor(pool, w, 'Gamma Office');

    // Within 10% of the request: issued. A revision past it: back to approval, by someone else.
    const req = await approvedRequest(engine, pool, w, [['Chairs', 4, 1000]]);
    const o = await createOrder(pool, w.buyer.p, { requisitionId: req.id, vendorId: v, lines: [{ description: 'Chair', quantity: 4, unitPrice: 270 }] });
    assert.equal(o.status, 'issued', '1,080 is within 10% of 1,000');
    await assert.rejects(reviseOrder(pool, w.buyer.p, o.id, { lines: [{ description: 'Chair', quantity: 5, unitPrice: 270 }] }), /say why/);
    const r2 = await reviseOrder(pool, w.buyer.p, o.id, { reason: 'Fifth desk added', lines: [{ description: 'Chair', quantity: 5, unitPrice: 270 }] });
    assert.equal(r2.status, 'pending_approval');
    assert.equal(r2.revision, 2);
    await assert.rejects(receiveGoods(pool, w.buyer.p, o.id, { lines: [{ lineId: (await orderDetail(pool, w.buyer.p, o.id)).lines[0]!.id, accepted: 1 }] }), /waiting for approval/);
    await assert.rejects(approveOrder(pool, w.buyer.p, o.id), /administer/);
    await approveOrder(pool, w.admin.p, o.id);
    const detail = await orderDetail(pool, w.buyer.p, o.id);
    assert.equal(detail.status, 'issued');
    assert.equal(detail.revisions.length, 2);

    // The enforced budget (2,000) caps a revision that would need more than is left.
    await assert.rejects(reviseOrder(pool, w.buyer.p, o.id, { reason: 'More', lines: [{ description: 'Chair', quantity: 9, unitPrice: 270 }] }), /budget has/);

    // Cancel after a delivery: refused until it is returned; then the budget is released.
    const line = detail.lines[0]!;
    await receiveGoods(pool, w.buyer.p, o.id, { lines: [{ lineId: line.id, accepted: 1 }] });
    await assert.rejects(cancelOrder(pool, w.buyer.p, o.id, { reason: 'Project stopped' }), /return first/);
    await returnGoods(pool, w.buyer.p, o.id, { lineId: line.id, quantity: 1, reason: 'Project stopped' });
    await cancelOrder(pool, w.buyer.p, o.id, { reason: 'Project stopped' });
    assert.equal(Number((await listBudgets(pool, w.buyer.p))[0].consumed), 0, 'the hold is released');
    assert.equal((await listRequisitions(pool, w.buyer.p)).find((x) => x.id === req.id)!.status, 'cancelled');

    // A framework agreement caps what orders can use, and shows what is left.
    await assert.rejects(createAgreement(pool, w.buyer.p, { vendorId: v, title: 'x', limitAmount: 1, validFrom: '2026-01-01', validTo: '2026-12-31' }), /administer/);
    const g = await createAgreement(pool, w.admin.p, { vendorId: v, title: 'Stationery 2026', limitAmount: 500, validFrom: '2026-01-01', validTo: '2027-12-31' });
    await createOrder(pool, w.admin.p, { vendorId: v, agreementId: g.id, lines: [{ description: 'Paper', quantity: 10, unitPrice: 30 }] });
    await assert.rejects(createOrder(pool, w.admin.p, { vendorId: v, agreementId: g.id, lines: [{ description: 'Paper', quantity: 10, unitPrice: 30 }] }), /has 200\.00 left/);
    assert.equal((await listAgreements(pool, w.buyer.p))[0].remaining, 200);
    // An order with no approved request needs an owner or admin.
    await assert.rejects(createOrder(pool, w.buyer.p, { vendorId: v, lines: [{ description: 'Pen', quantity: 1, unitPrice: 1 }] }), /owner or admin/);
  } finally { await pool.end(); }
});
