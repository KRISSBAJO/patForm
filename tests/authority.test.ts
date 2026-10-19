import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { validate } from '../src/compiler/validate.js';
import { createPool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { InvalidInput } from '../src/runtime/errors.js';
import { authorityOf, covers, createDelegation, createGrant, listAuthority, revokeDelegation, revokeGrant, workspaceAudit } from '../src/runtime/authority.js';
import { createLegalEntity, setMemberPlacement } from '../src/runtime/org.js';
import { changeRole } from '../src/runtime/workspace.js';
import type { Principal } from '../src/runtime/policy.js';

// PRD ORG-05 to ORG-07: a role says somebody can approve, a grant says how
// much; a delegate never exceeds the holder; a claim above everyone's limit
// escalates; every change to authority is written down.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function workspace(engine: Engine, label: string) {
  const tenantId = await engine.createTenant(`auth-${label}-${stamp()}`, { scenario: true });
  const adminId = await engine.createActor(tenantId, `admin-${stamp()}@auth.test`, 'Admin', 'admin');
  const admin: Principal = { kind: 'actor', tenantId, actorId: adminId };
  return { tenantId, adminId, admin };
}

test('grants: self-grant refused, entity scope honoured, delegation capped at the holder, revocation audited', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const { tenantId, adminId, admin } = await workspace(engine, 'grants');
    const director = await engine.createActor(tenantId, `dir-${stamp()}@auth.test`, 'Director', 'approver');
    const deputy = await engine.createActor(tenantId, `dep-${stamp()}@auth.test`, 'Deputy', 'approver');
    const entityA = await createLegalEntity(pool, admin, { name: 'Alpha Ltd' });
    const entityB = await createLegalEntity(pool, admin, { name: 'Beta Ltd' });
    // Grants and delegations start at a fixed past date, so the clock the test
    // asks about is never a moment before they began.
    const at = new Date();
    const since = '2026-01-01T00:00:00Z';

    // ORG-07: no second pair of eyes, no grant to yourself.
    await assert.rejects(createGrant(pool, admin, { actorId: adminId, amountLimit: 1000000 }), /yourself/);
    // Writes need `administer`.
    await assert.rejects(createGrant(pool, { kind: 'actor', tenantId, actorId: director }, { actorId: deputy, amountLimit: 10 }), /administer/);

    // Nothing on file covers nothing, not even zero.
    assert.equal(covers(await authorityOf(pool, { tenantId, actorId: director, decisionType: 'expense_approval', legalEntityId: null, at }), 0), false);

    // A 5,000 grant for Alpha only.
    const grant = await createGrant(pool, admin, { actorId: director, decisionType: 'expense_approval', amountLimit: '5,000', legalEntityId: entityA.id, validFrom: since });
    const inA = await authorityOf(pool, { tenantId, actorId: director, decisionType: 'expense_approval', legalEntityId: entityA.id, at });
    assert.equal(inA.limit, 5000);
    assert.equal(covers(inA, 5000), true);
    assert.equal(covers(inA, 5000.01), false);
    const inB = await authorityOf(pool, { tenantId, actorId: director, decisionType: 'expense_approval', legalEntityId: entityB.id, at });
    assert.equal(inB.none, true);
    const otherType = await authorityOf(pool, { tenantId, actorId: director, decisionType: 'procurement', legalEntityId: entityA.id, at });
    assert.equal(otherType.none, true);

    // ORG-06: the deputy acts for the director, never above 5,000, and a cap lowers it further.
    const delegation = await createDelegation(pool, { kind: 'actor', tenantId, actorId: director }, { toActorId: deputy, scope: 'expense_approval', amountLimit: 2000, reason: 'leave', validFrom: since });
    const asDeputy = await authorityOf(pool, { tenantId, actorId: deputy, decisionType: 'expense_approval', legalEntityId: entityA.id, at });
    assert.equal(asDeputy.limit, 2000);
    assert.equal(asDeputy.via?.kind, 'delegated');
    // Only when acting for someone actually named.
    const notNamed = await authorityOf(pool, { tenantId, actorId: deputy, decisionType: 'expense_approval', legalEntityId: entityA.id, at, actingFor: ['someone-else@auth.test'] });
    assert.equal(notNamed.none, true);
    // An uncapped delegation inherits the holder's 5,000, not unlimited.
    await revokeDelegation(pool, { kind: 'actor', tenantId, actorId: director }, delegation.id);
    await createDelegation(pool, admin, { fromActorId: director, toActorId: deputy, scope: '*', validFrom: since });
    assert.equal((await authorityOf(pool, { tenantId, actorId: deputy, decisionType: 'expense_approval', legalEntityId: entityA.id, at })).limit, 5000);
    // The holder's revoked grant takes the delegate's authority with it.
    await revokeGrant(pool, admin, grant.id, 'reorganisation');
    assert.equal((await authorityOf(pool, { tenantId, actorId: deputy, decisionType: 'expense_approval', legalEntityId: entityA.id, at })).none, true);

    // Validity dates are honoured.
    const future = await createGrant(pool, admin, { actorId: director, amountLimit: 100, validFrom: '2030-01-01T00:00:00Z' });
    assert.equal((await authorityOf(pool, { tenantId, actorId: director, decisionType: 'x', legalEntityId: null, at })).none, true);
    assert.equal((await authorityOf(pool, { tenantId, actorId: director, decisionType: 'x', legalEntityId: null, at: new Date('2030-06-01T00:00:00Z') })).limit, 100);
    assert.ok(future.id);

    // Listing and the audit trail: every change above is a row, and the rows cannot be changed.
    const listed = await listAuthority(pool, admin);
    assert.equal(listed.grants.length, 2);
    assert.equal(listed.delegations.length, 2);
    const audit = await workspaceAudit(pool, admin);
    const actions = audit.map((r: { action: string }) => r.action);
    for (const expected of ['authority.granted', 'authority.revoked', 'delegation.created', 'delegation.revoked']) {
      assert.ok(actions.includes(expected), `${expected} in ${actions.join(', ')}`);
    }
    await assert.rejects(pool.query('delete from workspace_admin_audit where tenant_id = $1', [tenantId]), /append-only/);
    await assert.rejects(pool.query("update workspace_admin_audit set action = 'x' where tenant_id = $1", [tenantId]), /append-only/);
    // Another workspace's admin sees none of it.
    const other = await workspace(engine, 'grants-other');
    assert.equal((await workspaceAudit(pool, other.admin)).length, 0);
    await assert.rejects(createDelegation(pool, other.admin, { fromActorId: director, toActorId: deputy }), InvalidInput);

    // Role changes and deactivation are audited too (the gap the audit found).
    await changeRole(pool, { principal: admin, actorId: deputy, workspaceRole: 'operator' });
    assert.ok((await workspaceAudit(pool, admin)).some((r: { action: string }) => r.action === 'member.role_changed'));
  } finally { await pool.end(); }
});

