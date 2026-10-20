import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { setManager } from '../src/runtime/org.js';
import { requestLeave, setTeamMember } from '../src/runtime/hr.js';
import { goHome } from '../src/runtime/go.js';
import type { Principal } from '../src/runtime/policy.js';

/** The phone screen: one call, only what the modules that are on can give. */
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const iso = (n: number) => new Date(Date.now() + (n + 7) * 86400000).toISOString().slice(0, 10);

test('the phone screen gathers leave to approve and my own leave once HR is on, and nothing before', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  const engine = new Engine(pool);
  try {
    const tenantId = await engine.createTenant(`go-${stamp()}`, { scenario: true });
    const mk = async (name: string, role: 'owner' | 'admin' | 'operator' | 'approver' | 'read_only') => {
      const id = await engine.createActor(tenantId, `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@go.test`, name, role);
      await pool.query('update actor set email_verified_at = now() where id = $1', [id]);
      return { id, p: { kind: 'actor', tenantId, actorId: id } as Principal };
    };
    const owner = await mk('Owner', 'owner');
    const manager = await mk('Mo Manager', 'approver');
    const staff = await mk('Sam Staff', 'read_only');

    const before = await goHome(pool, engine, staff.p, staff.id);
    assert.equal(before.leave, null, 'HR off: no leave on the phone');
    assert.deepEqual(before.approvals, []);
    assert.equal(before.late, 0);

    await setModule(pool, owner.p, 'hr', { enabled: true });
    await setTeamMember(pool, owner.p, { team: 'hr', actorId: owner.id });
    await setManager(pool, owner.p, staff.id, { managerId: manager.id, effectiveFrom: '2026-01-01T00:00:00Z' });
    await requestLeave(pool, staff.p, { type: 'annual', startDate: iso(0), endDate: iso(1), reason: 'Rest' });

    const mine = await goHome(pool, engine, staff.p, staff.id);
    assert.ok(mine.leave?.mine, 'my leave is on the phone');
    assert.ok(mine.leave!.mine!.balances.length > 0);
    assert.equal(mine.leave!.mine!.requests[0]?.status, 'requested');
    assert.deepEqual(mine.leave!.toApprove, [], 'nobody reports to Sam');

    const theirs = await goHome(pool, engine, manager.p, manager.id);
    assert.equal(theirs.leave?.toApprove.length, 1);
    assert.equal(theirs.leave!.toApprove[0]!.who, 'Sam Staff');
    assert.equal(theirs.leave!.toApprove[0]!.days, 2);

    await assert.rejects(goHome(pool, engine, { kind: 'respondent', tenantId }, staff.id), /sign in/);
  } finally { await pool.end(); }
});
