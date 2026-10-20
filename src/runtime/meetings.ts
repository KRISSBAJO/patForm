/**
 * Meetings and resolutions.
 *
 * A board, a committee or a management team is a *body*: people with roles
 * (chair, secretary, member, observer), a quorum rule and a decision rule.
 * A body holds meetings and passes resolutions; both leave an append-only
 * record (mtg_event) that a register and an auditor can rely on.
 *
 * The rules that matter:
 *   - Notice. A meeting is "called" only with the notice period the
 *     workspace set, unless the caller records a reason for short notice.
 *     Calling sends the notice with the agenda; everyone can RSVP.
 *   - Quorum. A meeting starts when the voting members marked present
 *     satisfy the body's quorum rule. The chair may start an inquorate
 *     meeting for discussion, with a recorded note, but no resolution can
 *     be opened in it.
 *   - Votes. One vote per voting member. In a meeting only members marked
 *     present can vote; a written resolution is open to every voting member
 *     until its deadline. The secretary or chair may record a vote on behalf
 *     of a present member and the record says who recorded it.
 *   - Decision. Simple majority, two-thirds or unanimous, applied to votes
 *     cast in a meeting and to all eligible members for a written resolution
 *     (an unanswered written vote is not a yes). A tie falls to the chair's
 *     casting vote only if the body allows one and the chair voted.
 *   - Minutes. Written per agenda item while the meeting runs; approved by
 *     someone other than the person who wrote them. Approval produces the
 *     minutes PDF and closes the meeting; the text cannot change after that.
 *   - Signing. A passed resolution can go to Patform Sign: its PDF is
 *     generated here, the body's signatories sign (as a company through its
 *     register number when the body has one), and the signed copy comes
 *     back to the register with its fingerprint.
 *   - Actions. Agreed in a meeting with an owner and a date; shown to the
 *     owner, reminded, and only the owner or the secretary closes them.
 */
import { createHash, randomUUID } from 'node:crypto';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { enabledModules } from './modules.js';
import { objectStore } from './object-store.js';
import { appUrl, sendPlatformMail, type PlatformMailKind } from './platform-mail.js';
import { renderPdf, type Block } from './pdf.js';
import { createEnvelope, sendEnvelope } from './esign.js';
import type { Attachment } from './email.js';

const UUID = /^[0-9a-f-]{36}$/;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[, ]/g, '')); return Number.isFinite(n) ? n : NaN; };
const DAY = 86_400_000;
function id(v: unknown, what: string): string { const s = text(v, 36); if (!UUID.test(s)) throw new InvalidInput(`${what} must be an id`); return s; }
function when(v: unknown, what: string, required = false): Date | null {
  if (v === undefined || v === null || v === '') { if (required) throw new InvalidInput(`${what} is required`); return null; }
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new InvalidInput(`${what} must be a date and time`);
  return d;
}
function day(v: unknown, what: string): string | null {
  const s = text(v, 10);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new InvalidInput(`${what} must be a date`);
  return s;
}
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ mail

type Mail = { kind: PlatformMailKind; to: string; subject: string; text: string; tenantId: string; idempotencyKey: string; attachments?: Attachment[] };
let mailer: (pool: Pool | Client, m: Mail) => Promise<void> = async (pool, m) => { await sendPlatformMail(pool as Pool, m); };
export function setMeetingMailerForTests(fn: ((pool: Pool | Client, m: Mail) => Promise<void>) | null) {
  mailer = fn ?? (async (pool, m) => { await sendPlatformMail(pool as Pool, m); });
}

// ------------------------------------------------------------- invitation

const icsText = (v: string) => v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** Folds lines at 75 octets as RFC 5545 asks. */
const fold = (line: string) => { const out: string[] = []; let rest = line; while (Buffer.byteLength(rest) > 73) { let cut = 73; while (Buffer.byteLength(rest.slice(0, cut)) > 73) cut -= 1; out.push(rest.slice(0, cut)); rest = ' ' + rest.slice(cut); } out.push(rest); return out.join('\r\n'); };

/**
 * A calendar invitation for a meeting, as every calendar understands it.
 * The UID is the meeting id, so a changed time or a cancellation updates
 * the same entry; the sequence number rises with each change.
 */
