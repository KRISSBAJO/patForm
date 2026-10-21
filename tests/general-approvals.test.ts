import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { setManager } from '../src/runtime/org.js';
import { memoryObjectStore, setObjectStoreForTests } from '../src/runtime/object-store.js';
import { createRequest, decideRequest, editRequest, fileLink, listRequests, listTypes, requestDetail, saveType, setRequestShare, submitRequest, uploadFile } from '../src/runtime/general-approvals.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);

test('general approvals routes a typed request, checks its required attachment, and keeps each decision', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  const engine = new Engine(pool);
  const store = memoryObjectStore();
  setObjectStoreForTests(store.store);
  try {
    const tenantId = await engine.createTenant(`ga-${Date.now()}-${Math.random()}`, { scenario: true });
    const actor = async (name: string, role: 'owner' | 'approver' | 'operator') => {
      const id = await engine.createActor(tenantId, `${name.toLowerCase()}-${Date.now()}@example.test`, name, role);
      return { id, p: { kind: 'actor', tenantId, actorId: id } as Principal };
    };
    const owner = await actor('Owner', 'owner');
    const requester = await actor('Requester', 'operator');
    const manager = await actor('Manager', 'approver');
    const final = await actor('Final', 'approver');
    const outsider = await actor('Outsider', 'operator');
    await setModule(pool, owner.p, 'general_approvals', { enabled: true });
    const starter = (await listTypes(pool, requester.p)).find((t: { name: string }) => t.name === 'General request');
    assert.ok(starter, 'activating the module creates a usable request type');
    const first = await createRequest(pool, requester.p, { typeId: starter.id, title: 'Access to the demo', answers: { details: 'I need to test the new workspace.' } });
    await assert.rejects(setRequestShare(pool, requester.p, first.id, { actorId: outsider.id }), /submitted request/);
    await submitRequest(pool, requester.p, first.id);
    assert.equal((await listRequests(pool, owner.p, 'waiting')).some((r: { id: string }) => r.id === first.id), true, 'owner reviews when the requester has no manager');
    await assert.rejects(requestDetail(pool, outsider.p, first.id), /not assigned/);
    const otherTenant = await engine.createTenant(`ga-other-${Date.now()}-${Math.random()}`, { scenario: true });
    const otherActor = await engine.createActor(otherTenant, `other-${Date.now()}@example.test`, 'Other workspace', 'operator');
    await assert.rejects(setRequestShare(pool, requester.p, first.id, { actorId: otherActor }), /active person in this workspace/);
    await setRequestShare(pool, requester.p, first.id, { actorId: outsider.id });
    assert.equal((await requestDetail(pool, outsider.p, first.id)).viewer.canDecide, false, 'sharing view access does not grant approval power');
    assert.equal((await listRequests(pool, outsider.p, 'shared')).some((r: { id: string }) => r.id === first.id), true);
    await assert.rejects(decideRequest(pool, outsider.p, first.id, { decision: 'approve' }), /not a named approver/);
    await setRequestShare(pool, requester.p, first.id, { actorId: outsider.id, shared: false });
    await assert.rejects(requestDetail(pool, outsider.p, first.id), /not assigned/);
    const ownerDraft = await createRequest(pool, owner.p, { typeId: starter.id, title: 'Owner request', answers: { details: 'A request that needs another person.' } });
    await assert.rejects(submitRequest(pool, owner.p, ownerDraft.id), /cannot approve your own request/);
    await setManager(pool, owner.p, requester.id, { managerId: manager.id, effectiveFrom: '2026-01-01T00:00:00Z' });
    const type = await saveType(pool, owner.p, {
      name: 'System access', description: 'Access to a work system', attachmentRule: 'required',
      fields: [{ key: 'system', label: 'System', type: 'short_text', required: true }],
      steps: [
        { name: 'Manager review', responsible: [{ kind: 'manager' }], mode: 'any' },
        { name: 'IT review', responsible: [{ kind: 'person', actorId: final.id }], mode: 'any' },
      ],
    });
    await assert.rejects(saveType(pool, requester.p, { name: 'Bad', fields: [], steps: [] }), /permission|administer|allowed|access/i);
    const draft = await createRequest(pool, requester.p, { typeId: type.id, title: 'Access to planning tool', answers: { system: 'Planning tool' } });
    await assert.rejects(submitRequest(pool, requester.p, draft.id), /attach a file/);
    await assert.rejects(requestDetail(pool, outsider.p, draft.id), /not assigned/);
    await uploadFile(pool, requester.p, draft.id, { filename: 'reason.txt', base64: Buffer.from('Work need').toString('base64') });
    await submitRequest(pool, requester.p, draft.id);
    assert.equal((await listRequests(pool, manager.p, 'waiting')).length, 1);
    assert.equal((await listRequests(pool, outsider.p, 'waiting')).length, 0);
    await assert.rejects(decideRequest(pool, requester.p, draft.id, { decision: 'approve' }), /cannot be decided/);
    await decideRequest(pool, manager.p, draft.id, { decision: 'return', note: 'Explain the duration' });
    assert.equal((await requestDetail(pool, requester.p, draft.id)).request.status, 'returned');
    await editRequest(pool, requester.p, draft.id, { answers: { system: 'Planning tool, 30 days' } });
    await submitRequest(pool, requester.p, draft.id);
    await decideRequest(pool, manager.p, draft.id, { decision: 'approve' });
    assert.equal((await listRequests(pool, final.p, 'waiting')).length, 1);
    await decideRequest(pool, final.p, draft.id, { decision: 'approve' });
    const detail = await requestDetail(pool, requester.p, draft.id);
    assert.equal(detail.request.status, 'approved');
    assert.equal(detail.steps.length, 4);
    assert.equal(detail.events.filter((e: { kind: string }) => e.kind === 'decision').length, 3);
    assert.equal(detail.files.length, 1);
    const linked = await fileLink(pool, requester.p, draft.id, detail.files[0]!.id);
    assert.ok(linked.url);
    const key = [...store.objects.keys()][0]!;
    store.scans.set(key, 'quarantined');
    await assert.rejects(fileLink(pool, requester.p, draft.id, detail.files[0]!.id), /malware check/);
    store.scans.delete(key);

    const twoPeople = await saveType(pool, owner.p, {
      name: 'Two-person exception', attachmentRule: 'none', fields: [],
      steps: [{ name: 'Joint review', responsible: [{ kind: 'person', actorId: manager.id }, { kind: 'person', actorId: final.id }], mode: 'all' }],
    });
    const second = await createRequest(pool, requester.p, { typeId: twoPeople.id, title: 'Temporary exception', answers: {} });
    await submitRequest(pool, requester.p, second.id);
    await decideRequest(pool, manager.p, second.id, { decision: 'approve' });
    assert.equal((await requestDetail(pool, manager.p, second.id)).viewer.canDecide, false);
    assert.equal((await requestDetail(pool, final.p, second.id)).viewer.canDecide, true);
    await decideRequest(pool, final.p, second.id, { decision: 'approve' });
    assert.equal((await requestDetail(pool, requester.p, second.id)).request.status, 'approved');
  } finally { setObjectStoreForTests(null); await pool.end(); }
});
