import { randomUUID } from 'node:crypto';
import { inTransaction, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { enabledModules } from './modules.js';
import type { Principal } from './policy.js';

type Shift = { id: string; starts_at: Date; ends_at: Date; timezone: string; workplace: string | null; role_name: string | null };
type Session = { id: string; actor_id: string; shift_id: string | null; started_at: Date; ended_at: Date | null; state: 'working' | 'break' | 'closed'; break_started_at: Date | null; break_paid: boolean; paid_break_seconds: number; unpaid_break_seconds: number; exception_reason: string | null; review_status: string };

async function member(pool: Pool, principal: Principal) {
  if (principal.kind !== 'actor') throw new InvalidInput('Sign in to record time.');
  const modules = await enabledModules(pool, principal.tenantId);
  if (!modules.has('attendance')) return null;
  const { rows } = await pool.query<{ active: boolean; workspace_role: string }>(
    'select active, workspace_role from actor where id = $1 and tenant_id = $2', [principal.actorId, principal.tenantId]);
  if (!rows[0]?.active || rows[0].workspace_role === 'pre_hire') return null;
  const employee = await pool.query<{ status: string }>('select status from employee_record where tenant_id = $1 and actor_id = $2', [principal.tenantId, principal.actorId]);
  if (employee.rows[0] && !['active', 'leaving'].includes(employee.rows[0].status)) return null;
  return { tenantId: principal.tenantId, actorId: principal.actorId, role: rows[0].workspace_role };
}

async function requiredMember(pool: Pool, principal: Principal) {
  const who = await member(pool, principal);
  if (!who) throw new InvalidInput('Time & attendance is not available for this account.');
  return who;
}

async function canManage(pool: Pool, tenantId: string, actorId: string, subjectId: string) {
  const { rows } = await pool.query<{ allowed: boolean }>(
    `select (exists(select 1 from actor where id = $2 and tenant_id = $1 and active and workspace_role in ('owner','admin'))
         or exists(select 1 from reporting_line where tenant_id = $1 and actor_id = $3 and manager_id = $2
           and kind = 'primary' and effective_from <= now() and (effective_to is null or effective_to > now()))) as allowed`,
    [tenantId, actorId, subjectId]);
  return Boolean(rows[0]?.allowed);
}

function validId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new InvalidInput('Invalid identifier.');
  return value;
}

function present(session: Session | undefined | null) {
  if (!session) return null;
  return { id: session.id, shiftId: session.shift_id, startedAt: session.started_at,
    endedAt: session.ended_at, state: session.state, breakStartedAt: session.break_started_at,
    breakPaid: session.break_paid, paidBreakSeconds: session.paid_break_seconds,
    unpaidBreakSeconds: session.unpaid_break_seconds, exceptionReason: session.exception_reason,
    reviewStatus: session.review_status };
}
function presentShift(shift: Shift) {
  return { id: shift.id, startsAt: shift.starts_at, endsAt: shift.ends_at,
    timezone: shift.timezone, workplace: shift.workplace, roleName: shift.role_name };
}

/** A fast independent read so the Workday card can arrive before the wider phone inbox. */
export async function workday(pool: Pool, principal: Principal) {
  const who = await member(pool, principal);
  if (!who) return { available: false, current: null, shifts: [], recent: [] };
  const [open, shifts, recent] = await Promise.all([
    pool.query<Session>(`select * from attendance_session where tenant_id = $1 and actor_id = $2 and ended_at is null`, [who.tenantId, who.actorId]),
    pool.query<Shift>(`select * from attendance_shift where tenant_id = $1 and actor_id = $2 and ends_at > now() - interval '8 hours' and starts_at < now() + interval '7 days' order by starts_at limit 12`, [who.tenantId, who.actorId]),
    pool.query<Session>(`select * from attendance_session where tenant_id = $1 and actor_id = $2 and ended_at is not null order by started_at desc limit 7`, [who.tenantId, who.actorId]),
  ]);
  return { available: true, current: present(open.rows[0]), shifts: shifts.rows.map(presentShift), recent: recent.rows.map(present) };
}

