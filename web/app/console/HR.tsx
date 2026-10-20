'use client';

import './meetings.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState, ShellSync, type ModuleShell } from './module-shell';
import { Illustration, type IllustrationName } from './illustrations';
import { postJson } from './stepup';
import { COUNTRIES, CURRENCIES, Choice, F, Sheet, SheetSection, TIMEZONES, WEEKDAYS, money, readFileAsBase64 } from './sheet';
import { DataTable } from './datatable';

/*
 * HR (PRD Module 7). Everyone: my tasks, leave, documents and profile; the
 * team's leave calendar. Managers: leave to approve, their reports' records.
 * HR: cases, the people directory with full records (timeline, files, pay),
 * the org chart, hiring, upcoming dates, reconciliation and setup, including
 * branches so a company can run in several countries and currencies.
 */

type Tab = 'tasks' | 'leave' | 'calendar' | 'documents' | 'profile' | 'approve' | 'cases' | 'people' | 'org' | 'hiring' | 'upcoming' | 'reconcile' | 'setup';
type Summary = { hr: boolean; admin?: boolean; role: string; teams: string[]; myTasks: number; leaveToApprove: number; onboarding?: number; offboarding?: number; changes?: number; reconciliation?: number; hiring?: number };
type Task = { id: string; key: string; title: string; team: string; critical: boolean; status: string; note: string | null; mine: boolean; blockedBy: string[]; completed_by_name: string | null; action: string | null };
type Case = { id: string; kind: string; status: string; restricted?: boolean; effectiveDate: string | null; summary: string | null; employee: { id: string; name: string; email: string; location: string | null; startDate: string | null; endDate: string | null; unit: string | null; title: string | null; employmentType: string }; progress: { done: number; total: number }; readiness: { title: string; team: string; critical: boolean; blockedBy: string[] }[]; tasks: Task[] };
type MyTask = Task & { caseId: string; kind: string; employee: string; effectiveDate: string | null };
type Balance = { typeId: string; key: string; name: string; unlimited: boolean; accrualMode: string; entitled: number; accrued: number; carriedOver: number; adjusted: number; taken: number; pending: number; left: number | null };
type LeaveReq = { id: string; type: string; start_date: string; end_date: string; days: string | number; status: string; decision_note: string | null; approver?: string | null; reason?: string | null };
type MyLeave = { year: number; balances: Balance[]; requests: LeaveReq[]; balanceOwner: string };
type ToApprove = { id: string; employee_name: string; type: string; start_date: string; end_date: string; days: number; reason: string | null; sameUnitAway: { name: string; start_date: string; end_date: string }[] };
type MyDoc = { id: string; document_id: string; title: string; version: string; kind: string; document_ref: string | null; has_file: boolean; due_date: string | null; status: string; statement: string | null };
type Employee = { id: string; name: string; email: string; employment_type: string; status: string; location: string | null; start_date: string | null; end_date: string | null; probation_end: string | null; payroll_ref: string | null; workspace_role: string | null; position_title: string | null; unit_name: string | null; manager_name: string | null; branch_id: string | null; branch_name: string | null; branch_country: string | null; branch_currency: string | null; grade: string | null };
type Member = { id: string; display_name: string; email: string; active: boolean };
type Branch = { id: string; name: string; code: string | null; country: string; currency: string; timezone: string; address: string | null; working_days: number[]; active: boolean; people: number };
type Branches = { branches: Branch[]; defaultCurrency: string; defaultCountry: string | null; workingDays: number[]; canEdit: boolean };
type LeaveType = { id: string; key: string; name: string; annual_days: string; unlimited: boolean; active: boolean; accrual_mode: string; carry_over_max: string; prorate_first_year: boolean; branch_id: string | null; branch_name: string | null };
type Holiday = { day: string; name: string; branch_id: string | null; branch_name: string | null };
type DocRow = { id: string; title: string; version: string; kind: string; sent: number; acknowledged: number; overdue: number; filename: string | null; byte_size: number | null; scan_status: string };
type Detail = {
  tier: 'hr' | 'manager' | 'self'; profile: Record<string, string | null | boolean>; reportingHistory: { kind: string; effective_from: string; effective_to: string | null; manager: string }[];
  leave: { year: number; balances: Balance[]; requests: LeaveReq[] }; cases: { id: string; kind: string; status: string; effective_date: string | null; created_at: string; restricted: boolean }[];
  certifications: { id: string; name: string; expires_on: string }[]; files: { id: string; category: string; title: string; filename: string; content_type: string; byte_size: number; scan_status: string; employee_can_see: boolean; created_at: string; uploaded_by: string | null }[];
  events: { id: string; kind: string; title: string; detail: string | null; visibility: string; occurred_on: string; by: string | null }[]; reports: { id: string; name: string; position_title: string | null }[];
  documents: { id: string; document_id: string; title: string; version: string; kind: string; status: string; due_date: string | null; acknowledged_at: string | null; has_file: boolean }[];
  timeline: { on: string; kind: string; title: string; detail: string | null; by?: string | null }[];
};
type PayLine = { id: number; kind: string; label: string; amount: string; currency: string; period: string; effective_from: string; ended_on: string | null; reason: string | null; entered_by: string | null };
type PersonRow = { id: string; name: string; email: string; status: string; type: string; location: string | null; grade: string | null; start_date: string | null; probation_end: string | null; title: string | null; unit: string | null; branch: string | null; branch_country: string | null; manager: string | null };
type OrgNode = { id: string; actorId: string | null; name: string; title: string | null; unit: string | null; branch: string | null; status: string | null; email: string; reports: OrgNode[] };
type Calendar = { month: string; first: string; last: string; holidays: { day: string; name: string; branch: string | null }[]; away: { id: string; employee_id: string; name: string; unit: string | null; branch: string | null; type: string; start_date: string; end_date: string; days: number; status: string; mine: boolean }[]; scope: string };

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
const flag = (cc: string | null) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');
const KIND: Record<string, string> = { onboarding: 'Onboarding', offboarding: 'Offboarding', transfer: 'Transfer', probation: 'Probation review', urgent_termination: 'Urgent termination' };
const TEAM: Record<string, string> = { hr: 'HR', it: 'IT', facilities: 'Facilities', finance: 'Finance', manager: 'Manager', employee: 'Employee' };
const pillOf = (s: string) => ({ open: 'open', active: 'passed', approved: 'passed', done: 'passed', acknowledged: 'passed', requested: 'open', sent: 'called', pre_hire: 'draft', on_notice: 'open', leaving: 'open', left: 'cancelled', rejected: 'failed', cancelled: 'cancelled', closed: 'passed', waived: 'withdrawn', clean: 'passed', unscanned: 'draft', quarantined: 'failed', hr: 'failed', manager: 'called', employee: 'passed' }[s] ?? 'draft');
const Pill = ({ s, text }: { s: string; text?: string }) => <span className={`mx__pill mx__pill--${pillOf(s)}`}><i />{text ?? s.replace(/_/g, ' ')}</span>;
const Bar = ({ value, max }: { value: number; max: number }) => <div className="mx__voteBar" style={{ height: 6 }}><span className="is-for" style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`, background: 'var(--mod, #7a3e9d)' }} /></div>;
const Avatar = ({ name, lg }: { name: string; lg?: boolean }) => <span className={`mx__avatar ${lg ? 'mx__avatar--lg' : ''}`} style={{ marginLeft: 0 }}>{initials(name)}</span>;
const Fact = ({ label, value }: { label: string; value: string | null | undefined }) => <div className="hr__fact"><span>{label}</span><strong className={value ? '' : 'is-empty'}>{value || 'Not set'}</strong></div>;
const empty = (icon: 'inbox' | 'calendar' | 'vote' | 'check' | 'register' | 'people' | 'send' | 'search', title: string, text: string, action?: { label: string; onClick: () => void }) => <li><EmptyState icon={icon} title={title} text={text} action={action} /></li>;
type Act = (id: string, work: () => Promise<string>) => Promise<void>;
type Ask = (id: string, label: string, run: (a: string) => Promise<string>) => void;

/** Pick a file; shows the chosen name; hands back base64 on demand. */
function FilePick({ file, onFile, accept }: { file: File | null; onFile: (f: File | null) => void; accept?: string }) {
  const [over, setOver] = useState(false);
  return <label className={`mx__dropzone ${over ? 'is-over' : ''} ${file ? 'is-set' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0] ?? null); }}>
    <input type="file" accept={accept ?? '.pdf,.docx,.png,.jpg,.jpeg,.webp'} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
    <Illustration name="register" size={40} />
    <strong>{file ? file.name : 'Drop a file here or choose one'}</strong>
    <small>{file ? `${(file.size / 1024).toFixed(0)} KB` : 'PDF, Word, JPEG, PNG or WebP · up to 5 MB'}</small>
  </label>;
}

