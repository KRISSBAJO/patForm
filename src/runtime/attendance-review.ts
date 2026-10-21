import { inTransaction, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { recordWorkspaceAudit } from './authority.js';
import { canManage, requiredMember, validId } from './attendance.js';
import type { Principal } from './policy.js';

type Correction = { id: string; session_id: string; actor_id: string; status: string; proposed_started_at: Date; proposed_ended_at: Date; proposed_unpaid_break_seconds: number; reason: string; created_at: Date; decided_at: Date | null; decision_note: string | null; display_name?: string };
type Period = { id: string; name: string; starts_at: Date; ends_at: Date; status: string; created_at: Date; finalized_at: Date | null };
type SessionRow = { id: string; started_at: Date; ended_at: Date | null; unpaid_break_seconds: number; review_status: string; corrected_start: Date | null; corrected_end: Date | null; corrected_break: number | null; pending_correction: boolean };

function instant(value: unknown, label: string): Date {
  if (typeof value !== 'string') throw new InvalidInput(`Choose ${label}.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new InvalidInput(`Choose a valid ${label}.`);
  return date;
}
function note(value: unknown, label: string, max = 1000): string {
  const result = typeof value === 'string' ? value.trim().slice(0, max) : '';
  if (!result) throw new InvalidInput(`Add ${label}.`);
  return result;
}
function presentCorrection(c: Correction) {
  return { id: c.id, sessionId: c.session_id, employeeId: c.actor_id, employeeName: c.display_name,
    status: c.status, startsAt: c.proposed_started_at, endsAt: c.proposed_ended_at,
    unpaidBreakSeconds: c.proposed_unpaid_break_seconds, reason: c.reason,
    createdAt: c.created_at, decidedAt: c.decided_at, decisionNote: c.decision_note };
}

/** Employee proposals never alter the observed clock events or the original session times. */
export async function requestCorrection(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const who = await requiredMember(pool, principal);
  const sessionId = validId(body.sessionId);
  const starts = instant(body.startsAt, 'the corrected start time');
  const ends = instant(body.endsAt, 'the corrected end time');
  const unpaid = Number(body.unpaidBreakSeconds ?? 0);
  if (ends <= starts || ends.getTime() - starts.getTime() > 36 * 3600_000) throw new InvalidInput('Corrected work must be between 0 and 36 hours.');
  if (!Number.isSafeInteger(unpaid) || unpaid < 0 || unpaid >= (ends.getTime() - starts.getTime()) / 1000) throw new InvalidInput('Choose a valid unpaid break duration.');
  const reason = note(body.reason, 'why the time needs correction');
  return inTransaction(pool, async (db) => {
    await db.query('select id from actor where id = $1 and tenant_id = $2 for update', [who.actorId, who.tenantId]);
    const { rows: sessions } = await db.query<{ actor_id: string; ended_at: Date | null }>(
      'select actor_id, ended_at from attendance_session where id = $1 and tenant_id = $2 for update', [sessionId, who.tenantId]);
    if (sessions[0]?.actor_id !== who.actorId || !sessions[0]?.ended_at) throw new InvalidInput('Choose one of your completed workdays.');
    const pending = await db.query('select id from attendance_correction where tenant_id = $1 and session_id = $2 and status = $3', [who.tenantId, sessionId, 'pending']);
    if (pending.rowCount) throw new InvalidInput('A correction for this workday is already waiting for review.');
    const { rows } = await db.query<Correction>(`insert into attendance_correction
      (tenant_id, session_id, requested_by, proposed_started_at, proposed_ended_at, proposed_unpaid_break_seconds, reason)
      values ($1,$2,$3,$4,$5,$6,$7) returning *`, [who.tenantId, sessionId, who.actorId, starts, ends, unpaid, reason]);
    await db.query(`update attendance_timesheet set status = 'needs_review' where tenant_id = $1 and actor_id = $2
      and status = 'approved' and period_id in (select p.id from attendance_period p join attendance_session s on s.id = $3
        where p.tenant_id = $1 and p.status = 'open' and p.starts_at <= s.started_at and p.ends_at > s.started_at)`,
      [who.tenantId, who.actorId, sessionId]);
    await recordWorkspaceAudit(db, { tenantId: who.tenantId, actorId: who.actorId, action: 'attendance.correction_requested', targetId: rows[0]!.id, detail: { sessionId } });
    return presentCorrection({ ...rows[0]!, actor_id: who.actorId });
  });
}

export async function corrections(pool: Pool, principal: Principal, scope: 'mine' | 'team' = 'mine') {
  const who = await requiredMember(pool, principal);
  const { rows } = await pool.query<Correction>(`select c.*, s.actor_id, a.display_name from attendance_correction c
    join attendance_session s on s.id = c.session_id and s.tenant_id = c.tenant_id
    join actor a on a.id = s.actor_id
    where c.tenant_id = $1 and (
      ($3 = 'mine' and s.actor_id = $2) or
      ($3 = 'team' and c.status = 'pending' and s.actor_id <> $2 and
        (exists(select 1 from actor m where m.id = $2 and m.tenant_id = $1 and m.active and m.workspace_role in ('owner','admin'))
         or exists(select 1 from reporting_line r where r.tenant_id = $1 and r.actor_id = s.actor_id and r.manager_id = $2
           and r.kind = 'primary' and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())))))
    order by c.created_at desc limit 150`, [who.tenantId, who.actorId, scope]);
  return rows.map(presentCorrection);
}

export async function mySessions(pool: Pool, principal: Principal, pageInput: string | null) {
  const who = await requiredMember(pool, principal);
  const page = Math.min(1000, Math.max(0, Number.parseInt(pageInput ?? '0', 10) || 0));
  const [items, count] = await Promise.all([
    pool.query<SessionRow>(`select s.id, s.started_at, s.ended_at, s.unpaid_break_seconds, s.review_status,
      c.proposed_started_at as corrected_start, c.proposed_ended_at as corrected_end,
      c.proposed_unpaid_break_seconds as corrected_break,
      exists(select 1 from attendance_correction pc where pc.tenant_id = s.tenant_id and pc.session_id = s.id and pc.status = 'pending') as pending_correction
      from attendance_session s left join lateral (
        select proposed_started_at, proposed_ended_at, proposed_unpaid_break_seconds from attendance_correction
        where tenant_id = s.tenant_id and session_id = s.id and status = 'approved'
        order by decided_at desc, id desc limit 1
      ) c on true
      where s.tenant_id = $1 and s.actor_id = $2 order by s.started_at desc, s.id desc limit 25 offset $3`, [who.tenantId, who.actorId, page * 25]),
    pool.query<{ total: number }>('select count(*)::int as total from attendance_session where tenant_id = $1 and actor_id = $2', [who.tenantId, who.actorId]),
  ]);
  return { page, total: count.rows[0]?.total ?? 0, rows: items.rows.map((s) => ({ id: s.id, startedAt: s.started_at, endedAt: s.ended_at,
    unpaidBreakSeconds: s.unpaid_break_seconds, reviewStatus: s.review_status, correctedStart: s.corrected_start,
    correctedEnd: s.corrected_end, correctedBreak: s.corrected_break, pendingCorrection: s.pending_correction })) };
}

export async function decideCorrection(pool: Pool, principal: Principal, correctionId: string, body: Record<string, unknown>) {
  const who = await requiredMember(pool, principal);
  const id = validId(correctionId);
  const decision = body.decision;
  if (decision !== 'approved' && decision !== 'declined') throw new InvalidInput('Choose approve or decline.');
  const explanation = decision === 'declined' ? note(body.note, 'a reason for declining') : (typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '');
  return inTransaction(pool, async (db) => {
    const subject = await db.query<{ actor_id: string }>(`select s.actor_id from attendance_correction c
      join attendance_session s on s.id = c.session_id where c.id = $1 and c.tenant_id = $2`, [id, who.tenantId]);
    if (!subject.rows[0]) throw new InvalidInput('Correction not found.');
    await db.query('select id from actor where id = $1 and tenant_id = $2 for update', [subject.rows[0].actor_id, who.tenantId]);
    const { rows } = await db.query<Correction & { actual_start: Date; actual_end: Date; actual_break: number }>(`select c.*, s.actor_id,
      s.started_at as actual_start, s.ended_at as actual_end, s.unpaid_break_seconds as actual_break from attendance_correction c
      join attendance_session s on s.id = c.session_id where c.id = $1 and c.tenant_id = $2 for update`, [id, who.tenantId]);
    const correction = rows[0];
    if (!correction || correction.status !== 'pending') throw new InvalidInput('This correction is no longer waiting for review.');
    if (correction.actor_id === who.actorId || !await canManage(pool, who.tenantId, who.actorId, correction.actor_id)) throw new InvalidInput('You cannot decide this correction.');
    const previous = decision === 'approved' ? (await db.query<Pick<Correction, 'proposed_started_at' | 'proposed_ended_at' | 'proposed_unpaid_break_seconds'>>(`select proposed_started_at, proposed_ended_at, proposed_unpaid_break_seconds
      from attendance_correction where tenant_id = $1 and session_id = $2 and status = 'approved'
      order by decided_at desc, id desc limit 1`, [who.tenantId, correction.session_id])).rows[0] : undefined;
    await db.query(`update attendance_correction set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`,
      [id, decision, who.actorId, explanation || null]);
    if (decision === 'approved') {
      const priorSeconds = Math.max(0, Math.round(((previous?.proposed_ended_at ?? correction.actual_end).getTime() -
        (previous?.proposed_started_at ?? correction.actual_start).getTime()) / 1000) -
        (previous?.proposed_unpaid_break_seconds ?? correction.actual_break));
      const nextSeconds = Math.max(0, Math.round((correction.proposed_ended_at.getTime() - correction.proposed_started_at.getTime()) / 1000) - correction.proposed_unpaid_break_seconds);
      const finalized = await db.query<{ id: string }>(`select id from attendance_period where tenant_id = $1 and status = 'finalized'
        and starts_at <= $2 and ends_at > $2 for update`, [who.tenantId, correction.actual_start]);
      if (finalized.rows[0]) {
        await db.query(`insert into attendance_adjustment (tenant_id, period_id, actor_id, correction_id, delta_seconds)
          values ($1,$2,$3,$4,$5)`, [who.tenantId, finalized.rows[0].id, correction.actor_id, id, nextSeconds - priorSeconds]);
      }
      // Keep an earlier approved snapshot readable, but require fresh approval before an open period closes.
      await db.query(`update attendance_timesheet set status = 'needs_review' where tenant_id = $1 and actor_id = $2
        and status = 'approved' and period_id in (select p.id from attendance_period p join attendance_session s on s.id = $3
          where p.tenant_id = $1 and p.status = 'open' and p.starts_at <= s.started_at and p.ends_at > s.started_at)`,
        [who.tenantId, correction.actor_id, correction.session_id]);
    }
    await recordWorkspaceAudit(db, { tenantId: who.tenantId, actorId: who.actorId, action: `attendance.correction_${decision}`, targetId: id, detail: { sessionId: correction.session_id, note: explanation } });
    return { id, status: decision };
  });
}

function presentPeriod(p: Period) { return { id: p.id, name: p.name, startsAt: p.starts_at, endsAt: p.ends_at, status: p.status, createdAt: p.created_at, finalizedAt: p.finalized_at }; }
function requireAdmin(role: string) { if (!['owner', 'admin'].includes(role)) throw new InvalidInput('A workspace administrator must manage pay periods.'); }

export async function createPeriod(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const who = await requiredMember(pool, principal); requireAdmin(who.role);
  const name = note(body.name, 'a period name', 100);
  const starts = instant(body.startsAt, 'the period start');
  const ends = instant(body.endsAt, 'the period end');
  if (ends <= starts || ends.getTime() - starts.getTime() > 35 * 86400_000) throw new InvalidInput('Choose a period of up to 35 days.');
  return inTransaction(pool, async (db) => {
    const overlaps = await db.query(`select id from attendance_period where tenant_id = $1 and starts_at < $3 and ends_at > $2`, [who.tenantId, starts, ends]);
    if (overlaps.rowCount) throw new InvalidInput('This period overlaps an existing one.');
    const { rows } = await db.query<Period>(`insert into attendance_period (tenant_id, name, starts_at, ends_at, created_by)
      values ($1,$2,$3,$4,$5) returning *`, [who.tenantId, name, starts, ends, who.actorId]);
    await recordWorkspaceAudit(db, { tenantId: who.tenantId, actorId: who.actorId, action: 'attendance.period_created', targetId: rows[0]!.id, detail: { name, startsAt: starts, endsAt: ends } });
    return presentPeriod(rows[0]!);
  });
}

export async function listPeriods(pool: Pool, principal: Principal) {
  const who = await requiredMember(pool, principal);
  const { rows } = await pool.query<Period>('select * from attendance_period where tenant_id = $1 order by starts_at desc limit 50', [who.tenantId]);
  return rows.map(presentPeriod);
}

async function period(pool: Pool, tenantId: string, id: string) {
  const { rows } = await pool.query<Period>('select * from attendance_period where id = $1 and tenant_id = $2', [validId(id), tenantId]);
  if (!rows[0]) throw new InvalidInput('Pay period not found.');
  return rows[0];
}

async function summarize(pool: Pick<Pool, 'query'>, tenantId: string, actorId: string, p: Period) {
  const { rows } = await pool.query<SessionRow>(`select s.id, s.started_at, s.ended_at, s.unpaid_break_seconds, s.review_status,
     c.proposed_started_at as corrected_start, c.proposed_ended_at as corrected_end,
     c.proposed_unpaid_break_seconds as corrected_break,
     exists(select 1 from attendance_correction pc where pc.tenant_id = s.tenant_id and pc.session_id = s.id and pc.status = 'pending') as pending_correction
    from attendance_session s left join lateral (
      select proposed_started_at, proposed_ended_at, proposed_unpaid_break_seconds from attendance_correction
      where tenant_id = s.tenant_id and session_id = s.id and status = 'approved'
      order by decided_at desc, id desc limit 1
    ) c on true
    where s.tenant_id = $1 and s.actor_id = $2 and s.started_at >= $3 and s.started_at < $4
    order by s.started_at`, [tenantId, actorId, p.starts_at, p.ends_at]);
  let recordedSeconds = 0; let proposedSeconds = 0;
  const issues: string[] = [];
  for (const row of rows) {
    const actualStart = row.started_at.getTime();
    const actualEnd = row.ended_at?.getTime();
    const start = (row.corrected_start ?? row.started_at).getTime();
    const end = (row.corrected_end ?? row.ended_at)?.getTime();
    if (!actualEnd || !end) { issues.push('Open workday'); continue; }
    if (start < p.starts_at.getTime() || end > p.ends_at.getTime() || actualStart < p.starts_at.getTime() || actualEnd > p.ends_at.getTime()) { issues.push('Workday crosses a period boundary'); continue; }
    recordedSeconds += Math.max(0, Math.round((actualEnd - actualStart) / 1000) - row.unpaid_break_seconds);
    proposedSeconds += Math.max(0, Math.round((end - start) / 1000) - (row.corrected_break ?? row.unpaid_break_seconds));
    if (row.pending_correction) issues.push('Correction waiting for review');
    if (row.review_status === 'pending') issues.push('Schedule exception waiting for review');
  }
  return { recordedSeconds, proposedSeconds, sessions: rows.length, issues: [...new Set(issues)] };
}

/** A member sees their own summary; managers see only their team. */
export async function periodDetail(pool: Pool, principal: Principal, periodId: string) {
  const who = await requiredMember(pool, principal);
  const p = await period(pool, who.tenantId, periodId);
  const { rows: people } = await pool.query<{ id: string; display_name: string }>(`select distinct a.id, a.display_name from actor a
    join attendance_session s on s.actor_id = a.id and s.tenant_id = a.tenant_id
    where a.tenant_id = $1 and s.started_at >= $3 and s.started_at < $4 and
      (a.id = $2 or exists(select 1 from actor m where m.id = $2 and m.tenant_id = $1 and m.active and m.workspace_role in ('owner','admin'))
       or exists(select 1 from reporting_line r where r.tenant_id = $1 and r.actor_id = a.id and r.manager_id = $2
         and r.kind = 'primary' and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())))
    order by a.display_name limit 250`, [who.tenantId, who.actorId, p.starts_at, p.ends_at]);
  const { rows: approvals } = await pool.query<{ actor_id: string; status: string; approved_seconds: number; approved_at: Date; approval_note: string | null }>(
    'select actor_id, status, approved_seconds, approved_at, approval_note from attendance_timesheet where tenant_id = $1 and period_id = $2', [who.tenantId, p.id]);
  const byActor = new Map(approvals.map((a) => [a.actor_id, a]));
  const peopleRows = await Promise.all(people.map(async (person) => ({
    actorId: person.id, name: person.display_name, ...await summarize(pool, who.tenantId, person.id, p),
    approval: byActor.get(person.id) ?? null,
    canApprove: person.id !== who.actorId && await canManage(pool, who.tenantId, who.actorId, person.id),
  })));
  const { rows: adjustments } = await pool.query<{ id: string; actor_id: string; delta_seconds: number; created_at: Date; display_name: string }>(
    `select j.id, j.actor_id, j.delta_seconds, j.created_at, a.display_name from attendance_adjustment j
      join actor a on a.id = j.actor_id and a.tenant_id = j.tenant_id
      where j.tenant_id = $1 and j.period_id = $2 and
        (j.actor_id = $3 or exists(select 1 from actor m where m.id = $3 and m.tenant_id = $1 and m.active and m.workspace_role in ('owner','admin'))
         or exists(select 1 from reporting_line r where r.tenant_id = $1 and r.actor_id = j.actor_id and r.manager_id = $3
           and r.kind = 'primary' and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())))
      order by j.created_at desc`, [who.tenantId, p.id, who.actorId]);
  return { period: presentPeriod(p), people: peopleRows, adjustments: adjustments.map((j) => ({ id: j.id, actorId: j.actor_id,
    employeeName: j.display_name, deltaSeconds: j.delta_seconds, createdAt: j.created_at })) };
}

function csvCell(value: unknown) {
  const raw = String(value ?? '');
  const safe = typeof value !== 'number' && /^[=+@\-\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}\"`;
}