export function meetingIcs(args: { id: string; title: string; body: string; startsAt: Date; endsAt: Date | null; location: string | null; link: string | null; agenda: string[]; sequence: number; cancelled?: boolean; organiser?: { name: string; email: string } | null; attendee?: { name: string; email: string } | null; url?: string }): string {
  const end = args.endsAt ?? new Date(args.startsAt.getTime() + 3600_000);
  const description = [`${args.body}: ${args.title}`, '', 'Agenda:', ...args.agenda.map((a, i) => `${i + 1}. ${a}`), ...(args.link ? ['', `Join: ${args.link}`] : []), ...(args.url ? ['', `In Patform: ${args.url}`] : [])].join('\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Patform//Meetings//EN', `METHOD:${args.cancelled ? 'CANCEL' : 'REQUEST'}`,
    'BEGIN:VEVENT', `UID:${args.id}@patform`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(args.startsAt)}`, `DTEND:${icsDate(end)}`,
    `SEQUENCE:${args.sequence}`, `SUMMARY:${icsText(args.title)}`, `DESCRIPTION:${icsText(description)}`,
    ...(args.location ? [`LOCATION:${icsText(args.location)}`] : []), ...(args.link ? [`URL:${args.link}`] : []),
    `STATUS:${args.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    ...(args.organiser ? [`ORGANIZER;CN=${icsText(args.organiser.name)}:mailto:${args.organiser.email}`] : []),
    ...(args.attendee ? [`ATTENDEE;CN=${icsText(args.attendee.name)};ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${args.attendee.email}`] : []),
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(args.title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

async function invitationFor(client: Client | Pool, m: { id: string; body_id: string; title: string; starts_at: Date; ends_at: Date | null; location: string | null; link: string | null; sequence?: number; created_by?: string | null }, attendee: { display_name: string; email: string }, cancelled = false): Promise<Attachment> {
  const { rows: b } = await client.query<{ name: string }>('select name from mtg_body where id = $1', [m.body_id]);
  const { rows: items } = await client.query<{ title: string }>('select title from mtg_agenda_item where meeting_id = $1 order by position', [m.id]);
  const { rows: org } = m.created_by ? await client.query<{ display_name: string; email: string }>('select display_name, email from actor where id = $1', [m.created_by]) : { rows: [] as { display_name: string; email: string }[] };
  const ics = meetingIcs({ id: m.id, title: m.title, body: b[0]?.name ?? 'Meeting', startsAt: m.starts_at, endsAt: m.ends_at, location: m.location, link: m.link, agenda: items.map((i) => i.title), sequence: m.sequence ?? 0, cancelled,
    organiser: org[0] ? { name: org[0].display_name, email: org[0].email } : null, attendee: { name: attendee.display_name, email: attendee.email }, url: `${appUrl()}/console?view=meetings&meeting=${m.id}` });
  return { filename: cancelled ? 'cancelled.ics' : 'invite.ics', content: Buffer.from(ics, 'utf8'), contentType: `text/calendar; charset=utf-8; method=${cancelled ? 'CANCEL' : 'REQUEST'}` };
}

// ---------------------------------------------------------------- access

export type BodyRole = 'chair' | 'secretary' | 'member' | 'observer';
interface Membership { bodyId: string; role: BodyRole; voting: boolean; signatory: boolean }
interface Who { tenantId: string; actorId: string; admin: boolean; role: string; bodies: Membership[] }

async function who(pool: Pool | Client, principal: Principal): Promise<Who> {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  if (!(await enabledModules(pool as Pool, principal.tenantId)).has('meetings')) {
    throw new InvalidInput('the Meetings module is switched off for this workspace — an owner can switch it on in Settings');
  }
  const { rows } = await pool.query<{ workspace_role: string; active: boolean }>('select workspace_role, active from actor where id = $1 and tenant_id = $2', [principal.actorId, principal.tenantId]);
  if (!rows[0]?.active || rows[0].workspace_role === 'pre_hire') throw new InvalidInput('this opens after your first day');
  if (rows[0].workspace_role === 'auditor') throw new InvalidInput('auditors see only their engagement');
  const admin = ['owner', 'admin'].includes(rows[0].workspace_role);
  const { rows: m } = await pool.query<{ body_id: string; role: BodyRole; voting: boolean; signatory: boolean }>(
    'select body_id, role, voting, signatory from mtg_body_member where tenant_id = $1 and actor_id = $2 and until is null', [principal.tenantId, principal.actorId]);
  return { tenantId: principal.tenantId, actorId: principal.actorId, admin, role: rows[0].workspace_role, bodies: m.map((r) => ({ bodyId: r.body_id, role: r.role, voting: r.voting, signatory: r.signatory })) };
}
const member = (w: Who, bodyId: string) => w.bodies.find((b) => b.bodyId === bodyId) ?? null;
const canSee = (w: Who, bodyId: string) => w.admin || member(w, bodyId) !== null;
const canManage = (w: Who, bodyId: string) => w.admin || ['chair', 'secretary'].includes(member(w, bodyId)?.role ?? '');
const isChair = (w: Who, bodyId: string) => member(w, bodyId)?.role === 'chair';
const canVote = (w: Who, bodyId: string) => { const m = member(w, bodyId); return Boolean(m && m.voting && m.role !== 'observer'); };
const requireSee = (w: Who, bodyId: string) => { if (!canSee(w, bodyId)) throw new InvalidInput('you are not a member of this body'); };
const requireManage = (w: Who, bodyId: string) => { if (!canManage(w, bodyId)) throw new InvalidInput('only the chair, the secretary or an admin can do this'); };
const requireAdmin = (w: Who) => { if (!w.admin) throw new InvalidInput('only an owner or admin can do this'); };

async function nextNumber(client: Client, table: 'mtg_meeting' | 'mtg_resolution' | 'mtg_action', scopeCol: 'body_id' | 'tenant_id', scope: string): Promise<number> {
  await client.query('select pg_advisory_xact_lock(hashtext($1 || $2))', [table, scope]);
  const { rows } = await client.query<{ n: number }>(`select coalesce(max(number), 0) + 1 as n from ${table} where ${scopeCol} = $1`, [scope]);
  return rows[0]!.n;
}

async function event(client: Client | Pool, e: { tenantId: string; bodyId?: string | null; meetingId?: string | null; resolutionId?: string | null; actorId: string | null; kind: string; detail?: unknown }) {
  await client.query(
    'insert into mtg_event (tenant_id, body_id, meeting_id, resolution_id, actor_id, kind, detail) values ($1, $2, $3, $4, $5, $6, $7)',
    [e.tenantId, e.bodyId ?? null, e.meetingId ?? null, e.resolutionId ?? null, e.actorId, e.kind, JSON.stringify(e.detail ?? {})]);
}

// -------------------------------------------------------------- settings

export interface MeetingSettings {
  /** Calendar days of notice a meeting needs before it can be called. */
  noticeDays: number;
  /** Hours before a meeting the reminder goes out. */
  reminderHours: number;
  /** Days before an action is due that its owner is reminded. */
  actionReminderDays: number;
  /** Days a written resolution stays open by default. */
  writtenDays: number;
}
export const DEFAULT_MEETING_SETTINGS: MeetingSettings = { noticeDays: 7, reminderHours: 24, actionReminderDays: 2, writtenDays: 7 };

export async function meetingSettings(client: Client | Pool, tenantId: string): Promise<MeetingSettings> {
  const { rows } = await client.query<{ settings: Partial<MeetingSettings> }>('select settings from mtg_settings where tenant_id = $1', [tenantId]);
  return { ...DEFAULT_MEETING_SETTINGS, ...(rows[0]?.settings ?? {}) };
}
export async function readMeetingSettings(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  return { settings: await meetingSettings(pool, w.tenantId), me: { admin: w.admin, bodies: w.bodies } };
}
export async function updateMeetingSettings(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireAdmin(w);
  const cur = await meetingSettings(pool, w.tenantId);
  const next = { ...cur };
  const bound = (k: keyof MeetingSettings, lo: number, hi: number) => {
    if (body[k] === undefined) return;
    const n = Math.trunc(num(body[k]));
    if (!(n >= lo && n <= hi)) throw new InvalidInput(`${k} must be ${lo} to ${hi}`);
    next[k] = n;
  };
  bound('noticeDays', 0, 60); bound('reminderHours', 0, 168); bound('actionReminderDays', 0, 30); bound('writtenDays', 1, 60);
  await pool.query('insert into mtg_settings (tenant_id, settings, updated_by) values ($1, $2, $3) on conflict (tenant_id) do update set settings = excluded.settings, updated_by = excluded.updated_by, updated_at = now()',
    [w.tenantId, JSON.stringify(next), w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'meetings.settings_changed', targetId: w.tenantId, detail: { before: cur, after: next } });
  return next;
}

// ----------------------------------------------------------------- bodies

export type QuorumRule = { type: 'fraction'; value: number } | { type: 'count'; value: number };
export type DecisionRule = { type: 'simple_majority' | 'two_thirds' | 'unanimous'; chairCasting: boolean };

function readQuorum(v: unknown): QuorumRule {
  const o = (v ?? {}) as { type?: unknown; value?: unknown };
  const value = num(o.value);
  if (o.type === 'count') { if (!(Number.isInteger(value) && value >= 1)) throw new InvalidInput('a quorum by count must be a whole number of at least 1'); return { type: 'count', value }; }
  if (!(value > 0 && value <= 1)) throw new InvalidInput('a quorum by fraction must be above 0 and at most 1 (0.5 is half)');
  return { type: 'fraction', value };
}
function readDecision(v: unknown): DecisionRule {
  const o = (v ?? {}) as { type?: unknown; chairCasting?: unknown };
  const type = ['simple_majority', 'two_thirds', 'unanimous'].includes(String(o.type)) ? (o.type as DecisionRule['type']) : 'simple_majority';
  return { type, chairCasting: o.chairCasting !== false };
}
export function quorumMet(rule: QuorumRule, present: number, votingMembers: number): boolean {
  if (rule.type === 'count') return present >= rule.value;
  return votingMembers > 0 && present >= Math.ceil(rule.value * votingMembers) && present > 0;
}
/**
 * The result of a vote. Meeting votes count what was cast; written
 * resolutions count every eligible member, so silence is not consent.
 */
export function decide(rule: DecisionRule, v: { for: number; against: number; abstain: number; eligible: number; written: boolean; chairVote?: 'for' | 'against' | 'abstain' | null }): { passed: boolean; why: string } {
  const cast = v.for + v.against;
  const base = v.written ? v.eligible : cast;
  if (rule.type === 'unanimous') {
    const ok = v.against === 0 && v.for > 0 && v.for === v.eligible;
    return { passed: ok, why: ok ? `unanimous: all ${v.eligible} eligible voted for` : `not unanimous: ${v.for} of ${v.eligible} eligible voted for, ${v.against} against, ${v.abstain} abstained` };
  }
  if (rule.type === 'two_thirds') {
    const need = Math.ceil((2 / 3) * base);
    const ok = base > 0 && v.for >= need;
    return { passed: ok, why: `${v.for} for, ${v.against} against, ${v.abstain} abstained; two-thirds of ${v.written ? 'eligible' : 'votes cast'} (${need} of ${base}) ${ok ? 'reached' : 'not reached'}` };
  }
  if (v.written) {
    const ok = v.for > base / 2;
    return { passed: ok, why: `${v.for} for, ${v.against} against, ${v.abstain} abstained; majority of ${base} eligible ${ok ? 'reached' : 'not reached'}` };
  }
  if (v.for > v.against) return { passed: true, why: `${v.for} for, ${v.against} against, ${v.abstain} abstained` };
  if (v.for === v.against && rule.chairCasting && (v.chairVote === 'for' || v.chairVote === 'against')) {
    return { passed: v.chairVote === 'for', why: `${v.for} for, ${v.against} against: tie decided by the chair's casting vote (${v.chairVote})` };
  }
  return { passed: false, why: v.for === v.against ? `${v.for} for, ${v.against} against: tied, no casting vote` : `${v.for} for, ${v.against} against, ${v.abstain} abstained` };
}

export async function listBodies(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query<{ id: string; name: string; kind: string; quorum_rule: QuorumRule; decision_rule: DecisionRule; company_name: string | null; register: unknown; signatures_required: number; written_resolutions: boolean; proxies_allowed: boolean; max_proxies: number; active: boolean; members: number; next_meeting: string | null }>(
    `select b.id, b.name, b.kind, b.quorum_rule, b.decision_rule, b.company_name, b.register, b.signatures_required, b.written_resolutions, b.proxies_allowed, b.max_proxies, b.active,
            (select count(*)::int from mtg_body_member m where m.body_id = b.id and m.until is null) as members,
            (select min(starts_at)::text from mtg_meeting x where x.body_id = b.id and x.status in ('called', 'in_progress') and x.starts_at > now() - interval '1 day') as next_meeting
       from mtg_body b where b.tenant_id = $1 order by b.active desc, b.name`, [w.tenantId]);
  return rows.filter((b) => canSee(w, b.id)).map((b) => ({ ...b, my_role: member(w, b.id)?.role ?? null, can_manage: canManage(w, b.id) }));
}

export async function saveBody(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const bodyId = body.id ? id(body.id, 'id') : null;
  if (bodyId) requireManage(w, bodyId); else requireAdmin(w);
  const name = text(body.name, 120);
  if (!name) throw new InvalidInput('give the body a name');
  const kind = ['board', 'committee', 'management', 'general'].includes(String(body.kind)) ? String(body.kind) : 'committee';
  const quorum = readQuorum(body.quorum ?? body.quorum_rule);
  const decision = readDecision(body.decision ?? body.decision_rule);
  const companyName = text(body.companyName, 200) || null;
  const reg = (body.register ?? null) as { country?: unknown; number?: unknown } | null;
  const register = reg && text(reg.number, 40) ? { country: text(reg.country, 2).toUpperCase() || 'GB', number: text(reg.number, 40) } : null;
  const required = body.signaturesRequired === undefined ? 1 : Math.trunc(num(body.signaturesRequired));
  if (!(required >= 1 && required <= 20)) throw new InvalidInput('signaturesRequired must be 1 to 20');
  const written = body.writtenResolutions !== false;
  const proxies = body.proxiesAllowed === true;
  const maxProxies = body.maxProxies === undefined ? 2 : Math.trunc(num(body.maxProxies));
  if (!(maxProxies >= 1 && maxProxies <= 50)) throw new InvalidInput('maxProxies must be 1 to 50');
  return inTransaction(pool, async (client) => {
    let resultId = bodyId;
    if (bodyId) {
      await client.query(`update mtg_body set name = $2, kind = $3, quorum_rule = $4, decision_rule = $5, company_name = $6, register = $7, signatures_required = $8, written_resolutions = $9, active = $10, proxies_allowed = $12, max_proxies = $13 where id = $1 and tenant_id = $11`,
        [bodyId, name, kind, JSON.stringify(quorum), JSON.stringify(decision), companyName, register ? JSON.stringify(register) : null, required, written, body.active !== false, w.tenantId, proxies, maxProxies]);
    } else {
      const { rows } = await client.query<{ id: string }>(
        `insert into mtg_body (tenant_id, name, kind, quorum_rule, decision_rule, company_name, register, signatures_required, written_resolutions, created_by, proxies_allowed, max_proxies) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [w.tenantId, name, kind, JSON.stringify(quorum), JSON.stringify(decision), companyName, register ? JSON.stringify(register) : null, required, written, w.actorId, proxies, maxProxies]);
      resultId = rows[0]!.id;
    }
    await event(client, { tenantId: w.tenantId, bodyId: resultId, actorId: w.actorId, kind: bodyId ? 'body_changed' : 'body_created', detail: { name, kind, quorum, decision, companyName, register, required } });
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: bodyId ? 'meetings.body_changed' : 'meetings.body_created', targetId: resultId, detail: { name, quorum, decision } });
    return { id: resultId };
  });
}

export async function setBodyMember(pool: Pool, principal: Principal, bodyId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal); requireManage(w, bodyId);
  const actorId = id(body.actorId, 'actorId');
  const role: BodyRole = ['chair', 'secretary', 'member', 'observer'].includes(String(body.role)) ? (body.role as BodyRole) : 'member';
  const voting = role === 'observer' ? false : body.voting !== false;
  const signatory = role !== 'observer' && (body.signatory === true || (body.signatory === undefined && role === 'chair'));
  return inTransaction(pool, async (client) => {
    const { rows: a } = await client.query<{ display_name: string; active: boolean; workspace_role: string }>('select display_name, active, workspace_role from actor where id = $1 and tenant_id = $2', [actorId, w.tenantId]);
    if (!a[0]?.active) throw new InvalidInput('that person is not an active member of the workspace');
    if (a[0].workspace_role === 'auditor') throw new InvalidInput('an auditor cannot sit on a body');
    if (body.remove === true) {
      const { rowCount } = await client.query('update mtg_body_member set until = current_date where body_id = $1 and actor_id = $2 and until is null', [bodyId, actorId]);
      if (!rowCount) throw new InvalidInput('that person is not on this body');
      await event(client, { tenantId: w.tenantId, bodyId, actorId: w.actorId, kind: 'member_removed', detail: { actorId, name: a[0].display_name } });
      return { removed: true };
    }
    if (role === 'chair') {
      // One chair at a time: the previous chair becomes a member.
      await client.query(`update mtg_body_member set role = 'member' where body_id = $1 and role = 'chair' and actor_id <> $2 and until is null`, [bodyId, actorId]);
    }
    await client.query(
      `insert into mtg_body_member (tenant_id, body_id, actor_id, role, voting, signatory) values ($1, $2, $3, $4, $5, $6)
       on conflict (body_id, actor_id) where until is null do update set role = excluded.role, voting = excluded.voting, signatory = excluded.signatory`,
      [w.tenantId, bodyId, actorId, role, voting, signatory]);
    await event(client, { tenantId: w.tenantId, bodyId, actorId: w.actorId, kind: 'member_set', detail: { actorId, name: a[0].display_name, role, voting, signatory } });
    return { role, voting, signatory };
  });
}

export async function bodyDetail(pool: Pool, principal: Principal, bodyId: string) {
  const w = await who(pool, principal); requireSee(w, bodyId);
  const { rows: b } = await pool.query('select * from mtg_body where id = $1 and tenant_id = $2', [bodyId, w.tenantId]);
  if (!b[0]) throw new InvalidInput('no such body');
  const { rows: members } = await pool.query(
    `select m.actor_id, a.display_name, a.email, m.role, m.voting, m.signatory, m.since::text from mtg_body_member m join actor a on a.id = m.actor_id
      where m.body_id = $1 and m.until is null order by case m.role when 'chair' then 0 when 'secretary' then 1 when 'member' then 2 else 3 end, a.display_name`, [bodyId]);
  const { rows: recent } = await pool.query(
    `select id, number, title, kind, status, starts_at::text, quorum_met from mtg_meeting where body_id = $1 order by starts_at desc limit 12`, [bodyId]);
  const { rows: events } = await pool.query(
    `select e.kind, e.detail, e.occurred_at::text, a.display_name as actor from mtg_event e left join actor a on a.id = e.actor_id where e.body_id = $1 and e.meeting_id is null and e.resolution_id is null order by e.id desc limit 30`, [bodyId]);
  return { body: b[0], members, meetings: recent, events, can_manage: canManage(w, bodyId), my_role: member(w, bodyId)?.role ?? null };
}

// --------------------------------------------------------------- meetings

async function loadMeeting(client: Client | Pool, tenantId: string, meetingId: string) {
  const { rows } = await client.query<{ id: string; body_id: string; number: number; title: string; kind: string; status: string; starts_at: Date; ends_at: Date | null; location: string | null; link: string | null; notice_sent_at: Date | null; quorum_met: boolean | null; quorum_note: string | null; chaired_by: string | null; minutes_author: string | null; minutes_approved_by: string | null; minutes_file_id: string | null; short_notice_reason: string | null; cancel_reason: string | null; created_by: string | null; sequence: number }>(
    'select * from mtg_meeting where id = $1 and tenant_id = $2', [meetingId, tenantId]);
  if (!rows[0]) throw new InvalidInput('no such meeting');
  return rows[0];
}

async function votingMembers(client: Client | Pool, bodyId: string): Promise<{ actor_id: string; display_name: string; email: string; role: BodyRole }[]> {
  const { rows } = await client.query<{ actor_id: string; display_name: string; email: string; role: BodyRole }>(
    `select m.actor_id, a.display_name, a.email, m.role from mtg_body_member m join actor a on a.id = m.actor_id where m.body_id = $1 and m.until is null and m.voting and m.role <> 'observer' and a.active`, [bodyId]);
  return rows;
}
async function allMembers(client: Client | Pool, bodyId: string): Promise<{ actor_id: string; display_name: string; email: string; role: BodyRole }[]> {
  const { rows } = await client.query<{ actor_id: string; display_name: string; email: string; role: BodyRole }>(
    `select m.actor_id, a.display_name, a.email, m.role from mtg_body_member m join actor a on a.id = m.actor_id where m.body_id = $1 and m.until is null and a.active`, [bodyId]);
  return rows;
}

export async function listMeetings(pool: Pool, principal: Principal, filter: { bodyId?: string; scope?: string } = {}) {
  const w = await who(pool, principal);
  const { rows } = await pool.query<{ id: string; body_id: string; body: string; number: number; title: string; kind: string; status: string; starts_at: string; ends_at: string | null; location: string | null; quorum_met: boolean | null; items: number; my_rsvp: string | null; chair: string | null }>(
    `select m.id, m.body_id, b.name as body, m.number, m.title, m.kind, m.status, m.starts_at::text, m.ends_at::text, m.location, m.quorum_met,
            (select count(*)::int from mtg_agenda_item i where i.meeting_id = m.id) as items,
            (select rsvp from mtg_attendance t where t.meeting_id = m.id and t.actor_id = $2) as my_rsvp,
            (select display_name from actor where id = m.chaired_by) as chair
       from mtg_meeting m join mtg_body b on b.id = m.body_id
      where m.tenant_id = $1 and ($3::uuid is null or m.body_id = $3)
        and ($4 <> 'upcoming' or (m.status in ('draft', 'called', 'in_progress') and m.starts_at > now() - interval '12 hours'))
        and ($4 <> 'past' or m.status in ('minutes_draft', 'minutes_approved', 'cancelled') or m.starts_at <= now() - interval '12 hours')
      order by m.starts_at desc limit 200`,
    [w.tenantId, w.actorId, filter.bodyId && UUID.test(filter.bodyId) ? filter.bodyId : null, filter.scope ?? 'all']);
  return rows.filter((m) => canSee(w, m.body_id)).map((m) => ({ ...m, can_manage: canManage(w, m.body_id) }));
}

export async function createMeeting(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const bodyId = id(body.bodyId, 'bodyId'); requireManage(w, bodyId);
  const title = text(body.title, 200); if (!title) throw new InvalidInput('give the meeting a title');
  const startsAt = when(body.startsAt, 'startsAt', true)!;
  const endsAt = when(body.endsAt, 'endsAt');
  if (endsAt && endsAt <= startsAt) throw new InvalidInput('the meeting ends before it starts');
  const kind = ['ordinary', 'extraordinary', 'annual'].includes(String(body.kind)) ? String(body.kind) : 'ordinary';
  return inTransaction(pool, async (client) => {
    const { rows: b } = await client.query<{ active: boolean }>('select active from mtg_body where id = $1 and tenant_id = $2', [bodyId, w.tenantId]);
    if (!b[0]?.active) throw new InvalidInput('that body is not active');
    const number = await nextNumber(client, 'mtg_meeting', 'body_id', bodyId);
    const { rows } = await client.query<{ id: string }>(
      `insert into mtg_meeting (tenant_id, body_id, number, title, kind, starts_at, ends_at, location, link, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [w.tenantId, bodyId, number, title, kind, startsAt, endsAt, text(body.location, 200) || null, text(body.link, 500) || null, w.actorId]);
    const meetingId = rows[0]!.id;
    const items = Array.isArray(body.agenda) ? body.agenda : [];
    if (items.length) await writeAgenda(client, w, meetingId, items);
    await event(client, { tenantId: w.tenantId, bodyId, meetingId, actorId: w.actorId, kind: 'meeting_created', detail: { number, title, startsAt } });
    return { id: meetingId, number };
  });
}

async function writeAgenda(client: Client, w: Who, meetingId: string, items: unknown[]) {
  await client.query('delete from mtg_agenda_item where meeting_id = $1 and tenant_id = $2 and id not in (select coalesce(agenda_item_id, gen_random_uuid()) from mtg_resolution where meeting_id = $1 union select coalesce(agenda_item_id, gen_random_uuid()) from mtg_action where meeting_id = $1)', [meetingId, w.tenantId]);
  const kept = await client.query<{ id: string }>('select id from mtg_agenda_item where meeting_id = $1', [meetingId]);
  const keptIds = new Set(kept.rows.map((r) => r.id));
  let position = 0;
  for (const raw of items.slice(0, 60)) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const title = text(o.title, 300); if (!title) continue;
    position += 1;
    const purpose = ['information', 'discussion', 'decision', 'resolution'].includes(String(o.purpose)) ? String(o.purpose) : 'discussion';
    const presenter = o.presenterId ? id(o.presenterId, 'presenterId') : null;
    const duration = o.durationMin === undefined || o.durationMin === '' ? null : Math.trunc(num(o.durationMin));
    const papers = (Array.isArray(o.papers) ? o.papers : []).map((p) => { const x = (p ?? {}) as Record<string, unknown>; return { ref: text(x.ref, 60), filename: text(x.filename, 200) }; }).filter((p) => /^gov-file:[0-9a-f-]{36}$/.test(p.ref));
    const existing = o.id && UUID.test(String(o.id)) && keptIds.has(String(o.id)) ? String(o.id) : null;
    if (existing) {
      await client.query('update mtg_agenda_item set position = $2, title = $3, purpose = $4, presenter_id = $5, duration_min = $6, papers = $7 where id = $1', [existing, position, title, purpose, presenter, duration, JSON.stringify(papers)]);
    } else {
      await client.query('insert into mtg_agenda_item (tenant_id, meeting_id, position, title, purpose, presenter_id, duration_min, papers) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [w.tenantId, meetingId, position, title, purpose, presenter, duration, JSON.stringify(papers)]);
    }
  }
}

export async function updateMeeting(pool: Pool, principal: Principal, meetingId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const m = await loadMeeting(client, w.tenantId, meetingId); requireManage(w, m.body_id);
    if (!['draft', 'called'].includes(m.status)) throw new InvalidInput('the agenda and details can change only before the meeting starts');
    const title = body.title === undefined ? m.title : text(body.title, 200);
    if (!title) throw new InvalidInput('give the meeting a title');
    const startsAt = body.startsAt === undefined ? m.starts_at : when(body.startsAt, 'startsAt', true)!;
    const endsAt = body.endsAt === undefined ? m.ends_at : when(body.endsAt, 'endsAt');
    if (endsAt && endsAt <= startsAt) throw new InvalidInput('the meeting ends before it starts');
    const location = body.location === undefined ? m.location : text(body.location, 200) || null;
    const link = body.link === undefined ? m.link : text(body.link, 500) || null;
    const moved = m.status === 'called' && (startsAt.getTime() !== m.starts_at.getTime() || (endsAt?.getTime() ?? null) !== (m.ends_at?.getTime() ?? null) || location !== m.location || link !== m.link);
    await client.query('update mtg_meeting set title = $2, starts_at = $3, ends_at = $4, location = $5, link = $6, sequence = sequence + $7 where id = $1',
      [meetingId, title, startsAt, endsAt, location, link, moved ? 1 : 0]);
    if (Array.isArray(body.agenda)) await writeAgenda(client, w, meetingId, body.agenda);
    if (moved) {
      // A called meeting that moves: everyone's calendar entry is updated, not duplicated.
      const fresh = await loadMeeting(client, w.tenantId, meetingId);
      for (const p of await allMembers(client, m.body_id)) {
        await mailer(client, { kind: 'meeting_notice', to: p.email, tenantId: w.tenantId, idempotencyKey: `mtg-moved:${meetingId}:${fresh.sequence}:${p.actor_id}`, attachments: [await invitationFor(client, fresh, p)],
          subject: `Changed: ${title}`, text: `Hello ${p.display_name},\n\n"${title}" now takes place ${startsAt.toUTCString()}${location ? ` at ${location}` : ''}.${link ? `\nJoin: ${link}` : ''}\n\nYour calendar entry is updated by the attached invitation.\n` });
      }
    }
    await event(client, { tenantId: w.tenantId, bodyId: m.body_id, meetingId, actorId: w.actorId, kind: 'meeting_changed', detail: { title, startsAt, agenda: Array.isArray(body.agenda) ? body.agenda.length : undefined } });
    return { ok: true };
  });
}

/** Sends the notice. The notice period is the workspace's unless a reason for short notice is recorded. */
export async function callMeeting(pool: Pool, principal: Principal, meetingId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const settings = await meetingSettings(pool, w.tenantId);
  return inTransaction(pool, async (client) => {
    const m = await loadMeeting(client, w.tenantId, meetingId); requireManage(w, m.body_id);
    if (m.status !== 'draft') throw new InvalidInput('this meeting has already been called');
    const { rows: items } = await client.query<{ title: string; purpose: string; position: number }>('select title, purpose, position from mtg_agenda_item where meeting_id = $1 order by position', [meetingId]);
    if (!items.length) throw new InvalidInput('add at least one agenda item before calling the meeting');
    const daysNotice = (m.starts_at.getTime() - Date.now()) / DAY;
    const shortReason = text(body.shortNoticeReason, 500) || null;
    if (daysNotice < settings.noticeDays && !shortReason) throw new InvalidInput(`this body needs ${settings.noticeDays} days' notice; the meeting is in ${Math.max(0, Math.floor(daysNotice))}. Record a reason to call it at short notice.`);
    if (m.starts_at.getTime() < Date.now()) throw new InvalidInput('the meeting is in the past');
    const members = await allMembers(client, m.body_id);
    if (!members.length) throw new InvalidInput('this body has no members to notify');
    const { rows: b } = await client.query<{ name: string }>('select name from mtg_body where id = $1', [m.body_id]);
    await client.query('update mtg_meeting set status = $2, notice_sent_at = now(), short_notice_reason = $3 where id = $1', [meetingId, 'called', shortReason]);
    for (const p of members) {
      await client.query('insert into mtg_attendance (tenant_id, meeting_id, actor_id) values ($1, $2, $3) on conflict (meeting_id, actor_id) do nothing', [w.tenantId, meetingId, p.actor_id]);
      await mailer(client, {
        kind: 'meeting_notice', to: p.email, tenantId: w.tenantId, idempotencyKey: `mtg-notice:${meetingId}:${p.actor_id}`, attachments: [await invitationFor(client, m, p)],
        subject: `Notice of meeting: ${b[0]!.name} — ${m.title}`,
        text: `Hello ${p.display_name},\n\n${b[0]!.name} meets on ${m.starts_at.toUTCString()}${m.location ? ` at ${m.location}` : ''}${m.link ? `\nJoin: ${m.link}` : ''}.\n\nAgenda:\n${items.map((i) => `  ${i.position}. ${i.title}${i.purpose === 'resolution' ? ' (resolution)' : i.purpose === 'decision' ? ' (decision)' : ''}`).join('\n')}\n${shortReason ? `\nThis meeting is called at short notice: ${shortReason}\n` : ''}\nPlease say whether you will attend: ${appUrl()}/console?view=meetings&meeting=${meetingId}\n`,
      });
    }
    await event(client, { tenantId: w.tenantId, bodyId: m.body_id, meetingId, actorId: w.actorId, kind: 'notice_sent', detail: { to: members.length, daysNotice: Math.floor(daysNotice), shortReason } });
    return { notified: members.length, daysNotice: Math.floor(daysNotice) };
  });
}

export async function rsvp(pool: Pool, principal: Principal, meetingId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const m = await loadMeeting(pool, w.tenantId, meetingId); requireSee(w, m.body_id);
  if (!['called', 'in_progress'].includes(m.status)) throw new InvalidInput('this meeting is not open for replies');
  const answer = ['yes', 'no', 'maybe'].includes(String(body.rsvp)) ? String(body.rsvp) : null;
  if (!answer) throw new InvalidInput('answer yes, no or maybe');
  const apologies = answer === 'no' ? text(body.apologies, 500) || null : null;
  await pool.query('insert into mtg_attendance (tenant_id, meeting_id, actor_id, rsvp, apologies) values ($1, $2, $3, $4, $5) on conflict (meeting_id, actor_id) do update set rsvp = excluded.rsvp, apologies = excluded.apologies',
    [w.tenantId, meetingId, w.actorId, answer, apologies]);
  await event(pool, { tenantId: w.tenantId, bodyId: m.body_id, meetingId, actorId: w.actorId, kind: 'rsvp', detail: { rsvp: answer, apologies } });
  return { rsvp: answer };
}

export async function cancelMeeting(pool: Pool, principal: Principal, meetingId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const reason = text(body.reason, 500); if (!reason) throw new InvalidInput('say why the meeting is cancelled');
  return inTransaction(pool, async (client) => {
    const m = await loadMeeting(client, w.tenantId, meetingId); requireManage(w, m.body_id);
    if (!['draft', 'called'].includes(m.status)) throw new InvalidInput('a meeting that has started cannot be cancelled; close it instead');
    await client.query('update mtg_meeting set status = $2, cancel_reason = $3, sequence = sequence + 1 where id = $1', [meetingId, 'cancelled', reason]);
    await client.query(`update mtg_resolution set status = 'withdrawn', result_note = 'meeting cancelled' where meeting_id = $1 and status in ('draft', 'open')`, [meetingId]);
    await event(client, { tenantId: w.tenantId, bodyId: m.body_id, meetingId, actorId: w.actorId, kind: 'meeting_cancelled', detail: { reason } });
    if (m.status === 'called') {
      for (const p of await allMembers(client, m.body_id)) {
        await mailer(client, { kind: 'meeting_notice', to: p.email, tenantId: w.tenantId, idempotencyKey: `mtg-cancel:${meetingId}:${p.actor_id}`, attachments: [await invitationFor(client, { ...m, sequence: m.sequence + 1 }, p, true)], subject: `Cancelled: ${m.title}`, text: `Hello ${p.display_name},\n\nThe meeting "${m.title}" on ${m.starts_at.toUTCString()} is cancelled.\n\nReason: ${reason}\n` });
      }
    }
    return { ok: true };
  });
}

/** Live proxies at a meeting: giver → holder. Only counts while the holder is in the room and the giver is not. */
async function liveProxies(client: Client | Pool, meetingId: string): Promise<{ giver_id: string; holder_id: string; giver: string; holder: string }[]> {
  const { rows } = await client.query<{ giver_id: string; holder_id: string; giver: string; holder: string }>(
    `select p.giver_id, p.holder_id, g.display_name as giver, h.display_name as holder from mtg_proxy p join actor g on g.id = p.giver_id join actor h on h.id = p.holder_id
      where p.meeting_id = $1 and p.revoked_at is null
        and exists (select 1 from mtg_attendance t where t.meeting_id = p.meeting_id and t.actor_id = p.holder_id and t.present)
        and not exists (select 1 from mtg_attendance t where t.meeting_id = p.meeting_id and t.actor_id = p.giver_id and t.present)`, [meetingId]);
  return rows;
}

/** Present voting members, and those represented by a proxy. Quorum is bodies in the room; proxies add votes, not presence. */
async function presentCount(client: Client | Pool, meetingId: string, bodyId: string) {
  const voting = await votingMembers(client, bodyId);
  const { rows } = await client.query<{ actor_id: string }>('select actor_id from mtg_attendance where meeting_id = $1 and present', [meetingId]);
  const presentIds = new Set(rows.map((r) => r.actor_id));
  const proxies = await liveProxies(client, meetingId);
  const votingIds = new Set(voting.map((v) => v.actor_id));
  const represented = proxies.filter((p) => votingIds.has(p.giver_id) && votingIds.has(p.holder_id)).length;
  return { present: voting.filter((v) => presentIds.has(v.actor_id)).length, voting: voting.length, represented };
}

/** A voting member hands their vote at one meeting to another voting member. */
export async function appointProxy(pool: Pool, principal: Principal, meetingId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const m = await loadMeeting(client, w.tenantId, meetingId); requireSee(w, m.body_id);
    if (!['called', 'in_progress'].includes(m.status)) throw new InvalidInput('proxies are given once the meeting is called and before it closes');
    const { rows: b } = await client.query<{ proxies_allowed: boolean; max_proxies: number }>('select proxies_allowed, max_proxies from mtg_body where id = $1', [m.body_id]);
    if (!b[0]?.proxies_allowed) throw new InvalidInput('this body does not allow proxies; members vote in person');
    if (body.revoke === true) {
      const { rowCount } = await client.query('update mtg_proxy set revoked_at = now() where meeting_id = $1 and giver_id = $2 and revoked_at is null', [meetingId, w.actorId]);
      if (!rowCount) throw new InvalidInput('you have not given a proxy for this meeting');
      await event(client, { tenantId: w.tenantId, bodyId: m.body_id, meetingId, actorId: w.actorId, kind: 'proxy_revoked', detail: {} });
      return { revoked: true };
    }
    const holderId = id(body.holderId, 'holderId');
    if (holderId === w.actorId) throw new InvalidInput('you cannot be your own proxy');
    const voters = await votingMembers(client, m.body_id);
    if (!voters.some((v) => v.actor_id === w.actorId)) throw new InvalidInput('only a voting member can give a proxy');
    const holder = voters.find((v) => v.actor_id === holderId);
    if (!holder) throw new InvalidInput('the proxy holder must be a voting member of this body');
    const { rows: held } = await client.query<{ n: number }>('select count(*)::int as n from mtg_proxy where meeting_id = $1 and holder_id = $2 and revoked_at is null and giver_id <> $3', [meetingId, holderId, w.actorId]);
    if (held[0]!.n >= b[0].max_proxies) throw new InvalidInput(`${holder.display_name} already holds ${held[0]!.n} proxies, the most this body allows`);
    await client.query('update mtg_proxy set revoked_at = now() where meeting_id = $1 and giver_id = $2 and revoked_at is null', [meetingId, w.actorId]);
    await client.query('insert into mtg_proxy (tenant_id, meeting_id, giver_id, holder_id) values ($1, $2, $3, $4)', [w.tenantId, meetingId, w.actorId, holderId]);
    await event(client, { tenantId: w.tenantId, bodyId: m.body_id, meetingId, actorId: w.actorId, kind: 'proxy_given', detail: { holderId, holder: holder.display_name } });
    return { holder: holder.display_name };
  });
}

/** Marks who is in the room. Allowed before and during the meeting. */
export async function setPresence(pool: Pool, principal: Principal, meetingId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const m = await loadMeeting(client, w.tenantId, meetingId); requireManage(w, m.body_id);
    if (!['called', 'in_progress'].includes(m.status)) throw new InvalidInput('attendance is taken once the meeting is called and before the minutes are closed');
    const actorId = id(body.actorId, 'actorId');
    const present = body.present === true;
    const { rows: mem } = await client.query('select 1 from mtg_body_member where body_id = $1 and actor_id = $2 and until is null', [m.body_id, actorId]);
    if (!mem[0]) throw new InvalidInput('that person is not on this body');
    await client.query(
      `insert into mtg_attendance (tenant_id, meeting_id, actor_id, present, joined_at, left_at) values ($1, $2, $3, $4, case when $4 then now() end, case when $4 then null else now() end)
       on conflict (meeting_id, actor_id) do update set present = excluded.present, joined_at = coalesce(mtg_attendance.joined_at, excluded.joined_at), left_at = case when excluded.present then null else now() end`,
      [w.tenantId, meetingId, actorId, present]);
    const q = await presentCount(client, meetingId, m.body_id);
    const { rows: b } = await client.query<{ quorum_rule: QuorumRule }>('select quorum_rule from mtg_body where id = $1', [m.body_id]);
    const met = quorumMet(b[0]!.quorum_rule, q.present, q.voting);
    if (m.status === 'in_progress') await client.query('update mtg_meeting set quorum_met = $2 where id = $1', [meetingId, met]);
    await event(client, { tenantId: w.tenantId, bodyId: m.body_id, meetingId, actorId: w.actorId, kind: present ? 'arrived' : 'left', detail: { actorId, present: q.present, voting: q.voting, quorum: met } });
    return { present: q.present, voting: q.voting, quorum: met };
  });
}

