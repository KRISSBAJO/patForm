import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { setManager } from '../src/runtime/org.js';
import { listMembers } from '../src/runtime/workspace.js';
import { listCases } from '../src/runtime/hr.js';
import { myAssets } from '../src/runtime/ops.js';
import { listVendors } from '../src/runtime/procurement.js';
import { runScheduledRetention } from '../src/runtime/retention.js';
import {
  acknowledgePolicy, addEvidenceRequest, approvePolicyVersion, buildEvidencePack, clearHold, completeGovTask, contractDetail, createContract, createEngagement, createHold,
  createObligation, createPolicy, decideEvidence, decideException, engagementRecord, engagementView, govDashboard, grantAuditor, listHolds, listPolicies, listTasks,
  myAcknowledgements, noticeDeadline, publishPolicyVersion, raiseFinding, recordControlTest, releaseHold, requestException, reviewContract, reviseContract, saveControl,
  sendForSignature, setGovTeamMember, setRetentionSchedule, startCampaign, submitContract, submitEvidence, sweepGov, triggerObligation, updateEnvelope, workFinding, newPolicyVersion,
} from '../src/runtime/gov.js';
import type { Principal } from '../src/runtime/policy.js';

// PRD Module 10 and its four acceptance scenarios.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const addDays = (n: number, from = new Date()) => new Date(from.getTime() + n * 86400000).toISOString().slice(0, 10);
const shift = (d: string, n: number) => addDays(n, new Date(`${d}T00:00:00Z`));
const load = (f: string) => Blueprint.parse(JSON.parse(readFileSync(`processes/${f}`, 'utf8')));

