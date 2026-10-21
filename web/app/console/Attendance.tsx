'use client';

import { useCallback, useEffect, useState } from 'react';
import './attendance.css';
import { AttendanceRecords } from './AttendanceRecords';
import { Illustration } from './illustrations';
import { ShellSync, type ModuleShell } from './module-shell';

type Shift = { id: string; actorId: string; employeeName: string; startsAt: string; endsAt: string; timezone: string; workplace: string | null; roleName: string | null };
type Exception = { id: string; employeeName: string; employeeId: string; startedAt: string; endedAt: string | null; exceptionReason: string | null; reviewStatus: string };
type Team = { people: { id: string; display_name: string }[]; shifts: Shift[] };
type MyTime = { current: null | { startedAt: string; state: string; reviewStatus: string }; recent: { id: string; startedAt: string; endedAt: string | null; reviewStatus: string }[] };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.reason ?? data.error ?? 'Could not complete this action.');
  return data as T;
}

export function AttendanceView({ shell }: { shell?: ModuleShell } = {}) {
  const [tab, setTab] = useState<'overview' | 'records' | 'periods'>('overview');
  const [team, setTeam] = useState<Team | null>(null);
  const [queue, setQueue] = useState<Exception[]>([]);
  const [myTime, setMyTime] = useState<MyTime | null>(null);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(false);
  const [person, setPerson] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [workplace, setWorkplace] = useState('');
  const [roleName, setRoleName] = useState('');
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const refresh = useCallback(async () => {
    try {
      const [nextTeam, nextQueue, nextMyTime] = await Promise.all([api<Team>('/api/attendance/shifts'), api<Exception[]>('/api/attendance/review'), api<MyTime>('/api/attendance/workday')]);
      setTeam(nextTeam); setQueue(nextQueue); setMyTime(nextMyTime); setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load attendance.'); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const save = async () => {
    setBusy(true);
    try {
      await api('/api/attendance/shifts', { actorId: person, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, workplace, roleName });
      setSheet(false); setStart(''); setEnd(''); setWorkplace(''); setRoleName(''); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not schedule the shift.'); }
    finally { setBusy(false); }
  };
  const decide = async (id: string, decision: 'approved' | 'declined') => {
    if (decision === 'declined' && !reviewNote.trim()) { setError('Add a reason before declining the schedule exception.'); return; }
    setBusy(true);
    try { await api(`/api/attendance/review/${id}`, { decision, note: decision === 'declined' ? reviewNote : '' }); setDeclining(null); setReviewNote(''); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not review this item.'); }
    finally { setBusy(false); }
  };
  const format = (value: string, zone?: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(new Date(value));
  const canSchedule = Boolean(team?.people.length);
  const activeTab = shell ? shell.section === 'records' || shell.section === 'periods' ? shell.section : 'overview' : tab;
  const pickTab = (next: 'overview' | 'records' | 'periods') => { setTab(next); shell?.onSection?.(next); };
  const sections = [{ id: 'overview', name: 'Workday', count: null }, { id: 'records', name: 'My records', count: null }, { id: 'periods', name: 'Timesheets', count: null }];
  const nextShift = team?.shifts[0];
  const isWorking = Boolean(myTime?.current);
  return <main className="att">
    <ShellSync sections={sections} onSections={shell?.onSections} />
    {!shell && <nav className="att__tabs" aria-label="Attendance views"><button type="button" aria-current={activeTab === 'overview' ? 'page' : undefined} onClick={() => pickTab('overview')}>Workday</button><button type="button" aria-current={activeTab === 'records' ? 'page' : undefined} onClick={() => pickTab('records')}>My records</button><button type="button" aria-current={activeTab === 'periods' ? 'page' : undefined} onClick={() => pickTab('periods')}>Timesheets</button></nav>}
    {error && <p className="att__error" role="alert">{error} <button type="button" onClick={() => void refresh()}>Retry</button></p>}
    {activeTab === 'overview' ? <>
    <header className="att__hero">
      <div className="att__heroCopy"><span className="att__eyebrow">TIME & ATTENDANCE / WORKDAY</span><h1>Make every hour<br /><em>make sense.</em></h1><p>One place for shifts, real clock time, and the decisions in between.</p><div className="att__heroActions"><a className="att__primary" href="/go">Open my workday <span aria-hidden="true">↗</span></a>{canSchedule && <button type="button" className="att__secondary" onClick={() => { setPerson(team?.people[0]?.id ?? ''); setSheet(true); }}>Schedule a shift <span aria-hidden="true">＋</span></button>}</div></div>
      <div className="att__heroScene" aria-hidden="true"><div className="att__orbit att__orbit--one"/><div className="att__orbit att__orbit--two"/><div className="att__clock"><span className="att__clockNeedle att__clockNeedle--hour"/><span className="att__clockNeedle att__clockNeedle--minute"/><span className="att__clockCenter"/></div><div className="att__sceneChip att__sceneChip--plan"><span className="att__sceneDot"/> Plan the shift</div><div className="att__sceneChip att__sceneChip--record"><span className="att__sceneDot"/> Record the work</div><div className="att__sceneChip att__sceneChip--review"><span className="att__sceneDot"/> Review the time</div></div>
    </header>
    <div className="att__overviewGrid">
      <section className="att__workday" aria-labelledby="att-workday-heading"><div className="att__workdayTop"><span className="att__eyebrow">MY WORKDAY</span><span className={`att__liveBadge${isWorking ? ' att__liveBadge--on' : ''}`}><i aria-hidden="true" />{myTime === null ? 'Loading' : isWorking ? myTime?.current?.state === 'break' ? 'On break' : 'Working' : 'Not clocked in'}</span></div><div className="att__workdayContent"><div><h2 id="att-workday-heading">{isWorking ? 'Your time is being recorded.' : 'Ready when you are.'}</h2><p>{isWorking ? `Started ${format(myTime!.current!.startedAt)}${myTime!.current!.reviewStatus === 'pending' ? ' · Schedule review pending' : ''}` : nextShift ? `Next shift: ${format(nextShift.startsAt, nextShift.timezone)}${nextShift.workplace ? ` · ${nextShift.workplace}` : ''}` : 'Your next shift will appear here when it is scheduled.'}</p><a href="/go" className="att__workdayLink">{isWorking ? 'Manage my workday' : 'Clock in from Workday'} <span aria-hidden="true">↗</span></a></div><span className="att__workdayArt"><Illustration name="calendar" size={96}/></span></div></section>
      {canSchedule && <div className="att__pulse" aria-label="Attendance at a glance"><div><span>Scheduled</span><strong>{team?.shifts.length ?? '—'}</strong><small>next two weeks</small></div><div><span>Needs review</span><strong>{queue.length}</strong><small>{queue.length ? 'waiting for a decision' : 'all clear'}</small></div><div><span>Team</span><strong>{team?.people.length ?? '—'}</strong><small>members</small></div></div>}
    </div>
    {canSchedule && <section className="att__section att__review"><div className="att__sectionHead"><div><span className="att__eyebrow">MANAGER REVIEW</span><h2>Schedule exceptions</h2><p>Resolve unusual starts without changing the original clock record.</p></div><span className="att__sectionCount">{queue.length} to review</span></div>
      {queue.length ? <div className="att__list">{queue.map((item) => <article className="att__row" key={item.id}><div><strong>{item.employeeName}</strong><span>{format(item.startedAt)} · {item.endedAt ? 'Clocked out' : 'Still working'}</span><small>{item.exceptionReason || 'No scheduled shift'}</small></div><div className="att__rowActions"><button type="button" disabled={busy} onClick={() => void decide(item.id, 'approved')}>Approve exception</button><button type="button" disabled={busy} onClick={() => { setDeclining(item.id); setReviewNote(''); }}>Decline exception</button></div>{declining === item.id && <div className="att__reviewNote"><label htmlFor={`att-note-${item.id}`}>Reason for declining the schedule exception</label><textarea id={`att-note-${item.id}`} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} maxLength={1000} placeholder="Explain the decision. The clock record will remain intact." /><div><button type="button" disabled={busy || !reviewNote.trim()} onClick={() => void decide(item.id, 'declined')}>Save decision</button><button type="button" onClick={() => setDeclining(null)}>Cancel</button></div></div>}</article>)}</div> : <div className="att__emptyReview"><span className="att__emptyReviewArt"><Illustration name="actions" size={60}/></span><div><strong>Nothing needs a decision.</strong><p>New schedule exceptions will appear here, with the clock record beside them.</p></div></div>}
    </section>}
    <section className="att__section att__schedule"><div className="att__sectionHead"><div><span className="att__eyebrow">LOOKING AHEAD</span><h2>Upcoming shifts</h2><p>{team?.shifts.length ? 'A clear plan for the next two weeks.' : 'Give the team a clear start to each workday.'}</p></div>{canSchedule && <button type="button" className="att__textAction" onClick={() => { setPerson(team?.people[0]?.id ?? ''); setSheet(true); }}>Add a shift <span aria-hidden="true">↗</span></button>}</div>
      {team?.shifts.length ? <div className="att__shiftGrid">{team.shifts.map((shift) => <article className="att__shift" key={shift.id}><span className="att__shiftDate"><strong>{new Intl.DateTimeFormat(undefined,{day:'2-digit',timeZone:shift.timezone}).format(new Date(shift.startsAt))}</strong><small>{new Intl.DateTimeFormat(undefined,{month:'short',timeZone:shift.timezone}).format(new Date(shift.startsAt))}</small></span><div><strong>{shift.employeeName}</strong><span>{new Intl.DateTimeFormat(undefined, { timeStyle: 'short', timeZone: shift.timezone }).format(new Date(shift.startsAt))} – {new Intl.DateTimeFormat(undefined, { timeStyle: 'short', timeZone: shift.timezone }).format(new Date(shift.endsAt))}</span><small>{shift.workplace || 'Workplace not set'}{shift.roleName ? ` · ${shift.roleName}` : ''}</small></div></article>)}</div> : <div className="att__emptySchedule"><span><Illustration name="calendar" size={74}/></span><div><strong>No shifts on the calendar yet</strong><p>Scheduled shifts give people a timely clock-in prompt.</p>{canSchedule && <button type="button" className="att__textAction" onClick={() => { setPerson(team?.people[0]?.id ?? ''); setSheet(true); }}>Schedule the first shift <span aria-hidden="true">↗</span></button>}</div></div>}
    </section>
    {myTime?.recent.length ? <section className="att__section att__recent"><div className="att__sectionHead"><div><span className="att__eyebrow">RECENT ACTIVITY</span><h2>My latest records</h2></div><button type="button" className="att__textAction" onClick={() => pickTab('records')}>See all records <span aria-hidden="true">↗</span></button></div>{myTime.recent.slice(0, 3).map((session) => <div className="att__myRow" key={session.id}>{format(session.startedAt)} → {session.endedAt ? format(session.endedAt) : 'Open'} <span>{session.reviewStatus === 'pending' ? 'Needs review' : 'Recorded'}</span></div>)}</section> : null}
    {sheet && <div className="att__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSheet(false); }}><section className="att__sheet" role="dialog" aria-modal="true" aria-labelledby="att-sheet-title"><div className="att__sheetHead"><div><span className="att__eyebrow">PLANNED WORK</span><h2 id="att-sheet-title">Schedule a shift</h2></div><button type="button" aria-label="Close" onClick={() => setSheet(false)}>×</button></div><p>This is the plan. Clock events record what actually happens. Enter times in your device’s time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p><label>Team member<select value={person} onChange={(event) => setPerson(event.target.value)}><option value="">Choose a person</option>{team?.people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label><label>Starts<input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>Ends<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label><label>Workplace<input value={workplace} onChange={(event) => setWorkplace(event.target.value)} placeholder="Branch or workplace" /></label><label>Role for this shift<input value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="Optional" /></label><button type="button" className="att__primary" disabled={busy || !person || !start || !end} onClick={() => void save()}>Save shift</button></section></div>}
    </> : <><header className="att__subhead"><div><span className="att__eyebrow">TIME & ATTENDANCE / {activeTab === 'records' ? 'MY RECORDS' : 'TIMESHEETS'}</span><h1>{activeTab === 'records' ? 'Your hours, in full.' : 'From recorded to approved.'}</h1><p>{activeTab === 'records' ? 'A clear history of workdays and correction requests.' : 'Review the hours behind each pay period.'}</p></div><span className="att__subheadArt"><Illustration name={activeTab === 'records' ? 'register' : 'calendar'} size={112}/></span></header><AttendanceRecords mode={activeTab} /></>}
  </main>;
}