export async function startMeeting(pool: Pool, principal: Principal, meetingId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const m = await loadMeeting(client, w.tenantId, meetingId); requireManage(w, m.body_id);
    if (m.status !== 'called') throw new InvalidInput(m.status === 'draft' ? 'call the meeting first' : 'this meeting has already started');
    const q = await presentCount(client, meetingId, m.body_id);
    const { rows: b } = await client.query<{ quorum_rule: QuorumRule }>('select quorum_rule from mtg_body where id = $1', [m.body_id]);
    const met = quorumMet(b[0]!.quorum_rule, q.present, q.voting);
    const note = text(body.inquorateNote, 500) || null;
    if (!met && !note) throw new InvalidInput(`no quorum: ${q.present} of ${q.voting} voting members present. Mark who is here, or record a note to proceed without a quorum (no resolution can pass).`);
    const chair = body.chairedBy ? id(body.chairedBy, 'chairedBy') : (await client.query<{ actor_id: string }>(`select actor_id from mtg_body_member where body_id = $1 and role = 'chair' and until is null`, [m.body_id])).rows[0]?.actor_id ?? w.actorId;
    await client.query('update mtg_meeting set status = $2, started_at = now(), quorum_met = $3, quorum_note = $4, chaired_by = $5 where id = $1', [meetingId, 'in_progress', met, met ? null : note, chair]);
    await event(client, { tenantId: w.tenantId, bodyId: m.body_id, meetingId, actorId: w.actorId, kind: 'meeting_started', detail: { present: q.present, voting: q.voting, quorum: met, note, chairedBy: chair } });
    return { quorum: met, present: q.present, voting: q.voting };
  });
}