async function workspace(pool: Pool, engine: Engine, modules: string[] = []) {
  const tenantId = await engine.createTenant(`gov-${stamp()}`, { scenario: true });
  const mk = async (name: string, role: 'owner' | 'admin' | 'operator' | 'approver' | 'read_only' | 'auditor') => {
    const id = await engine.createActor(tenantId, `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@gov.test`, name, role);
    return { id, name, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner');
  const admin = await mk('Ada Admin', 'admin');
  const legal = await mk('Lola Legal', 'operator');
  const legal2 = await mk('Leo Legal', 'operator');
  const compliance = await mk('Cora Compliance', 'operator');
  const compliance2 = await mk('Cal Compliance', 'operator');
  const finance = await mk('Fin Finance', 'operator');
  const manager = await mk('Mo Manager', 'approver');
  const staff = await mk('Sam Staff', 'read_only');
  const auditor = await mk('Audrey Auditor', 'auditor');
  for (const m of ['contracts', ...modules]) await setModule(pool, owner.p, m, { enabled: true });
  for (const [team, who] of [['legal', legal], ['legal', legal2], ['compliance', compliance], ['compliance', compliance2], ['finance', finance]] as const) await setGovTeamMember(pool, admin.p, { team, actorId: who.id });
  await setManager(pool, owner.p, staff.id, { managerId: manager.id, effectiveFrom: '2026-01-01T00:00:00Z' });
  return { tenantId, owner, admin, legal, legal2, compliance, compliance2, finance, manager, staff, auditor };
}

test('notice deadlines: calendar days move off weekends and holidays; working days skip them', () => {
  const holidays = new Set(['2026-12-25', '2026-12-28']);
  assert.equal(noticeDeadline('2026-12-31', 30, 'calendar', holidays), '2026-12-01');
  // 31 Dec less 26 days is Saturday 5 Dec; notice is due the working day before.
  assert.equal(noticeDeadline('2026-12-31', 26, 'calendar', holidays), '2026-12-04');
  // Five working days back from Thursday 31 Dec, skipping the weekend and two holidays.
  assert.equal(noticeDeadline('2026-12-31', 5, 'business', holidays), '2026-12-22');
});

test('acceptance 1: a contract revision after Legal approval requests a new review under the material-change policy', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    const c = await createContract(pool, w.staff.p, { title: 'Cleaning services', counterparty: 'SparkleCo Ltd', value: 20000, currency: 'NGN', startDate: addDays(5), endDate: addDays(370), noticeDays: 30 });
    await assert.rejects(reviewContract(pool, w.legal.p, c.id, { discipline: 'legal', decision: 'approve' }), /not sent it for review/);
    const sent = await submitContract(pool, w.staff.p, c.id);
    assert.deepEqual(sent.required, ['business', 'legal']);
    await assert.rejects(reviewContract(pool, w.finance.p, c.id, { discipline: 'finance', decision: 'approve' }), /does not need a finance review/);
    await assert.rejects(reviewContract(pool, w.finance.p, c.id, { discipline: 'legal', decision: 'approve' }), /only the legal team/);
    await assert.rejects(reviewContract(pool, w.staff.p, c.id, { discipline: 'business', decision: 'approve' }), /owner's manager or an admin/);
    await reviewContract(pool, w.legal.p, c.id, { discipline: 'legal', decision: 'approve', note: 'Standard terms' });
    const both = await reviewContract(pool, w.manager.p, c.id, { discipline: 'business', decision: 'approve' });
    assert.equal(both.status, 'approved');

    // A wording fix is not material: approvals carry over, and say so.
    const typo = await reviseContract(pool, w.staff.p, c.id, { changes: 'Fixed a typo in clause 4' });
    assert.equal(typo.material, false);
    assert.equal(typo.status, 'approved');

    // A changed value is material: Legal's approval (and the business one) are cancelled.
    const priced = await reviseContract(pool, w.staff.p, c.id, { changes: 'Price increase agreed', value: 26000 });
    assert.equal(priced.material, true);
    assert.deepEqual(priced.changed, ['value']);
    assert.deepEqual(priced.cancelled.sort(), ['business', 'legal']);
    assert.equal(priced.status, 'in_review');
    const d = await contractDetail(pool, w.legal.p, c.id);
    assert.equal(d.contract.current_version, 3);
    assert.deepEqual(d.review.decisions.map((x) => x.decision), ['waiting', 'waiting']);
    assert.ok(d.reviews.some((r: { invalidated_reason: string | null }) => /material revision v3 \(value\)/.test(r.invalidated_reason ?? '')));
    // The person who wrote a version cannot review it.
    await reviseContract(pool, w.legal.p, c.id, { changes: 'Legal added a liability cap', material: true });
    await assert.rejects(reviewContract(pool, w.legal.p, c.id, { discipline: 'legal', decision: 'approve' }), /someone other than the author/);
    await reviewContract(pool, w.legal2.p, c.id, { discipline: 'legal', decision: 'approve' });
    await reviewContract(pool, w.manager.p, c.id, { discipline: 'business', decision: 'approve' });

    // Signature is separate from approval, and a revision voids an envelope for the old version.
    const env = await sendForSignature(pool, w.staff.p, c.id, { provider: 'DocuSign', envelopeRef: 'ENV-1' });
    await reviseContract(pool, w.legal2.p, c.id, { changes: 'Changed the end date', endDate: addDays(400) });
    await assert.rejects(updateEnvelope(pool, w.staff.p, env.id, { status: 'completed', signedArtifactRef: 'x' }), /already voided/);
    await assert.rejects(sendForSignature(pool, w.staff.p, c.id, { provider: 'DocuSign', envelopeRef: 'ENV-2' }), /approved in its current version/);
    await reviewContract(pool, w.legal.p, c.id, { discipline: 'legal', decision: 'approve' });
    await reviewContract(pool, w.manager.p, c.id, { discipline: 'business', decision: 'approve' });
    const env2 = await sendForSignature(pool, w.staff.p, c.id, { provider: 'DocuSign', envelopeRef: 'ENV-2' });
    await assert.rejects(updateEnvelope(pool, w.staff.p, env2.id, { status: 'completed' }), /signed document reference/);
    assert.equal((await updateEnvelope(pool, w.staff.p, env2.id, { status: 'completed', signedArtifactRef: 'signed/ENV-2.pdf' })).contract, 'signed');
    await assert.rejects(reviseContract(pool, w.staff.p, c.id, { changes: 'x', value: 1 }), /amendment/);

    // Finance joins above the value threshold.
    const big = await createContract(pool, w.staff.p, { title: 'Fleet lease', counterparty: 'Autos Ltd', value: 900000, currency: 'NGN' });
    assert.deepEqual((await submitContract(pool, w.staff.p, big.id)).required, ['business', 'legal', 'finance']);
    // Someone outside the contract and the teams cannot see it.
    const outsiderId = await engine.createActor(w.tenantId, `outsider-${stamp()}@gov.test`, 'Olu Outsider', 'operator');
    await assert.rejects(contractDetail(pool, { kind: 'actor', tenantId: w.tenantId, actorId: outsiderId }, c.id), /no such contract/);
  } finally { await pool.end(); }
});

test('acceptance 2: a renewal task is created before the notice deadline from the stored notice period and calendar, once', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    const end = addDays(90);
    const holidays = [shift(end, -3), shift(end, -4)];
    for (const h of holidays) await pool.query(`insert into public_holiday (tenant_id, day, name) values ($1, $2, 'Holiday') on conflict do nothing`, [w.tenantId, h]);
    const cal = await createContract(pool, w.staff.p, { title: 'Office lease', counterparty: 'Landlord Ltd', endDate: end, noticeDays: 30, autoRenews: true });
    const biz = await createContract(pool, w.staff.p, { title: 'Payroll software', counterparty: 'SoftCo', endDate: end, noticeDays: 10, noticeCalendar: 'business' });
    await pool.query(`update contract set status = 'signed' where id = any($1::uuid[])`, [[cal.id, biz.id]]);
    const set = new Set(holidays);
    const calDeadline = noticeDeadline(end, 30, 'calendar', set);
    const bizDeadline = noticeDeadline(end, 10, 'business', set);

    // Not yet: more than the lead time (30 days) before the deadline.
    await sweepGov(pool, { tenantId: w.tenantId, on: shift(calDeadline, -31) });
    assert.equal((await pool.query(`select count(*)::int as n from obligation_task where contract_id = $1`, [cal.id])).rows[0].n, 0);
    // Then exactly one, however many sweeps run, even at once.
    await Promise.all([1, 2, 3].map(() => sweepGov(pool, { tenantId: w.tenantId, on: shift(calDeadline, -30) })));
    await sweepGov(pool, { tenantId: w.tenantId, on: shift(calDeadline, -10) });
    const { rows } = await pool.query<{ due_on: string; notice_deadline: string; title: string }>(`select due_on::text, notice_deadline::text, title from obligation_task where contract_id = $1`, [cal.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.notice_deadline, calDeadline);
    assert.ok(rows[0]!.due_on < end, 'due before the contract ends');
    assert.match(rows[0]!.title, /Renews automatically .* notice due by/);
    await sweepGov(pool, { tenantId: w.tenantId, on: shift(bizDeadline, -30) });
    const b = await pool.query<{ notice_deadline: string }>(`select notice_deadline::text from obligation_task where contract_id = $1`, [biz.id]);
    assert.equal(b.rows[0]!.notice_deadline, bizDeadline, 'working days skip weekends and the workspace holidays');

    const tasks = await listTasks(pool, w.staff.p);
    const renewal = tasks.find((t: { contract_id: string }) => t.contract_id === cal.id);
    await assert.rejects(completeGovTask(pool, w.staff.p, renewal.id, {}), /decide: renew, give_notice/);
    await assert.rejects(completeGovTask(pool, w.staff.p, renewal.id, { decision: 'give_notice' }), /attach the notice/);
    await completeGovTask(pool, w.staff.p, renewal.id, { decision: 'give_notice', evidence: 'Letter ref L-22', note: 'Moving office' });

    // Recurring and event obligations, with evidence and escalation.
    const ob = await createObligation(pool, w.staff.p, { contractId: cal.id, title: 'Insurance certificate to landlord', kind: 'recurring', everyMonths: 3, firstDue: addDays(5), escalateAfterDays: 2 });
    await sweepGov(pool, { tenantId: w.tenantId });
    await sweepGov(pool, { tenantId: w.tenantId });
    const ins = await pool.query<{ due_on: string; id: string }>(`select id, due_on::text from obligation_task where obligation_id = $1`, [ob.id]);
    assert.equal(ins.rows.length, 1);
    assert.equal(ins.rows[0]!.due_on, addDays(5));
    await assert.rejects(completeGovTask(pool, w.staff.p, ins.rows[0]!.id, {}), /needs evidence/);
    const ev = await createObligation(pool, w.staff.p, { contractId: cal.id, title: 'Report a data breach to the client', kind: 'event' });
    await assert.rejects(triggerObligation(pool, w.staff.p, ev.id, {}), /what happened/);
    const trig = await triggerObligation(pool, w.staff.p, ev.id, { note: 'Laptop stolen', dueInDays: 0 });
    assert.equal(trig.due, addDays(0));
    await pool.query(`update obligation_task set due_on = current_date - 5 where id = $1`, [ins.rows[0]!.id]);
    await sweepGov(pool, { tenantId: w.tenantId });
    assert.ok((await pool.query('select escalated_at from obligation_task where id = $1', [ins.rows[0]!.id])).rows[0].escalated_at);
  } finally { await pool.end(); }
});