/** The full record of one person. */
function PersonPage({ id, onBack, admin, branches, act, busy, mine }: { id: string | null; onBack: () => void; admin: boolean; branches: Branch[]; act: Act; busy: string | null; mine?: boolean }) {
  const feed = useFeed<Detail>(mine ? '/api/hr/me' : id ? `/api/hr/employees/${id}` : null);
  const d = feed.data;
  const [tab, setTab] = useState<'overview' | 'timeline' | 'leave' | 'files' | 'documents' | 'pay' | 'notes'>('overview');
  const [sheet, setSheet] = useState<null | 'edit' | 'note' | 'file' | 'pay' | 'adjust' | 'branch' | 'cert'>(null);
  const [f, setForm] = useState<Record<string, string>>({});
  const v = (k: string) => f[k] ?? '';
  const set = (k: string, val: string) => setForm((x) => ({ ...x, [k]: val }));
  const [file, setFile] = useState<File | null>(null);
  const [canSee, setCanSee] = useState(false);
  const pay = useFeed<PayLine[]>(d && d.tier === 'hr' && admin && tab === 'pay' ? `/api/hr/employees/${d.profile.id}/pay` : null);
  const run = (key: string, work: () => Promise<string>) => void act(key, async () => { const m = await work(); setSheet(null); setForm({}); setFile(null); await feed.reload(); await pay.reload(); return m; });
  if (feed.error) return <div className="mx__card"><EmptyState icon="people" title="Cannot open this record" text={feed.error} action={{ label: 'Back', onClick: onBack }} /></div>;
  if (!d) return <div className="mx__card"><div className="mx__empty">Loading…</div></div>;
  const p = d.profile; const eid = String(p.id); const name = String(p.name);
  const hr = d.tier === 'hr'; const self = d.tier === 'self'; const mgr = d.tier === 'manager';
  const branch = branches.find((b) => b.id === p.branch_id);
  const cur = branch?.currency ?? '';
  const todayIso = new Date().toISOString().slice(0, 10);
  const openEdit = () => { setForm({ phone: String(p.phone ?? ''), personalEmail: String(p.personal_email ?? ''), address: String(p.address ?? ''), emergencyName: String(p.emergency_name ?? ''), emergencyPhone: String(p.emergency_phone ?? ''), emergencyRelation: String(p.emergency_relation ?? ''), bio: String(p.bio ?? ''), dateOfBirth: String(p.date_of_birth ?? ''), grade: String(p.grade ?? ''), workPattern: String(p.work_pattern ?? ''), location: String(p.location ?? ''), startDate: String(p.start_date ?? ''), endDate: String(p.end_date ?? ''), probationEnd: String(p.probation_end ?? ''), externalRef: String(p.external_ref ?? ''), employmentType: String(p.employment_type ?? 'employee') }); setSheet('edit'); };
  const tabs: [typeof tab, string, number | null][] = [['overview', 'Overview', null], ['timeline', 'Timeline', d.timeline.length], ['leave', 'Leave', null]];
  if (!mgr) tabs.push(['files', 'Files', d.files.length], ['documents', 'Documents', d.documents.length]);
  if (hr && admin) tabs.push(['pay', 'Pay', null]);
  if (!self) tabs.push(['notes', 'Notes', d.events.length]);
  const link = async (url: string) => { const r = await get<{ url: string }>(url); window.open(r.url, '_blank', 'noopener'); return 'Opened in a new tab.'; };

  return <>
    <div className="mx__card">
      <div className="hr__personHead">
        <Avatar name={name} lg />
        <div>
          <div className="mx__eyebrow">{mine ? 'My profile' : 'Employee record'}</div>
          <h2>{name}</h2>
          <div className="hr__meta">{p.position_title && <span>{String(p.position_title)}</span>}{p.unit_name && <span>{String(p.unit_name)}</span>}{p.branch_name && <span>{flag(String(p.branch_country))} {String(p.branch_name)}</span>}{p.manager_name && <span>reports to {String(p.manager_name)}</span>}{p.start_date && <span>since {day(String(p.start_date))}</span>}</div>
          <div className="hr__pills"><Pill s={String(p.status)} /><Pill s="draft" text={String(p.employment_type)} />{p.grade && <Pill s="draft" text={`Grade ${String(p.grade)}`} />}{d.reports.length > 0 && <Pill s="called" text={`${d.reports.length} report${d.reports.length === 1 ? '' : 's'}`} />}</div>
        </div>
        <div className="hr__personBtns">
          {!mine && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={onBack}>← Back</button>}
          {(hr || self) && <button type="button" className="mx__btn mx__btn--sm" onClick={openEdit}>{self ? 'Edit my details' : 'Edit record'}</button>}
          {hr && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({ branchId: String(p.branch_id ?? '') }); setSheet('branch'); }}>Move branch</button>}
          {!self && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({ kind: 'note', visibility: hr ? 'hr' : 'manager' }); setSheet('note'); }}>+ Note</button>}
        </div>
      </div>
      <div className="mx__segs" style={{ padding: '0 24px 18px' }}>{tabs.map(([k, label, n]) => <button key={k} type="button" className={`mx__seg ${tab === k ? 'is-on' : ''}`} onClick={() => setTab(k)}>{label}{n ? ` · ${n}` : ''}</button>)}</div>
    </div>

    {tab === 'overview' && <div className="hr__grid2">
      <div className="mx__stack">
        <div className="mx__card"><div className="mx__cardHead"><h3>Employment</h3></div><div className="hr__facts">
          <Fact label="Job title" value={p.position_title as string} /><Fact label="Unit" value={p.unit_name as string} /><Fact label="Branch" value={p.branch_name ? `${flag(String(p.branch_country))} ${p.branch_name}` : null} /><Fact label="Location" value={p.location as string} />
          <Fact label="Type" value={p.employment_type as string} /><Fact label="Grade" value={p.grade as string} /><Fact label="Start date" value={day(p.start_date as string)} /><Fact label="Probation ends" value={day(p.probation_end as string)} />
          {p.end_date && <Fact label="Last day" value={day(p.end_date as string)} />}<Fact label="Work pattern" value={p.work_pattern as string} />{hr && <><Fact label="Payroll reference" value={p.payroll_ref as string} /><Fact label="External reference" value={p.external_ref as string} /></>}
        </div></div>
        {!mgr && <div className="mx__card"><div className="mx__cardHead"><h3>Contact &amp; emergency</h3><small>{self ? 'only you and HR see this' : 'HR only'}</small></div><div className="hr__facts">
          <Fact label="Work email" value={p.email as string} /><Fact label="Phone" value={p.phone as string} /><Fact label="Personal email" value={p.personal_email as string} /><Fact label="Date of birth" value={day(p.date_of_birth as string)} />
          <Fact label="Address" value={p.address as string} /><Fact label="Emergency contact" value={p.emergency_name ? `${p.emergency_name}${p.emergency_relation ? ` (${p.emergency_relation})` : ''}` : null} /><Fact label="Emergency phone" value={p.emergency_phone as string} />
        </div>{p.bio && <p style={{ margin: '0 24px 20px', fontSize: 13.5, color: 'var(--mx-muted)' }}>{String(p.bio)}</p>}</div>}
      </div>
      <div className="mx__stack">
        <div className="mx__card"><div className="mx__cardHead"><h3>Reporting</h3></div>
          <ul className="mx__list">{d.reportingHistory.map((r, i) => <li key={i}><Avatar name={r.manager} /><div className="mx__main"><strong>{r.manager}</strong><small>{r.kind} · from {day(r.effective_from)}{r.effective_to ? ` to ${day(r.effective_to)}` : ''}</small></div>{!r.effective_to && <Pill s="active" text="Current" />}</li>)}{!d.reportingHistory.length && <li><small className="mx__tiny">No manager recorded.</small></li>}</ul>
          {d.reports.length > 0 && <><div className="mx__cardHead" style={{ paddingTop: 0 }}><h3 style={{ fontSize: 14 }}>Direct reports</h3></div><ul className="mx__list">{d.reports.map((r) => <li key={r.id}><Avatar name={r.name} /><div className="mx__main"><strong>{r.name}</strong><small>{r.position_title ?? ''}</small></div></li>)}</ul></>}
        </div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Certifications</h3>{hr && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({}); setSheet('cert'); }}>+ Add</button>}</div>
          <ul className="mx__list">{d.certifications.map((c) => <li key={c.id}><div className="mx__date"><strong>{new Date(`${c.expires_on}T00:00:00`).getDate()}</strong><small>{new Date(`${c.expires_on}T00:00:00`).toLocaleDateString([], { month: 'short' })}</small></div><div className="mx__main"><strong>{c.name}</strong><small>expires {day(c.expires_on)}</small></div><Pill s={c.expires_on < todayIso ? 'rejected' : 'active'} text={c.expires_on < todayIso ? 'Expired' : 'Valid'} /></li>)}{!d.certifications.length && <li><small className="mx__tiny">None recorded.</small></li>}</ul></div>
        {d.cases.length > 0 && <div className="mx__card"><div className="mx__cardHead"><h3>Cases</h3></div><ul className="mx__list">{d.cases.map((c) => <li key={c.id}><div className="mx__main"><strong>{KIND[c.kind] ?? c.kind}</strong><small>{c.effective_date ? day(c.effective_date) : day(c.created_at)}</small></div><Pill s={c.status} /></li>)}</ul></div>}
      </div>
    </div>}

    {tab === 'timeline' && <div className="mx__card"><div className="mx__cardHead"><h3>Timeline</h3><small>everything on the record, newest first</small></div>
      <ul className="hr__timeline">{d.timeline.map((t, i) => <li key={i}><span className="hr__tlDate">{day(t.on)}</span><span className={`hr__tlDot k-${t.kind}`} /><div className="hr__tlBody"><strong><span className="hr__tlKind">{t.kind}</span>{t.title}</strong>{(t.detail || t.by) && <small>{t.detail ?? ''}{t.by ? ` · ${t.by}` : ''}</small>}</div></li>)}</ul>
      {!d.timeline.length && <EmptyState icon="calendar" title="Nothing yet" text="Joining, reporting changes, leave, documents, files and notes all land here." />}</div>}

    {tab === 'leave' && <LeaveLedger employeeId={eid} year={d.leave.year} hr={hr} onAdjust={hr ? () => { setForm({ year: String(d.leave.year), type: d.leave.balances[0]?.key ?? '' }); setSheet('adjust'); } : undefined} />}

    {tab === 'files' && <div className="mx__card"><div className="mx__cardHead"><h3>Files</h3>{hr && <button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ category: 'contract' }); setFile(null); setCanSee(false); setSheet('file'); }}>+ Upload</button>}</div>
      <div className="hr__files">{d.files.map((x) => <div key={x.id} className="hr__file"><span className="hr__fileIcon">{x.content_type.includes('pdf') ? 'PDF' : x.content_type.includes('word') ? 'DOC' : 'IMG'}</span>
        <div className="mx__main"><strong>{x.title} <Pill s="draft" text={x.category} />{x.scan_status === 'quarantined' && <Pill s="quarantined" text="Failed scan" />}</strong><small>{x.filename} · {(x.byte_size / 1024).toFixed(0)} KB · {day(x.created_at)}{x.uploaded_by ? ` · ${x.uploaded_by}` : ''}{hr ? ` · ${x.employee_can_see ? 'visible to them' : 'HR only'}` : ''}</small></div>
        <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy === x.id} onClick={() => void act(x.id, () => link(`/api/hr/files/${x.id}/link`))}>Open</button>
        {hr && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => run(x.id, async () => { await postJson(`/api/hr/files/${x.id}/visibility`, { employeeCanSee: !x.employee_can_see }); return x.employee_can_see ? 'Now HR only.' : 'Now visible to them.'; })}>{x.employee_can_see ? 'Hide from them' : 'Share with them'}</button>}
        {hr && admin && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => run(x.id, async () => { await postJson(`/api/hr/files/${x.id}/remove`, {}); return 'File removed.'; })}>Remove</button>}
      </div>)}{!d.files.length && <EmptyState icon="register" title="No files" text={hr ? 'Contracts, identity checks, certificates and letters live here. Choose whether the person can see each one.' : 'Files HR shares with you appear here.'} action={hr ? { label: 'Upload a file', onClick: () => { setForm({ category: 'contract' }); setSheet('file'); } } : undefined} />}</div></div>}

    {tab === 'documents' && <div className="mx__card"><div className="mx__cardHead"><h3>Documents</h3><small>policies and agreements sent to {self ? 'you' : 'them'}</small></div>
      <ul className="mx__list">{d.documents.map((x) => <li key={x.id}><span className={`mx__avatar ${x.status === 'acknowledged' ? 'mx__avatar--on' : ''}`} style={{ marginLeft: 0 }}>{x.kind === 'agreement' ? '✍' : '✓'}</span><div className="mx__main"><strong>{x.title}</strong><small>Version {x.version}{x.due_date ? ` · by ${day(x.due_date)}` : ''}{x.acknowledged_at ? ` · done ${day(x.acknowledged_at)}` : ''}</small></div><Pill s={x.status} />{x.has_file && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(x.id, () => link(`/api/hr/documents/${x.document_id}/link`))}>Open</button>}</li>)}{!d.documents.length && empty('register', 'No documents', 'Documents HR sends to confirm or agree to appear here.')}</ul></div>}

    {tab === 'pay' && (() => {
      const lines = pay.data ?? []; const live = lines.filter((x) => !x.ended_on || x.ended_on >= todayIso);
      const base = live.find((x) => x.kind === 'base'); const comps = live.filter((x) => x.kind !== 'base');
      const ccy = base?.currency ?? (cur || 'USD');
      const perYear = (x: PayLine) => Number(x.amount) * ({ year: 1, month: 12, week: 52, day: 260, hour: 2080, once: 0 }[x.period] ?? 1) * (x.kind === 'deduction' ? -1 : 1);
      const total = live.filter((x) => x.currency === ccy && x.period !== 'once').reduce((t, x) => t + perYear(x), 0);
      return <div className="mx__card"><div className="mx__cardHead"><h3>Pay</h3><div className="mx__bar"><small>HR admins only · viewing is recorded</small><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({ kind: 'allowance', currency: ccy, period: 'month', effectiveFrom: todayIso }); setSheet('pay'); }}>+ Component</button><button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ kind: 'base', currency: ccy, period: base?.period ?? 'year', effectiveFrom: todayIso }); setSheet('pay'); }}>{base ? 'Change base pay' : '+ Set base pay'}</button></div></div>
        {base && <div className="hr__ledger"><div style={{ background: 'var(--mod-tint, #f4edf8)' }}><span>Base pay</span><strong>{money(base.amount, base.currency)}</strong><small className="mx__tiny">per {base.period}</small></div>{comps.map((x) => <div key={x.id}><span>{x.label}</span><strong>{x.kind === 'deduction' ? '−' : ''}{money(x.amount, x.currency)}</strong><small className="mx__tiny">{x.period === 'once' ? 'one-off' : `per ${x.period}`}{x.ended_on ? ` · until ${day(x.ended_on)}` : ''}</small></div>)}<div><span>Package a year</span><strong>{money(total, ccy)}</strong><small className="mx__tiny">base plus recurring components</small></div></div>}
        <ul className="mx__list">{lines.map((x) => <li key={x.id} className={x.ended_on && x.ended_on < todayIso ? 'is-done' : ''}><div className="mx__date"><strong>{new Date(`${x.effective_from}T00:00:00`).getDate()}</strong><small>{new Date(`${x.effective_from}T00:00:00`).toLocaleDateString([], { month: 'short' })}</small></div><div className="mx__main"><strong>{x.label} · {money(x.amount, x.currency)} <small style={{ fontWeight: 500 }}>{x.period === 'once' ? 'one-off' : `a ${x.period}`}</small></strong><small>{x.kind} · from {day(x.effective_from)}{x.ended_on ? ` to ${day(x.ended_on)}` : ''}{x.reason ? ` · ${x.reason}` : ''}{x.entered_by ? ` · ${x.entered_by}` : ''}</small></div><Pill s={x.ended_on && x.ended_on < todayIso ? 'left' : x === base ? 'active' : 'draft'} text={x.ended_on && x.ended_on < todayIso ? 'Ended' : x === base ? 'Current base' : x.kind} />{x.kind !== 'base' && !x.ended_on && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => run(String(x.id), async () => { await postJson(`/api/hr/employees/${eid}/pay`, { endId: x.id, amount: x.amount, effectiveFrom: todayIso, endedOn: todayIso }); return `${x.label} ended today.`; })}>End</button>}</li>)}{pay.data && !pay.data.length && empty('check', 'No pay recorded', `Set base pay in ${ccy}, then add allowances, bonuses or deductions. Each line keeps its date and reason.`)}</ul></div>; })()}

    {tab === 'notes' && <div className="mx__card"><div className="mx__cardHead"><h3>Notes</h3><button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ kind: 'note', visibility: hr ? 'hr' : 'manager' }); setSheet('note'); }}>+ Add</button></div>
      <ul className="mx__list">{d.events.map((e) => <li key={e.id}><span className={`hr__tlDot k-${e.kind}`} style={{ margin: '0 4px' }} /><div className="mx__main"><strong>{e.title}</strong><small>{e.kind} · {day(e.occurred_on)}{e.by ? ` · ${e.by}` : ''}{e.detail ? ` · ${e.detail}` : ''}</small></div><Pill s={e.visibility} text={{ hr: 'HR only', manager: 'Managers', employee: 'Shared with them' }[e.visibility]} /></li>)}{!d.events.length && empty('inbox', 'No notes', 'Recognition, training, warnings and milestones, each with who may see it.')}</ul></div>}

    {sheet === 'edit' && <Sheet eyebrow={name} title={self ? 'My details' : 'Edit the record'} subtitle={self ? 'Your contact and emergency details. HR keeps the employment details.' : 'Name, status and payroll reference keep their own paths; everything else is here.'} onClose={() => setSheet(null)}
      footer={<><small className="mx__tiny">Every change is logged on the timeline.</small><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'profile'} onClick={() => run('profile', async () => { const body: Record<string, string> = {}; const keys = self ? ['phone', 'personalEmail', 'address', 'emergencyName', 'emergencyPhone', 'emergencyRelation', 'bio'] : Object.keys(f); for (const k of keys) body[k] = f[k] ?? ''; await postJson(`/api/hr/employees/${eid}/profile`, body); return 'Saved.'; })}>Save</button></>}>
      {hr && <SheetSection title="Employment" hint="Type, grade, location and dates.">
        <F label="Type" wide><Choice value={v('employmentType')} onChange={(x) => set('employmentType', x)} options={[['employee', 'Employee'], ['contractor', 'Contractor'], ['intern', 'Intern']]} /></F>
        <F label="Grade"><input value={v('grade')} onChange={(e) => set('grade', e.target.value)} placeholder="e.g. G7, Senior" /></F>
        <F label="Location"><input value={v('location')} onChange={(e) => set('location', e.target.value)} /></F>
        <F label="Start date"><input type="date" value={v('startDate')} onChange={(e) => set('startDate', e.target.value)} /></F>
        <F label="Probation ends"><input type="date" value={v('probationEnd')} onChange={(e) => set('probationEnd', e.target.value)} /></F>
        <F label="Work pattern" hint="e.g. Mon–Fri 9 to 5, or 3 days a week"><input value={v('workPattern')} onChange={(e) => set('workPattern', e.target.value)} /></F>
        <F label="External reference" hint="the id in payroll or another system"><input value={v('externalRef')} onChange={(e) => set('externalRef', e.target.value)} /></F>
      </SheetSection>}
      <SheetSection title="Contact" hint="Where to reach them outside work.">
        <F label="Phone"><input value={v('phone')} onChange={(e) => set('phone', e.target.value)} /></F>
        <F label="Personal email"><input type="email" value={v('personalEmail')} onChange={(e) => set('personalEmail', e.target.value)} /></F>
        {hr && <F label="Date of birth"><input type="date" value={v('dateOfBirth')} onChange={(e) => set('dateOfBirth', e.target.value)} /></F>}
        <F label="Home address" wide><textarea rows={2} value={v('address')} onChange={(e) => set('address', e.target.value)} /></F>
      </SheetSection>
      <SheetSection title="Emergency contact" hint="Who to call, and how they are related.">
        <F label="Name"><input value={v('emergencyName')} onChange={(e) => set('emergencyName', e.target.value)} /></F>
        <F label="Relationship"><input value={v('emergencyRelation')} onChange={(e) => set('emergencyRelation', e.target.value)} placeholder="Spouse, parent, friend…" /></F>
        <F label="Phone" wide><input value={v('emergencyPhone')} onChange={(e) => set('emergencyPhone', e.target.value)} /></F>
      </SheetSection>
      <SheetSection title="About" hint="A line or two, shown on the record."><F label="Bio" wide><textarea rows={3} value={v('bio')} onChange={(e) => set('bio', e.target.value)} /></F></SheetSection>
    </Sheet>}

    {sheet === 'note' && <Sheet eyebrow={name} title="Add to the record" subtitle="A note, recognition, training, milestone or warning, with who may see it." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'note' || !v('title')} onClick={() => run('note', async () => { await postJson(`/api/hr/employees/${eid}/events`, { kind: v('kind'), title: v('title'), detail: v('detail'), visibility: v('visibility'), occurredOn: v('on') || undefined }); return 'Added to the record.'; })}>Add</button></>}>
      <SheetSection title="What happened">
        <F label="Kind" wide><Choice value={v('kind')} onChange={(x) => set('kind', x)} options={[['note', 'Note'], ['recognition', 'Recognition'], ['training', 'Training'], ['milestone', 'Milestone'], ...(hr ? [['warning', 'Warning'] as [string, string]] : [])]} wide /></F>
        <F label="Title" wide><input autoFocus value={v('title')} onChange={(e) => set('title', e.target.value)} /></F>
        <F label="Detail" wide><textarea rows={4} value={v('detail')} onChange={(e) => set('detail', e.target.value)} /></F>
        <F label="Date"><input type="date" value={v('on')} onChange={(e) => set('on', e.target.value)} /></F>
      </SheetSection>
      <SheetSection title="Who may see it"><F label="Visibility" wide><Choice value={v('visibility')} onChange={(x) => set('visibility', x)} options={[...(hr ? [['hr', 'HR only'] as [string, string]] : []), ['manager', 'Managers and HR'], ['employee', 'The person too']]} /></F></SheetSection>
    </Sheet>}

    {sheet === 'file' && <Sheet eyebrow={name} title="Upload a file" subtitle="Kept in the workspace file store and checked for malware before anyone opens it." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'file' || !file} onClick={() => run('file', async () => { const base64 = await readFileAsBase64(file!); await postJson(`/api/hr/employees/${eid}/files`, { category: v('category'), title: v('title') || undefined, filename: file!.name, base64, employeeCanSee: canSee }); return 'Uploaded. It opens once the malware check has passed.'; })}>Upload</button></>}>
      <SheetSection title="File"><div className="mx__field--wide"><FilePick file={file} onFile={setFile} /></div>
        <F label="Title" hint="defaults to the file name"><input value={v('title')} onChange={(e) => set('title', e.target.value)} /></F>
        <F label="Category"><select value={v('category')} onChange={(e) => set('category', e.target.value)}>{['contract', 'identity', 'certificate', 'letter', 'payslip', 'other'].map((c) => <option key={c} value={c}>{c}</option>)}</select></F></SheetSection>
      <SheetSection title="Who may see it"><F label="Visibility" wide><Choice value={canSee ? 'yes' : 'no'} onChange={(x) => setCanSee(x === 'yes')} options={[['no', 'HR only'], ['yes', 'The person can open it']]} /></F></SheetSection>
    </Sheet>}

    {sheet === 'pay' && <Sheet eyebrow={name} title={v('kind') === 'base' ? 'Base pay' : 'Pay component'} subtitle={v('kind') === 'base' ? 'Salary or a rate. A new line from a date; earlier lines stay in the history.' : 'An allowance, bonus or deduction on top of base pay, with its own basis and dates.'} onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'pay' || !v('amount') || (v('kind') !== 'base' && !v('label'))} onClick={() => run('pay', async () => { const r = await postJson<{ queuedForReconciliation: boolean }>(`/api/hr/employees/${eid}/pay`, { kind: v('kind'), label: v('label') || undefined, amount: v('amount'), currency: v('currency') || undefined, period: v('period'), effectiveFrom: v('effectiveFrom'), endedOn: v('endedOn') || undefined, reason: v('reason') }); return r.queuedForReconciliation ? 'Pay is owned by another system: a reconciliation task was raised instead.' : 'Pay recorded.'; })}>Record</button></>}>
      <SheetSection title="What" hint="Base pay is the salary or rate. Components sit on top of it.">
        <F label="Kind" wide><Choice value={v('kind')} onChange={(x) => set('kind', x)} options={[['base', 'Base pay'], ['allowance', 'Allowance'], ['bonus', 'Bonus'], ['deduction', 'Deduction']]} /></F>
        {v('kind') !== 'base' && <F label="Name" wide><input autoFocus value={v('label')} onChange={(e) => set('label', e.target.value)} placeholder={v('kind') === 'allowance' ? 'Housing allowance, transport, phone…' : v('kind') === 'bonus' ? 'Performance bonus, sign-on…' : 'Pension contribution, loan repayment…'} /></F>}
        <F label="Basis" wide><Choice value={v('period')} onChange={(x) => set('period', x)} options={v('kind') === 'base' ? [['year', 'Salary per year'], ['month', 'Salary per month'], ['week', 'Per week'], ['day', 'Per day'], ['hour', 'Per hour']] : [['month', 'Per month'], ['year', 'Per year'], ['week', 'Per week'], ['day', 'Per day'], ['hour', 'Per hour'], ['once', 'One-off']]} wide /></F>
      </SheetSection>
      <SheetSection title="Amount">
        <F label="Amount"><input inputMode="decimal" autoFocus={v('kind') === 'base'} value={v('amount')} onChange={(e) => set('amount', e.target.value)} /></F>
        <F label="Currency" hint={branch ? `${branch.name} pays in ${branch.currency}` : 'the workspace default if empty'}><input list="hr-currencies" value={v('currency')} onChange={(e) => set('currency', e.target.value.toUpperCase())} placeholder={cur || 'USD'} /><datalist id="hr-currencies">{CURRENCIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</datalist></F>
      </SheetSection>
      <SheetSection title="From when, and why">
        <F label="Effective from"><input type="date" value={v('effectiveFrom')} onChange={(e) => set('effectiveFrom', e.target.value)} /></F>
        {v('kind') !== 'base' && <F label="Until" hint="leave empty if it continues"><input type="date" value={v('endedOn')} onChange={(e) => set('endedOn', e.target.value)} /></F>}
        <F label="Reason" wide><input value={v('reason')} onChange={(e) => set('reason', e.target.value)} placeholder="Offer letter, annual review, promotion…" /></F>
      </SheetSection>
    </Sheet>}

    {sheet === 'adjust' && <Sheet eyebrow={name} title="Adjust leave" subtitle="Days in lieu, an agreed carry-over, or a deduction. The reason is kept on the ledger." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'adjust' || !v('days') || !v('reason')} onClick={() => run('adjust', async () => { const r = await postJson<{ queuedForReconciliation: boolean }>('/api/hr/leave/adjust', { employeeId: eid, type: v('type'), year: v('year'), days: v('days'), reason: v('reason') }); return r.queuedForReconciliation ? 'Balances are owned by another system: a reconciliation task was raised instead.' : 'Balance adjusted.'; })}>Apply</button></>}>
      <SheetSection title="Adjustment">
        <F label="Leave type" wide><Choice value={v('type')} onChange={(x) => set('type', x)} options={d.leave.balances.filter((b) => !b.unlimited).map((b) => [b.key, b.name] as [string, string])} wide /></F>
        <F label="Days" hint="negative to deduct, e.g. -1"><input inputMode="decimal" autoFocus value={v('days')} onChange={(e) => set('days', e.target.value)} /></F>
        <F label="Year"><input inputMode="numeric" value={v('year')} onChange={(e) => set('year', e.target.value)} /></F>
        <F label="Reason" wide><input value={v('reason')} onChange={(e) => set('reason', e.target.value)} placeholder="Worked the public holiday" /></F>
      </SheetSection>
    </Sheet>}

    {sheet === 'branch' && <Sheet eyebrow={name} title="Move to a branch" subtitle="Leave types, holidays, the working week and the pay currency follow the branch from now on." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'branch'} onClick={() => run('branch', async () => { await postJson(`/api/hr/employees/${eid}/branch`, { branchId: v('branchId') || null }); return 'Moved.'; })}>Move</button></>}>
      <SheetSection title="Branch"><F label="Branch" wide><Choice value={v('branchId')} onChange={(x) => set('branchId', x)} options={[['', 'No branch'], ...branches.filter((b) => b.active).map((b) => [b.id, `${flag(b.country)} ${b.name}`] as [string, string])]} wide /></F></SheetSection>
    </Sheet>}

    {sheet === 'cert' && <Sheet eyebrow={name} title="Add a certification" subtitle="Expiries show up in Coming up before they lapse." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'cert' || !v('name') || !v('expires')} onClick={() => run('cert', async () => { await postJson(`/api/hr/employees/${eid}/certifications`, { name: v('name'), expiresOn: v('expires') }); return 'Certification added.'; })}>Add</button></>}>
      <SheetSection title="Certification"><F label="Name" wide><input autoFocus value={v('name')} onChange={(e) => set('name', e.target.value)} placeholder="First aid, forklift licence, CPA…" /></F><F label="Expires on"><input type="date" value={v('expires')} onChange={(e) => set('expires', e.target.value)} /></F></SheetSection>
    </Sheet>}
  </>;
}

