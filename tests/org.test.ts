import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { validate as compile } from '../src/compiler/validate.js';
import { applyUpgrades, createPool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { InvalidInput } from '../src/runtime/errors.js';
import { createLegalEntity, createOrgUnit, managerOf, orgChart, reportingHistory, setManager, setMemberPlacement, updateOrgUnit } from '../src/runtime/org.js';
import type { Principal } from '../src/runtime/policy.js';

// PRD Module 1 (ORG-02) and the routing rule in 4.3: the directory a
// workflow can route by, with the two things the tables cannot enforce on
// their own — no loops, and one dated primary line per person.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function workspace(engine: Engine, label: string) {
  const tenantId = await engine.createTenant(`org-${label}-${stamp()}`, { scenario: true });
  const adminId = await engine.createActor(tenantId, `admin-${stamp()}@org.test`, 'Admin', 'admin');
  const admin: Principal = { kind: 'actor', tenantId, actorId: adminId };
  return { tenantId, adminId, admin };
}

test('units nest, refuse loops, and stay inside their workspace', { skip: !localDatabase }, async () => {
  const pool = createPool();
  try {
    await applyUpgrades(pool);
    const engine = new Engine(pool);
    const { tenantId, admin } = await workspace(engine, 'units');
    const other = await workspace(engine, 'units-other');

    const entity = await createLegalEntity(pool, admin, { name: 'Alpha Ltd', code: 'ALPHA' });
    const ops = await createOrgUnit(pool, admin, { name: 'Operations', legalEntityId: entity.id });
    const lagos = await createOrgUnit(pool, admin, { name: 'Lagos', parentId: ops.id });
    const fleet = await createOrgUnit(pool, admin, { name: 'Fleet', parentId: lagos.id });

    // Operations under Fleet would make Operations its own ancestor.
    await assert.rejects(updateOrgUnit(pool, admin, ops.id, { parentId: fleet.id }), /inside itself/);
    await assert.rejects(updateOrgUnit(pool, admin, ops.id, { parentId: ops.id }), /inside itself/);
    // Moving a leaf is fine.
    const moved = await updateOrgUnit(pool, admin, fleet.id, { parentId: ops.id });
    assert.equal(moved.parent_id, ops.id);

    // Two "Lagos" under the same parent is a mistake; under different parents it is not.
    await assert.rejects(createOrgUnit(pool, admin, { name: 'lagos', parentId: ops.id }), /already a unit/);
    await createOrgUnit(pool, admin, { name: 'Lagos', parentId: fleet.id });

    // Another workspace's unit or entity cannot be used as a parent, by id.
    await assert.rejects(createOrgUnit(pool, other.admin, { name: 'Intruder', parentId: ops.id }), InvalidInput);
    await assert.rejects(createOrgUnit(pool, other.admin, { name: 'Intruder', legalEntityId: entity.id }), InvalidInput);
    await assert.rejects(updateOrgUnit(pool, other.admin, ops.id, { name: 'Renamed' }), InvalidInput);

    // Writes need `administer`; reads do not.
    const reader = await engine.createActor(tenantId, `reader-${stamp()}@org.test`, 'Reader', 'read_only');
    await assert.rejects(createOrgUnit(pool, { kind: 'actor', tenantId, actorId: reader }, { name: 'Nope' }), /administer/);
    const chart = await orgChart(pool, { kind: 'actor', tenantId, actorId: reader });
    assert.equal(chart.entities.length, 1);
    assert.equal(chart.units.length, 4);
    assert.equal(chart.units.find((u) => u.id === lagos.id)!.parent_id, ops.id);
  } finally { await pool.end(); }
});

