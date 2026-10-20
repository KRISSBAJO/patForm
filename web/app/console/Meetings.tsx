'use client';

import './meetings.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState, ShellSync, type ModuleShell } from './module-shell';
import { Illustration } from './illustrations';
import { postJson } from './stepup';

/*
 * Meetings and resolutions — the executive area.
 *
 * Overview: the band with what needs you, quick actions, what is coming.
 * Calendar: a month of meetings, vote deadlines and action due dates.
 * Meetings: the list, a three-step wizard to call one, and the room.
 * Resolutions, Actions, Register, Boards & committees, Setup.
 *
 * Who may do what is decided by the API; this file only draws what it
 * is given and sends what the person pressed.
 */

type Tab = 'overview' | 'calendar' | 'meetings' | 'resolutions' | 'actions' | 'register' | 'bodies' | 'setup';
type Body = { id: string; name: string; kind: string; quorum_rule: { type: string; value: number }; decision_rule: { type: string; chairCasting: boolean }; company_name: string | null; register: { country: string; number: string } | null; signatures_required: number; written_resolutions: boolean; proxies_allowed: boolean; max_proxies: number; active: boolean; members: number; next_meeting: string | null; my_role: string | null; can_manage: boolean };
type Meeting = { id: string; body_id: string; body: string; body_kind?: string; number: number; title: string; kind: string; status: string; starts_at: string; ends_at: string | null; location: string | null; link?: string | null; quorum_met?: boolean | null; items: number; my_rsvp: string | null; chair?: string | null; can_manage?: boolean };
type Item = { id: string; position: number; title: string; purpose: string; presenter_id: string | null; presenter: string | null; duration_min: number | null; papers: { ref: string; filename: string }[]; minutes: string | null; outcome: string | null };
type Attendee = { actor_id: string; display_name: string; role: string; voting: boolean; rsvp: string | null; apologies: string | null; present: boolean | null };
type Res = { id: string; body_id?: string; body?: string; meeting_id?: string | null; agenda_item_id?: string | null; number: number; title: string; kind: string; status: string; votes_for: number; votes_against: number; votes_abstain: number; eligible: number | null; result_note?: string | null; envelope_id?: string | null; signed_file_id?: string | null; my_vote: string | null; deadline_at?: string | null; signed_sha256?: string | null; envelope_number?: number | null; can_manage?: boolean; can_vote?: boolean };
type Action = { id: string; body: string; meeting?: string | null; number: number; title: string; owner: string; owner_id: string; due_on: string | null; status: string; done_note: string | null; late: boolean; can_close: boolean; agenda_item_id?: string | null };
type Proxy = { giver_id: string; holder_id: string; giver: string; holder: string };
type Detail = { meeting: Meeting & { short_notice_reason: string | null; quorum_note: string | null; minutes_author: string | null; link: string | null; company_name: string | null; quorum_rule: { type: string; value: number }; decision_rule: { type: string; chairCasting: boolean } }; agenda: Item[]; attendance: Attendee[]; resolutions: Res[]; actions: Action[]; events: Ev[]; quorum: { present: number; voting: number; represented: number; met: boolean }; proxies: Proxy[]; proxies_allowed: boolean; max_proxies: number; minutes_file: { sha256: string; filename: string } | null; me: { can_manage: boolean; can_vote: boolean; is_chair: boolean; actor_id: string; wrote_minutes: boolean; my_proxy: Proxy | null; holding: Proxy[] } };
type ResDetail = { resolution: Res & { body: string; body_text: string; company_name: string | null; opened_at: string | null; deadline_at: string | null; closed_at: string | null; signing_error: string | null; decision_rule: { type: string } }; votes: { actor_id: string; display_name: string; vote: string; by_proxy: boolean; cast_at: string; recorded_by: string | null }[]; tally: { for: number; against: number; abstain: number } | null; voted: number; events: Ev[]; envelope: { number: number; status: string; final_sha256: string | null } | null; me: { can_manage: boolean; can_vote: boolean; my_vote: string | null; is_proposer: boolean; proxy_for: { actor_id: string; name: string; voted: boolean }[] } };
type Ev = { kind: string; detail: Record<string, unknown>; occurred_at: string; actor: string | null };
type Overview = { bodies: Body[]; upcoming: Meeting[]; rsvpPending: Meeting[]; openVotes: Res[]; myActions: Action[]; minutesToApprove: { id: string; title: string; body: string }[]; toSign: { id: string; number: number; title: string; body: string }[]; me: { admin: boolean; bodies: { bodyId: string; role: string }[] } };
type Member = { id: string; display_name: string; email: string; active: boolean };
type Cal = { from: string; to: string; meetings: Meeting[]; deadlines: { id: string; number: number; title: string; body: string; deadline_at: string }[]; actions: { id: string; number: number; title: string; body: string; due_on: string; owner: string }[] };
type Settings = { settings: { noticeDays: number; reminderHours: number; actionReminderDays: number; writtenDays: number }; me: { admin: boolean } };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}
function useFeed<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => { if (!path) return; try { setData(await get<T>(path)); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}
const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const clock = (v: string) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (v: string | null | undefined) => (v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toLocaleDateString([], { dateStyle: 'medium' }) : '');
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const initials = (n: string) => n.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
const STATUS: Record<string, string> = { draft: 'Draft', called: 'Called', in_progress: 'In the room', minutes_draft: 'Minutes to approve', minutes_approved: 'Minutes approved', cancelled: 'Cancelled', open: 'Vote open', passed: 'Passed', failed: 'Not passed', withdrawn: 'Withdrawn', signing: 'With signatories', signed: 'Signed', done: 'Done' };
const st = (s: string) => STATUS[s] ?? s.replace(/_/g, ' ');
const RULE: Record<string, string> = { simple_majority: 'Simple majority', two_thirds: 'Two-thirds', unanimous: 'Unanimous' };
const PURPOSE: Record<string, string> = { information: 'For information', discussion: 'Discussion', decision: 'Decision', resolution: 'Resolution' };
const ROLE: Record<string, string> = { chair: 'Chair', secretary: 'Secretary', member: 'Member', observer: 'Observer' };
const KIND: Record<string, string> = { board: 'Board', committee: 'Committee', management: 'Management team', general: 'General meeting' };
const Pill = ({ s, text }: { s: string; text?: string }) => <span className={`mx__pill mx__pill--${s}`}><i />{text ?? st(s)}</span>;
const countdown = (iso: string) => { const ms = new Date(iso).getTime() - Date.now(); if (ms < 0) return 'now'; const d = Math.floor(ms / 86400000); const h = Math.floor((ms % 86400000) / 3600000); return d > 0 ? `in ${d}d ${h}h` : h > 0 ? `in ${h}h` : 'within the hour'; };

function Ring({ present, voting, met, represented }: { present: number; voting: number; met: boolean; represented?: number }) {
  const r = 34; const c = 2 * Math.PI * r; const pct = voting ? Math.min(1, present / voting) : 0;
  return <div className={`mx__ring ${met ? 'is-met' : ''}`}>
    <svg viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r={r} className="mx__ringTrack" /><circle cx="42" cy="42" r={r} className="mx__ringFill" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} /></svg>
    <div className="mx__ringText"><strong>{present}</strong><small>of {voting}{represented ? ` +${represented}` : ''}</small></div>
    <span className="mx__ringLabel">{met ? 'Quorum' : 'No quorum'}</span>
  </div>;
}
function VoteBar({ f, a, ab, eligible }: { f: number; a: number; ab: number; eligible: number | null }) {
  const total = Math.max(eligible ?? 0, f + a + ab, 1);
  return <div className="mx__votes" aria-label={`${f} for, ${a} against, ${ab} abstained`}>
    <div className="mx__voteBar"><span className="is-for" style={{ width: `${(f / total) * 100}%` }} /><span className="is-against" style={{ width: `${(a / total) * 100}%` }} /><span className="is-abstain" style={{ width: `${(ab / total) * 100}%` }} /></div>
    <div className="mx__voteKey"><span><i className="is-for" />{f} for</span><span><i className="is-against" />{a} against</span><span><i className="is-abstain" />{ab} abstained</span>{eligible !== null && <span style={{ marginLeft: 'auto' }}>{eligible} eligible</span>}</div>
  </div>;
}
const Field = ({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) => <div className={`mx__field ${wide ? 'mx__field--wide' : ''}`}><label>{label}</label>{children}</div>;

/* --------------------------------------------------------------- calendar */
function Calendar({ onOpen, onNew, pickedDay, setPickedDay }: { onOpen: (id: string) => void; onNew: (date: string) => void; pickedDay: string | null; setPickedDay: (d: string | null) => void }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(first); gridStart.setDate(1 - ((first.getDay() + 6) % 7));
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridStart.getDate() + 41);
  const cal = useFeed<Cal>(`/api/meetings/calendar?from=${ymd(gridStart)}&to=${ymd(gridEnd)}`);
  const byDay = useMemo(() => {
    const map: Record<string, { kind: 'meeting' | 'deadline' | 'action'; id: string; label: string; cls: string; time?: string; status?: string }[]> = {};
    const push = (k: string, v: (typeof map)[string][number]) => { (map[k] ??= []).push(v); };
    for (const m of cal.data?.meetings ?? []) push(ymd(new Date(m.starts_at)), { kind: 'meeting', id: m.id, label: `${clock(m.starts_at)} ${m.title}`, cls: m.status === 'cancelled' ? 'mx__ev--cancelled' : `mx__ev--${m.body_kind ?? 'committee'}`, time: m.starts_at, status: m.status });
    for (const d of cal.data?.deadlines ?? []) push(ymd(new Date(d.deadline_at)), { kind: 'deadline', id: d.id, label: `Vote closes: R-${d.number}`, cls: 'mx__ev--deadline' });
    for (const a of cal.data?.actions ?? []) push(a.due_on, { kind: 'action', id: a.id, label: `A-${a.number} ${a.owner.split(' ')[0]}`, cls: 'mx__ev--action' });
    return map;
  }, [cal.data]);
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d; });
  const today = ymd(new Date());
  const picked = pickedDay ? byDay[pickedDay] ?? [] : [];
  return <div className="mx__grid">
    <div className="mx__card mx__cal">
      <div className="mx__calHead">
        <h3>{month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h3>
        <div className="mx__calNav">
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">‹</button>
          <button type="button" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); setPickedDay(today); }}>Today</button>
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">›</button>
        </div>
      </div>
      <div className="mx__dow">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d}>{d}</span>)}</div>
      <div className="mx__days">
        {days.map((d) => { const k = ymd(d); const evs = byDay[k] ?? []; return <button type="button" key={k} className={`mx__day ${d.getMonth() !== month.getMonth() ? 'is-out' : ''} ${k === today ? 'is-today' : ''} ${pickedDay === k ? 'is-picked' : ''}`} onClick={() => setPickedDay(k)} onDoubleClick={() => onNew(k)}>
          <span className="mx__dayNo">{d.getDate()}</span>
          {evs.slice(0, 3).map((e, i) => <span key={i} className={`mx__ev ${e.cls}`}>{e.label}</span>)}
          {evs.length > 3 && <span className="mx__more">+{evs.length - 3} more</span>}
          {evs.length > 0 && <span className="mx__dot" />}
        </button>; })}
      </div>
      <div className="mx__legend"><span><i style={{ background: '#3d3280' }} />Board</span><span><i style={{ background: '#5b4bb7' }} />Committee</span><span><i style={{ background: '#0e7c7b' }} />Management</span><span><i style={{ background: '#1f5fa8' }} />General meeting</span><span><i style={{ background: '#fff3d6' }} />Vote deadline</span><span><i style={{ background: '#e7f5ec' }} />Action due</span><span className="mx__tiny">Double-click a day to draft a meeting on it.</span></div>
    </div>
    <div className="mx__stack">
      <div className="mx__card">
        <div className="mx__cardHead"><h3>{pickedDay ? day(pickedDay) : 'Pick a day'}</h3>{pickedDay && <button type="button" className="mx__btn mx__btn--sm" onClick={() => onNew(pickedDay)}>+ Meeting</button>}</div>
        <ul className="mx__list">
          {picked.map((e, i) => <li key={i}>
            <div className="mx__main"><strong>{e.label}</strong><small>{e.kind === 'meeting' ? st(e.status ?? '') : e.kind === 'deadline' ? 'Written resolution deadline' : 'Action due'}</small></div>
            {e.kind === 'meeting' && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => onOpen(e.id)}>Open</button>}
          </li>)}
          {pickedDay && !picked.length && <li><EmptyState icon="calendar" title="Nothing on this day" text="Double-click the day to draft a meeting on it." /></li>}
        </ul>
      </div>
      <div className="mx__card">
        <div className="mx__cardHead"><h3>Coming up</h3><small>{(cal.data?.meetings ?? []).filter((m) => new Date(m.starts_at) > new Date() && m.status !== 'cancelled').length} in view</small></div>
        <ul className="mx__list">
          {(cal.data?.meetings ?? []).filter((m) => new Date(m.starts_at) > new Date() && m.status !== 'cancelled').slice(0, 6).map((m) => <li key={m.id}>
            <div className={`mx__date ${m.status === 'in_progress' ? 'mx__date--live' : ''}`}><strong>{new Date(m.starts_at).getDate()}</strong><small>{new Date(m.starts_at).toLocaleDateString([], { month: 'short' })}</small></div>
            <div className="mx__main"><strong>{m.title}</strong><small>{m.body} · {clock(m.starts_at)}{m.location ? ` · ${m.location}` : ''}</small></div>
            <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => onOpen(m.id)}>Open</button>
          </li>)}
        </ul>
      </div>
    </div>
  </div>;
}