test('an approval with a limit refuses above it, admits a delegate, and escalates when nobody named could approve', { skip: !localDatabase }, async () => {
  const raw = Blueprint.parse(JSON.parse(readFileSync('processes/expense-approval.blueprint.json', 'utf8')));
  const scenario = raw.tests.find((t) => t.name.includes('over £1000'))!;
  const submit = scenario.steps.find((step) => step.step === 'submit')!;
  if (submit.step !== 'submit') throw new Error('expected a submit step');

  const bp = structuredClone(raw);
  bp.experience.access = { mode: 'workspace', role: 'claimant_staff' };
  bp.roles.push({ key: 'claimant_staff', name: 'Staff', kind: 'internal', capabilities: ['submit', 'view'] });
  bp.roles.push({ key: 'director', name: 'Director', kind: 'internal', capabilities: ['view', 'approve'] });
  const approval = bp.workflow.approvals.find((a) => a.key === 'manager_approval')!;
  approval.approvers = [{ manager: 'submitter', fallback: 'line_manager' }];
  approval.authority = { amountField: 'expense_total', escalateTo: { role: 'director' } };

  // The compiler: a non-amount field is an error; no escalation route is a warning.
  const bad = structuredClone(bp);
  bad.workflow.approvals.find((a) => a.key === 'manager_approval')!.authority = { amountField: 'claimant_name' };
  assert.ok(validate(bad).errors.some((e) => e.code === 'TYPE010'));
  assert.ok(validate(bad).warnings.some((w) => w.code === 'OPS013'));
  assert.equal(validate(bp).errors.length, 0, JSON.stringify(validate(bp).errors));

  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const { tenantId, admin } = await workspace(engine, 'limits');
    const manager = await engine.createActor(tenantId, `mgr-${stamp()}@auth.test`, 'Manager', 'approver');
    const deputy = await engine.createActor(tenantId, `dep-${stamp()}@auth.test`, 'Deputy', 'approver');
    const director = await engine.createActor(tenantId, `dir-${stamp()}@auth.test`, 'Director', 'approver');
    const staff = await engine.createActor(tenantId, `staff-${stamp()}@auth.test`, 'Staff', 'operator');
    const version = await engine.publish(tenantId, bp, 'test');
    for (const [actorId, roleKey] of [[staff, 'claimant_staff'], [manager, 'line_manager'], [deputy, 'line_manager'], [director, 'director']] as const) {
      await engine.grant({ tenantId, actorId, processKey: bp.key, roleKey });
    }
    const now = new Date('2026-10-19T09:00:00Z');
    let claim = 0;
    const submitAs = (lines: { line_description: string; line_amount: number }[]) => engine.submit({
      version, now, principal: { kind: 'actor', tenantId, actorId: staff },
      answers: { ...submit.answers, expense_date: `2026-09-${String(10 + ++claim).padStart(2, '0')}`, line_items: lines },
    });
    // The outbox is one queue for every tenant, and the suite runs test files
    // in parallel, so another process may hold our row for a moment: ask a
    // few times before concluding nothing was routed.
    const requestFor = async (instanceId: string) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        await engine.drain(now, 'test', tenantId);
        const { rows } = await pool.query<{ approvers: string[] }>(
          "select approvers from approval_request where instance_id = $1 and approval_key = 'manager_approval'", [instanceId]);
        if (rows[0]) return rows[0].approvers;
        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    };
    const decideAs = (instanceId: string, actorId: string, decision: 'approved' | 'rejected' = 'approved') =>
      engine.decide({ instanceId, approvalKey: 'manager_approval', decision, reason: 'ok', principal: { kind: 'actor', tenantId, actorId }, now });
    const managerEmail = (await engine.actor(manager))!.email;
    const grantTo = (actorId: string, amountLimit: number) => createGrant(pool, admin, { actorId, decisionType: bp.key, amountLimit, validFrom: '2026-01-01T00:00:00Z' });

    // 1. Named, with a role, but no grant: a title alone implies nothing.
    const a = await submitAs([{ line_description: 'Laptop', line_amount: 1400 }]);
    // Nobody named could approve and the director can, so it escalates.
    await grantTo(director, 50000);
    assert.deepEqual(await requestFor(a.instanceId), ['role:director']);
    assert.ok((await engine.events(a.instanceId)).some((e) => e.type === 'approval_escalated'));
    await assert.rejects(decideAs(a.instanceId, manager), /not named/);
    assert.equal((await decideAs(a.instanceId, director)).applied, true);

    // 2. The manager has a 2,000 limit: a 1,400 claim is theirs; a 3,000 claim is above it.
    await grantTo(manager, 2000);
    const { setManager } = await import('../src/runtime/org.js');
    await setManager(pool, admin, staff, { managerId: manager, effectiveFrom: '2026-01-01T00:00:00Z' });
    const b = await submitAs([{ line_description: 'Chair', line_amount: 1400 }]);
    assert.deepEqual(await requestFor(b.instanceId), [managerEmail]);
    assert.equal((await decideAs(b.instanceId, manager)).applied, true);
    const decided = (await engine.events(b.instanceId)).find((e) => e.type === 'approval_decided');
    assert.ok(decided, 'the decision is on the record');

    const c = await submitAs([{ line_description: 'Desk', line_amount: 3000 }]);
    // Above the manager's limit, so routing already escalated to the director.
    assert.deepEqual(await requestFor(c.instanceId), ['role:director']);
    const d = await submitAs([{ line_description: 'Screen', line_amount: 1900 }]);
    assert.deepEqual(await requestFor(d.instanceId), [managerEmail]);

    // 3. Defence in depth at decide time: lower the manager's limit after routing and the decision is refused.
    const grants = (await listAuthority(pool, admin)).grants.filter((g) => g.actor_id === manager && !g.revoked_at);
    for (const g of grants) await revokeGrant(pool, admin, g.id);
    await grantTo(manager, 1000);
    await assert.rejects(decideAs(d.instanceId, manager), /above your approval limit/);
    // Rejecting spends nothing and is still allowed.
    assert.equal((await decideAs(d.instanceId, manager, 'rejected')).applied, true);

    // 4. A delegate of the named manager may decide, under the manager's limit.
    const e = await submitAs([{ line_description: 'Books', line_amount: 800 }]);
    assert.deepEqual(await requestFor(e.instanceId), [managerEmail]);
    await assert.rejects(decideAs(e.instanceId, deputy), /not named/);
    await createDelegation(pool, { kind: 'actor', tenantId, actorId: manager }, { toActorId: deputy, scope: bp.key, validFrom: '2026-01-01T00:00:00Z' });
    const f = await submitAs([{ line_description: 'Bigger books', line_amount: 1200 }]);
    // 1,200 is above the manager's current 1,000, so routing escalated; drop the amount instead.
    assert.deepEqual(await requestFor(f.instanceId), ['role:director']);
    assert.equal((await decideAs(e.instanceId, deputy)).applied, true);
    const viaDelegate = (await pool.query<{ payload: { authority: { via: { kind: string } } } }>(
      "select payload from event where instance_id = $1 and type = 'approval_decided' order by seq desc limit 1", [e.instanceId])).rows[0]!;
    assert.equal(viaDelegate.payload.authority.via.kind, 'delegated');
  } finally { await pool.end(); }
});