/** Payroll input only: approved time and separately identified post-close adjustments. */
export async function exportPeriod(pool: Pool, principal: Principal, periodId: string) {
  const who = await requiredMember(pool, principal); requireAdmin(who.role);
  const p = await period(pool, who.tenantId, periodId);
  if (p.status !== 'finalized') throw new InvalidInput('Finalize the period before exporting approved hours.');
  const { rows } = await pool.query<{ actor_id: string; display_name: string; payroll_ref: string | null; recorded_seconds: number; approved_seconds: number; approved_at: Date }>(
    `select t.actor_id, a.display_name, e.payroll_ref, t.recorded_seconds, t.approved_seconds, t.approved_at
      from attendance_timesheet t join actor a on a.id = t.actor_id and a.tenant_id = t.tenant_id
      left join employee_record e on e.actor_id = t.actor_id and e.tenant_id = t.tenant_id
      where t.tenant_id = $1 and t.period_id = $2 and t.status = 'approved' order by a.display_name, t.actor_id`, [who.tenantId, p.id]);
  const { rows: adjustments } = await pool.query<{ id: string; actor_id: string; display_name: string; payroll_ref: string | null; delta_seconds: number; created_at: Date }>(
    `select j.id, j.actor_id, a.display_name, e.payroll_ref, j.delta_seconds, j.created_at
      from attendance_adjustment j join actor a on a.id = j.actor_id and a.tenant_id = j.tenant_id
      left join employee_record e on e.actor_id = j.actor_id and e.tenant_id = j.tenant_id
      where j.tenant_id = $1 and j.period_id = $2 order by j.created_at, j.id`, [who.tenantId, p.id]);
  const columns = ['row_type','row_id','period_id','period_name','employee_id','employee_name','payroll_reference',
    'recorded_seconds','approved_seconds','adjustment_seconds','approved_or_created_at'];
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(['approved_time', `${p.id}:${row.actor_id}`, p.id, p.name, row.actor_id,
    row.display_name, row.payroll_ref, row.recorded_seconds, row.approved_seconds, '', row.approved_at.toISOString()].map(csvCell).join(','));
  for (const row of adjustments) lines.push(['post_close_adjustment', row.id, p.id, p.name, row.actor_id,
    row.display_name, row.payroll_ref, '', '', row.delta_seconds, row.created_at.toISOString()].map(csvCell).join(','));
  await recordWorkspaceAudit(pool, { tenantId: who.tenantId, actorId: who.actorId, action: 'attendance.hours_exported',
    targetId: p.id, detail: { approvedRows: rows.length, adjustmentRows: adjustments.length } });
  return { filename: `approved-hours-${p.starts_at.toISOString().slice(0, 10)}-${p.id.slice(0, 8)}.csv`,
    contentType: 'text/csv', body: '\ufeff' + lines.join('\r\n') + '\r\n' };
}