/* ----------------------------------------------------------------- wizard */
type AgendaDraft = { title: string; purpose: string; presenterId: string; durationMin: string };
const PRESETS: Record<string, AgendaDraft[]> = {
  board: [
    { title: 'Apologies and declarations of interest', purpose: 'information', presenterId: '', durationMin: '5' },
    { title: 'Minutes of the last meeting', purpose: 'decision', presenterId: '', durationMin: '5' },
    { title: 'Matters arising and actions', purpose: 'discussion', presenterId: '', durationMin: '10' },
    { title: 'CEO report', purpose: 'discussion', presenterId: '', durationMin: '20' },
    { title: 'Finance report and management accounts', purpose: 'discussion', presenterId: '', durationMin: '20' },
    { title: 'Any other business', purpose: 'discussion', presenterId: '', durationMin: '10' },
  ],
  agm: [
    { title: 'Notice and quorum', purpose: 'information', presenterId: '', durationMin: '5' },
    { title: 'Receive the annual report and accounts', purpose: 'resolution', presenterId: '', durationMin: '15' },
    { title: 'Declare a dividend', purpose: 'resolution', presenterId: '', durationMin: '10' },
    { title: 'Re-elect directors', purpose: 'resolution', presenterId: '', durationMin: '10' },
    { title: 'Appoint auditors and fix their remuneration', purpose: 'resolution', presenterId: '', durationMin: '10' },
  ],
  exco: [
    { title: 'Priorities this week', purpose: 'discussion', presenterId: '', durationMin: '15' },
    { title: 'Pipeline and numbers', purpose: 'discussion', presenterId: '', durationMin: '15' },
    { title: 'Decisions needed', purpose: 'decision', presenterId: '', durationMin: '15' },
    { title: 'Actions review', purpose: 'information', presenterId: '', durationMin: '10' },
  ],
  blank: [],
};
function Wizard({ bodies, people, settings, initialDate, onDone, onCancel }: { bodies: Body[]; people: Member[]; settings: Settings['settings'] | null; initialDate?: string | null; onDone: (id: string, called: boolean) => void; onCancel: () => void }) {
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ bodyId: bodies[0]?.id ?? '', title: '', kind: 'ordinary', start: initialDate ? `${initialDate}T10:00` : toLocalInput(new Date(Date.now() + 8 * 86400000)), duration: '90', location: '', link: '' });
  const [agenda, setAgenda] = useState<AgendaDraft[]>(PRESETS.board!);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [shortNeeded, setShortNeeded] = useState<string | null>(null);
  const [shortReason, setShortReason] = useState('');
  const bodyDetail = useFeed<{ members: { actor_id: string; display_name: string; role: string; voting: boolean }[] }>(f.bodyId ? `/api/meetings/bodies/${f.bodyId}` : null);
  const body = bodies.find((b) => b.id === f.bodyId);
  const agendaTime = agenda.reduce((n, a) => n + (Number(a.durationMin) || 0), 0);
  const startDate = f.start ? new Date(f.start) : null;
  const endDate = startDate ? new Date(startDate.getTime() + (Number(f.duration) || agendaTime || 60) * 60000) : null;
  const daysNotice = startDate ? Math.floor((startDate.getTime() - Date.now()) / 86400000) : 0;
  const needs = settings?.noticeDays ?? 7;
  const members = bodyDetail.data?.members ?? [];
  const move = (i: number, d: -1 | 1) => setAgenda((x) => { const y = [...x]; const j = i + d; if (j < 0 || j >= y.length) return x; [y[i], y[j]] = [y[j]!, y[i]!]; return y; });
  const set = (i: number, patch: Partial<AgendaDraft>) => setAgenda((x) => x.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const okBasics = Boolean(f.bodyId && f.title.trim() && f.start);
  const okAgenda = agenda.some((a) => a.title.trim());
  const ensureCreated = async () => {
    if (createdId) return createdId;
    const r = await postJson<{ id: string; number: number }>('/api/meetings/meetings', { bodyId: f.bodyId, title: f.title, kind: f.kind, startsAt: new Date(f.start).toISOString(), endsAt: endDate?.toISOString(), location: f.location, link: f.link, agenda: agenda.filter((a) => a.title.trim()) });
    setCreatedId(r.id);
    return r.id;
  };
  const submit = async (call: boolean, reason?: string) => {
    setBusy(true); setErr(null);
    try {
      const id = await ensureCreated();
      if (call) {
        try { await postJson(`/api/meetings/meetings/${id}/call`, reason ? { shortNoticeReason: reason } : {}); }
        catch (e) { const msg = e instanceof Error ? e.message : String(e); if (/short notice/.test(msg) && !reason) { setShortNeeded(msg); return; } throw e; }
      }
      onDone(id, call);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const preview = <aside className="mx__invite">
    <div className="mx__inviteHead"><span className="mx__eyebrow" style={{ color: 'rgba(255,255,255,.8)' }}>Invitation preview</span><strong>{f.title.trim() || 'Meeting title'}</strong><small>{body?.name ?? 'Body'} · {f.kind}</small></div>
    <div className="mx__inviteBody">
      <div className="mx__inviteRow"><span className="mx__inviteDate"><strong>{startDate ? startDate.getDate() : '–'}</strong><small>{startDate ? startDate.toLocaleDateString([], { month: 'short' }) : ''}</small></span><div><strong>{startDate ? startDate.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }) : 'Date'}</strong><small>{startDate ? `${clock(startDate.toISOString())} – ${clock(endDate!.toISOString())}` : 'Time'}{f.location ? ` · ${f.location}` : ''}{f.link ? ' · video link' : ''}</small></div></div>
      <div className="mx__inviteSection"><span>Agenda</span><ol>{agenda.filter((a) => a.title.trim()).map((a, i) => <li key={i}>{a.title}{a.purpose === 'resolution' ? <em> resolution</em> : a.purpose === 'decision' ? <em> decision</em> : null}</li>)}{!agenda.some((a) => a.title.trim()) && <li className="mx__tiny">No items yet</li>}</ol></div>
      <div className="mx__inviteSection"><span>Invited</span><div className="mx__avatars" style={{ marginTop: 6 }}>{members.map((m) => <span key={m.actor_id} className="mx__avatar" title={m.display_name}>{initials(m.display_name)}</span>)}</div><small className="mx__tiny">{members.length} member{members.length === 1 ? '' : 's'} · each gets the notice and a calendar invitation (.ics)</small></div>
      <div className={`mx__check ${daysNotice >= needs ? 'mx__check--ok' : 'mx__check--warn'}`} style={{ marginTop: 12 }}>{daysNotice >= needs ? `✓ ${daysNotice} days' notice — meets the ${needs}-day rule` : `⚠ ${daysNotice} days' notice; this body needs ${needs}. Sending will ask for a reason.`}</div>
    </div>
  </aside>;
  return <div className="mx__wizard">
    <div className="mx__steps">{['Basics', 'Agenda', 'Review & send'].map((s, i) => <div key={s} className={`mx__step ${i === step ? 'is-on' : ''} ${i < step ? 'is-done' : ''}`}><i>{i < step ? '✓' : i + 1}</i>{s}</div>)}</div>
    <div className="mx__wizGrid">
      <div className="mx__wizBody">
        {err && <p className="mx__notice mx__notice--err">{err}</p>}
        {step === 0 && <>
          <div className="mx__field" style={{ marginBottom: 16 }}><label>Body</label><div className="mx__bodyPick">{bodies.map((b) => <button type="button" key={b.id} className={`mx__bodyPickBtn ${f.bodyId === b.id ? 'is-on' : ''}`} onClick={() => setF({ ...f, bodyId: b.id })}><strong>{b.name}</strong><small>{KIND[b.kind]} · {b.members} members</small></button>)}</div></div>
          <div className="mx__form">
            <Field label="Title" wide><input placeholder="Q4 board meeting" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></Field>
            <Field label="Kind of meeting" wide><div className="mx__segs">{[['ordinary', 'Ordinary'], ['extraordinary', 'Extraordinary'], ['annual', 'Annual general meeting']].map(([k, v]) => <button type="button" key={k} className={`mx__seg ${f.kind === k ? 'is-on' : ''}`} onClick={() => setF({ ...f, kind: k! })}>{v}</button>)}</div></Field>
            <Field label="Starts"><input type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
            <Field label="Length"><div className="mx__segs">{[['30', '30 min'], ['60', '1 h'], ['90', '1½ h'], ['120', '2 h'], ['180', '3 h']].map(([k, v]) => <button type="button" key={k} className={`mx__seg ${f.duration === k ? 'is-on' : ''}`} onClick={() => setF({ ...f, duration: k! })}>{v}</button>)}</div></Field>
            <Field label="Place"><div className="mx__segs" style={{ marginBottom: 6 }}>{['Boardroom', 'Head office', 'Video only'].map((pl) => <button type="button" key={pl} className={`mx__seg ${f.location === pl ? 'is-on' : ''}`} onClick={() => setF({ ...f, location: pl })}>{pl}</button>)}</div><input placeholder="Or type an address" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
            <Field label="Video link (optional)"><input placeholder="https://meet…" value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} /></Field>
          </div>
        </>}
        {step === 1 && <>
          <div className="mx__voteBtns" style={{ marginTop: 0, marginBottom: 12 }}><span className="mx__tiny">Start from:</span>{[['board', 'Board meeting'], ['agm', 'Annual general meeting'], ['exco', 'Management meeting'], ['blank', 'Blank']].map(([k, v]) => <button type="button" key={k} className="mx__seg" onClick={() => setAgenda(PRESETS[k!]!.map((a) => ({ ...a })))}>{v}</button>)}</div>
          <div className="mx__agendaRows">
            {agenda.map((a, i) => <div className="mx__agendaRow" key={i}>
              <span className="mx__no">{i + 1}</span>
              <input className="mx__input" placeholder="Item" value={a.title} onChange={(e) => set(i, { title: e.target.value })} />
              <select className="mx__input" value={a.purpose} onChange={(e) => set(i, { purpose: e.target.value })}>{Object.entries(PURPOSE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <select className="mx__input" value={a.presenterId} onChange={(e) => set(i, { presenterId: e.target.value })}><option value="">Presenter…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select>
              <input className="mx__input" placeholder="min" inputMode="numeric" value={a.durationMin} onChange={(e) => set(i, { durationMin: e.target.value })} />
              <div className="mx__rowBtns"><button type="button" aria-label="Move up" onClick={() => move(i, -1)}>↑</button><button type="button" aria-label="Move down" onClick={() => move(i, 1)}>↓</button><button type="button" aria-label="Remove" onClick={() => setAgenda((x) => x.filter((_, j) => j !== i))}>×</button></div>
            </div>)}
          </div>
          <div className="mx__voteBtns"><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setAgenda((x) => [...x, { title: '', purpose: 'discussion', presenterId: '', durationMin: '10' }])}>+ Add item</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setAgenda((x) => [...x, { title: '', purpose: 'resolution', presenterId: '', durationMin: '15' }])}>+ Add a resolution item</button></div>
          <div className="mx__total"><span>Items: <strong>{agenda.filter((a) => a.title.trim()).length}</strong></span><span>Agenda time: <strong>{agendaTime} min</strong></span><span>Slot: <strong>{f.duration} min</strong>{agendaTime > Number(f.duration) ? <span style={{ color: '#8a3a34' }}> · over by {agendaTime - Number(f.duration)} min</span> : null}</span></div>
        </>}
        {step === 2 && <div className="mx__reviewBox">
          <h4>Ready to send</h4>
          <p>The notice goes to {members.length} member{members.length === 1 ? '' : 's'} with the agenda and a calendar invitation. They reply yes, no or maybe; you take attendance in the room.</p>
          {shortNeeded && <div className="mx__ask" style={{ marginTop: 12 }}><label>{shortNeeded}</label><input placeholder="Reason for short notice" value={shortReason} onChange={(e) => setShortReason(e.target.value)} /><div className="mx__voteBtns" style={{ marginTop: 0 }}><button type="button" className="mx__btn mx__btn--sm" disabled={!shortReason.trim() || busy} onClick={() => void submit(true, shortReason.trim())}>Send at short notice</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { if (createdId) onDone(createdId, false); else setShortNeeded(null); }}>Keep as draft</button></div></div>}
        </div>}
      </div>
      {preview}
    </div>
    <div className="mx__wizFoot">
      <div><button type="button" className="mx__btn mx__btn--ghost" onClick={step === 0 ? onCancel : () => setStep(step - 1)}>{step === 0 ? 'Cancel' : '‹ Back'}</button></div>
      <div className="mx__voteBtns" style={{ marginTop: 0 }}>
        {step < 2 && <button type="button" className="mx__btn" disabled={step === 0 ? !okBasics : !okAgenda} onClick={() => setStep(step + 1)}>Next ›</button>}
        {step === 2 && <><button type="button" className="mx__btn mx__btn--ghost" disabled={busy} onClick={() => void submit(false)}>Save as draft</button><button type="button" className="mx__btn" disabled={busy} onClick={() => void submit(true)}>{busy ? 'Working…' : 'Send the notice'}</button></>}
      </div>
    </div>
  </div>;
}

