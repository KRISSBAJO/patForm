'use client';

import './meetings.css';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from './module-shell';
import { Illustration } from './illustrations';
import { postJson } from './stepup';
import { Choice, F, Sheet, SheetSection } from './sheet';
import { DataTable } from './datatable';

/*
 * Approval policies: the one place an administrator says who approves
 * what, in what order, up to what amount, with what evidence, how fast,
 * and what happens when they are slow or say no. Every module's process
 * that is policy-driven follows what is set here. Templates are starting
 * points; the simulator shows who would decide a given request before
 * the policy goes live.
 */

type Responsible = { kind: string; role?: string; team?: string; email?: string; field?: string; fallback?: string };
type Step = { key: string; name: string; responsible: Responsible[]; mode: 'any' | 'all' | 'quorum'; required?: number; applies?: { amountField?: string; minAmount?: number | null; maxAmount?: number | null; categories?: string[]; costCentres?: string[]; branches?: string[] }; evidence: 'none' | 'note' | 'file'; notTheSubmitter: boolean; sla?: { remindAfterHours?: number | null; escalateAfterHours?: number | null; escalateTo?: Responsible[]; escalateMode?: 'add' | 'replace' }; onReject: 'end' | 'return'; guidance?: string };
type Policy = { id: string; process_key: string; process_name: string | null; name: string; description: string | null; branch_id: string | null; branch: string | null; steps: Step[]; cost_centre_owners: Record<string, string>; template_key: string | null; active: boolean; version: number; updated_at: string; open_steps: number };
type Process = { key: string; name: string; approvals: { key: string; name: string; policy: boolean }[]; finance: unknown };
type Template = { key: string; name: string; description: string; fits: string; steps: Step[]; process?: string; limitFrom?: { step: string; module: string } };
type Overview = { open: { id: number; instance_id: string; approval_key: string; step_name: string; step_index: number; started_at: string; remind_at: string | null; reminded_at: string | null; escalate_at: string | null; escalated_at: string | null; escalated_to: string[] | null; approvers: string[]; mode: string; process_key: string; process_name: string; policy_name: string | null; who: string; amount: string; hoursOpen: number; overdue: boolean }[]; counts: { open: number; overdue: number; escalated: number }; last90Days: { decided: number; averageHours: number; rejected: number; returned: number } };
type Sim = { amount: number; steps: { key: string; name: string; applies: boolean; who: string[]; mode: string; required?: number; evidence: string; remindAfterHours: number | null; escalateAfterHours: number | null; escalateTo: string[]; onReject: string }[] };
type Branch = { id: string; name: string; country: string; active: boolean };

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
const flag = (cc: string | null) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');
const day = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString([], { dateStyle: 'medium' }) : '');
const Pill = ({ s, text }: { s: string; text?: string }) => <span className={`mx__pill mx__pill--${s}`}><i />{text ?? s}</span>;
const who = (r: Responsible) => r.kind === 'manager' ? (r.fallback ? `Their manager, else role ${r.fallback}` : 'Their manager') : r.kind === 'skip_manager' ? 'Manager’s manager' : r.kind === 'role' ? `Role: ${r.role}` : r.kind === 'team' ? `${(r.team ?? '').toUpperCase()} team` : r.kind === 'person' ? r.email ?? '' : r.kind === 'cost_centre_owner' ? 'Cost centre owner' : r.kind === 'field' ? `Address in ${r.field}` : 'Process approvers';
const KINDS: [string, string][] = [['manager', 'Their manager'], ['skip_manager', 'Manager’s manager'], ['team', 'A team'], ['role', 'A process role'], ['person', 'A named person'], ['cost_centre_owner', 'Cost centre owner'], ['field', 'An address on the form'], ['fallback', 'The process’s own approvers']];
const blankStep = (): Step => ({ key: '', name: '', responsible: [{ kind: 'manager' }], mode: 'any', applies: {}, evidence: 'none', notTheSubmitter: true, sla: { remindAfterHours: 24, escalateAfterHours: null, escalateTo: [], escalateMode: 'add' }, onReject: 'end' });