/** Minutes for one agenda item, written while the meeting runs or before the minutes are approved. */
export async function recordMinutes(pool: Pool, principal: Principal, meetingId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const m = await loadMeeting(client, w.tenantId, meetingId); requireManage(w, m.body_id);
    if (!['in_progress', 'minutes_draft'].includes(m.status)) throw new InvalidInput('minutes are written while the meeting runs or before they are approved');
    const itemId = id(body.itemId, 'itemId');
    const { rows } = await client.query('select 1 from mtg_agenda_item where id = $1 and meeting_id = $2', [itemId, meetingId]);
    if (!rows[0]) throw new InvalidInput('that item is not on this agenda');
    await client.query('update mtg_agenda_item set minutes = $2, outcome = $3 where id = $1', [itemId, text(body.minutes, 20000) || null, text(body.outcome, 1000) || null]);
    await client.query('update mtg_meeting set minutes_author = $2 where id = $1', [meetingId, w.actorId]);
    await event(client, { tenantId: w.tenantId, bodyId: m.body_id, meetingId, actorId: w.actorId, kind: 'minutes_written', detail: { itemId } });
    return { ok: true };
  });
}

export async function closeMeeting(pool: Pool, principal: Principal, meetingId: string) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const m = await loadMeeting(client, w.tenantId, meetingId); requireManage(w, m.body_id);
    if (m.status !== 'in_progress') throw new InvalidInput('only a running meeting can be closed');
    const { rows: open } = await client.query<{ number: number }>(`select number from mtg_resolution where meeting_id = $1 and status = 'open'`, [meetingId]);
    if (open.length) throw new InvalidInput(`close the vote on resolution ${open.map((r) => `R-${r.number}`).join(', ')} first`);
    await client.query(`update mtg_resolution set status = 'withdrawn', result_note = 'not put to the meeting' where meeting_id = $1 and status = 'draft'`, [meetingId]);
    await client.query('update mtg_meeting set status = $2, closed_at = now(), ends_at = coalesce(ends_at, now()) where id = $1', [meetingId, 'minutes_draft']);
    await client.query('update mtg_attendance set left_at = coalesce(left_at, now()) where meeting_id = $1 and present', [meetingId]);
    await event(client, { tenantId: w.tenantId, bodyId: m.body_id, meetingId, actorId: w.actorId, kind: 'meeting_closed', detail: {} });
    return { status: 'minutes_draft' };
  });
}

