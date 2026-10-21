'use client';

import { useCallback, useEffect, useState } from 'react';
import './attendance.css';

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

export function AttendanceView() {
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
  return <main className="att">
    <header className="att__intro"><div><span className="att__eyebrow">TIME & ATTENDANCE</span><h1>Every hour, accounted for.</h1><p>Planned shifts and actual time stay clear from start to review.</p></div>{canSchedule && <button type="button" className="att__primary" onClick={() => { setPerson(team?.people[0]?.id ?? ''); setSheet(true); }}>Schedule shift</button>}</header>
    {error && <p className="att__error" role="alert">{error} <button type="button" onClick={() => void refresh()}>Retry</button></p>}
    <section className="att__section"><div className="att__sectionHead"><div><span className="att__eyebrow">YOUR RECORD</span><h2>My time</h2></div><a href="/go">Open Workday on your phone ↗</a></div>{myTime?.current ? <p className="att__myStatus">{myTime.current.state === 'break' ? 'On break' : 'Working'} since {format(myTime.current.startedAt)}{myTime.current.reviewStatus === 'pending' ? ' · Schedule review pending' : ''}</p> : <p className="att__myStatus">You are not clocked in.</p>}{myTime?.recent.map((session) => <div className="att__myRow" key={session.id}>{format(session.startedAt)} → {session.endedAt ? format(session.endedAt) : 'Open'} <span>{session.reviewStatus === 'pending' ? 'Needs review' : 'Recorded'}</span></div>)}</section>
    {canSchedule && <><div className="att__stats"><div><strong>{team?.shifts.length ?? '—'}</strong><span>Upcoming shifts</span></div><div><strong>{queue.length}</strong><span>Needs review</span></div><div><strong>{team?.people.length ?? '—'}</strong><span>Team members</span></div></div>
    <section className="att__section"><div className="att__sectionHead"><div><span className="att__eyebrow">MANAGER INBOX</span><h2>Schedule exceptions</h2></div><span>{queue.length} open</span></div>
      {queue.length ? <div className="att__list">{queue.map((item) => <article className="att__row" key={item.id}><div><strong>{item.employeeName}</strong><span>{format(item.startedAt)} · {item.endedAt ? 'Clocked out' : 'Still working'}</span><small>{item.exceptionReason || 'No scheduled shift'}</small></div><div className="att__rowActions"><button type="button" disabled={busy} onClick={() => void decide(item.id, 'approved')}>Approve exception</button><button type="button" disabled={busy} onClick={() => { setDeclining(item.id); setReviewNote(''); }}>Decline exception</button></div>{declining === item.id && <div className="att__reviewNote"><label htmlFor={`att-note-${item.id}`}>Reason for declining the schedule exception</label><textarea id={`att-note-${item.id}`} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} maxLength={1000} placeholder="Explain the decision. The clock record will remain intact." /><div><button type="button" disabled={busy || !reviewNote.trim()} onClick={() => void decide(item.id, 'declined')}>Save decision</button><button type="button" onClick={() => setDeclining(null)}>Cancel</button></div></div>}</article>)}</div> : <div className="att__empty">No schedule exceptions need review.</div>}
    </section></>}
    <section className="att__section"><div className="att__sectionHead"><div><span className="att__eyebrow">NEXT TWO WEEKS</span><h2>Scheduled shifts</h2></div></div>
      {team?.shifts.length ? <div className="att__list">{team.shifts.map((shift) => <article className="att__row" key={shift.id}><div><strong>{shift.employeeName}</strong><span>{format(shift.startsAt, shift.timezone)} – {new Intl.DateTimeFormat(undefined, { timeStyle: 'short', timeZone: shift.timezone }).format(new Date(shift.endsAt))}</span><small>{shift.workplace || 'No workplace set'}{shift.roleName ? ` · ${shift.roleName}` : ''}</small></div></article>)}</div> : <div className="att__empty">No shifts scheduled yet. Add one to show a helpful clock-in prompt on the employee’s phone.</div>}
    </section>
    {sheet && <div className="att__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSheet(false); }}><section className="att__sheet" role="dialog" aria-modal="true" aria-labelledby="att-sheet-title"><div className="att__sheetHead"><div><span className="att__eyebrow">PLANNED WORK</span><h2 id="att-sheet-title">Schedule a shift</h2></div><button type="button" aria-label="Close" onClick={() => setSheet(false)}>×</button></div><p>This is the plan. Clock events record what actually happens. Enter times in your device’s time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p><label>Team member<select value={person} onChange={(event) => setPerson(event.target.value)}><option value="">Choose a person</option>{team?.people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label><label>Starts<input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>Ends<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label><label>Workplace<input value={workplace} onChange={(event) => setWorkplace(event.target.value)} placeholder="Branch or workplace" /></label><label>Role for this shift<input value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="Optional" /></label><button type="button" className="att__primary" disabled={busy || !person || !start || !end} onClick={() => void save()}>Save shift</button></section></div>}
  </main>;
}
