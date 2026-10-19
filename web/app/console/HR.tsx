'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { postJson } from './stepup';

/*
 * HR (PRD Module 7). Everyone: my tasks, my leave, my documents. Managers:
 * leave to approve. Teams (IT, Facilities, Finance): the cases with tasks for
 * them, showing only the basic facts. HR: cases, people, pay, leave setup,
 * documents, reconciliation, upcoming dates, hiring, teams and templates.
 * Pay never appears outside the People tab, which only HR can open.
 */

type Tab = 'tasks' | 'leave' | 'documents' | 'approve' | 'cases' | 'people' | 'hiring' | 'upcoming' | 'reconcile' | 'setup';
type Summary = { hr: boolean; admin?: boolean; role: string; teams: string[]; myTasks: number; leaveToApprove: number; onboarding?: number; offboarding?: number; changes?: number; reconciliation?: number; hiring?: number };
type Task = { id: string; key: string; title: string; team: string; critical: boolean; status: string; note: string | null; mine: boolean; blockedBy: string[]; completed_by_name: string | null; action: string | null };
type Case = { id: string; kind: string; status: string; restricted?: boolean; effectiveDate: string | null; summary: string | null; employee: { id: string; name: string; email: string; location: string | null; startDate: string | null; endDate: string | null; unit: string | null; title: string | null; employmentType: string }; progress: { done: number; total: number }; readiness: { title: string; team: string; critical: boolean; blockedBy: string[] }[]; tasks: Task[] };
type MyTask = Task & { caseId: string; kind: string; employee: string; effectiveDate: string | null };
type Balance = { key: string; name: string; unlimited: boolean; entitled: number; taken: number; pending: number; left: number | null };
type MyLeave = { year: number; balances: Balance[]; requests: { id: string; type: string; start_date: string; end_date: string; days: string; status: string; decision_note: string | null; approver: string | null }[]; balanceOwner: string };
type ToApprove = { id: string; employee_name: string; type: string; start_date: string; end_date: string; days: number; reason: string | null; sameUnitAway: { name: string; start_date: string; end_date: string }[] };
type MyDoc = { id: string; title: string; version: string; kind: string; document_ref: string | null; due_date: string | null; status: string; statement: string | null };
type Employee = { id: string; name: string; email: string; employment_type: string; status: string; location: string | null; start_date: string | null; end_date: string | null; probation_end: string | null; payroll_ref: string | null; workspace_role: string | null; position_title: string | null; unit_name: string | null; manager_name: string | null };
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
  const reload = useCallback(async () => {
    if (!path) return;
    try { setData(await get<T>(path)); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}
const day = (v: string | null | undefined) => (v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toLocaleDateString() : '');
const list = { listStyle: 'none', margin: 0, padding: 0 } as const;
const KIND: Record<string, string> = { onboarding: 'Onboarding', offboarding: 'Offboarding', transfer: 'Transfer', probation: 'Probation review', urgent_termination: 'Urgent termination' };
const TEAM: Record<string, string> = { hr: 'HR', it: 'IT', facilities: 'Facilities', finance: 'Finance', manager: 'Manager', employee: 'Employee' };

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div><label className="cs__label" htmlFor={id}>{label}</label>{children}</div>;
}

export function HRView({ onChanged }: { onChanged?: () => void }) {
  const summary = useFeed<Summary>('/api/hr/summary');
  const s = summary.data;
  const hr = s?.hr === true;
  const [tab, setTab] = useState<Tab>('tasks');
  const tasks = useFeed<MyTask[]>('/api/hr/tasks/mine');
  const leave = useFeed<MyLeave>(s && s.role !== 'pre_hire' ? '/api/hr/leave/mine' : null);
  const docs = useFeed<MyDoc[]>(s ? '/api/hr/documents/mine' : null);
  const approve = useFeed<ToApprove[]>(s && s.role !== 'pre_hire' ? '/api/hr/leave/to-approve' : null);
  const cases = useFeed<Case[]>(s && (hr || s.teams.length || s.role !== 'pre_hire') ? '/api/hr/cases' : null);
  const people = useFeed<Employee[]>(hr ? '/api/hr/employees' : null);
  const hiring = useFeed<{ id: string; reference: string; position: string; headcount: number; filled: number; cost_centre: string | null; status: string }[]>(hr ? '/api/hr/hiring' : null);
  const soon = useFeed<{ kind: string; name: string; on: string; detail: string | null }[]>(hr ? '/api/hr/upcoming' : null);
  const recon = useFeed<{ id: string; field: string; owner: string; current_value: string | null; proposed_value: string | null; status: string; employee_name: string; raised_by: string | null; created_at: string }[]>(hr ? '/api/hr/reconciliation' : null);
  const members = useFeed<Member[]>(hr ? '/api/members' : null);
  const teams = useFeed<{ team: string; actor_id: string; display_name: string }[]>(hr ? '/api/hr/teams' : null);
  const docList = useFeed<{ id: string; title: string; version: string; kind: string; sent: number; acknowledged: number; overdue: number }[]>(hr ? '/api/hr/documents' : null);
  const types = useFeed<{ key: string; name: string; annual_days: string; unlimited: boolean }[]>(s && s.role !== 'pre_hire' ? '/api/hr/leave/types' : null);
  const holidays = useFeed<{ day: string; name: string }[]>(s && s.role !== 'pre_hire' ? '/api/hr/leave/holidays' : null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState<null | 'onboarding' | 'offboarding' | 'transfer' | 'urgent' | 'probation'>(null);
  const [asking, setAsking] = useState<{ id: string; label: string; run: (answer: string) => Promise<string> } | null>(null);
  const [answer, setAnswer] = useState('');
  const [pay, setPay] = useState<Record<string, { amount: string; currency: string; period: string; effective_from: string }[]>>({});
  const f = (k: string) => form[k] ?? '';
  const setF = (k: string, v: string) => setForm((x) => ({ ...x, [k]: v }));

  const reloadAll = async () => { await Promise.all([summary.reload(), tasks.reload(), leave.reload(), docs.reload(), approve.reload(), cases.reload(), people.reload(), hiring.reload(), soon.reload(), recon.reload(), teams.reload(), docList.reload(), holidays.reload()]); onChanged?.(); };
  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    // Refresh first, so the message never sits above a list that has not caught up.
    try { const message = await work(); await reloadAll(); setNote(message); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } finally { setBusy(null); }
  };

  if (summary.error) return <div className="ig__workspace"><p className="ig__error" role="alert">{summary.error}</p></div>;
  if (!s) return <div className="ig__workspace"><p className="ig__rowMain">Loading…</p></div>;

  const pre = s.role === 'pre_hire';
  const tabs: { id: Tab; name: string; count: number | null; icon: 'table' | 'export' | 'trail' | 'account' | 'done' }[] = [
    { id: 'tasks', name: pre ? 'Before you start' : 'My tasks', count: s.myTasks, icon: 'done' },
    ...(!pre ? [{ id: 'leave' as const, name: 'My leave', count: null, icon: 'trail' as const }] : []),
    { id: 'documents', name: 'My documents', count: (docs.data ?? []).filter((d) => d.status === 'sent').length, icon: 'export' },
    ...(!pre && (s.leaveToApprove > 0 || hr) ? [{ id: 'approve' as const, name: 'Leave to approve', count: s.leaveToApprove, icon: 'trail' as const }] : []),
    ...(hr || s.teams.length ? [{ id: 'cases' as const, name: hr ? 'Cases' : 'Team tasks', count: hr ? (s.onboarding ?? 0) + (s.offboarding ?? 0) + (s.changes ?? 0) : null, icon: 'table' as const }] : []),
    ...(hr ? [
      { id: 'people' as const, name: 'People', count: people.data?.length ?? 0, icon: 'account' as const },
      { id: 'hiring' as const, name: 'Hiring', count: s.hiring ?? 0, icon: 'export' as const },
      { id: 'upcoming' as const, name: 'Coming up', count: soon.data?.length ?? 0, icon: 'trail' as const },
      { id: 'reconcile' as const, name: 'To reconcile', count: s.reconciliation ?? 0, icon: 'done' as const },
      { id: 'setup' as const, name: 'Setup', count: null, icon: 'trail' as const },
    ] : []),
  ];
  const memberOptions = (members.data ?? []).filter((m) => m.active);

  const caseRow = (c: Case) => <li key={c.id} className="ig__row" style={{ flexWrap: 'wrap' }}>
    <div className="ig__rowMain">
      <strong>{c.employee.name}</strong><span className={`ig__status ${c.status === 'open' ? 'ig__status--off' : ''}`}>{KIND[c.kind] ?? c.kind}{c.status !== 'open' ? ` · ${c.status}` : ''}</span>{c.restricted && <span className="ig__status ig__status--off">Restricted</span>}
      <p>{[c.employee.title, c.employee.unit, c.employee.location, c.effectiveDate && `${c.kind === 'onboarding' ? 'starts' : c.kind === 'transfer' ? 'from' : 'on'} ${day(c.effectiveDate)}`].filter(Boolean).join(' · ')} · {c.progress.done} of {c.progress.total} done</p>
      {c.summary && <p>{c.summary}</p>}
      {c.readiness.length > 0 && <p className="ig__rowError">Outstanding: {c.readiness.map((r) => `${r.title} (${TEAM[r.team]})${r.blockedBy.length ? ` — ${r.blockedBy.join(', ')}` : ''}`).join('; ')}</p>}
      <table className="ex__table"><thead><tr><th scope="col">Task</th><th scope="col">Team</th><th scope="col">State</th><th scope="col"><span className="ex__sr">Action</span></th></tr></thead>
        <tbody>{c.tasks.map((t) => <tr key={t.id}>
          <td>{t.critical ? '● ' : ''}{t.title}{t.note ? <><br /><small>{t.note}</small></> : null}</td>
          <td>{TEAM[t.team]}</td>
          <td>{t.status === 'open' ? (t.blockedBy.length ? `Waiting: ${t.blockedBy.join(', ')}` : 'Ready') : t.status === 'done' ? `Done${t.completed_by_name ? ` by ${t.completed_by_name}` : ''}` : 'Waived'}</td>
          <td>{t.status === 'open' && t.mine && !t.blockedBy.length && <button type="button" className="cs__btn cs__btn--primary" disabled={busy === t.id} onClick={() => setAsking({ id: t.id, label: `Note for "${t.title}" (optional — type "-" for none)`, run: async (n) => { await postJson(`/api/hr/tasks/${t.id}/complete`, { note: n === '-' ? '' : n }); return `"${t.title}" done.`; } })}>Mark done</button>}
            {t.status === 'open' && hr && s.admin && !t.critical && <button type="button" className="cs__btn" onClick={() => setAsking({ id: t.id, label: `Why waive "${t.title}"?`, run: async (r) => { await postJson(`/api/hr/tasks/${t.id}/except`, { reason: r }); return 'Waived, with your reason recorded.'; } })}>Waive</button>}</td>
        </tr>)}</tbody></table>
      {hr && <div className="pp2__roleEdit" style={{ marginTop: 8 }}>
        <button type="button" className="cs__btn" onClick={() => setAsking({ id: c.id, label: 'Note (kept to HR)', run: async (b) => { await postJson(`/api/hr/cases/${c.id}/notes`, { body: b, category: 'general' }); return 'Note added.'; } })}>Add HR note</button>
        <button type="button" className="cs__btn" onClick={() => setAsking({ id: c.id, label: 'Note shared with the teams on this case', run: async (b) => { await postJson(`/api/hr/cases/${c.id}/notes`, { body: b, category: 'general', shared: true }); return 'Shared note added.'; } })}>Add shared note</button>
        {c.kind === 'probation' && c.status === 'open' && <>
          <button type="button" className="cs__btn" onClick={() => setAsking({ id: c.id, label: 'Why confirm?', run: async (r) => { await postJson(`/api/hr/cases/${c.id}/probation-decision`, { outcome: 'confirm', reason: r }); return 'Probation confirmed.'; } })}>Confirm</button>
          <button type="button" className="cs__btn" onClick={() => setAsking({ id: c.id, label: 'New probation end (YYYY-MM-DD), then a space and the reason', run: async (r) => { const [newEnd, ...why] = r.split(' '); await postJson(`/api/hr/cases/${c.id}/probation-decision`, { outcome: 'extend', newEnd, reason: why.join(' ') }); return 'Probation extended.'; } })}>Extend</button>
        </>}
      </div>}
    </div>
  </li>;

  return <div className="ig__workspace">
    <header className="ig__hero">
      <span className="ig__eyebrow">PEOPLE &amp; HR</span>
      <h2>{pre ? 'Welcome — a few things before your first day' : hr ? 'Joiners, movers, leavers and leave' : 'Your HR'}</h2>
      <p>{pre ? 'These are the tasks for you. The rest of the workspace opens on your first day, once your checks are done.' : hr ? 'Each team sees only its tasks and the basic facts about a person. Pay, health, disciplinary notes and restricted cases stay with HR.' : 'Your tasks, leave and documents. Ask HR about anything else.'}</p>
    </header>

    {hr && <section className="pp2__overview" aria-label="HR at a glance" style={{ marginBottom: 18 }}>
      <div><span>Joining</span><strong>{s.onboarding}</strong><small>{s.hiring} open hiring requests</small></div>
      <div><span>Leaving</span><strong>{s.offboarding}</strong><small>{s.changes} transfers and probation reviews</small></div>
      <div><span>To reconcile</span><strong>{s.reconciliation}</strong><small>changes another system owns</small></div>
    </section>}

    <div className="ig__surface">
      <div className="ig__tabs" role="tablist" aria-label="HR areas">
        {tabs.map((item, index) => <button key={item.id} id={`hr-tab-${item.id}`} type="button" role="tab" aria-controls={`hr-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className="ig__tab" onClick={() => { setTab(item.id); setNote(null); setStarting(null); setForm({}); }} onKeyDown={(event) => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : -1; if (next < 0) return; event.preventDefault(); const id = tabs[next]!.id; setTab(id); document.getElementById(`hr-tab-${id}`)?.focus(); }}>
          <Icon name={item.icon} /><span>{item.name}</span>{item.count !== null && <span className="ig__tabCount">{item.count}</span>}
        </button>)}
      </div>
      <section id={`hr-panel-${tab}`} role="tabpanel" aria-labelledby={`hr-tab-${tab}`} className="ig__panel">
        {note && <p className="ig__notice" role="status">{note}</p>}
        {asking && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); const a = answer.trim(); if (!a) return; const job = asking; setAsking(null); setAnswer(''); void act(job.id, () => job.run(a)); }}>
          <Field id="hr-ask" label={asking.label}><input id="hr-ask" className="cs__input" required autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} /></Field>
          <div className="pp2__roleEdit" style={{ alignSelf: 'end' }}><button type="submit" className="cs__btn cs__btn--primary">Save</button><button type="button" className="cs__btn" onClick={() => { setAsking(null); setAnswer(''); }}>Cancel</button></div>
        </form>}

        {tab === 'tasks' && <ul style={list}>
          {(tasks.data ?? []).map((t) => <li key={t.id} className="ig__row"><div className="ig__rowMain">
            <strong>{t.title}</strong><span className="ig__status ig__status--off">{KIND[t.kind] ?? t.kind} · {t.employee}</span>
            <p>{t.blockedBy.length ? `Waiting: ${t.blockedBy.join(', ')}` : 'Ready for you'}{t.effectiveDate ? ` · ${day(t.effectiveDate)}` : ''}</p></div>
            {!t.blockedBy.length && <button type="button" className="cs__btn cs__btn--primary" onClick={() => setAsking({ id: t.id, label: `Note for "${t.title}" (type "-" for none)`, run: async (n) => { await postJson(`/api/hr/tasks/${t.id}/complete`, { note: n === '-' ? '' : n }); return `"${t.title}" done.`; } })}>Mark done</button>}
          </li>)}
          {tasks.data && !tasks.data.length && <li className="ig__row"><div className="ig__rowMain"><p>Nothing for you to do right now.</p></div></li>}
        </ul>}

        {tab === 'leave' && leave.data && <>
          <ul style={list}>{leave.data.balances.map((b) => <li key={b.key} className="ig__row"><div className="ig__rowMain"><strong>{b.name}</strong><span className="ig__status">{b.unlimited ? 'No limit' : `${b.left} left`}</span><p>{b.unlimited ? `${b.taken} taken this year` : `${b.entitled} a year · ${b.taken} taken · ${b.pending} waiting for approval`}{leave.data!.balanceOwner !== 'patform' ? ` · balances are kept in ${leave.data!.balanceOwner}` : ''}</p></div></li>)}</ul>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('leave', async () => { const r = await postJson<{ days: number; approver: string }>('/api/hr/leave', { type: f('lType'), startDate: f('lFrom'), endDate: f('lTo'), reason: f('lWhy') }); setForm({}); return `Asked for ${r.days} working day(s); it is with ${r.approver}.`; }); }}>
            <div className="ig__formTitle"><strong>Ask for leave</strong><p>Weekends and public holidays are not counted.</p></div>
            <Field id="l-type" label="Type"><select id="l-type" className="cs__input" required value={f('lType')} onChange={(e) => setF('lType', e.target.value)}><option value="">Choose…</option>{(types.data ?? []).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></Field>
            <Field id="l-from" label="From"><input id="l-from" type="date" className="cs__input" required value={f('lFrom')} onChange={(e) => setF('lFrom', e.target.value)} /></Field>
            <Field id="l-to" label="To"><input id="l-to" type="date" className="cs__input" required value={f('lTo')} onChange={(e) => setF('lTo', e.target.value)} /></Field>
            <Field id="l-why" label="Note (optional)"><input id="l-why" className="cs__input" value={f('lWhy')} onChange={(e) => setF('lWhy', e.target.value)} /></Field>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'leave'}>Ask</button>
          </form>
          <ul style={list}>{leave.data.requests.map((r) => <li key={r.id} className="ig__row"><div className="ig__rowMain"><strong>{r.type}: {day(r.start_date)} to {day(r.end_date)}</strong><span className={`ig__status ${r.status === 'approved' ? '' : 'ig__status--off'}`}>{r.status}</span><p>{Number(r.days)} day(s){r.approver ? ` · ${r.approver}` : ''}{r.decision_note ? ` · ${r.decision_note}` : ''}</p></div>
            {['requested', 'approved'].includes(r.status) && <button type="button" className="cs__btn" onClick={() => void act(r.id, async () => { await postJson(`/api/hr/leave/${r.id}/cancel`, {}); return 'Leave cancelled.'; })}>Cancel</button>}</li>)}</ul>
        </>}

        {tab === 'documents' && <ul style={list}>
          {(docs.data ?? []).map((d) => <li key={d.id} className="ig__row"><div className="ig__rowMain">
            <strong>{d.title}</strong><span className={`ig__status ${d.status === 'acknowledged' ? '' : 'ig__status--off'}`}>{d.status === 'acknowledged' ? 'Done' : d.kind === 'agreement' ? 'To agree' : 'To confirm received'}</span>
            <p>Version {d.version}{d.due_date ? ` · by ${day(d.due_date)}` : ''}{d.document_ref ? ` · ${d.document_ref}` : ''}{d.statement ? ` · "${d.statement}"` : ''}</p></div>
            {d.status === 'sent' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(d.id, async () => { const r = await postJson<{ statement: string }>(`/api/hr/documents/requests/${d.id}/acknowledge`, {}); return `Recorded: "${r.statement}"`; })}>{d.kind === 'agreement' ? 'I agree' : 'I have received it'}</button>}
          </li>)}
          {docs.data && !docs.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No documents for you.</p></div></li>}
        </ul>}

        {tab === 'approve' && <ul style={list}>
          {(approve.data ?? []).map((r) => <li key={r.id} className="ig__row"><div className="ig__rowMain">
            <strong>{r.employee_name}: {r.type}</strong><span className="ig__status ig__status--off">{r.days} day(s)</span>
            <p>{day(r.start_date)} to {day(r.end_date)}{r.reason ? ` · ${r.reason}` : ''}</p>
            {r.sameUnitAway.length > 0 && <p className="ig__rowError">Also away from the same team: {r.sameUnitAway.map((o) => `${o.name} (${day(o.start_date)}–${day(o.end_date)})`).join(', ')}</p>}</div>
            <div className="pp2__roleEdit"><button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(r.id, async () => { await postJson(`/api/hr/leave/${r.id}/decide`, { decision: 'approve' }); return 'Approved.'; })}>Approve</button>
              <button type="button" className="cs__btn" onClick={() => setAsking({ id: r.id, label: 'Why not?', run: async (n) => { await postJson(`/api/hr/leave/${r.id}/decide`, { decision: 'reject', note: n }); return 'Declined.'; } })}>Decline</button></div>
          </li>)}
          {approve.data && !approve.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No leave waiting for you.</p></div></li>}
        </ul>}

        {tab === 'cases' && <>
          {hr && <div className="pp2__roleEdit" style={{ padding: '16px 28px 0' }}>
            {([['onboarding', 'Start an onboarding'], ['offboarding', 'Start an offboarding'], ['transfer', 'Transfer or promotion'], ['probation', 'Probation review'], ...(s.admin ? [['urgent', 'Urgent termination']] : [])] as [typeof starting, string][]).map(([k, label]) => <button key={k} type="button" className={`cs__btn ${k === 'urgent' ? '' : ''}`} aria-expanded={starting === k} onClick={() => { setStarting(starting === k ? null : k); setForm({}); }}>{label}</button>)}
          </div>}
          {starting === 'onboarding' && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('start', async () => { const r = await postJson<{ invitation: string | null }>('/api/hr/cases/onboarding', { name: f('oName'), email: f('oEmail'), startDate: f('oStart'), employmentType: f('oType') || 'employee', location: f('oLoc'), managerId: f('oMgr') || undefined, title: f('oTitle'), probationEnd: f('oProb') || undefined, hiringId: f('oHire') || undefined, sendInvitation: f('oInvite') === 'yes' }); setStarting(null); setForm({}); return `Onboarding started.${r.invitation ? ` Invitation: ${r.invitation}.` : ''}`; }); }}>
            <div className="ig__formTitle"><strong>New joiner</strong><p>They get a pre-hire account: their own tasks only, until access is activated on the first day.</p></div>
            <Field id="o-name" label="Name"><input id="o-name" className="cs__input" required value={f('oName')} onChange={(e) => setF('oName', e.target.value)} /></Field>
            <Field id="o-email" label="Work email"><input id="o-email" type="email" className="cs__input" required value={f('oEmail')} onChange={(e) => setF('oEmail', e.target.value)} /></Field>
            <Field id="o-start" label="Start date"><input id="o-start" type="date" className="cs__input" required value={f('oStart')} onChange={(e) => setF('oStart', e.target.value)} /></Field>
            <Field id="o-type" label="Type"><select id="o-type" className="cs__input" value={f('oType')} onChange={(e) => setF('oType', e.target.value)}><option value="employee">Employee</option><option value="contractor">Contractor</option><option value="intern">Intern</option></select></Field>
            <Field id="o-title" label="Job title"><input id="o-title" className="cs__input" value={f('oTitle')} onChange={(e) => setF('oTitle', e.target.value)} /></Field>
            <Field id="o-loc" label="Location"><input id="o-loc" className="cs__input" value={f('oLoc')} onChange={(e) => setF('oLoc', e.target.value)} /></Field>
            <Field id="o-mgr" label="Manager"><select id="o-mgr" className="cs__input" value={f('oMgr')} onChange={(e) => setF('oMgr', e.target.value)}><option value="">Choose…</option>{memberOptions.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
            <Field id="o-prob" label="Probation ends (optional)"><input id="o-prob" type="date" className="cs__input" value={f('oProb')} onChange={(e) => setF('oProb', e.target.value)} /></Field>
            <Field id="o-hire" label="For hiring request (optional)"><select id="o-hire" className="cs__input" value={f('oHire')} onChange={(e) => setF('oHire', e.target.value)}><option value="">None</option>{(hiring.data ?? []).filter((h) => h.status === 'open').map((h) => <option key={h.id} value={h.id}>{h.reference} · {h.position} ({h.filled}/{h.headcount})</option>)}</select></Field>
            <div><label className="pp2__inlineLabel"><input type="checkbox" checked={f('oInvite') === 'yes'} onChange={(e) => setF('oInvite', e.target.checked ? 'yes' : '')} /> Email them an invitation now</label></div>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'start'}>Start onboarding</button>
          </form>}
          {(starting === 'offboarding' || starting === 'urgent' || starting === 'probation' || starting === 'transfer') && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('start', async () => {
            if (starting === 'offboarding') await postJson('/api/hr/cases/offboarding', { employeeId: f('xEmp'), endDate: f('xDate'), summary: f('xWhy') });
            if (starting === 'urgent') await postJson('/api/hr/cases/urgent-termination', { employeeId: f('xEmp'), reason: f('xWhy') });
            if (starting === 'probation') await postJson('/api/hr/cases/probation', { employeeId: f('xEmp') });
            if (starting === 'transfer') await postJson('/api/hr/cases/transfer', { employeeId: f('xEmp'), effectiveDate: f('xDate'), managerId: f('xMgr') || undefined, title: f('xTitle') || undefined, reason: f('xWhy') });
            const done = starting === 'urgent' ? 'Access revoked now. The case is restricted to HR.' : 'Started.'; setStarting(null); setForm({}); return done; }); }}>
            <div className="ig__formTitle"><strong>{{ offboarding: 'Leaver', urgent: 'Urgent termination', probation: 'Probation review', transfer: 'Transfer or promotion' }[starting]}</strong><p>{starting === 'urgent' ? 'Revokes all access immediately. Other teams see only their own task; the reason stays in a restricted HR note.' : starting === 'offboarding' ? 'Access is revoked on the end date, whatever else is outstanding.' : starting === 'transfer' ? 'Approvals go to the new manager from the effective date; past decisions keep the old one.' : 'Manager check-in and recommendation, then HR decides.'}</p></div>
            <Field id="x-emp" label="Person"><select id="x-emp" className="cs__input" required value={f('xEmp')} onChange={(e) => setF('xEmp', e.target.value)}><option value="">Choose…</option>{(people.data ?? []).filter((p) => p.status !== 'left').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            {(starting === 'offboarding' || starting === 'transfer') && <Field id="x-date" label={starting === 'transfer' ? 'Effective from' : 'Last day'}><input id="x-date" type="date" className="cs__input" required value={f('xDate')} onChange={(e) => setF('xDate', e.target.value)} /></Field>}
            {starting === 'transfer' && <>
              <Field id="x-mgr" label="New manager"><select id="x-mgr" className="cs__input" value={f('xMgr')} onChange={(e) => setF('xMgr', e.target.value)}><option value="">No change</option>{memberOptions.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
              <Field id="x-title" label="New title"><input id="x-title" className="cs__input" value={f('xTitle')} onChange={(e) => setF('xTitle', e.target.value)} /></Field>
            </>}
            {starting !== 'probation' && <Field id="x-why" label={starting === 'urgent' ? 'Reason (restricted)' : starting === 'transfer' ? 'What is changing' : 'Note'}><input id="x-why" className="cs__input" required={starting !== 'offboarding'} value={f('xWhy')} onChange={(e) => setF('xWhy', e.target.value)} /></Field>}
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'start'}>{starting === 'urgent' ? 'Authorise and revoke access' : 'Start'}</button>
          </form>}
          <ul style={list}>{(cases.data ?? []).map(caseRow)}</ul>
          {cases.data && !cases.data.length && <p className="ig__rowMain" style={{ padding: '0 28px 24px' }}>No cases.</p>}
        </>}

        {tab === 'people' && <ul style={list}>
          {(people.data ?? []).map((p) => <li key={p.id} className="ig__row" style={{ flexWrap: 'wrap' }}><div className="ig__rowMain">
            <strong>{p.name}</strong><span className={`ig__status ${p.status === 'active' ? '' : 'ig__status--off'}`}>{p.status.replace('_', ' ')}</span>
            <p>{[p.position_title, p.unit_name, p.location, p.employment_type, p.manager_name && `reports to ${p.manager_name}`, p.start_date && `started ${day(p.start_date)}`, p.probation_end && `probation to ${day(p.probation_end)}`, p.payroll_ref && `payroll ${p.payroll_ref}`].filter(Boolean).join(' · ')}</p>
            {pay[p.id] && <p>Pay: {pay[p.id]!.length ? pay[p.id]!.map((x) => `${x.currency} ${Number(x.amount).toLocaleString()} a ${x.period} from ${day(x.effective_from)}`).join('; ') : 'none recorded'}</p>}
          </div>
            <div className="pp2__roleEdit">
              {s.admin && <button type="button" className="cs__btn" onClick={() => void act(p.id, async () => { setPay({ ...pay, [p.id]: await get(`/api/hr/employees/${p.id}/pay`) }); return 'Pay shown. Only HR can see it.'; })}>Show pay</button>}
              {s.admin && <button type="button" className="cs__btn" onClick={() => setAsking({ id: p.id, label: 'New pay: amount currency period date, e.g. "4800000 NGN year 2026-11-01"', run: async (a) => { const [amount, currency, period, effectiveFrom] = a.split(/\s+/); const r = await postJson<{ queuedForReconciliation: boolean }>(`/api/hr/employees/${p.id}/pay`, { amount, currency, period, effectiveFrom }); return r.queuedForReconciliation ? 'Pay is owned by another system: a reconciliation task was raised instead.' : 'Pay recorded.'; } })}>Set pay</button>}
            </div>
          </li>)}
        </ul>}

        {tab === 'hiring' && <ul style={list}>
          {(hiring.data ?? []).map((h) => <li key={h.id} className="ig__row"><div className="ig__rowMain"><strong>{h.reference} · {h.position}</strong><span className={`ig__status ${h.status === 'open' ? 'ig__status--off' : ''}`}>{h.status}</span><p>{h.filled} of {h.headcount} hired{h.cost_centre ? ` · ${h.cost_centre}` : ''}. Start each hire from Cases → Start an onboarding.</p></div></li>)}
          {hiring.data && !hiring.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No approved hiring requests. Managers ask with the Hiring request form.</p></div></li>}
        </ul>}

        {tab === 'upcoming' && <ul style={list}>
          {(soon.data ?? []).map((x, i) => <li key={i} className="ig__row"><div className="ig__rowMain"><strong>{day(x.on)}: {x.name}</strong><span className="ig__status">{{ probation_end: 'Probation ends', start: 'Starts', leaving: 'Leaves', certification: 'Certification expires', anniversary: 'Work anniversary' }[x.kind] ?? x.kind}</span>{x.detail && <p>{x.detail}</p>}</div></li>)}
          {soon.data && !soon.data.length && <li className="ig__row"><div className="ig__rowMain"><p>Nothing in the next 60 days.</p></div></li>}
        </ul>}

        {tab === 'reconcile' && <ul style={list}>
          {(recon.data ?? []).map((r) => <li key={r.id} className="ig__row"><div className="ig__rowMain"><strong>{r.employee_name}: {r.field.replace('_', ' ')}</strong><span className={`ig__status ${r.status === 'open' ? 'ig__status--off' : ''}`}>{r.status}</span><p>{r.owner} owns this field. Proposed: {r.proposed_value ?? '—'}{r.current_value ? ` (now ${r.current_value})` : ''} · raised by {r.raised_by}</p></div>
            {r.status === 'open' && <div className="pp2__roleEdit"><button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(r.id, async () => { await postJson(`/api/hr/reconciliation/${r.id}`, { outcome: 'applied' }); return `Marked as updated in ${r.owner}.`; })}>Updated in {r.owner}</button><button type="button" className="cs__btn" onClick={() => void act(r.id, async () => { await postJson(`/api/hr/reconciliation/${r.id}`, { outcome: 'dismissed' }); return 'Dismissed.'; })}>Dismiss</button></div>}</li>)}
          {recon.data && !recon.data.length && <li className="ig__row"><div className="ig__rowMain"><p>Nothing to reconcile.</p></div></li>}
        </ul>}

        {tab === 'setup' && <>
          <div className="ig__panelHead"><div><h3>Teams</h3><p>Who sees the IT, Facilities, Finance and HR tasks. Owners and admins are always HR.</p></div></div>
          {s.admin && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('team', async () => { await postJson('/api/hr/teams', { team: f('tTeam'), actorId: f('tWho') }); setForm({}); return 'Added to the team.'; }); }}>
            <Field id="t-team" label="Team"><select id="t-team" className="cs__input" required value={f('tTeam')} onChange={(e) => setF('tTeam', e.target.value)}><option value="">Choose…</option><option value="hr">HR</option><option value="it">IT</option><option value="facilities">Facilities</option><option value="finance">Finance</option></select></Field>
            <Field id="t-who" label="Person"><select id="t-who" className="cs__input" required value={f('tWho')} onChange={(e) => setF('tWho', e.target.value)}><option value="">Choose…</option>{memberOptions.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
            <button type="submit" className="cs__btn cs__btn--primary">Add</button>
          </form>}
          <ul style={list}>{(teams.data ?? []).map((t) => <li key={`${t.team}-${t.actor_id}`} className="ig__row"><div className="ig__rowMain"><strong>{t.display_name}</strong><span className="ig__status">{TEAM[t.team]}</span></div>{s.admin && <button type="button" className="cs__btn" onClick={() => void act(t.actor_id, async () => { await postJson('/api/hr/teams', { team: t.team, actorId: t.actor_id, member: false }); return 'Removed from the team.'; })}>Remove</button>}</li>)}</ul>
          <div className="ig__panelHead"><div><h3>Documents to send</h3><p>Choose whether people confirm they received it, or agree to it. The words recorded say which.</p></div></div>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('doc', async () => { const d = await postJson<{ id: string }>('/api/hr/documents', { title: f('dTitle'), version: f('dVer'), kind: f('dKind') || 'receipt', documentRef: f('dRef') }); const sent = await postJson<{ sent: number }>(`/api/hr/documents/${d.id}/send`, { employeeIds: 'all', dueDate: f('dDue') || undefined }); setForm({}); return `Sent to ${sent.sent} people.`; }); }}>
            <Field id="d-title" label="Title"><input id="d-title" className="cs__input" required value={f('dTitle')} onChange={(e) => setF('dTitle', e.target.value)} /></Field>
            <Field id="d-ver" label="Version"><input id="d-ver" className="cs__input" required value={f('dVer')} onChange={(e) => setF('dVer', e.target.value)} /></Field>
            <Field id="d-kind" label="People should"><select id="d-kind" className="cs__input" value={f('dKind')} onChange={(e) => setF('dKind', e.target.value)}><option value="receipt">Confirm they received it</option><option value="agreement">Agree to it</option></select></Field>
            <Field id="d-ref" label="Where it is"><input id="d-ref" className="cs__input" value={f('dRef')} onChange={(e) => setF('dRef', e.target.value)} /></Field>
            <Field id="d-due" label="By"><input id="d-due" type="date" className="cs__input" value={f('dDue')} onChange={(e) => setF('dDue', e.target.value)} /></Field>
            <button type="submit" className="cs__btn cs__btn--primary">Send to everyone</button>
          </form>
          <ul style={list}>{(docList.data ?? []).map((d) => <li key={d.id} className="ig__row"><div className="ig__rowMain"><strong>{d.title} · {d.version}</strong><span className="ig__status">{d.kind === 'agreement' ? 'Agreement' : 'Receipt'}</span><p>{d.acknowledged} of {d.sent} done{d.overdue ? ` · ${d.overdue} overdue` : ''}</p></div></li>)}</ul>
          <div className="ig__panelHead"><div><h3>Public holidays</h3><p>Not counted as leave days.</p></div></div>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('hol', async () => { await postJson('/api/hr/leave/holidays', { day: f('hDay'), name: f('hName') }); setForm({}); return 'Holiday added.'; }); }}>
            <Field id="h-day" label="Date"><input id="h-day" type="date" className="cs__input" required value={f('hDay')} onChange={(e) => setF('hDay', e.target.value)} /></Field>
            <Field id="h-name" label="Name"><input id="h-name" className="cs__input" required value={f('hName')} onChange={(e) => setF('hName', e.target.value)} /></Field>
            <button type="submit" className="cs__btn">Add holiday</button>
          </form>
          <ul style={list}>{(holidays.data ?? []).map((h) => <li key={h.day} className="ig__row"><div className="ig__rowMain"><strong>{day(h.day)}</strong><p>{h.name}</p></div></li>)}</ul>
        </>}
      </section>
    </div>
  </div>;
}