test('a manager is a dated line: replacing closes the old one, loops are refused', { skip: !localDatabase }, async () => {
  const pool = createPool();
  try {
    await applyUpgrades(pool);
    const engine = new Engine(pool);
    const { tenantId, admin } = await workspace(engine, 'managers');
    const ceo = await engine.createActor(tenantId, `ceo-${stamp()}@org.test`, 'CEO', 'operator');
    const head = await engine.createActor(tenantId, `head-${stamp()}@org.test`, 'Head', 'operator');
    const staff = await engine.createActor(tenantId, `staff-${stamp()}@org.test`, 'Staff', 'operator');

    await setManager(pool, admin, head, { managerId: ceo });
    await setManager(pool, admin, staff, { managerId: head });
    // CEO reporting to Staff closes the loop CEO → Staff → Head → CEO.
    await assert.rejects(setManager(pool, admin, ceo, { managerId: staff }), /reporting loop/);
    await assert.rejects(setManager(pool, admin, staff, { managerId: staff }), /own manager/);

    // Same manager again is a no-op, not a second open line.
    assert.equal((await setManager(pool, admin, staff, { managerId: head })).changed, false);

    // Replace, back-dated: the old line is closed at the new start, both are kept.
    const from = new Date('2026-10-01T00:00:00Z');
    const change = await setManager(pool, admin, staff, { managerId: ceo, effectiveFrom: from.toISOString() });
    assert.equal(change.previousManagerId, head);
    const history = await reportingHistory(pool, admin, staff);
    assert.equal(history.length, 2);
    assert.equal(history[0]!.manager_id, ceo);
    assert.equal(history[0]!.effective_to, null);
    assert.equal(history[1]!.manager_id, head);
    assert.ok(history[1]!.effective_to);

    // Resolving "as of" a moment picks the line open then.
    assert.equal((await managerOf(pool, { tenantId, actorId: staff, at: new Date('2026-10-15T00:00:00Z') }))!.id, ceo);
    assert.equal((await managerOf(pool, { tenantId, actorId: head, at: new Date() }))!.id, ceo);

    // Removing a manager closes the line and leaves nobody.
    await setManager(pool, admin, staff, { managerId: null });
    assert.equal(await managerOf(pool, { tenantId, actorId: staff, at: new Date() }), null);
    assert.equal((await reportingHistory(pool, admin, staff)).every((l) => l.effective_to), true);

    // A deactivated person cannot be made a manager; another workspace's admin cannot touch these lines.
    await engine.deactivateActor(head);
    await assert.rejects(setManager(pool, admin, staff, { managerId: head }), /deactivated/);
    const other = await workspace(engine, 'managers-other');
    await assert.rejects(setManager(pool, other.admin, staff, { managerId: ceo }), InvalidInput);

    // Placement: unit, entity and title.
    const unit = await createOrgUnit(pool, admin, { name: 'Finance' });
    const placed = await setMemberPlacement(pool, admin, staff, { unitId: unit.id, positionTitle: 'Analyst' });
    assert.equal(placed.org_unit_id, unit.id);
    assert.equal(placed.position_title, 'Analyst');
    assert.equal((await orgChart(pool, admin)).units.find((u) => u.id === unit.id)!.members, 1);
  } finally { await pool.end(); }
});