/** One responsible party, editable. */
function Party({ r, onChange, onRemove, roles }: { r: Responsible; onChange: (r: Responsible) => void; onRemove?: () => void; roles: string[] }) {
  return <div className="ap__party">
    <select value={r.kind} onChange={(e) => onChange({ kind: e.target.value })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
    {r.kind === 'team' && <select value={r.team ?? 'finance'} onChange={(e) => onChange({ ...r, team: e.target.value })}>{[['finance', 'Finance'], ['hr', 'HR'], ['it', 'IT'], ['facilities', 'Facilities']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
    {r.kind === 'role' && <input list="ap-roles" value={r.role ?? ''} onChange={(e) => onChange({ ...r, role: e.target.value })} placeholder="finance_approver" />}
    {r.kind === 'person' && <input type="email" value={r.email ?? ''} onChange={(e) => onChange({ ...r, email: e.target.value })} placeholder="name@company.com" />}
    {r.kind === 'field' && <input value={r.field ?? ''} onChange={(e) => onChange({ ...r, field: e.target.value })} placeholder="manager_email" />}
    {(r.kind === 'manager' || r.kind === 'skip_manager') && <input list="ap-roles" value={r.fallback ?? ''} onChange={(e) => onChange({ ...r, fallback: e.target.value || undefined })} placeholder="if none on file: a role" />}
    {r.kind === 'cost_centre_owner' && <input value={r.field ?? ''} onChange={(e) => onChange({ ...r, field: e.target.value })} placeholder="cost_centre (field)" />}
    {onRemove && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={onRemove}>Remove</button>}
    <datalist id="ap-roles">{roles.map((x) => <option key={x} value={x} />)}</datalist>
  </div>;
}

/** The step card inside the policy editor. */
function StepCard({ step, index, total, currency, branches, onEdit, onMove, onRemove }: { step: Step; index: number; total: number; currency: string; branches: Branch[]; onEdit: () => void; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  const a = step.applies ?? {};
  const band = typeof a.minAmount === 'number' && typeof a.maxAmount === 'number' ? `${a.minAmount.toLocaleString()} to ${a.maxAmount.toLocaleString()} ${currency}` : typeof a.minAmount === 'number' ? `from ${a.minAmount.toLocaleString()} ${currency}` : typeof a.maxAmount === 'number' ? `up to ${a.maxAmount.toLocaleString()} ${currency}` : 'any amount';
  const extra = [a.categories?.length && `categories: ${a.categories.join(', ')}`, a.costCentres?.length && `cost centres: ${a.costCentres.join(', ')}`, a.branches?.length && `branches: ${a.branches.map((id) => branches.find((b) => b.id === id)?.name ?? id).join(', ')}`].filter(Boolean).join(' · ');
  return <div className="ap__step">
    <div className="ap__stepNo"><span>{index + 1}</span>{index < total - 1 && <i />}</div>
    <div className="ap__stepBody">
      <div className="ap__stepHead"><strong>{step.name || 'Untitled step'}</strong><div className="mx__voteBtns" style={{ marginTop: 0 }}><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={index === 0} onClick={() => onMove(-1)}>↑</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={index === total - 1} onClick={() => onMove(1)}>↓</button><button type="button" className="mx__btn mx__btn--sm" onClick={onEdit}>Edit</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={onRemove}>Remove</button></div></div>
      <div className="ap__facts">
        <span><b>Who</b>{step.responsible.map(who).join(' or ')}{step.mode === 'all' ? ' · all of them, in turn' : step.mode === 'quorum' ? ` · any ${step.required ?? 2}` : step.responsible.length > 1 ? ' · any one' : ''}</span>
        <span><b>When</b>{band}{extra ? ` · ${extra}` : ''}</span>
        <span><b>Evidence</b>{step.evidence === 'file' ? 'a file must be attached' : step.evidence === 'note' ? 'a note on what was checked' : 'none required'}{step.notTheSubmitter ? ' · never the requester' : ''}</span>
        <span><b>Clock</b>{step.sla?.remindAfterHours ? `remind after ${step.sla.remindAfterHours}h` : 'no reminder'}{step.sla?.escalateAfterHours ? ` · escalate after ${step.sla.escalateAfterHours}h to ${(step.sla.escalateTo ?? []).map(who).join(', ')}${step.sla.escalateMode === 'replace' ? ' (replacing)' : ''}` : ''}</span>
        <span><b>If rejected</b>{step.onReject === 'return' ? 'goes back to the requester to fix and resubmit' : 'the request ends'}</span>
        {step.guidance && <span><b>Guidance</b>{step.guidance}</span>}
      </div>
    </div>
  </div>;
}

export function ApprovalsView({ canAdminister, onOpenRecord }: { canAdminister: boolean; onOpenRecord: (instanceId: string) => void }) {
  const list = useFeed<{ policies: Policy[]; processes: Process[]; templates: Template[] }>('/api/approvals/policies');
  const overview = useFeed<Overview>('/api/approvals/overview');
  const branches = useFeed<{ branches: Branch[]; defaultCurrency: string }>('/api/hr/branches');
  const [tab, setTab] = useState<'overview' | 'policies' | 'templates'>('overview');
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<{ id?: string; processKey: string; name: string; description: string; branchId: string; steps: Step[]; owners: { cc: string; email: string }[]; active: boolean } | null>(null);
  const [stepSheet, setStepSheet] = useState<{ index: number; step: Step } | null>(null);
  const [adopt, setAdopt] = useState<Template | null>(null);
  const [adoptForm, setAdoptForm] = useState<{ processKey: string; name: string; branchId: string }>({ processKey: '', name: '', branchId: '' });
  const [sim, setSim] = useState<{ amount: string; category: string; costCentre: string; branchId: string }>({ amount: '2500', category: 'purchase', costCentre: 'ops', branchId: '' });
  const [simOut, setSimOut] = useState<Sim | null>(null);
  const cur = branches.data?.defaultCurrency ?? '';
  const br = (branches.data?.branches ?? []).filter((b) => b.active);
  const processes = list.data?.processes ?? [];
  const roles = ['line_manager', 'finance_approver', 'finance_ops', 'hr', 'admin'];
  const act = async (id: string, work: () => Promise<string>) => { setBusy(id); setNote(null); try { setNote({ text: await work() }); await Promise.all([list.reload(), overview.reload()]); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } finally { setBusy(null); } };
  const openEditor = (p: Policy | null, processKey = '') => { setEditing(p); setDraft(p ? { id: p.id, processKey: p.process_key, name: p.name, description: p.description ?? '', branchId: p.branch_id ?? '', steps: p.steps, owners: Object.entries(p.cost_centre_owners).map(([cc, email]) => ({ cc, email })), active: p.active } : { processKey, name: '', description: '', branchId: '', steps: [blankStep()], owners: [], active: true }); setSimOut(null); setTab('policies'); };
  const save = () => { if (!draft) return; void act('save', async () => { const body = { id: draft.id, processKey: draft.processKey, name: draft.name, description: draft.description, branchId: draft.branchId || undefined, steps: draft.steps, costCentreOwners: Object.fromEntries(draft.owners.filter((o) => o.cc && o.email).map((o) => [o.cc, o.email])), active: draft.active }; const r = await postJson<{ id: string; version: number }>('/api/approvals/policies', body); setDraft(null); setEditing(null); return `Policy saved, version ${r.version}.`; }); };
  const runSim = async () => { if (!draft) return; try { setSimOut(await postJson<Sim>('/api/approvals/simulate', { processKey: draft.processKey, amount: sim.amount, category: sim.category, costCentre: sim.costCentre, branchId: sim.branchId || undefined, steps: draft.steps, costCentreOwners: Object.fromEntries(draft.owners.filter((o) => o.cc && o.email).map((o) => [o.cc, o.email])) })); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } };
  const policyProcesses = processes.filter((p) => p.approvals.some((a) => a.policy));
  const o = overview.data;

  return <div className="mx ap">
    <section className="mx__band">
      <div className="mx__bandGrid">
        <div>
          <div className="mx__eyebrow">Approval policies</div>
          <h2 className="mx__bandTitle">{o && o.counts.overdue ? `${o.counts.overdue} approval${o.counts.overdue === 1 ? '' : 's'} running late` : 'Who approves what'}</h2>
          <p className="mx__bandSub">One set of rules for every module: steps, limits, evidence, reminders, escalation.</p>
          <div className="mx__bandActions">
            {canAdminister && <button type="button" className="mx__btn mx__btn--light" onClick={() => setTab('templates')}>+ From a template</button>}
            {canAdminister && <button type="button" className="mx__btn mx__btn--outline" onClick={() => openEditor(null, policyProcesses[0]?.key ?? '')}>+ Blank policy</button>}
            <button type="button" className="mx__btn mx__btn--outline" onClick={() => setTab('overview')}>Waiting now</button>
          </div>
        </div>
        <div className={`mx__kpi ${o?.counts.open ? 'mx__kpi--live' : ''}`}><span>Waiting</span><strong>{o?.counts.open ?? 0}</strong><small>{o?.counts.overdue ?? 0} late · {o?.counts.escalated ?? 0} escalated</small></div>
        <div className="mx__kpi"><span>Decided, 90 days</span><strong>{o?.last90Days.decided ?? 0}</strong><small>{o ? `${o.last90Days.averageHours}h on average` : ''}</small></div>
        <div className="mx__kpi"><span>Policies</span><strong>{(list.data?.policies ?? []).filter((p) => p.active).length}</strong><small>{policyProcesses.length} process{policyProcesses.length === 1 ? '' : 'es'} policy-driven</small></div>
      </div>
    </section>

    {note && <p className={`mx__notice ${note.err ? 'mx__notice--err' : ''}`} style={{ marginTop: 16 }} role="status">{note.text}</p>}
    {(list.error || overview.error) && <p className="mx__notice mx__notice--err" style={{ marginTop: 16 }}>{list.error ?? overview.error}</p>}
    <div className="mx__segs" style={{ marginTop: 16 }}>{([['overview', 'Waiting now'], ['policies', 'Policies'], ['templates', 'Templates']] as const).map(([k, l]) => <button key={k} type="button" className={`mx__seg ${tab === k ? 'is-on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>

    <div className="mx__stack" style={{ marginTop: 14 }}>
      {tab === 'overview' && <div className="mx__card"><div className="mx__cardHead"><h3>Waiting for a decision</h3><small>every policy-driven approval that is open, oldest first</small></div>
        <ul className="mx__list">{(o?.open ?? []).map((x) => <li key={x.id} className={x.overdue ? 'is-late' : ''}><span className={`mx__avatar ${x.escalated_at ? 'mx__avatar--on' : ''}`} style={{ marginLeft: 0, fontSize: 10 }}>{x.step_index + 1}</span><div className="mx__main"><strong>{x.process_name} · {x.step_name}{x.who ? ` · ${x.who}` : ''}{x.amount ? ` · ${Number(x.amount).toLocaleString()}` : ''}</strong><small>Waiting {x.hoursOpen}h with {x.approvers.map((a) => a.replace(/^role:/, 'role ')).join(', ')}{x.policy_name ? ` · ${x.policy_name}` : ''}{x.reminded_at ? ' · reminded' : ''}{x.escalated_at ? ` · escalated to ${(x.escalated_to ?? []).join(', ')}` : ''}</small></div>{x.overdue ? <Pill s="failed" text="Late" /> : <Pill s="open" text="Open" />}<button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => onOpenRecord(x.instance_id)}>Open</button></li>)}{o && !o.open.length && <li><EmptyState icon="check" title="Nothing waiting" text="Policy-driven approvals that are open show here with how long they have waited and who has them." /></li>}</ul></div>}

      {tab === 'policies' && !draft && <div className="mx__card"><div className="mx__cardHead"><h3>Policies</h3><small>one active policy per process, plus one per branch where a branch differs</small></div>
        <div className="ex__records">{(list.data?.policies ?? []).map((p) => <div key={p.id} className={`ex__record ${p.active ? '' : 'is-off'}`}>
          <div className="ex__recordHead"><span className="mx__avatar mx__avatar--lg" style={{ marginLeft: 0, fontSize: 11 }}>{p.steps.length}</span><div className="mx__main"><strong>{p.name} <Pill s={p.active ? 'passed' : 'cancelled'} text={p.active ? 'Active' : 'Off'} />{p.branch && <Pill s="called" text={p.branch} />}</strong><small>{p.process_name ?? p.process_key} · {p.steps.map((s) => s.name).join(' → ')} · v{p.version} · {day(p.updated_at)}{p.open_steps ? ` · ${p.open_steps} open now` : ''}</small>{p.description && <small>{p.description}</small>}</div></div>
          <div className="ex__recordBtns">{canAdminister && <><button type="button" className="mx__btn mx__btn--sm" onClick={() => openEditor(p)}>Edit</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy === p.id} onClick={() => void act(p.id, async () => { await postJson(`/api/approvals/policies/${p.id}/active`, { active: !p.active }); return p.active ? 'Policy switched off; the process falls back to its own approvers.' : 'Policy switched on.'; })}>{p.active ? 'Switch off' : 'Switch on'}</button></>}</div>
        </div>)}{list.data && !list.data.policies.length && <EmptyState icon="vote" title="No policies yet" text="Adopt a template or start blank. Until a process has an active policy it uses the approvers written into it." action={canAdminister ? { label: 'See templates', onClick: () => setTab('templates') } : undefined} />}</div>
        {policyProcesses.length === 0 && processes.length > 0 && <p className="mx__tiny" style={{ margin: '0 20px 16px' }}>None of your processes is policy-driven yet. The built-in Approval request process is; a process built in the builder becomes policy-driven when its approval is marked so.</p>}
      </div>}

      {tab === 'policies' && draft && <div className="hr__grid2">
        <div className="mx__stack">
          <div className="mx__card"><div className="mx__cardHead"><h3>{editing ? `Edit ${editing.name}` : 'New policy'}</h3><div className="mx__bar"><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setDraft(null); setEditing(null); }}>Cancel</button><button type="button" className="mx__btn mx__btn--sm" disabled={busy === 'save' || !draft.name || !draft.processKey || !draft.steps.length} onClick={save}>{editing ? 'Save as a new version' : 'Create policy'}</button></div></div>
            <div className="mx__cardBody"><div className="mx__form">
              <F label="Name"><input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Standard spend" /></F>
              <F label="Process"><select value={draft.processKey} onChange={(e) => setDraft({ ...draft, processKey: e.target.value })}><option value="">Choose…</option>{processes.map((p) => <option key={p.key} value={p.key}>{p.name}{p.approvals.some((a) => a.policy) ? '' : ' (not policy-driven)'}</option>)}</select></F>
              <F label="Branch" hint="leave empty for the whole workspace"><select value={draft.branchId} onChange={(e) => setDraft({ ...draft, branchId: e.target.value })}><option value="">Whole workspace</option>{br.map((b) => <option key={b.id} value={b.id}>{flag(b.country)} {b.name}</option>)}</select></F>
              <F label="Status"><Choice value={draft.active ? 'yes' : 'no'} onChange={(x) => setDraft({ ...draft, active: x === 'yes' })} options={[['yes', 'Active'], ['no', 'Off']]} /></F>
              <F label="Description" wide><input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></F>
            </div></div>
          </div>
          <div className="mx__card"><div className="mx__cardHead"><h3>Steps</h3><div className="mx__bar"><small>in order; a step only runs when its conditions match</small><button type="button" className="mx__btn mx__btn--sm" onClick={() => setStepSheet({ index: draft.steps.length, step: blankStep() })}>+ Step</button></div></div>
            <div className="ap__steps">{draft.steps.map((s, i) => <StepCard key={i} step={s} index={i} total={draft.steps.length} currency={cur} branches={br} onEdit={() => setStepSheet({ index: i, step: JSON.parse(JSON.stringify(s)) })} onMove={(d) => { const steps = [...draft.steps]; const [m] = steps.splice(i, 1); steps.splice(i + d, 0, m!); setDraft({ ...draft, steps }); }} onRemove={() => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })} />)}</div>
          </div>
          <div className="mx__card"><div className="mx__cardHead"><h3>Cost centre owners</h3><div className="mx__bar"><small>for steps that route to the owner of the cost centre</small><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setDraft({ ...draft, owners: [...draft.owners, { cc: '', email: '' }] })}>+ Owner</button></div></div>
            {draft.owners.length > 0 && <div className="mx__cardBody">{draft.owners.map((o, i) => <div key={i} className="ap__party"><input value={o.cc} onChange={(e) => setDraft({ ...draft, owners: draft.owners.map((x, j) => j === i ? { ...x, cc: e.target.value } : x) })} placeholder="cost centre, e.g. ops" /><input type="email" value={o.email} onChange={(e) => setDraft({ ...draft, owners: draft.owners.map((x, j) => j === i ? { ...x, email: e.target.value } : x) })} placeholder="owner@company.com" /><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setDraft({ ...draft, owners: draft.owners.filter((_, j) => j !== i) })}>Remove</button></div>)}</div>}
          </div>
        </div>
        <div className="mx__stack">
          <div className="mx__card"><div className="mx__cardHead"><h3>Try it</h3><small>who would decide this request</small></div>
            <div className="mx__cardBody"><div className="mx__form">
              <F label={`Amount (${cur})`}><input inputMode="decimal" value={sim.amount} onChange={(e) => setSim({ ...sim, amount: e.target.value })} /></F>
              <F label="Category"><input value={sim.category} onChange={(e) => setSim({ ...sim, category: e.target.value })} /></F>
              <F label="Cost centre"><input value={sim.costCentre} onChange={(e) => setSim({ ...sim, costCentre: e.target.value })} /></F>
              {br.length > 0 && <F label="Branch"><select value={sim.branchId} onChange={(e) => setSim({ ...sim, branchId: e.target.value })}><option value="">None</option>{br.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></F>}
              <div className="mx__field--wide"><button type="button" className="mx__btn mx__btn--sm" onClick={() => void runSim()}>Simulate</button></div>
            </div>
            {simOut && <ol className="ap__simList">{simOut.steps.map((s) => <li key={s.key} className={s.applies ? '' : 'is-skipped'}><strong>{s.name}</strong>{s.applies ? <small>{s.who.join(' or ')}{s.mode === 'quorum' ? ` · any ${s.required}` : s.mode === 'all' ? ' · all in turn' : ''}{s.evidence !== 'none' ? ` · ${s.evidence === 'file' ? 'file required' : 'note required'}` : ''}{s.remindAfterHours ? ` · remind ${s.remindAfterHours}h` : ''}{s.escalateAfterHours ? ` · escalate ${s.escalateAfterHours}h to ${s.escalateTo.join(', ')}` : ''}</small> : <small>does not apply to this request</small>}</li>)}</ol>}
            </div></div>
          <div className="mx__card"><div className="mx__cardBody"><Illustration name="vote" size={56} /><p className="mx__tiny" style={{ marginTop: 8 }}>Changes make a new version. Records already in a chain finish on the steps they started with; new records use the new version. Authority grants and delegations still apply at every step.</p></div></div>
        </div>
      </div>}

      {tab === 'templates' && <div className="mx__quick" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>{(list.data?.templates ?? []).map((t) => <div key={t.key} className="mx__card ap__template"><div className="mx__cardBody"><Illustration name={t.steps.length > 2 ? 'register' : t.steps.some((s) => s.mode === 'quorum') ? 'vote' : 'actions'} size={44} /><h3>{t.name}</h3><p>{t.description}</p><small className="mx__tiny">Fits: {t.fits}</small><ol className="ap__tplSteps">{t.steps.map((s) => <li key={s.key}>{s.name}<small> · {s.responsible.map(who).join(' or ')}{t.limitFrom?.step === s.key ? ' · above the module\u2019s manager limit' : typeof s.applies?.minAmount === 'number' ? ` · from ${s.applies.minAmount.toLocaleString()}` : ''}</small></li>)}</ol>{canAdminister && <button type="button" className="mx__btn mx__btn--sm" onClick={() => { setAdopt(t); setAdoptForm({ processKey: (t.process && processes.some((p) => p.key === t.process) ? t.process : policyProcesses[0]?.key ?? processes[0]?.key) ?? '', name: t.name, branchId: '' }); }}>Use this</button>}</div></div>)}</div>}
    </div>

    {stepSheet && draft && <Sheet wide eyebrow={`Step ${stepSheet.index + 1}`} title={stepSheet.step.name || 'Approval step'} subtitle="Who decides, when the step applies, what they must bring, how long they have, and what a no does." onClose={() => setStepSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setStepSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={!stepSheet.step.name || !stepSheet.step.responsible.length} onClick={() => { const steps = [...draft.steps]; steps[stepSheet.index] = stepSheet.step; setDraft({ ...draft, steps }); setStepSheet(null); }}>Keep step</button></>}>
      {(() => { const s = stepSheet.step; const up = (patch: Partial<Step>) => setStepSheet({ ...stepSheet, step: { ...s, ...patch } }); const a = s.applies ?? {}; const upA = (patch: Partial<NonNullable<Step['applies']>>) => up({ applies: { ...a, ...patch } }); const sla = s.sla ?? {}; const upS = (patch: Partial<NonNullable<Step['sla']>>) => up({ sla: { ...sla, ...patch } }); return <>
        <SheetSection title="Step"><F label="Name" wide><input autoFocus value={s.name} onChange={(e) => up({ name: e.target.value })} placeholder="Finance approval" /></F><F label="Guidance for the approver" wide><input value={s.guidance ?? ''} onChange={(e) => up({ guidance: e.target.value })} placeholder="Check the quote and the budget before approving." /></F></SheetSection>
        <SheetSection title="Who decides" hint="Any of these may take it unless you ask for all of them or a quorum.">
          <div className="mx__field--wide ap__parties">{s.responsible.map((r, i) => <Party key={i} r={r} roles={roles} onChange={(x) => up({ responsible: s.responsible.map((y, j) => j === i ? x : y) })} onRemove={s.responsible.length > 1 ? () => up({ responsible: s.responsible.filter((_, j) => j !== i) }) : undefined} />)}<button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => up({ responsible: [...s.responsible, { kind: 'person', email: '' }] })}>+ Another</button></div>
          <F label="Settled by" wide><Choice value={s.mode} onChange={(x) => up({ mode: x as Step['mode'] })} options={[['any', 'Any one of them'], ['all', 'All of them, in turn'], ['quorum', 'A number of them']]} /></F>
          {s.mode === 'quorum' && <F label="How many"><input inputMode="numeric" value={s.required ?? 2} onChange={(e) => up({ required: Number(e.target.value) })} /></F>}
          <F label="Separation of duties" wide><Choice value={s.notTheSubmitter ? 'yes' : 'no'} onChange={(x) => up({ notTheSubmitter: x === 'yes' })} options={[['yes', 'Never the person who asked'], ['no', 'The requester may decide']]} /></F>
        </SheetSection>
        <SheetSection title="When it applies" hint={`Amounts in ${cur || 'the workspace currency'}. Leave empty for always.`}>
          <F label="From amount"><input inputMode="decimal" value={a.minAmount ?? ''} onChange={(e) => upA({ minAmount: e.target.value === '' ? null : Number(e.target.value) })} /></F>
          <F label="Up to amount"><input inputMode="decimal" value={a.maxAmount ?? ''} onChange={(e) => upA({ maxAmount: e.target.value === '' ? null : Number(e.target.value) })} /></F>
          <F label="Only these categories" hint="comma separated"><input value={(a.categories ?? []).join(', ')} onChange={(e) => upA({ categories: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></F>
          <F label="Only these cost centres" hint="comma separated"><input value={(a.costCentres ?? []).join(', ')} onChange={(e) => upA({ costCentres: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></F>
          {br.length > 0 && <F label="Only these branches" wide><div className="mx__segs mx__segs--wrap">{br.map((b) => <button key={b.id} type="button" className={`mx__seg ${(a.branches ?? []).includes(b.id) ? 'is-on' : ''}`} onClick={() => upA({ branches: (a.branches ?? []).includes(b.id) ? (a.branches ?? []).filter((x) => x !== b.id) : [...(a.branches ?? []), b.id] })}>{flag(b.country)} {b.name}</button>)}</div></F>}
          <F label="Amount field" hint="only if the form calls it something else"><input value={a.amountField ?? ''} onChange={(e) => upA({ amountField: e.target.value || undefined })} placeholder="amount" /></F>
        </SheetSection>
        <SheetSection title="Evidence"><F label="Before approving" wide><Choice value={s.evidence} onChange={(x) => up({ evidence: x as Step['evidence'] })} options={[['none', 'Nothing extra'], ['note', 'A note on what was checked'], ['file', 'A file attached']]} /></F></SheetSection>
        <SheetSection title="Clock" hint="Hours from when the step opens.">
          <F label="Remind after (hours)"><input inputMode="decimal" value={sla.remindAfterHours ?? ''} onChange={(e) => upS({ remindAfterHours: e.target.value === '' ? null : Number(e.target.value) })} /></F>
          <F label="Escalate after (hours)"><input inputMode="decimal" value={sla.escalateAfterHours ?? ''} onChange={(e) => upS({ escalateAfterHours: e.target.value === '' ? null : Number(e.target.value) })} /></F>
          {!!sla.escalateAfterHours && <><div className="mx__field--wide ap__parties"><label style={{ font: '600 12px var(--ui)', color: 'var(--mx-muted)' }}>Escalate to</label>{(sla.escalateTo ?? []).map((r, i) => <Party key={i} r={r} roles={roles} onChange={(x) => upS({ escalateTo: (sla.escalateTo ?? []).map((y, j) => j === i ? x : y) })} onRemove={() => upS({ escalateTo: (sla.escalateTo ?? []).filter((_, j) => j !== i) })} />)}<button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => upS({ escalateTo: [...(sla.escalateTo ?? []), { kind: 'skip_manager' }] })}>+ Someone</button></div>
          <F label="How" wide><Choice value={sla.escalateMode ?? 'add'} onChange={(x) => upS({ escalateMode: x as 'add' | 'replace' })} options={[['add', 'Add them to the approvers'], ['replace', 'Replace the approvers']]} /></F></>}
        </SheetSection>
        <SheetSection title="If they say no"><F label="A rejection" wide><Choice value={s.onReject} onChange={(x) => up({ onReject: x as Step['onReject'] })} options={[['end', 'Ends the request'], ['return', 'Sends it back to the requester to fix']]} /></F></SheetSection>
      </>; })()}
    </Sheet>}

    {adopt && <Sheet eyebrow="Template" title={adopt.name} subtitle={adopt.description} onClose={() => setAdopt(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setAdopt(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'adopt' || !adoptForm.processKey} onClick={() => void act('adopt', async () => { const r = await postJson<{ id: string }>('/api/approvals/templates/adopt', { templateKey: adopt.key, processKey: adoptForm.processKey, name: adoptForm.name, branchId: adoptForm.branchId || undefined }); setAdopt(null); const fresh = await get<{ policies: Policy[] }>('/api/approvals/policies'); const p = fresh.policies.find((x) => x.id === r.id); if (p) openEditor(p); return 'Template adopted. Edit the limits and names so it fits you.'; })}>Adopt and edit</button></>}>
      <SheetSection title="Where it applies"><F label="Process" wide><select autoFocus value={adoptForm.processKey} onChange={(e) => setAdoptForm({ ...adoptForm, processKey: e.target.value })}><option value="">Choose…</option>{processes.map((p) => <option key={p.key} value={p.key}>{p.name}{p.approvals.some((a) => a.policy) ? '' : ' (not policy-driven)'}</option>)}</select></F><F label="Policy name"><input value={adoptForm.name} onChange={(e) => setAdoptForm({ ...adoptForm, name: e.target.value })} /></F><F label="Branch"><select value={adoptForm.branchId} onChange={(e) => setAdoptForm({ ...adoptForm, branchId: e.target.value })}><option value="">Whole workspace</option>{br.map((b) => <option key={b.id} value={b.id}>{flag(b.country)} {b.name}</option>)}</select></F></SheetSection>
      <SheetSection title="The steps it brings"><ol className="ap__tplSteps" style={{ gridColumn: '1 / -1' }}>{adopt.steps.map((s) => <li key={s.key}>{s.name}<small> · {s.responsible.map(who).join(' or ')}{typeof s.applies?.minAmount === 'number' ? ` · from ${s.applies.minAmount.toLocaleString()}` : ''}{s.evidence !== 'none' ? ` · ${s.evidence}` : ''}{s.sla?.escalateAfterHours ? ` · escalates after ${s.sla.escalateAfterHours}h` : ''}</small></li>)}</ol></SheetSection>
    </Sheet>}
  </div>;
}