test('acceptance 3: an auditor cannot edit evidence or reach records outside the engagement; views and exports are logged; export is separate', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine, ['hr', 'assets', 'procurement']);
    await engine.publish(w.tenantId, load('cash-advance.blueprint.json'), 'test');
    await engine.publish(w.tenantId, load('staff-expense-claim.blueprint.json'), 'test');
    const ver = async (key: string) => (await pool.query<{ id: string }>('select id from process_version where tenant_id = $1 and process_key = $2 order by version desc limit 1', [w.tenantId, key])).rows[0]!.id;
    const rec = async (key: string, created: string) => (await pool.query<{ id: string }>(
      `insert into instance (tenant_id, process_key, process_version_id, state, data, created_at, completed_at) values ($1, $2, $3, 'closed', $4, $5, $5) returning id`,
      [w.tenantId, key, await ver(key), JSON.stringify({ purpose: `${key} record` }), `${created}T10:00:00Z`])).rows[0]!.id;
    const inScope = await rec('cash_advance', addDays(-20));
    const otherProcess = await rec('staff_expense_claim', addDays(-20));
    const otherPeriod = await rec('cash_advance', addDays(-400));

    const eng = await createEngagement(pool, w.compliance.p, { title: 'Cash advances review', scope: { processKeys: ['cash_advance'] }, periodFrom: addDays(-90), periodTo: addDays(0) });
    await assert.rejects(engagementView(pool, w.auditor.p, eng.id), /no such engagement for you/);
    await grantAuditor(pool, w.compliance.p, eng.id, { actorId: w.auditor.id, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
    const req = await addEvidenceRequest(pool, w.compliance.p, eng.id, { title: 'Advance approval matrix', ownerId: w.finance.id });
    await submitEvidence(pool, w.finance.p, req.id, { evidenceRef: 'matrix-v3.pdf' });

    const view = await engagementView(pool, w.auditor.p, eng.id);
    assert.equal(view.readOnly, true);
    assert.equal(view.canExport, false);
    assert.deepEqual(view.records.map((r: { id: string }) => r.id), [inScope]);
    assert.equal((await engagementRecord(pool, w.auditor.p, eng.id, inScope)).record.id, inScope);
    await assert.rejects(engagementRecord(pool, w.auditor.p, eng.id, otherProcess), /outside this engagement/);
    await assert.rejects(engagementRecord(pool, w.auditor.p, eng.id, otherPeriod), /outside this engagement/);

    // Read-only: no edits to evidence, requests or findings.
    await assert.rejects(submitEvidence(pool, w.auditor.p, req.id, { evidenceRef: 'forged.pdf' }), /read-only/);
    await assert.rejects(decideEvidence(pool, w.auditor.p, req.id, { decision: 'accept' }), /read-only/);
    await assert.rejects(addEvidenceRequest(pool, w.auditor.p, eng.id, { title: 'x', ownerId: w.staff.id }), /read-only/);
    await assert.rejects(raiseFinding(pool, w.auditor.p, eng.id, { title: 'x', detail: 'y', severity: 'low', ownerId: w.staff.id }), /read-only/);
    // And nothing else in the workspace.
    await assert.rejects(listCases(pool, w.auditor.p), /auditors see only their engagement/);
    await assert.rejects(myAssets(pool, w.auditor.p), /auditors see only their engagement/);
    await assert.rejects(listMembers(pool, w.auditor.p), /auditors see only their engagement/);
    await assert.rejects(listVendors(pool, w.auditor.p));

    // Export is a separate right.
    await assert.rejects(buildEvidencePack(pool, w.auditor.p, eng.id), /does not include export/);
    await grantAuditor(pool, w.compliance.p, eng.id, { actorId: w.auditor.id, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), canExport: true });
    const pack = await buildEvidencePack(pool, w.auditor.p, eng.id);
    assert.ok(pack.items.some((i) => i.kind === 'original' && i.id === `record:${inScope}`));
    assert.ok(pack.items.some((i) => i.kind === 'original' && i.id === `evidence_request:${req.id}`));
    const summary = pack.items.find((i) => i.kind === 'derived')!;
    assert.match(summary.source, /not an original artifact/);
    assert.ok(!pack.items.some((i) => i.id === `record:${otherProcess}`));
    for (const m of pack.manifest.items) assert.equal(m.sha256, createHash('sha256').update(JSON.stringify(pack.items.find((i) => i.id === m.id)!.data)).digest('hex'));

    const { rows: log } = await pool.query<{ action: string; target_kind: string; target_id: string }>('select action, target_kind, target_id from auditor_access_log where engagement_id = $1 order by id', [eng.id]);
    assert.ok(log.some((l) => l.action === 'view' && l.target_id === inScope));
    assert.ok(log.some((l) => l.action === 'denied' && l.target_id === otherProcess));
    assert.ok(log.some((l) => l.action === 'denied' && l.target_kind === 'export'));
    assert.ok(log.some((l) => l.action === 'export'));
    await assert.rejects(pool.query('delete from auditor_access_log where engagement_id = $1', [eng.id]), /append-only/);

    // Access ends on its date.
    await pool.query(`update engagement_auditor set expires_at = now() - interval '1 minute' where engagement_id = $1`, [eng.id]);
    await assert.rejects(engagementView(pool, w.auditor.p, eng.id), /no such engagement for you/);
  } finally { await pool.end(); }
});