/* ------------------------------------------------------------------- room */
function Room({ d, busy, act, ask, onBack, onResolution, people, minutesDraft, setMinutesDraft }: { d: Detail; busy: string | null; act: (k: string, w: () => Promise<string | void>) => Promise<void>; ask: (label: string, run: (a: string) => Promise<string>) => void; onBack: () => void; onResolution: (id: string) => void; people: Member[]; minutesDraft: Record<string, { minutes: string; outcome: string }>; setMinutesDraft: React.Dispatch<React.SetStateAction<Record<string, { minutes: string; outcome: string }>>> }) {
  const m = d.meeting; const me = d.me; const live = m.status === 'in_progress';
  const [panel, setPanel] = useState<{ kind: 'resolution' | 'action'; itemId: string; title: string } | null>(null);
  const [rf, setRf] = useState({ title: '', text: '', kind: 'ordinary', owner: '', due: '' });
  const flow = ['draft', 'called', 'in_progress', 'minutes_draft', 'minutes_approved'];
  const at = flow.indexOf(m.status);
  const vote = (r: Res, v: string, actorId?: string) => act(`v-${r.id}-${actorId ?? ''}`, async () => { await postJson(`/api/meetings/resolutions/${r.id}/vote`, { vote: v, actorId }); return `Vote recorded: ${v}.`; });
  const voters = d.attendance.filter((a) => a.voting && a.role !== 'observer' && a.actor_id !== me.actor_id);
  return <div className="mx__room">
    <div className="mx__card">
      <div className="mx__roomHead">
        <div>
          <button type="button" className="mx__link" onClick={onBack}>‹ All meetings</button>
          <div className="mx__eyebrow" style={{ color: 'var(--mx-muted)', marginTop: 8 }}>{m.body} · Meeting {m.number} · {m.kind}</div>
          <h2 className="mx__roomTitle">{m.title}</h2>
          <div className="mx__roomMeta"><Pill s={m.status} /><span>{when(m.starts_at)}{m.ends_at ? ` – ${clock(m.ends_at)}` : ''}</span>{m.location && <span>· {m.location}</span>}{m.link && <a className="mx__link" href={m.link} target="_blank" rel="noreferrer">Join video</a>}<a className="mx__link" href={`/api/meetings/meetings/${m.id}/invite.ics`}>Add to calendar</a>{m.short_notice_reason && <span>· short notice: {m.short_notice_reason}</span>}</div>
        </div>
        <Ring present={d.quorum.present} voting={d.quorum.voting} met={d.quorum.met} represented={d.quorum.represented} />
      </div>
      <div className="mx__flow">{flow.map((s, i) => <span key={s} className={i < at ? 'is-done' : i === at ? 'is-on' : ''}>{st(s)}</span>)}{m.status === 'cancelled' && <span className="is-on">Cancelled</span>}</div>
      <div className="mx__bar">
        {m.status === 'called' && !m.my_rsvp && <><button type="button" className="mx__btn" onClick={() => void act('rsvp', async () => { await postJson(`/api/meetings/meetings/${m.id}/rsvp`, { rsvp: 'yes' }); return 'You are attending.'; })}>I will attend</button><button type="button" className="mx__btn mx__btn--ghost" onClick={() => ask('Apologies (optional)', async (n) => { await postJson(`/api/meetings/meetings/${m.id}/rsvp`, { rsvp: 'no', apologies: n }); return 'Apologies sent.'; })}>Send apologies</button></>}
        {m.status === 'called' && m.my_rsvp && <span className="mx__tiny">You replied: {m.my_rsvp}.</span>}
        {me.can_manage && m.status === 'draft' && <button type="button" className="mx__btn" disabled={busy === 'call'} onClick={() => void act('call', async () => { try { const r = await postJson<{ notified: number }>(`/api/meetings/meetings/${m.id}/call`, {}); return `Notice and calendar invitation sent to ${r.notified}.`; } catch (err) { const msg = err instanceof Error ? err.message : String(err); if (/short notice/.test(msg)) { ask(`${msg} Reason:`, async (n) => { const r = await postJson<{ notified: number }>(`/api/meetings/meetings/${m.id}/call`, { shortNoticeReason: n }); return `Notice sent to ${r.notified} at short notice.`; }); return; } throw err; } })}>Send the notice</button>}
        {me.can_manage && m.status === 'called' && <button type="button" className="mx__btn" disabled={busy === 'start'} onClick={() => void act('start', async () => { try { const r = await postJson<{ quorum: boolean }>(`/api/meetings/meetings/${m.id}/start`, {}); return r.quorum ? 'Meeting started with a quorum.' : 'Meeting started.'; } catch (err) { const msg = err instanceof Error ? err.message : String(err); if (/no quorum/.test(msg)) { ask(`${msg} Note to proceed without a quorum:`, async (n) => { await postJson(`/api/meetings/meetings/${m.id}/start`, { inquorateNote: n }); return 'Meeting started without a quorum: no resolution can pass.'; }); return; } throw err; } })}>Start the meeting</button>}
        {me.can_manage && live && <button type="button" className="mx__btn" disabled={busy === 'close'} onClick={() => void act('close', async () => { await postJson(`/api/meetings/meetings/${m.id}/close`, {}); return 'Meeting closed. Finish the minutes, then have them approved.'; })}>Close the meeting</button>}
        {me.can_manage && m.status === 'minutes_draft' && !me.wrote_minutes && <button type="button" className="mx__btn" disabled={busy === 'approve'} onClick={() => void act('approve', async () => { const r = await postJson<{ sha256: string }>(`/api/meetings/meetings/${m.id}/approve-minutes`, {}); return `Minutes approved and sent to members. Fingerprint ${r.sha256.slice(0, 12)}…`; })}>Approve the minutes</button>}
        {m.status === 'minutes_draft' && me.wrote_minutes && <span className="mx__tiny">You wrote these minutes; the chair or another officer approves them.</span>}
        {m.status === 'minutes_approved' && <a className="mx__btn" href={`/api/meetings/meetings/${m.id}/minutes.pdf`} target="_blank" rel="noreferrer">Open the minutes (PDF)</a>}
        {d.proxies_allowed && me.can_vote && ['called', 'in_progress'].includes(m.status) && (me.my_proxy
          ? <span className="mx__tiny">Your proxy is held by {me.my_proxy.holder}. <button type="button" className="mx__link" onClick={() => void act('px', async () => { await postJson(`/api/meetings/meetings/${m.id}/proxy`, { revoke: true }); return 'Proxy withdrawn.'; })}>Withdraw</button></span>
          : <select className="mx__input" style={{ height: 40 }} value="" onChange={(e) => { const h = e.target.value; if (h) void act('px', async () => { const r = await postJson<{ holder: string }>(`/api/meetings/meetings/${m.id}/proxy`, { holderId: h }); return `${r.holder} will vote for you.`; }); }}><option value="">Give my proxy to…</option>{voters.map((v) => <option key={v.actor_id} value={v.actor_id}>{v.display_name}</option>)}</select>)}
        {me.can_manage && ['draft', 'called'].includes(m.status) && <button type="button" className="mx__btn mx__btn--danger mx__btn--sm" style={{ marginLeft: 'auto' }} onClick={() => ask('Why is the meeting cancelled?', async (n) => { await postJson(`/api/meetings/meetings/${m.id}/cancel`, { reason: n }); onBack(); return 'Meeting cancelled; everyone gets the cancellation.'; })}>Cancel meeting</button>}
      </div>
    </div>

    <div className="mx__grid" style={{ marginTop: 0 }}>
      <div className="mx__stack">
        <div className="mx__card">
          <div className="mx__cardHead"><h3>Agenda</h3><small>{d.agenda.length} items</small></div>
          <ol className="mx__agenda">
            {d.agenda.map((i) => <li key={i.id} className={`mx__item mx__item--${i.purpose}`}>
              <span className="mx__itemNo">{i.position}</span>
              <div>
                <div className="mx__itemHead"><strong>{i.title}</strong><span className="mx__pill">{PURPOSE[i.purpose]}</span>{i.presenter && <span className="mx__itemMeta">{i.presenter}</span>}{i.duration_min ? <span className="mx__itemMeta">{i.duration_min} min</span> : null}</div>
                {d.resolutions.filter((r) => r.agenda_item_id === i.id).map((r) => <div key={r.id} className="mx__res">
                  <div className="mx__resHead"><span>R-{r.number} {r.title}</span><Pill s={r.status} /></div>
                  {r.status !== 'draft' && <VoteBar f={r.votes_for} a={r.votes_against} ab={r.votes_abstain} eligible={r.eligible} />}
                  <div className="mx__voteBtns">
                    {r.status === 'open' && me.can_vote && !r.my_vote && (['for', 'against', 'abstain'] as const).map((v) => <button key={v} type="button" className={`mx__btn mx__btn--sm ${v !== 'for' ? 'mx__btn--ghost' : ''}`} disabled={busy?.startsWith(`v-${r.id}`)} onClick={() => void vote(r, v)}>{v === 'for' ? 'For' : v === 'against' ? 'Against' : 'Abstain'}</button>)}
                    {r.status === 'open' && r.my_vote && <span className="mx__tiny">You voted {r.my_vote}.</span>}
                    {r.status === 'open' && me.holding.map((p) => <span key={p.giver_id} className="mx__voteBtns" style={{ marginTop: 0 }}><span className="mx__tiny">For {p.giver} (proxy):</span>{(['for', 'against', 'abstain'] as const).map((v) => <button key={v} type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void vote(r, v, p.giver_id)}>{v}</button>)}</span>)}
                    {me.can_manage && r.status === 'draft' && live && <button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(`o-${r.id}`, async () => { const x = await postJson<{ eligible: number }>(`/api/meetings/resolutions/${r.id}/open`, {}); return `Vote open: ${x.eligible} can vote.`; })}>Put to the vote</button>}
                    {me.can_manage && r.status === 'open' && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(`c-${r.id}`, async () => { const x = await postJson<{ status: string; why: string }>(`/api/meetings/resolutions/${r.id}/close`, {}); return `${st(x.status)}: ${x.why}`; })}>Close the vote</button>}
                    <button type="button" className="mx__link" onClick={() => onResolution(r.id)}>Detail</button>
                  </div>
                </div>)}
                {d.actions.filter((a) => a.agenda_item_id === i.id).map((a) => <p key={a.id} className="mx__actionLine"><span className="mx__pill mx__pill--draft">A-{a.number}</span>{a.title} — {a.owner}{a.due_on ? `, by ${day(a.due_on)}` : ''}<Pill s={a.late ? 'late' : a.status} /></p>)}
                {me.can_manage && (live || m.status === 'minutes_draft') && <div className="mx__minutes">
                  <textarea placeholder="Minutes for this item…" value={minutesDraft[i.id]?.minutes ?? ''} onChange={(e) => setMinutesDraft((x) => ({ ...x, [i.id]: { minutes: e.target.value, outcome: x[i.id]?.outcome ?? '' } }))} />
                  <div className="mx__voteBtns" style={{ marginTop: 0 }}>
                    <input className="mx__input" style={{ flex: 1, height: 38 }} placeholder="Outcome (one line)" value={minutesDraft[i.id]?.outcome ?? ''} onChange={(e) => setMinutesDraft((x) => ({ ...x, [i.id]: { minutes: x[i.id]?.minutes ?? '', outcome: e.target.value } }))} />
                    <button type="button" className="mx__btn mx__btn--sm" disabled={busy === `m-${i.id}`} onClick={() => void act(`m-${i.id}`, async () => { await postJson(`/api/meetings/meetings/${m.id}/minutes`, { itemId: i.id, ...minutesDraft[i.id] }); return 'Minutes saved.'; })}>Save minutes</button>
                    {live && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setPanel({ kind: 'resolution', itemId: i.id, title: i.title }); setRf({ ...rf, title: i.title, text: '' }); }}>Draft a resolution</button>}
                    {live && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setPanel({ kind: 'action', itemId: i.id, title: i.title }); setRf({ ...rf, title: '', owner: '', due: '' }); }}>Add an action</button>}
                  </div>
                </div>}
                {(!me.can_manage || m.status === 'minutes_approved') && i.minutes && <p className="mx__minutesRead">{i.minutes}{i.outcome ? `\nOutcome: ${i.outcome}` : ''}</p>}
                {panel?.itemId === i.id && <div className="mx__ask" style={{ marginTop: 12 }}>
                  {panel.kind === 'resolution' ? <>
                    <label>Draft a resolution on “{panel.title}”</label>
                    <input placeholder="Short title" value={rf.title} onChange={(e) => setRf({ ...rf, title: e.target.value })} />
                    <div className="mx__segs">{[['ordinary', 'Ordinary'], ['special', 'Special (two-thirds)']].map(([k, v]) => <button type="button" key={k} className={`mx__seg ${rf.kind === k ? 'is-on' : ''}`} onClick={() => setRf({ ...rf, kind: k! })}>{v}</button>)}</div>
                    <textarea className="mx__input" style={{ height: 90, padding: 10 }} placeholder="IT WAS RESOLVED THAT …" value={rf.text} onChange={(e) => setRf({ ...rf, text: e.target.value })} />
                    <div className="mx__voteBtns" style={{ marginTop: 0 }}><button type="button" className="mx__btn mx__btn--sm" disabled={!rf.title.trim() || !rf.text.trim()} onClick={() => void act('newres', async () => { const r = await postJson<{ number: number }>('/api/meetings/resolutions', { meetingId: m.id, itemId: panel.itemId, title: rf.title, text: rf.text, kind: rf.kind }); setPanel(null); return `R-${r.number} drafted. Put it to the vote when ready.`; })}>Save draft</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setPanel(null)}>Cancel</button></div>
                  </> : <>
                    <label>Agree an action on “{panel.title}”</label>
                    <input placeholder="What is to be done" value={rf.title} onChange={(e) => setRf({ ...rf, title: e.target.value })} />
                    <div className="mx__voteBtns" style={{ marginTop: 0 }}><select className="mx__input" style={{ height: 40 }} value={rf.owner} onChange={(e) => setRf({ ...rf, owner: e.target.value })}><option value="">Owner…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select><input className="mx__input" style={{ height: 40 }} type="date" value={rf.due} onChange={(e) => setRf({ ...rf, due: e.target.value })} /></div>
                    <div className="mx__voteBtns" style={{ marginTop: 0 }}><button type="button" className="mx__btn mx__btn--sm" disabled={!rf.title.trim() || !rf.owner} onClick={() => void act('newact', async () => { const r = await postJson<{ number: number }>('/api/meetings/actions', { meetingId: m.id, itemId: panel.itemId, title: rf.title, ownerId: rf.owner, dueOn: rf.due || undefined }); setPanel(null); return `Action A-${r.number} agreed; the owner has been told.`; })}>Agree</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setPanel(null)}>Cancel</button></div>
                  </>}
                </div>}
              </div>
            </li>)}
          </ol>
        </div>
      </div>
      <div className="mx__stack">
        <div className="mx__card">
          <div className="mx__cardHead"><h3>In the room</h3><small>{d.quorum.present} present{d.quorum.represented ? ` · ${d.quorum.represented} by proxy` : ''}</small></div>
          <div className="mx__people" style={{ paddingTop: 12 }}>
            {d.attendance.map((a) => { const px = d.proxies.find((p) => p.giver_id === a.actor_id); return <div key={a.actor_id} className={`mx__person ${a.present ? 'is-present' : ''}`}>
              <span className={`mx__avatar ${a.present ? 'mx__avatar--on' : ''}`} style={{ marginLeft: 0 }}>{initials(a.display_name)}</span>
              <span className="mx__personText"><strong>{a.display_name}</strong><small>{ROLE[a.role]}{!a.voting ? ' · no vote' : ''}{a.present ? ' · present' : px ? ` · proxy to ${px.holder}` : a.rsvp === 'yes' ? ' · coming' : a.rsvp === 'no' ? ` · apologies${a.apologies ? `: ${a.apologies}` : ''}` : a.rsvp === 'maybe' ? ' · maybe' : ''}</small></span>
              {me.can_manage && ['called', 'in_progress'].includes(m.status) && <button type="button" className={`mx__presence ${a.present ? 'is-on' : ''}`} aria-pressed={Boolean(a.present)} onClick={() => void act(`p-${a.actor_id}`, async () => { await postJson(`/api/meetings/meetings/${m.id}/presence`, { actorId: a.actor_id, present: !a.present }); })}>{a.present ? 'Here' : 'Mark here'}</button>}
            </div>; })}
          </div>
        </div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Rules</h3></div><div className="mx__cardBody"><p className="mx__tiny">Quorum: {m.quorum_rule.type === 'count' ? `${m.quorum_rule.value} voting members` : `${Math.round(m.quorum_rule.value * 100)}% of voting members`} in the room · Decisions: {RULE[m.decision_rule.type]}{m.decision_rule.chairCasting ? ', chair has a casting vote' : ''}{d.proxies_allowed ? ` · proxies allowed (${d.max_proxies} per holder)` : ' · no proxies'}{m.quorum_note ? ` · started without quorum: ${m.quorum_note}` : ''}</p>{d.minutes_file && <p className="mx__tiny" style={{ marginTop: 8 }}>Minutes fingerprint: <code>{d.minutes_file.sha256.slice(0, 16)}…</code></p>}</div></div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Record</h3><small>{d.events.length} events</small></div><ul className="mx__log" style={{ paddingTop: 12 }}>{d.events.map((e, i) => <li key={i}><span /><span><time>{when(e.occurred_at)}</time>{e.kind.replace(/_/g, ' ')}{e.actor ? ` — ${e.actor}` : ''}</span></li>)}</ul></div>
      </div>
    </div>
  </div>;
}

