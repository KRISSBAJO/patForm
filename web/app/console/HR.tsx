'use client';

import './meetings.css';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ShellSync, type ModuleShell } from './module-shell';
import { Illustration, type IllustrationName } from './illustrations';
import { postJson } from './stepup';

/*
 * HR (PRD Module 7). Everyone: my tasks, my leave, my documents. Managers:
 * leave to approve. Teams (IT, Facilities, Finance): the cases with tasks for
 * them, showing only the basic facts. HR: cases, people, pay, leave setup,
 * documents, reconciliation, upcoming dates, hiring, teams and templates.
 * Pay never appears outside the People section, which only HR can open.
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
  const reload = useCallback(async () => { if (!path) return; try { setData(await get<T>(path)); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}
const day = (v: string | null | undefined) => (v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toLocaleDateString([], { dateStyle: 'medium' }) : '');
const initials = (n: string) => n.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
const KIND: Record<string, string> = { onboarding: 'Onboarding', offboarding: 'Offboarding', transfer: 'Transfer', probation: 'Probation review', urgent_termination: 'Urgent termination' };
const TEAM: Record<string, string> = { hr: 'HR', it: 'IT', facilities: 'Facilities', finance: 'Finance', manager: 'Manager', employee: 'Employee' };
const pillOf = (s: string) => ({ open: 'open', active: 'passed', approved: 'passed', done: 'passed', acknowledged: 'passed', requested: 'open', sent: 'called', pre_hire: 'draft', on_notice: 'open', left: 'cancelled', rejected: 'failed', cancelled: 'cancelled', closed: 'passed', waived: 'withdrawn' }[s] ?? 'draft');
const Pill = ({ s, text }: { s: string; text?: string }) => <span className={`mx__pill mx__pill--${pillOf(s)}`}><i />{text ?? s.replace(/_/g, ' ')}</span>;
const Field = ({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) => <div className={`mx__field ${wide ? 'mx__field--wide' : ''}`}><label>{label}</label>{children}</div>;
const Bar = ({ value, max }: { value: number; max: number }) => <div className="mx__voteBar" style={{ height: 6 }}><span className="is-for" style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%`, background: 'var(--mod, #7a3e9d)' }} /></div>;
const Avatar = ({ name, lg }: { name: string; lg?: boolean }) => <span className={`mx__avatar ${lg ? 'mx__avatar--lg' : ''}`} style={{ marginLeft: 0 }}>{initials(name)}</span>;

export function HRView({ onChanged, shell }: { onChanged?: () => void; shell?: ModuleShell }) {
  const summary = useFeed<Summary>('/api/hr/summary');
  const s = summary.data;
  const hr = s?.hr === true;
  const [tab, setTab] = useState<Tab>('tasks');
  const pickTab = (id: Tab) => { setTab(id); shell?.onSection?.(id); };
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
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState<null | 'onboarding' | 'offboarding' | 'transfer' | 'urgent' | 'probation'>(null);
  const [asking, setAsking] = useState<{ id: string; label: string; run: (answer: string) => Promise<string> } | null>(null);
  const [answer, setAnswer] = useState('');
  const [openCase, setOpenCase] = useState<string | null>(null);
  const [caseFilter, setCaseFilter] = useState<string>('all');
  const [q, setQ] = useState('');
  useEffect(() => {
    if (shell?.section && shell.section !== tab) { setTab(shell.section as Tab); setNote(null); setStarting(null); setForm({}); setAsking(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell?.section]);
  const [pay, setPay] = useState<Record<string, { amount: string; currency: string; period: string; effective_from: string }[]>>({});
  const f = (k: string) => form[k] ?? '';
  const setF = (k: string, v: string) => setForm((x) => ({ ...x, [k]: v }));

  const reloadAll = async () => { await Promise.all([summary.reload(), tasks.reload(), leave.reload(), docs.reload(), approve.reload(), cases.reload(), people.reload(), hiring.reload(), soon.reload(), recon.reload(), teams.reload(), docList.reload(), holidays.reload()]); onChanged?.(); };
  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { const message = await work(); await reloadAll(); setNote({ text: message }); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } finally { setBusy(null); }
  };
  const ask = (id: string, label: string, run: (a: string) => Promise<string>) => { setAsking({ id, label, run }); setAnswer(''); };

  if (summary.error) return <div className="mx"><div className="mx__card"><EmptyState icon="people" title="HR is not available" text={summary.error} /></div></div>;
  if (!s) return <div className="mx"><div className="mx__card"><div className="mx__empty">Loading…</div></div></div>;

  const pre = s.role === 'pre_hire';
  const tabs: { id: Tab; name: string; count: number | null }[] = [
    { id: 'tasks', name: pre ? 'Before you start' : 'My tasks', count: s.myTasks || null },
    ...(!pre ? [{ id: 'leave' as const, name: 'My leave', count: null }] : []),
    { id: 'documents', name: 'My documents', count: (docs.data ?? []).filter((d) => d.status === 'sent').length || null },
    ...(!pre && (s.leaveToApprove > 0 || hr) ? [{ id: 'approve' as const, name: 'Leave to approve', count: s.leaveToApprove || null }] : []),
    ...(hr || s.teams.length ? [{ id: 'cases' as const, name: hr ? 'Cases' : 'Team tasks', count: hr ? ((s.onboarding ?? 0) + (s.offboarding ?? 0) + (s.changes ?? 0)) || null : null }] : []),
    ...(hr ? [
      { id: 'people' as const, name: 'People', count: people.data?.length ?? null },
      { id: 'hiring' as const, name: 'Hiring', count: s.hiring || null },
      { id: 'upcoming' as const, name: 'Coming up', count: soon.data?.length || null },
      { id: 'reconcile' as const, name: 'To reconcile', count: s.reconciliation || null },
      { id: 'setup' as const, name: 'Setup', count: null },
    ] : []),
  ];
  const memberOptions = (members.data ?? []).filter((m) => m.active);
  const leaveLeft = (leave.data?.balances ?? []).find((b) => !b.unlimited);
  const empty = (icon: 'inbox' | 'calendar' | 'vote' | 'check' | 'register' | 'people' | 'send' | 'search', title: string, text: string, action?: { label: string; onClick: () => void }) => <li><EmptyState icon={icon} title={title} text={text} action={action} /></li>;

  const taskRow = (t: MyTask) => <li key={t.id}>
    <span className={`mx__avatar ${t.blockedBy.length ? '' : 'mx__avatar--on'}`} style={{ marginLeft: 0 }}>{t.critical ? '!' : '✓'}</span>
    <div className="mx__main"><strong>{t.title}</strong><small>{KIND[t.kind] ?? t.kind} · {t.employee}{t.effectiveDate ? ` · ${day(t.effectiveDate)}` : ''}{t.blockedBy.length ? ` · waiting: ${t.blockedBy.join(', ')}` : ''}</small></div>
    {t.blockedBy.length ? <Pill s="requested" text="Waiting" /> : <button type="button" className="mx__btn mx__btn--sm" disabled={busy === t.id} onClick={() => ask(t.id, `Note for "${t.title}" (optional)`, async (n) => { await postJson(`/api/hr/tasks/${t.id}/complete`, { note: n }); return `"${t.title}" done.`; })}>Mark done</button>}
  </li>;

  const caseCard = (c: Case) => { const open = openCase === c.id; const pct = c.progress.total ? (c.progress.done / c.progress.total) * 100 : 0; return <div key={c.id} className={`mx__card hr__case ${open ? 'is-open' : ''}`}>
    <button type="button" className="hr__caseHead" onClick={() => setOpenCase(open ? null : c.id)} aria-expanded={open}>
      <Avatar name={c.employee.name} lg />
      <div className="mx__main"><strong>{c.employee.name} <Pill s={c.status} text={`${KIND[c.kind] ?? c.kind}${c.status !== 'open' ? ` · ${c.status}` : ''}`} />{c.restricted && <Pill s="cancelled" text="Restricted" />}</strong><small>{[c.employee.title, c.employee.unit, c.employee.location, c.effectiveDate && `${c.kind === 'onboarding' ? 'starts' : c.kind === 'transfer' ? 'from' : 'on'} ${day(c.effectiveDate)}`].filter(Boolean).join(' · ')}</small>{c.summary && <small>{c.summary}</small>}</div>
      <div className="hr__progress"><Bar value={c.progress.done} max={c.progress.total} /><span className="mx__tiny">{c.progress.done} of {c.progress.total} done</span></div>
      <span className="hr__chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
    </button>
    {c.readiness.length > 0 && <div className="hr__ready"><span className="mx__eyebrow">Still outstanding before {day(c.effectiveDate)}</span><ul>{c.readiness.map((r) => <li key={r.title}><strong>{r.title}</strong><small>{TEAM[r.team]}{r.blockedBy.length ? ` · waits on ${r.blockedBy.join(', ')}` : ''}</small></li>)}</ul></div>}
    {open && <>
      <ul className="mx__list">{c.tasks.map((t) => <li key={t.id} className={t.status !== 'open' ? 'is-done' : ''}>
        <span className={`mx__avatar ${t.status === 'done' ? 'mx__avatar--on' : ''}`} style={{ marginLeft: 0, fontSize: 10 }}>{TEAM[t.team]?.slice(0, 2).toUpperCase()}</span>
        <div className="mx__main"><strong>{t.critical ? <span title="Critical">● </span> : null}{t.title}</strong><small>{TEAM[t.team]} · {t.status === 'open' ? (t.blockedBy.length ? `waiting: ${t.blockedBy.join(', ')}` : 'ready') : t.status === 'done' ? `done${t.completed_by_name ? ` by ${t.completed_by_name}` : ''}` : 'waived'}{t.note ? ` · ${t.note}` : ''}</small></div>
        <Pill s={t.status} text={t.status === 'open' ? (t.blockedBy.length ? 'Waiting' : 'Ready') : t.status === 'done' ? 'Done' : 'Waived'} />
        {t.status === 'open' && t.mine && !t.blockedBy.length && <button type="button" className="mx__btn mx__btn--sm" disabled={busy === t.id} onClick={() => ask(t.id, `Note for "${t.title}" (optional)`, async (n) => { await postJson(`/api/hr/tasks/${t.id}/complete`, { note: n }); return `"${t.title}" done.`; })}>Mark done</button>}
        {t.status === 'open' && hr && s.admin && !t.critical && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(t.id, `Why waive "${t.title}"?`, async (r) => { await postJson(`/api/hr/tasks/${t.id}/except`, { reason: r }); return 'Waived, with your reason recorded.'; })}>Waive</button>}
      </li>)}</ul>
      {hr && <div className="mx__bar">
        <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(c.id, 'Note (kept to HR)', async (b) => { await postJson(`/api/hr/cases/${c.id}/notes`, { body: b, category: 'general' }); return 'Note added.'; })}>Add HR note</button>
        <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(c.id, 'Note shared with the teams on this case', async (b) => { await postJson(`/api/hr/cases/${c.id}/notes`, { body: b, category: 'general', shared: true }); return 'Shared note added.'; })}>Add shared note</button>
        {c.kind === 'probation' && c.status === 'open' && <>
          <button type="button" className="mx__btn mx__btn--sm" onClick={() => ask(c.id, 'Why confirm?', async (r) => { await postJson(`/api/hr/cases/${c.id}/probation-decision`, { outcome: 'confirm', reason: r }); return 'Probation confirmed.'; })}>Confirm probation</button>
          <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(c.id, 'New probation end (YYYY-MM-DD), a space, then the reason', async (r) => { const [newEnd, ...why] = r.split(' '); await postJson(`/api/hr/cases/${c.id}/probation-decision`, { outcome: 'extend', newEnd, reason: why.join(' ') }); return 'Probation extended.'; })}>Extend</button>
        </>}
      </div>}
    </>}
  </div>; };

  const caseList = (cases.data ?? []).filter((c) => caseFilter === 'all' || (caseFilter === 'open' ? c.status === 'open' : c.kind === caseFilter));
  const peopleList = (people.data ?? []).filter((p) => !q.trim() || `${p.name} ${p.email} ${p.position_title ?? ''} ${p.unit_name ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  return <div className="mx">
    <ShellSync sections={tabs} onSections={shell?.onSections} />
    {!shell && <div className="mx__segs" style={{ marginBottom: 14 }}>{tabs.map((t) => <button key={t.id} type="button" className={`mx__seg ${tab === t.id ? 'is-on' : ''}`} onClick={() => pickTab(t.id)}>{t.name}{t.count ? ` · ${t.count}` : ''}</button>)}</div>}

    <section className="mx__band">
      <div className="mx__bandGrid">
        <div>
          <div className="mx__eyebrow">People &amp; HR</div>
          <h2 className="mx__bandTitle">{pre ? 'Welcome — a few things before your first day' : hr ? 'Joiners, movers, leavers and leave' : s.myTasks ? `${s.myTasks} thing${s.myTasks === 1 ? '' : 's'} for you` : 'Your HR, in one place'}</h2>
          <p className="mx__bandSub">{pre ? 'Your tasks before day one. Everything else opens when you start.' : hr ? 'Joiners, leavers, leave and records. Pay and restricted cases stay with HR.' : 'Your tasks, leave and documents.'}</p>
          <div className="mx__bandActions">
            {hr && <button type="button" className="mx__btn mx__btn--light" onClick={() => { pickTab('cases'); setStarting('onboarding'); }}>+ Start an onboarding</button>}
            {!pre && <button type="button" className={`mx__btn ${hr ? 'mx__btn--outline' : 'mx__btn--light'}`} onClick={() => pickTab('leave')}>Ask for leave</button>}
            {hr && <button type="button" className="mx__btn mx__btn--outline" onClick={() => pickTab('people')}>People</button>}
          </div>
        </div>
        {hr ? <>
          <div className={`mx__kpi ${s.onboarding ? 'mx__kpi--live' : ''}`}><span>Joining</span><strong>{s.onboarding ?? 0}</strong><small>{s.hiring ?? 0} open hiring request{s.hiring === 1 ? '' : 's'}</small></div>
          <div className="mx__kpi"><span>Leaving &amp; moving</span><strong>{(s.offboarding ?? 0) + (s.changes ?? 0)}</strong><small>{s.offboarding ?? 0} leaving · {s.changes ?? 0} transfers and reviews</small></div>
          <div className="mx__kpi"><span>Waiting on you</span><strong>{s.myTasks + s.leaveToApprove + (s.reconciliation ?? 0)}</strong><small>{s.myTasks} tasks · {s.leaveToApprove} leave · {s.reconciliation ?? 0} to reconcile</small></div>
        </> : <>
          <div className={`mx__kpi ${s.myTasks ? 'mx__kpi--live' : ''}`}><span>My tasks</span><strong>{s.myTasks}</strong><small>{pre ? 'before your first day' : 'waiting for you'}</small></div>
          <div className="mx__kpi"><span>{leaveLeft ? leaveLeft.name : 'Leave'}</span><strong>{leaveLeft ? leaveLeft.left ?? '–' : '–'}</strong><small>{leaveLeft ? `days left of ${leaveLeft.entitled} · ${leaveLeft.pending} pending` : 'no balance yet'}</small></div>
          <div className="mx__kpi"><span>Documents</span><strong>{(docs.data ?? []).filter((d) => d.status === 'sent').length}</strong><small>to confirm or agree</small></div>
        </>}
      </div>
    </section>

    {note && <p className={`mx__notice ${note.err ? 'mx__notice--err' : ''}`} style={{ marginTop: 16 }} role="status">{note.text}</p>}
    {asking && <form className="mx__ask" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); const job = asking; const a = answer.trim(); setAsking(null); setAnswer(''); void act(job.id, () => job.run(a)); }}>
      <label>{asking.label}</label><input autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} />
      <div className="mx__voteBtns" style={{ marginTop: 0 }}><button type="submit" className="mx__btn mx__btn--sm">Save</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setAsking(null); setAnswer(''); }}>Cancel</button></div>
    </form>}

    <div className="mx__stack" style={{ marginTop: 18 }}>
      {tab === 'tasks' && <div className="mx__card"><div className="mx__cardHead"><h3>{pre ? 'Before you start' : 'My tasks'}</h3><small>{(tasks.data ?? []).length}</small></div>
        <ul className="mx__list" style={{ marginTop: 10 }}>{(tasks.data ?? []).map(taskRow)}{tasks.data && !tasks.data.length && empty('check', 'Nothing for you to do', 'Tasks from onboardings, leavers and transfers that are yours appear here, with what they wait on.')}</ul></div>}

      {tab === 'leave' && leave.data && <>
        <div className="hr__balances">{leave.data.balances.map((b) => <div key={b.key} className="mx__card hr__balance"><div className="mx__cardBody"><span className="mx__eyebrow" style={{ color: 'var(--mx-muted)' }}>{b.name}</span><strong className="hr__big">{b.unlimited ? '∞' : b.left ?? '–'}<small>{b.unlimited ? 'no limit' : 'days left'}</small></strong>{!b.unlimited && <Bar value={b.taken} max={b.entitled} />}<span className="mx__tiny">{b.unlimited ? `${b.taken} taken this year` : `${b.taken} of ${b.entitled} taken · ${b.pending} pending`}{leave.data!.balanceOwner !== 'patform' ? ` · kept in ${leave.data!.balanceOwner}` : ''}</span></div></div>)}</div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Ask for leave</h3><small>weekends and public holidays are not counted</small></div><div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('leave', async () => { const r = await postJson<{ days: number; approver: string }>('/api/hr/leave', { type: f('lType'), startDate: f('lFrom'), endDate: f('lTo'), reason: f('lWhy') }); setForm({}); return `Asked for ${r.days} working day(s); it is with ${r.approver}.`; }); }}>
          <Field label="Type"><div className="mx__segs">{(types.data ?? []).map((t) => <button type="button" key={t.key} className={`mx__seg ${f('lType') === t.key ? 'is-on' : ''}`} onClick={() => setF('lType', t.key)}>{t.name}</button>)}</div></Field>
          <Field label="Note (optional)"><input value={f('lWhy')} onChange={(e) => setF('lWhy', e.target.value)} /></Field>
          <Field label="From"><input type="date" required value={f('lFrom')} onChange={(e) => setF('lFrom', e.target.value)} /></Field>
          <Field label="To"><input type="date" required value={f('lTo')} onChange={(e) => setF('lTo', e.target.value)} /></Field>
          <div className="mx__field--wide"><button type="submit" className="mx__btn" disabled={busy === 'leave' || !f('lType')}>Send the request</button></div>
        </form></div></div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Your requests</h3><small>{leave.data.year}</small></div>
          <ul className="mx__list" style={{ marginTop: 10 }}>{leave.data.requests.map((r) => <li key={r.id}><div className="mx__date"><strong>{new Date(`${r.start_date}T00:00:00`).getDate()}</strong><small>{new Date(`${r.start_date}T00:00:00`).toLocaleDateString([], { month: 'short' })}</small></div><div className="mx__main"><strong>{r.type} · {Number(r.days)} day{Number(r.days) === 1 ? '' : 's'}</strong><small>{day(r.start_date)} to {day(r.end_date)}{r.approver ? ` · ${r.approver}` : ''}{r.decision_note ? ` · ${r.decision_note}` : ''}</small></div><Pill s={r.status} />{['requested', 'approved'].includes(r.status) && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(r.id, async () => { await postJson(`/api/hr/leave/${r.id}/cancel`, {}); return 'Leave cancelled.'; })}>Cancel</button>}</li>)}{!leave.data.requests.length && empty('calendar', 'No leave taken yet', 'Your requests and their decisions are listed here.')}</ul></div>
      </>}

      {tab === 'documents' && <div className="mx__card"><div className="mx__cardHead"><h3>My documents</h3><small>{(docs.data ?? []).filter((d) => d.status === 'sent').length} to do</small></div>
        <ul className="mx__list" style={{ marginTop: 10 }}>{(docs.data ?? []).map((d) => <li key={d.id}><span className={`mx__avatar ${d.status === 'acknowledged' ? 'mx__avatar--on' : ''}`} style={{ marginLeft: 0 }}>{d.kind === 'agreement' ? '✍' : '✓'}</span><div className="mx__main"><strong>{d.title}</strong><small>Version {d.version}{d.due_date ? ` · by ${day(d.due_date)}` : ''}{d.document_ref ? ` · ${d.document_ref}` : ''}{d.statement ? ` · "${d.statement}"` : ''}</small></div><Pill s={d.status} text={d.status === 'acknowledged' ? 'Done' : d.kind === 'agreement' ? 'To agree' : 'To confirm'} />{d.status === 'sent' && <button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(d.id, async () => { const r = await postJson<{ statement: string }>(`/api/hr/documents/requests/${d.id}/acknowledge`, {}); return `Recorded: "${r.statement}"`; })}>{d.kind === 'agreement' ? 'I agree' : 'Received'}</button>}</li>)}{docs.data && !docs.data.length && empty('register', 'No documents for you', 'Policies and agreements HR sends you to confirm or agree appear here.')}</ul></div>}

      {tab === 'approve' && <div className="mx__card"><div className="mx__cardHead"><h3>Leave to approve</h3><small>{(approve.data ?? []).length}</small></div>
        <ul className="mx__list" style={{ marginTop: 10 }}>{(approve.data ?? []).map((r) => <li key={r.id}><Avatar name={r.employee_name} lg /><div className="mx__main"><strong>{r.employee_name} · {r.type}</strong><small>{day(r.start_date)} to {day(r.end_date)} · {r.days} day{r.days === 1 ? '' : 's'}{r.reason ? ` · ${r.reason}` : ''}</small>{r.sameUnitAway.length > 0 && <small style={{ color: '#8a3a34' }}>Also away from the same team: {r.sameUnitAway.map((o) => `${o.name} (${day(o.start_date)}–${day(o.end_date)})`).join(', ')}</small>}</div><button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(r.id, async () => { await postJson(`/api/hr/leave/${r.id}/decide`, { decision: 'approve' }); return 'Approved.'; })}>Approve</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(r.id, 'Why not?', async (n) => { await postJson(`/api/hr/leave/${r.id}/decide`, { decision: 'reject', note: n }); return 'Declined.'; })}>Decline</button></li>)}{approve.data && !approve.data.length && empty('calendar', 'No leave waiting for you', 'Requests from the people who report to you land here, with who else from their team is away then.')}</ul></div>}

      {tab === 'cases' && <>
        {hr && <div className="mx__quick">
          {([['onboarding', 'Start an onboarding', 'A new joiner and their first-day tasks', 'people'], ['offboarding', 'Start an offboarding', 'A leaver; access ends on the date', 'send'], ['transfer', 'Transfer or promotion', 'New manager, title or unit from a date', 'actions'], ['probation', 'Probation review', 'Manager check-in, then HR decides', 'verify'], ...(s.admin ? [['urgent', 'Urgent termination', 'Revokes access now; restricted to HR', 'register']] : [])] as [typeof starting, string, string, IllustrationName][]).map(([k, label, sub, art]) => <button key={k} type="button" className={`mx__quickBtn ${starting === k ? 'is-on' : ''}`} aria-expanded={starting === k} onClick={() => { setStarting(starting === k ? null : k); setForm({}); }}><Illustration name={art} size={48} /><strong>{label}</strong><small>{sub}</small></button>)}
        </div>}
        {starting === 'onboarding' && <div className="mx__card"><div className="mx__cardHead"><h3>New joiner</h3><small>they get a pre-hire account: their own tasks only, until access opens on the first day</small></div><div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('start', async () => { const r = await postJson<{ invitation: string | null }>('/api/hr/cases/onboarding', { name: f('oName'), email: f('oEmail'), startDate: f('oStart'), employmentType: f('oType') || 'employee', location: f('oLoc'), managerId: f('oMgr') || undefined, title: f('oTitle'), probationEnd: f('oProb') || undefined, hiringId: f('oHire') || undefined, sendInvitation: f('oInvite') === 'yes' }); setStarting(null); setForm({}); return `Onboarding started.${r.invitation ? ` Invitation: ${r.invitation}.` : ''}`; }); }}>
          <Field label="Name"><input required value={f('oName')} onChange={(e) => setF('oName', e.target.value)} /></Field>
          <Field label="Work email"><input type="email" required value={f('oEmail')} onChange={(e) => setF('oEmail', e.target.value)} /></Field>
          <Field label="Start date"><input type="date" required value={f('oStart')} onChange={(e) => setF('oStart', e.target.value)} /></Field>
          <Field label="Type"><div className="mx__segs">{[['employee', 'Employee'], ['contractor', 'Contractor'], ['intern', 'Intern']].map(([k, v]) => <button type="button" key={k} className={`mx__seg ${(f('oType') || 'employee') === k ? 'is-on' : ''}`} onClick={() => setF('oType', k!)}>{v}</button>)}</div></Field>
          <Field label="Job title"><input value={f('oTitle')} onChange={(e) => setF('oTitle', e.target.value)} /></Field>
          <Field label="Location"><input value={f('oLoc')} onChange={(e) => setF('oLoc', e.target.value)} /></Field>
          <Field label="Manager"><select value={f('oMgr')} onChange={(e) => setF('oMgr', e.target.value)}><option value="">Choose…</option>{memberOptions.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
          <Field label="Probation ends (optional)"><input type="date" value={f('oProb')} onChange={(e) => setF('oProb', e.target.value)} /></Field>
          <Field label="For hiring request (optional)"><select value={f('oHire')} onChange={(e) => setF('oHire', e.target.value)}><option value="">None</option>{(hiring.data ?? []).filter((h) => h.status === 'open').map((h) => <option key={h.id} value={h.id}>{h.reference} · {h.position} ({h.filled}/{h.headcount})</option>)}</select></Field>
          <Field label="Invitation"><div className="mx__segs"><button type="button" className={`mx__seg ${f('oInvite') === 'yes' ? 'is-on' : ''}`} onClick={() => setF('oInvite', f('oInvite') === 'yes' ? '' : 'yes')}>Email them an invitation now</button></div></Field>
          <div className="mx__field--wide"><button type="submit" className="mx__btn" disabled={busy === 'start'}>Start onboarding</button></div>
        </form></div></div>}
        {(starting === 'offboarding' || starting === 'urgent' || starting === 'probation' || starting === 'transfer') && <div className="mx__card"><div className="mx__cardHead"><h3>{{ offboarding: 'Leaver', urgent: 'Urgent termination', probation: 'Probation review', transfer: 'Transfer or promotion' }[starting]}</h3><small>{starting === 'urgent' ? 'revokes all access immediately; the reason stays in a restricted HR note' : starting === 'offboarding' ? 'access is revoked on the end date, whatever else is outstanding' : starting === 'transfer' ? 'approvals go to the new manager from the effective date' : 'manager check-in and recommendation, then HR decides'}</small></div><div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('start', async () => {
          if (starting === 'offboarding') await postJson('/api/hr/cases/offboarding', { employeeId: f('xEmp'), endDate: f('xDate'), summary: f('xWhy') });
          if (starting === 'urgent') await postJson('/api/hr/cases/urgent-termination', { employeeId: f('xEmp'), reason: f('xWhy') });
          if (starting === 'probation') await postJson('/api/hr/cases/probation', { employeeId: f('xEmp') });
          if (starting === 'transfer') await postJson('/api/hr/cases/transfer', { employeeId: f('xEmp'), effectiveDate: f('xDate'), managerId: f('xMgr') || undefined, title: f('xTitle') || undefined, reason: f('xWhy') });
          const done = starting === 'urgent' ? 'Access revoked now. The case is restricted to HR.' : 'Started.'; setStarting(null); setForm({}); return done; }); }}>
          <Field label="Person"><select required value={f('xEmp')} onChange={(e) => setF('xEmp', e.target.value)}><option value="">Choose…</option>{(people.data ?? []).filter((p) => p.status !== 'left').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          {(starting === 'offboarding' || starting === 'transfer') && <Field label={starting === 'transfer' ? 'Effective from' : 'Last day'}><input type="date" required value={f('xDate')} onChange={(e) => setF('xDate', e.target.value)} /></Field>}
          {starting === 'transfer' && <><Field label="New manager"><select value={f('xMgr')} onChange={(e) => setF('xMgr', e.target.value)}><option value="">No change</option>{memberOptions.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field><Field label="New title"><input value={f('xTitle')} onChange={(e) => setF('xTitle', e.target.value)} /></Field></>}
          {starting !== 'probation' && <Field label={starting === 'urgent' ? 'Reason (restricted)' : starting === 'transfer' ? 'What is changing' : 'Note'} wide><input required={starting !== 'offboarding'} value={f('xWhy')} onChange={(e) => setF('xWhy', e.target.value)} /></Field>}
          <div className="mx__field--wide"><button type="submit" className={`mx__btn ${starting === 'urgent' ? 'mx__btn--danger' : ''}`} disabled={busy === 'start'}>{starting === 'urgent' ? 'Authorise and revoke access' : 'Start'}</button></div>
        </form></div></div>}
        <div className="mx__card"><div className="mx__cardHead"><h3>{hr ? 'Cases' : 'Team tasks'}</h3><div className="mx__segs">{([['all', 'All'], ['open', 'Open'], ['onboarding', 'Joining'], ['offboarding', 'Leaving'], ['transfer', 'Transfers'], ['probation', 'Probation']] as const).map(([k, v]) => <button key={k} type="button" className={`mx__seg ${caseFilter === k ? 'is-on' : ''}`} onClick={() => setCaseFilter(k)}>{v}</button>)}</div></div>
          <div className="hr__cases">{caseList.map(caseCard)}{cases.data && !caseList.length && <EmptyState icon="people" title="No cases" text={hr ? 'Start an onboarding, offboarding, transfer or probation review above.' : 'Cases with a task for your team appear here with the basic facts only.'} />}</div>
        </div>
      </>}

      {tab === 'people' && <div className="mx__card"><div className="mx__cardHead"><h3>People</h3><input className="mx__input" style={{ height: 36, width: 240 }} placeholder="Search name, title, unit" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="hr__people">{peopleList.map((p) => <div key={p.id} className="hr__person">
          <Avatar name={p.name} lg />
          <div className="mx__main"><strong>{p.name} <Pill s={p.status} /></strong><small>{[p.position_title, p.unit_name, p.location].filter(Boolean).join(' · ') || p.employment_type}</small><small className="mx__tiny">{[p.employment_type, p.manager_name && `reports to ${p.manager_name}`, p.start_date && `since ${day(p.start_date)}`, p.probation_end && `probation to ${day(p.probation_end)}`, p.payroll_ref && `payroll ${p.payroll_ref}`].filter(Boolean).join(' · ')}</small>{pay[p.id] && <small className="hr__pay">Pay: {pay[p.id]!.length ? pay[p.id]!.map((x) => `${x.currency} ${Number(x.amount).toLocaleString()} a ${x.period} from ${day(x.effective_from)}`).join('; ') : 'none recorded'}</small>}</div>
          {s.admin && <div className="mx__voteBtns" style={{ marginTop: 0 }}><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(p.id, async () => { setPay({ ...pay, [p.id]: await get(`/api/hr/employees/${p.id}/pay`) }); return 'Pay shown. Only HR can see it.'; })}>Show pay</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(p.id, 'New pay: amount currency period date, e.g. "4800000 NGN year 2026-11-01"', async (a) => { const [amount, currency, period, effectiveFrom] = a.split(/\s+/); const r = await postJson<{ queuedForReconciliation: boolean }>(`/api/hr/employees/${p.id}/pay`, { amount, currency, period, effectiveFrom }); return r.queuedForReconciliation ? 'Pay is owned by another system: a reconciliation task was raised instead.' : 'Pay recorded.'; })}>Set pay</button></div>}
        </div>)}{people.data && !peopleList.length && <EmptyState icon="people" title={q ? 'No match' : 'No people yet'} text={q ? 'Try another name, title or unit.' : 'Start an onboarding and the person appears here with their record.'} />}</div></div>}

      {tab === 'hiring' && <div className="mx__card"><div className="mx__cardHead"><h3>Hiring</h3><small>{(hiring.data ?? []).filter((h) => h.status === 'open').length} open</small></div>
        <ul className="mx__list" style={{ marginTop: 10 }}>{(hiring.data ?? []).map((h) => <li key={h.id}><div className="mx__main"><strong>{h.reference} · {h.position}</strong><small>{h.filled} of {h.headcount} hired{h.cost_centre ? ` · ${h.cost_centre}` : ''} · start each hire from Cases → Start an onboarding</small></div><div className="hr__progress"><Bar value={h.filled} max={h.headcount} /></div><Pill s={h.status} /></li>)}{hiring.data && !hiring.data.length && empty('people', 'No approved hiring requests', 'Managers ask with the Hiring request form; approved requests show here with their headcount.')}</ul></div>}

      {tab === 'upcoming' && <div className="mx__card"><div className="mx__cardHead"><h3>Coming up</h3><small>next 60 days</small></div>
        <ul className="mx__list" style={{ marginTop: 10 }}>{(soon.data ?? []).map((x, i) => <li key={i}><div className="mx__date"><strong>{new Date(x.on.length === 10 ? `${x.on}T00:00:00` : x.on).getDate()}</strong><small>{new Date(x.on.length === 10 ? `${x.on}T00:00:00` : x.on).toLocaleDateString([], { month: 'short' })}</small></div><div className="mx__main"><strong>{x.name}</strong><small>{x.detail ?? ''}</small></div><Pill s="draft" text={{ probation_end: 'Probation ends', start: 'Starts', leaving: 'Leaves', certification: 'Certification expires', anniversary: 'Work anniversary' }[x.kind] ?? x.kind} /></li>)}{soon.data && !soon.data.length && empty('calendar', 'Nothing in the next 60 days', 'Start dates, last days, probation ends, certifications and anniversaries show here.')}</ul></div>}

      {tab === 'reconcile' && <div className="mx__card"><div className="mx__cardHead"><h3>To reconcile</h3><small>changes another system owns</small></div>
        <ul className="mx__list" style={{ marginTop: 10 }}>{(recon.data ?? []).map((r) => <li key={r.id}><Avatar name={r.employee_name} /><div className="mx__main"><strong>{r.employee_name} · {r.field.replace('_', ' ')}</strong><small>{r.owner} owns this field · proposed {r.proposed_value ?? '—'}{r.current_value ? ` (now ${r.current_value})` : ''} · raised by {r.raised_by}</small></div><Pill s={r.status} />{r.status === 'open' && <><button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(r.id, async () => { await postJson(`/api/hr/reconciliation/${r.id}`, { outcome: 'applied' }); return `Marked as updated in ${r.owner}.`; })}>Updated in {r.owner}</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(r.id, async () => { await postJson(`/api/hr/reconciliation/${r.id}`, { outcome: 'dismissed' }); return 'Dismissed.'; })}>Dismiss</button></>}</li>)}{recon.data && !recon.data.length && empty('check', 'Nothing to reconcile', 'When a change belongs to another system (payroll, say), it waits here until someone confirms it was made there.')}</ul></div>}

      {tab === 'setup' && <>
        <div className="mx__card"><div className="mx__cardHead"><h3>Teams</h3><small>who sees the IT, Facilities, Finance and HR tasks · owners and admins are always HR</small></div>
          {s.admin && <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('team', async () => { await postJson('/api/hr/teams', { team: f('tTeam'), actorId: f('tWho') }); setForm({}); return 'Added to the team.'; }); }}>
            <Field label="Team"><div className="mx__segs">{[['hr', 'HR'], ['it', 'IT'], ['facilities', 'Facilities'], ['finance', 'Finance']].map(([k, v]) => <button type="button" key={k} className={`mx__seg ${f('tTeam') === k ? 'is-on' : ''}`} onClick={() => setF('tTeam', k!)}>{v}</button>)}</div></Field>
            <Field label="Person"><select required value={f('tWho')} onChange={(e) => setF('tWho', e.target.value)}><option value="">Choose…</option>{memberOptions.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
            <div className="mx__field--wide"><button type="submit" className="mx__btn mx__btn--sm" disabled={!f('tTeam') || !f('tWho')}>Add to team</button></div>
          </form></div>}
          <ul className="mx__list">{(teams.data ?? []).map((t) => <li key={`${t.team}-${t.actor_id}`}><Avatar name={t.display_name} /><div className="mx__main"><strong>{t.display_name}</strong><small>{TEAM[t.team]}</small></div>{s.admin && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(t.actor_id, async () => { await postJson('/api/hr/teams', { team: t.team, actorId: t.actor_id, member: false }); return 'Removed from the team.'; })}>Remove</button>}</li>)}</ul></div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Documents to send</h3><small>people confirm they received it, or agree to it; the words recorded say which</small></div>
          <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('doc', async () => { const d = await postJson<{ id: string }>('/api/hr/documents', { title: f('dTitle'), version: f('dVer'), kind: f('dKind') || 'receipt', documentRef: f('dRef') }); const sent = await postJson<{ sent: number }>(`/api/hr/documents/${d.id}/send`, { employeeIds: 'all', dueDate: f('dDue') || undefined }); setForm({}); return `Sent to ${sent.sent} people.`; }); }}>
            <Field label="Title"><input required value={f('dTitle')} onChange={(e) => setF('dTitle', e.target.value)} /></Field>
            <Field label="Version"><input required value={f('dVer')} onChange={(e) => setF('dVer', e.target.value)} /></Field>
            <Field label="People should"><div className="mx__segs">{[['receipt', 'Confirm they received it'], ['agreement', 'Agree to it']].map(([k, v]) => <button type="button" key={k} className={`mx__seg ${(f('dKind') || 'receipt') === k ? 'is-on' : ''}`} onClick={() => setF('dKind', k!)}>{v}</button>)}</div></Field>
            <Field label="By"><input type="date" value={f('dDue')} onChange={(e) => setF('dDue', e.target.value)} /></Field>
            <Field label="Where it is" wide><input value={f('dRef')} onChange={(e) => setF('dRef', e.target.value)} /></Field>
            <div className="mx__field--wide"><button type="submit" className="mx__btn mx__btn--sm">Send to everyone</button></div>
          </form></div>
          <ul className="mx__list">{(docList.data ?? []).map((d) => <li key={d.id}><div className="mx__main"><strong>{d.title} · {d.version}</strong><small>{d.acknowledged} of {d.sent} done{d.overdue ? ` · ${d.overdue} overdue` : ''}</small></div><div className="hr__progress"><Bar value={d.acknowledged} max={d.sent} /></div><Pill s="draft" text={d.kind === 'agreement' ? 'Agreement' : 'Receipt'} /></li>)}</ul></div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Public holidays</h3><small>not counted as leave days</small></div>
          <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('hol', async () => { await postJson('/api/hr/leave/holidays', { day: f('hDay'), name: f('hName') }); setForm({}); return 'Holiday added.'; }); }}>
            <Field label="Date"><input type="date" required value={f('hDay')} onChange={(e) => setF('hDay', e.target.value)} /></Field>
            <Field label="Name"><input required value={f('hName')} onChange={(e) => setF('hName', e.target.value)} /></Field>
            <div className="mx__field--wide"><button type="submit" className="mx__btn mx__btn--ghost mx__btn--sm">Add holiday</button></div>
          </form></div>
          <ul className="mx__list">{(holidays.data ?? []).map((h) => <li key={h.day}><div className="mx__date"><strong>{new Date(`${h.day}T00:00:00`).getDate()}</strong><small>{new Date(`${h.day}T00:00:00`).toLocaleDateString([], { month: 'short' })}</small></div><div className="mx__main"><strong>{h.name}</strong><small>{day(h.day)}</small></div></li>)}</ul></div>
      </>}
    </div>
  </div>;
}