export async function approveTimesheet(pool: Pool, principal: Principal, periodId: string, actorId: string, body: Record<string, unknown>) {
  const who = await requiredMember(pool, principal);
  const subjectId = validId(actorId);
  if (subjectId === who.actorId || !await canManage(pool, who.tenantId, who.actorId, subjectId)) throw new InvalidInput('You cannot approve this timesheet.');
  const approvalNote = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
  return inTransaction(pool, async (db) => {
    await db.query('select id from actor where id = $1 and tenant_id = $2 for update', [subjectId, who.tenantId]);
    const { rows: periodRows } = await db.query<Period>('select * from attendance_period where id = $1 and tenant_id = $2 for update', [validId(periodId), who.tenantId]);
    const p = periodRows[0];
    if (!p) throw new InvalidInput('Pay period not found.');
    if (p.status !== 'open') throw new InvalidInput('This period is finalized. Corrections must become a later adjustment.');
    const total = await summarize(db, who.tenantId, subjectId, p);
    if (!total.sessions) throw new InvalidInput('There are no recorded workdays for this person in the period.');
    if (total.issues.length) throw new InvalidInput(`Resolve these issues first: ${total.issues.join(', ')}.`);
    const declined = await db.query(`select 1 from attendance_session where tenant_id = $1 and actor_id = $2 and started_at >= $3 and started_at < $4 and review_status = 'declined' limit 1`,
      [who.tenantId, subjectId, p.starts_at, p.ends_at]);
    if (declined.rowCount && !approvalNote) throw new InvalidInput('Explain why recorded time is payable despite a declined schedule exception.');
    const { rows } = await db.query(`insert into attendance_timesheet
      (tenant_id, period_id, actor_id, recorded_seconds, approved_seconds, status, approval_note, approved_by)
      values ($1,$2,$3,$4,$5,'approved',$6,$7)
      on conflict (period_id, actor_id) do update set recorded_seconds = excluded.recorded_seconds,
        approved_seconds = excluded.approved_seconds, status = 'approved', approval_note = excluded.approval_note,
        approved_by = excluded.approved_by, approved_at = now() returning id`,
      [who.tenantId, p.id, subjectId, total.recordedSeconds, total.proposedSeconds, approvalNote || null, who.actorId]);
    await recordWorkspaceAudit(db, { tenantId: who.tenantId, actorId: who.actorId, action: 'attendance.timesheet_approved', targetId: rows[0]!.id, detail: { periodId: p.id, actorId: subjectId, ...total, note: approvalNote } });
    return { actorId: subjectId, approvedSeconds: total.proposedSeconds };
  });
}

