'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShellSync, type ModuleShell } from './module-shell';
import { postJson } from './stepup';

/*
 * Meetings and resolutions. Everyone on a body: the overview, RSVPs, the
 * papers, votes, their actions. Chair and secretary: calling meetings, the
 * room (attendance, quorum, votes, minutes), approving minutes, sending a
 * passed resolution for signature. Admins: bodies and rules.
 */

type Tab = 'overview' | 'meetings' | 'resolutions' | 'actions' | 'bodies' | 'register' | 'setup';
type Body = { id: string; name: string; kind: string; quorum_rule: { type: string; value: number }; decision_rule: { type: string; chairCasting: boolean }; company_name: string | null; register: { country: string; number: string } | null; signatures_required: number; written_resolutions: boolean; active: boolean; members: number; next_meeting: string | null; my_role: string | null; can_manage: boolean };
type Meeting = { id: string; body_id: string; body: string; number: number; title: string; kind: string; status: string; starts_at: string; ends_at: string | null; location: string | null; quorum_met: boolean | null; items: number; my_rsvp: string | null; chair: string | null; can_manage: boolean };
type Item = { id: string; position: number; title: string; purpose: string; presenter_id: string | null; presenter: string | null; duration_min: number | null; papers: { ref: string; filename: string }[]; minutes: string | null; outcome: string | null };
type Attendee = { actor_id: string; display_name: string; role: string; voting: boolean; rsvp: string | null; apologies: string | null; present: boolean | null };
type Res = { id: string; body_id?: string; body?: string; meeting_id?: string | null; agenda_item_id?: string | null; number: number; title: string; kind: string; status: string; votes_for: number; votes_against: number; votes_abstain: number; eligible: number | null; result_note?: string | null; envelope_id?: string | null; signed_file_id?: string | null; my_vote: string | null; deadline_at?: string | null; signed_sha256?: string | null; envelope_number?: number | null; can_manage?: boolean; can_vote?: boolean };
type Action = { id: string; body: string; meeting?: string | null; number: number; title: string; owner: string; owner_id: string; due_on: string | null; status: string; done_note: string | null; late: boolean; can_close: boolean };
type Detail = { meeting: Meeting & { short_notice_reason: string | null; quorum_note: string | null; minutes_author: string | null; minutes_approved_by: string | null; link: string | null; company_name: string | null; quorum_rule: { type: string; value: number }; decision_rule: { type: string; chairCasting: boolean } }; agenda: Item[]; attendance: Attendee[]; resolutions: Res[]; actions: Action[]; events: Ev[]; quorum: { present: number; voting: number; met: boolean }; minutes_file: { sha256: string; filename: string } | null; me: { can_manage: boolean; can_vote: boolean; is_chair: boolean; actor_id: string; wrote_minutes: boolean } };
type ResDetail = { resolution: Res & { body: string; body_text: string; company_name: string | null; opened_at: string | null; deadline_at: string | null; closed_at: string | null; signing_error: string | null; decision_rule: { type: string } }; votes: { actor_id: string; display_name: string; vote: string; cast_at: string; recorded_by: string | null }[]; tally: { for: number; against: number; abstain: number } | null; voted: number; events: Ev[]; envelope: { number: number; status: string; final_sha256: string | null; completed_at: string | null } | null; me: { can_manage: boolean; can_vote: boolean; my_vote: string | null; is_proposer: boolean } };
type Ev = { kind: string; detail: Record<string, unknown>; occurred_at: string; actor: string | null };
type Overview = { bodies: Body[]; upcoming: Meeting[]; rsvpPending: Meeting[]; openVotes: Res[]; myActions: Action[]; minutesToApprove: { id: string; title: string; body: string }[]; toSign: { id: string; number: number; title: string; body: string }[]; me: { admin: boolean; bodies: { bodyId: string; role: string }[] } };
type Member = { id: string; display_name: string; email: string; active: boolean };

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
const day = (v: string | null | undefined) => (v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toLocaleDateString([], { dateStyle: 'medium' }) : '');
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const STATUS: Record<string, string> = { draft: 'Draft', called: 'Called', in_progress: 'In the room', minutes_draft: 'Minutes to approve', minutes_approved: 'Minutes approved', cancelled: 'Cancelled', open: 'Vote open', passed: 'Passed', failed: 'Not passed', withdrawn: 'Withdrawn', signing: 'With signatories', signed: 'Signed', done: 'Done' };
const st = (s: string) => STATUS[s] ?? s.replace(/_/g, ' ');
const RULE: Record<string, string> = { simple_majority: 'Simple majority', two_thirds: 'Two-thirds', unanimous: 'Unanimous' };
const PURPOSE: Record<string, string> = { information: 'For information', discussion: 'Discussion', decision: 'Decision', resolution: 'Resolution' };
const ROLE: Record<string, string> = { chair: 'Chair', secretary: 'Secretary', member: 'Member', observer: 'Observer' };
const list = { listStyle: 'none', margin: 0, padding: 0 } as const;
const describeEvent = (e: Ev) => e.kind.replace(/_/g, ' ');

function Field({ id, label, children, wide }: { id: string; label: string; children: React.ReactNode; wide?: boolean }) {
  return <div style={wide ? { gridColumn: '1 / -1' } : undefined}><label className="cs__label" htmlFor={id}>{label}</label>{children}</div>;
}

/** A ring that fills as the room fills. */
function QuorumRing({ present, voting, met }: { present: number; voting: number; met: boolean }) {
  const r = 26; const c = 2 * Math.PI * r; const pct = voting ? Math.min(1, present / voting) : 0;
  return (
    <div className={`mt__ring ${met ? 'is-met' : ''}`}>
      <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} className="mt__ringTrack" />
        <circle cx="32" cy="32" r={r} className="mt__ringFill" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
      </svg>
      <div className="mt__ringText"><strong>{present}</strong><small>of {voting}</small></div>
      <span className="mt__ringLabel">{met ? 'Quorum' : 'No quorum'}</span>
    </div>
  );
}

function VoteBar({ f, a, ab, eligible }: { f: number; a: number; ab: number; eligible: number | null }) {
  const total = Math.max(eligible ?? 0, f + a + ab, 1);
  return (
    <div className="mt__votes" aria-label={`${f} for, ${a} against, ${ab} abstained`}>
      <div className="mt__voteBar"><span className="is-for" style={{ width: `${(f / total) * 100}%` }} /><span className="is-against" style={{ width: `${(a / total) * 100}%` }} /><span className="is-abstain" style={{ width: `${(ab / total) * 100}%` }} /></div>
      <div className="mt__voteKey"><span><i className="is-for" />{f} for</span><span><i className="is-against" />{a} against</span><span><i className="is-abstain" />{ab} abstained</span>{eligible !== null && <span className="mt__voteEligible">{eligible} eligible</span>}</div>
    </div>
  );
}