/* ------------------------------------------------------------ resolution */
function ResolutionPage({ r: rd, busy, act, ask, onBack }: { r: ResDetail; busy: string | null; act: (k: string, w: () => Promise<string | void>) => Promise<void>; ask: (label: string, run: (a: string) => Promise<string>) => void; onBack: () => void }) {
  const r = rd.resolution; const me = rd.me;
  const vote = (v: string, actorId?: string) => act(`v-${r.id}-${actorId ?? ''}`, async () => { await postJson(`/api/meetings/resolutions/${r.id}/vote`, { vote: v, actorId }); return `Vote recorded: ${v}.`; });
  return <div className="mx__room">
    <div className="mx__card">
      <div className="mx__roomHead"><div>
        <button type="button" className="mx__link" onClick={onBack}>‹ All resolutions</button>
        <div className="mx__eyebrow" style={{ color: 'var(--mx-muted)', marginTop: 8 }}>{r.body} · {r.kind === 'special' ? 'Special' : 'Ordinary'} resolution R-{r.number}</div>
        <h2 className="mx__roomTitle">{r.title}</h2>
        <div className="mx__roomMeta"><Pill s={r.status} /><span>{r.meeting_id ? 'Put to a meeting' : 'Written resolution'}</span>{r.deadline_at && <span>· vote by {when(r.deadline_at)}</span>}{r.closed_at && <span>· decided {when(r.closed_at)}</span>}<span>· {RULE[r.decision_rule.type]}</span></div>
      </div></div>
      <div className="mx__cardBody"><blockquote className="mx__resolved">IT WAS RESOLVED THAT {r.body_text}</blockquote>
        {rd.tally ? <VoteBar f={rd.tally.for} a={rd.tally.against} ab={rd.tally.abstain} eligible={r.eligible} /> : r.status === 'open' ? <p className="mx__tiny" style={{ marginTop: 10 }}>{rd.voted} of {r.eligible} have voted. The tally is shown when the vote closes.</p> : null}
        {r.result_note && <p className="mx__tiny" style={{ marginTop: 6 }}>{r.result_note}</p>}
      </div>
      <div className="mx__bar">
        {me.can_vote && !me.my_vote && (['for', 'against', 'abstain'] as const).map((v) => <button key={v} type="button" className={`mx__btn ${v !== 'for' ? 'mx__btn--ghost' : ''}`} disabled={busy?.startsWith(`v-${r.id}`)} onClick={() => void vote(v)}>{v === 'for' ? 'Vote for' : v === 'against' ? 'Vote against' : 'Abstain'}</button>)}
        {me.my_vote && r.status === 'open' && <span className="mx__tiny">You voted {me.my_vote}.</span>}
        {me.proxy_for.filter((p) => !p.voted).map((p) => <span key={p.actor_id} className="mx__voteBtns" style={{ marginTop: 0 }}><span className="mx__tiny">For {p.name} (proxy):</span>{(['for', 'against', 'abstain'] as const).map((v) => <button key={v} type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void vote(v, p.actor_id)}>{v}</button>)}</span>)}
        {me.can_manage && r.status === 'draft' && !r.meeting_id && <button type="button" className="mx__btn" onClick={() => void act('open', async () => { const x = await postJson<{ eligible: number; deadline: string }>(`/api/meetings/resolutions/${r.id}/open`, {}); return `Sent to ${x.eligible} members to vote by ${when(x.deadline)}.`; })}>Open the written vote</button>}
        {me.can_manage && r.status === 'open' && <button type="button" className="mx__btn mx__btn--ghost" onClick={() => void act('closev', async () => { const x = await postJson<{ status: string; why: string }>(`/api/meetings/resolutions/${r.id}/close`, {}); return `${st(x.status)}: ${x.why}`; })}>Close the vote now</button>}
        {me.can_manage && r.status === 'passed' && <button type="button" className="mx__btn" disabled={busy === 'sign'} onClick={() => void act('sign', async () => { const x = await postJson<{ signers: number; required: number; waiting: boolean }>(`/api/meetings/resolutions/${r.id}/sign`, {}); return x.waiting ? 'The PDF is being checked; it goes out for signature in a minute.' : `Sent to ${x.signers} signatories (${x.required} needed).`; })}>Send for signature</button>}
        {(me.can_manage || me.is_proposer) && ['draft', 'open'].includes(r.status) && <button type="button" className="mx__btn mx__btn--danger mx__btn--sm" onClick={() => ask('Why withdraw it?', async (n) => { await postJson(`/api/meetings/resolutions/${r.id}/withdraw`, { reason: n }); return 'Withdrawn.'; })}>Withdraw</button>}
        {rd.envelope && <span className="mx__tiny">Patform Sign PS-{rd.envelope.number}: {rd.envelope.status}{rd.envelope.final_sha256 ? ` · signed copy ${rd.envelope.final_sha256.slice(0, 12)}…` : ''}</span>}
        {r.signing_error && <span className="mx__tiny" style={{ color: '#8a3a34' }}>{r.signing_error}</span>}
      </div>
    </div>
    <div className="mx__grid" style={{ marginTop: 0 }}>
      <div className="mx__card"><div className="mx__cardHead"><h3>Votes</h3><small>{rd.votes.length} shown</small></div>
        <div className="mx__people" style={{ paddingTop: 12 }}>{rd.votes.map((v) => <div key={v.actor_id} className="mx__person is-present"><span className={`mx__avatar mx__avatar--on`} style={{ marginLeft: 0, background: v.vote === 'for' ? '#14663f' : v.vote === 'against' ? '#b0463f' : '#8a867a' }}>{initials(v.display_name)}</span><span className="mx__personText"><strong>{v.display_name}</strong><small>{v.vote} · {when(v.cast_at)}{v.by_proxy ? ` · by proxy (${v.recorded_by})` : v.recorded_by ? ` · recorded by ${v.recorded_by}` : ''}</small></span></div>)}{!rd.votes.length && <div className="mx__empty">No votes shown yet.</div>}</div>
      </div>
      <div className="mx__card"><div className="mx__cardHead"><h3>Record</h3></div><ul className="mx__log" style={{ paddingTop: 12 }}>{rd.events.map((e, i) => <li key={i}><span /><span><time>{when(e.occurred_at)}</time>{e.kind.replace(/_/g, ' ')}{e.actor ? ` — ${e.actor}` : ''}</span></li>)}</ul></div>
    </div>
  </div>;
}