async function minutesPdf(client: Client, tenantId: string, meetingId: string): Promise<{ bytes: Buffer; blocks: Block[] }> {
  const m = await loadMeeting(client, tenantId, meetingId);
  const { rows: b } = await client.query<{ name: string; kind: string; company_name: string | null }>('select name, kind, company_name from mtg_body where id = $1', [m.body_id]);
  const { rows: t } = await client.query<{ name: string }>('select name from tenant where id = $1', [tenantId]);
  const { rows: att } = await client.query<{ display_name: string; role: string; present: boolean | null; rsvp: string | null; apologies: string | null }>(
    `select a.display_name, mb.role, t.present, t.rsvp, t.apologies from mtg_body_member mb join actor a on a.id = mb.actor_id left join mtg_attendance t on t.meeting_id = $1 and t.actor_id = mb.actor_id
      where mb.body_id = $2 and mb.until is null order by case mb.role when 'chair' then 0 when 'secretary' then 1 else 2 end, a.display_name`, [meetingId, m.body_id]);
  const { rows: items } = await client.query<{ id: string; position: number; title: string; purpose: string; presenter: string | null; minutes: string | null; outcome: string | null }>(
    `select i.id, i.position, i.title, i.purpose, (select display_name from actor where id = i.presenter_id) as presenter, i.minutes, i.outcome from mtg_agenda_item i where i.meeting_id = $1 order by i.position`, [meetingId]);
  const { rows: res } = await client.query<{ agenda_item_id: string | null; number: number; title: string; status: string; votes_for: number; votes_against: number; votes_abstain: number; result_note: string | null }>(
    `select agenda_item_id, number, title, status, votes_for, votes_against, votes_abstain, result_note from mtg_resolution where meeting_id = $1 order by number`, [meetingId]);
  const { rows: acts } = await client.query<{ agenda_item_id: string | null; number: number; title: string; owner: string; due_on: string | null }>(
    `select a.agenda_item_id, a.number, a.title, o.display_name as owner, a.due_on::text from mtg_action a join actor o on o.id = a.owner_id where a.meeting_id = $1 order by a.number`, [meetingId]);
  const chair = att.find((a) => a.role === 'chair')?.display_name ?? '—';
  const proxies = await liveProxies(client, meetingId);
  const blocks: Block[] = [
    { kind: 'heading', level: 1, text: `Minutes of ${b[0]!.name}` },
    { kind: 'paragraph', text: `${b[0]!.company_name ?? t[0]!.name} · Meeting ${m.number}: ${m.title} (${m.kind})` },
    { kind: 'field', label: 'Held on', value: m.starts_at.toUTCString() },
    { kind: 'field', label: 'Place', value: m.location ?? (m.link ? 'by video link' : '—') },
    { kind: 'field', label: 'Chair', value: chair },
    { kind: 'field', label: 'Quorum', value: m.quorum_met ? 'present' : `not present${m.quorum_note ? ` — ${m.quorum_note}` : ''}` },
    { kind: 'rule' },
    { kind: 'heading', level: 2, text: 'Attendance' },
    { kind: 'table', head: ['Name', 'Role', 'Attendance'], rows: att.map((a) => [a.display_name, a.role, a.present ? 'present' : proxies.find((p) => p.giver === a.display_name) ? `by proxy (${proxies.find((p) => p.giver === a.display_name)!.holder})` : a.apologies ? `apologies: ${a.apologies}` : a.rsvp === 'no' ? 'apologies' : 'absent']) },
    { kind: 'spacer', height: 8 },
  ];
  for (const i of items) {
    blocks.push({ kind: 'heading', level: 2, text: `${i.position}. ${i.title}` });
    if (i.presenter) blocks.push({ kind: 'field', label: 'Presented by', value: i.presenter });
    blocks.push({ kind: 'paragraph', text: i.minutes ?? '(no minutes recorded)' });
    if (i.outcome) blocks.push({ kind: 'field', label: 'Outcome', value: i.outcome });
    for (const r of res.filter((x) => x.agenda_item_id === i.id)) {
      blocks.push({ kind: 'field', label: `Resolution R-${r.number}`, value: `${r.title} — ${r.status.toUpperCase()} (${r.votes_for} for, ${r.votes_against} against, ${r.votes_abstain} abstained${r.result_note ? `; ${r.result_note}` : ''})` });
    }
    const itemActions = acts.filter((x) => x.agenda_item_id === i.id);
    if (itemActions.length) blocks.push({ kind: 'list', items: itemActions.map((a) => `Action A-${a.number}: ${a.title} — ${a.owner}${a.due_on ? `, by ${a.due_on}` : ''}`) });
  }
  const loose = res.filter((x) => !x.agenda_item_id);
  if (loose.length) { blocks.push({ kind: 'heading', level: 2, text: 'Other resolutions' }); blocks.push({ kind: 'table', head: ['No.', 'Resolution', 'Result', 'Votes'], rows: loose.map((r) => [`R-${r.number}`, r.title, r.status, `${r.votes_for}/${r.votes_against}/${r.votes_abstain}`]) }); }
  const looseActions = acts.filter((x) => !x.agenda_item_id);
  if (looseActions.length) { blocks.push({ kind: 'heading', level: 2, text: 'Actions' }); blocks.push({ kind: 'list', items: looseActions.map((a) => `A-${a.number}: ${a.title} — ${a.owner}${a.due_on ? `, by ${a.due_on}` : ''}`) }); }
  return { bytes: renderPdf(blocks, { title: `Minutes — ${b[0]!.name} meeting ${m.number}`, producedFor: t[0]!.name }), blocks };
}

async function storePdf(client: Client, tenantId: string, purpose: 'minutes' | 'signing', filename: string, bytes: Buffer, uploadedBy: string | null): Promise<{ id: string; sha256: string }> {
  const fileId = randomUUID(); const key = `gov/files/${tenantId}/${fileId}`;
  const sha = createHash('sha256').update(bytes).digest('hex');
  await objectStore().put(key, bytes, 'application/pdf', { sha256: sha });
  await client.query(`insert into gov_file (id, tenant_id, purpose, filename, content_type, byte_size, sha256, storage_key, uploaded_by, scan_status) values ($1, $2, $3, $4, 'application/pdf', $5, $6, $7, $8, 'clean')`,
    [fileId, tenantId, purpose, filename, bytes.length, sha, key, uploadedBy]);
  return { id: fileId, sha256: sha };
}

/** Someone other than the writer approves; the PDF is produced and the text is frozen. */
export async function approveMinutes(pool: Pool, principal: Principal, meetingId: string) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const m = await loadMeeting(client, w.tenantId, meetingId); requireManage(w, m.body_id);
    if (m.status !== 'minutes_draft') throw new InvalidInput(m.status === 'minutes_approved' ? 'these minutes are already approved' : 'close the meeting before approving its minutes');
    if (m.minutes_author === w.actorId) throw new InvalidInput('the person who wrote the minutes cannot approve them — the chair or another officer must');
    const { rows: empty } = await client.query('select 1 from mtg_agenda_item where meeting_id = $1 and minutes is null limit 1', [meetingId]);
    if (empty[0]) throw new InvalidInput('every agenda item needs minutes before approval');
    const { bytes } = await minutesPdf(client, w.tenantId, meetingId);
    const file = await storePdf(client, w.tenantId, 'minutes', `Minutes - meeting ${m.number} - ${m.title.replace(/[^a-zA-Z0-9 ._-]/g, '').slice(0, 50)}.pdf`, bytes, w.actorId);
    await client.query('update mtg_meeting set status = $2, minutes_approved_by = $3, minutes_approved_at = now(), minutes_file_id = $4 where id = $1', [meetingId, 'minutes_approved', w.actorId, file.id]);
    await event(client, { tenantId: w.tenantId, bodyId: m.body_id, meetingId, actorId: w.actorId, kind: 'minutes_approved', detail: { fileId: file.id, sha256: file.sha256 } });
    for (const p of await allMembers(client, m.body_id)) {
      await mailer(client, { kind: 'meeting_minutes', to: p.email, tenantId: w.tenantId, idempotencyKey: `mtg-minutes:${meetingId}:${p.actor_id}`, subject: `Minutes approved: ${m.title}`, text: `Hello ${p.display_name},\n\nThe minutes of "${m.title}" were approved. Read them in Patform: ${appUrl()}/console?view=meetings&meeting=${meetingId}\n\nFingerprint (SHA-256) of the minutes file: ${file.sha256}\n` });
    }
    return { fileId: file.id, sha256: file.sha256 };
  });
}

export async function meetingDetail(pool: Pool, principal: Principal, meetingId: string) {
  const w = await who(pool, principal);
  const m = await loadMeeting(pool, w.tenantId, meetingId); requireSee(w, m.body_id);
  const { rows: b } = await pool.query<{ name: string; quorum_rule: QuorumRule; decision_rule: DecisionRule; company_name: string | null }>('select name, quorum_rule, decision_rule, company_name from mtg_body where id = $1', [m.body_id]);
  const { rows: items } = await pool.query(
    `select i.id, i.position, i.title, i.purpose, i.presenter_id, (select display_name from actor where id = i.presenter_id) as presenter, i.duration_min, i.papers, i.minutes, i.outcome from mtg_agenda_item i where i.meeting_id = $1 order by i.position`, [meetingId]);
  const { rows: attendance } = await pool.query(
    `select mb.actor_id, a.display_name, mb.role, mb.voting, t.rsvp, t.apologies, t.present, t.joined_at::text from mtg_body_member mb join actor a on a.id = mb.actor_id left join mtg_attendance t on t.meeting_id = $1 and t.actor_id = mb.actor_id
      where mb.body_id = $2 and mb.until is null order by case mb.role when 'chair' then 0 when 'secretary' then 1 when 'member' then 2 else 3 end, a.display_name`, [meetingId, m.body_id]);
  const { rows: resolutions } = await pool.query(
    `select r.id, r.agenda_item_id, r.number, r.title, r.kind, r.status, r.votes_for, r.votes_against, r.votes_abstain, r.eligible, r.result_note, r.envelope_id, r.signed_file_id,
            (select vote from mtg_vote v where v.resolution_id = r.id and v.actor_id = $2) as my_vote
       from mtg_resolution r where r.meeting_id = $1 order by r.number`, [meetingId, w.actorId]);
  const { rows: actions } = await pool.query(
    `select a.id, a.agenda_item_id, a.number, a.title, a.owner_id, o.display_name as owner, a.due_on::text, a.status from mtg_action a join actor o on o.id = a.owner_id where a.meeting_id = $1 order by a.number`, [meetingId]);
  const { rows: events } = await pool.query(
    `select e.kind, e.detail, e.occurred_at::text, a.display_name as actor from mtg_event e left join actor a on a.id = e.actor_id where e.meeting_id = $1 order by e.id`, [meetingId]);
  const q = await presentCount(pool, meetingId, m.body_id);
  const { rows: proxies } = await pool.query<{ giver_id: string; holder_id: string; giver: string; holder: string }>(
    `select p.giver_id, p.holder_id, g.display_name as giver, h.display_name as holder from mtg_proxy p join actor g on g.id = p.giver_id join actor h on h.id = p.holder_id where p.meeting_id = $1 and p.revoked_at is null`, [meetingId]);
  const { rows: bodyRules } = await pool.query<{ proxies_allowed: boolean; max_proxies: number }>('select proxies_allowed, max_proxies from mtg_body where id = $1', [m.body_id]);
  const minutesFile = m.minutes_file_id ? (await pool.query<{ sha256: string; filename: string }>('select sha256, filename from gov_file where id = $1', [m.minutes_file_id])).rows[0] ?? null : null;
  return {
    meeting: { ...m, starts_at: m.starts_at.toISOString(), ends_at: m.ends_at?.toISOString() ?? null, body: b[0]!.name, company_name: b[0]!.company_name, quorum_rule: b[0]!.quorum_rule, decision_rule: b[0]!.decision_rule },
    agenda: items, attendance, resolutions, actions, events,
    quorum: { present: q.present, voting: q.voting, represented: q.represented, met: quorumMet(b[0]!.quorum_rule, q.present, q.voting) },
    proxies, proxies_allowed: bodyRules[0]?.proxies_allowed ?? false, max_proxies: bodyRules[0]?.max_proxies ?? 0,
    minutes_file: minutesFile,
    me: { can_manage: canManage(w, m.body_id), can_vote: canVote(w, m.body_id), is_chair: isChair(w, m.body_id), actor_id: w.actorId, wrote_minutes: m.minutes_author === w.actorId, my_proxy: proxies.find((p) => p.giver_id === w.actorId) ?? null, holding: proxies.filter((p) => p.holder_id === w.actorId) },
  };
}

export async function minutesDocument(pool: Pool, principal: Principal, meetingId: string) {
  const w = await who(pool, principal);
  const m = await loadMeeting(pool, w.tenantId, meetingId); requireSee(w, m.body_id);
  if (!m.minutes_file_id) throw new InvalidInput('the minutes are not approved yet');
  const { rows } = await pool.query<{ storage_key: string; filename: string }>('select storage_key, filename from gov_file where id = $1', [m.minutes_file_id]);
  const bytes = await objectStore().get(rows[0]!.storage_key);
  return { contentType: 'application/pdf', body: bytes, headers: { 'content-disposition': `inline; filename="${rows[0]!.filename.replace(/"/g, '')}"` } };
}

// ------------------------------------------------------------ resolutions

async function loadResolution(client: Client | Pool, tenantId: string, resolutionId: string) {
  const { rows } = await client.query<{ id: string; body_id: string; meeting_id: string | null; agenda_item_id: string | null; number: number; title: string; body_text: string; kind: string; status: string; decision_rule: DecisionRule; opened_at: Date | null; deadline_at: Date | null; eligible: number | null; envelope_id: string | null; signing_file_id: string | null; signed_file_id: string | null; proposed_by: string | null }>(
    'select * from mtg_resolution where id = $1 and tenant_id = $2', [resolutionId, tenantId]);
  if (!rows[0]) throw new InvalidInput('no such resolution');
  return rows[0];
}

