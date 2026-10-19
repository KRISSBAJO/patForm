'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { postJson } from './stepup';

/*
 * Goals, appraisals and development (PRD Module 8). Everyone: reviews to
 * write, my goals, my results (acknowledge, appeal) and my development plan.
 * Managers: their reports' goals and goal changes. HR: templates, cycles,
 * calibration, appeals and promotion or pay recommendations. A rating never
 * changes pay here; approving a recommendation only clears HR to act.
 */

type Tab = 'reviews' | 'goals' | 'results' | 'development' | 'team' | 'cycles' | 'calibration' | 'appeals' | 'recommendations' | 'templates';
type Summary = { hr: boolean; admin: boolean; reviewsToDo: number; results: number; goals: number; dev: number };
type Assignment = { id: string; stage: string; participant_id: string; person: string; cycle: string; window: string; status: string | null };
type Criterion = { key: string; title: string; weight?: number };
type Section = { key: string; title: string; kind: 'objectives' | 'competencies' | 'narrative'; weight: number; criteria: Criterion[] };
type TemplateSnap = { name: string; version: number; scaleMin: number; scaleMax: number; naPolicy: 'block' | 'redistribute'; decimals: number; sections: Section[] };
type Resp = { score?: number | null; na?: boolean; comment?: string };
type Form = { stage: string; window: string; template: TemplateSnap; mine: { responses: Record<string, Resp>; narrative: string | null; recommendation: { kind: string; detail: string } | null; status: string; score: string | null } | null;
  self?: { responses: Record<string, Resp>; narrative: string | null; score: string | null } | null;
  peers?: { released: boolean; note?: string; mode?: string; count?: number; suppressed?: boolean; averages?: Record<string, number>; responses?: { reviewer: string; narrative: string | null; responses: Record<string, Resp> }[] };
  goals?: { title: string; success_criteria: string; weight: string; progress: number; status: string; evidence: string | null }[] };
type Goal = { id: string; title: string; description: string | null; success_criteria: string; weight: string; target_date: string | null; status: string; progress: number; evidence: string | null; aligned_title: string | null; pending_changes: number };
type TeamGoal = { id: string; title: string; success_criteria: string; weight: string; status: string; progress: number; owner: string; pending: { id: number; proposed: Record<string, unknown>; previous: Record<string, unknown>; reason: string }[] | null };
type Result = { participant_id: string; cycle: string; scale_min: string; scale_max: string; manager_score: string | null; calibrated_score: string | null; summary: string | null; published_at: string; acknowledged_at: string | null; acknowledgement: string | null; appeal_status: string; appeal_outcome: string | null };
type Dev = { id: string; kind: string; title: string; due_date: string | null; status: string; evidence: string | null; owner: string | null };
type Cycle = { id: string; name: string; kind: string; status: string; stages: Record<string, { opens: string; closes: string }>; peer_mode: string; min_cohort: number; template_name: string; template_version: string; participants: number; needs_reviewer: number };
type Template = { id: string; name: string; version: number; status: string; scale_min: number; scale_max: number; na_policy: string; decimals: number; sections: Section[] };
type CalRow = { id: string; name: string; unit: string | null; needs_reviewer: boolean; reviewer_note: string | null; self: { score: string | null; status: string } | null; manager: { score: string | null; status: string; reviewer: string; active: boolean } | null; peers: number; current: number | null; adjustments: { original_score: string; adjusted_score: string; evidence: string; reason: string; actor: string; occurred_at: string }[]; recommendation: { kind: string; detail: string } | null };
type Appeal = { id: string; reason: string; status: string; due_date: string; outcome: string | null; new_score: string | null; employee: string; cycle: string; reviewer: string | null; reviewer_id: string | null; calibrated_score: string | null };
type Rec = { id: string; kind: string; detail: string; status: string; decision_note: string | null; employee: string; cycle: string };
type Member = { id: string; display_name: string; active: boolean };

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
const STAGE: Record<string, string> = { self: 'Self-assessment', peer: 'Peer feedback', manager: 'Manager review', additional: 'Additional review' };
const WINDOW: Record<string, string> = { open: 'Open', not_open: 'Not open yet', closed: 'Closed', none: '' };
const score = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : String(Number(v)));

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div><label className="cs__label" htmlFor={id}>{label}</label>{children}</div>;
}

/** One criterion per line; "Title : 40" gives it a weight. */
const parseCriteria = (textValue: string): Criterion[] => textValue.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
  const m = l.match(/^(.*?)\s*:\s*(\d+(?:\.\d+)?)$/);
  return m ? { key: `c${i + 1}`, title: m[1]!, weight: Number(m[2]) } : { key: `c${i + 1}`, title: l };
});

