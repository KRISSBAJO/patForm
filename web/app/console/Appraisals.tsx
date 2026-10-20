'use client';

import './meetings.css';
import { EmptyState, ShellSync, type ModuleShell } from './module-shell';
import { useCallback, useEffect, useState } from 'react';
import { postJson } from './stepup';
import { GoalsWorkspace, type GoalSummary } from './GoalsWorkspace';

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
type Goal = GoalSummary;
type TeamGoal = GoalSummary;
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
const day = (v: string | null | undefined) => (v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toLocaleDateString([], { dateStyle: 'medium' }) : '');
const STAGE: Record<string, string> = { self: 'Self-assessment', peer: 'Peer feedback', manager: 'Manager review', additional: 'Additional review' };
const WINDOW: Record<string, string> = { open: 'Open', not_open: 'Not open yet', closed: 'Closed', none: '' };
const score = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : String(Number(v)));
const initials = (n: string) => n.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
const pillOf = (s: string) => ({ open: 'open', submitted: 'passed', draft: 'draft', approved: 'passed', achieved: 'passed', missed: 'failed', withdrawn: 'cancelled', done: 'passed', active: 'open', published: 'passed', closed: 'cancelled', not_open: 'draft', proposed: 'open', declined: 'failed', upheld: 'passed', changed: 'called', pending: 'open' }[s] ?? 'draft');
const Pill = ({ s, text }: { s: string; text?: string }) => <span className={`mx__pill mx__pill--${pillOf(s)}`}><i />{text ?? s.replace(/_/g, ' ')}</span>;
const Field = ({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) => <div className={`mx__field ${wide ? 'mx__field--wide' : ''}`}><label>{label}</label>{children}</div>;
const Avatar = ({ name, text }: { name: string; text?: string }) => <span className="mx__avatar mx__avatar--lg" style={{ marginLeft: 0, fontSize: text ? 12 : undefined }}>{text ?? initials(name)}</span>;
const Bar = ({ value, max }: { value: number; max: number }) => <div className="mx__voteBar" style={{ height: 6 }}><span className="is-for" style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`, background: 'var(--mod, #0e7c7b)' }} /></div>;

/** One criterion per line; "Title : 40" gives it a weight. */
const parseCriteria = (textValue: string): Criterion[] => textValue.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
  const m = l.match(/^(.*?)\s*:\s*(\d+(?:\.\d+)?)$/);
  return m ? { key: `c${i + 1}`, title: m[1]!, weight: Number(m[2]) } : { key: `c${i + 1}`, title: l };
});

export function AppraisalsView({ shell }: { shell?: ModuleShell } = {}) {
  const summary = useFeed<Summary>('/api/appraisals/summary');
  const s = summary.data;
  const hr = s?.hr === true;
  const [tab, setTab] = useState<Tab>('reviews');
  const pickTab = (id: Tab) => { setTab(id); shell?.onSection?.(id); };
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
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<null | 'goal' | 'dev' | 'cycle' | 'tpl'>(null);
  const [sections, setSections] = useState<{ title: string; kind: Section['kind']; weight: string; criteria: string }[]>([{ title: 'Objectives', kind: 'objectives', weight: '60', criteria: 'Delivered agreed objectives' }, { title: 'Behaviours', kind: 'competencies', weight: '40', criteria: 'Teamwork : 50\nOwnership : 50' }, { title: 'Comments', kind: 'narrative', weight: '0', criteria: '' }]);
  const [asking, setAsking] = useState<{ id: string; label: string; run: (answer: string) => Promise<string> } | null>(null);
  const [answer, setAnswer] = useState('');
  useEffect(() => {
    if (shell?.section && shell.section !== tab) { setTab(shell.section as Tab); setNote(null); setFields({}); setAsking(null); setAdding(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell?.section]);
  const [incomplete, setIncomplete] = useState<string | null>(null);
  const f = (k: string) => fields[k] ?? '';
  const setF = (k: string, v: string) => setFields((x) => ({ ...x, [k]: v }));

  const reloadAll = async () => { await Promise.all([summary.reload(), reviews.reload(), goals.reload(), results.reload(), dev.reload(), team.reload(), appeals.reload(), cycles.reload(), templates.reload(), recs.reload(), cal.reload()]); };
  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { const message = await work(); await reloadAll(); setNote({ text: message }); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } finally { setBusy(null); }
  };
  const ask = (id: string, label: string, run: (a: string) => Promise<string>) => { setAsking({ id, label, run }); setAnswer(''); };
  const loadForm = async (assignmentId: string) => {
    setOpenReview(assignmentId); setForm(null); setNote(null);
    try {
      const data = await get<Form>(`/api/appraisals/reviews/${assignmentId}`);
      setForm(data);
      setDraft({ responses: data.mine?.responses ?? {}, narrative: data.mine?.narrative ?? '', recKind: data.mine?.recommendation?.kind ?? '', recDetail: data.mine?.recommendation?.detail ?? '' });
    } catch (err) { setOpenReview(null); setNote({ text: err instanceof Error ? err.message : String(err), err: true }); }
  };

  if (summary.error) return <div className="mx"><div className="mx__card"><EmptyState icon="vote" title="Appraisals are not available" text={summary.error} /></div></div>;
  if (!s) return <div className="mx"><div className="mx__card"><div className="mx__empty">Loading…</div></div></div>;

  const isManager = (team.data ?? []).length > 0;
  const appealsForMe = (appeals.data ?? []).filter((a) => hr || a.status === 'open');
  const activeCycles = (cycles.data ?? []).filter((c) => c.status === 'active');
  const tabs: { id: Tab; name: string; count: number | null }[] = [
    { id: 'reviews', name: 'Reviews to write', count: s.reviewsToDo || null },
    { id: 'goals', name: 'My goals', count: s.goals || null },
    { id: 'results', name: 'My results', count: s.results || null },
    { id: 'development', name: 'My development', count: s.dev || null },
    ...(isManager || hr ? [{ id: 'team' as const, name: 'Team goals', count: (team.data ?? []).filter((g) => g.status === 'draft' || g.pending?.length).length || null }] : []),
    ...(hr ? [
      { id: 'cycles' as const, name: 'Cycles', count: activeCycles.length || null },
      { id: 'calibration' as const, name: 'Calibration', count: null },
    ] : []),
    ...(hr || appealsForMe.length ? [{ id: 'appeals' as const, name: 'Appeals', count: appealsForMe.filter((a) => a.status === 'open').length || null }] : []),
    ...(hr ? [
      { id: 'recommendations' as const, name: 'Recommendations', count: (recs.data ?? []).filter((r) => r.status === 'proposed').length || null },
      { id: 'templates' as const, name: 'Templates', count: null },
    ] : []),
  ];
  const people = (members.data ?? []).filter((m) => m.active);
  const published = (templates.data ?? []).filter((t) => t.status === 'published');
  const submitted = form?.mine?.status === 'submitted';

  const reviewForm = form && openReview && <div className="mx__card apr__review">
    <div className="mx__cardHead"><h3>{STAGE[form.stage] ?? form.stage}</h3><div className="mx__bar"><small>{form.template.name} v{form.template.version} · scale {form.template.scaleMin}–{form.template.scaleMax}{form.window !== 'open' ? ` · window ${WINDOW[form.window]?.toLowerCase() || 'not set'}` : ''}</small><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setOpenReview(null); setForm(null); }}>Close</button></div></div>
    <div className="mx__cardBody apr__reviewBody">
      <div className="apr__sheet">
        {submitted && <p className="mx__notice">Submitted. Score {score(form.mine!.score)}. It cannot be changed now.</p>}
        <small className="mx__tiny">{form.template.naPolicy === 'redistribute' ? '"Not applicable" moves that item\'s weight to the others; the calculation is kept with your review.' : 'Every item needs a score; "not applicable" is not allowed in this template.'}</small>
        {form.template.sections.map((sec) => <section key={sec.key} className="apr__section">
          <div className="apr__sectionHead"><strong>{sec.title}</strong>{sec.kind !== 'narrative' && <Pill s="draft" text={`${sec.weight}% of the score`} />}</div>
          {sec.kind === 'narrative' ? <textarea className="mx__input" rows={4} disabled={submitted} placeholder="Your comments" value={draft.narrative} onChange={(e) => setDraft((d) => ({ ...d, narrative: e.target.value }))} />
            : sec.criteria.map((c) => { const r = draft.responses[c.key] ?? {}; return <div key={c.key} className="apr__crit">
              <span className="apr__critTitle">{c.title}{c.weight !== undefined && <small className="mx__tiny">{c.weight}%</small>}</span>
              <div className="mx__segs apr__scale" role="radiogroup" aria-label={c.title}>
                {Array.from({ length: form.template.scaleMax - form.template.scaleMin + 1 }, (_, i) => form.template.scaleMin + i).map((n) => <button key={n} type="button" role="radio" aria-checked={r.score === n} className={`mx__seg ${r.score === n ? 'is-on' : ''}`} disabled={submitted || r.na} onClick={() => setDraft((d) => ({ ...d, responses: { ...d.responses, [c.key]: { ...r, score: r.score === n ? null : n } } }))}>{n}</button>)}
                {form.template.naPolicy === 'redistribute' && <button type="button" className={`mx__seg ${r.na ? 'is-on' : ''}`} disabled={submitted} onClick={() => setDraft((d) => ({ ...d, responses: { ...d.responses, [c.key]: { ...r, na: !r.na, score: !r.na ? null : r.score } } }))}>N/A</button>}
              </div>
            </div>; })}
        </section>)}
        {!form.template.sections.some((x) => x.kind === 'narrative') && <section className="apr__section"><div className="apr__sectionHead"><strong>Your comments</strong></div><textarea className="mx__input" rows={3} disabled={submitted} value={draft.narrative} onChange={(e) => setDraft((d) => ({ ...d, narrative: e.target.value }))} /></section>}
        {form.stage === 'manager' && !submitted && <section className="apr__section"><div className="apr__sectionHead"><strong>Recommend</strong><small className="mx__tiny">optional · HR decides separately</small></div>
          <div className="mx__segs">{[['', 'Nothing'], ['promotion', 'A promotion'], ['pay_increase', 'A pay increase']].map(([k, v]) => <button key={k} type="button" className={`mx__seg ${draft.recKind === k ? 'is-on' : ''}`} onClick={() => setDraft((d) => ({ ...d, recKind: k! }))}>{v}</button>)}</div>
          {draft.recKind && <input className="mx__input" style={{ marginTop: 8 }} placeholder="Details" value={draft.recDetail} onChange={(e) => setDraft((d) => ({ ...d, recDetail: e.target.value }))} />}
        </section>}
        {!submitted && <div className="mx__voteBtns">
          <button type="button" className="mx__btn" disabled={busy === 'review'} onClick={() => void act('review', async () => { const r = await postJson<{ score: number }>(`/api/appraisals/reviews/${openReview}`, { responses: draft.responses, narrative: draft.narrative, recommendation: draft.recKind ? { kind: draft.recKind, detail: draft.recDetail } : undefined, submit: true }); setOpenReview(null); setForm(null); return `Submitted. Score ${r.score}.`; })}>Submit review</button>
          <button type="button" className="mx__btn mx__btn--ghost" disabled={busy === 'review'} onClick={() => void act('review', async () => { await postJson(`/api/appraisals/reviews/${openReview}`, { responses: draft.responses, narrative: draft.narrative, recommendation: draft.recKind ? { kind: draft.recKind, detail: draft.recDetail } : undefined }); return 'Draft saved.'; })}>Save draft</button>
        </div>}
      </div>
      <aside className="apr__side">
        {form.goals && <div className="apr__sideBlock"><span className="mx__eyebrow">Their goals</span>{form.goals.length ? form.goals.map((g, i) => <div key={i} className="apr__sideGoal"><strong>{g.title}</strong><Bar value={g.progress} max={100} /><small className="mx__tiny">{g.progress}% · weight {Number(g.weight)} · {g.status}{g.evidence ? ` · ${g.evidence}` : ''}</small></div>) : <small className="mx__tiny">No goals recorded.</small>}</div>}
        {form.self !== undefined && <div className="apr__sideBlock"><span className="mx__eyebrow">Self-assessment</span>{form.self ? <><strong className="apr__sideScore">{score(form.self.score)}</strong>{form.self.narrative && <small>“{form.self.narrative}”</small>}</> : <small className="mx__tiny">Nothing to show yet.</small>}</div>}
        {form.peers && <div className="apr__sideBlock"><span className="mx__eyebrow">Peer feedback</span><small>{!form.peers.released || form.peers.suppressed ? form.peers.note : form.peers.mode === 'confidential' ? `From ${form.peers.count} people (averages only): ${Object.entries(form.peers.averages ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'no scored items'}` : (form.peers.responses ?? []).map((r) => `${r.reviewer}${r.narrative ? ` — “${r.narrative}”` : ''}`).join('; ') || 'none'}</small></div>}
      </aside>
    </div>
  </div>;

  return <div className="mx">
    <ShellSync sections={tabs} onSections={shell?.onSections} />
    {!shell && <div className="mx__segs" style={{ marginBottom: 14 }}>{tabs.map((t) => <button key={t.id} type="button" className={`mx__seg ${tab === t.id ? 'is-on' : ''}`} onClick={() => { pickTab(t.id); setNote(null); setFields({}); setAsking(null); }}>{t.name}{t.count ? ` · ${t.count}` : ''}</button>)}</div>}

    <section className="mx__band">
      <div className="mx__bandGrid">
        <div>
          <div className="mx__eyebrow">Goals &amp; appraisals</div>
          <h2 className="mx__bandTitle">{s.reviewsToDo ? `${s.reviewsToDo} review${s.reviewsToDo === 1 ? '' : 's'} to write` : hr ? 'Cycles, calibration and development' : 'Your goals, reviews and development'}</h2>
          <p className="mx__bandSub">Reviews, goals and results. A rating never changes pay by itself.</p>
          <div className="mx__bandActions">
            <button type="button" className="mx__btn mx__btn--light" onClick={() => pickTab('reviews')}>Write a review</button>
            <button type="button" className="mx__btn mx__btn--outline" onClick={() => { pickTab('goals'); setAdding('goal'); }}>+ Goal</button>
            {hr && <button type="button" className="mx__btn mx__btn--outline" onClick={() => pickTab('cycles')}>Cycles</button>}
          </div>
        </div>
        <div className={`mx__kpi ${s.reviewsToDo ? 'mx__kpi--live' : ''}`}><span>Reviews to write</span><strong>{s.reviewsToDo}</strong><small>{hr ? `${activeCycles.length} active cycle${activeCycles.length === 1 ? '' : 's'}` : 'self, peer or manager'}</small></div>
        <div className="mx__kpi"><span>My goals</span><strong>{s.goals}</strong><small>{(goals.data ?? []).filter((g) => g.status === 'approved').length} approved</small></div>
        <div className={`mx__kpi ${hr && appealsForMe.some((a) => a.status === 'open') ? 'mx__kpi--live' : ''}`}><span>{hr ? 'Waiting on HR' : 'Development'}</span><strong>{hr ? appealsForMe.filter((a) => a.status === 'open').length + (recs.data ?? []).filter((r) => r.status === 'proposed').length : s.dev}</strong><small>{hr ? 'appeals and recommendations' : 'open actions in your plan'}</small></div>
      </div>
    </section>

    {note && <p className={`mx__notice ${note.err ? 'mx__notice--err' : ''}`} style={{ marginTop: 16 }} role="status">{note.text}</p>}
    {asking && <form className="mx__ask" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); const a = answer.trim(); if (!a) return; const job = asking; setAsking(null); setAnswer(''); void act(job.id, () => job.run(a)); }}>
      <label>{asking.label}</label><input required autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} />
      <div className="mx__voteBtns" style={{ marginTop: 0 }}><button type="submit" className="mx__btn mx__btn--sm">Save</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setAsking(null); setAnswer(''); }}>Cancel</button></div>
    </form>}

    <div className="mx__stack" style={{ marginTop: 18 }}>
      {tab === 'reviews' && <>
        {reviewForm}
        {!openReview && <div className="mx__card"><div className="mx__cardHead"><h3>Reviews</h3><small>{(reviews.data ?? []).filter((a) => a.status !== 'submitted').length} to write</small></div>
          <ul className="mx__list" style={{ marginTop: 10 }}>{(reviews.data ?? []).map((a) => <li key={a.id}>
            <Avatar name={a.stage === 'self' ? 'Me' : a.person} text={a.stage === 'self' ? 'ME' : undefined} />
            <div className="mx__main"><strong>{a.stage === 'self' ? 'Your self-assessment' : `${STAGE[a.stage]} for ${a.person}`}</strong><small>{a.cycle}{a.status === 'draft' ? ' · draft saved' : ''}</small></div>
            <Pill s={a.status === 'submitted' ? 'submitted' : a.window} text={a.status === 'submitted' ? 'Submitted' : WINDOW[a.window] || 'No window'} />
            <button type="button" className={`mx__btn mx__btn--sm ${a.window === 'open' && a.status !== 'submitted' ? '' : 'mx__btn--ghost'}`} onClick={() => void loadForm(a.id)}>{a.status === 'submitted' ? 'View' : 'Open'}</button>
          </li>)}{reviews.data && !reviews.data.length && <li><EmptyState icon="vote" title="No reviews for you to write" text="When a cycle opens a self-assessment, peer feedback or manager review for you, it appears here with its window." /></li>}</ul></div>}
      </>}

      {tab === 'goals' && <GoalsWorkspace mode="mine" goals={goals.data ?? []} startCreate={adding === 'goal'} onCreateClose={() => setAdding(adding === 'goal' ? null : 'goal')} onChanged={reloadAll} />}

      {tab === 'results' && <div className="mx__card"><div className="mx__cardHead"><h3>My results</h3><small>published reviews</small></div>
        <div className="ex__records">{(results.data ?? []).map((r) => <div key={r.participant_id} className="ex__record">
          <div className="ex__recordHead">
            <span className="apr__ring"><strong>{score(r.calibrated_score)}</strong><small>of {Number(r.scale_max)}</small></span>
            <div className="mx__main">
              <strong>{r.cycle} {r.acknowledged_at ? <Pill s="done" text="Received" /> : <Pill s="open" text="To acknowledge" />}{r.appeal_status !== 'none' && <Pill s={r.appeal_status} text={`Appeal ${r.appeal_status}`} />}</strong>
              <small>Published {day(r.published_at)}{r.calibrated_score !== r.manager_score ? ` · manager's score ${score(r.manager_score)}, changed in calibration or on appeal` : ''}{r.acknowledged_at ? ` · received ${day(r.acknowledged_at)}` : ''}{r.appeal_outcome ? ` · ${r.appeal_outcome}` : ''}</small>
              {r.summary && <small>“{r.summary}”</small>}
            </div>
          </div>
          <div className="ex__recordBtns">
            {!r.acknowledged_at && <button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(r.participant_id, async () => { const x = await postJson<{ statement: string }>(`/api/appraisals/participants/${r.participant_id}/acknowledge`, {}); return `Recorded: "${x.statement}"`; })}>I have received it</button>}
            {r.appeal_status !== 'open' && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(r.participant_id, 'What are you appealing, and why?', async (why) => { const x = await postJson<{ due: string }>(`/api/appraisals/participants/${r.participant_id}/appeal`, { reason: why }); return `Appeal opened. An independent reviewer decides by ${day(x.due)}.`; })}>Appeal</button>}
          </div>
        </div>)}
        {results.data && !results.data.length && <EmptyState icon="search" title="No published reviews yet" text="When HR publishes a cycle, your result appears here with the score and how it was reached. You confirm you received it, or appeal." />}</div>
      </div>}

      {tab === 'development' && <div className="mx__card"><div className="mx__cardHead"><h3>My development plan</h3><button type="button" className="mx__btn mx__btn--sm" onClick={() => setAdding(adding === 'dev' ? null : 'dev')}>{adding === 'dev' ? 'Close' : '+ Add'}</button></div>
        {adding === 'dev' && <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('dev', async () => { await postJson('/api/appraisals/development', { kind: f('dKind') || 'action', title: f('dTitle'), dueDate: f('dDate') || undefined }); setFields({}); setAdding(null); return 'Added to your plan.'; }); }}>
          <Field label="Kind"><div className="mx__segs">{[['action', 'Action'], ['training', 'Training'], ['checkin', 'Check-in']].map(([k, v]) => <button key={k} type="button" className={`mx__seg ${(f('dKind') || 'action') === k ? 'is-on' : ''}`} onClick={() => setF('dKind', k!)}>{v}</button>)}</div></Field>
          <Field label="By"><input type="date" value={f('dDate')} onChange={(e) => setF('dDate', e.target.value)} /></Field>
          <Field label="What" wide><input required value={f('dTitle')} onChange={(e) => setF('dTitle', e.target.value)} /></Field>
          <div className="mx__field--wide"><button type="submit" className="mx__btn" disabled={busy === 'dev'}>Add</button><small className="mx__tiny" style={{ marginLeft: 12 }}>Each is closed with what shows it is done.</small></div>
        </form></div>}
        <ul className="mx__list">{(dev.data ?? []).map((d) => <li key={d.id} className={d.status === 'done' ? 'is-done' : ''}>
          <span className={`mx__avatar ${d.status === 'done' ? 'mx__avatar--on' : ''}`} style={{ marginLeft: 0, fontSize: 10 }}>{d.kind === 'training' ? 'TR' : d.kind === 'checkin' ? 'CI' : 'AC'}</span>
          <div className="mx__main"><strong>{d.title}</strong><small>{d.kind} · {d.due_date ? `by ${day(d.due_date)}` : 'no date'}{d.owner ? ` · ${d.owner}` : ''}{d.evidence ? ` · ${d.evidence}` : ''}</small></div>
          <Pill s={d.status} />
          {d.status === 'open' && <button type="button" className="mx__btn mx__btn--sm" onClick={() => ask(d.id, 'What shows it is done?', async (ev) => { await postJson(`/api/appraisals/development/${d.id}/close`, { evidence: ev }); return 'Closed.'; })}>Mark done</button>}
        </li>)}{dev.data && !dev.data.length && <li><EmptyState icon="check" title="Nothing in your plan yet" text="Actions, training and check-ins agreed with your manager live here." action={{ label: 'Add one', onClick: () => setAdding('dev') }} /></li>}</ul>
      </div>}

      {tab === 'team' && <GoalsWorkspace mode="team" goals={team.data ?? []} onChanged={reloadAll} />}

      {tab === 'cycles' && <div className="mx__card"><div className="mx__cardHead"><h3>Review cycles</h3><button type="button" className="mx__btn mx__btn--sm" disabled={!published.length} title={published.length ? undefined : 'Publish a template first'} onClick={() => setAdding(adding === 'cycle' ? null : 'cycle')}>{adding === 'cycle' ? 'Close' : published.length ? '+ New cycle' : 'Publish a template first'}</button></div>
        {adding === 'cycle' && <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('cycle', async () => {
          const stages: Record<string, { opens: string; closes: string }> = {};
          for (const st of ['self', 'peer', 'manager', 'calibration']) if (f(`${st}O`) && f(`${st}C`)) stages[st] = { opens: f(`${st}O`), closes: f(`${st}C`) };
          await postJson('/api/appraisals/cycles', { name: f('cName'), kind: f('cKind') || 'annual', templateId: f('cTpl'), stages, peerMode: f('cPeer') || 'confidential', minCohort: Number(f('cMin') || 3), eligibility: { startedBefore: f('cStarted') || undefined } });
          setFields({}); setAdding(null); return 'Cycle created as a draft. Launch it to take the list of people and start the reviews.'; }); }}>
          <Field label="Name"><input required value={f('cName')} onChange={(e) => setF('cName', e.target.value)} /></Field>
          <Field label="Template"><select required value={f('cTpl')} onChange={(e) => setF('cTpl', e.target.value)}><option value="">Choose…</option>{published.map((t) => <option key={t.id} value={t.id}>{t.name} v{t.version}</option>)}</select></Field>
          <Field label="Kind" wide><div className="mx__segs">{['annual', 'quarterly', 'probation', 'project', 'continuous'].map((k) => <button key={k} type="button" className={`mx__seg ${(f('cKind') || 'annual') === k ? 'is-on' : ''}`} onClick={() => setF('cKind', k)}>{k}</button>)}</div></Field>
          <Field label="Peer feedback"><div className="mx__segs">{[['confidential', 'Confidential (averages only)'], ['identified', 'Named']].map(([k, v]) => <button key={k} type="button" className={`mx__seg ${(f('cPeer') || 'confidential') === k ? 'is-on' : ''}`} onClick={() => setF('cPeer', k!)}>{v}</button>)}</div></Field>
          <Field label="Smallest group shown"><input type="number" min={2} max={20} value={f('cMin') || '3'} onChange={(e) => setF('cMin', e.target.value)} /></Field>
          <Field label="Only people who started before (optional)"><input type="date" value={f('cStarted')} onChange={(e) => setF('cStarted', e.target.value)} /></Field>
          <div className="mx__field--wide apr__stages">{(['self', 'peer', 'manager', 'calibration'] as const).map((st) => <div key={st} className="apr__stage"><strong>{st === 'calibration' ? 'Calibration' : STAGE[st]}{st !== 'manager' && <small className="mx__tiny"> optional</small>}</strong><div className="apr__stageDates"><input type="date" aria-label={`${st} opens`} required={st === 'manager'} value={f(`${st}O`)} onChange={(e) => setF(`${st}O`, e.target.value)} /><span>to</span><input type="date" aria-label={`${st} closes`} required={st === 'manager'} value={f(`${st}C`)} onChange={(e) => setF(`${st}C`, e.target.value)} /></div></div>)}</div>
          <div className="mx__field--wide"><button type="submit" className="mx__btn" disabled={busy === 'cycle' || !published.length}>Create cycle</button><small className="mx__tiny" style={{ marginLeft: 12 }}>The cycle keeps a copy of the template. Self-assessment must close before the manager review closes.</small></div>
        </form></div>}
        <div className="ex__records">{(cycles.data ?? []).map((c) => <div key={c.id} className="ex__record">
          <div className="ex__recordHead">
            <Avatar name={c.name} text={c.kind.slice(0, 2).toUpperCase()} />
            <div className="mx__main"><strong>{c.name} <Pill s={c.status} />{c.needs_reviewer > 0 && <Pill s="failed" text={`${c.needs_reviewer} need a reviewer`} />}</strong><small>{c.kind} · {c.template_name} v{c.template_version} · peer feedback {c.peer_mode}</small>
              <div className="apr__timeline">{Object.entries(c.stages).map(([k, w]) => <span key={k} className="apr__tl"><strong>{STAGE[k] ?? 'Calibration'}</strong><small>{day(w.opens)} – {day(w.closes)}</small></span>)}</div></div>
            <div className="ex__amount"><strong>{c.participants}</strong><small>people</small></div>
          </div>
          <div className="ex__recordBtns">
            {c.status === 'draft' && s.admin && <button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(c.id, async () => { const r = await postJson<{ eligible: number; excluded: number }>(`/api/appraisals/cycles/${c.id}/launch`, {}); return `Launched: ${r.eligible} people in, ${r.excluded} left out (each with the reason).`; })}>Launch</button>}
            {c.status === 'active' && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setCycleId(c.id); pickTab('calibration'); }}>Calibrate</button>}
            {c.status === 'active' && s.admin && <button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(c.id, async () => {
              try { const r = await postJson<{ published: number }>(`/api/appraisals/cycles/${c.id}/publish`, {}); return `Published ${r.published} results. Recommendations are waiting for HR.`; }
              catch (err) { if (err instanceof Error && /publish without them/.test(err.message)) setIncomplete(c.id); throw err; } })}>Publish results</button>}
            {c.status === 'active' && s.admin && incomplete === c.id && <button type="button" className="mx__btn mx__btn--danger mx__btn--sm" onClick={() => void act(c.id, async () => { const r = await postJson<{ published: number; withoutReview: string[] }>(`/api/appraisals/cycles/${c.id}/publish`, { allowIncomplete: true }); setIncomplete(null); return `Published ${r.published} results. ${r.withoutReview.length} people had no manager review and got no result.`; })}>Publish without them</button>}
          </div>
        </div>)}
        {cycles.data && !cycles.data.length && <EmptyState icon="calendar" title="No cycles yet" text="A cycle takes a published template, a set of windows and the people in scope. Launch it to start the reviews." action={published.length ? { label: 'New cycle', onClick: () => setAdding('cycle') } : { label: 'Templates', onClick: () => pickTab('templates') }} />}</div>
      </div>}

      {tab === 'calibration' && <div className="mx__card"><div className="mx__cardHead"><h3>Calibration</h3><div className="mx__segs">{activeCycles.map((c) => <button key={c.id} type="button" className={`mx__seg ${cycleId === c.id ? 'is-on' : ''}`} onClick={() => setCycleId(c.id)}>{c.name}</button>)}</div></div>
        {cal.error && <p className="mx__notice mx__notice--err" style={{ margin: '0 20px 12px' }}>{cal.error}</p>}
        {!cycleId && <EmptyState icon="search" title={activeCycles.length ? 'Choose a cycle' : 'No active cycle'} text={activeCycles.length ? 'Pick a cycle above to see every person’s self, manager and peer scores side by side.' : 'Calibration needs an active cycle.'} />}
        {cycleId && cal.data && <div className="mx__cardBody" style={{ paddingTop: 0 }}><table className="ex__table apr__cal"><thead><tr><th scope="col">Person</th><th scope="col">Self</th><th scope="col">Manager</th><th scope="col">Peers</th><th scope="col">Current</th><th scope="col"><span className="ex__sr">Actions</span></th></tr></thead>
          <tbody>{cal.data.map((p) => <tr key={p.id}>
            <td><div className="apr__calPerson"><Avatar name={p.name} /><div><strong>{p.name}</strong>{p.unit && <small className="mx__tiny">{p.unit}</small>}{p.needs_reviewer && <small className="ex__bank is-off">Needs a reviewer: {p.reviewer_note}</small>}
              {p.adjustments.map((a, i) => <small key={i} className="mx__tiny">{score(a.original_score)} → {score(a.adjusted_score)} by {a.actor}: {a.reason} (evidence: {a.evidence})</small>)}
              {p.recommendation && <small className="mx__tiny">Recommends {p.recommendation.kind === 'promotion' ? 'a promotion' : 'a pay increase'}: {p.recommendation.detail}</small>}</div></div></td>
            <td>{p.self ? `${score(p.self.score)}${p.self.status === 'draft' ? ' (draft)' : ''}` : '—'}</td>
            <td>{p.manager ? <>{score(p.manager.score)}<br /><small className="mx__tiny">{p.manager.reviewer}{p.manager.status === 'draft' ? ' (draft)' : ''}{!p.manager.active ? ' (no longer reviewing)' : ''}</small></> : '—'}</td>
            <td>{p.peers}</td>
            <td><strong className="apr__calScore">{score(p.current)}</strong></td>
            <td><div className="mx__voteBtns" style={{ marginTop: 0 }}>
              {p.current !== null && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(p.id, `New score for ${p.name}, then " | " evidence " | " reason`, async (r) => { const [sc, ev, why] = r.split('|').map((x) => x.trim()); await postJson(`/api/appraisals/participants/${p.id}/calibrate`, { score: Number(sc), evidence: ev, reason: why }); return 'Adjusted. The original score is kept.'; })}>Adjust</button>}
              <select aria-label={`Assign a reviewer for ${p.name}`} className="mx__input" style={{ height: 32, fontSize: 12 }} value="" onChange={(e) => { const rid = e.target.value; if (!rid) return; ask(p.id, 'Why this reviewer?', async (why) => { await postJson(`/api/appraisals/participants/${p.id}/reviewer`, { reviewerId: rid, stage: 'manager', reason: why }); return 'Reviewer assigned.'; }); }}>
                <option value="">{p.needs_reviewer ? 'Assign reviewer…' : 'Replace reviewer…'}</option>{people.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select>
            </div></td>
          </tr>)}</tbody></table></div>}
      </div>}

      {tab === 'appeals' && <div className="mx__card"><div className="mx__cardHead"><h3>Appeals</h3><small>{appealsForMe.filter((a) => a.status === 'open').length} open</small></div>
        <div className="ex__records">{(appeals.data ?? []).map((a) => <div key={a.id} className="ex__record">
          <div className="ex__recordHead">
            <Avatar name={a.employee} />
            <div className="mx__main"><strong>{a.employee} <Pill s={a.status} /></strong><small>{a.cycle} · decide by {day(a.due_date)}{a.reviewer ? ` · reviewer ${a.reviewer}` : ' · no reviewer yet'}{a.outcome ? ` · ${a.outcome}` : ''}</small><small>“{a.reason}”</small></div>
            <div className="ex__amount"><strong>{score(a.calibrated_score)}</strong><small>{a.new_score ? `now ${score(a.new_score)}` : 'score'}</small></div>
          </div>
          {a.status === 'open' && <div className="ex__recordBtns">
            {hr && s.admin && <select aria-label="Independent reviewer" className="mx__input" style={{ height: 32, fontSize: 12, width: 'auto' }} value="" onChange={(e) => { const rid = e.target.value; if (rid) void act(a.id, async () => { await postJson(`/api/appraisals/appeals/${a.id}/reviewer`, { reviewerId: rid }); return 'Independent reviewer assigned.'; }); }}><option value="">{a.reviewer ? 'Change reviewer…' : 'Assign reviewer…'}</option>{people.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select>}
            {a.reviewer_id && <>
              <button type="button" className="mx__btn mx__btn--sm" onClick={() => ask(a.id, 'Why the score stands', async (n) => { await postJson(`/api/appraisals/appeals/${a.id}/decide`, { outcome: 'upheld', note: n }); return 'Appeal decided: score stands.'; })}>Uphold</button>
              <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(a.id, 'New score, then " | " and why', async (n) => { const [sc, why] = n.split('|').map((x) => x.trim()); await postJson(`/api/appraisals/appeals/${a.id}/decide`, { outcome: 'changed', newScore: Number(sc), note: why }); return 'Appeal decided: score changed, with the history kept.'; })}>Change score</button>
            </>}
          </div>}
        </div>)}
        {appeals.data && !appeals.data.length && <EmptyState icon="inbox" title="No appeals" text="When someone appeals a published result, an independent reviewer is assigned and decides by the due date." />}</div>
      </div>}

      {tab === 'recommendations' && <div className="mx__card"><div className="mx__cardHead"><h3>Recommendations</h3><small>from published manager reviews</small></div>
        <div className="ex__records">{(recs.data ?? []).map((r) => <div key={r.id} className="ex__record">
          <div className="ex__recordHead">
            <Avatar name={r.employee} />
            <div className="mx__main"><strong>{r.employee} <Pill s={r.status} /></strong><small>{r.kind === 'promotion' ? 'Promotion' : 'Pay increase'} · {r.cycle}{r.decision_note ? ` · ${r.decision_note}` : ''}</small><small>{r.detail}</small>{r.status === 'approved' && <small className="mx__tiny">Approved. Pay or role changes only when HR records them on the HR page.</small>}</div>
          </div>
          {r.status === 'proposed' && s.admin && <div className="ex__recordBtns">
            <button type="button" className="mx__btn mx__btn--sm" onClick={() => ask(r.id, 'Approval note', async (n) => { const x = await postJson<{ next: string }>(`/api/appraisals/recommendations/${r.id}/decide`, { decision: 'approve', note: n }); return x.next; })}>Approve</button>
            <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(r.id, 'Why not?', async (n) => { await postJson(`/api/appraisals/recommendations/${r.id}/decide`, { decision: 'decline', note: n }); return 'Declined.'; })}>Decline</button>
          </div>}
        </div>)}
        {recs.data && !recs.data.length && <EmptyState icon="send" title="No recommendations yet" text="Managers can recommend a promotion or pay increase in their review. They land here once results are published; approving one only clears HR to act." />}</div>
      </div>}

      {tab === 'templates' && <div className="mx__card"><div className="mx__cardHead"><h3>Review templates</h3><button type="button" className="mx__btn mx__btn--sm" onClick={() => { if (adding === 'tpl') { setAdding(null); setF('tId', ''); } else setAdding('tpl'); }}>{adding === 'tpl' ? 'Close' : '+ New template'}</button></div>
        {adding === 'tpl' && <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('tpl', async () => {
          const body = { id: f('tId') || undefined, name: f('tName'), scaleMin: Number(f('tMin') || 1), scaleMax: Number(f('tMax') || 5), naPolicy: f('tNa') || 'block', decimals: 2,
            sections: sections.map((x, i) => ({ key: `s${i + 1}`, title: x.title, kind: x.kind, weight: Number(x.weight || 0), criteria: parseCriteria(x.criteria) })) };
          const r = await postJson<{ id: string; version: number }>('/api/appraisals/templates', body); setF('tId', ''); setAdding(null); return `Saved as draft version ${r.version}. Publish it to use it in a cycle.`; }); }}>
          <div className="mx__field--wide"><strong>{f('tId') ? 'Edit template' : 'New template'}</strong><small className="mx__tiny" style={{ display: 'block' }}>Scored sections' weights must add up to 100. Inside a section, give every item a weight (adding up to 100) or none for equal weights: one item per line, "Item : 40" for a weight. Editing a published template makes a new version.</small></div>
          <Field label="Name"><input required value={f('tName')} onChange={(e) => setF('tName', e.target.value)} /></Field>
          <Field label="Scale"><div className="apr__stageDates"><input type="number" aria-label="Scale from" value={f('tMin') || '1'} onChange={(e) => setF('tMin', e.target.value)} /><span>to</span><input type="number" aria-label="Scale to" value={f('tMax') || '5'} onChange={(e) => setF('tMax', e.target.value)} /></div></Field>
          <Field label="Not applicable" wide><div className="mx__segs">{[['block', 'Not allowed'], ['redistribute', 'Allowed; weight moves to the other items']].map(([k, v]) => <button key={k} type="button" className={`mx__seg ${(f('tNa') || 'block') === k ? 'is-on' : ''}`} onClick={() => setF('tNa', k!)}>{v}</button>)}</div></Field>
          {sections.map((x, i) => <div key={i} className="mx__field--wide apr__tplSection">
            <div className="apr__tplRow">
              <input aria-label={`Section ${i + 1} title`} placeholder="Section title" value={x.title} onChange={(e) => setSections((all) => all.map((y, j) => j === i ? { ...y, title: e.target.value } : y))} />
              <div className="mx__segs">{[['objectives', 'Objectives'], ['competencies', 'Competencies'], ['narrative', 'Comments only']].map(([k, v]) => <button key={k} type="button" className={`mx__seg ${x.kind === k ? 'is-on' : ''}`} onClick={() => setSections((all) => all.map((y, j) => j === i ? { ...y, kind: k as Section['kind'] } : y))}>{v}</button>)}</div>
              {x.kind !== 'narrative' && <input aria-label={`Section ${i + 1} weight`} type="number" placeholder="Weight %" className="pr__num" value={x.weight} onChange={(e) => setSections((all) => all.map((y, j) => j === i ? { ...y, weight: e.target.value } : y))} />}
              <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setSections((all) => all.filter((_, j) => j !== i))}>Remove</button>
            </div>
            {x.kind !== 'narrative' && <textarea aria-label={`Section ${i + 1} items`} rows={3} placeholder={'One item per line, e.g.\nTeamwork : 50\nOwnership : 50'} value={x.criteria} onChange={(e) => setSections((all) => all.map((y, j) => j === i ? { ...y, criteria: e.target.value } : y))} />}
          </div>)}
          <div className="mx__field--wide mx__voteBtns" style={{ marginTop: 0 }}>
            <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setSections((all) => [...all, { title: '', kind: 'competencies', weight: '0', criteria: '' }])}>+ Add section</button>
            <button type="submit" className="mx__btn" disabled={busy === 'tpl'}>Save draft</button>
          </div>
        </form></div>}
        <ul className="mx__list">{(templates.data ?? []).map((t) => <li key={t.id}>
          <span className="mx__avatar" style={{ marginLeft: 0, fontSize: 10 }}>v{t.version}</span>
          <div className="mx__main"><strong>{t.name}</strong><small>Scale {t.scale_min}–{t.scale_max} · {t.na_policy === 'redistribute' ? 'not applicable allowed' : 'every item scored'} · {t.sections.map((x) => x.kind === 'narrative' ? x.title : `${x.title} ${x.weight}%`).join(', ')}</small></div>
          <Pill s={t.status} />
          <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setFields({ tId: t.id, tName: t.name, tMin: String(t.scale_min), tMax: String(t.scale_max), tNa: t.na_policy }); setSections(t.sections.map((x) => ({ title: x.title, kind: x.kind, weight: String(x.weight), criteria: x.criteria.map((c) => c.weight !== undefined ? `${c.title} : ${c.weight}` : c.title).join('\n') }))); setAdding('tpl'); }}>Edit</button>
          {t.status === 'draft' && <button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(t.id, async () => { await postJson(`/api/appraisals/templates/${t.id}/publish`, {}); return 'Published.'; })}>Publish</button>}
        </li>)}{templates.data && !templates.data.length && <li><EmptyState icon="templates" title="No templates yet" text="A template sets the sections, items and weights a review is scored on. Publish one, then build a cycle on it." action={{ label: 'New template', onClick: () => setAdding('tpl') }} /></li>}</ul>
      </div>}
    </div>
  </div>;
}