export async function createResolution(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const meetingId = body.meetingId ? id(body.meetingId, 'meetingId') : null;
  const bodyId = meetingId ? null : id(body.bodyId, 'bodyId');
  const title = text(body.title, 300); const bodyText = text(body.text, 20000);
  if (!title || !bodyText) throw new InvalidInput('a resolution needs a title and its wording');
  const kind = body.kind === 'special' ? 'special' : 'ordinary';
  return inTransaction(pool, async (client) => {
    let scopeBody = bodyId!;
    let agendaItemId: string | null = null;
    if (meetingId) {
      const m = await loadMeeting(client, w.tenantId, meetingId);
      scopeBody = m.body_id;
      if (!['draft', 'called', 'in_progress'].includes(m.status)) throw new InvalidInput('this meeting is over');
      if (body.itemId) { agendaItemId = id(body.itemId, 'itemId'); const { rows } = await client.query('select 1 from mtg_agenda_item where id = $1 and meeting_id = $2', [agendaItemId, meetingId]); if (!rows[0]) throw new InvalidInput('that item is not on this agenda'); }
    }
    if (!(canManage(w, scopeBody) || canVote(w, scopeBody))) throw new InvalidInput('only members of this body can propose a resolution');
    const { rows: b } = await client.query<{ decision_rule: DecisionRule; written_resolutions: boolean; active: boolean }>('select decision_rule, written_resolutions, active from mtg_body where id = $1 and tenant_id = $2', [scopeBody, w.tenantId]);
    if (!b[0]?.active) throw new InvalidInput('that body is not active');
    if (!meetingId && !b[0].written_resolutions) throw new InvalidInput('this body does not pass written resolutions; put it to a meeting');
    const rule: DecisionRule = kind === 'special' ? { type: 'two_thirds', chairCasting: false } : b[0].decision_rule;
    const number = await nextNumber(client, 'mtg_resolution', 'body_id', scopeBody);
    const { rows } = await client.query<{ id: string }>(
      `insert into mtg_resolution (tenant_id, body_id, meeting_id, agenda_item_id, number, title, body_text, kind, decision_rule, proposed_by, seconded_by, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10) returning id`,
      [w.tenantId, scopeBody, meetingId, agendaItemId, number, title, bodyText, kind, JSON.stringify(rule), w.actorId, body.secondedBy ? id(body.secondedBy, 'secondedBy') : null]);
    await event(client, { tenantId: w.tenantId, bodyId: scopeBody, meetingId, resolutionId: rows[0]!.id, actorId: w.actorId, kind: 'resolution_drafted', detail: { number, title, kind, rule } });
    return { id: rows[0]!.id, number };
  });
}

/** Opens the vote. In a meeting: the meeting must be running and quorate. Written: a deadline, and every voting member is told. */
export async function openResolution(pool: Pool, principal: Principal, resolutionId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const settings = await meetingSettings(pool, w.tenantId);
  return inTransaction(pool, async (client) => {
    const r = await loadResolution(client, w.tenantId, resolutionId); requireManage(w, r.body_id);
    if (r.status !== 'draft') throw new InvalidInput('this resolution is not a draft');
    let deadline: Date | null = null;
    let eligible: number;
    if (r.meeting_id) {
      const m = await loadMeeting(client, w.tenantId, r.meeting_id);
      if (m.status !== 'in_progress') throw new InvalidInput('the meeting must be running to put a resolution to it');
      if (!m.quorum_met) throw new InvalidInput('no quorum: a resolution cannot be put to an inquorate meeting');
      const pc = await presentCount(client, r.meeting_id, r.body_id);
      eligible = pc.present + pc.represented;
    } else {
      deadline = when(body.deadlineAt, 'deadlineAt') ?? new Date(Date.now() + settings.writtenDays * DAY);
      if (deadline.getTime() < Date.now() + 3600_000) throw new InvalidInput('give at least an hour to vote');
      eligible = (await votingMembers(client, r.body_id)).length;
      if (!eligible) throw new InvalidInput('this body has no voting members');
    }
    await client.query('update mtg_resolution set status = $2, opened_at = now(), deadline_at = $3, eligible = $4 where id = $1', [resolutionId, 'open', deadline, eligible]);
    await event(client, { tenantId: w.tenantId, bodyId: r.body_id, meetingId: r.meeting_id, resolutionId, actorId: w.actorId, kind: 'vote_opened', detail: { eligible, deadline } });
    if (!r.meeting_id) {
      const { rows: b } = await client.query<{ name: string }>('select name from mtg_body where id = $1', [r.body_id]);
      for (const p of await votingMembers(client, r.body_id)) {
        await mailer(client, { kind: 'resolution_vote', to: p.email, tenantId: w.tenantId, idempotencyKey: `mtg-vote:${resolutionId}:${p.actor_id}`, subject: `Written resolution R-${r.number}: ${r.title}`, text: `Hello ${p.display_name},\n\n${b[0]!.name} is asked to pass a written resolution:\n\n${r.title}\n\n${r.body_text}\n\nVote by ${deadline!.toUTCString()}: ${appUrl()}/console?view=meetings&resolution=${resolutionId}\n\nAn unanswered vote does not count as a yes.\n` });
      }
    }
    return { eligible, deadline };
  });
}

export async function castVote(pool: Pool, principal: Principal, resolutionId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const vote = ['for', 'against', 'abstain'].includes(String(body.vote)) ? String(body.vote) : null;
  if (!vote) throw new InvalidInput('vote for, against or abstain');
  return inTransaction(pool, async (client) => {
    const r = await loadResolution(client, w.tenantId, resolutionId);
    if (r.status !== 'open') throw new InvalidInput('this vote is not open');
    if (r.deadline_at && r.deadline_at.getTime() < Date.now()) throw new InvalidInput('the deadline has passed');
    // Whose vote: your own, or — for a present member — one the chair or secretary records.
    const forActor = body.actorId ? id(body.actorId, 'actorId') : w.actorId;
    let byProxy = false;
    if (forActor !== w.actorId) {
      if (!r.meeting_id) throw new InvalidInput('written resolutions are voted by each member personally');
      // Either an officer recording a present member's vote, or a proxy holder voting for an absent giver.
      const proxies = await liveProxies(client, r.meeting_id);
      byProxy = proxies.some((p) => p.giver_id === forActor && p.holder_id === w.actorId);
      if (!byProxy) requireManage(w, r.body_id);
    }
    const voters = await votingMembers(client, r.body_id);
    if (!voters.some((v) => v.actor_id === forActor)) throw new InvalidInput(forActor === w.actorId ? 'you do not have a vote on this body' : 'that person does not have a vote on this body');
    if (r.meeting_id && !byProxy) {
      const { rows } = await client.query('select 1 from mtg_attendance where meeting_id = $1 and actor_id = $2 and present', [r.meeting_id, forActor]);
      if (!rows[0]) throw new InvalidInput('only members marked present can vote in the meeting');
    }
    await client.query(
      `insert into mtg_vote (tenant_id, resolution_id, actor_id, vote, recorded_by, note, by_proxy) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (resolution_id, actor_id) do update set vote = excluded.vote, recorded_by = excluded.recorded_by, note = excluded.note, by_proxy = excluded.by_proxy, cast_at = now()`,
      [w.tenantId, resolutionId, forActor, vote, forActor === w.actorId ? null : w.actorId, text(body.note, 300) || null, byProxy]);
    await event(client, { tenantId: w.tenantId, bodyId: r.body_id, meetingId: r.meeting_id, resolutionId, actorId: w.actorId, kind: 'vote_cast', detail: { for: forActor, vote, recordedFor: forActor !== w.actorId, byProxy } });
    const tally = await countVotes(client, resolutionId);
    return { vote, ...tally };
  });
}

async function countVotes(client: Client | Pool, resolutionId: string) {
  const { rows } = await client.query<{ vote: string; n: number }>('select vote, count(*)::int as n from mtg_vote where resolution_id = $1 group by vote', [resolutionId]);
  const get = (k: string) => rows.find((r) => r.vote === k)?.n ?? 0;
  return { for: get('for'), against: get('against'), abstain: get('abstain') };
}

async function settle(client: Client, tenantId: string, r: Awaited<ReturnType<typeof loadResolution>>, actorId: string | null, how: string) {
  const tally = await countVotes(client, r.id);
  let chairVote: 'for' | 'against' | 'abstain' | null = null;
  if (r.meeting_id) {
    const { rows } = await client.query<{ vote: 'for' | 'against' | 'abstain' }>(`select v.vote from mtg_vote v join mtg_meeting m on m.id = $2 where v.resolution_id = $1 and v.actor_id = m.chaired_by`, [r.id, r.meeting_id]);
    chairVote = rows[0]?.vote ?? null;
  }
  const eligible = r.eligible ?? 0;
  const verdict = decide(r.decision_rule, { ...tally, eligible, written: !r.meeting_id, chairVote });
  const status = verdict.passed ? 'passed' : 'failed';
  await client.query('update mtg_resolution set status = $2, closed_at = now(), votes_for = $3, votes_against = $4, votes_abstain = $5, result_note = $6 where id = $1', [r.id, status, tally.for, tally.against, tally.abstain, verdict.why]);
  await event(client, { tenantId, bodyId: r.body_id, meetingId: r.meeting_id, resolutionId: r.id, actorId, kind: verdict.passed ? 'resolution_passed' : 'resolution_failed', detail: { ...tally, eligible, why: verdict.why, how } });
  return { status, ...tally, eligible, why: verdict.why };
}

export async function closeResolution(pool: Pool, principal: Principal, resolutionId: string) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const r = await loadResolution(client, w.tenantId, resolutionId); requireManage(w, r.body_id);
    if (r.status !== 'open') throw new InvalidInput('this vote is not open');
    return settle(client, w.tenantId, r, w.actorId, 'closed by officer');
  });
}

export async function withdrawResolution(pool: Pool, principal: Principal, resolutionId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const reason = text(body.reason, 500); if (!reason) throw new InvalidInput('say why');
  return inTransaction(pool, async (client) => {
    const r = await loadResolution(client, w.tenantId, resolutionId);
    if (!(canManage(w, r.body_id) || r.proposed_by === w.actorId)) throw new InvalidInput('only the proposer, the chair or the secretary can withdraw it');
    if (!['draft', 'open'].includes(r.status)) throw new InvalidInput('a decided resolution cannot be withdrawn');
    await client.query('update mtg_resolution set status = $2, closed_at = now(), result_note = $3 where id = $1', [resolutionId, 'withdrawn', reason]);
    await event(client, { tenantId: w.tenantId, bodyId: r.body_id, meetingId: r.meeting_id, resolutionId, actorId: w.actorId, kind: 'resolution_withdrawn', detail: { reason } });
    return { status: 'withdrawn' };
  });
}

function resolutionPdf(args: { company: string; body: string; number: number; title: string; text: string; kind: string; passedAt: Date; tally: { for: number; against: number; abstain: number }; eligible: number; why: string; meeting: string | null; signatories: string[] }): Buffer {
  const blocks: Block[] = [
    { kind: 'heading', level: 1, text: `${args.kind === 'special' ? 'Special' : 'Ordinary'} resolution R-${args.number}` },
    { kind: 'paragraph', text: `${args.company} — ${args.body}` },
    { kind: 'field', label: 'Passed on', value: args.passedAt.toUTCString() },
    { kind: 'field', label: 'Passed at', value: args.meeting ?? 'as a written resolution' },
    { kind: 'field', label: 'Vote', value: `${args.tally.for} for, ${args.tally.against} against, ${args.tally.abstain} abstained of ${args.eligible} eligible — ${args.why}` },
    { kind: 'rule' },
    { kind: 'heading', level: 2, text: args.title },
    { kind: 'paragraph', text: `IT WAS RESOLVED THAT ${args.text}` },
    { kind: 'spacer', height: 18 },
    { kind: 'paragraph', text: `Signed for and on behalf of ${args.company} by: ${args.signatories.join('; ')}. Each signature, the signer's verification and the time stamp are recorded on the certificate page added by Patform Sign.` },
  ];
  return renderPdf(blocks, { title: `Resolution R-${args.number} — ${args.title}`, producedFor: args.company });
}