export function AppraisalsView() {
  const summary = useFeed<Summary>('/api/appraisals/summary');
  const s = summary.data;
  const hr = s?.hr === true;
  const [tab, setTab] = useState<Tab>('reviews');
  const reviews = useFeed<Assignment[]>(s ? '/api/appraisals/reviews/mine' : null);
  const goals = useFeed<Goal[]>(s ? '/api/appraisals/goals' : null);
  const results = useFeed<Result[]>(s ? '/api/appraisals/results/mine' : null);
  const dev = useFeed<Dev[]>(s ? '/api/appraisals/development' : null);
  const team = useFeed<TeamGoal[]>(s ? '/api/appraisals/goals/team' : null);
  const appeals = useFeed<Appeal[]>(s ? '/api/appraisals/appeals' : null);
  const cycles = useFeed<Cycle[]>(hr ? '/api/appraisals/cycles' : null);
  const templates = useFeed<Template[]>(hr ? '/api/appraisals/templates' : null);
  const recs = useFeed<Rec[]>(hr ? '/api/appraisals/recommendations' : null);
  const members = useFeed<Member[]>(hr ? '/api/members' : null);
  const [cycleId, setCycleId] = useState('');
  const cal = useFeed<CalRow[]>(hr && cycleId ? `/api/appraisals/cycles/${cycleId}/calibration` : null);
  const [openReview, setOpenReview] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [draft, setDraft] = useState<{ responses: Record<string, Resp>; narrative: string; recKind: string; recDetail: string }>({ responses: {}, narrative: '', recKind: '', recDetail: '' });
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sections, setSections] = useState<{ title: string; kind: Section['kind']; weight: string; criteria: string }[]>([{ title: 'Objectives', kind: 'objectives', weight: '60', criteria: 'Delivered agreed objectives' }, { title: 'Behaviours', kind: 'competencies', weight: '40', criteria: 'Teamwork : 50\nOwnership : 50' }, { title: 'Comments', kind: 'narrative', weight: '0', criteria: '' }]);
  const [asking, setAsking] = useState<{ id: string; label: string; run: (answer: string) => Promise<string> } | null>(null);
  const [answer, setAnswer] = useState('');
  const [incomplete, setIncomplete] = useState<string | null>(null);
  const f = (k: string) => fields[k] ?? '';
  const setF = (k: string, v: string) => setFields((x) => ({ ...x, [k]: v }));

  const reloadAll = async () => { await Promise.all([summary.reload(), reviews.reload(), goals.reload(), results.reload(), dev.reload(), team.reload(), appeals.reload(), cycles.reload(), templates.reload(), recs.reload(), cal.reload()]); };
  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { const message = await work(); await reloadAll(); setNote(message); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } finally { setBusy(null); }
  };
  const loadForm = async (assignmentId: string) => {
    setOpenReview(assignmentId); setForm(null); setNote(null);
    try {
      const data = await get<Form>(`/api/appraisals/reviews/${assignmentId}`);
      setForm(data);
      setDraft({ responses: data.mine?.responses ?? {}, narrative: data.mine?.narrative ?? '', recKind: data.mine?.recommendation?.kind ?? '', recDetail: data.mine?.recommendation?.detail ?? '' });
    } catch (err) { setOpenReview(null); setNote(err instanceof Error ? err.message : String(err)); }
  };

  if (summary.error) return <div className="ig__workspace"><p className="ig__error" role="alert">{summary.error}</p></div>;
  if (!s) return <div className="ig__workspace"><p className="ig__rowMain">Loading…</p></div>;

  const isManager = (team.data ?? []).length > 0;
  const appealsForMe = (appeals.data ?? []).filter((a) => hr || a.status === 'open');
  const tabs: { id: Tab; name: string; count: number | null; icon: 'table' | 'export' | 'trail' | 'account' | 'done' }[] = [
    { id: 'reviews', name: 'Reviews to write', count: s.reviewsToDo, icon: 'done' },
    { id: 'goals', name: 'My goals', count: s.goals, icon: 'trail' },
    { id: 'results', name: 'My results', count: s.results, icon: 'export' },
    { id: 'development', name: 'My development', count: s.dev, icon: 'trail' },
    ...(isManager || hr ? [{ id: 'team' as const, name: 'Team goals', count: (team.data ?? []).filter((g) => g.status === 'draft' || g.pending?.length).length, icon: 'account' as const }] : []),
    ...(hr ? [
      { id: 'cycles' as const, name: 'Cycles', count: (cycles.data ?? []).filter((c) => c.status === 'active').length, icon: 'table' as const },
      { id: 'calibration' as const, name: 'Calibration', count: null, icon: 'table' as const },
    ] : []),
    ...(hr || appealsForMe.length ? [{ id: 'appeals' as const, name: 'Appeals', count: appealsForMe.filter((a) => a.status === 'open').length, icon: 'trail' as const }] : []),
    ...(hr ? [
      { id: 'recommendations' as const, name: 'Recommendations', count: (recs.data ?? []).filter((r) => r.status === 'proposed').length, icon: 'export' as const },
      { id: 'templates' as const, name: 'Templates', count: null, icon: 'trail' as const },
    ] : []),
  ];
  const people = (members.data ?? []).filter((m) => m.active);
  const published = (templates.data ?? []).filter((t) => t.status === 'published');

  const reviewForm = form && openReview && <form className="ig__form" style={{ gridTemplateColumns: '1fr' }} onSubmit={(e) => e.preventDefault()}>
    <div className="ig__formTitle"><strong>{STAGE[form.stage] ?? form.stage} · {form.template.name} v{form.template.version}</strong>
      <p>Score each item from {form.template.scaleMin} to {form.template.scaleMax}. {form.template.naPolicy === 'redistribute' ? '"Not applicable" moves that item\'s weight to the others; the calculation is kept with your review.' : 'Every item needs a score; "not applicable" is not allowed in this template.'} {form.window !== 'open' ? `The window is ${WINDOW[form.window]?.toLowerCase() || 'not set'}.` : ''}</p></div>
    {form.mine?.status === 'submitted' && <p className="ig__notice">Submitted. Score {score(form.mine.score)}. It cannot be changed now.</p>}
    {form.goals && form.goals.length > 0 && <div><strong>Their goals</strong><ul style={list}>{form.goals.map((g, i) => <li key={i}><small>{g.title} · weight {Number(g.weight)} · {g.progress}% · {g.status}{g.evidence ? ` · ${g.evidence}` : ''}</small></li>)}</ul></div>}
    {form.self !== undefined && <p><small>{form.self ? `Their self-assessment: ${score(form.self.score)}${form.self.narrative ? ` — "${form.self.narrative}"` : ''}` : 'No self-assessment to show yet.'}</small></p>}
    {form.peers && <p><small>{!form.peers.released ? `Peer feedback: ${form.peers.note}` : form.peers.suppressed ? `Peer feedback: ${form.peers.note}` : form.peers.mode === 'confidential' ? `Peer feedback from ${form.peers.count} people (averages only): ${Object.entries(form.peers.averages ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'no scored items'}` : `Peer feedback: ${(form.peers.responses ?? []).map((r) => `${r.reviewer}${r.narrative ? ` — "${r.narrative}"` : ''}`).join('; ') || 'none'}`}</small></p>}
    {form.template.sections.map((sec) => <fieldset key={sec.key} style={{ border: '1px solid var(--line, #ddd)', borderRadius: 8, padding: 12 }}>
      <legend><strong>{sec.title}</strong>{sec.kind !== 'narrative' ? ` · ${sec.weight}%` : ''}</legend>
      {sec.kind === 'narrative' ? <Field id={`n-${sec.key}`} label="Your comments"><textarea id={`n-${sec.key}`} className="cs__input" rows={3} disabled={form.mine?.status === 'submitted'} value={draft.narrative} onChange={(e) => setDraft((d) => ({ ...d, narrative: e.target.value }))} /></Field>
        : sec.criteria.map((c) => { const r = draft.responses[c.key] ?? {}; return <div key={c.key} className="pp2__roleEdit" style={{ alignItems: 'center', marginBottom: 6 }}>
          <label htmlFor={`s-${c.key}`} style={{ flex: 1 }}>{c.title}{c.weight !== undefined ? ` (${c.weight}%)` : ''}</label>
          <select id={`s-${c.key}`} className="cs__input" style={{ width: 90 }} disabled={form.mine?.status === 'submitted' || r.na} value={r.score ?? ''} onChange={(e) => setDraft((d) => ({ ...d, responses: { ...d.responses, [c.key]: { ...r, score: e.target.value === '' ? null : Number(e.target.value) } } }))}>
            <option value="">—</option>{Array.from({ length: form.template.scaleMax - form.template.scaleMin + 1 }, (_, i) => form.template.scaleMin + i).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          {form.template.naPolicy === 'redistribute' && <label className="pp2__inlineLabel"><input type="checkbox" disabled={form.mine?.status === 'submitted'} checked={!!r.na} onChange={(e) => setDraft((d) => ({ ...d, responses: { ...d.responses, [c.key]: { ...r, na: e.target.checked, score: e.target.checked ? null : r.score } } }))} /> Not applicable</label>}
        </div>; })}
    </fieldset>)}
    {!form.template.sections.some((x) => x.kind === 'narrative') && <Field id="n-all" label="Your comments"><textarea id="n-all" className="cs__input" rows={3} disabled={form.mine?.status === 'submitted'} value={draft.narrative} onChange={(e) => setDraft((d) => ({ ...d, narrative: e.target.value }))} /></Field>}
    {form.stage === 'manager' && form.mine?.status !== 'submitted' && <div className="pp2__roleEdit">
      <Field id="rec-kind" label="Recommend (optional)"><select id="rec-kind" className="cs__input" value={draft.recKind} onChange={(e) => setDraft((d) => ({ ...d, recKind: e.target.value }))}><option value="">Nothing</option><option value="promotion">A promotion</option><option value="pay_increase">A pay increase</option></select></Field>
      {draft.recKind && <Field id="rec-detail" label="Details (HR decides separately)"><input id="rec-detail" className="cs__input" value={draft.recDetail} onChange={(e) => setDraft((d) => ({ ...d, recDetail: e.target.value }))} /></Field>}
    </div>}
    <div className="pp2__roleEdit">
      {form.mine?.status !== 'submitted' && <>
        <button type="button" className="cs__btn" disabled={busy === 'review'} onClick={() => void act('review', async () => { await postJson(`/api/appraisals/reviews/${openReview}`, { responses: draft.responses, narrative: draft.narrative, recommendation: draft.recKind ? { kind: draft.recKind, detail: draft.recDetail } : undefined }); return 'Draft saved.'; })}>Save draft</button>
        <button type="button" className="cs__btn cs__btn--primary" disabled={busy === 'review'} onClick={() => void act('review', async () => { const r = await postJson<{ score: number }>(`/api/appraisals/reviews/${openReview}`, { responses: draft.responses, narrative: draft.narrative, recommendation: draft.recKind ? { kind: draft.recKind, detail: draft.recDetail } : undefined, submit: true }); setOpenReview(null); setForm(null); return `Submitted. Score ${r.score}.`; })}>Submit</button>
      </>}
      <button type="button" className="cs__btn" onClick={() => { setOpenReview(null); setForm(null); }}>Close</button>
    </div>
  </form>;

  return <div className="ig__workspace">
    <header className="ig__hero">
      <span className="ig__eyebrow">GOALS &amp; APPRAISALS</span>
      <h2>{hr ? 'Review cycles, calibration and development' : 'Your goals, reviews and development'}</h2>
      <p>Scores are worked out from the template and kept with each review, so a result can always be checked. A rating does not change pay on its own: promotions and pay rises go to HR as separate decisions.</p>
    </header>

    <div className="ig__surface">
      <div className="ig__tabs" role="tablist" aria-label="Appraisal areas">
        {tabs.map((item, index) => <button key={item.id} id={`apr-tab-${item.id}`} type="button" role="tab" aria-controls={`apr-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className="ig__tab" onClick={() => { setTab(item.id); setNote(null); setFields({}); setAsking(null); }} onKeyDown={(event) => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : -1; if (next < 0) return; event.preventDefault(); const id = tabs[next]!.id; setTab(id); document.getElementById(`apr-tab-${id}`)?.focus(); }}>
          <Icon name={item.icon} /><span>{item.name}</span>{item.count !== null && <span className="ig__tabCount">{item.count}</span>}
        </button>)}
      </div>
      <section id={`apr-panel-${tab}`} role="tabpanel" aria-labelledby={`apr-tab-${tab}`} className="ig__panel">
        {note && <p className="ig__notice" role="status">{note}</p>}
        {asking && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); const a = answer.trim(); if (!a) return; const job = asking; setAsking(null); setAnswer(''); void act(job.id, () => job.run(a)); }}>
          <Field id="apr-ask" label={asking.label}><input id="apr-ask" className="cs__input" required autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} /></Field>
          <div className="pp2__roleEdit" style={{ alignSelf: 'end' }}><button type="submit" className="cs__btn cs__btn--primary">Save</button><button type="button" className="cs__btn" onClick={() => { setAsking(null); setAnswer(''); }}>Cancel</button></div>
        </form>}

        {tab === 'reviews' && <>
          {reviewForm}
          {!openReview && <ul style={list}>
            {(reviews.data ?? []).map((a) => <li key={a.id} className="ig__row"><div className="ig__rowMain">
              <strong>{a.stage === 'self' ? 'Your self-assessment' : `${STAGE[a.stage]} for ${a.person}`}</strong><span className={`ig__status ${a.status === 'submitted' ? '' : 'ig__status--off'}`}>{a.status === 'submitted' ? 'Submitted' : WINDOW[a.window] || 'No window'}</span>
              <p>{a.cycle}{a.status === 'draft' ? ' · draft saved' : ''}</p></div>
              <button type="button" className={`cs__btn ${a.window === 'open' && a.status !== 'submitted' ? 'cs__btn--primary' : ''}`} onClick={() => void loadForm(a.id)}>{a.status === 'submitted' ? 'View' : 'Open'}</button>
            </li>)}
            {reviews.data && !reviews.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No reviews for you to write.</p></div></li>}
          </ul>}
        </>}

        {tab === 'goals' && <>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('goal', async () => { await postJson('/api/appraisals/goals', { title: f('gTitle'), successCriteria: f('gMeasure'), weight: f('gWeight') || 0, targetDate: f('gDate') || undefined }); setFields({}); return 'Goal added as a draft. Your manager approves it.'; }); }}>
            <div className="ig__formTitle"><strong>New goal</strong><p>Your manager approves it. Once approved, changes to what it means go back to them, with the old version kept.</p></div>
            <Field id="g-title" label="Goal"><input id="g-title" className="cs__input" required value={f('gTitle')} onChange={(e) => setF('gTitle', e.target.value)} /></Field>
            <Field id="g-measure" label="How success is measured"><input id="g-measure" className="cs__input" required value={f('gMeasure')} onChange={(e) => setF('gMeasure', e.target.value)} /></Field>
            <Field id="g-weight" label="Weight (0–100)"><input id="g-weight" type="number" min={0} max={100} className="cs__input" value={f('gWeight')} onChange={(e) => setF('gWeight', e.target.value)} /></Field>
            <Field id="g-date" label="Target date"><input id="g-date" type="date" className="cs__input" value={f('gDate')} onChange={(e) => setF('gDate', e.target.value)} /></Field>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'goal'}>Add goal</button>
          </form>
          <ul style={list}>{(goals.data ?? []).map((g) => <li key={g.id} className="ig__row"><div className="ig__rowMain">
            <strong>{g.title}</strong><span className={`ig__status ${g.status === 'approved' || g.status === 'achieved' ? '' : 'ig__status--off'}`}>{g.status}{g.pending_changes ? ' · change waiting' : ''}</span>
            <p>{g.success_criteria} · weight {Number(g.weight)} · {g.progress}% done{g.target_date ? ` · by ${day(g.target_date)}` : ''}{g.evidence ? ` · ${g.evidence}` : ''}</p></div>
            {['draft', 'approved'].includes(g.status) && <div className="pp2__roleEdit">
              <button type="button" className="cs__btn" onClick={() => setAsking({ id: g.id, label: 'Progress (0–100), then a space and the evidence', run: async (r) => { const [p, ...ev] = r.split(' '); await postJson(`/api/appraisals/goals/${g.id}`, { progress: Number(p), evidence: ev.join(' ') || undefined }); return 'Progress recorded.'; } })}>Update progress</button>
              <button type="button" className="cs__btn" onClick={() => setAsking({ id: g.id, label: g.status === 'draft' ? 'New measure of success' : 'New measure of success, then " because " and why', run: async (r) => { const [m, why] = r.split(' because '); await postJson(`/api/appraisals/goals/${g.id}`, { successCriteria: m, reason: why }); return g.status === 'draft' ? 'Changed.' : 'Change sent to your manager.'; } })}>Change measure</button>
            </div>}
          </li>)}
          {goals.data && !goals.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No goals yet.</p></div></li>}</ul>
        </>}

        {tab === 'results' && <ul style={list}>
          {(results.data ?? []).map((r) => <li key={r.participant_id} className="ig__row" style={{ flexWrap: 'wrap' }}><div className="ig__rowMain">
            <strong>{r.cycle}</strong><span className="ig__status">{score(r.calibrated_score)} of {r.scale_max}</span>
            <p>Published {day(r.published_at)}{r.calibrated_score !== r.manager_score ? ` · manager's score ${score(r.manager_score)}, changed in calibration or on appeal` : ''}{r.acknowledged_at ? ` · received ${day(r.acknowledged_at)}` : ''}{r.appeal_status !== 'none' ? ` · appeal ${r.appeal_status}${r.appeal_outcome ? `: ${r.appeal_outcome}` : ''}` : ''}</p>
            {r.summary && <p>"{r.summary}"</p>}</div>
            <div className="pp2__roleEdit">
              {!r.acknowledged_at && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(r.participant_id, async () => { const x = await postJson<{ statement: string }>(`/api/appraisals/participants/${r.participant_id}/acknowledge`, {}); return `Recorded: "${x.statement}"`; })}>I have received it</button>}
              {r.appeal_status !== 'open' && <button type="button" className="cs__btn" onClick={() => setAsking({ id: r.participant_id, label: 'What are you appealing, and why?', run: async (why) => { const x = await postJson<{ due: string }>(`/api/appraisals/participants/${r.participant_id}/appeal`, { reason: why }); return `Appeal opened. An independent reviewer decides by ${day(x.due)}.`; } })}>Appeal</button>}
            </div>
          </li>)}
          {results.data && !results.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No published reviews yet.</p></div></li>}
        </ul>}

        {tab === 'development' && <>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('dev', async () => { await postJson('/api/appraisals/development', { kind: f('dKind') || 'action', title: f('dTitle'), dueDate: f('dDate') || undefined }); setFields({}); return 'Added to your plan.'; }); }}>
            <div className="ig__formTitle"><strong>Add to your development plan</strong><p>Actions, training and check-ins. Each is closed with what shows it is done.</p></div>
            <Field id="d-kind" label="Kind"><select id="d-kind" className="cs__input" value={f('dKind')} onChange={(e) => setF('dKind', e.target.value)}><option value="action">Action</option><option value="training">Training</option><option value="checkin">Check-in</option></select></Field>
            <Field id="d-title" label="What"><input id="d-title" className="cs__input" required value={f('dTitle')} onChange={(e) => setF('dTitle', e.target.value)} /></Field>
            <Field id="d-date" label="By"><input id="d-date" type="date" className="cs__input" value={f('dDate')} onChange={(e) => setF('dDate', e.target.value)} /></Field>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'dev'}>Add</button>
          </form>
          <ul style={list}>{(dev.data ?? []).map((d) => <li key={d.id} className="ig__row"><div className="ig__rowMain">
            <strong>{d.title}</strong><span className={`ig__status ${d.status === 'done' ? '' : 'ig__status--off'}`}>{d.kind} · {d.status}</span>
            <p>{d.due_date ? `By ${day(d.due_date)}` : 'No date'}{d.owner ? ` · ${d.owner}` : ''}{d.evidence ? ` · ${d.evidence}` : ''}</p></div>
            {d.status === 'open' && <button type="button" className="cs__btn" onClick={() => setAsking({ id: d.id, label: 'What shows it is done?', run: async (ev) => { await postJson(`/api/appraisals/development/${d.id}/close`, { evidence: ev }); return 'Closed.'; } })}>Mark done</button>}
          </li>)}</ul>
        </>}

        {tab === 'team' && <ul style={list}>
          {(team.data ?? []).map((g) => <li key={g.id} className="ig__row" style={{ flexWrap: 'wrap' }}><div className="ig__rowMain">
            <strong>{g.owner}: {g.title}</strong><span className={`ig__status ${g.status === 'approved' ? '' : 'ig__status--off'}`}>{g.status}</span>
            <p>{g.success_criteria} · weight {Number(g.weight)} · {g.progress}% done</p>
            {(g.pending ?? []).map((p) => <p key={p.id} className="ig__rowError">Change asked: {Object.entries(p.proposed).map(([k, v]) => `${k.replace('_', ' ')} "${String((p.previous as Record<string, unknown>)[k] ?? '')}" → "${String(v ?? '')}"`).join('; ')} — {p.reason}
              {' '}<button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(String(p.id), async () => { await postJson(`/api/appraisals/goals/revisions/${p.id}/decide`, { decision: 'approve' }); return 'Change approved.'; })}>Approve change</button>
              <button type="button" className="cs__btn" onClick={() => void act(String(p.id), async () => { await postJson(`/api/appraisals/goals/revisions/${p.id}/decide`, { decision: 'reject' }); return 'Change rejected; the goal stays as it was.'; })}>Reject</button></p>)}</div>
            <div className="pp2__roleEdit">
              {g.status === 'draft' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(g.id, async () => { await postJson(`/api/appraisals/goals/${g.id}/approve`, {}); return 'Goal approved.'; })}>Approve goal</button>}
              {g.status === 'approved' && <button type="button" className="cs__btn" onClick={() => setAsking({ id: g.id, label: 'Close as achieved, missed or withdrawn?', run: async (st) => { await postJson(`/api/appraisals/goals/${g.id}`, { status: st.trim().toLowerCase() }); return 'Goal closed.'; } })}>Close goal</button>}
            </div>
          </li>)}
          {team.data && !team.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No goals from people who report to you.</p></div></li>}
        </ul>}

        {tab === 'cycles' && <>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('cycle', async () => {
            const stages: Record<string, { opens: string; closes: string }> = {};
            for (const st of ['self', 'peer', 'manager', 'calibration']) if (f(`${st}O`) && f(`${st}C`)) stages[st] = { opens: f(`${st}O`), closes: f(`${st}C`) };
            await postJson('/api/appraisals/cycles', { name: f('cName'), kind: f('cKind') || 'annual', templateId: f('cTpl'), stages, peerMode: f('cPeer') || 'confidential', minCohort: Number(f('cMin') || 3), eligibility: { startedBefore: f('cStarted') || undefined } });
            setFields({}); return 'Cycle created as a draft. Launch it to take the list of people and start the reviews.'; }); }}>
            <div className="ig__formTitle"><strong>New review cycle</strong><p>The cycle keeps a copy of the template, so later template changes never alter it. Self-assessment must close before the manager review closes.</p></div>
            <Field id="c-name" label="Name"><input id="c-name" className="cs__input" required value={f('cName')} onChange={(e) => setF('cName', e.target.value)} /></Field>
            <Field id="c-kind" label="Kind"><select id="c-kind" className="cs__input" value={f('cKind')} onChange={(e) => setF('cKind', e.target.value)}>{['annual', 'quarterly', 'probation', 'project', 'continuous'].map((k) => <option key={k} value={k}>{k}</option>)}</select></Field>
            <Field id="c-tpl" label="Template"><select id="c-tpl" className="cs__input" required value={f('cTpl')} onChange={(e) => setF('cTpl', e.target.value)}><option value="">Choose…</option>{published.map((t) => <option key={t.id} value={t.id}>{t.name} v{t.version}</option>)}</select></Field>
            <Field id="c-peer" label="Peer feedback"><select id="c-peer" className="cs__input" value={f('cPeer')} onChange={(e) => setF('cPeer', e.target.value)}><option value="confidential">Confidential (averages only)</option><option value="identified">Named</option></select></Field>
            <Field id="c-min" label="Smallest group shown"><input id="c-min" type="number" min={2} max={20} className="cs__input" value={f('cMin') || '3'} onChange={(e) => setF('cMin', e.target.value)} /></Field>
            <Field id="c-started" label="Only people who started before (optional)"><input id="c-started" type="date" className="cs__input" value={f('cStarted')} onChange={(e) => setF('cStarted', e.target.value)} /></Field>
            {(['self', 'peer', 'manager', 'calibration'] as const).map((st) => <div key={st} className="pp2__roleEdit">
              <Field id={`${st}-o`} label={`${st === 'calibration' ? 'Calibration' : STAGE[st]} opens${st === 'manager' ? '' : ' (optional)'}`}><input id={`${st}-o`} type="date" className="cs__input" required={st === 'manager'} value={f(`${st}O`)} onChange={(e) => setF(`${st}O`, e.target.value)} /></Field>
              <Field id={`${st}-c`} label="closes"><input id={`${st}-c`} type="date" className="cs__input" required={st === 'manager'} value={f(`${st}C`)} onChange={(e) => setF(`${st}C`, e.target.value)} /></Field>
            </div>)}
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'cycle' || !published.length}>{published.length ? 'Create cycle' : 'Publish a template first'}</button>
          </form>
          <ul style={list}>{(cycles.data ?? []).map((c) => <li key={c.id} className="ig__row"><div className="ig__rowMain">
            <strong>{c.name}</strong><span className={`ig__status ${c.status === 'active' ? '' : 'ig__status--off'}`}>{c.status}</span>
            <p>{c.kind} · {c.template_name} v{c.template_version} · {c.participants} people · peer feedback {c.peer_mode}{c.needs_reviewer ? ` · ${c.needs_reviewer} need a reviewer` : ''}</p>
            <p>{Object.entries(c.stages).map(([k, w]) => `${STAGE[k] ?? 'Calibration'} ${day(w.opens)}–${day(w.closes)}`).join(' · ')}</p></div>
            <div className="pp2__roleEdit">
              {c.status === 'draft' && s.admin && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(c.id, async () => { const r = await postJson<{ eligible: number; excluded: number }>(`/api/appraisals/cycles/${c.id}/launch`, {}); return `Launched: ${r.eligible} people in, ${r.excluded} left out (each with the reason).`; })}>Launch</button>}
              {c.status === 'active' && <button type="button" className="cs__btn" onClick={() => { setCycleId(c.id); setTab('calibration'); }}>Calibrate</button>}
              {c.status === 'active' && s.admin && <button type="button" className="cs__btn" onClick={() => void act(c.id, async () => {
                try { const r = await postJson<{ published: number }>(`/api/appraisals/cycles/${c.id}/publish`, {}); return `Published ${r.published} results. Recommendations are waiting for HR.`; }
                catch (err) { if (err instanceof Error && /publish without them/.test(err.message)) setIncomplete(c.id); throw err; } })}>Publish results</button>}
              {c.status === 'active' && s.admin && incomplete === c.id && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(c.id, async () => { const r = await postJson<{ published: number; withoutReview: string[] }>(`/api/appraisals/cycles/${c.id}/publish`, { allowIncomplete: true }); setIncomplete(null); return `Published ${r.published} results. ${r.withoutReview.length} people had no manager review and got no result.`; })}>Publish without them</button>}
            </div>
          </li>)}</ul>
        </>}

        {tab === 'calibration' && <>
          <div className="ig__form"><Field id="cal-cycle" label="Cycle"><select id="cal-cycle" className="cs__input" value={cycleId} onChange={(e) => setCycleId(e.target.value)}><option value="">Choose…</option>{(cycles.data ?? []).filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field></div>
          {cal.error && <p className="ig__error">{cal.error}</p>}
          {cycleId && cal.data && <table className="ex__table"><thead><tr><th scope="col">Person</th><th scope="col">Self</th><th scope="col">Manager</th><th scope="col">Peers</th><th scope="col">Current</th><th scope="col"><span className="ex__sr">Actions</span></th></tr></thead>
            <tbody>{cal.data.map((p) => <tr key={p.id}>
              <td><strong>{p.name}</strong>{p.unit ? <><br /><small>{p.unit}</small></> : null}{p.needs_reviewer && <><br /><small className="ig__rowError">Needs a reviewer: {p.reviewer_note}</small></>}
                {p.adjustments.map((a, i) => <div key={i}><small>{score(a.original_score)} → {score(a.adjusted_score)} by {a.actor}: {a.reason} (evidence: {a.evidence})</small></div>)}
                {p.recommendation && <div><small>Recommends {p.recommendation.kind === 'promotion' ? 'a promotion' : 'a pay increase'}: {p.recommendation.detail}</small></div>}</td>
              <td>{p.self ? `${score(p.self.score)}${p.self.status === 'draft' ? ' (draft)' : ''}` : '—'}</td>
              <td>{p.manager ? `${score(p.manager.score)} · ${p.manager.reviewer}${p.manager.status === 'draft' ? ' (draft)' : ''}${!p.manager.active ? ' (no longer reviewing)' : ''}` : '—'}</td>
              <td>{p.peers}</td>
              <td><strong>{score(p.current)}</strong></td>
              <td><div className="pp2__roleEdit">
                {p.current !== null && <button type="button" className="cs__btn" onClick={() => setAsking({ id: p.id, label: `New score for ${p.name}, then " | " evidence " | " reason`, run: async (r) => { const [sc, ev, why] = r.split('|').map((x) => x.trim()); await postJson(`/api/appraisals/participants/${p.id}/calibrate`, { score: Number(sc), evidence: ev, reason: why }); return 'Adjusted. The original score is kept.'; } })}>Adjust</button>}
                <select aria-label={`Assign a reviewer for ${p.name}`} className="cs__input" value="" onChange={(e) => { const rid = e.target.value; if (!rid) return; setAsking({ id: p.id, label: 'Why this reviewer?', run: async (why) => { await postJson(`/api/appraisals/participants/${p.id}/reviewer`, { reviewerId: rid, stage: 'manager', reason: why }); return 'Reviewer assigned.'; } }); }}>
                  <option value="">{p.needs_reviewer ? 'Assign reviewer…' : 'Replace reviewer…'}</option>{people.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select>
              </div></td>
            </tr>)}</tbody></table>}
        </>}

        {tab === 'appeals' && <ul style={list}>
          {(appeals.data ?? []).map((a) => <li key={a.id} className="ig__row" style={{ flexWrap: 'wrap' }}><div className="ig__rowMain">
            <strong>{a.employee} · {a.cycle}</strong><span className={`ig__status ${a.status === 'open' ? 'ig__status--off' : ''}`}>{a.status}</span>
            <p>"{a.reason}" · score {score(a.calibrated_score)} · decide by {day(a.due_date)}{a.reviewer ? ` · reviewer ${a.reviewer}` : ' · no reviewer yet'}{a.outcome ? ` · ${a.outcome}` : ''}</p></div>
            {a.status === 'open' && <div className="pp2__roleEdit">
              {hr && s.admin && <select aria-label="Independent reviewer" className="cs__input" value="" onChange={(e) => { const rid = e.target.value; if (rid) void act(a.id, async () => { await postJson(`/api/appraisals/appeals/${a.id}/reviewer`, { reviewerId: rid }); return 'Independent reviewer assigned.'; }); }}><option value="">{a.reviewer ? 'Change reviewer…' : 'Assign reviewer…'}</option>{people.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select>}
              {a.reviewer_id && <>
                <button type="button" className="cs__btn" onClick={() => setAsking({ id: a.id, label: 'Why the score stands', run: async (n) => { await postJson(`/api/appraisals/appeals/${a.id}/decide`, { outcome: 'upheld', note: n }); return 'Appeal decided: score stands.'; } })}>Uphold</button>
                <button type="button" className="cs__btn" onClick={() => setAsking({ id: a.id, label: 'New score, then " | " and why', run: async (n) => { const [sc, why] = n.split('|').map((x) => x.trim()); await postJson(`/api/appraisals/appeals/${a.id}/decide`, { outcome: 'changed', newScore: Number(sc), note: why }); return 'Appeal decided: score changed, with the history kept.'; } })}>Change score</button>
              </>}
            </div>}
          </li>)}
          {appeals.data && !appeals.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No appeals.</p></div></li>}
        </ul>}

        {tab === 'recommendations' && <ul style={list}>
          {(recs.data ?? []).map((r) => <li key={r.id} className="ig__row"><div className="ig__rowMain">
            <strong>{r.employee}: {r.kind === 'promotion' ? 'promotion' : 'pay increase'}</strong><span className={`ig__status ${r.status === 'approved' ? '' : 'ig__status--off'}`}>{r.status}</span>
            <p>{r.detail} · {r.cycle}{r.decision_note ? ` · ${r.decision_note}` : ''}</p>
            {r.status === 'approved' && <p><small>Approved. Pay or role changes only when HR records them on the HR page.</small></p>}</div>
            {r.status === 'proposed' && s.admin && <div className="pp2__roleEdit">
              <button type="button" className="cs__btn cs__btn--primary" onClick={() => setAsking({ id: r.id, label: 'Approval note', run: async (n) => { const x = await postJson<{ next: string }>(`/api/appraisals/recommendations/${r.id}/decide`, { decision: 'approve', note: n }); return x.next; } })}>Approve</button>
              <button type="button" className="cs__btn" onClick={() => setAsking({ id: r.id, label: 'Why not?', run: async (n) => { await postJson(`/api/appraisals/recommendations/${r.id}/decide`, { decision: 'decline', note: n }); return 'Declined.'; } })}>Decline</button>
            </div>}
          </li>)}
          {recs.data && !recs.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No recommendations yet. They come from published manager reviews.</p></div></li>}
        </ul>}

        {tab === 'templates' && <>
          <form className="ig__form" style={{ gridTemplateColumns: '1fr' }} onSubmit={(e) => { e.preventDefault(); void act('tpl', async () => {
            const body = { id: f('tId') || undefined, name: f('tName'), scaleMin: Number(f('tMin') || 1), scaleMax: Number(f('tMax') || 5), naPolicy: f('tNa') || 'block', decimals: 2,
              sections: sections.map((x, i) => ({ key: `s${i + 1}`, title: x.title, kind: x.kind, weight: Number(x.weight || 0), criteria: parseCriteria(x.criteria) })) };
            const r = await postJson<{ id: string; version: number }>('/api/appraisals/templates', body); setF('tId', ''); return `Saved as draft version ${r.version}. Publish it to use it in a cycle.`; }); }}>
            <div className="ig__formTitle"><strong>{f('tId') ? 'Edit template' : 'New template'}</strong><p>Scored sections' weights must add up to 100. Inside a section, give every item a weight (adding up to 100) or none for equal weights: one item per line, "Item : 40" for a weight. Editing a published template makes a new version.</p></div>
            <div className="pp2__roleEdit">
              <Field id="t-name" label="Name"><input id="t-name" className="cs__input" required value={f('tName')} onChange={(e) => setF('tName', e.target.value)} /></Field>
              <Field id="t-min" label="Scale from"><input id="t-min" type="number" className="cs__input" value={f('tMin') || '1'} onChange={(e) => setF('tMin', e.target.value)} /></Field>
              <Field id="t-max" label="to"><input id="t-max" type="number" className="cs__input" value={f('tMax') || '5'} onChange={(e) => setF('tMax', e.target.value)} /></Field>
              <Field id="t-na" label="Not applicable"><select id="t-na" className="cs__input" value={f('tNa') || 'block'} onChange={(e) => setF('tNa', e.target.value)}><option value="block">Not allowed</option><option value="redistribute">Allowed; weight moves to the other items</option></select></Field>
            </div>
            {sections.map((x, i) => <fieldset key={i} style={{ border: '1px solid var(--line, #ddd)', borderRadius: 8, padding: 12 }}><legend>Section {i + 1}</legend>
              <div className="pp2__roleEdit">
                <Field id={`ts-title-${i}`} label="Title"><input id={`ts-title-${i}`} className="cs__input" value={x.title} onChange={(e) => setSections((all) => all.map((y, j) => j === i ? { ...y, title: e.target.value } : y))} /></Field>
                <Field id={`ts-kind-${i}`} label="Kind"><select id={`ts-kind-${i}`} className="cs__input" value={x.kind} onChange={(e) => setSections((all) => all.map((y, j) => j === i ? { ...y, kind: e.target.value as Section['kind'] } : y))}><option value="objectives">Objectives</option><option value="competencies">Competencies</option><option value="narrative">Comments only</option></select></Field>
                {x.kind !== 'narrative' && <Field id={`ts-weight-${i}`} label="Weight %"><input id={`ts-weight-${i}`} type="number" className="cs__input" value={x.weight} onChange={(e) => setSections((all) => all.map((y, j) => j === i ? { ...y, weight: e.target.value } : y))} /></Field>}
                <button type="button" className="cs__btn" onClick={() => setSections((all) => all.filter((_, j) => j !== i))}>Remove</button>
              </div>
              {x.kind !== 'narrative' && <Field id={`ts-crit-${i}`} label="Items to score"><textarea id={`ts-crit-${i}`} className="cs__input" rows={3} value={x.criteria} onChange={(e) => setSections((all) => all.map((y, j) => j === i ? { ...y, criteria: e.target.value } : y))} /></Field>}
            </fieldset>)}
            <div className="pp2__roleEdit">
              <button type="button" className="cs__btn" onClick={() => setSections((all) => [...all, { title: '', kind: 'competencies', weight: '0', criteria: '' }])}>Add section</button>
              <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'tpl'}>Save draft</button>
            </div>
          </form>
          <ul style={list}>{(templates.data ?? []).map((t) => <li key={t.id} className="ig__row"><div className="ig__rowMain">
            <strong>{t.name} v{t.version}</strong><span className={`ig__status ${t.status === 'published' ? '' : 'ig__status--off'}`}>{t.status}</span>
            <p>Scale {t.scale_min}–{t.scale_max} · {t.na_policy === 'redistribute' ? 'not applicable allowed' : 'every item scored'} · {t.sections.map((x) => x.kind === 'narrative' ? x.title : `${x.title} ${x.weight}%`).join(', ')}</p></div>
            <div className="pp2__roleEdit">
              <button type="button" className="cs__btn" onClick={() => { setFields({ tId: t.id, tName: t.name, tMin: String(t.scale_min), tMax: String(t.scale_max), tNa: t.na_policy }); setSections(t.sections.map((x) => ({ title: x.title, kind: x.kind, weight: String(x.weight), criteria: x.criteria.map((c) => c.weight !== undefined ? `${c.title} : ${c.weight}` : c.title).join('\n') }))); }}>Edit</button>
              {t.status === 'draft' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(t.id, async () => { await postJson(`/api/appraisals/templates/${t.id}/publish`, {}); return 'Published.'; })}>Publish</button>}
            </div>
          </li>)}</ul>
        </>}
      </section>
    </div>
  </div>;
}
