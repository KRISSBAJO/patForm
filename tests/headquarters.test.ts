import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { memoryObjectStore, setObjectStoreForTests } from '../src/runtime/object-store.js';
import { createRequest, decideRequest, requestDetail, saveType, submitRequest, uploadFile, listCategories } from '../src/runtime/general-approvals.js';
import { createGroup, decideEscalation, escalationDetail, hqOverview, hqStatus, inviteNational, joinGroup, listEscalations, nationalRequests, removeNational, saveRule, setAccess } from '../src/runtime/headquarters.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function workspace(pool: Pool, engine: Engine, name: string) {
  const tenantId = await engine.createTenant(`${name}-${stamp()}`, { scenario: true });
  const mk = async (who: string, role: 'owner' | 'admin' | 'approver' | 'read_only') => {
    const id = await engine.createActor(tenantId, `${who.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@hq.test`, who, role);
    await pool.query('update actor set email_verified_at = now() where id = $1', [id]);
    return { id, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  return { tenantId, mk };
}

async function world(pool: Pool, engine: Engine) {
  const hqw = await workspace(pool, engine, 'hq');
  const hqOwner = await hqw.mk('Global Owner', 'owner'); const hqClerk = await hqw.mk('Global Clerk', 'approver'); const hqViewer = await hqw.mk('Global Viewer', 'read_only');
  const group = await createGroup(pool, hqOwner.p, { name: 'The Worldwide Church' });
  const nat = async (label: string) => {
    const w = await workspace(pool, engine, label.toLowerCase().replace(/\s+/g, '-'));
    const owner = await w.mk(`${label} Owner`, 'owner'); const admin = await w.mk(`${label} Admin`, 'admin');
    const approver = await w.mk(`${label} Approver`, 'approver'); const member = await w.mk(`${label} Member`, 'read_only');
    await setModule(pool, owner.p, 'general_approvals', { enabled: true });
    const cats = await listCategories(pool, owner.p);
    const finance = cats.find((c: { name: string }) => c.name === 'Finance') as { id: string };
    const type = await saveType(pool, owner.p, { name: 'Expenditure', attachmentRule: 'optional', categoryId: finance.id, amountField: 'amount',
      fields: [{ key: 'amount', label: 'Amount', type: 'number', required: true }, { key: 'purpose', label: 'Purpose', type: 'long_text', required: true }],
      steps: [{ name: 'National approval', responsible: [{ kind: 'person', actorId: approver.id }], mode: 'any' }] });
    return { ...w, owner, admin, approver, member, typeId: type!.id };
  };
  const ng = await nat('Nigeria National'); const gh = await nat('Ghana National');
  return { hqw, hqOwner, hqClerk, hqViewer, group, ng, gh };
}

test('a National joins a headquarters only with its owner and a valid code; Nationals stay apart', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await world(pool, engine);
    const inv = await inviteNational(pool, w.hqOwner.p, { label: 'Nigeria National' });
    await assert.rejects(inviteNational(pool, w.hqClerk.p, { label: 'x' }), /manage permission/);
    await assert.rejects(joinGroup(pool, w.ng.admin.p, { code: inv.code }), /only the owner/);
    await assert.rejects(joinGroup(pool, w.ng.owner.p, { code: 'grp_not-a-real-code' }), /not valid/);
    const joined = await joinGroup(pool, w.ng.owner.p, { code: inv.code });
    assert.equal(joined.label, 'Nigeria National');
    await assert.rejects(joinGroup(pool, w.gh.owner.p, { code: inv.code }), /not valid/, 'a code works once');
    await assert.rejects(joinGroup(pool, w.hqOwner.p, { code: (await inviteNational(pool, w.hqOwner.p, { label: 'Self' })).code }), /only the owner|cannot join itself|headquarters/);
    const inv2 = await inviteNational(pool, w.hqOwner.p, { label: 'Ghana National' });
    await joinGroup(pool, w.gh.owner.p, { code: inv2.code });

    const st = await hqStatus(pool, w.ng.member.p);
    assert.equal(st.role, 'national');
    // A National cannot use Headquarters endpoints, and so cannot see the other National.
    await assert.rejects(hqOverview(pool, w.ng.owner.p), /not a headquarters/);
    await assert.rejects(nationalRequests(pool, w.ng.owner.p, w.gh.tenantId), /not a headquarters/);
    // At Headquarters, access is explicit.
    await assert.rejects(hqOverview(pool, w.hqViewer.p), /view permission/);
    await setAccess(pool, w.hqOwner.p, { actorId: w.hqViewer.id, permissions: ['view'] });
    const ov = await hqOverview(pool, w.hqViewer.p);
    assert.deepEqual(ov.nationals.map((n) => n.label).sort(), ['Ghana National', 'Nigeria National']);
    assert.equal(ov.totals.members, 8);
    await assert.rejects(nationalRequests(pool, w.hqViewer.p, w.ng.tenantId), /records permission/, 'figures are not records');
    // Another group's Headquarters reaches none of this.
    const other = await workspace(pool, engine, 'other-hq'); const otherOwner = await other.mk('Other Owner', 'owner');
    await createGroup(pool, otherOwner.p, { name: 'Another Church' });
    await assert.rejects(nationalRequests(pool, otherOwner.p, w.ng.tenantId), /no such National in this group/);
    // Removing a National takes it out of every view.
    await removeNational(pool, w.hqOwner.p, w.gh.tenantId);
    assert.deepEqual((await hqOverview(pool, w.hqOwner.p)).nationals.map((n) => n.label), ['Nigeria National']);
    assert.equal((await hqStatus(pool, w.gh.owner.p)).role, 'none');
  } finally { await pool.end(); }
});