/** A passed resolution goes to the body's signatories through Patform Sign. */
export async function sendResolutionForSignature(pool: Pool, principal: Principal, resolutionId: string) {
  const w = await who(pool, principal);
  const r = await loadResolution(pool, w.tenantId, resolutionId); requireManage(w, r.body_id);
  if (r.status !== 'passed') throw new InvalidInput(r.status === 'signing' || r.status === 'signed' ? 'this resolution is already with the signatories' : 'only a passed resolution is signed');
  if (!(await enabledModules(pool, w.tenantId)).has('contracts')) throw new InvalidInput('Patform Sign is part of the Contracts module; switch it on in Settings to sign resolutions');
  const { rows: b } = await pool.query<{ name: string; company_name: string | null; register: { country: string; number: string } | null; signatures_required: number }>('select name, company_name, register, signatures_required from mtg_body where id = $1', [r.body_id]);
  const { rows: t } = await pool.query<{ name: string }>('select name from tenant where id = $1', [w.tenantId]);
  const { rows: signers } = await pool.query<{ actor_id: string; display_name: string; email: string; role: string }>(
    `select m.actor_id, a.display_name, a.email, m.role from mtg_body_member m join actor a on a.id = m.actor_id where m.body_id = $1 and m.until is null and m.signatory and a.active order by case m.role when 'chair' then 0 else 1 end, a.display_name`, [r.body_id]);
  if (!signers.length) throw new InvalidInput('mark at least one member of the body as a signatory first');
  const { rows: ev } = await pool.query<{ occurred_at: Date }>(`select occurred_at from mtg_event where resolution_id = $1 and kind = 'resolution_passed' order by id desc limit 1`, [resolutionId]);
  const { rows: mt } = r.meeting_id ? await pool.query<{ title: string; number: number; starts_at: Date }>('select title, number, starts_at from mtg_meeting where id = $1', [r.meeting_id]) : { rows: [] as { title: string; number: number; starts_at: Date }[] };
  const tally = await countVotes(pool, resolutionId);
  const { rows: rr } = await pool.query<{ result_note: string }>('select result_note from mtg_resolution where id = $1', [resolutionId]);
  const company = b[0]!.company_name ?? t[0]!.name;
  const bytes = resolutionPdf({ company, body: b[0]!.name, number: r.number, title: r.title, text: r.body_text, kind: r.kind, passedAt: ev[0]?.occurred_at ?? new Date(), tally, eligible: r.eligible ?? 0, why: rr[0]?.result_note ?? '', meeting: mt[0] ? `meeting ${mt[0].number} (${mt[0].title}) on ${mt[0].starts_at.toUTCString()}` : null, signatories: signers.map((s) => `${s.display_name} (${s.role})`) });
  const file = await inTransaction(pool, (client) => storePdf(client, w.tenantId, 'signing', `Resolution R-${r.number}.pdf`, bytes, w.actorId));
  const required = Math.min(b[0]!.signatures_required, signers.length);
  let envelopeId: string | null = null; let error: string | null = null;
  try {
    const env = await createEnvelope(pool, principal, {
      documentRef: `gov-file:${file.id}`, title: `Resolution R-${r.number}: ${r.title}`, routing: 'parallel', expiresInDays: 30,
      message: `Please sign resolution R-${r.number} of ${b[0]!.name}, passed ${tally.for} to ${tally.against}.`,
      recipients: signers.map((s) => ({ name: s.display_name, email: s.email, role: 'signer', order: 1, party: b[0]!.company_name ?? undefined, title: s.role === 'chair' ? 'Chair' : s.role === 'secretary' ? 'Secretary' : 'Director' })),
      parties: b[0]!.company_name ? [{ name: b[0]!.company_name, required, order: 1, authorityNote: `Resolution R-${r.number} of ${b[0]!.name}`, register: b[0]!.register ?? undefined }] : [],
    });
    envelopeId = (env as { id: string }).id;
    await sendEnvelope(pool, principal, envelopeId);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (!/still being checked/.test(error)) throw err;
  }
  await pool.query('update mtg_resolution set status = $2, envelope_id = $3, signing_file_id = $4, signing_error = $5 where id = $1', [resolutionId, 'signing', envelopeId, file.id, error]);
  await event(pool, { tenantId: w.tenantId, bodyId: r.body_id, meetingId: r.meeting_id, resolutionId, actorId: w.actorId, kind: envelopeId ? 'sent_for_signature' : 'signing_waiting', detail: { envelopeId, signers: signers.length, required, error } });
  return { envelopeId, signers: signers.length, required, waiting: !envelopeId };
}

export async function resolutionDetail(pool: Pool, principal: Principal, resolutionId: string) {
  const w = await who(pool, principal);
  const r = await loadResolution(pool, w.tenantId, resolutionId); requireSee(w, r.body_id);
  const { rows: votes } = await pool.query(
    `select v.actor_id, a.display_name, v.vote, v.by_proxy, v.cast_at::text, (select display_name from actor where id = v.recorded_by) as recorded_by from mtg_vote v join actor a on a.id = v.actor_id where v.resolution_id = $1 order by v.cast_at`, [resolutionId]);
  const { rows: events } = await pool.query(`select e.kind, e.detail, e.occurred_at::text, a.display_name as actor from mtg_event e left join actor a on a.id = e.actor_id where e.resolution_id = $1 order by e.id`, [resolutionId]);
  const { rows: b } = await pool.query<{ name: string; company_name: string | null }>('select name, company_name from mtg_body where id = $1', [r.body_id]);
  const envelope = r.envelope_id ? (await pool.query<{ number: number; status: string; final_sha256: string | null; completed_at: Date | null }>('select number, status, final_sha256, completed_at from sign_envelope where id = $1', [r.envelope_id])).rows[0] ?? null : null;
  const canVoteNow = r.status === 'open' && canVote(w, r.body_id) && (!r.meeting_id || (await pool.query('select 1 from mtg_attendance where meeting_id = $1 and actor_id = $2 and present', [r.meeting_id, w.actorId])).rows.length > 0);
  const proxyFor = r.status === 'open' && r.meeting_id ? (await liveProxies(pool, r.meeting_id)).filter((p) => p.holder_id === w.actorId).map((p) => ({ actor_id: p.giver_id, name: p.giver, voted: votes.some((v) => (v as { actor_id: string }).actor_id === p.giver_id) })) : [];
  // Who has voted is shown only after the close (or to officers), so a running vote is not steered by its tally.
  const officer = canManage(w, r.body_id);
  const settled = !['draft', 'open'].includes(r.status);
  return {
    resolution: { ...r, body: b[0]!.name, company_name: b[0]!.company_name, opened_at: r.opened_at?.toISOString() ?? null, deadline_at: r.deadline_at?.toISOString() ?? null },
    votes: settled || officer ? votes : votes.filter((v) => v.actor_id === w.actorId),
    tally: settled || officer ? await countVotes(pool, resolutionId) : null,
    voted: votes.length,
    events, envelope,
    me: { can_manage: officer, can_vote: canVoteNow, my_vote: (votes.find((v) => v.actor_id === w.actorId) as { vote?: string } | undefined)?.vote ?? null, is_proposer: r.proposed_by === w.actorId, proxy_for: proxyFor },
  };
}

export async function listResolutions(pool: Pool, principal: Principal, filter: { bodyId?: string; status?: string } = {}) {
  const w = await who(pool, principal);
  const { rows } = await pool.query<{ id: string; body_id: string; body: string; meeting_id: string | null; number: number; title: string; kind: string; status: string; votes_for: number; votes_against: number; votes_abstain: number; eligible: number | null; opened_at: string | null; deadline_at: string | null; closed_at: string | null; signed_sha256: string | null; envelope_number: number | null; my_vote: string | null; created_at: string }>(
    `select r.id, r.body_id, b.name as body, r.meeting_id, r.number, r.title, r.kind, r.status, r.votes_for, r.votes_against, r.votes_abstain, r.eligible, r.opened_at::text, r.deadline_at::text, r.closed_at::text, r.created_at::text,
            (select sha256 from gov_file f where f.id = r.signed_file_id) as signed_sha256,
            (select number from sign_envelope e where e.id = r.envelope_id) as envelope_number,
            (select vote from mtg_vote v where v.resolution_id = r.id and v.actor_id = $2) as my_vote
       from mtg_resolution r join mtg_body b on b.id = r.body_id
      where r.tenant_id = $1 and ($3::uuid is null or r.body_id = $3) and ($4::text is null or r.status = $4)
      order by r.created_at desc limit 300`,
    [w.tenantId, w.actorId, filter.bodyId && UUID.test(filter.bodyId) ? filter.bodyId : null, filter.status || null]);
  return rows.filter((r) => canSee(w, r.body_id)).map((r) => ({ ...r, can_manage: canManage(w, r.body_id), can_vote: r.status === 'open' && canVote(w, r.body_id) }));
}

/** The register: every decided resolution of a body, with how it was decided and the fingerprint of the signed copy. */
export async function resolutionRegister(pool: Pool, principal: Principal, bodyId: string) {
  const w = await who(pool, principal); requireSee(w, bodyId);
  const { rows } = await pool.query(
    `select r.number, r.kind, r.title, r.status, r.votes_for, r.votes_against, r.votes_abstain, r.eligible, r.closed_at::text, r.result_note,
            m.number as meeting_number, m.starts_at::text as meeting_on,
            (select sha256 from gov_file f where f.id = r.signed_file_id) as signed_sha256,
            (select number from sign_envelope e where e.id = r.envelope_id) as envelope_number,
            (select completed_at::text from sign_envelope e where e.id = r.envelope_id) as signed_at
       from mtg_resolution r left join mtg_meeting m on m.id = r.meeting_id
      where r.body_id = $1 and r.tenant_id = $2 and r.status in ('passed', 'failed', 'signing', 'signed', 'withdrawn') order by r.number`, [bodyId, w.tenantId]);
  await event(pool, { tenantId: w.tenantId, bodyId, actorId: w.actorId, kind: 'register_viewed', detail: { rows: rows.length } });
  return rows;
}

export function registerCsv(rows: Record<string, unknown>[]): string {
  const cols = ['number', 'kind', 'title', 'status', 'votes_for', 'votes_against', 'votes_abstain', 'eligible', 'closed_at', 'meeting_number', 'meeting_on', 'envelope_number', 'signed_at', 'signed_sha256', 'result_note'];
  const cell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

// ---------------------------------------------------------------- actions

export async function createAction(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  const title = text(body.title, 300); if (!title) throw new InvalidInput('say what is to be done');
  const ownerId = id(body.ownerId, 'ownerId');
  const dueOn = day(body.dueOn, 'dueOn');
  const meetingId = body.meetingId ? id(body.meetingId, 'meetingId') : null;
  const bodyId = meetingId ? null : id(body.bodyId, 'bodyId');
  return inTransaction(pool, async (client) => {
    let scopeBody = bodyId!;
    let agendaItemId: string | null = null;
    if (meetingId) {
      const m = await loadMeeting(client, w.tenantId, meetingId); scopeBody = m.body_id;
      if (!['in_progress', 'minutes_draft'].includes(m.status)) throw new InvalidInput('actions are agreed while the meeting runs or while its minutes are being written');
      if (body.itemId) { agendaItemId = id(body.itemId, 'itemId'); const { rows } = await client.query('select 1 from mtg_agenda_item where id = $1 and meeting_id = $2', [agendaItemId, meetingId]); if (!rows[0]) throw new InvalidInput('that item is not on this agenda'); }
    }
    requireManage(w, scopeBody);
    const { rows: o } = await client.query<{ display_name: string; email: string; active: boolean }>('select display_name, email, active from actor where id = $1 and tenant_id = $2', [ownerId, w.tenantId]);
    if (!o[0]?.active) throw new InvalidInput('the owner must be an active member of the workspace');
    const number = await nextNumber(client, 'mtg_action', 'tenant_id', w.tenantId);
    const { rows } = await client.query<{ id: string }>(
      'insert into mtg_action (tenant_id, body_id, meeting_id, agenda_item_id, number, title, owner_id, due_on, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id',
      [w.tenantId, scopeBody, meetingId, agendaItemId, number, title, ownerId, dueOn, w.actorId]);
    await event(client, { tenantId: w.tenantId, bodyId: scopeBody, meetingId, actorId: w.actorId, kind: 'action_agreed', detail: { id: rows[0]!.id, number, title, ownerId, dueOn } });
    if (ownerId !== w.actorId) {
      await mailer(client, { kind: 'action_assigned', to: o[0].email, tenantId: w.tenantId, idempotencyKey: `mtg-action:${rows[0]!.id}`, subject: `Action A-${number}: ${title}`, text: `Hello ${o[0].display_name},\n\nYou own an action agreed in a meeting:\n\nA-${number}: ${title}${dueOn ? `\nDue: ${dueOn}` : ''}\n\nSee it in Patform: ${appUrl()}/go\n` });
    }
    return { id: rows[0]!.id, number };
  });
}

export async function listActions(pool: Pool, principal: Principal, filter: { scope?: string; bodyId?: string } = {}) {
  const w = await who(pool, principal);
  const mine = filter.scope === 'mine';
  const { rows } = await pool.query<{ id: string; body_id: string; body: string; meeting_id: string | null; meeting: string | null; number: number; title: string; owner_id: string; owner: string; due_on: string | null; status: string; done_note: string | null; done_at: string | null; late: boolean }>(
    `select a.id, a.body_id, b.name as body, a.meeting_id, m.title as meeting, a.number, a.title, a.owner_id, o.display_name as owner, a.due_on::text, a.status, a.done_note, a.done_at::text,
            (a.status = 'open' and a.due_on is not null and a.due_on < current_date) as late
       from mtg_action a join mtg_body b on b.id = a.body_id join actor o on o.id = a.owner_id left join mtg_meeting m on m.id = a.meeting_id
      where a.tenant_id = $1 and ($2::boolean = false or a.owner_id = $3) and ($4::uuid is null or a.body_id = $4)
      order by a.status = 'open' desc, a.due_on nulls last, a.number desc limit 300`,
    [w.tenantId, mine, w.actorId, filter.bodyId && UUID.test(filter.bodyId) ? filter.bodyId : null]);
  return rows.filter((a) => a.owner_id === w.actorId || canSee(w, a.body_id)).map((a) => ({ ...a, can_close: a.owner_id === w.actorId || canManage(w, a.body_id) }));
}

export async function completeAction(pool: Pool, principal: Principal, actionId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ body_id: string; meeting_id: string | null; owner_id: string; status: string; number: number }>('select body_id, meeting_id, owner_id, status, number from mtg_action where id = $1 and tenant_id = $2', [actionId, w.tenantId]);
    const a = rows[0]; if (!a) throw new InvalidInput('no such action');
    if (!(a.owner_id === w.actorId || canManage(w, a.body_id))) throw new InvalidInput('only the owner, the chair or the secretary can close an action');
    if (a.status !== 'open') throw new InvalidInput('this action is already closed');
    const cancelled = body.cancelled === true;
    const note = text(body.note, 1000) || null;
    if (cancelled && !note) throw new InvalidInput('say why it is cancelled');
    await client.query('update mtg_action set status = $2, done_note = $3, done_at = now() where id = $1', [actionId, cancelled ? 'cancelled' : 'done', note]);
    await event(client, { tenantId: w.tenantId, bodyId: a.body_id, meetingId: a.meeting_id, actorId: w.actorId, kind: cancelled ? 'action_cancelled' : 'action_done', detail: { id: actionId, number: a.number, note } });
    return { status: cancelled ? 'cancelled' : 'done' };
  });
}