export function MeetingsView({ shell }: { shell?: ModuleShell } = {}) {
  const [tab, setTab] = useState<Tab>('overview');
  const pickTab = (id: Tab) => { setTab(id); shell?.onSection?.(id); };
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [agenda, setAgenda] = useState<{ id?: string; title: string; purpose: string; presenterId: string; durationMin: string }[]>([]);
  const [openMeeting, setOpenMeeting] = useState<Detail | null>(null);
  const [openRes, setOpenRes] = useState<ResDetail | null>(null);
  const [openBody, setOpenBody] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ id: string; label: string; run: (answer: string) => Promise<string> } | null>(null);
  const [answer, setAnswer] = useState('');
  const [minutesDraft, setMinutesDraft] = useState<Record<string, { minutes: string; outcome: string }>>({});

  const ov = useFeed<Overview>('/api/meetings/overview');
  const on = !ov.error;
  const bodies = useFeed<Body[]>(on ? '/api/meetings/bodies' : null);
  const meetings = useFeed<Meeting[]>(on ? '/api/meetings/meetings' : null);
  const resolutions = useFeed<Res[]>(on ? '/api/meetings/resolutions' : null);
  const actions = useFeed<Action[]>(on ? '/api/meetings/actions' : null);
  const members = useFeed<Member[]>(on ? '/api/members' : null);
  const settings = useFeed<{ settings: { noticeDays: number; reminderHours: number; actionReminderDays: number; writtenDays: number }; me: { admin: boolean } }>(on ? '/api/meetings/settings' : null);
  const register = useFeed<Record<string, unknown>[]>(on && openBody && tab === 'register' ? `/api/meetings/bodies/${openBody}/register` : null);
  const bodyDetail = useFeed<{ body: Body; members: { actor_id: string; display_name: string; email: string; role: string; voting: boolean; signatory: boolean; since: string }[]; meetings: Meeting[]; events: Ev[]; can_manage: boolean }>(on && openBody && tab === 'bodies' ? `/api/meetings/bodies/${openBody}` : null);

  useEffect(() => {
    if (shell?.section && shell.section !== tab) { setTab(shell.section as Tab); setNote(null); setAsking(null); setOpenMeeting(null); setOpenRes(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell?.section]);
  useEffect(() => { if (!openBody && bodies.data?.[0]) setOpenBody(bodies.data[0].id); }, [bodies.data, openBody]);
  // Deep links from email: ?meeting=<id> and ?resolution=<id>.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const m = q.get('meeting'); const r = q.get('resolution');
    if (m) { void showMeeting(m); pickTab('meetings'); }
    else if (r) { void showResolution(r); pickTab('resolutions'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadAll = async () => { await Promise.all([ov.reload(), meetings.reload(), resolutions.reload(), actions.reload(), bodies.reload()]); };
  const act = async (key: string, work: () => Promise<string | void>) => {
    setBusy(key); setNote(null);
    try { const m = await work(); if (m) setNote(m); await reloadAll(); if (openMeeting) await showMeeting(openMeeting.meeting.id); if (openRes) await showResolution(openRes.resolution.id); }
    catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };
  const showMeeting = async (id: string) => { try { const d = await get<Detail>(`/api/meetings/meetings/${id}`); setOpenMeeting(d); setMinutesDraft(Object.fromEntries(d.agenda.map((i) => [i.id, { minutes: i.minutes ?? '', outcome: i.outcome ?? '' }]))); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } };
  const showResolution = async (id: string) => { try { setOpenRes(await get<ResDetail>(`/api/meetings/resolutions/${id}`)); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } };
  const f = (k: string) => form[k] ?? '';
  const setF = (k: string, v: string) => setForm((x) => ({ ...x, [k]: v }));
  const people = (members.data ?? []).filter((m) => m.active);
  const myBodies = (bodies.data ?? []).filter((b) => b.active);
  const manageAny = (bodies.data ?? []).some((b) => b.can_manage);
  const admin = ov.data?.me.admin ?? false;

  if (ov.error) return <div className="ig__workspace"><header className="ig__hero"><span className="ig__eyebrow">MEETINGS</span><h2>Meetings and resolutions</h2><p>{ov.error}</p></header></div>;
  const o = ov.data;
  const tabs: { id: Tab; name: string; count: number | null }[] = [
    { id: 'overview', name: 'Overview', count: o ? o.rsvpPending.length + o.openVotes.length + o.minutesToApprove.length : null },
    { id: 'meetings', name: 'Meetings', count: (meetings.data ?? []).filter((m) => ['called', 'in_progress'].includes(m.status)).length || null },
    { id: 'resolutions', name: 'Resolutions', count: (resolutions.data ?? []).filter((r) => r.status === 'open').length || null },
    { id: 'actions', name: 'Actions', count: (actions.data ?? []).filter((a) => a.status === 'open').length || null },
    { id: 'register', name: 'Register', count: null },
    { id: 'bodies', name: 'Boards & committees', count: null },
    ...(admin ? [{ id: 'setup' as Tab, name: 'Setup', count: null }] : []),
  ];

  const vote = (r: { id: string }, v: 'for' | 'against' | 'abstain') => act(`v-${r.id}`, async () => { await postJson(`/api/meetings/resolutions/${r.id}/vote`, { vote: v }); return `Vote recorded: ${v}.`; });

  // ------------------------------------------------------------ meeting room
  const room = openMeeting && (() => {
    const d = openMeeting; const m = d.meeting; const me = d.me;
    const live = m.status === 'in_progress';
    const itemRes = (i: Item) => d.resolutions.filter((r) => r.agenda_item_id === i.id);
    const itemActs = (i: Item) => d.actions.filter((a) => (a as Action & { agenda_item_id?: string | null }).agenda_item_id === i.id);
    return <div className="mt__room">
      <div className="mt__roomHead">
        <div>
          <button type="button" className="go__link" onClick={() => setOpenMeeting(null)}>‹ All meetings</button>
          <h3>{m.body} · Meeting {m.number}</h3>
          <p className="mt__big">{m.title}</p>
          <p className="ig__muted">{when(m.starts_at)}{m.ends_at ? ` – ${when(m.ends_at)}` : ''}{m.location ? ` · ${m.location}` : ''}{m.link ? <> · <a href={m.link} target="_blank" rel="noreferrer">join link</a></> : null} · <span className={`mt__pill mt__pill--${m.status}`}>{st(m.status)}</span>{m.short_notice_reason ? ` · short notice: ${m.short_notice_reason}` : ''}</p>
        </div>
        <QuorumRing present={d.quorum.present} voting={d.quorum.voting} met={d.quorum.met} />
      </div>

      <div className="mt__roomBar">
        {m.status === 'called' && !m.my_rsvp && <>
          <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act('rsvp', async () => { await postJson(`/api/meetings/meetings/${m.id}/rsvp`, { rsvp: 'yes' }); return 'You are attending.'; })}>I will attend</button>
          <button type="button" className="cs__btn" onClick={() => setAsking({ id: 'rsvp-no', label: 'Apologies (optional)', run: async (n) => { await postJson(`/api/meetings/meetings/${m.id}/rsvp`, { rsvp: 'no', apologies: n }); return 'Apologies sent.'; } })}>Send apologies</button>
        </>}
        {me.can_manage && m.status === 'draft' && <button type="button" className="cs__btn cs__btn--primary" disabled={busy === 'call'} onClick={() => void act('call', async () => { try { const r = await postJson<{ notified: number }>(`/api/meetings/meetings/${m.id}/call`, {}); return `Notice sent to ${r.notified}.`; } catch (err) { const msg = err instanceof Error ? err.message : String(err); if (/short notice/.test(msg)) { setAsking({ id: 'short', label: msg + ' Reason:', run: async (n) => { const r = await postJson<{ notified: number }>(`/api/meetings/meetings/${m.id}/call`, { shortNoticeReason: n }); return `Notice sent to ${r.notified} at short notice.`; } }); return; } throw err; } })}>Call the meeting</button>}
        {me.can_manage && m.status === 'called' && <button type="button" className="cs__btn cs__btn--primary" disabled={busy === 'start'} onClick={() => void act('start', async () => { try { const r = await postJson<{ quorum: boolean }>(`/api/meetings/meetings/${m.id}/start`, {}); return r.quorum ? 'Meeting started with a quorum.' : 'Meeting started.'; } catch (err) { const msg = err instanceof Error ? err.message : String(err); if (/no quorum/.test(msg)) { setAsking({ id: 'inq', label: msg + ' Note to proceed without a quorum:', run: async (n) => { await postJson(`/api/meetings/meetings/${m.id}/start`, { inquorateNote: n }); return 'Meeting started without a quorum: no resolution can pass.'; } }); return; } throw err; } })}>Start the meeting</button>}
        {me.can_manage && live && <button type="button" className="cs__btn cs__btn--primary" disabled={busy === 'close'} onClick={() => void act('close', async () => { await postJson(`/api/meetings/meetings/${m.id}/close`, {}); return 'Meeting closed. Finish the minutes, then have them approved.'; })}>Close the meeting</button>}
        {me.can_manage && m.status === 'minutes_draft' && !me.wrote_minutes && <button type="button" className="cs__btn cs__btn--primary" disabled={busy === 'approve'} onClick={() => void act('approve', async () => { const r = await postJson<{ sha256: string }>(`/api/meetings/meetings/${m.id}/approve-minutes`, {}); return `Minutes approved and sent to members. Fingerprint ${r.sha256.slice(0, 12)}…`; })}>Approve the minutes</button>}
        {m.status === 'minutes_draft' && me.wrote_minutes && <span className="ig__muted">You wrote these minutes; the chair or another officer approves them.</span>}
        {m.status === 'minutes_approved' && <a className="cs__btn" href={`/api/meetings/meetings/${m.id}/minutes.pdf`} target="_blank" rel="noreferrer">Open the minutes (PDF)</a>}
        {me.can_manage && ['draft', 'called'].includes(m.status) && <button type="button" className="cs__btn" onClick={() => setAsking({ id: 'cancel', label: 'Why is the meeting cancelled?', run: async (n) => { await postJson(`/api/meetings/meetings/${m.id}/cancel`, { reason: n }); setOpenMeeting(null); return 'Meeting cancelled.'; } })}>Cancel</button>}
      </div>

      <div className="mt__roomGrid">
        <section className="mt__agenda">
          <h4>Agenda</h4>
          <ol className="mt__timeline">
            {d.agenda.map((i) => <li key={i.id} className={`mt__item mt__item--${i.purpose}`}>
              <span className="mt__itemNo">{i.position}</span>
              <div className="mt__itemBody">
                <div className="mt__itemHead"><strong>{i.title}</strong><span className="mt__tag">{PURPOSE[i.purpose]}</span>{i.presenter && <span className="ig__muted">· {i.presenter}</span>}{i.duration_min ? <span className="ig__muted">· {i.duration_min} min</span> : null}</div>
                {i.papers.length > 0 && <p className="ig__muted">Papers: {i.papers.map((p) => p.filename).join(', ')}</p>}
                {itemRes(i).map((r) => <div key={r.id} className="mt__resCard">
                  <div className="mt__resHead"><strong>R-{r.number} {r.title}</strong><span className={`mt__pill mt__pill--${r.status}`}>{st(r.status)}</span></div>
                  {r.status !== 'draft' && <VoteBar f={r.votes_for} a={r.votes_against} ab={r.votes_abstain} eligible={r.eligible} />}
                  <div className="pp2__roleEdit">
                    {r.status === 'open' && me.can_vote && !r.my_vote && (['for', 'against', 'abstain'] as const).map((v) => <button key={v} type="button" className={`cs__btn ${v === 'for' ? 'cs__btn--primary' : ''}`} disabled={busy === `v-${r.id}`} onClick={() => void vote(r, v)}>{v === 'for' ? 'For' : v === 'against' ? 'Against' : 'Abstain'}</button>)}
                    {r.status === 'open' && r.my_vote && <span className="ig__muted">You voted {r.my_vote}.</span>}
                    {me.can_manage && r.status === 'draft' && live && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(`o-${r.id}`, async () => { const x = await postJson<{ eligible: number }>(`/api/meetings/resolutions/${r.id}/open`, {}); return `Vote open: ${x.eligible} can vote.`; })}>Put to the vote</button>}
                    {me.can_manage && r.status === 'open' && <button type="button" className="cs__btn" onClick={() => void act(`c-${r.id}`, async () => { const x = await postJson<{ status: string; why: string }>(`/api/meetings/resolutions/${r.id}/close`, {}); return `${st(x.status)}: ${x.why}`; })}>Close the vote</button>}
                    <button type="button" className="go__link" onClick={() => { void showResolution(r.id); pickTab('resolutions'); }}>Detail</button>
                  </div>
                </div>)}
                {itemActs(i).map((a) => <p key={a.id} className="mt__actionLine">A-{a.number} {a.title} — {a.owner}{a.due_on ? `, by ${day(a.due_on)}` : ''} <span className={`mt__pill mt__pill--${a.status}`}>{st(a.status)}</span></p>)}
                {me.can_manage && (live || m.status === 'minutes_draft') && <div className="mt__minutes">
                  <textarea className="cs__input" rows={3} placeholder="Minutes for this item…" value={minutesDraft[i.id]?.minutes ?? ''} onChange={(e) => setMinutesDraft((x) => ({ ...x, [i.id]: { minutes: e.target.value, outcome: x[i.id]?.outcome ?? '' } }))} />
                  <div className="pp2__roleEdit">
                    <input className="cs__input" placeholder="Outcome (one line)" value={minutesDraft[i.id]?.outcome ?? ''} onChange={(e) => setMinutesDraft((x) => ({ ...x, [i.id]: { minutes: x[i.id]?.minutes ?? '', outcome: e.target.value } }))} />
                    <button type="button" className="cs__btn" disabled={busy === `m-${i.id}`} onClick={() => void act(`m-${i.id}`, async () => { await postJson(`/api/meetings/meetings/${m.id}/minutes`, { itemId: i.id, ...minutesDraft[i.id] }); return 'Minutes saved.'; })}>Save minutes</button>
                    {live && (i.purpose === 'resolution' || i.purpose === 'decision') && <button type="button" className="cs__btn" onClick={() => { setF('r-item', i.id); setF('r-title', i.title); setF('r-text', ''); setF('panel', 'resolution'); }}>Draft a resolution</button>}
                    {live && <button type="button" className="cs__btn" onClick={() => { setF('a-item', i.id); setF('a-title', ''); setF('a-owner', ''); setF('a-due', ''); setF('panel', 'action'); }}>Add an action</button>}
                  </div>
                </div>}
                {!me.can_manage && i.minutes && <p className="mt__minutesRead">{i.minutes}{i.outcome ? <><br /><strong>Outcome:</strong> {i.outcome}</> : null}</p>}
                {me.can_manage && m.status === 'minutes_approved' && i.minutes && <p className="mt__minutesRead">{i.minutes}{i.outcome ? <><br /><strong>Outcome:</strong> {i.outcome}</> : null}</p>}
              </div>
            </li>)}
          </ol>
          {f('panel') === 'resolution' && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('newres', async () => { const r = await postJson<{ number: number }>('/api/meetings/resolutions', { meetingId: m.id, itemId: f('r-item') || undefined, title: f('r-title'), text: f('r-text'), kind: f('r-kind') || 'ordinary' }); setF('panel', ''); return `Resolution R-${r.number} drafted. Put it to the vote when ready.`; }); }}>
            <div className="ig__formTitle"><strong>Draft a resolution</strong><p>Wording that begins “IT WAS RESOLVED THAT …”. A special resolution needs two-thirds.</p></div>
            <Field id="r-title" label="Short title"><input id="r-title" className="cs__input" required value={f('r-title')} onChange={(e) => setF('r-title', e.target.value)} /></Field>
            <Field id="r-kind" label="Kind"><select id="r-kind" className="cs__input" value={f('r-kind') || 'ordinary'} onChange={(e) => setF('r-kind', e.target.value)}><option value="ordinary">Ordinary</option><option value="special">Special (two-thirds)</option></select></Field>
            <Field id="r-text" label="Resolved that…" wide><textarea id="r-text" className="cs__input" rows={4} required value={f('r-text')} onChange={(e) => setF('r-text', e.target.value)} /></Field>
            <div className="pp2__roleEdit"><button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'newres'}>Save draft</button><button type="button" className="cs__btn" onClick={() => setF('panel', '')}>Cancel</button></div>
          </form>}
          {f('panel') === 'action' && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('newact', async () => { const r = await postJson<{ number: number }>('/api/meetings/actions', { meetingId: m.id, itemId: f('a-item') || undefined, title: f('a-title'), ownerId: f('a-owner'), dueOn: f('a-due') || undefined }); setF('panel', ''); return `Action A-${r.number} agreed; the owner has been told.`; }); }}>
            <div className="ig__formTitle"><strong>Agree an action</strong></div>
            <Field id="a-title" label="What is to be done" wide><input id="a-title" className="cs__input" required value={f('a-title')} onChange={(e) => setF('a-title', e.target.value)} /></Field>
            <Field id="a-owner" label="Owner"><select id="a-owner" className="cs__input" required value={f('a-owner')} onChange={(e) => setF('a-owner', e.target.value)}><option value="">Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select></Field>
            <Field id="a-due" label="Due"><input id="a-due" type="date" className="cs__input" value={f('a-due')} onChange={(e) => setF('a-due', e.target.value)} /></Field>
            <div className="pp2__roleEdit"><button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'newact'}>Agree</button><button type="button" className="cs__btn" onClick={() => setF('panel', '')}>Cancel</button></div>
          </form>}
        </section>

        <aside className="mt__side">
          <h4>In the room</h4>
          <ul style={list} className="mt__people">
            {d.attendance.map((a) => <li key={a.actor_id} className={`mt__person ${a.present ? 'is-present' : ''}`}>
              <span className="mt__avatar">{a.display_name.split(' ').map((p) => p[0]).join('').slice(0, 2)}</span>
              <span className="mt__personText"><strong>{a.display_name}</strong><small>{ROLE[a.role]}{!a.voting ? ' · no vote' : ''}{a.present ? ' · present' : a.rsvp === 'yes' ? ' · coming' : a.rsvp === 'no' ? ` · apologies${a.apologies ? `: ${a.apologies}` : ''}` : a.rsvp === 'maybe' ? ' · maybe' : ''}</small></span>
              {me.can_manage && ['called', 'in_progress'].includes(m.status) && <button type="button" className={`mt__presence ${a.present ? 'is-on' : ''}`} aria-pressed={Boolean(a.present)} onClick={() => void act(`p-${a.actor_id}`, async () => { await postJson(`/api/meetings/meetings/${m.id}/presence`, { actorId: a.actor_id, present: !a.present }); })}>{a.present ? 'Here' : 'Mark here'}</button>}
            </li>)}
          </ul>
          <h4>Rules</h4>
          <p className="ig__muted">Quorum: {m.quorum_rule.type === 'count' ? `${m.quorum_rule.value} voting members` : `${Math.round(m.quorum_rule.value * 100)}% of voting members`} · Decisions: {RULE[m.decision_rule.type]}{m.decision_rule.chairCasting ? ', chair has a casting vote' : ''}{m.quorum_note ? ` · started without quorum: ${m.quorum_note}` : ''}</p>
          {d.minutes_file && <p className="ig__muted">Minutes fingerprint: <code>{d.minutes_file.sha256.slice(0, 16)}…</code></p>}
          <h4>Record</h4>
          <ul style={list} className="mt__log">{d.events.map((e, i) => <li key={i}><span>{when(e.occurred_at)}</span>{describeEvent(e)}{e.actor ? ` — ${e.actor}` : ''}</li>)}</ul>
        </aside>
      </div>
    </div>;
  })();

  // --------------------------------------------------------- resolution page
  const resPage = openRes && (() => {
    const r = openRes.resolution; const me = openRes.me;
    return <div className="mt__room">
      <div className="mt__roomHead">
        <div>
          <button type="button" className="go__link" onClick={() => setOpenRes(null)}>‹ All resolutions</button>
          <h3>{r.body} · {r.kind === 'special' ? 'Special' : 'Ordinary'} resolution R-{r.number}</h3>
          <p className="mt__big">{r.title}</p>
          <p className="ig__muted"><span className={`mt__pill mt__pill--${r.status}`}>{st(r.status)}</span>{r.meeting_id ? ' · put to a meeting' : ' · written resolution'}{r.deadline_at ? ` · vote by ${when(r.deadline_at)}` : ''}{r.closed_at ? ` · decided ${when(r.closed_at)}` : ''} · {RULE[r.decision_rule.type]}</p>
        </div>
      </div>
      <blockquote className="mt__resolved">IT WAS RESOLVED THAT {r.body_text}</blockquote>
      {openRes.tally ? <VoteBar f={openRes.tally.for} a={openRes.tally.against} ab={openRes.tally.abstain} eligible={r.eligible} /> : r.status === 'open' && <p className="ig__muted">{openRes.voted} of {r.eligible} have voted. The tally is shown when the vote closes.</p>}
      {r.result_note && <p className="ig__muted">{r.result_note}</p>}
      <div className="mt__roomBar">
        {me.can_vote && !me.my_vote && (['for', 'against', 'abstain'] as const).map((v) => <button key={v} type="button" className={`cs__btn ${v === 'for' ? 'cs__btn--primary' : ''}`} disabled={busy === `v-${r.id}`} onClick={() => void vote(r, v)}>{v === 'for' ? 'Vote for' : v === 'against' ? 'Vote against' : 'Abstain'}</button>)}
        {me.my_vote && r.status === 'open' && <span className="ig__muted">You voted {me.my_vote}.</span>}
        {me.can_manage && r.status === 'draft' && !r.meeting_id && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act('open', async () => { const x = await postJson<{ eligible: number; deadline: string }>(`/api/meetings/resolutions/${r.id}/open`, {}); return `Sent to ${x.eligible} members to vote by ${when(x.deadline)}.`; })}>Open the written vote</button>}
        {me.can_manage && r.status === 'open' && <button type="button" className="cs__btn" onClick={() => void act('closev', async () => { const x = await postJson<{ status: string; why: string }>(`/api/meetings/resolutions/${r.id}/close`, {}); return `${st(x.status)}: ${x.why}`; })}>Close the vote now</button>}
        {me.can_manage && r.status === 'passed' && <button type="button" className="cs__btn cs__btn--primary" disabled={busy === 'sign'} onClick={() => void act('sign', async () => { const x = await postJson<{ signers: number; required: number; waiting: boolean }>(`/api/meetings/resolutions/${r.id}/sign`, {}); return x.waiting ? 'The PDF is being checked; it goes out for signature in a minute.' : `Sent to ${x.signers} signatories (${x.required} needed).`; })}>Send for signature</button>}
        {(me.can_manage || me.is_proposer) && ['draft', 'open'].includes(r.status) && <button type="button" className="cs__btn" onClick={() => setAsking({ id: 'wd', label: 'Why withdraw it?', run: async (n) => { await postJson(`/api/meetings/resolutions/${r.id}/withdraw`, { reason: n }); return 'Withdrawn.'; } })}>Withdraw</button>}
        {openRes.envelope && <span className="ig__muted">Patform Sign envelope PS-{openRes.envelope.number}: {openRes.envelope.status}{openRes.envelope.final_sha256 ? ` · signed copy ${openRes.envelope.final_sha256.slice(0, 12)}…` : ''}</span>}
        {r.signing_error && <span className="ig__rowError">{r.signing_error}</span>}
      </div>
      <div className="mt__roomGrid">
        <section><h4>Votes</h4>
          <ul style={list} className="mt__people">{openRes.votes.map((v) => <li key={v.actor_id} className="mt__person is-present"><span className={`mt__voteDot is-${v.vote}`} /><span className="mt__personText"><strong>{v.display_name}</strong><small>{v.vote} · {when(v.cast_at)}{v.recorded_by ? ` · recorded by ${v.recorded_by}` : ''}</small></span></li>)}{!openRes.votes.length && <li className="ig__muted">No votes shown yet.</li>}</ul>
        </section>
        <aside className="mt__side"><h4>Record</h4><ul style={list} className="mt__log">{openRes.events.map((e, i) => <li key={i}><span>{when(e.occurred_at)}</span>{describeEvent(e)}{e.actor ? ` — ${e.actor}` : ''}</li>)}</ul></aside>
      </div>
    </div>;
  })();

  const meetingRow = (m: Meeting) => <li key={m.id} className="ig__row mt__meetingRow">
    <div className="mt__date"><strong>{new Date(m.starts_at).toLocaleDateString([], { day: '2-digit' })}</strong><small>{new Date(m.starts_at).toLocaleDateString([], { month: 'short' })}</small></div>
    <div className="ig__rowMain"><strong>{m.title}</strong><span className={`mt__pill mt__pill--${m.status}`}>{st(m.status)}</span><p>{m.body} · meeting {m.number} · {when(m.starts_at)}{m.location ? ` · ${m.location}` : ''} · {m.items} item{m.items === 1 ? '' : 's'}{m.my_rsvp ? ` · you: ${m.my_rsvp}` : ''}</p></div>
    <button type="button" className="cs__btn" onClick={() => { void showMeeting(m.id); pickTab('meetings'); }}>{m.status === 'in_progress' ? 'Enter the room' : 'Open'}</button>
  </li>;
  const resRow = (r: Res) => <li key={r.id} className="ig__row">
    <div className="ig__rowMain"><strong>R-{r.number} {r.title}</strong><span className={`mt__pill mt__pill--${r.status}`}>{st(r.status)}</span><p>{r.body}{r.kind === 'special' ? ' · special' : ''}{r.meeting_id ? ' · at a meeting' : ' · written'}{r.deadline_at && r.status === 'open' ? ` · by ${when(r.deadline_at)}` : ''}{r.status !== 'draft' && r.status !== 'open' ? ` · ${r.votes_for} for, ${r.votes_against} against` : ''}{r.signed_sha256 ? ' · signed copy on file' : ''}</p></div>
    <div className="pp2__roleEdit">
      {r.can_vote && !r.my_vote && <button type="button" className="cs__btn cs__btn--primary" onClick={() => { void showResolution(r.id); }}>Vote</button>}
      <button type="button" className="cs__btn" onClick={() => void showResolution(r.id)}>Open</button>
    </div>
  </li>;
  const actionRow = (a: Action) => <li key={a.id} className={`ig__row ${a.late ? 'mt__late' : ''}`}>
    <div className="ig__rowMain"><strong>A-{a.number} {a.title}</strong><span className={`mt__pill mt__pill--${a.status}`}>{a.late ? 'Late' : st(a.status)}</span><p>{a.owner} · {a.body}{a.meeting ? ` · ${a.meeting}` : ''}{a.due_on ? ` · due ${day(a.due_on)}` : ''}{a.done_note ? ` · ${a.done_note}` : ''}</p></div>
    {a.status === 'open' && a.can_close && <div className="pp2__roleEdit">
      <button type="button" className="cs__btn cs__btn--primary" onClick={() => setAsking({ id: `d-${a.id}`, label: 'What was done? (optional)', run: async (n) => { await postJson(`/api/meetings/actions/${a.id}/close`, { note: n }); return 'Action closed.'; } })}>Done</button>
      <button type="button" className="cs__btn" onClick={() => setAsking({ id: `x-${a.id}`, label: 'Why is it cancelled?', run: async (n) => { await postJson(`/api/meetings/actions/${a.id}/close`, { cancelled: true, note: n }); return 'Action cancelled.'; } })}>Cancel</button>
    </div>}
  </li>;
  const empty = (t: string) => <li className="ig__row"><div className="ig__rowMain"><p>{t}</p></div></li>;

  return <div className="ig__workspace">
    <header className="ig__hero">
      <span className="ig__eyebrow">MEETINGS</span>
      <h2>Boards, committees and the decisions they take</h2>
      <p>Notice, papers, quorum, votes, minutes and signed resolutions — recorded as they happen, so the register is the record.</p>
    </header>
    {o && <section className="pp2__overview" aria-label="Meetings at a glance" style={{ marginBottom: 18 }}>
      <div><span>Next meeting</span><strong>{o.upcoming[0] ? day(o.upcoming[0].starts_at) : '—'}</strong><small>{o.upcoming[0] ? `${o.upcoming[0].body}: ${o.upcoming[0].title}` : 'Nothing called'}</small></div>
      <div><span>Votes waiting for you</span><strong>{o.openVotes.length}</strong><small>{o.rsvpPending.length} meeting{o.rsvpPending.length === 1 ? '' : 's'} to reply to</small></div>
      <div><span>Your open actions</span><strong>{o.myActions.length}</strong><small>{o.myActions.filter((a) => a.late).length} late · {o.minutesToApprove.length} minutes to approve</small></div>
    </section>}

    <div className="ig__surface">
      {!shell && <div className="ig__tabs" role="tablist" aria-label="Meeting areas">{tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="ig__tab" onClick={() => pickTab(t.id)}><span>{t.name}</span>{t.count !== null && <span className="ig__tabCount">{t.count}</span>}</button>)}</div>}
      <ShellSync sections={tabs} onSections={shell?.onSections} />
      <section className="ig__panel">
        {note && <p className="ig__notice" role="status">{note}</p>}
        {asking && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); const job = asking; const a = answer.trim(); setAsking(null); setAnswer(''); void act(job.id, () => job.run(a)); }}>
          <Field id="mt-ask" label={asking.label} wide><input id="mt-ask" className="cs__input" autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} /></Field>
          <div className="pp2__roleEdit"><button type="submit" className="cs__btn cs__btn--primary">Continue</button><button type="button" className="cs__btn" onClick={() => { setAsking(null); setAnswer(''); }}>Cancel</button></div>
        </form>}

        {tab === 'overview' && o && !openMeeting && !openRes && <div className="mt__overview">
          {o.rsvpPending.length > 0 && <section><h4>Reply to</h4><ul style={list}>{o.rsvpPending.map(meetingRow)}</ul></section>}
          {o.openVotes.length > 0 && <section><h4>Vote now</h4><ul style={list}>{o.openVotes.map(resRow)}</ul></section>}
          {o.minutesToApprove.length > 0 && <section><h4>Minutes to approve</h4><ul style={list}>{o.minutesToApprove.map((m) => <li key={m.id} className="ig__row"><div className="ig__rowMain"><strong>{m.title}</strong><p>{m.body}</p></div><button type="button" className="cs__btn cs__btn--primary" onClick={() => { void showMeeting(m.id); pickTab('meetings'); }}>Review</button></li>)}</ul></section>}
          {o.toSign.length > 0 && <section><h4>Passed, not yet signed</h4><ul style={list}>{o.toSign.map((r) => <li key={r.id} className="ig__row"><div className="ig__rowMain"><strong>R-{r.number} {r.title}</strong><p>{r.body}</p></div><button type="button" className="cs__btn" onClick={() => { void showResolution(r.id); pickTab('resolutions'); }}>Open</button></li>)}</ul></section>}
          <section><h4>Coming up</h4><ul style={list}>{o.upcoming.map(meetingRow)}{!o.upcoming.length && empty('No meetings called. The secretary of a body calls one from Meetings.')}</ul></section>
          {o.myActions.length > 0 && <section><h4>Your actions</h4><ul style={list}>{o.myActions.map(actionRow)}</ul></section>}
          {!myBodies.length && <p className="ig__muted" style={{ padding: '0 28px 24px' }}>{admin ? 'Start by creating a board or committee under “Boards & committees”.' : 'You are not on any board or committee yet.'}</p>}
        </div>}

        {tab === 'meetings' && (room ?? <>
          {manageAny && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('newm', async () => {
            const r = await postJson<{ id: string; number: number }>('/api/meetings/meetings', { bodyId: f('m-body'), title: f('m-title'), kind: f('m-kind') || 'ordinary', startsAt: new Date(f('m-start')).toISOString(), endsAt: f('m-end') ? new Date(f('m-end')).toISOString() : undefined, location: f('m-loc'), link: f('m-link'), agenda: agenda.filter((a) => a.title.trim()) });
            setForm({}); setAgenda([]); await showMeeting(r.id); return `Meeting ${r.number} drafted. Call it to send the notice.`; }); }}>
            <div className="ig__formTitle"><strong>Draft a meeting</strong><p>Set the agenda, then call it: the notice goes to every member with the agenda, and they reply. The body needs {settings.data?.settings.noticeDays ?? 7} days’ notice unless you record a reason.</p></div>
            <Field id="m-body" label="Body"><select id="m-body" className="cs__input" required value={f('m-body')} onChange={(e) => setF('m-body', e.target.value)}><option value="">Choose…</option>{myBodies.filter((b) => b.can_manage).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            <Field id="m-title" label="Title"><input id="m-title" className="cs__input" required value={f('m-title')} onChange={(e) => setF('m-title', e.target.value)} /></Field>
            <Field id="m-kind" label="Kind"><select id="m-kind" className="cs__input" value={f('m-kind') || 'ordinary'} onChange={(e) => setF('m-kind', e.target.value)}><option value="ordinary">Ordinary</option><option value="extraordinary">Extraordinary</option><option value="annual">Annual</option></select></Field>
            <Field id="m-start" label="Starts"><input id="m-start" type="datetime-local" className="cs__input" required value={f('m-start') || toLocalInput(new Date(Date.now() + 8 * 86400000))} onChange={(e) => setF('m-start', e.target.value)} /></Field>
            <Field id="m-end" label="Ends (optional)"><input id="m-end" type="datetime-local" className="cs__input" value={f('m-end')} onChange={(e) => setF('m-end', e.target.value)} /></Field>
            <Field id="m-loc" label="Place"><input id="m-loc" className="cs__input" value={f('m-loc')} onChange={(e) => setF('m-loc', e.target.value)} /></Field>
            <Field id="m-link" label="Video link (optional)"><input id="m-link" className="cs__input" value={f('m-link')} onChange={(e) => setF('m-link', e.target.value)} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="cs__label">Agenda</label>
              <ol className="mt__agendaEdit">{agenda.map((a, i) => <li key={i}>
                <span className="mt__itemNo">{i + 1}</span>
                <input className="cs__input" placeholder="Item" value={a.title} onChange={(e) => setAgenda((x) => x.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)))} />
                <select className="cs__input" value={a.purpose} onChange={(e) => setAgenda((x) => x.map((y, j) => (j === i ? { ...y, purpose: e.target.value } : y)))}>{Object.entries(PURPOSE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <select className="cs__input" value={a.presenterId} onChange={(e) => setAgenda((x) => x.map((y, j) => (j === i ? { ...y, presenterId: e.target.value } : y)))}><option value="">Presenter…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select>
                <input className="cs__input" style={{ width: 70 }} placeholder="min" value={a.durationMin} onChange={(e) => setAgenda((x) => x.map((y, j) => (j === i ? { ...y, durationMin: e.target.value } : y)))} />
                <button type="button" className="cs__btn" aria-label="Remove item" onClick={() => setAgenda((x) => x.filter((_, j) => j !== i))}>×</button>
              </li>)}</ol>
              <button type="button" className="cs__btn" onClick={() => setAgenda((x) => [...x, { title: '', purpose: 'discussion', presenterId: '', durationMin: '' }])}>+ Add agenda item</button>
            </div>
            <div className="pp2__roleEdit"><button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'newm'}>Save draft</button></div>
          </form>}
          <ul style={list}>{(meetings.data ?? []).map(meetingRow)}{meetings.data && !meetings.data.length && empty('No meetings yet.')}</ul>
        </>)}

        {tab === 'resolutions' && (resPage ?? <>
          {manageAny && myBodies.some((b) => b.written_resolutions) && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('newwr', async () => { const r = await postJson<{ id: string; number: number }>('/api/meetings/resolutions', { bodyId: f('w-body'), title: f('w-title'), text: f('w-text'), kind: f('w-kind') || 'ordinary' }); setForm({}); await showResolution(r.id); return `Written resolution R-${r.number} drafted. Open the vote to send it to members.`; }); }}>
            <div className="ig__formTitle"><strong>Written resolution</strong><p>Passed without a meeting: every voting member is asked, and it needs the majority of all of them — an unanswered vote is not a yes.</p></div>
            <Field id="w-body" label="Body"><select id="w-body" className="cs__input" required value={f('w-body')} onChange={(e) => setF('w-body', e.target.value)}><option value="">Choose…</option>{myBodies.filter((b) => b.can_manage && b.written_resolutions).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            <Field id="w-kind" label="Kind"><select id="w-kind" className="cs__input" value={f('w-kind') || 'ordinary'} onChange={(e) => setF('w-kind', e.target.value)}><option value="ordinary">Ordinary</option><option value="special">Special (two-thirds)</option></select></Field>
            <Field id="w-title" label="Short title" wide><input id="w-title" className="cs__input" required value={f('w-title')} onChange={(e) => setF('w-title', e.target.value)} /></Field>
            <Field id="w-text" label="Resolved that…" wide><textarea id="w-text" className="cs__input" rows={4} required value={f('w-text')} onChange={(e) => setF('w-text', e.target.value)} /></Field>
            <div className="pp2__roleEdit"><button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'newwr'}>Save draft</button></div>
          </form>}
          <ul style={list}>{(resolutions.data ?? []).map(resRow)}{resolutions.data && !resolutions.data.length && empty('No resolutions yet.')}</ul>
        </>)}

        {tab === 'actions' && <ul style={list}>{(actions.data ?? []).map(actionRow)}{actions.data && !actions.data.length && empty('No actions agreed yet.')}</ul>}

        {tab === 'register' && <>
          <div className="ig__panelHead"><div><h3>Resolution register</h3><p>Every decided resolution of a body: how it was decided, when, and the fingerprint of the signed copy. Viewing is itself recorded.</p></div>
            <div className="pp2__roleEdit"><select className="cs__input" value={openBody ?? ''} onChange={(e) => setOpenBody(e.target.value)}>{myBodies.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>{openBody && <a className="cs__btn" href={`/api/meetings/bodies/${openBody}/register?format=csv`}>Download CSV</a>}</div></div>
          <table className="vw__table mt__table"><thead><tr><th scope="col">No.</th><th scope="col">Resolution</th><th scope="col">Decided</th><th scope="col">Votes</th><th scope="col">Signed copy</th></tr></thead>
            <tbody>{(register.data ?? []).map((r) => <tr key={String(r.number)}><td>R-{String(r.number)}</td><td>{String(r.title)}<br /><small className="ig__muted">{r.kind === 'special' ? 'special · ' : ''}{r.meeting_number ? `meeting ${r.meeting_number}` : 'written'}</small></td><td><span className={`mt__pill mt__pill--${r.status}`}>{st(String(r.status))}</span><br /><small className="ig__muted">{when(r.closed_at as string | null)}</small></td><td>{String(r.votes_for)} / {String(r.votes_against)} / {String(r.votes_abstain)}<br /><small className="ig__muted">of {String(r.eligible ?? '—')}</small></td><td>{r.signed_sha256 ? <code>{String(r.signed_sha256).slice(0, 16)}…</code> : r.envelope_number ? `PS-${r.envelope_number} pending` : '—'}</td></tr>)}
              {register.data && !register.data.length && <tr><td colSpan={5} className="ig__muted">Nothing decided yet.</td></tr>}</tbody></table>
        </>}

        {tab === 'bodies' && <>
          {admin && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('newb', async () => { const r = await postJson<{ id: string }>('/api/meetings/bodies', { name: f('b-name'), kind: f('b-kind') || 'committee', quorum: { type: f('b-qtype') || 'fraction', value: Number(f('b-qval') || (f('b-qtype') === 'count' ? 2 : 0.5)) }, decision: { type: f('b-rule') || 'simple_majority', chairCasting: f('b-cast') !== 'no' }, companyName: f('b-co') || undefined, register: f('b-reg') ? { country: f('b-regc') || 'GB', number: f('b-reg') } : undefined, signaturesRequired: Number(f('b-sig') || 1), writtenResolutions: f('b-written') !== 'no' }); setForm({}); setOpenBody(r.id); return 'Body created. Add its members.'; }); }}>
            <div className="ig__formTitle"><strong>New board or committee</strong><p>Its quorum and decision rules apply to every meeting and vote. A company name and register number let it sign resolutions as the company through Patform Sign.</p></div>
            <Field id="b-name" label="Name"><input id="b-name" className="cs__input" required value={f('b-name')} onChange={(e) => setF('b-name', e.target.value)} /></Field>
            <Field id="b-kind" label="Kind"><select id="b-kind" className="cs__input" value={f('b-kind') || 'committee'} onChange={(e) => setF('b-kind', e.target.value)}><option value="board">Board</option><option value="committee">Committee</option><option value="management">Management team</option><option value="general">General meeting</option></select></Field>
            <Field id="b-qtype" label="Quorum"><select id="b-qtype" className="cs__input" value={f('b-qtype') || 'fraction'} onChange={(e) => setF('b-qtype', e.target.value)}><option value="fraction">Share of voting members</option><option value="count">A number of voting members</option></select></Field>
            <Field id="b-qval" label={f('b-qtype') === 'count' ? 'How many' : 'Share (0.5 = half)'}><input id="b-qval" className="cs__input" value={f('b-qval')} placeholder={f('b-qtype') === 'count' ? '2' : '0.5'} onChange={(e) => setF('b-qval', e.target.value)} /></Field>
            <Field id="b-rule" label="Decisions"><select id="b-rule" className="cs__input" value={f('b-rule') || 'simple_majority'} onChange={(e) => setF('b-rule', e.target.value)}><option value="simple_majority">Simple majority</option><option value="two_thirds">Two-thirds</option><option value="unanimous">Unanimous</option></select></Field>
            <Field id="b-cast" label="Chair's casting vote on a tie"><select id="b-cast" className="cs__input" value={f('b-cast') || 'yes'} onChange={(e) => setF('b-cast', e.target.value)}><option value="yes">Yes</option><option value="no">No</option></select></Field>
            <Field id="b-co" label="Signs as company (optional)"><input id="b-co" className="cs__input" placeholder="Acme Ltd" value={f('b-co')} onChange={(e) => setF('b-co', e.target.value)} /></Field>
            <Field id="b-reg" label="Company register number (optional)"><div className="pp2__roleEdit"><select className="cs__input" style={{ width: 80 }} value={f('b-regc') || 'GB'} onChange={(e) => setF('b-regc', e.target.value)}><option value="GB">GB</option><option value="NG">NG</option></select><input id="b-reg" className="cs__input" value={f('b-reg')} onChange={(e) => setF('b-reg', e.target.value)} /></div></Field>
            <Field id="b-sig" label="Signatures needed on a resolution"><input id="b-sig" className="cs__input" value={f('b-sig')} placeholder="2" onChange={(e) => setF('b-sig', e.target.value)} /></Field>
            <Field id="b-written" label="Written resolutions allowed"><select id="b-written" className="cs__input" value={f('b-written') || 'yes'} onChange={(e) => setF('b-written', e.target.value)}><option value="yes">Yes</option><option value="no">No</option></select></Field>
            <div className="pp2__roleEdit"><button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'newb'}>Create</button></div>
          </form>}
          <div className="mt__bodies">
            {myBodies.map((b) => <button key={b.id} type="button" className={`mt__bodyCard ${openBody === b.id ? 'is-open' : ''}`} onClick={() => setOpenBody(b.id)}>
              <strong>{b.name}</strong><small>{b.kind} · {b.members} member{b.members === 1 ? '' : 's'}{b.my_role ? ` · you: ${ROLE[b.my_role]}` : ''}</small><small>{RULE[b.decision_rule.type]} · quorum {b.quorum_rule.type === 'count' ? b.quorum_rule.value : `${Math.round(b.quorum_rule.value * 100)}%`}{b.company_name ? ` · signs as ${b.company_name}` : ''}</small>
            </button>)}
            {!myBodies.length && <p className="ig__muted">No boards or committees yet.</p>}
          </div>
          {bodyDetail.data && <div className="mt__members">
            <div className="ig__panelHead"><div><h3>{bodyDetail.data.body.name}</h3><p>Chair and secretary run meetings; members vote; observers attend without a vote. Signatories sign passed resolutions.</p></div></div>
            {bodyDetail.data.can_manage && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('addm', async () => { await postJson(`/api/meetings/bodies/${openBody}/members`, { actorId: f('mm-who'), role: f('mm-role') || 'member', voting: f('mm-vote') !== 'no', signatory: f('mm-sig') === 'yes' }); setForm({}); await bodyDetail.reload(); return 'Member set.'; }); }}>
              <Field id="mm-who" label="Person"><select id="mm-who" className="cs__input" required value={f('mm-who')} onChange={(e) => setF('mm-who', e.target.value)}><option value="">Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select></Field>
              <Field id="mm-role" label="Role"><select id="mm-role" className="cs__input" value={f('mm-role') || 'member'} onChange={(e) => setF('mm-role', e.target.value)}>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field id="mm-vote" label="Votes"><select id="mm-vote" className="cs__input" value={f('mm-vote') || 'yes'} onChange={(e) => setF('mm-vote', e.target.value)}><option value="yes">Yes</option><option value="no">No</option></select></Field>
              <Field id="mm-sig" label="Signatory"><select id="mm-sig" className="cs__input" value={f('mm-sig') || (f('mm-role') === 'chair' ? 'yes' : 'no')} onChange={(e) => setF('mm-sig', e.target.value)}><option value="no">No</option><option value="yes">Yes</option></select></Field>
              <div className="pp2__roleEdit"><button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'addm'}>Add or update</button></div>
            </form>}
            <ul style={list}>{bodyDetail.data.members.map((mm) => <li key={mm.actor_id} className="ig__row"><div className="ig__rowMain"><strong>{mm.display_name}</strong><span className="ig__status">{ROLE[mm.role]}</span><p>{mm.email} · {mm.voting ? 'votes' : 'no vote'}{mm.signatory ? ' · signatory' : ''} · since {day(mm.since)}</p></div>
              {bodyDetail.data!.can_manage && <button type="button" className="cs__btn" onClick={() => void act(`rm-${mm.actor_id}`, async () => { await postJson(`/api/meetings/bodies/${openBody}/members`, { actorId: mm.actor_id, remove: true }); await bodyDetail.reload(); return 'Removed from the body.'; })}>Remove</button>}</li>)}</ul>
          </div>}
        </>}

        {tab === 'setup' && settings.data && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('settings', async () => { await postJson('/api/meetings/settings', { noticeDays: f('s-notice') || settings.data!.settings.noticeDays, reminderHours: f('s-rem') || settings.data!.settings.reminderHours, actionReminderDays: f('s-act') || settings.data!.settings.actionReminderDays, writtenDays: f('s-wr') || settings.data!.settings.writtenDays }); await settings.reload(); return 'Saved.'; }); }}>
          <div className="ig__formTitle"><strong>Meeting rules for this workspace</strong><p>Notice periods and reminders. Quorum and decision rules belong to each body.</p></div>
          <Field id="s-notice" label="Days of notice a meeting needs"><input id="s-notice" className="cs__input" value={f('s-notice') || String(settings.data.settings.noticeDays)} onChange={(e) => setF('s-notice', e.target.value)} /></Field>
          <Field id="s-rem" label="Reminder, hours before"><input id="s-rem" className="cs__input" value={f('s-rem') || String(settings.data.settings.reminderHours)} onChange={(e) => setF('s-rem', e.target.value)} /></Field>
          <Field id="s-act" label="Remind action owners, days before due"><input id="s-act" className="cs__input" value={f('s-act') || String(settings.data.settings.actionReminderDays)} onChange={(e) => setF('s-act', e.target.value)} /></Field>
          <Field id="s-wr" label="Written resolutions stay open, days"><input id="s-wr" className="cs__input" value={f('s-wr') || String(settings.data.settings.writtenDays)} onChange={(e) => setF('s-wr', e.target.value)} /></Field>
          <div className="pp2__roleEdit"><button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'settings'}>Save</button></div>
        </form>}
      </section>
    </div>
  </div>;
}