/** All state changes are explicit, serialized on the actor row, and safe to retry with the same key. */
export async function clockAction(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const who = await requiredMember(pool, principal);
  const kind = body.kind;
  if (!['clock_in', 'break_start', 'break_end', 'clock_out'].includes(String(kind))) throw new InvalidInput('Choose a clock action.');
  const idempotencyKey = validId(body.idempotencyKey);
  const shiftId = body.shiftId == null ? null : validId(body.shiftId);
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  return inTransaction(pool, async (db) => {
    await db.query('select id from actor where id = $1 and tenant_id = $2 for update', [who.actorId, who.tenantId]);
    const existing = await db.query<{ session_id: string; kind: string }>(
      'select session_id, kind from attendance_event where tenant_id = $1 and actor_id = $2 and idempotency_key = $3',
      [who.tenantId, who.actorId, idempotencyKey]);
    if (existing.rows[0]) {
      if (existing.rows[0].kind !== kind) throw new InvalidInput('That action key was already used.');
      const saved = await db.query<Session>('select * from attendance_session where id = $1 and tenant_id = $2', [existing.rows[0].session_id, who.tenantId]);
      return { current: present(saved.rows[0]), repeated: true };
    }
    const open = await db.query<Session>('select * from attendance_session where tenant_id = $1 and actor_id = $2 and ended_at is null for update', [who.tenantId, who.actorId]);
    let session = open.rows[0];
    if (kind === 'clock_in') {
      if (session) throw new InvalidInput('You are already clocked in.');
      const candidates = await db.query<Shift>(
        `select * from attendance_shift where tenant_id = $1 and actor_id = $2
         and starts_at <= now() + interval '30 minutes' and ends_at >= now() - interval '2 hours'
         order by starts_at`, [who.tenantId, who.actorId]);
      const matching = shiftId ? candidates.rows.find((s) => s.id === shiftId) : candidates.rows.length === 1 ? candidates.rows[0] : null;
      if (shiftId && !matching) throw new InvalidInput('That shift is not available for clock-in.');
      if (candidates.rows.length > 1 && !shiftId) throw new InvalidInput('Choose the shift you are starting.');
      if (!matching && !reason) throw new InvalidInput('Tell your manager why you are starting without a scheduled shift.');
      const inserted = await db.query<Session>(
        `insert into attendance_session (tenant_id, actor_id, shift_id, exception_reason, review_status)
         values ($1,$2,$3,$4,$5) returning *`,
        [who.tenantId, who.actorId, matching?.id ?? null, matching ? null : reason, matching ? 'none' : 'pending']);
      session = inserted.rows[0];
    } else {
      if (!session) throw new InvalidInput('Clock in before recording this action.');
      if (kind === 'break_start') {
        if (session.state !== 'working') throw new InvalidInput('A break is already in progress.');
        session = (await db.query<Session>(`update attendance_session set state = 'break', break_started_at = now(), break_paid = $2 where id = $1 returning *`, [session.id, body.paid === true])).rows[0];
      } else if (kind === 'break_end') {
        if (session.state !== 'break') throw new InvalidInput('There is no break to end.');
        session = (await db.query<Session>(`update attendance_session set state = 'working',
          unpaid_break_seconds = unpaid_break_seconds + case when not break_paid then greatest(0, extract(epoch from (now() - break_started_at))::int) else 0 end,
          paid_break_seconds = paid_break_seconds + case when break_paid then greatest(0, extract(epoch from (now() - break_started_at))::int) else 0 end,
          break_started_at = null, break_paid = false
          where id = $1 returning *`, [session.id])).rows[0];
      } else {
        session = (await db.query<Session>(`update attendance_session set state = 'closed', ended_at = now(),
          unpaid_break_seconds = unpaid_break_seconds + case when state = 'break' and not break_paid then greatest(0, extract(epoch from (now() - break_started_at))::int) else 0 end,
          paid_break_seconds = paid_break_seconds + case when state = 'break' and break_paid then greatest(0, extract(epoch from (now() - break_started_at))::int) else 0 end,
          break_started_at = null, break_paid = false where id = $1 returning *`, [session.id])).rows[0];
      }
    }
    if (!session) throw new Error('Clock action did not create a session.');
    await db.query(`insert into attendance_event (id, tenant_id, session_id, actor_id, kind, idempotency_key)
      values ($1,$2,$3,$4,$5,$6)`, [randomUUID(), who.tenantId, session.id, who.actorId, kind, idempotencyKey]);
    return { current: present(session), repeated: false };
  });
}