test('acceptance 4: a legal hold stops the scheduled purge, the blocked purge is recorded, and release needs a review before deletion resumes', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    await engine.publish(w.tenantId, load('cash-advance.blueprint.json'), 'test');
    const { rows: v } = await pool.query<{ id: string }>(`select id from process_version where tenant_id = $1 and process_key = 'cash_advance'`, [w.tenantId]);
    const old = `${addDays(-8 * 365)}T10:00:00Z`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await pool.query<{ id: string }>(`insert into instance (tenant_id, process_key, process_version_id, state, data, created_at, completed_at) values ($1, 'cash_advance', $2, 'closed', '{}', $3, $3) returning id`, [w.tenantId, v[0]!.id, old])).rows[0]!.id);
    const count = async () => (await pool.query<{ n: number }>('select count(*)::int as n from instance where id = any($1::uuid[])', [ids])).rows[0]!.n;

    // Only owners and Legal see or place holds.
    await assert.rejects(createHold(pool, w.admin.p, { title: 'x', reason: 'y', scope: { processKeys: ['cash_advance'] } }), /owner or the legal team/);
    await assert.rejects(listHolds(pool, w.compliance.p), /visible only to owners and the legal team/);
    assert.equal((await govDashboard(pool, w.compliance.p)).holds, null);
    const hold = await createHold(pool, w.legal.p, { title: 'Dispute with Contractor X', reason: 'Litigation expected', scope: { processKeys: ['cash_advance'] } });

    await setRetentionSchedule(pool, w.admin.p, { processKey: 'cash_advance' });
    const run1 = await runScheduledRetention(pool);
    const mine = run1.find((r) => r.processKey === 'cash_advance' && r.held);
    assert.equal(mine?.held, 3);
    assert.equal(mine?.instances, 0);
    assert.equal(await count(), 3, 'nothing held was deleted');
    const held = await listHolds(pool, w.legal.p);
    assert.equal(held.blocks[0]!.held_records, 3);
    assert.equal(held.holds[0]!.blocked, 3);
    await assert.rejects(pool.query('delete from retention_block where tenant_id = $1', [w.tenantId]), /append-only/);

    // Released is still protected until someone else reviews it.
    await assert.rejects(releaseHold(pool, w.legal.p, hold.id, {}), /record why/);
    await releaseHold(pool, w.legal.p, hold.id, { reason: 'Settled out of court' });
    await pool.query(`update retention_schedule set last_run_at = null where tenant_id = $1`, [w.tenantId]);
    await runScheduledRetention(pool);
    assert.equal(await count(), 3, 'a release alone does not trigger deletion');
    await assert.rejects(clearHold(pool, w.legal.p, hold.id, { note: 'ok' }), /someone other than the person who released it/);
    await clearHold(pool, w.legal2.p, hold.id, { note: 'Reviewed the settlement; normal retention may resume' });
    await pool.query(`update retention_schedule set last_run_at = null where tenant_id = $1`, [w.tenantId]);
    const run3 = await runScheduledRetention(pool);
    assert.equal(run3.find((r) => r.processKey === 'cash_advance')?.instances, 3);
    assert.equal(await count(), 0);
  } finally { await pool.end(); }
});

