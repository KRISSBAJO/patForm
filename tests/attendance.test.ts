import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyUpgrades, createPool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { setManager } from '../src/runtime/org.js';
import { clockAction, decideException, reviewQueue, scheduleShift, teamSchedule, workday } from '../src/runtime/attendance.js';
import { approveTimesheet, corrections, createPeriod, decideCorrection, exportPeriod, finalizePeriod, periodDetail, requestCorrection } from '../src/runtime/attendance-review.js';
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
    const earlyShift = await scheduleShift(pool, manager.principal, { actorId: staff.actorId,
      startsAt: new Date(Date.now() + 25 * 60000).toISOString(), endsAt: new Date(Date.now() + 8 * 3600000).toISOString(),
      timezone: 'America/Chicago', workplace: 'Studio' });
    const early = await clockAction(pool, staff.principal, { kind: 'clock_in', shiftId: earlyShift.id, idempotencyKey: randomUUID() });
    assert.equal(early.current?.reviewStatus, 'pending', 'an early start is recorded but reviewed');
    await decideException(pool, manager.principal, early.current!.id, { decision: 'approved' });
    await clockAction(pool, staff.principal, { kind: 'clock_out', idempotencyKey: randomUUID() });
    await pool.query(`update attendance_shift set starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' where id = $1`, [earlyShift.id]);
    const unscheduled = await clockAction(pool, staff.principal, { kind: 'clock_in', reason: 'Covering another employee', idempotencyKey: randomUUID() });
    assert.equal(unscheduled.current?.reviewStatus, 'pending');
    assert.equal((await reviewQueue(pool, manager.principal)).some((r) => r.id === unscheduled.current?.id), true);
    await assert.rejects(decideException(pool, staff.principal, unscheduled.current!.id, { decision: 'approved' }), /cannot review/);
    await decideException(pool, manager.principal, unscheduled.current!.id, { decision: 'declined', note: 'Schedule was not authorized' });
    assert.equal((await workday(pool, staff.principal)).current?.reviewStatus, 'declined');
    assert.equal((await pool.query('select count(*)::int as n from attendance_event where session_id = $1', [unscheduled.current!.id])).rows[0].n, 1);
  } finally { await pool.end(); }
});

test('corrections keep actual times, managers approve timesheets, and finalized periods remain fixed', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    await applyUpgrades(pool);
    const engine = new Engine(pool);
    const tenantId = await engine.createTenant(`attendance-review-${randomUUID()}`, { scenario: true });
    const make = async (name: string, role: 'owner' | 'approver' | 'read_only') => {
      const actorId = await engine.createActor(tenantId, `${randomUUID()}@attendance.test`, name, role);
      return { actorId, principal: { kind: 'actor', tenantId, actorId } as Principal };
    };
    const owner = await make('Owner', 'owner');
    const manager = await make('Manager', 'approver');
    const staff = await make('Staff', 'read_only');
    await setModule(pool, owner.principal, 'attendance', { enabled: true });
    await setManager(pool, owner.principal, staff.actorId, { managerId: manager.actorId, effectiveFrom: '2026-01-01T00:00:00Z' });
    const now = Date.now();
    const shift = await scheduleShift(pool, manager.principal, { actorId: staff.actorId, startsAt: new Date(now - 60000).toISOString(), endsAt: new Date(now + 3600000).toISOString(), timezone: 'America/Chicago' });
    const started = await clockAction(pool, staff.principal, { kind: 'clock_in', shiftId: shift.id, idempotencyKey: randomUUID() });
    await clockAction(pool, staff.principal, { kind: 'clock_out', idempotencyKey: randomUUID() });
    const original = (await pool.query<{ started_at: Date; ended_at: Date }>('select started_at, ended_at from attendance_session where id = $1', [started.current!.id])).rows[0]!;
    const p = await createPeriod(pool, owner.principal, { name: 'Pilot period', startsAt: new Date(now - 3600000).toISOString(), endsAt: new Date(now + 86400000).toISOString() });
    const correction = await requestCorrection(pool, staff.principal, { sessionId: started.current!.id, startsAt: new Date(now - 900000).toISOString(), endsAt: new Date(now - 10000).toISOString(), unpaidBreakSeconds: 300, reason: 'The start and end times were missed' });
    assert.equal((await corrections(pool, manager.principal, 'team')).some((item) => item.id === correction.id), true);
    await assert.rejects(approveTimesheet(pool, manager.principal, p.id, staff.actorId, {}), /Correction waiting for review/);
    await assert.rejects(decideCorrection(pool, staff.principal, correction.id, { decision: 'approved' }), /cannot decide/);
    await decideCorrection(pool, manager.principal, correction.id, { decision: 'approved' });
    const actual = (await pool.query<{ started_at: Date; ended_at: Date }>('select started_at, ended_at from attendance_session where id = $1', [started.current!.id])).rows[0]!;
    assert.equal(actual.started_at.getTime(), original.started_at.getTime());
    assert.equal(actual.ended_at.getTime(), original.ended_at.getTime());
    await assert.rejects(approveTimesheet(pool, staff.principal, p.id, staff.actorId, {}), /cannot approve/);
    const approved = await approveTimesheet(pool, manager.principal, p.id, staff.actorId, {});
    assert.ok(approved.approvedSeconds > 0);
    assert.equal((await periodDetail(pool, staff.principal, p.id)).people[0]?.approval?.status, 'approved');
    await pool.query(`update attendance_period set ends_at = now() - interval '1 millisecond' where id = $1`, [p.id]);
    await finalizePeriod(pool, owner.principal, p.id);
    const originalExport = await exportPeriod(pool, owner.principal, p.id);
    assert.match(originalExport.body, /approved_time/);
    assert.match(originalExport.body, new RegExp(String(approved.approvedSeconds)));
    await assert.rejects(exportPeriod(pool, staff.principal, p.id), /administrator/);
    await assert.rejects(approveTimesheet(pool, manager.principal, p.id, staff.actorId, {}), /finalized/);
    const later = await requestCorrection(pool, staff.principal, { sessionId: started.current!.id, startsAt: new Date(now - 1200000).toISOString(), endsAt: new Date(now - 5000).toISOString(), reason: 'Later discovery' });
    await decideCorrection(pool, manager.principal, later.id, { decision: 'approved' });
    const frozen = (await periodDetail(pool, staff.principal, p.id)).people[0]?.approval;
    assert.equal(frozen?.status, 'approved');
    assert.equal(frozen?.approved_seconds, approved.approvedSeconds);
    const adjusted = await periodDetail(pool, staff.principal, p.id);
    assert.equal(adjusted.adjustments.length, 1);
    assert.ok(adjusted.adjustments[0]!.deltaSeconds > 0);
    const laterExport = await exportPeriod(pool, owner.principal, p.id);
    assert.match(laterExport.body, /post_close_adjustment/);
    assert.match(laterExport.body, new RegExp(adjusted.adjustments[0]!.id));
  } finally { await pool.end(); }
});