/** The ledger behind a balance, for the person or HR. */
function LeaveLedger({ employeeId, year, hr, onAdjust }: { employeeId: string | null; year: number; hr: boolean; onAdjust?: () => void }) {
  const [y, setY] = useState(year);
  const ledger = useFeed<{ name: string; year: number; balances: Balance[]; adjustments: { id: string; type: string; days: string; reason: string; created_at: string; by: string | null }[]; requests: (LeaveReq & { type_name?: string })[]; balanceOwner: string }>(`/api/hr/leave/ledger?year=${y}${employeeId ? `&employee=${employeeId}` : ''}`);
  const l = ledger.data;
  return <div className="mx__card"><div className="mx__cardHead"><h3>Leave ledger</h3><div className="mx__bar"><div className="mx__segs">{[y - 1, y, y + 1].map((n) => <button key={n} type="button" className={`mx__seg ${n === y ? 'is-on' : ''}`} onClick={() => setY(n)}>{n}</button>)}</div>{hr && onAdjust && <button type="button" className="mx__btn mx__btn--sm" onClick={onAdjust}>Adjust</button>}</div></div>
    {ledger.error && <p className="mx__notice mx__notice--err" style={{ margin: '0 20px 12px' }}>{ledger.error}</p>}
    {l && <>
      {l.balances.map((b) => <div key={b.key}><div className="mx__cardHead" style={{ paddingTop: 4 }}><h3 style={{ fontSize: 14 }}>{b.name}</h3><small>{b.unlimited ? 'no limit' : b.accrualMode === 'monthly' ? 'accrues monthly' : 'given up front'}{l.balanceOwner !== 'patform' ? ` · balances kept in ${l.balanceOwner}` : ''}</small></div>
        {!b.unlimited && <div className="hr__ledger"><div><span>Entitled</span><strong>{b.entitled}</strong></div>{b.accrualMode === 'monthly' && <div><span>Accrued so far</span><strong>{b.accrued}</strong></div>}<div><span>Carried over</span><strong>{b.carriedOver}</strong></div><div><span>Adjusted</span><strong>{b.adjusted > 0 ? `+${b.adjusted}` : b.adjusted}</strong></div><div><span>Taken</span><strong>{b.taken}</strong></div><div><span>Pending</span><strong>{b.pending}</strong></div><div style={{ background: 'var(--mod-tint, #f4edf8)' }}><span>Left</span><strong>{b.left}</strong></div></div>}
        {b.unlimited && <div className="hr__ledger"><div><span>Taken</span><strong>{b.taken}</strong></div><div><span>Pending</span><strong>{b.pending}</strong></div></div>}
      </div>)}
      {l.adjustments.length > 0 && <ul className="mx__list">{l.adjustments.map((a) => <li key={a.id}><span className="mx__avatar" style={{ marginLeft: 0, fontSize: 11 }}>{Number(a.days) > 0 ? '+' : '−'}</span><div className="mx__main"><strong>{Number(a.days) > 0 ? '+' : ''}{Number(a.days)} day{Math.abs(Number(a.days)) === 1 ? '' : 's'} · {a.type}</strong><small>{a.reason} · {day(a.created_at)}{a.by ? ` · ${a.by}` : ''}</small></div></li>)}</ul>}
      <ul className="mx__list">{l.requests.map((r) => <li key={r.id}><div className="mx__date"><strong>{new Date(`${r.start_date}T00:00:00`).getDate()}</strong><small>{new Date(`${r.start_date}T00:00:00`).toLocaleDateString([], { month: 'short' })}</small></div><div className="mx__main"><strong>{r.type_name ?? r.type} · {Number(r.days)} day{Number(r.days) === 1 ? '' : 's'}</strong><small>{day(r.start_date)} to {day(r.end_date)}{r.decision_note ? ` · ${r.decision_note}` : ''}</small></div><Pill s={r.status} /></li>)}{!l.requests.length && empty('calendar', `No leave in ${y}`, 'Requests and their decisions are listed here.')}</ul>
    </>}
  </div>;
}