test('policies, controls, exceptions and findings: someone else approves, validates or decides; history is kept', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    const p = await createPolicy(pool, w.compliance.p, { title: 'Acceptable use', summary: 'How company devices may be used' });
    await assert.rejects(createPolicy(pool, w.staff.p, { title: 'x', summary: 'y' }), /only compliance/);
    await assert.rejects(approvePolicyVersion(pool, w.compliance.p, p.versionId), /someone other than the author/);
    await assert.rejects(publishPolicyVersion(pool, w.compliance.p, p.versionId, { effectiveFrom: addDays(0) }), /approve the version/);
    await approvePolicyVersion(pool, w.compliance2.p, p.versionId);
    await publishPolicyVersion(pool, w.compliance.p, p.versionId, { effectiveFrom: addDays(0) });
    const camp = await startCampaign(pool, w.compliance.p, p.versionId, { dueOn: addDays(14) });
    const mineBefore = await myAcknowledgements(pool, w.staff.p);
    assert.equal(mineBefore[0].acknowledged_at, null);
    const ack = await acknowledgePolicy(pool, w.staff.p, camp.id);
    assert.match(ack.statement, /read and understood "Acceptable use" version 1/);
    await assert.rejects(acknowledgePolicy(pool, w.staff.p, camp.id), /already acknowledged/);
    // A new published version supersedes the old one, which stays on record.
    const v2 = await newPolicyVersion(pool, w.compliance.p, p.id, { summary: 'Adds personal phones' });
    await approvePolicyVersion(pool, w.compliance2.p, v2.id);
    await publishPolicyVersion(pool, w.compliance2.p, v2.id, { effectiveFrom: addDays(1) });
    const pol = (await listPolicies(pool, w.compliance.p))[0];
    assert.deepEqual(pol.versions.map((x: { status: string }) => x.status), ['published', 'superseded']);
    assert.equal(pol.campaigns[0].acknowledged, 1);
    await assert.rejects(acknowledgePolicy(pool, w.manager.p, camp.id), /replaced/);

    const k = await saveControl(pool, w.compliance.p, { ref: 'AC-1', title: 'Quarterly access review', ownerId: w.staff.id, evidenceType: 'Signed review export', frequencyDays: 90 });
    await assert.rejects(recordControlTest(pool, w.staff.p, k.id, { result: 'pass' }), /needs its evidence/);
    assert.equal((await recordControlTest(pool, w.staff.p, k.id, { result: 'fail', evidenceRef: 'review-q3.xlsx' })).status, 'ineffective');
    const ex = await requestException(pool, w.staff.p, { kind: 'control', targetId: k.id, subject: 'Field tablets', reason: 'No network for the export', expiresOn: addDays(30) });
    await assert.rejects(decideException(pool, w.staff.p, ex.id, { decision: 'approve', note: 'x' }), /only compliance/);
    await decideException(pool, w.compliance.p, ex.id, { decision: 'approve', note: 'Until the new MDM is live' });

    const eng = await createEngagement(pool, w.compliance.p, { title: 'Access controls', scope: { controlIds: [k.id] }, periodFrom: addDays(-30), periodTo: addDays(0) });
    const f = await raiseFinding(pool, w.compliance.p, eng.id, { title: 'Access review failed', detail: 'Two leavers still active', severity: 'high', ownerId: w.staff.id });
    await assert.rejects(workFinding(pool, w.staff.p, f.id, { action: 'evidence', evidenceRef: 'x' }), /management response first/);
    await workFinding(pool, w.staff.p, f.id, { action: 'respond', body: 'Remove both and automate the review', targetDate: addDays(14) });
    await workFinding(pool, w.staff.p, f.id, { action: 'evidence', evidenceRef: 'ticket-881' });
    await assert.rejects(workFinding(pool, w.staff.p, f.id, { action: 'validate' }), /someone other than the owner/);
    await workFinding(pool, w.compliance.p, f.id, { action: 'reopen', body: 'Only one leaver removed' });
    await workFinding(pool, w.staff.p, f.id, { action: 'evidence', evidenceRef: 'ticket-882' });
    assert.equal((await workFinding(pool, w.compliance2.p, f.id, { action: 'validate' })).status, 'closed');
    const { rows } = await pool.query<{ kind: string }>('select kind from finding_action where finding_id = $1 order by id', [f.id]);
    assert.deepEqual(rows.map((r) => r.kind), ['response', 'evidence', 'reopened', 'evidence', 'validated']);

    const dash = await govDashboard(pool, w.compliance.p);
    assert.match(dash.disclaimer!, /not a certification/);
  } finally { await pool.end(); }
});