export async function scheduleShift(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const who = await requiredMember(pool, principal);
  const actorId = validId(body.actorId);
  if (!await canManage(pool, who.tenantId, who.actorId, actorId)) throw new InvalidInput('Only this person’s manager or a workspace administrator can schedule them.');
  const start = new Date(String(body.startsAt ?? ''));
  const end = new Date(String(body.endsAt ?? ''));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end.getTime() - start.getTime() > 36 * 3600_000) throw new InvalidInput('Choose a valid shift of up to 36 hours.');
  const timezone = String(body.timezone ?? '').trim();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new InvalidInput('Choose a valid workplace time zone.'); }
  const actor = await pool.query('select id from actor where id = $1 and tenant_id = $2 and active and workspace_role <> $3', [actorId, who.tenantId, 'pre_hire']);
  if (!actor.rowCount) throw new InvalidInput('Choose an active member of this workspace.');
  const { rows } = await pool.query<Shift>(`insert into attendance_shift (tenant_id, actor_id, starts_at, ends_at, timezone, workplace, role_name, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [who.tenantId, actorId, start, end, timezone,
    typeof body.workplace === 'string' ? body.workplace.trim().slice(0, 150) || null : null,
    typeof body.roleName === 'string' ? body.roleName.trim().slice(0, 120) || null : null, who.actorId]);
  return presentShift(rows[0]!);
}

export async function teamSchedule(pool: Pool, principal: Principal) {
  const who = await requiredMember(pool, principal);
  const { rows: people } = await pool.query<{ id: string; display_name: string }>(
    `select a.id, a.display_name from actor a where a.tenant_id = $1 and a.active and a.workspace_role <> 'pre_hire'
       and (exists(select 1 from actor m where m.id = $2 and m.tenant_id = $1 and m.workspace_role in ('owner','admin'))
         or exists(select 1 from reporting_line r where r.tenant_id = $1 and r.actor_id = a.id and r.manager_id = $2
           and r.kind = 'primary' and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())))
     order by a.display_name limit 250`, [who.tenantId, who.actorId]);
  const { rows: shifts } = await pool.query<Shift & { actor_id: string; display_name: string }>(
    `select s.*, a.display_name from attendance_shift s join actor a on a.id = s.actor_id
     where s.tenant_id = $1 and s.starts_at >= now() - interval '1 day' and s.starts_at < now() + interval '14 days'
       and (exists(select 1 from actor m where m.id = $2 and m.tenant_id = $1 and m.workspace_role in ('owner','admin'))
         or exists(select 1 from reporting_line r where r.tenant_id = $1 and r.actor_id = s.actor_id and r.manager_id = $2
           and r.kind = 'primary' and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())))
     order by s.starts_at limit 250`, [who.tenantId, who.actorId]);
  return { people, shifts: shifts.map((s) => ({ ...presentShift(s), actorId: s.actor_id, employeeName: s.display_name })) };
}

export async function reviewQueue(pool: Pool, principal: Principal) {
  const who = await requiredMember(pool, principal);
  const { rows } = await pool.query<Session & { display_name: string }>(
    `select s.*, a.display_name from attendance_session s join actor a on a.id = s.actor_id
     where s.tenant_id = $1 and s.review_status = 'pending'
       and (exists(select 1 from actor m where m.id = $2 and m.tenant_id = $1 and m.workspace_role in ('owner','admin'))
         or exists(select 1 from reporting_line r where r.tenant_id = $1 and r.actor_id = s.actor_id and r.manager_id = $2
           and r.kind = 'primary' and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())))
     order by s.started_at desc limit 100`, [who.tenantId, who.actorId]);
  return rows.map((s) => ({ ...present(s), employeeId: s.actor_id, employeeName: s.display_name }));
}

export async function decideException(pool: Pool, principal: Principal, id: string, body: Record<string, unknown>) {
  const who = await requiredMember(pool, principal);
  const decision = body.decision;
  if (decision !== 'approved' && decision !== 'declined') throw new InvalidInput('Choose approve or decline.');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
  if (decision === 'declined' && !note) throw new InvalidInput('Explain why you declined the schedule exception.');
  return inTransaction(pool, async (db) => {
    const found = await db.query<Session & { actor_id: string }>('select * from attendance_session where id = $1 and tenant_id = $2 for update', [validId(id), who.tenantId]);
    const session = found.rows[0];
    if (!session || session.review_status !== 'pending') throw new InvalidInput('This exception is no longer waiting for review.');
    if (session.actor_id === who.actorId || !await canManage(pool, who.tenantId, who.actorId, session.actor_id)) throw new InvalidInput('You cannot review this clock-in.');
    const { rows } = await db.query<Session>(`update attendance_session set review_status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 where id = $1 returning *`,
      [id, decision, who.actorId, note || null]);
    return present(rows[0]);
  });
}