/** Who is away this month. */
function LeaveCalendar({ onOpen }: { onOpen?: (employeeId: string) => void }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const cal = useFeed<Calendar>(`/api/hr/leave/calendar?month=${month}`);
  const c = cal.data;
  const days = useMemo(() => { if (!c) return []; const out: string[] = []; for (let d = new Date(`${c.first}T00:00:00Z`); d <= new Date(`${c.last}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; }, [c]);
  const people = useMemo(() => { if (!c) return []; const m = new Map<string, { name: string; unit: string | null; branch: string | null; spans: Calendar['away'] }>(); for (const a of c.away) { const p = m.get(a.employee_id) ?? { name: a.name, unit: a.unit, branch: a.branch, spans: [] }; p.spans.push(a); m.set(a.employee_id, p); } return [...m.entries()]; }, [c]);
  const shift = (n: number) => { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y!, m! - 1 + n, 1)); setMonth(d.toISOString().slice(0, 7)); };
  const today = new Date().toISOString().slice(0, 10);
  const hol = new Map((c?.holidays ?? []).map((h) => [h.day, h]));
  return <div className="mx__card"><div className="mx__cardHead"><h3>Who is away</h3><div className="mx__bar"><small>{c?.scope === 'workspace' ? 'whole workspace' : 'your team'}</small><div className="mx__segs"><button type="button" className="mx__seg" onClick={() => shift(-1)}>‹</button><button type="button" className="mx__seg is-on">{new Date(`${month}-01T00:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' })}</button><button type="button" className="mx__seg" onClick={() => shift(1)}>›</button></div></div></div>
    {cal.error && <p className="mx__notice mx__notice--err" style={{ margin: '0 20px 12px' }}>{cal.error}</p>}
    {c && <div className="hr__cal"><div className="hr__calGrid" style={{ ['--days' as string]: days.length }}>
      <div />{days.map((d) => { const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); return <div key={d} className={`hr__calHead ${wd === 0 || wd === 6 ? 'is-off' : ''} ${hol.has(d) ? 'is-hol' : ''} ${d === today ? 'is-today' : ''}`} title={hol.get(d)?.name}>{['S', 'M', 'T', 'W', 'T', 'F', 'S'][wd]}<br />{Number(d.slice(8))}</div>; })}
      {people.map(([id, p]) => <div key={id} style={{ display: 'contents' }}>
        <div className="hr__calName"><Avatar name={p.name} /><div className="mx__main"><strong style={{ fontSize: 13 }}>{onOpen ? <button type="button" className="mx__link" onClick={() => onOpen(id)}>{p.name}</button> : p.name}</strong><small>{[p.unit, p.branch].filter(Boolean).join(' · ')}</small></div></div>
        {days.map((d) => { const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); const span = p.spans.find((s) => s.start_date <= d && s.end_date >= d); return <div key={d} className={`hr__calCell ${wd === 0 || wd === 6 ? 'is-off' : ''} ${hol.has(d) ? 'is-hol' : ''} ${span ? (span.status === 'approved' ? 'is-away' : 'is-pending') : ''}`} title={span ? `${span.type} · ${span.status}` : hol.get(d)?.name} />; })}
      </div>)}
    </div>
      {!people.length && <EmptyState icon="calendar" title="Nobody away this month" text="Approved and pending leave shows here as it is booked." />}
      <div className="hr__calLegend"><span><i style={{ background: 'var(--mod)' }} />Approved</span><span><i style={{ background: 'repeating-linear-gradient(135deg, var(--mod-tint) 0 4px, var(--mod) 4px 6px)' }} />Pending</span><span><i style={{ background: '#fdeceb' }} />Public holiday{c.holidays.length ? `: ${c.holidays.map((h) => `${day(h.day)} ${h.name}${h.branch ? ` (${h.branch})` : ''}`).join(', ')}` : ''}</span></div>
    </div>}
  </div>;
}

/** The reporting tree. */
function OrgChart({ onOpen }: { onOpen: (employeeId: string) => void }) {
  const org = useFeed<{ tree: OrgNode[]; units: { id: string; name: string; parent_id: string | null; members: number }[]; people: number; canEdit: boolean }>('/api/hr/org');
  const count = (n: OrgNode): number => n.reports.reduce((s, c) => s + 1 + count(c), 0);
  const Node = ({ n }: { n: OrgNode }) => <li>
    <button type="button" className="hr__node" onClick={() => n.status && onOpen(n.id)} title={n.email}><Avatar name={n.name} /><div className="mx__main"><strong>{n.name}</strong><small>{[n.title, n.unit, n.branch].filter(Boolean).join(' · ') || n.email}{n.status === 'pre_hire' ? ' · joining' : ''}</small></div>{n.reports.length > 0 && <span className="hr__count">{count(n)}</span>}</button>
    {n.reports.length > 0 && <ul>{n.reports.map((c) => <Node key={c.actorId ?? c.id} n={c} />)}</ul>}
  </li>;
  return <div className="mx__card"><div className="mx__cardHead"><h3>Organisation</h3><small>{org.data ? `${org.data.people} people · ${org.data.units.length} unit${org.data.units.length === 1 ? '' : 's'}` : ''}</small></div>
    {org.error && <p className="mx__notice mx__notice--err" style={{ margin: '0 20px 12px' }}>{org.error}</p>}
    {org.data && (org.data.tree.length ? <div className="hr__org"><ul className="hr__tree">{org.data.tree.map((n) => <Node key={n.actorId ?? n.id} n={n} />)}</ul></div> : <EmptyState icon="people" title="No people yet" text="Members and their managers appear here as a tree." />)}
  </div>;
}

export function HRView({ onChanged, shell }: { onChanged?: () => void; shell?: ModuleShell }) {
  const summary = useFeed<Summary>('/api/hr/summary');
  const s = summary.data;
  const hr = s?.hr === true;
  const [tab, setTab] = useState<Tab>('tasks');
  const [person, setPerson] = useState<string | null>(null);
  const pickTab = (id: Tab) => { setTab(id); shell?.onSection?.(id); setPerson(null); };
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
  const docList = useFeed<DocRow[]>(hr ? '/api/hr/documents' : null);
  const types = useFeed<LeaveType[]>(s && s.role !== 'pre_hire' ? '/api/hr/leave/types' : null);
  const holidays = useFeed<Holiday[]>(s && s.role !== 'pre_hire' ? '/api/hr/leave/holidays' : null);
  const branches = useFeed<Branches>(s ? '/api/hr/branches' : null);
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [sheet, setSheet] = useState<null | 'onboarding' | 'offboarding' | 'transfer' | 'urgent' | 'probation' | 'leave' | 'branch' | 'defaults' | 'leaveType' | 'holiday' | 'document' | 'docFile' | 'team' | 'probationExtend'>(null);
  const [file, setFile] = useState<File | null>(null);
  const [week, setWeek] = useState<number[]>([1, 2, 3, 4, 5]);
  const [asking, setAsking] = useState<{ id: string; label: string; run: (answer: string) => Promise<string> } | null>(null);
  const [answer, setAnswer] = useState('');
  const [openCase, setOpenCase] = useState<string | null>(null);
  const [caseFilter, setCaseFilter] = useState<string>('all');
  useEffect(() => {
    if (shell?.section && shell.section !== tab) { setTab(shell.section as Tab); setNote(null); setSheet(null); setForm({}); setAsking(null); setPerson(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell?.section]);
  const f = (k: string) => form[k] ?? '';
  const setF = (k: string, v: string) => setForm((x) => ({ ...x, [k]: v }));

  const reloadAll = async () => { await Promise.all([summary.reload(), tasks.reload(), leave.reload(), docs.reload(), approve.reload(), cases.reload(), people.reload(), hiring.reload(), soon.reload(), recon.reload(), teams.reload(), docList.reload(), holidays.reload(), types.reload(), branches.reload()]); onChanged?.(); };
  const act: Act = async (id, work) => {
    setBusy(id); setNote(null);
    try { const message = await work(); await reloadAll(); setNote({ text: message }); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } finally { setBusy(null); }
  };
  const done = (id: string, work: () => Promise<string>) => void act(id, async () => { const m = await work(); setSheet(null); setForm({}); setFile(null); return m; });
  const ask: Ask = (id, label, run) => { setAsking({ id, label, run }); setAnswer(''); };

  if (summary.error) return <div className="mx"><div className="mx__card"><EmptyState icon="people" title="HR is not available" text={summary.error} /></div></div>;
  if (!s) return <div className="mx"><div className="mx__card"><div className="mx__empty">Loading…</div></div></div>;

  const pre = s.role === 'pre_hire';
  const br = branches.data?.branches ?? [];
  const activeBranches = br.filter((b) => b.active);
  const tabs: { id: Tab; name: string; count: number | null }[] = [
    { id: 'tasks', name: pre ? 'Before you start' : 'My tasks', count: s.myTasks || null },
    ...(!pre ? [{ id: 'leave' as const, name: 'My leave', count: null }, { id: 'calendar' as const, name: 'Who is away', count: null }] : []),
    { id: 'documents', name: 'My documents', count: (docs.data ?? []).filter((d) => d.status === 'sent').length || null },
    { id: 'profile', name: 'My profile', count: null },
    ...(!pre && (s.leaveToApprove > 0 || hr) ? [{ id: 'approve' as const, name: 'Leave to approve', count: s.leaveToApprove || null }] : []),
    ...(hr || s.teams.length ? [{ id: 'cases' as const, name: hr ? 'Cases' : 'Team tasks', count: hr ? ((s.onboarding ?? 0) + (s.offboarding ?? 0) + (s.changes ?? 0)) || null : null }] : []),
    ...(hr ? [{ id: 'people' as const, name: 'People', count: people.data?.length ?? null }] : []),
    ...(!pre ? [{ id: 'org' as const, name: 'Org chart', count: null }] : []),
    ...(hr ? [
      { id: 'hiring' as const, name: 'Hiring', count: s.hiring || null },
      { id: 'upcoming' as const, name: 'Coming up', count: soon.data?.length || null },
      { id: 'reconcile' as const, name: 'To reconcile', count: s.reconciliation || null },
      { id: 'setup' as const, name: 'Setup', count: null },
    ] : []),
  ];
  const memberOptions = (members.data ?? []).filter((m) => m.active);
  const leaveLeft = (leave.data?.balances ?? []).find((b) => !b.unlimited);
  const openPerson = (id: string) => { setPerson(id); if (hr) { setTab('people'); shell?.onSection?.('people'); } };
  const openLink = async (url: string) => { const r = await get<{ url: string }>(url); window.open(r.url, '_blank', 'noopener'); return 'Opened in a new tab.'; };

  const taskRow = (t: MyTask) => <li key={t.id}>
    <span className={`mx__avatar ${t.blockedBy.length ? '' : 'mx__avatar--on'}`} style={{ marginLeft: 0 }}>{t.critical ? '!' : '✓'}</span>
    <div className="mx__main"><strong>{t.title}</strong><small>{KIND[t.kind] ?? t.kind} · {t.employee}{t.effectiveDate ? ` · ${day(t.effectiveDate)}` : ''}{t.blockedBy.length ? ` · waiting: ${t.blockedBy.join(', ')}` : ''}</small></div>
    {t.blockedBy.length ? <Pill s="requested" text="Waiting" /> : <button type="button" className="mx__btn mx__btn--sm" disabled={busy === t.id} onClick={() => ask(t.id, `Note for "${t.title}" (optional)`, async (n) => { await postJson(`/api/hr/tasks/${t.id}/complete`, { note: n }); return `"${t.title}" done.`; })}>Mark done</button>}
  </li>;

  const caseCard = (c: Case) => { const open = openCase === c.id; return <div key={c.id} className={`mx__card hr__case ${open ? 'is-open' : ''}`}>
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
        <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => openPerson(c.employee.id)}>Open record</button>
        <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(c.id, 'Note (kept to HR)', async (b) => { await postJson(`/api/hr/cases/${c.id}/notes`, { body: b, category: 'general' }); return 'Note added.'; })}>Add HR note</button>
        <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(c.id, 'Note shared with the teams on this case', async (b) => { await postJson(`/api/hr/cases/${c.id}/notes`, { body: b, category: 'general', shared: true }); return 'Shared note added.'; })}>Add shared note</button>
        {c.kind === 'probation' && c.status === 'open' && <>
          <button type="button" className="mx__btn mx__btn--sm" onClick={() => ask(c.id, 'Why confirm?', async (r) => { await postJson(`/api/hr/cases/${c.id}/probation-decision`, { outcome: 'confirm', reason: r }); return 'Probation confirmed.'; })}>Confirm probation</button>
          <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({ caseId: c.id }); setSheet('probationExtend'); }}>Extend</button>
        </>}
      </div>}
    </>}
  </div>; };

  const caseList = (cases.data ?? []).filter((c) => caseFilter === 'all' || (caseFilter === 'open' ? c.status === 'open' : c.kind === caseFilter));
  const defaults = branches.data;
  const weekPicker = <div className="mx__segs">{WEEKDAYS.map(([n, label]) => <button key={n} type="button" className={`mx__seg ${week.includes(n) ? 'is-on' : ''}`} onClick={() => setWeek(week.includes(n) ? week.filter((d) => d !== n) : [...week, n].sort())}>{label}</button>)}</div>;
  const dayNames = (ds: number[]) => ds.map((d) => WEEKDAYS.find(([n]) => n === d)?.[1]).join(', ');

  return <div className="mx">
    <ShellSync sections={tabs} onSections={shell?.onSections} />
    {!shell && <div className="mx__segs mx__segs--wrap" style={{ marginBottom: 14 }}>{tabs.map((t) => <button key={t.id} type="button" className={`mx__seg ${tab === t.id ? 'is-on' : ''}`} onClick={() => pickTab(t.id)}>{t.name}{t.count ? ` · ${t.count}` : ''}</button>)}</div>}

    <section className="mx__band">
      <div className="mx__bandGrid">
        <div>
          <div className="mx__eyebrow">People &amp; HR</div>
          <h2 className="mx__bandTitle">{pre ? 'A few things before your first day' : hr ? (s.onboarding ? `${s.onboarding} joining` : s.leaveToApprove ? `${s.leaveToApprove} leave request${s.leaveToApprove === 1 ? '' : 's'} waiting` : 'People, leave and records') : s.myTasks ? `${s.myTasks} thing${s.myTasks === 1 ? '' : 's'} for you` : 'Your HR, in one place'}</h2>
          <p className="mx__bandSub">{pre ? 'Your tasks before day one. Everything else opens when you start.' : hr ? `${(people.data ?? []).filter((p) => p.status !== 'left').length} people${activeBranches.length ? ` across ${activeBranches.length} branch${activeBranches.length === 1 ? '' : 'es'}` : ''}. Pay and restricted cases stay with HR.` : 'Your tasks, leave, documents and profile.'}</p>
          <div className="mx__bandActions">
            {hr && <button type="button" className="mx__btn mx__btn--light" onClick={() => { setForm({ oType: 'employee', oBranch: activeBranches[0]?.id ?? '' }); setSheet('onboarding'); }}>+ New joiner</button>}
            {!pre && <button type="button" className={`mx__btn ${hr ? 'mx__btn--outline' : 'mx__btn--light'}`} onClick={() => { setForm({ lType: (leave.data?.balances ?? [])[0]?.key ?? '' }); setSheet('leave'); }}>Ask for leave</button>}
            {hr && <button type="button" className="mx__btn mx__btn--outline" onClick={() => pickTab('people')}>People</button>}
            {!hr && !pre && <button type="button" className="mx__btn mx__btn--outline" onClick={() => pickTab('profile')}>My profile</button>}
          </div>
        </div>
        {hr ? <>
          <div className={`mx__kpi ${s.onboarding ? 'mx__kpi--live' : ''}`}><span>Joining</span><strong>{s.onboarding ?? 0}</strong><small>{s.hiring ?? 0} open hiring request{s.hiring === 1 ? '' : 's'}</small></div>
          <div className="mx__kpi"><span>Leaving &amp; moving</span><strong>{(s.offboarding ?? 0) + (s.changes ?? 0)}</strong><small>{s.offboarding ?? 0} leaving · {s.changes ?? 0} transfers and reviews</small></div>
          <div className="mx__kpi"><span>Waiting on you</span><strong>{s.myTasks + s.leaveToApprove + (s.reconciliation ?? 0)}</strong><small>{s.myTasks} tasks · {s.leaveToApprove} leave · {s.reconciliation ?? 0} to reconcile</small></div>
        </> : <>
          <div className={`mx__kpi ${s.myTasks ? 'mx__kpi--live' : ''}`}><span>My tasks</span><strong>{s.myTasks}</strong><small>{pre ? 'before your first day' : 'waiting for you'}</small></div>
          <div className="mx__kpi"><span>{leaveLeft ? leaveLeft.name : 'Leave'}</span><strong>{leaveLeft ? leaveLeft.left ?? '–' : '–'}</strong><small>{leaveLeft ? `days left of ${leaveLeft.entitled}${leaveLeft.carriedOver ? ` + ${leaveLeft.carriedOver} carried` : ''}` : 'no balance yet'}</small></div>
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
        <div className="hr__balances">{leave.data.balances.map((b) => <div key={b.key} className="mx__card hr__balance"><div className="mx__cardBody"><span className="mx__eyebrow" style={{ color: 'var(--mx-muted)' }}>{b.name}</span><strong className="hr__big">{b.unlimited ? '∞' : b.left ?? '–'}<small>{b.unlimited ? 'no limit' : 'days left'}</small></strong>{!b.unlimited && <Bar value={b.taken + b.pending} max={b.accrued + b.carriedOver + b.adjusted} />}<span className="mx__tiny">{b.unlimited ? `${b.taken} taken this year` : `${b.taken} taken · ${b.pending} pending${b.accrualMode === 'monthly' ? ` · ${b.accrued} of ${b.entitled} accrued` : ''}${b.carriedOver ? ` · ${b.carriedOver} carried over` : ''}`}</span></div></div>)}</div>
        <div className="mx__bar"><button type="button" className="mx__btn" onClick={() => { setForm({ lType: leave.data?.balances[0]?.key ?? '' }); setSheet('leave'); }}>+ Ask for leave</button><small className="mx__tiny">Weekends and public holidays in your branch are not counted.</small></div>
        <LeaveLedger employeeId={null} year={leave.data.year} hr={false} />
      </>}

      {tab === 'calendar' && <LeaveCalendar onOpen={hr ? openPerson : undefined} />}

      {tab === 'documents' && <div className="mx__card"><div className="mx__cardHead"><h3>My documents</h3><small>{(docs.data ?? []).filter((d) => d.status === 'sent').length} to do</small></div>
        <ul className="mx__list" style={{ marginTop: 10 }}>{(docs.data ?? []).map((d) => <li key={d.id}><span className={`mx__avatar ${d.status === 'acknowledged' ? 'mx__avatar--on' : ''}`} style={{ marginLeft: 0 }}>{d.kind === 'agreement' ? '✍' : '✓'}</span><div className="mx__main"><strong>{d.title}</strong><small>Version {d.version}{d.due_date ? ` · by ${day(d.due_date)}` : ''}{d.document_ref ? ` · ${d.document_ref}` : ''}{d.statement ? ` · "${d.statement}"` : ''}</small></div><Pill s={d.status} text={d.status === 'acknowledged' ? 'Done' : d.kind === 'agreement' ? 'To agree' : 'To confirm'} />{d.has_file && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(d.id, () => openLink(`/api/hr/documents/${d.document_id}/link`))}>Read it</button>}{d.status === 'sent' && <button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(d.id, async () => { const r = await postJson<{ statement: string }>(`/api/hr/documents/requests/${d.id}/acknowledge`, {}); return `Recorded: "${r.statement}"`; })}>{d.kind === 'agreement' ? 'I agree' : 'Received'}</button>}</li>)}{docs.data && !docs.data.length && empty('register', 'No documents for you', 'Policies and agreements HR sends you to confirm or agree appear here.')}</ul></div>}

      {tab === 'profile' && <PersonPage id={null} mine onBack={() => pickTab('tasks')} admin={!!s.admin} branches={br} act={act} busy={busy} />}

      {tab === 'approve' && <div className="mx__card"><div className="mx__cardHead"><h3>Leave to approve</h3><small>{(approve.data ?? []).length}</small></div>
        <ul className="mx__list" style={{ marginTop: 10 }}>{(approve.data ?? []).map((r) => <li key={r.id}><Avatar name={r.employee_name} lg /><div className="mx__main"><strong>{r.employee_name} · {r.type}</strong><small>{day(r.start_date)} to {day(r.end_date)} · {r.days} day{r.days === 1 ? '' : 's'}{r.reason ? ` · ${r.reason}` : ''}</small>{r.sameUnitAway.length > 0 && <small style={{ color: '#8a3a34' }}>Also away from the same team: {r.sameUnitAway.map((o) => `${o.name} (${day(o.start_date)}–${day(o.end_date)})`).join(', ')}</small>}</div><button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(r.id, async () => { await postJson(`/api/hr/leave/${r.id}/decide`, { decision: 'approve' }); return 'Approved.'; })}>Approve</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(r.id, 'Why not?', async (n) => { await postJson(`/api/hr/leave/${r.id}/decide`, { decision: 'reject', note: n }); return 'Declined.'; })}>Decline</button></li>)}{approve.data && !approve.data.length && empty('calendar', 'No leave waiting for you', 'Requests from the people who report to you land here, with who else from their team is away then.')}</ul></div>}

      {tab === 'cases' && <>
        {hr && <div className="mx__quick">
          {([['onboarding', 'New joiner', 'Record, pre-hire account and first-day tasks', 'people'], ['offboarding', 'Leaver', 'Access ends on the last day', 'send'], ['transfer', 'Transfer or promotion', 'New manager, title or unit from a date', 'actions'], ['probation', 'Probation review', 'Manager check-in, then HR decides', 'verify'], ...(s.admin ? [['urgent', 'Urgent termination', 'Revokes access now; restricted to HR', 'register']] : [])] as ['onboarding' | 'offboarding' | 'transfer' | 'probation' | 'urgent', string, string, IllustrationName][]).map(([k, label, sub, art]) => <button key={k} type="button" className="mx__quickBtn" onClick={() => { setForm(k === 'onboarding' ? { oType: 'employee', oBranch: activeBranches[0]?.id ?? '' } : {}); setSheet(k); }}><Illustration name={art} size={48} /><strong>{label}</strong><small>{sub}</small></button>)}
        </div>}
        <div className="mx__card"><div className="mx__cardHead"><h3>{hr ? 'Cases' : 'Team tasks'}</h3><div className="mx__segs">{([['all', 'All'], ['open', 'Open'], ['onboarding', 'Joining'], ['offboarding', 'Leaving'], ['transfer', 'Transfers'], ['probation', 'Probation']] as const).map(([k, v]) => <button key={k} type="button" className={`mx__seg ${caseFilter === k ? 'is-on' : ''}`} onClick={() => setCaseFilter(k)}>{v}</button>)}</div></div>
          <div className="hr__cases">{caseList.map(caseCard)}{cases.data && !caseList.length && <EmptyState icon="people" title="No cases" text={hr ? 'Start a joiner, leaver, transfer or probation review above.' : 'Cases with a task for your team appear here with the basic facts only.'} />}</div>
        </div>
      </>}

      {tab === 'people' && (person ? <PersonPage id={person} onBack={() => setPerson(null)} admin={!!s.admin} branches={br} act={act} busy={busy} /> : <DataTable<PersonRow>
        path="/api/hr/employees/search" title="People" defaultSort="name:asc" refreshKey={people.data} onRow={(r) => setPerson(r.id)}
        columns={[
          { key: 'name', label: 'Person', sortable: true, render: (r) => <span className="dt__cell"><Avatar name={r.name} /><span><strong>{r.name}</strong><small>{r.email}</small></span></span> },
          { key: 'title', label: 'Job title', sortable: true },
          { key: 'unit', label: 'Unit', sortable: true },
          { key: 'branch', label: 'Branch', sortable: true, render: (r) => r.branch ? <>{flag(r.branch_country)} {r.branch}</> : '' },
          { key: 'manager', label: 'Manager', sortable: true },
          { key: 'status', label: 'Status', sortable: true, render: (r) => <Pill s={r.status} /> },
          { key: 'type', label: 'Type', sortable: true },
          { key: 'grade', label: 'Grade', sortable: true, hide: true },
          { key: 'location', label: 'Location', sortable: true, hide: true },
          { key: 'start_date', label: 'Started', sortable: true, render: (r) => day(r.start_date) },
          { key: 'probation_end', label: 'Probation ends', sortable: true, hide: true, render: (r) => day(r.probation_end) },
        ]}
        filters={[
          { key: 'branch', label: 'Branch', kind: 'facet', multi: true },
          { key: 'status', label: 'Status', kind: 'facet', multi: true },
          { key: 'unit', label: 'Unit', kind: 'facet' },
          { key: 'manager', label: 'Manager', kind: 'facet' },
          { key: 'type', label: 'Type', kind: 'facet', multi: true },
          { key: 'started_from', label: 'Started after', kind: 'date_from' },
          { key: 'started_to', label: 'Started before', kind: 'date_to' },
        ]}
        card={(p) => <div className="hr__person" style={{ cursor: 'pointer' }}><Avatar name={p.name} lg /><div className="mx__main"><strong>{p.name} <Pill s={p.status} /></strong><small>{[p.title, p.unit, p.branch && `${flag(p.branch_country)} ${p.branch}`].filter(Boolean).join(' · ') || p.type}</small><small className="mx__tiny">{[p.type, p.grade && `grade ${p.grade}`, p.manager && `reports to ${p.manager}`, p.start_date && `since ${day(p.start_date)}`].filter(Boolean).join(' · ')}</small></div></div>}
        toolbar={<button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ oType: 'employee', oBranch: activeBranches[0]?.id ?? '' }); setSheet('onboarding'); }}>+ New joiner</button>}
        empty={{ title: 'No people yet', text: 'Add a new joiner and the person appears here with their record.', action: { label: 'New joiner', onClick: () => { setForm({ oType: 'employee' }); setSheet('onboarding'); } } }}
      />)}

      {tab === 'org' && <OrgChart onOpen={openPerson} />}

      {tab === 'hiring' && <div className="mx__card"><div className="mx__cardHead"><h3>Hiring</h3><small>{(hiring.data ?? []).filter((h) => h.status === 'open').length} open</small></div>
        <ul className="mx__list" style={{ marginTop: 10 }}>{(hiring.data ?? []).map((h) => <li key={h.id}><div className="mx__main"><strong>{h.reference} · {h.position}</strong><small>{h.filled} of {h.headcount} hired{h.cost_centre ? ` · ${h.cost_centre}` : ''}</small></div><div className="hr__progress"><Bar value={h.filled} max={h.headcount} /></div><Pill s={h.status} />{h.status === 'open' && <button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ oType: 'employee', oHire: h.id, oTitle: h.position, oBranch: activeBranches[0]?.id ?? '' }); setSheet('onboarding'); }}>Start a joiner</button>}</li>)}{hiring.data && !hiring.data.length && empty('people', 'No approved hiring requests', 'Managers ask with the Hiring request form; approved requests show here with their headcount.')}</ul></div>}

      {tab === 'upcoming' && <div className="mx__card"><div className="mx__cardHead"><h3>Coming up</h3><small>next 60 days</small></div>
        <ul className="mx__list" style={{ marginTop: 10 }}>{(soon.data ?? []).map((x, i) => <li key={i}><div className="mx__date"><strong>{new Date(x.on.length === 10 ? `${x.on}T00:00:00` : x.on).getDate()}</strong><small>{new Date(x.on.length === 10 ? `${x.on}T00:00:00` : x.on).toLocaleDateString([], { month: 'short' })}</small></div><div className="mx__main"><strong>{x.name}</strong><small>{x.detail ?? ''}</small></div><Pill s="draft" text={{ probation_end: 'Probation ends', start: 'Starts', leaving: 'Leaves', certification: 'Certification expires', anniversary: 'Work anniversary' }[x.kind] ?? x.kind} /></li>)}{soon.data && !soon.data.length && empty('calendar', 'Nothing in the next 60 days', 'Start dates, last days, probation ends, certifications and anniversaries show here.')}</ul></div>}

      {tab === 'reconcile' && <div className="mx__card"><div className="mx__cardHead"><h3>To reconcile</h3><small>changes another system owns</small></div>
        <ul className="mx__list" style={{ marginTop: 10 }}>{(recon.data ?? []).map((r) => <li key={r.id}><Avatar name={r.employee_name} /><div className="mx__main"><strong>{r.employee_name} · {r.field.replace('_', ' ')}</strong><small>{r.owner} owns this field · proposed {r.proposed_value ?? '—'}{r.current_value ? ` (now ${r.current_value})` : ''} · raised by {r.raised_by}</small></div><Pill s={r.status} />{r.status === 'open' && <><button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(r.id, async () => { await postJson(`/api/hr/reconciliation/${r.id}`, { outcome: 'applied' }); return `Marked as updated in ${r.owner}.`; })}>Updated in {r.owner}</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(r.id, async () => { await postJson(`/api/hr/reconciliation/${r.id}`, { outcome: 'dismissed' }); return 'Dismissed.'; })}>Dismiss</button></>}</li>)}{recon.data && !recon.data.length && empty('check', 'Nothing to reconcile', 'When a change belongs to another system (payroll, say), it waits here until someone confirms it was made there.')}</ul></div>}

      {tab === 'setup' && <>
        <div className="mx__card"><div className="mx__cardHead"><h3>Branches</h3><div className="mx__bar"><small>where people are employed · country, currency, time zone, working week</small>{s.admin && <button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ country: defaults?.defaultCountry ?? '', currency: defaults?.defaultCurrency ?? 'USD', timezone: 'UTC' }); setWeek(defaults?.workingDays ?? [1, 2, 3, 4, 5]); setSheet('branch'); }}>+ Branch</button>}</div></div>
          <div className="ex__budgets">{br.map((b) => <div key={b.id} className="ex__budget"><div className="ex__budgetHead"><strong><span className="hr__flag">{flag(b.country)}</span> {b.name}</strong><Pill s={b.active ? 'active' : 'left'} text={b.active ? b.currency : 'Closed'} /></div><small className="mx__tiny">{b.country} · {COUNTRIES.find(([c]) => c === b.country)?.[1] ?? b.country} · {b.timezone}</small><div className="ex__budgetBig"><strong>{b.people}</strong><small>people</small></div><small className="mx__tiny">Works {dayNames(b.working_days)}</small>{s.admin && <div className="mx__voteBtns" style={{ marginTop: 4 }}><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({ id: b.id, name: b.name, country: b.country, currency: b.currency, timezone: b.timezone, address: b.address ?? '', active: b.active ? 'yes' : 'no' }); setWeek(b.working_days); setSheet('branch'); }}>Edit</button></div>}</div>)}
          {branches.data && !br.length && <EmptyState icon="people" title="One company, any country" text={`Add a branch for each place you employ people. Each has its own currency, holidays and working week. Without branches everything uses the workspace default (${defaults?.defaultCurrency ?? 'USD'}).`} action={s.admin ? { label: 'Add a branch', onClick: () => { setForm({ currency: defaults?.defaultCurrency ?? 'USD', timezone: 'UTC' }); setWeek([1, 2, 3, 4, 5]); setSheet('branch'); } } : undefined} />}</div>
          {defaults && <div className="mx__bar" style={{ padding: '0 20px 18px' }}><small className="mx__tiny">Workspace default: {defaults.defaultCurrency}{defaults.defaultCountry ? ` · ${flag(defaults.defaultCountry)} ${COUNTRIES.find(([c]) => c === defaults.defaultCountry)?.[1] ?? defaults.defaultCountry}` : ''} · works {dayNames(defaults.workingDays)}</small>{s.admin && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({ currency: defaults.defaultCurrency, country: defaults.defaultCountry ?? '' }); setWeek(defaults.workingDays); setSheet('defaults'); }}>Change defaults</button>}</div>}
        </div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Leave types</h3>{s.admin && <button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ accrual: 'upfront', carry: '0', days: '20' }); setSheet('leaveType'); }}>+ Leave type</button>}</div>
          <ul className="mx__list">{(types.data ?? []).map((t) => <li key={t.id}><span className="mx__avatar" style={{ marginLeft: 0, fontSize: 11 }}>{t.unlimited ? '∞' : Number(t.annual_days)}</span><div className="mx__main"><strong>{t.name} {!t.active && <Pill s="left" text="Off" />}</strong><small>{t.unlimited ? 'no limit' : `${Number(t.annual_days)} days a year · ${t.accrual_mode === 'monthly' ? 'accrues monthly' : 'given up front'}${Number(t.carry_over_max) ? ` · carry over up to ${Number(t.carry_over_max)}` : ''}${t.prorate_first_year ? ' · prorated in the first year' : ''}`}{t.branch_name ? ` · ${t.branch_name} only` : ' · all branches'}</small></div>{s.admin && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({ key: t.key, name: t.name, days: String(Number(t.annual_days)), unlimited: t.unlimited ? 'yes' : 'no', accrual: t.accrual_mode, carry: String(Number(t.carry_over_max)), prorate: t.prorate_first_year ? 'yes' : 'no', branchId: t.branch_id ?? '', active: t.active ? 'yes' : 'no' }); setSheet('leaveType'); }}>Edit</button>}</li>)}</ul></div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Public holidays</h3><button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ branchId: '' }); setSheet('holiday'); }}>+ Holiday</button></div>
          <ul className="mx__list">{(holidays.data ?? []).map((h) => <li key={`${h.day}-${h.branch_id ?? ''}`}><div className="mx__date"><strong>{new Date(`${h.day}T00:00:00`).getDate()}</strong><small>{new Date(`${h.day}T00:00:00`).toLocaleDateString([], { month: 'short' })}</small></div><div className="mx__main"><strong>{h.name}</strong><small>{day(h.day)} · {h.branch_name ?? 'all branches'}</small></div><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(h.day, async () => { await postJson('/api/hr/leave/holidays', { day: h.day, branchId: h.branch_id ?? undefined, remove: true }); return 'Holiday removed.'; })}>Remove</button></li>)}{holidays.data && !holidays.data.length && empty('calendar', 'No holidays yet', 'Add each branch’s public holidays so leave is counted right.')}</ul></div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Documents</h3><div className="mx__bar"><small>policies and agreements people confirm or agree to</small><button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ dKind: 'receipt' }); setFile(null); setSheet('document'); }}>+ Document</button></div></div>
          <ul className="mx__list">{(docList.data ?? []).map((d) => <li key={d.id}><span className="hr__fileIcon" style={{ width: 32, height: 38 }}>{d.filename ? (d.filename.toLowerCase().endsWith('.pdf') ? 'PDF' : 'DOC') : '—'}</span><div className="mx__main"><strong>{d.title} · v{d.version} <Pill s="draft" text={d.kind === 'agreement' ? 'Agreement' : 'Receipt'} /></strong><small>{d.acknowledged} of {d.sent} done{d.overdue ? ` · ${d.overdue} overdue` : ''}{d.filename ? ` · ${d.filename}` : ' · no file attached'}</small></div><div className="hr__progress"><Bar value={d.acknowledged} max={d.sent} /></div>{d.filename && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(d.id, () => openLink(`/api/hr/documents/${d.id}/link`))}>Open</button>}<button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({ docId: d.id, docTitle: d.title }); setFile(null); setSheet('docFile'); }}>{d.filename ? 'Replace file' : 'Attach file'}</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(d.id, async () => { const sent = await postJson<{ sent: number }>(`/api/hr/documents/${d.id}/send`, { employeeIds: 'all' }); return `Sent to ${sent.sent} more people.`; })}>Send to everyone</button></li>)}{docList.data && !docList.data.length && empty('register', 'No documents yet', 'Create a policy or agreement, attach the file, and send it. People confirm they received it or agree to it, in those words.')}</ul></div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Teams</h3><div className="mx__bar"><small>who sees the IT, Facilities, Finance and HR tasks · owners and admins are always HR</small>{s.admin && <button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ tTeam: 'hr' }); setSheet('team'); }}>+ Add to a team</button>}</div></div>
          <ul className="mx__list">{(teams.data ?? []).map((t) => <li key={`${t.team}-${t.actor_id}`}><Avatar name={t.display_name} /><div className="mx__main"><strong>{t.display_name}</strong><small>{TEAM[t.team]}</small></div>{s.admin && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(t.actor_id, async () => { await postJson('/api/hr/teams', { team: t.team, actorId: t.actor_id, member: false }); return 'Removed from the team.'; })}>Remove</button>}</li>)}</ul></div>
      </>}
    </div>

    {sheet === 'onboarding' && <Sheet eyebrow="New joiner" title={f('oName') || 'Who is joining?'} subtitle="They get a pre-hire account with their own tasks only. Access opens on the first day once the checks are done." onClose={() => setSheet(null)} wide
      footer={<><small className="mx__tiny">Tasks come from the onboarding template for their type and branch.</small><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'start' || !f('oName') || !f('oEmail') || !f('oStart')} onClick={() => done('start', async () => { const r = await postJson<{ invitation: string | null }>('/api/hr/cases/onboarding', { name: f('oName'), email: f('oEmail'), startDate: f('oStart'), employmentType: f('oType') || 'employee', location: f('oLoc'), managerId: f('oMgr') || undefined, title: f('oTitle'), grade: f('oGrade'), branchId: f('oBranch') || undefined, probationEnd: f('oProb') || undefined, hiringId: f('oHire') || undefined, sendInvitation: f('oInvite') === 'yes' }); return `Onboarding started.${r.invitation ? ` Invitation: ${r.invitation}.` : ''}`; })}>Start onboarding</button></>}>
      <SheetSection title="Who" hint="Their name and the work email they will sign in with.">
        <F label="Full name"><input autoFocus required value={f('oName')} onChange={(e) => setF('oName', e.target.value)} /></F>
        <F label="Work email"><input type="email" required value={f('oEmail')} onChange={(e) => setF('oEmail', e.target.value)} /></F>
      </SheetSection>
      <SheetSection title="Role" hint="Where they sit and who they report to.">
        <F label="Job title"><input value={f('oTitle')} onChange={(e) => setF('oTitle', e.target.value)} /></F>
        <F label="Grade"><input value={f('oGrade')} onChange={(e) => setF('oGrade', e.target.value)} placeholder="optional" /></F>
        <F label="Manager"><select value={f('oMgr')} onChange={(e) => setF('oMgr', e.target.value)}><option value="">Choose…</option>{memberOptions.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></F>
        <F label="Branch" hint={activeBranches.length ? undefined : 'no branches yet; set them up in Setup'}><select value={f('oBranch')} onChange={(e) => setF('oBranch', e.target.value)}><option value="">No branch</option>{activeBranches.map((b) => <option key={b.id} value={b.id}>{flag(b.country)} {b.name} · {b.currency}</option>)}</select></F>
        <F label="Location" hint="office or city"><input value={f('oLoc')} onChange={(e) => setF('oLoc', e.target.value)} /></F>
        <F label="Type" wide><Choice value={f('oType') || 'employee'} onChange={(x) => setF('oType', x)} options={[['employee', 'Employee'], ['contractor', 'Contractor'], ['intern', 'Intern']]} /></F>
      </SheetSection>
      <SheetSection title="Dates" hint="Access opens on the start date, after the identity check and the contract.">
        <F label="Start date"><input type="date" required value={f('oStart')} onChange={(e) => setF('oStart', e.target.value)} /></F>
        <F label="Probation ends"><input type="date" value={f('oProb')} onChange={(e) => setF('oProb', e.target.value)} /></F>
        <F label="For hiring request" wide><select value={f('oHire')} onChange={(e) => setF('oHire', e.target.value)}><option value="">None</option>{(hiring.data ?? []).filter((h) => h.status === 'open').map((h) => <option key={h.id} value={h.id}>{h.reference} · {h.position} ({h.filled}/{h.headcount})</option>)}</select></F>
      </SheetSection>
      <SheetSection title="Invitation"><F label="Email them now?" wide><Choice value={f('oInvite') === 'yes' ? 'yes' : 'no'} onChange={(x) => setF('oInvite', x)} options={[['no', 'Not yet'], ['yes', 'Send the invitation now']]} /></F></SheetSection>
    </Sheet>}

    {(sheet === 'offboarding' || sheet === 'urgent' || sheet === 'probation' || sheet === 'transfer') && <Sheet eyebrow={{ offboarding: 'Leaver', urgent: 'Urgent termination', probation: 'Probation review', transfer: 'Transfer or promotion' }[sheet]} title={{ offboarding: 'Someone is leaving', urgent: 'End employment now', probation: 'Review a probation', transfer: 'Change a role' }[sheet]} subtitle={{ urgent: 'Revokes all access immediately. The reason stays in a restricted HR note.', offboarding: 'Access is revoked on the last day, whatever else is outstanding.', transfer: 'Approvals go to the new manager from the effective date; the old line is kept in the history.', probation: 'The manager checks in and recommends; HR decides.' }[sheet]} onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className={`mx__btn ${sheet === 'urgent' ? 'mx__btn--danger' : ''}`} disabled={busy === 'start' || !f('xEmp')} onClick={() => { const kind = sheet; done('start', async () => {
        if (kind === 'offboarding') await postJson('/api/hr/cases/offboarding', { employeeId: f('xEmp'), endDate: f('xDate'), summary: f('xWhy') });
        if (kind === 'urgent') await postJson('/api/hr/cases/urgent-termination', { employeeId: f('xEmp'), reason: f('xWhy') });
        if (kind === 'probation') await postJson('/api/hr/cases/probation', { employeeId: f('xEmp') });
        if (kind === 'transfer') await postJson('/api/hr/cases/transfer', { employeeId: f('xEmp'), effectiveDate: f('xDate'), managerId: f('xMgr') || undefined, title: f('xTitle') || undefined, reason: f('xWhy') });
        return kind === 'urgent' ? 'Access revoked now. The case is restricted to HR.' : 'Started.'; }); }}>{sheet === 'urgent' ? 'Authorise and revoke access' : 'Start'}</button></>}>
      <SheetSection title="Person"><F label="Who" wide><select required autoFocus value={f('xEmp')} onChange={(e) => setF('xEmp', e.target.value)}><option value="">Choose…</option>{(people.data ?? []).filter((p) => p.status !== 'left').map((p) => <option key={p.id} value={p.id}>{p.name}{p.branch_name ? ` · ${p.branch_name}` : ''}</option>)}</select></F>{(sheet === 'offboarding' || sheet === 'transfer') && <F label={sheet === 'transfer' ? 'Effective from' : 'Last day'}><input type="date" required value={f('xDate')} onChange={(e) => setF('xDate', e.target.value)} /></F>}</SheetSection>
      {sheet === 'transfer' && <SheetSection title="What changes" hint="Leave a field empty to keep it as it is."><F label="New manager"><select value={f('xMgr')} onChange={(e) => setF('xMgr', e.target.value)}><option value="">No change</option>{memberOptions.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></F><F label="New title"><input value={f('xTitle')} onChange={(e) => setF('xTitle', e.target.value)} /></F></SheetSection>}
      {sheet !== 'probation' && <SheetSection title={sheet === 'urgent' ? 'Reason' : 'Note'} hint={sheet === 'urgent' ? 'Restricted to HR.' : undefined}><F label={sheet === 'urgent' ? 'Reason (restricted)' : sheet === 'transfer' ? 'What is changing and why' : 'Note'} wide><textarea rows={3} value={f('xWhy')} onChange={(e) => setF('xWhy', e.target.value)} /></F></SheetSection>}
    </Sheet>}

    {sheet === 'probationExtend' && <Sheet eyebrow="Probation" title="Extend the probation" subtitle="A new end date and the reason, recorded on the case." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!f('newEnd') || !f('why')} onClick={() => done('probation', async () => { await postJson(`/api/hr/cases/${f('caseId')}/probation-decision`, { outcome: 'extend', newEnd: f('newEnd'), reason: f('why') }); return 'Probation extended.'; })}>Extend</button></>}>
      <SheetSection title="New end"><F label="Probation now ends"><input type="date" autoFocus value={f('newEnd')} onChange={(e) => setF('newEnd', e.target.value)} /></F><F label="Reason" wide><textarea rows={3} value={f('why')} onChange={(e) => setF('why', e.target.value)} /></F></SheetSection>
    </Sheet>}

    {sheet === 'leave' && leave.data && <Sheet eyebrow="Leave" title="Ask for leave" subtitle="Weekends and the public holidays in your branch are not counted. It goes to your manager, or to HR if you have none." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'leave' || !f('lType') || !f('lFrom') || !f('lTo')} onClick={() => done('leave', async () => { const r = await postJson<{ days: number; approver: string }>('/api/hr/leave', { type: f('lType'), startDate: f('lFrom'), endDate: f('lTo'), reason: f('lWhy') }); return `Asked for ${r.days} working day(s); it is with ${r.approver}.`; })}>Send the request</button></>}>
      <SheetSection title="Type"><F label="Leave type" wide><Choice value={f('lType')} onChange={(x) => setF('lType', x)} options={leave.data.balances.map((b) => [b.key, `${b.name}${b.unlimited ? '' : ` · ${b.left} left`}`] as [string, string])} wide /></F></SheetSection>
      <SheetSection title="Dates"><F label="From"><input type="date" autoFocus value={f('lFrom')} onChange={(e) => setF('lFrom', e.target.value)} /></F><F label="To"><input type="date" value={f('lTo')} onChange={(e) => setF('lTo', e.target.value)} /></F><F label="Note for your manager" wide><input value={f('lWhy')} onChange={(e) => setF('lWhy', e.target.value)} placeholder="optional" /></F></SheetSection>
    </Sheet>}

    {sheet === 'branch' && <Sheet eyebrow="Branch" title={f('id') ? `Edit ${f('name')}` : 'New branch'} subtitle="A place you employ people. People in it get its holidays, working week and pay currency." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'branch' || !f('name') || !f('country') || !f('currency')} onClick={() => done('branch', async () => { await postJson('/api/hr/branches', { id: f('id') || undefined, name: f('name'), country: f('country'), currency: f('currency'), timezone: f('timezone'), address: f('address'), workingDays: week, active: f('active') !== 'no' }); return f('id') ? 'Branch updated.' : 'Branch added.'; })}>{f('id') ? 'Save' : 'Add branch'}</button></>}>
      <SheetSection title="Where" hint="Country sets the flag; the time zone is used for dates and reminders.">
        <F label="Name" wide><input autoFocus value={f('name')} onChange={(e) => setF('name', e.target.value)} placeholder="Lagos, London, Nairobi…" /></F>
        <F label="Country"><select value={f('country')} onChange={(e) => setF('country', e.target.value)}><option value="">Choose…</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{flag(c)} {n}</option>)}</select></F>
        <F label="Time zone"><select value={f('timezone')} onChange={(e) => setF('timezone', e.target.value)}>{TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}</select></F>
        <F label="Address" wide><textarea rows={2} value={f('address')} onChange={(e) => setF('address', e.target.value)} /></F>
      </SheetSection>
      <SheetSection title="Money and time" hint="Pay for people here defaults to this currency.">
        <F label="Currency"><select value={f('currency')} onChange={(e) => setF('currency', e.target.value)}>{CURRENCIES.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}</select></F>
        <F label="Working week" wide>{weekPicker}</F>
        {f('id') && <F label="Status" wide><Choice value={f('active') === 'no' ? 'no' : 'yes'} onChange={(x) => setF('active', x)} options={[['yes', 'Open'], ['no', 'Closed']]} /></F>}
      </SheetSection>
    </Sheet>}

    {sheet === 'defaults' && <Sheet eyebrow="Workspace" title="Workspace defaults" subtitle="Used for anyone not in a branch, and as the starting point for new branches." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'defaults'} onClick={() => done('defaults', async () => { await postJson('/api/hr/settings', { defaultCurrency: f('currency'), defaultCountry: f('country'), workingDays: week }); return 'Defaults saved.'; })}>Save</button></>}>
      <SheetSection title="Defaults">
        <F label="Currency"><select value={f('currency')} onChange={(e) => setF('currency', e.target.value)}>{CURRENCIES.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}</select></F>
        <F label="Country"><select value={f('country')} onChange={(e) => setF('country', e.target.value)}><option value="">Not set</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{flag(c)} {n}</option>)}</select></F>
        <F label="Working week" wide>{weekPicker}</F>
      </SheetSection>
    </Sheet>}

    {sheet === 'leaveType' && <Sheet eyebrow="Leave" title={f('key') ? `Edit ${f('name')}` : 'New leave type'} subtitle="How many days, how they are released, and what carries over." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'leaveType' || !f('name')} onClick={() => done('leaveType', async () => { await postJson('/api/hr/leave/types', { key: f('key') || f('name').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), name: f('name'), annualDays: f('unlimited') === 'yes' ? 0 : f('days'), unlimited: f('unlimited') === 'yes', accrualMode: f('accrual'), carryOverMax: f('carry') || 0, prorateFirstYear: f('prorate') === 'yes', branchId: f('branchId') || undefined, active: f('active') !== 'no' }); return 'Leave type saved.'; })}>Save</button></>}>
      <SheetSection title="Type"><F label="Name" wide><input autoFocus value={f('name')} onChange={(e) => setF('name', e.target.value)} placeholder="Annual leave, Sick leave, Study leave…" /></F>
        <F label="Limit" wide><Choice value={f('unlimited') === 'yes' ? 'yes' : 'no'} onChange={(x) => setF('unlimited', x)} options={[['no', 'A number of days a year'], ['yes', 'No limit']]} /></F>
        {f('unlimited') !== 'yes' && <F label="Days a year"><input inputMode="decimal" value={f('days')} onChange={(e) => setF('days', e.target.value)} /></F>}
        <F label="Applies to"><select value={f('branchId')} onChange={(e) => setF('branchId', e.target.value)}><option value="">All branches</option>{activeBranches.map((b) => <option key={b.id} value={b.id}>{flag(b.country)} {b.name}</option>)}</select></F>
      </SheetSection>
      {f('unlimited') !== 'yes' && <SheetSection title="Accrual and carry-over">
        <F label="Released" wide><Choice value={f('accrual') || 'upfront'} onChange={(x) => setF('accrual', x)} options={[['upfront', 'All at the start of the year'], ['monthly', 'A twelfth each month']]} /></F>
        <F label="Carry over up to" hint="unused days that move to next year"><input inputMode="decimal" value={f('carry')} onChange={(e) => setF('carry', e.target.value)} /></F>
        <F label="First year" wide><Choice value={f('prorate') === 'yes' ? 'yes' : 'no'} onChange={(x) => setF('prorate', x)} options={[['no', 'Full entitlement'], ['yes', 'Prorated from the start month']]} /></F>
        {f('key') && <F label="Status" wide><Choice value={f('active') === 'no' ? 'no' : 'yes'} onChange={(x) => setF('active', x)} options={[['yes', 'In use'], ['no', 'Switched off']]} /></F>}
      </SheetSection>}
    </Sheet>}

    {sheet === 'holiday' && <Sheet eyebrow="Holidays" title="Add a public holiday" subtitle="Not counted as a leave day for the people it applies to." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'hol' || !f('hDay') || !f('hName')} onClick={() => done('hol', async () => { await postJson('/api/hr/leave/holidays', { day: f('hDay'), name: f('hName'), branchId: f('branchId') || undefined }); return 'Holiday added.'; })}>Add</button></>}>
      <SheetSection title="Holiday"><F label="Date"><input type="date" autoFocus value={f('hDay')} onChange={(e) => setF('hDay', e.target.value)} /></F><F label="Name"><input value={f('hName')} onChange={(e) => setF('hName', e.target.value)} /></F><F label="Applies to" wide><Choice value={f('branchId')} onChange={(x) => setF('branchId', x)} options={[['', 'All branches'], ...activeBranches.map((b) => [b.id, `${flag(b.country)} ${b.name}`] as [string, string])]} wide /></F></SheetSection>
    </Sheet>}

    {sheet === 'document' && <Sheet eyebrow="Documents" title="New document" subtitle="A policy people confirm they received, or an agreement they agree to. Attach the file so they can read it first." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'doc' || !f('dTitle') || !f('dVer')} onClick={() => done('doc', async () => { const d = await postJson<{ id: string }>('/api/hr/documents', { title: f('dTitle'), version: f('dVer'), kind: f('dKind') || 'receipt', documentRef: f('dRef') }); if (file) await postJson(`/api/hr/documents/${d.id}/files`, { filename: file.name, base64: await readFileAsBase64(file) }); if (f('dSend') === 'yes') { const sent = await postJson<{ sent: number }>(`/api/hr/documents/${d.id}/send`, { employeeIds: 'all', dueDate: f('dDue') || undefined }); return `Created and sent to ${sent.sent} people.`; } return 'Created. Send it when you are ready.'; })}>{f('dSend') === 'yes' ? 'Create and send' : 'Create'}</button></>}>
      <SheetSection title="Document"><F label="Title"><input autoFocus value={f('dTitle')} onChange={(e) => setF('dTitle', e.target.value)} /></F><F label="Version"><input value={f('dVer')} onChange={(e) => setF('dVer', e.target.value)} placeholder="1, 2026-A…" /></F>
        <F label="People should" wide><Choice value={f('dKind') || 'receipt'} onChange={(x) => setF('dKind', x)} options={[['receipt', 'Confirm they received it'], ['agreement', 'Agree to it']]} /></F>
        <div className="mx__field--wide"><FilePick file={file} onFile={setFile} /></div>
        <F label="Or where it is" hint="a link or reference, if there is no file" wide><input value={f('dRef')} onChange={(e) => setF('dRef', e.target.value)} /></F></SheetSection>
      <SheetSection title="Sending"><F label="Send now?" wide><Choice value={f('dSend') === 'yes' ? 'yes' : 'no'} onChange={(x) => setF('dSend', x)} options={[['no', 'Not yet'], ['yes', 'Send to everyone now']]} /></F>{f('dSend') === 'yes' && <F label="Due by"><input type="date" value={f('dDue')} onChange={(e) => setF('dDue', e.target.value)} /></F>}</SheetSection>
    </Sheet>}

    {sheet === 'docFile' && <Sheet eyebrow={f('docTitle')} title="Attach the file" subtitle="Replaces any file already attached. Checked for malware before anyone opens it." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'docFile' || !file} onClick={() => done('docFile', async () => { await postJson(`/api/hr/documents/${f('docId')}/files`, { filename: file!.name, base64: await readFileAsBase64(file!) }); return 'File attached.'; })}>Attach</button></>}>
      <SheetSection title="File"><div className="mx__field--wide"><FilePick file={file} onFile={setFile} /></div></SheetSection>
    </Sheet>}

    {sheet === 'team' && <Sheet eyebrow="Teams" title="Add someone to a team" subtitle="They see that team's tasks on every case, and the basic facts about the person." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'team' || !f('tWho')} onClick={() => done('team', async () => { await postJson('/api/hr/teams', { team: f('tTeam'), actorId: f('tWho') }); return 'Added to the team.'; })}>Add</button></>}>
      <SheetSection title="Team"><F label="Team" wide><Choice value={f('tTeam') || 'hr'} onChange={(x) => setF('tTeam', x)} options={[['hr', 'HR'], ['it', 'IT'], ['facilities', 'Facilities'], ['finance', 'Finance']]} /></F><F label="Person" wide><select autoFocus value={f('tWho')} onChange={(e) => setF('tWho', e.target.value)}><option value="">Choose…</option>{memberOptions.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></F></SheetSection>
    </Sheet>}
  </div>;
}
