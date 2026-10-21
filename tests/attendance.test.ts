import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyUpgrades, createPool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { setManager } from '../src/runtime/org.js';
import { clockAction, decideException, reviewQueue, scheduleShift, teamSchedule, workday } from '../src/runtime/attendance.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);

test('clock events remain separate from shifts and a declined exception never erases recorded time', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    await applyUpgrades(pool);
    const engine = new Engine(pool);
    const tenantId = await engine.createTenant(`attendance-${randomUUID()}`, { scenario: true });
    const make = async (name: string, role: 'owner' | 'approver' | 'read_only') => {
      const actorId = await engine.createActor(tenantId, `${randomUUID()}@attendance.test`, name, role);
      return { actorId, principal: { kind: 'actor', tenantId, actorId } as Principal };
    };
    const owner = await make('Owner', 'owner');
    const manager = await make('Manager', 'approver');
    const staff = await make('Staff', 'read_only');
    assert.equal((await workday(pool, staff.principal)).available, false);
    await setModule(pool, owner.principal, 'attendance', { enabled: true });
    await setManager(pool, owner.principal, staff.actorId, { managerId: manager.actorId, effectiveFrom: '2026-01-01T00:00:00Z' });
    const now = Date.now();
    const shift = await scheduleShift(pool, manager.principal, { actorId: staff.actorId, startsAt: new Date(now - 60000).toISOString(), endsAt: new Date(now + 8 * 3600000).toISOString(), timezone: 'America/Chicago', workplace: 'Studio', roleName: 'Stylist' });
    assert.equal((await teamSchedule(pool, manager.principal)).shifts.some((s) => s.id === shift.id), true);
    assert.equal((await workday(pool, staff.principal)).shifts.some((s) => s.id === shift.id), true);
    assert.equal((await workday(pool, staff.principal)).current, null, 'opening Workday does not clock in');
    const firstKey = randomUUID();
    const started = await clockAction(pool, staff.principal, { kind: 'clock_in', shiftId: shift.id, idempotencyKey: firstKey });
    assert.equal(started.current?.shiftId, shift.id);
    assert.equal((await clockAction(pool, staff.principal, { kind: 'clock_in', shiftId: shift.id, idempotencyKey: firstKey })).repeated, true);
    await assert.rejects(clockAction(pool, staff.principal, { kind: 'clock_in', idempotencyKey: randomUUID() }), /already clocked in/);
    await clockAction(pool, staff.principal, { kind: 'break_start', idempotencyKey: randomUUID() });
    assert.equal((await workday(pool, staff.principal)).current?.state, 'break');
    await clockAction(pool, staff.principal, { kind: 'break_end', idempotencyKey: randomUUID() });
    await clockAction(pool, staff.principal, { kind: 'break_start', paid: true, idempotencyKey: randomUUID() });
    await clockAction(pool, staff.principal, { kind: 'break_end', idempotencyKey: randomUUID() });
    await clockAction(pool, staff.principal, { kind: 'clock_out', idempotencyKey: randomUUID() });
    assert.equal((await workday(pool, staff.principal)).current, null);
    const events = await pool.query<{ kind: string }>('select kind from attendance_event where session_id = $1 order by received_at', [started.current?.id]);
    assert.deepEqual(events.rows.map((e) => e.kind), ['clock_in', 'break_start', 'break_end', 'break_start', 'break_end', 'clock_out']);

    await pool.query(`update attendance_shift set starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' where id = $1`, [shift.id]);
    const unscheduled = await clockAction(pool, staff.principal, { kind: 'clock_in', reason: 'Covering another employee', idempotencyKey: randomUUID() });
    assert.equal(unscheduled.current?.reviewStatus, 'pending');
    assert.equal((await reviewQueue(pool, manager.principal)).some((r) => r.id === unscheduled.current?.id), true);
    await assert.rejects(decideException(pool, staff.principal, unscheduled.current!.id, { decision: 'approved' }), /cannot review/);
    await decideException(pool, manager.principal, unscheduled.current!.id, { decision: 'declined', note: 'Schedule was not authorized' });
    assert.equal((await workday(pool, staff.principal)).current?.reviewStatus, 'declined');
    assert.equal((await pool.query('select count(*)::int as n from attendance_event where session_id = $1', [unscheduled.current!.id])).rows[0].n, 1);
  } finally { await pool.end(); }
});
