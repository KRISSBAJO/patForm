'use client';

import { useCallback, useEffect, useState } from 'react';

type Session = { id: string; startedAt: string; endedAt: string | null; unpaidBreakSeconds: number; reviewStatus: string; correctedStart: string | null; correctedEnd: string | null; correctedBreak: number | null; pendingCorrection: boolean };
type Page = { page: number; total: number; rows: Session[] };
type Correction = { id: string; sessionId: string; employeeName: string; status: string; startsAt: string; endsAt: string; unpaidBreakSeconds: number; reason: string; decisionNote: string | null };
type Period = { id: string; name: string; startsAt: string; endsAt: string; status: string };
type PeriodRow = { actorId: string; name: string; recordedSeconds: number; proposedSeconds: number; sessions: number; issues: string[]; approval: { status: string; approved_seconds: number } | null; canApprove: boolean };
type PeriodDetail = { period: Period; people: PeriodRow[]; adjustments: { id: string; actorId: string; employeeName: string; deltaSeconds: number; createdAt: string }[] };

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.reason ?? data.error ?? 'Could not complete this action.');
  return data as T;
}
const when = (date: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
const duration = (seconds: number) => { const n = Math.abs(seconds); return `${Math.floor(n / 3600)}h ${Math.round((n % 3600) / 60)}m`; };
function localInput(value: string) { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }

export function AttendanceRecords({ mode }: { mode: 'records' | 'periods' }) {
  const [page, setPage] = useState<Page | null>(null);
  const [pageNumber, setPageNumber] = useState(0);
  const [mine, setMine] = useState<Correction[]>([]);
  const [team, setTeam] = useState<Correction[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PeriodDetail | null>(null);
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState<Session | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [breakMinutes, setBreakMinutes] = useState('0');
  const [reason, setReason] = useState('');
  const [decisionNote, setDecisionNote] = useState('');
  const [declining, setDeclining] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [periodName, setPeriodName] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [approvalNoteFor, setApprovalNoteFor] = useState<string | null>(null);
  const [approvalNote, setApprovalNote] = useState('');

  const refresh = useCallback(async () => {
    try {
      if (mode === 'records') {
        const [nextPage, nextMine, nextTeam] = await Promise.all([
          request<Page>(`/api/attendance/sessions?page=${pageNumber}`),
          request<Correction[]>('/api/attendance/corrections?scope=mine'),
          request<Correction[]>('/api/attendance/corrections?scope=team'),
        ]);
        setPage(nextPage); setMine(nextMine); setTeam(nextTeam);
      } else {
        const [items, session] = await Promise.all([request<Period[]>('/api/attendance/periods'), request<{ actor: { workspace_role: string } }>('/api/session')]);
        setPeriods(items); setAdmin(['owner', 'admin'].includes(session.actor.workspace_role));
        const id = selected ?? items[0]?.id;
        if (id) { setSelected(id); setDetail(await request<PeriodDetail>(`/api/attendance/periods/${id}`)); }
        else setDetail(null);
      }
      setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load time records.'); }
  }, [mode, pageNumber, selected]);
  useEffect(() => { void refresh(); }, [refresh]);
  const action = async (task: () => Promise<unknown>) => {
    setBusy(true);
    try { await task(); await refresh(); setError(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save.'); }
    finally { setBusy(false); }
  };
  const openCorrection = (s: Session) => { setCorrecting(s); setStart(localInput(s.correctedStart ?? s.startedAt)); setEnd(localInput(s.correctedEnd ?? s.endedAt!)); setBreakMinutes(String(Math.round((s.correctedBreak ?? s.unpaidBreakSeconds) / 60))); setReason(''); };
  const submitCorrection = async () => {
    if (!correcting) return;
    await action(async () => { await request('/api/attendance/corrections', { sessionId: correcting.id, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), unpaidBreakSeconds: Math.round(Number(breakMinutes) * 60), reason }); setCorrecting(null); });
  };
  const decide = async (id: string, decision: 'approved' | 'declined') => {
    await action(async () => { await request(`/api/attendance/corrections/${id}/decide`, { decision, note: decisionNote }); setDeclining(null); setDecisionNote(''); });
  };
  const create = async () => {
    const last = new Date(`${periodEnd}T00:00:00`); last.setDate(last.getDate() + 1);
    await action(async () => { const made = await request<Period>('/api/attendance/periods', { name: periodName, startsAt: new Date(`${periodStart}T00:00:00`).toISOString(), endsAt: last.toISOString() }); setCreating(false); setSelected(made.id); });
  };
  const approve = async (actorId: string) => {
    if (!detail) return;
    await action(async () => { await request(`/api/attendance/periods/${detail.period.id}/timesheets/${actorId}/approve`, { note: approvalNote }); setApprovalNoteFor(null); setApprovalNote(''); });
  };
  const finalize = async () => { if (detail) await action(() => request(`/api/attendance/periods/${detail.period.id}/finalize`, {})); };

  return <div className="att__records">
    {error && <p className="att__error" role="alert">{error} <button type="button" onClick={() => void refresh()}>Retry</button></p>}
    {mode === 'records' ? <>
      <section className="att__section"><div className="att__sectionHead"><div><span className="att__eyebrow">YOUR HISTORY</span><h2>Recorded workdays</h2></div><span>{page?.total ?? 0} records</span></div>
        <p className="att__introLine">Actual clock events stay intact. If a time is wrong, request a correction for your manager to review.</p>
        {page?.rows.length ? <div className="att__list">{page.rows.map((s) => <article className="att__row" key={s.id}><div><strong>{when(s.startedAt)}</strong><span>{s.endedAt ? `${when(s.endedAt)} · ${duration(Math.max(0, (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000 - s.unpaidBreakSeconds))} recorded` : 'Still clocked in'}</span>{s.correctedStart && <small>Approved correction: {when(s.correctedStart)}–{when(s.correctedEnd!)}</small>}{s.pendingCorrection && <small>Correction awaiting review</small>}{s.reviewStatus === 'pending' && <small>Schedule review pending</small>}</div>{s.endedAt && !s.pendingCorrection && <button type="button" className="att__plainAction" onClick={() => openCorrection(s)}>Request correction</button>}</article>)}</div> : <div className="att__empty">Your completed workdays will appear here after you clock out.</div>}
        {(page?.total ?? 0) > 25 && <div className="att__pages"><button type="button" disabled={!pageNumber} onClick={() => setPageNumber(pageNumber - 1)}>Previous</button><span>Page {pageNumber + 1}</span><button type="button" disabled={(pageNumber + 1) * 25 >= (page?.total ?? 0)} onClick={() => setPageNumber(pageNumber + 1)}>Next</button></div>}
      </section>
      {mine.length > 0 && <section className="att__section"><div className="att__sectionHead"><div><span className="att__eyebrow">CHANGE REQUESTS</span><h2>My corrections</h2></div></div><div className="att__list">{mine.map((c) => <div className="att__row" key={c.id}><div><strong>{when(c.startsAt)}–{when(c.endsAt)}</strong><span>{c.reason}</span><small>{c.status === 'pending' ? 'Waiting for review' : c.status === 'approved' ? 'Approved · original clock record kept' : `Declined${c.decisionNote ? ` · ${c.decisionNote}` : ''}`}</small></div></div>)}</div></section>}
      {team.length > 0 && <section className="att__section"><div className="att__sectionHead"><div><span className="att__eyebrow">MANAGER INBOX</span><h2>Corrections to review</h2></div><span>{team.length} waiting</span></div><div className="att__list">{team.map((c) => <article className="att__row" key={c.id}><div><strong>{c.employeeName}</strong><span>{when(c.startsAt)}–{when(c.endsAt)} · {Math.round(c.unpaidBreakSeconds / 60)}m unpaid break</span><small>{c.reason}</small></div><div className="att__rowActions"><button type="button" disabled={busy} onClick={() => void decide(c.id, 'approved')}>Approve</button><button type="button" disabled={busy} onClick={() => { setDeclining(c.id); setDecisionNote(''); }}>Decline</button></div>{declining === c.id && <div className="att__reviewNote"><label htmlFor={`att-correction-${c.id}`}>Why are you declining?</label><textarea id={`att-correction-${c.id}`} value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} /><div><button type="button" disabled={busy || !decisionNote.trim()} onClick={() => void decide(c.id, 'declined')}>Save decision</button><button type="button" onClick={() => setDeclining(null)}>Cancel</button></div></div>}</article>)}</div></section>}
    </> : <>
      <section className="att__section"><div className="att__sectionHead"><div><span className="att__eyebrow">PERIOD REVIEW</span><h2>Timesheets</h2></div>{admin && <button type="button" className="att__plainAction" onClick={() => setCreating(true)}>New period</button>}</div><p className="att__introLine">Review actual hours, resolve exceptions, then approve each person’s payable hours. Finalizing preserves the approved snapshot.</p>
        {periods.length ? <div className="att__periodPicker" role="group" aria-label="Pay periods">{periods.map((p) => <button type="button" key={p.id} aria-pressed={selected === p.id} onClick={() => setSelected(p.id)}><strong>{p.name}</strong><small>{p.status === 'finalized' ? 'Finalized' : 'Open'}</small></button>)}</div> : <div className="att__empty">No periods yet. A workspace administrator can add the first one.</div>}
      </section>
      {detail && <section className="att__section"><div className="att__sectionHead"><div><span className="att__eyebrow">{detail.period.status.toUpperCase()}</span><h2>{detail.period.name}</h2></div><div className="att__headActions">{admin && detail.period.status === 'open' && <button type="button" className="att__plainAction" disabled={busy} onClick={() => void finalize()}>Finalize period</button>}{admin && detail.period.status === 'finalized' && <a className="att__plainAction" href={`/api/attendance/periods/${detail.period.id}/export`}>Export approved hours ↓</a>}</div></div><p className="att__introLine">{when(detail.period.startsAt)} to {when(detail.period.endsAt)}. Finalized hours remain unchanged if a later correction is approved.</p>
        {detail.people.length ? <div className="att__list">{detail.people.map((person) => <article className="att__row" key={person.actorId}><div><strong>{person.name}</strong><span>{duration(person.recordedSeconds)} recorded · {duration(person.proposedSeconds)} for review</span><small>{person.approval?.status === 'approved' ? `${duration(person.approval.approved_seconds)} approved` : person.approval?.status === 'needs_review' ? 'Reapproval needed after a change' : person.issues.length ? person.issues.join(' · ') : 'Ready for manager approval'}</small></div>{person.canApprove && detail.period.status === 'open' && !person.issues.length && <button type="button" className="att__plainAction" onClick={() => { setApprovalNoteFor(person.actorId); setApprovalNote(''); }}>Approve timesheet</button>}{approvalNoteFor === person.actorId && <div className="att__reviewNote"><label htmlFor={`att-approval-${person.actorId}`}>Approval note, if needed</label><textarea id={`att-approval-${person.actorId}`} value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} placeholder="Explain any unusual or previously declined schedule exception." /><div><button type="button" disabled={busy} onClick={() => void approve(person.actorId)}>Confirm approval</button><button type="button" onClick={() => setApprovalNoteFor(null)}>Cancel</button></div></div>}</article>)}</div> : <div className="att__empty">No workdays were recorded in this period.</div>}
        {detail.adjustments.length > 0 && <div className="att__adjustments"><span className="att__eyebrow">AFTER FINALIZATION</span><h3>Corrections for payroll review</h3><p>These changes are separate rows in the export. Match each adjustment ID before importing so it is not paid twice.</p>{detail.adjustments.map((j) => <div className="att__row" key={j.id}><div><strong>{j.employeeName}</strong><small>{j.id} · {when(j.createdAt)}</small></div><span>{j.deltaSeconds >= 0 ? '+' : ''}{duration(j.deltaSeconds)} adjustment</span></div>)}</div>}
      </section>}
    </>}
    {correcting && <div className="att__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setCorrecting(null); }}><section className="att__sheet" role="dialog" aria-modal="true" aria-labelledby="att-correction-title"><div className="att__sheetHead"><div><span className="att__eyebrow">YOUR CLOCK RECORD</span><h2 id="att-correction-title">Request a correction</h2></div><button type="button" aria-label="Close" onClick={() => setCorrecting(null)}>×</button></div><p>Original: {when(correcting.startedAt)}–{when(correcting.endedAt!)}. It remains in the history beside any approved change.</p><label>Correct start<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label><label>Correct end<input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label><label>Unpaid break, minutes<input type="number" min="0" value={breakMinutes} onChange={(e) => setBreakMinutes(e.target.value)} /></label><label>What happened?<textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="Explain the missing or incorrect time." /></label><button type="button" className="att__primary" disabled={busy || !start || !end || !reason.trim()} onClick={() => void submitCorrection()}>Send for review</button></section></div>}
    {creating && <div className="att__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setCreating(false); }}><section className="att__sheet" role="dialog" aria-modal="true" aria-labelledby="att-period-title"><div className="att__sheetHead"><div><span className="att__eyebrow">REVIEW WINDOW</span><h2 id="att-period-title">New pay period</h2></div><button type="button" aria-label="Close" onClick={() => setCreating(false)}>×</button></div><p>Choose the first and last calendar day in your device’s time zone. This creates a review period; it does not pay anyone.</p><label>Period name<input value={periodName} onChange={(e) => setPeriodName(e.target.value)} placeholder="October, weeks 1–2" /></label><label>First day<input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></label><label>Last day<input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></label><button type="button" className="att__primary" disabled={busy || !periodName.trim() || !periodStart || !periodEnd} onClick={() => void create()}>Create period</button></section></div>}
  </div>;
}