export async function finalizePeriod(pool: Pool, principal: Principal, periodId: string) {
  const who = await requiredMember(pool, principal); requireAdmin(who.role);
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query<Period>('select * from attendance_period where id = $1 and tenant_id = $2 for update', [validId(periodId), who.tenantId]);
    const p = rows[0];
    if (!p || p.status !== 'open') throw new InvalidInput('Choose an open period.');
    if (p.ends_at.getTime() > Date.now()) throw new InvalidInput('Wait until the pay period has ended before finalizing it.');
    const unapproved = await db.query(`select distinct s.actor_id from attendance_session s left join attendance_timesheet t
      on t.period_id = $2 and t.actor_id = s.actor_id and t.status = 'approved'
      where s.tenant_id = $1 and s.started_at >= $3 and s.started_at < $4 and t.id is null limit 1`,
      [who.tenantId, p.id, p.starts_at, p.ends_at]);
    if (unapproved.rowCount) throw new InvalidInput('Every person with recorded time needs an approved timesheet first.');
    await db.query('update attendance_period set status = $2, finalized_by = $3, finalized_at = now() where id = $1', [p.id, 'finalized', who.actorId]);
    await recordWorkspaceAudit(db, { tenantId: who.tenantId, actorId: who.actorId, action: 'attendance.period_finalized', targetId: p.id });
    return { id: p.id, status: 'finalized' };
  });
}