test('Headquarters rules: a required document and an escalation that Headquarters decides, recorded on both sides', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  setObjectStoreForTests(memoryObjectStore().store);
  try {
    const w = await world(pool, engine);
    await joinGroup(pool, w.ng.owner.p, { code: (await inviteNational(pool, w.hqOwner.p, { label: 'Nigeria National' })).code });
    await assert.rejects(saveRule(pool, w.hqClerk.p, { kind: 'escalate', name: 'x', applies: { minAmount: 1 } }), /policies permission/);
    await saveRule(pool, w.hqOwner.p, { kind: 'require_document', name: 'Board resolution for large spending', applies: { category: 'Finance', minAmount: 50000 }, document: 'Board resolution' });
    await saveRule(pool, w.hqOwner.p, { kind: 'escalate', name: 'Large spending goes to Headquarters', applies: { category: 'Finance', minAmount: 50000 } });
    await setAccess(pool, w.hqOwner.p, { actorId: w.hqClerk.id, permissions: ['escalations'] });

    // Below the line: the National's own route only.
    const small = await createRequest(pool, w.ng.member.p, { typeId: w.ng.typeId, title: 'Chairs', answers: { amount: 4000, purpose: 'Chairs for the hall.' } });
    await submitRequest(pool, w.ng.member.p, small.id);
    assert.equal((await decideRequest(pool, w.ng.approver.p, small.id, { decision: 'approve' })).status, 'approved');

    // Above it: the Headquarters document is required, and Headquarters reviews last.
    const big = await createRequest(pool, w.ng.member.p, { typeId: w.ng.typeId, title: 'New roof', answers: { amount: 80000, purpose: 'The auditorium roof leaks.' } });
    await assert.rejects(submitRequest(pool, w.ng.member.p, big.id), /board resolution \(required by headquarters\)/i);
    const d0 = await requestDetail(pool, w.ng.member.p, big.id);
    const doc = d0.type.documents.find((d: { hq?: boolean }) => d.hq) as { key: string };
    await uploadFile(pool, w.ng.member.p, big.id, { filename: 'resolution.pdf', base64: Buffer.from('%PDF-1.4 resolution').toString('base64'), documentKey: doc.key });
    await submitRequest(pool, w.ng.member.p, big.id);
    const after = await decideRequest(pool, w.ng.approver.p, big.id, { decision: 'approve' });
    assert.equal(after.status, 'pending');
    assert.deepEqual(after.next, ['Headquarters review']);
    // The National cannot decide the Headquarters step.
    await assert.rejects(decideRequest(pool, w.ng.owner.p, big.id, { decision: 'approve' }), /not a named approver/);
    // Headquarters sees it, opens it (recorded in the National), and decides.
    const list = await listEscalations(pool, w.hqClerk.p);
    assert.equal(list.length, 1); assert.equal(list[0].national, 'Nigeria National'); assert.equal(list[0].mine, true);
    const detail = await escalationDetail(pool, w.hqClerk.p, big.id);
    assert.equal(detail.canDecide, true);
    assert.equal(detail.files.length, 1);
    const done = await decideEscalation(pool, w.hqClerk.p, big.id, { decision: 'approve', note: 'Approved by the Board.' });
    assert.equal(done.status, 'approved');
    const { rows: seen } = await pool.query<{ action: string }>(`select action from workspace_admin_audit where tenant_id = $1 and action like 'headquarters.%' order by id`, [w.ng.tenantId]);
    assert.ok(seen.some((r) => r.action === 'headquarters.request_opened'), 'the National can see Headquarters opened its request');
    assert.ok(seen.some((r) => r.action === 'headquarters.escalation_decided'));
    const dn = await requestDetail(pool, w.ng.member.p, big.id);
    assert.equal(dn.request.status, 'approved');
  } finally { setObjectStoreForTests(null); await pool.end(); }
});