/** For the phone: the open actions this person owns, across bodies. */
export async function myMeetingActions(pool: Pool, principal: Principal) {
  if (principal.kind !== 'actor') return [];
  const { rows } = await pool.query<{ id: string; number: number; title: string; body: string; due_on: string | null; late: boolean }>(
    `select a.id, a.number, a.title, b.name as body, a.due_on::text, (a.due_on is not null and a.due_on < current_date) as late
       from mtg_action a join mtg_body b on b.id = a.body_id where a.tenant_id = $1 and a.owner_id = $2 and a.status = 'open' order by a.due_on nulls last limit 50`, [principal.tenantId, principal.actorId]);
  return rows;
}

// --------------------------------------------------------------- overview

export async function meetingsOverview(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const bodies = await listBodies(pool, principal);
  const upcoming = (await listMeetings(pool, principal, { scope: 'upcoming' })).sort((a, b) => a.starts_at.localeCompare(b.starts_at)).slice(0, 8);
  const openVotes = (await listResolutions(pool, principal, { status: 'open' })).filter((r) => r.can_vote && !r.my_vote);
  const myActions = await listActions(pool, principal, { scope: 'mine' });
  const { rows: toApprove } = await pool.query<{ id: string; title: string; body: string; closed_at: string }>(
    `select m.id, m.title, b.name as body, m.closed_at::text from mtg_meeting m join mtg_body b on b.id = m.body_id where m.tenant_id = $1 and m.status = 'minutes_draft' and m.minutes_author is distinct from $2 order by m.closed_at`, [w.tenantId, w.actorId]);
  const { rows: toSign } = await pool.query<{ id: string; number: number; title: string; body: string }>(
    `select r.id, r.number, r.title, b.name as body from mtg_resolution r join mtg_body b on b.id = r.body_id where r.tenant_id = $1 and r.status = 'passed' order by r.closed_at desc limit 10`, [w.tenantId]);
  return {
    bodies, upcoming,
    rsvpPending: upcoming.filter((m) => m.status === 'called' && !m.my_rsvp),
    openVotes, myActions: myActions.filter((a) => a.status === 'open'),
    minutesToApprove: toApprove.filter((m) => canManage(w, bodies.find((b) => b.name === m.body)?.id ?? '')),
    toSign: toSign.filter((r) => canManage(w, bodies.find((b) => b.name === r.body)?.id ?? '')),
    me: { admin: w.admin, bodies: w.bodies },
  };
}

// --------------------------------------------------------------- calendar

/** Meetings between two dates, for the calendar. */
export async function calendar(pool: Pool, principal: Principal, args: { from?: string; to?: string }) {
  const w = await who(pool, principal);
  const from = day(args.from, 'from') ?? new Date(Date.now() - 35 * DAY).toISOString().slice(0, 10);
  const to = day(args.to, 'to') ?? new Date(Date.now() + 70 * DAY).toISOString().slice(0, 10);
  const { rows } = await pool.query<{ id: string; body_id: string; body: string; body_kind: string; number: number; title: string; kind: string; status: string; starts_at: string; ends_at: string | null; location: string | null; link: string | null; items: number; my_rsvp: string | null }>(
    `select m.id, m.body_id, b.name as body, b.kind as body_kind, m.number, m.title, m.kind, m.status, m.starts_at::text, m.ends_at::text, m.location, m.link,
            (select count(*)::int from mtg_agenda_item i where i.meeting_id = m.id) as items,
            (select rsvp from mtg_attendance t where t.meeting_id = m.id and t.actor_id = $2) as my_rsvp
       from mtg_meeting m join mtg_body b on b.id = m.body_id
      where m.tenant_id = $1 and m.starts_at >= $3::date and m.starts_at < ($4::date + 1) order by m.starts_at`, [w.tenantId, w.actorId, from, to]);
  const { rows: deadlines } = await pool.query<{ id: string; body_id: string; number: number; title: string; body: string; deadline_at: string }>(
    `select r.id, r.body_id, r.number, r.title, b.name as body, r.deadline_at::text from mtg_resolution r join mtg_body b on b.id = r.body_id where r.tenant_id = $1 and r.status = 'open' and r.deadline_at is not null and r.deadline_at >= $2::date and r.deadline_at < ($3::date + 1)`, [w.tenantId, from, to]);
  const { rows: actions } = await pool.query<{ id: string; body_id: string; owner_id: string; number: number; title: string; body: string; due_on: string; owner: string }>(
    `select a.id, a.body_id, a.owner_id, a.number, a.title, b.name as body, a.due_on::text, o.display_name as owner from mtg_action a join mtg_body b on b.id = a.body_id join actor o on o.id = a.owner_id where a.tenant_id = $1 and a.status = 'open' and a.due_on >= $2::date and a.due_on <= $3::date`, [w.tenantId, from, to]);
  return {
    from, to,
    meetings: rows.filter((m) => canSee(w, m.body_id)),
    deadlines: deadlines.filter((d) => canSee(w, d.body_id)),
    actions: actions.filter((a) => a.owner_id === w.actorId || canSee(w, a.body_id)),
  };
}

/** The .ics for one meeting, for a member to add it themselves. */
export async function meetingInvite(pool: Pool, principal: Principal, meetingId: string) {
  const w = await who(pool, principal);
  const m = await loadMeeting(pool, w.tenantId, meetingId); requireSee(w, m.body_id);
  const { rows: me } = await pool.query<{ display_name: string; email: string }>('select display_name, email from actor where id = $1', [w.actorId]);
  const a = await invitationFor(pool, m, me[0]!, m.status === 'cancelled');
  return { contentType: 'text/calendar; charset=utf-8', body: a.content, headers: { 'content-disposition': `attachment; filename="${a.filename}"` } };
}

// ------------------------------------------------------------------ sweep

/** Reminders, written-resolution deadlines, signing follow-up. Runs with the worker's sweep. */
export async function sweepMeetings(pool: Pool, now = new Date()): Promise<{ reminded: number; closed: number; signed: number; actions: number }> {
  let reminded = 0; let closed = 0; let signed = 0; let actions = 0;
  // Meeting reminders, once, inside the body's reminder window.
  const { rows: due } = await pool.query<{ id: string; tenant_id: string; body_id: string; title: string; starts_at: Date; ends_at: Date | null; location: string | null; link: string | null; sequence: number; created_by: string | null }>(
    `select m.id, m.tenant_id, m.body_id, m.title, m.starts_at, m.ends_at, m.location, m.link, m.sequence, m.created_by from mtg_meeting m where m.status = 'called' and m.reminded_at is null and m.starts_at > $1 and m.starts_at < $1 + interval '7 days'`, [now]);
  for (const m of due) {
    const s = await meetingSettings(pool, m.tenant_id);
    if (m.starts_at.getTime() - now.getTime() > s.reminderHours * 3600_000) continue;
    await pool.query('update mtg_meeting set reminded_at = $2 where id = $1 and reminded_at is null', [m.id, now]);
    for (const p of await allMembers(pool, m.body_id)) {
      await mailer(pool, { kind: 'meeting_reminder', to: p.email, tenantId: m.tenant_id, idempotencyKey: `mtg-remind:${m.id}:${p.actor_id}`, attachments: [await invitationFor(pool, m, p)], subject: `Reminder: ${m.title}`, text: `Hello ${p.display_name},\n\n"${m.title}" starts ${m.starts_at.toUTCString()}${m.location ? ` at ${m.location}` : ''}.${m.link ? `\nJoin: ${m.link}` : ''}\n\n${appUrl()}/console?view=meetings&meeting=${m.id}\n` });
    }
    reminded += 1;
  }
  // Written resolutions past their deadline settle themselves.
  const { rows: expired } = await pool.query<{ id: string; tenant_id: string }>(`select id, tenant_id from mtg_resolution where status = 'open' and meeting_id is null and deadline_at <= $1`, [now]);
  for (const x of expired) {
    await inTransaction(pool, async (client) => { const r = await loadResolution(client, x.tenant_id, x.id); if (r.status === 'open') { await settle(client, x.tenant_id, r, null, 'deadline'); closed += 1; } });
  }
  // Signed copies come back to the register.
  const { rows: signing } = await pool.query<{ id: string; tenant_id: string; body_id: string; meeting_id: string | null; envelope_id: string; final_file_id: string | null; status: string }>(
    `select r.id, r.tenant_id, r.body_id, r.meeting_id, r.envelope_id, e.final_file_id, e.status from mtg_resolution r join sign_envelope e on e.id = r.envelope_id where r.status = 'signing'`);
  for (const s of signing) {
    if (s.status === 'completed' && s.final_file_id) {
      await pool.query(`update mtg_resolution set status = 'signed', signed_file_id = $2 where id = $1`, [s.id, s.final_file_id]);
      await event(pool, { tenantId: s.tenant_id, bodyId: s.body_id, meetingId: s.meeting_id, resolutionId: s.id, actorId: null, kind: 'resolution_signed', detail: { fileId: s.final_file_id } });
      signed += 1;
    } else if (['voided', 'expired', 'declined'].includes(s.status)) {
      await pool.query(`update mtg_resolution set status = 'passed', envelope_id = null, signing_error = $2 where id = $1`, [s.id, `signing ${s.status}; send again`]);
      await event(pool, { tenantId: s.tenant_id, bodyId: s.body_id, meetingId: s.meeting_id, resolutionId: s.id, actorId: null, kind: 'signing_abandoned', detail: { status: s.status } });
    }
  }
  // Action reminders: once a day while due soon or late.
  const { rows: open } = await pool.query<{ id: string; tenant_id: string; number: number; title: string; due_on: string; email: string; display_name: string }>(
    `select a.id, a.tenant_id, a.number, a.title, a.due_on::text, o.email, o.display_name from mtg_action a join actor o on o.id = a.owner_id
      where a.status = 'open' and a.due_on is not null and (a.reminded_on is null or a.reminded_on < current_date) and a.due_on <= current_date + 30`);
  for (const a of open) {
    const s = await meetingSettings(pool, a.tenant_id);
    const daysLeft = Math.round((new Date(`${a.due_on}T00:00:00Z`).getTime() - now.getTime()) / DAY);
    if (daysLeft > s.actionReminderDays) continue;
    await pool.query('update mtg_action set reminded_on = current_date where id = $1', [a.id]);
    await mailer(pool, { kind: 'action_reminder', to: a.email, tenantId: a.tenant_id, idempotencyKey: `mtg-action-remind:${a.id}:${today()}`, subject: `${daysLeft < 0 ? 'Overdue' : 'Due soon'}: A-${a.number} ${a.title}`, text: `Hello ${a.display_name},\n\nAction A-${a.number} "${a.title}" ${daysLeft < 0 ? `was due ${a.due_on}` : `is due ${a.due_on}`}.\n\nClose it in Patform: ${appUrl()}/go\n` });
    actions += 1;
  }
  return { reminded, closed, signed, actions };
}