test('an approval addressed to the submitter\'s manager routes by the directory, with a fallback or a visible stall', { skip: !localDatabase }, async () => {
  const raw = Blueprint.parse(JSON.parse(readFileSync('processes/expense-approval.blueprint.json', 'utf8')));
  const scenario = raw.tests.find((t) => t.name.includes('over £1000'))!;
  const submit = scenario.steps.find((step) => step.step === 'submit')!;
  if (submit.step !== 'submit') throw new Error('expected a submit step');

  // Staff submit from inside the workspace; the manager approval goes to
  // whoever the directory says, falling back to finance_ops.
  const bp = structuredClone(raw);
  bp.experience.access = { mode: 'workspace', role: 'claimant_staff' };
  bp.roles.push({ key: 'claimant_staff', name: 'Staff', kind: 'internal', capabilities: ['submit', 'view'] });
  bp.roles.find((r) => r.key === 'finance_ops')!.capabilities.push('approve');
  const approval = bp.workflow.approvals.find((a) => a.key === 'manager_approval')!;
  approval.approvers = [{ manager: 'submitter', fallback: 'finance_ops' }];
  const noFallback = structuredClone(bp);
  noFallback.workflow.approvals.find((a) => a.key === 'manager_approval')!.approvers = [{ manager: 'submitter' }];

  // The compiler accepts both, and warns about the one with no fallback.
  assert.equal(compile(bp).errors.length, 0, JSON.stringify(compile(bp).errors));
  const warned = compile(noFallback);
  assert.equal(warned.errors.length, 0);
  assert.ok(warned.warnings.some((w) => w.code === 'OPS012'), JSON.stringify(warned.warnings));

  const pool = createPool();
  try {
    await applyUpgrades(pool);
    const engine = new Engine(pool);
    const { tenantId, admin } = await workspace(engine, 'routing');
    const manager = await engine.createActor(tenantId, `boss-${stamp()}@org.test`, 'Boss', 'approver');
    const staff = await engine.createActor(tenantId, `sam-${stamp()}@org.test`, 'Sam', 'operator');
    const finance = await engine.createActor(tenantId, `fin-${stamp()}@org.test`, 'Fin', 'operator');
    const version = await engine.publish(tenantId, bp, 'test');
    for (const [actorId, roleKey] of [[staff, 'claimant_staff'], [manager, 'line_manager'], [finance, 'finance_ops']] as const) {
      await engine.grant({ tenantId, actorId, processKey: bp.key, roleKey });
    }
    const now = new Date('2026-10-19T09:00:00Z');
    // Each submission is a different claim (identity is email + date + cost
    // centre), or the engine would rightly fold the repeats into the first.
    let claim = 0;
    const submitAs = (v: typeof version) => engine.submit({
      version: v,
      answers: { ...submit.answers, expense_date: `2026-09-0${++claim}` },
      now, principal: { kind: 'actor', tenantId, actorId: staff },
    });
    const requestFor = async (instanceId: string) => {
      await engine.drain(now, 'test', tenantId);
      const { rows } = await pool.query<{ approvers: string[] }>(
        "select approvers from approval_request where instance_id = $1 and approval_key = 'manager_approval'", [instanceId]);
      return rows[0]?.approvers ?? null;
    };
    const eventsFor = async (instanceId: string) => (await engine.events(instanceId)).map((e) => e.type);

    // 1. No manager on file → the fallback role, and the record says so.
    const first = await submitAs(version);
    assert.deepEqual(await requestFor(first.instanceId), ['role:finance_ops']);
    assert.ok((await eventsFor(first.instanceId)).includes('approval_routed'));

    // 2. A manager on file → that person, by email, not the typed manager_email.
    // Dated before the record's clock, which is what the engine resolves against.
    await setManager(pool, admin, staff, { managerId: manager, effectiveFrom: '2026-10-01T00:00:00Z' });
    const second = await submitAs(version);
    const boss = (await engine.actor(manager))!.email;
    assert.deepEqual(await requestFor(second.instanceId), [boss]);
    assert.notEqual(boss, submit.answers['manager_email']);
    // ...and that person can decide it.
    const decided = await engine.decide({ instanceId: second.instanceId, approvalKey: 'manager_approval', decision: 'approved', reason: 'fine', principal: { kind: 'actor', tenantId, actorId: manager }, now });
    assert.equal(decided.applied, true);
    // ...while someone else holding the same role cannot: they are not named.
    const outsider = await engine.createActor(tenantId, `other-${stamp()}@org.test`, 'Other', 'approver');
    await engine.grant({ tenantId, actorId: outsider, processKey: bp.key, roleKey: 'line_manager' });
    const third = await submitAs(version);
    assert.deepEqual(await requestFor(third.instanceId), [boss]);
    await assert.rejects(
      engine.decide({ instanceId: third.instanceId, approvalKey: 'manager_approval', decision: 'approved', reason: 'no', principal: { kind: 'actor', tenantId, actorId: outsider }, now }),
      /not named/,
    );

    // 3. No manager and no fallback → nobody named, and a routing_unresolved event, never a guess.
    await setManager(pool, admin, staff, { managerId: null, effectiveFrom: '2026-10-02T00:00:00Z' });
    assert.equal(await managerOf(pool, { tenantId, actorId: staff, at: now }), null);
    const stalled = await engine.publish(tenantId, noFallback, 'test');
    const fourth = await submitAs(stalled);
    assert.deepEqual(await requestFor(fourth.instanceId), []);
    assert.ok((await eventsFor(fourth.instanceId)).includes('routing_unresolved'));
  } finally { await pool.end(); }
});