/* ------------------------------------------------------------------ main */
export function MeetingsView({ shell }: { shell?: ModuleShell } = {}) {
  const [tab, setTab] = useState<Tab>('overview');
  const pickTab = (id: Tab) => { setTab(id); shell?.onSection?.(id); };
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openMeeting, setOpenMeeting] = useState<Detail | null>(null);
  const [openRes, setOpenRes] = useState<ResDetail | null>(null);
  const [openBody, setOpenBody] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{ date?: string | null } | null>(null);
  const [asking, setAsking] = useState<{ label: string; run: (answer: string) => Promise<string> } | null>(null);
  const [answer, setAnswer] = useState('');
  const [minutesDraft, setMinutesDraft] = useState<Record<string, { minutes: string; outcome: string }>>({});
  const [pickedDay, setPickedDay] = useState<string | null>(ymd(new Date()));
  const [bf, setBf] = useState<Record<string, string>>({});
  const [mf, setMf] = useState<Record<string, string>>({});
  const [wr, setWr] = useState({ bodyId: '', title: '', text: '', kind: 'ordinary' });

  const ov = useFeed<Overview>('/api/meetings/overview');
  const on = !ov.error;
  const bodies = useFeed<Body[]>(on ? '/api/meetings/bodies' : null);
  const meetings = useFeed<Meeting[]>(on ? '/api/meetings/meetings' : null);
  const resolutions = useFeed<Res[]>(on ? '/api/meetings/resolutions' : null);
  const actions = useFeed<Action[]>(on ? '/api/meetings/actions' : null);
  const members = useFeed<Member[]>(on ? '/api/members' : null);
  const settings = useFeed<Settings>(on ? '/api/meetings/settings' : null);
  const register = useFeed<Record<string, unknown>[]>(on && openBody && tab === 'register' ? `/api/meetings/bodies/${openBody}/register` : null);
  const bodyDetail = useFeed<{ body: Body; members: { actor_id: string; display_name: string; email: string; role: string; voting: boolean; signatory: boolean; since: string }[]; meetings: Meeting[]; events: Ev[]; can_manage: boolean }>(on && openBody && tab === 'bodies' ? `/api/meetings/bodies/${openBody}` : null);

  useEffect(() => {
    if (shell?.section && shell.section !== tab) { setTab(shell.section as Tab); setNote(null); setAsking(null); setOpenMeeting(null); setOpenRes(null); setWizard(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell?.section]);
  useEffect(() => { if (!openBody && bodies.data?.[0]) setOpenBody(bodies.data[0].id); }, [bodies.data, openBody]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const m = q.get('meeting'); const r = q.get('resolution');
    if (m) { void showMeeting(m); pickTab('meetings'); } else if (r) { void showResolution(r); pickTab('resolutions'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadAll = async () => { await Promise.all([ov.reload(), meetings.reload(), resolutions.reload(), actions.reload(), bodies.reload()]); };
  const act = async (key: string, work: () => Promise<string | void>) => {
    setBusy(key); setNote(null);
    try { const m = await work(); if (m) setNote({ text: m }); await reloadAll(); if (openMeeting) await showMeeting(openMeeting.meeting.id, true); if (openRes) await showResolution(openRes.resolution.id); }
    catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); }
    finally { setBusy(null); }
  };
  const ask = (label: string, run: (a: string) => Promise<string>) => { setAsking({ label, run }); setAnswer(''); };
  const showMeeting = async (id: string, keepDraft = false) => { try { const d = await get<Detail>(`/api/meetings/meetings/${id}`); setOpenMeeting(d); if (!keepDraft) setMinutesDraft(Object.fromEntries(d.agenda.map((i) => [i.id, { minutes: i.minutes ?? '', outcome: i.outcome ?? '' }]))); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } };
  const showResolution = async (id: string) => { try { setOpenRes(await get<ResDetail>(`/api/meetings/resolutions/${id}`)); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } };
  const people = (members.data ?? []).filter((m) => m.active);
  const myBodies = (bodies.data ?? []).filter((b) => b.active);
  const manageable = myBodies.filter((b) => b.can_manage);
  const admin = ov.data?.me.admin ?? false;
  const o = ov.data;

  if (ov.error) return <div className="mx"><div className="mx__card"><div className="mx__empty"><strong>Meetings is not available</strong>{ov.error}</div></div></div>;

  const tabs: { id: Tab; name: string; count: number | null }[] = [
    { id: 'overview', name: 'Overview', count: o ? o.rsvpPending.length + o.openVotes.length + o.minutesToApprove.length : null },
    { id: 'calendar', name: 'Calendar', count: null },
    { id: 'meetings', name: 'Meetings', count: (meetings.data ?? []).filter((m) => ['called', 'in_progress'].includes(m.status)).length || null },
    { id: 'resolutions', name: 'Resolutions', count: (resolutions.data ?? []).filter((r) => r.status === 'open').length || null },
    { id: 'actions', name: 'Actions', count: (actions.data ?? []).filter((a) => a.status === 'open').length || null },
    { id: 'register', name: 'Register', count: null },
    { id: 'bodies', name: 'Boards & committees', count: null },
    ...(admin ? [{ id: 'setup' as Tab, name: 'Setup', count: null }] : []),
  ];
  const openM = (id: string) => { void showMeeting(id); pickTab('meetings'); };
  const openR = (id: string) => { void showResolution(id); pickTab('resolutions'); };
  const startWizard = (date?: string | null) => { setWizard({ date }); setOpenMeeting(null); pickTab('meetings'); };
  /** The one way in: if there is a body you may call for, the wizard; otherwise the reason and the way forward. */
  const newMeeting = (date?: string | null) => {
    if (manageable.length) { startWizard(date); return; }
    if (!bodies.data) return;
    if (!myBodies.length) { if (admin) { pickTab('bodies'); setNote({ text: 'Create a board or committee first; its meetings are called from there.' }); } else setNote({ text: 'There is no board or committee yet. An owner or admin creates one.', err: true }); return; }
    setNote({ text: 'Only the chair, the secretary or an admin of a body can call its meeting.', err: true });
  };
  const next = o?.upcoming.find((m) => m.status !== 'cancelled');
  const live = (meetings.data ?? []).find((m) => m.status === 'in_progress');

  const meetingRow = (m: Meeting) => <li key={m.id}>
    <div className={`mx__date ${m.status === 'in_progress' ? 'mx__date--live' : ''}`}><strong>{new Date(m.starts_at).getDate()}</strong><small>{new Date(m.starts_at).toLocaleDateString([], { month: 'short' })}</small></div>
    <div className="mx__main"><strong>{m.title}</strong><small>{m.body} · meeting {m.number} · {when(m.starts_at)}{m.location ? ` · ${m.location}` : ''} · {m.items} item{m.items === 1 ? '' : 's'}{m.my_rsvp ? ` · you: ${m.my_rsvp}` : ''}</small></div>
    <Pill s={m.status} />
    <button type="button" className={`mx__btn mx__btn--sm ${m.status === 'in_progress' ? '' : 'mx__btn--ghost'}`} onClick={() => openM(m.id)}>{m.status === 'in_progress' ? 'Enter the room' : 'Open'}</button>
  </li>;
  const resRow = (r: Res) => <li key={r.id}>
    <div className="mx__main"><strong>R-{r.number} {r.title}</strong><small>{r.body}{r.kind === 'special' ? ' · special' : ''}{r.meeting_id ? ' · at a meeting' : ' · written'}{r.deadline_at && r.status === 'open' ? ` · by ${when(r.deadline_at)}` : ''}{!['draft', 'open'].includes(r.status) ? ` · ${r.votes_for} for, ${r.votes_against} against` : ''}{r.signed_sha256 ? ' · signed copy on file' : ''}</small></div>
    <Pill s={r.status} />
    {r.can_vote && !r.my_vote ? <button type="button" className="mx__btn mx__btn--sm" onClick={() => openR(r.id)}>Vote</button> : <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => openR(r.id)}>Open</button>}
  </li>;
  const actionRow = (a: Action) => <li key={a.id} className={a.late ? 'is-late' : ''}>
    <div className="mx__main"><strong>A-{a.number} {a.title}</strong><small>{a.owner} · {a.body}{a.meeting ? ` · ${a.meeting}` : ''}{a.due_on ? ` · due ${day(a.due_on)}` : ''}{a.done_note ? ` · ${a.done_note}` : ''}</small></div>
    <Pill s={a.late ? 'late' : a.status} text={a.late ? 'Overdue' : undefined} />
    {a.status === 'open' && a.can_close && <><button type="button" className="mx__btn mx__btn--sm" onClick={() => ask('What was done? (optional)', async (n) => { await postJson(`/api/meetings/actions/${a.id}/close`, { note: n }); return 'Action closed.'; })}>Done</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask('Why is it cancelled?', async (n) => { await postJson(`/api/meetings/actions/${a.id}/close`, { cancelled: true, note: n }); return 'Action cancelled.'; })}>Cancel</button></>}
  </li>;
  const empty = (title: string, text: string, action?: { label: string; onClick: () => void; secondary?: boolean }, icon?: 'inbox' | 'calendar' | 'vote' | 'check' | 'register' | 'people' | 'send' | 'search') => <li><EmptyState icon={icon} title={title} text={text} action={action} /></li>;

  return <div className="mx">
    <ShellSync sections={tabs} onSections={shell?.onSections} />
    {!shell && <div className="mx__segs" style={{ marginBottom: 16 }}>{tabs.map((t) => <button key={t.id} type="button" className={`mx__seg ${tab === t.id ? 'is-on' : ''}`} onClick={() => pickTab(t.id)}>{t.name}{t.count ? ` · ${t.count}` : ''}</button>)}</div>}
    {note && <p className={`mx__notice ${note.err ? 'mx__notice--err' : ''}`} role="status">{note.text}</p>}
    {asking && <form className="mx__ask" onSubmit={(e) => { e.preventDefault(); const job = asking; const a = answer.trim(); setAsking(null); setAnswer(''); void act('ask', () => job.run(a)); }}>
      <label>{asking.label}</label><input autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} />
      <div className="mx__voteBtns" style={{ marginTop: 0 }}><button type="submit" className="mx__btn mx__btn--sm">Continue</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setAsking(null); setAnswer(''); }}>Cancel</button></div>
    </form>}

    {tab === 'overview' && o && <>
      <section className="mx__band">
        <div className="mx__bandGrid">
          <div>
            <div className="mx__eyebrow">Meetings &amp; resolutions</div>
            <h2 className="mx__bandTitle">{live ? `In the room now: ${live.title}` : next ? `Next: ${next.title}` : 'Nothing on the calendar yet'}</h2>
            <p className="mx__bandSub">{live ? `${live.body} is sitting. Enter the room.` : next ? `${next.body} · ${when(next.starts_at)} · ${countdown(next.starts_at)}${next.location ? ` · ${next.location}` : ''}` : 'Create a board, then call its first meeting.'}</p>
            <div className="mx__bandActions">
              {live ? <button type="button" className="mx__btn mx__btn--light" onClick={() => openM(live.id)}>Enter the room</button> : next ? <button type="button" className="mx__btn mx__btn--light" onClick={() => openM(next.id)}>Open the meeting</button> : null}
              <button type="button" className="mx__btn mx__btn--outline" onClick={() => newMeeting()}>+ New meeting</button>
              <button type="button" className="mx__btn mx__btn--outline" onClick={() => pickTab('calendar')}>Calendar</button>
            </div>
          </div>
          <div className={`mx__kpi ${o.openVotes.length ? 'mx__kpi--live' : ''}`}><span>Votes waiting</span><strong>{o.openVotes.length}</strong><small>{o.rsvpPending.length} meeting{o.rsvpPending.length === 1 ? '' : 's'} to reply to</small></div>
          <div className="mx__kpi"><span>Your actions</span><strong>{o.myActions.length}</strong><small>{o.myActions.filter((a) => a.late).length} overdue</small></div>
          <div className="mx__kpi"><span>To approve / sign</span><strong>{o.minutesToApprove.length + o.toSign.length}</strong><small>{o.minutesToApprove.length} minutes · {o.toSign.length} resolution{o.toSign.length === 1 ? '' : 's'}</small></div>
        </div>
      </section>
      {(() => {
        const hasBody = myBodies.length > 0;
        const staffed = myBodies.some((b) => b.members >= 2);
        const hasMeeting = (meetings.data ?? []).length > 0;
        if (hasBody && staffed && hasMeeting) return null;
        const steps = [
          { done: hasBody, title: 'Create a board or committee', text: 'Its name, kind, quorum rule and how decisions are taken. A company name lets it sign resolutions as the company.', action: admin ? { label: hasBody ? 'Open' : 'Create', onClick: () => pickTab('bodies') } : null, who: 'Owner or admin' },
          { done: staffed, title: 'Add the chair, the secretary and the members', text: 'The chair runs the room, the secretary calls meetings and writes minutes, members vote. Mark who may sign resolutions.', action: hasBody ? { label: 'Add members', onClick: () => pickTab('bodies') } : null, who: 'Admin, chair or secretary' },
          { done: Boolean(settings.data), title: 'Check the notice rules', text: `Days of notice before a meeting (${settings.data?.settings.noticeDays ?? 7}), reminders, how long written resolutions stay open.`, action: admin ? { label: 'Review', onClick: () => pickTab('setup') } : null, who: 'Optional', optional: true },
          { done: hasMeeting, title: 'Call the first meeting', text: 'Draft the agenda, send the notice with a calendar invitation, take attendance, vote, write and approve the minutes.', action: staffed ? { label: 'New meeting', onClick: () => newMeeting() } : null, who: 'Chair or secretary' },
        ];
        const doneCount = steps.filter((x) => x.done && !x.optional).length;
        return <section className="mx__card mx__start" style={{ marginTop: 18 }}>
          <div className="mx__cardHead"><div><h3>Get started with Meetings</h3><small>{doneCount} of 3 steps done · what a company secretary would set up first</small></div><div className="mx__startBar" aria-hidden="true"><span style={{ width: `${(doneCount / 3) * 100}%` }} /></div></div>
          <ol className="mx__startSteps">
            {steps.map((x, i) => <li key={x.title} className={x.done ? 'is-done' : ''}>
              <span className="mx__startNo">{x.done ? '✓' : i + 1}</span>
              <div className="mx__main"><strong>{x.title}{x.optional && <span className="mx__pill" style={{ marginLeft: 8 }}>optional</span>}</strong><small>{x.text}</small><small className="mx__tiny">{x.who}</small></div>
              {x.action && !x.done && <button type="button" className={`mx__btn mx__btn--sm ${i > 0 && !steps[i - 1]!.done && !x.optional ? 'mx__btn--ghost' : ''}`} onClick={x.action.onClick}>{x.action.label}</button>}
              {x.action && x.done && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={x.action.onClick}>{x.action.label}</button>}
            </li>)}
          </ol>
        </section>;
      })()}
      <div className="mx__quick" style={{ marginTop: 18 }}>
        <button type="button" className="mx__quickBtn" onClick={() => newMeeting()}><Illustration name="calendar" size={48} /><strong>Call a meeting</strong><small>Agenda, notice, invitations</small></button>
        {manageable.some((b) => b.written_resolutions) && <button type="button" className="mx__quickBtn" onClick={() => { pickTab('resolutions'); setOpenRes(null); }}><Illustration name="vote" size={48} /><strong>Written resolution</strong><small>Decide without a meeting</small></button>}
        <button type="button" className="mx__quickBtn" onClick={() => pickTab('actions')}><Illustration name="actions" size={48} /><strong>Actions</strong><small>{(actions.data ?? []).filter((a) => a.status === 'open').length} open across bodies</small></button>
        <button type="button" className="mx__quickBtn" onClick={() => pickTab('register')}><Illustration name="register" size={48} /><strong>Register</strong><small>Decided resolutions, signed copies</small></button>
      </div>
      <div className="mx__grid">
        <div className="mx__stack">
          {o.rsvpPending.length > 0 && <div className="mx__card"><div className="mx__cardHead"><h3>Reply to</h3></div><ul className="mx__list" style={{ marginTop: 10 }}>{o.rsvpPending.map(meetingRow)}</ul></div>}
          {o.openVotes.length > 0 && <div className="mx__card"><div className="mx__cardHead"><h3>Vote now</h3></div><ul className="mx__list" style={{ marginTop: 10 }}>{o.openVotes.map(resRow)}</ul></div>}
          {(o.minutesToApprove.length > 0 || o.toSign.length > 0) && <div className="mx__card"><div className="mx__cardHead"><h3>Officer's desk</h3></div><ul className="mx__list" style={{ marginTop: 10 }}>
            {o.minutesToApprove.map((m) => <li key={m.id}><div className="mx__main"><strong>Approve the minutes: {m.title}</strong><small>{m.body}</small></div><button type="button" className="mx__btn mx__btn--sm" onClick={() => openM(m.id)}>Review</button></li>)}
            {o.toSign.map((r) => <li key={r.id}><div className="mx__main"><strong>Send for signature: R-{r.number} {r.title}</strong><small>{r.body} · passed</small></div><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => openR(r.id)}>Open</button></li>)}
          </ul></div>}
          <div className="mx__card"><div className="mx__cardHead"><h3>Coming up</h3><small>{o.upcoming.length}</small></div><ul className="mx__list" style={{ marginTop: 10 }}>{o.upcoming.map(meetingRow)}{!o.upcoming.length && empty('Nothing on the calendar', myBodies.length ? 'Call a meeting: the notice and invitation go to every member.' : 'Create a board or committee, then call its first meeting.', myBodies.length ? { label: '+ New meeting', onClick: () => newMeeting() } : admin ? { label: 'Create a board or committee', onClick: () => pickTab('bodies') } : undefined, 'calendar')}</ul></div>
        </div>
        <div className="mx__stack">
          <div className="mx__card"><div className="mx__cardHead"><h3>Your actions</h3><small>{o.myActions.length}</small></div><ul className="mx__list" style={{ marginTop: 10 }}>{o.myActions.slice(0, 6).map(actionRow)}{!o.myActions.length && empty('Nothing on you', 'Actions agreed in meetings with you as owner appear here.', undefined, 'check')}</ul></div>
          <div className="mx__card"><div className="mx__cardHead"><h3>Your bodies</h3></div><ul className="mx__list" style={{ marginTop: 10 }}>{myBodies.map((b) => <li key={b.id}><div className="mx__main"><strong>{b.name}</strong><small>{KIND[b.kind]} · {b.members} members{b.my_role ? ` · you: ${ROLE[b.my_role]}` : ''}</small></div><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setOpenBody(b.id); pickTab('bodies'); }}>Open</button></li>)}{!myBodies.length && empty('No bodies yet', admin ? 'Create a board or committee to get going.' : 'You are not on a board or committee yet.', admin ? { label: 'Create one', onClick: () => pickTab('bodies') } : undefined, 'people')}</ul></div>
        </div>
      </div>
    </>}

    {tab === 'calendar' && <Calendar onOpen={openM} onNew={newMeeting} pickedDay={pickedDay} setPickedDay={setPickedDay} />}

    {tab === 'meetings' && (openMeeting
      ? <Room d={openMeeting} busy={busy} act={act} ask={ask} onBack={() => setOpenMeeting(null)} onResolution={openR} people={people} minutesDraft={minutesDraft} setMinutesDraft={setMinutesDraft} />
      : wizard
        ? <Wizard bodies={manageable} people={people} settings={settings.data?.settings ?? null} initialDate={wizard.date} onCancel={() => setWizard(null)} onDone={(id, called) => { setWizard(null); setNote({ text: called ? 'Meeting called. The notice and calendar invitation have gone to every member.' : 'Meeting saved as a draft. Send the notice from the room when ready.' }); void reloadAll(); void showMeeting(id); }} />
        : <div className="mx__card">
          <div className="mx__cardHead"><h3>All meetings</h3><button type="button" className="mx__btn mx__btn--sm" onClick={() => newMeeting()}>+ New meeting</button></div>
          <ul className="mx__list" style={{ marginTop: 10 }}>{(meetings.data ?? []).map(meetingRow)}{meetings.data && !meetings.data.length && empty('No meetings yet', myBodies.length ? 'Draft the agenda, send the notice with a calendar invitation, and take the room from here.' : admin ? 'Start with a board or committee: its members, quorum and voting rules. Then call its first meeting.' : 'Once a board or committee exists and you sit on it, its meetings appear here.', myBodies.length ? { label: '+ New meeting', onClick: () => newMeeting() } : admin ? { label: 'Create a board or committee', onClick: () => pickTab('bodies') } : undefined, 'calendar')}</ul>
        </div>)}

    {tab === 'resolutions' && (openRes
      ? <ResolutionPage r={openRes} busy={busy} act={act} ask={ask} onBack={() => setOpenRes(null)} />
      : <div className="mx__stack">
        {manageable.some((b) => b.written_resolutions) && <div className="mx__card"><div className="mx__cardHead"><h3>Written resolution</h3><small>Decide without a meeting</small></div><div className="mx__cardBody"><div className="mx__form">
          <Field label="Body"><select value={wr.bodyId || manageable.find((b) => b.written_resolutions)?.id || ''} onChange={(e) => setWr({ ...wr, bodyId: e.target.value })}>{manageable.filter((b) => b.written_resolutions).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <Field label="Kind"><div className="mx__segs">{[['ordinary', 'Ordinary'], ['special', 'Special (two-thirds)']].map(([k, v]) => <button type="button" key={k} className={`mx__seg ${wr.kind === k ? 'is-on' : ''}`} onClick={() => setWr({ ...wr, kind: k! })}>{v}</button>)}</div></Field>
          <Field label="Short title" wide><input value={wr.title} onChange={(e) => setWr({ ...wr, title: e.target.value })} /></Field>
          <Field label="Resolved that…" wide><textarea value={wr.text} onChange={(e) => setWr({ ...wr, text: e.target.value })} /></Field>
          <div className="mx__field--wide"><button type="button" className="mx__btn" disabled={!wr.title.trim() || !wr.text.trim() || busy === 'newwr'} onClick={() => void act('newwr', async () => { const r = await postJson<{ id: string; number: number }>('/api/meetings/resolutions', { bodyId: wr.bodyId || manageable.find((b) => b.written_resolutions)?.id, title: wr.title, text: wr.text, kind: wr.kind }); setWr({ bodyId: wr.bodyId, title: '', text: '', kind: 'ordinary' }); await showResolution(r.id); return `R-${r.number} drafted. Open the vote to send it to members; every voting member is asked and silence is not a yes.`; })}>Save draft</button></div>
        </div></div></div>}
        <div className="mx__card"><div className="mx__cardHead"><h3>All resolutions</h3></div><ul className="mx__list" style={{ marginTop: 10 }}>{(resolutions.data ?? []).map(resRow)}{resolutions.data && !resolutions.data.length && empty('No resolutions yet', 'Put one to a meeting from an agenda item, or pass a written resolution without meeting at all.', manageable.some((b) => b.written_resolutions) ? { label: 'Draft a written resolution', onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) } : undefined, 'vote')}</ul></div>
      </div>)}

    {tab === 'actions' && <div className="mx__card"><div className="mx__cardHead"><h3>Actions</h3><small>{(actions.data ?? []).filter((a) => a.status === 'open').length} open</small></div><ul className="mx__list" style={{ marginTop: 10 }}>{(actions.data ?? []).map(actionRow)}{actions.data && !actions.data.length && empty('No actions yet', 'Actions are agreed in the room against an agenda item, with an owner and a date. Owners are reminded and can close them from their phone.', undefined, 'check')}</ul></div>}

    {tab === 'register' && <div className="mx__card">
      <div className="mx__cardHead"><div><h3>Resolution register</h3><small>Every decided resolution, how it was decided, and the fingerprint of the signed copy. Viewing is itself recorded.</small></div>
        <div className="mx__voteBtns" style={{ marginTop: 0 }}><select className="mx__input" style={{ height: 36 }} value={openBody ?? ''} onChange={(e) => setOpenBody(e.target.value)}>{myBodies.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>{openBody && <a className="mx__btn mx__btn--ghost mx__btn--sm" href={`/api/meetings/bodies/${openBody}/register?format=csv`}>Download CSV</a>}</div></div>
      <table className="mx__table" style={{ marginTop: 12 }}><thead><tr><th>No.</th><th>Resolution</th><th>Decided</th><th>Votes</th><th>Signed copy</th></tr></thead>
        <tbody>{(register.data ?? []).map((r) => <tr key={String(r.number)}><td>R-{String(r.number)}</td><td><strong>{String(r.title)}</strong><br /><span className="mx__tiny">{r.kind === 'special' ? 'special · ' : ''}{r.meeting_number ? `meeting ${r.meeting_number}` : 'written'}</span></td><td><Pill s={String(r.status)} /><br /><span className="mx__tiny">{when(r.closed_at as string | null)}</span></td><td>{String(r.votes_for)} / {String(r.votes_against)} / {String(r.votes_abstain)}<br /><span className="mx__tiny">of {String(r.eligible ?? '—')}</span></td><td>{r.signed_sha256 ? <code>{String(r.signed_sha256).slice(0, 16)}…</code> : r.envelope_number ? `PS-${r.envelope_number} pending` : '—'}</td></tr>)}
          {register.data && !register.data.length && <tr><td colSpan={5}><EmptyState icon="register" title="Nothing decided yet" text="Every passed, failed or signed resolution of this body is listed here with its votes and the fingerprint of the signed copy." /></td></tr>}</tbody></table>
    </div>}

    {tab === 'bodies' && <div className="mx__stack">
      {admin && <div className="mx__card"><div className="mx__cardHead"><h3>New board or committee</h3><small>Rules apply to every meeting and vote</small></div><div className="mx__cardBody"><div className="mx__form">
        <Field label="Name"><input value={bf.name ?? ''} onChange={(e) => setBf({ ...bf, name: e.target.value })} /></Field>
        <Field label="Kind"><select value={bf.kind ?? 'committee'} onChange={(e) => setBf({ ...bf, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Quorum"><div className="mx__voteBtns" style={{ marginTop: 0 }}><select className="mx__input" value={bf.qtype ?? 'fraction'} onChange={(e) => setBf({ ...bf, qtype: e.target.value })}><option value="fraction">Share of voting members</option><option value="count">Number of voting members</option></select><input className="mx__input" style={{ width: 90 }} placeholder={bf.qtype === 'count' ? '2' : '0.5'} value={bf.qval ?? ''} onChange={(e) => setBf({ ...bf, qval: e.target.value })} /></div></Field>
        <Field label="Decisions"><select value={bf.rule ?? 'simple_majority'} onChange={(e) => setBf({ ...bf, rule: e.target.value })}>{Object.entries(RULE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Chair's casting vote"><select value={bf.cast ?? 'yes'} onChange={(e) => setBf({ ...bf, cast: e.target.value })}><option value="yes">Yes</option><option value="no">No</option></select></Field>
        <Field label="Proxies"><select value={bf.proxies ?? 'no'} onChange={(e) => setBf({ ...bf, proxies: e.target.value })}><option value="no">Not allowed (boards, usually)</option><option value="yes">Allowed (general meetings)</option></select></Field>
        <Field label="Signs resolutions as company (optional)"><input placeholder="Acme Ltd" value={bf.co ?? ''} onChange={(e) => setBf({ ...bf, co: e.target.value })} /></Field>
        <Field label="Company register number (optional)"><div className="mx__voteBtns" style={{ marginTop: 0 }}><select className="mx__input" style={{ width: 80 }} value={bf.regc ?? 'GB'} onChange={(e) => setBf({ ...bf, regc: e.target.value })}><option value="GB">GB</option><option value="NG">NG</option></select><input className="mx__input" value={bf.reg ?? ''} onChange={(e) => setBf({ ...bf, reg: e.target.value })} /></div></Field>
        <Field label="Signatures needed on a resolution"><input placeholder="2" value={bf.sig ?? ''} onChange={(e) => setBf({ ...bf, sig: e.target.value })} /></Field>
        <Field label="Written resolutions"><select value={bf.written ?? 'yes'} onChange={(e) => setBf({ ...bf, written: e.target.value })}><option value="yes">Allowed</option><option value="no">Not allowed</option></select></Field>
        <div className="mx__field--wide"><button type="button" className="mx__btn" disabled={!(bf.name ?? '').trim() || busy === 'newb'} onClick={() => void act('newb', async () => { const r = await postJson<{ id: string }>('/api/meetings/bodies', { name: bf.name, kind: bf.kind ?? 'committee', quorum: { type: bf.qtype ?? 'fraction', value: Number(bf.qval || (bf.qtype === 'count' ? 2 : 0.5)) }, decision: { type: bf.rule ?? 'simple_majority', chairCasting: bf.cast !== 'no' }, proxiesAllowed: bf.proxies === 'yes', companyName: bf.co || undefined, register: bf.reg ? { country: bf.regc ?? 'GB', number: bf.reg } : undefined, signaturesRequired: Number(bf.sig || 1), writtenResolutions: bf.written !== 'no' }); setBf({}); setOpenBody(r.id); return 'Body created. Add its members below.'; })}>Create</button></div>
      </div></div></div>}
      <div className="mx__bodies">{myBodies.map((b) => <button key={b.id} type="button" className={`mx__bodyCard ${openBody === b.id ? 'is-open' : ''}`} onClick={() => setOpenBody(b.id)}><strong>{b.name}</strong><small>{KIND[b.kind]} · {b.members} member{b.members === 1 ? '' : 's'}{b.my_role ? ` · you: ${ROLE[b.my_role]}` : ''}</small><small>{RULE[b.decision_rule.type]} · quorum {b.quorum_rule.type === 'count' ? b.quorum_rule.value : `${Math.round(b.quorum_rule.value * 100)}%`}{b.proxies_allowed ? ' · proxies' : ''}{b.company_name ? ` · signs as ${b.company_name}` : ''}</small>{b.next_meeting && <small>Next: {when(b.next_meeting)}</small>}</button>)}{!myBodies.length && <div style={{ gridColumn: '1 / -1' }}><EmptyState icon="people" title="No boards or committees yet" text={admin ? 'A body holds the members, the quorum rule and the decision rule that every meeting and vote follows.' : 'An owner or admin creates them; you will see the ones you sit on.'} action={admin ? { label: 'Create the first one above', onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }), secondary: true } : undefined} /></div>}</div>
      {bodyDetail.data && <div className="mx__card">
        <div className="mx__cardHead"><div><h3>{bodyDetail.data.body.name}</h3><small>Chair and secretary run meetings; members vote; observers attend without a vote. Signatories sign passed resolutions.</small></div></div>
        {bodyDetail.data.can_manage && <div className="mx__cardBody"><div className="mx__form">
          <Field label="Person"><select value={mf.who ?? ''} onChange={(e) => setMf({ ...mf, who: e.target.value })}><option value="">Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select></Field>
          <Field label="Role"><select value={mf.role ?? 'member'} onChange={(e) => setMf({ ...mf, role: e.target.value })}>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Votes"><select value={mf.vote ?? 'yes'} onChange={(e) => setMf({ ...mf, vote: e.target.value })}><option value="yes">Yes</option><option value="no">No</option></select></Field>
          <Field label="Signatory"><select value={mf.sig ?? (mf.role === 'chair' ? 'yes' : 'no')} onChange={(e) => setMf({ ...mf, sig: e.target.value })}><option value="no">No</option><option value="yes">Yes</option></select></Field>
          <div className="mx__field--wide"><button type="button" className="mx__btn mx__btn--sm" disabled={!mf.who || busy === 'addm'} onClick={() => void act('addm', async () => { await postJson(`/api/meetings/bodies/${openBody}/members`, { actorId: mf.who, role: mf.role ?? 'member', voting: mf.vote !== 'no', signatory: mf.sig === 'yes' }); setMf({}); await bodyDetail.reload(); return 'Member set.'; })}>Add or update</button></div>
        </div></div>}
        <ul className="mx__list">{bodyDetail.data.members.map((mm) => <li key={mm.actor_id}><span className="mx__avatar mx__avatar--lg" style={{ marginLeft: 0 }}>{initials(mm.display_name)}</span><div className="mx__main"><strong>{mm.display_name}</strong><small>{ROLE[mm.role]} · {mm.email} · {mm.voting ? 'votes' : 'no vote'}{mm.signatory ? ' · signatory' : ''} · since {day(mm.since)}</small></div>{bodyDetail.data!.can_manage && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(`rm-${mm.actor_id}`, async () => { await postJson(`/api/meetings/bodies/${openBody}/members`, { actorId: mm.actor_id, remove: true }); await bodyDetail.reload(); return 'Removed from the body.'; })}>Remove</button>}</li>)}</ul>
      </div>}
    </div>}

    {tab === 'setup' && settings.data && <div className="mx__card"><div className="mx__cardHead"><h3>Meeting rules for this workspace</h3><small>Quorum and decision rules belong to each body.</small></div><div className="mx__cardBody"><div className="mx__form">
      <Field label="Days of notice a meeting needs"><input value={bf.notice ?? String(settings.data.settings.noticeDays)} onChange={(e) => setBf({ ...bf, notice: e.target.value })} /></Field>
      <Field label="Reminder, hours before"><input value={bf.rem ?? String(settings.data.settings.reminderHours)} onChange={(e) => setBf({ ...bf, rem: e.target.value })} /></Field>
      <Field label="Remind action owners, days before due"><input value={bf.act ?? String(settings.data.settings.actionReminderDays)} onChange={(e) => setBf({ ...bf, act: e.target.value })} /></Field>
      <Field label="Written resolutions stay open, days"><input value={bf.wr ?? String(settings.data.settings.writtenDays)} onChange={(e) => setBf({ ...bf, wr: e.target.value })} /></Field>
      <div className="mx__field--wide"><button type="button" className="mx__btn" disabled={busy === 'settings'} onClick={() => void act('settings', async () => { await postJson('/api/meetings/settings', { noticeDays: bf.notice ?? settings.data!.settings.noticeDays, reminderHours: bf.rem ?? settings.data!.settings.reminderHours, actionReminderDays: bf.act ?? settings.data!.settings.actionReminderDays, writtenDays: bf.wr ?? settings.data!.settings.writtenDays }); await settings.reload(); return 'Saved.'; })}>Save</button></div>
    </div></div></div>}
  </div>;
}
