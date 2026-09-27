'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import './improve.css';
import { RepairReview, type ReviewDecision } from './RepairReview';

type Blueprint = { key: string; name: string; roles?: { key: string; name: string }[]; data?: { fields?: { key: string; label: string }[] }; workflow?: { states?: { key: string; name: string }[]; transitions?: { key: string; name?: string }[]; tasks?: { key: string; name: string }[]; approvals?: { key: string; name: string }[] }; communications?: { email?: { key: string; name: string }[] }; outputs?: { documents?: { key: string; name: string }[] }; tests?: { key: string }[]; experience?: { pages?: { key: string; title: string }[] } };
type Draft = { id: string; processName: string; blueprint: Blueprint; revision: number };
type Diagnostic = { code: string; severity: 'error' | 'warning'; message: string };
type Job = { id: string; status: 'queued' | 'running' | 'ready' | 'failed'; stage: string; error?: string | null; source_revision: number; source_blueprint: Blueprint; proposal?: Blueprint | null; review?: { automaticRepair?: boolean; ready?: boolean; changes?: {at:string;change:string}[]; questions?: string[]; decisions?: ReviewDecision[]; provider?: string; diagnostics: Diagnostic[]; tests: { passed: number; total: number; failures: { name: string; failures: string[] }[] } } | null; applied_at?: string | null };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.reason || body.error || `Request failed (${response.status})`);
  return body as T;
}

function changes(before: Blueprint, after: Blueprint) {
  const collections: { label: string; a?: { key: string }[]; b?: { key: string }[] }[] = [
    { label: 'Fields', a: before.data?.fields, b: after.data?.fields },
    { label: 'Pages', a: before.experience?.pages, b: after.experience?.pages },
    { label: 'States', a: before.workflow?.states, b: after.workflow?.states },
    { label: 'Rules', a: before.workflow?.transitions, b: after.workflow?.transitions },
    { label: 'Tasks', a: before.workflow?.tasks, b: after.workflow?.tasks },
    { label: 'Approvals', a: before.workflow?.approvals, b: after.workflow?.approvals },
    { label: 'Roles and access', a: before.roles, b: after.roles },
    { label: 'Emails', a: before.communications?.email, b: after.communications?.email },
    { label: 'Documents', a: before.outputs?.documents, b: after.outputs?.documents },
    { label: 'Sample tests', a: before.tests, b: after.tests },
  ];
  return collections.map(({ label, a = [], b = [] }) => {
    const oldItems = new Map(a.map((item) => [item.key, item]));
    const oldKeys = new Set(oldItems.keys());
    const newKeys = new Set(b.map((item) => item.key));
    return { label, added: b.filter((item) => !oldKeys.has(item.key)).map((item) => item.key),
      changed: b.filter((item) => oldKeys.has(item.key) && JSON.stringify(oldItems.get(item.key)) !== JSON.stringify(item)).map((item) => item.key),
      removed: a.filter((item) => !newKeys.has(item.key)).map((item) => item.key), before: a.length, after: b.length };
  });
}

export function ImproveDraft() {
  const [staff, setStaff] = useState<Record<string,string>>({});
  const [automatic, setAutomatic] = useState(false);
  const autoStarted = useRef(false);
  const [draftId, setDraftId] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setRequest(params.get('request')??'');
    const id = params.get('draft') ?? '';
    setAutomatic(params.get('repair') === '1');
    const existingJob = params.get('job') ?? '';
    setDraftId(id);
    setJobId(existingJob);
    if (!/^[0-9a-f-]{36}$/.test(id)) { setError('Choose a draft in the builder first.'); return; }
    void api<Draft>(`/api/builder/drafts/${id}`).then(setDraft).catch((cause) => setError((cause as Error).message));
  }, []);

  useEffect(() => {
    if (!jobId || job?.status === 'ready' || job?.status === 'failed') return;
    let live = true;
    const poll = async () => {
      try { const next = await api<Job>(`/api/builder/ai-jobs/${jobId}`); if (live) { setJob(next); setError(''); } }
      catch (cause) { if (live) setError((cause as Error).message); }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => { live = false; window.clearInterval(timer); };
  }, [jobId, job?.status]);

  useEffect(() => {
    if (automatic && draft && !jobId && !autoStarted.current) { autoStarted.current = true; void start(); }
  }, [automatic, draft, jobId]);
  useEffect(() => {
    if (automatic && job?.status === 'ready' && job.review?.automaticRepair && job.review.ready && job.applied_at) {
      window.location.href = `/builder?draft=${draftId}&repairJob=${job.id}`;
    }
  }, [automatic, job]);

  const diff = useMemo(() => job?.proposal && job.source_blueprint ? changes(job.source_blueprint, job.proposal) : [], [job]);
  const errors = job?.review?.diagnostics.filter((item) => item.severity === 'error') ?? [];
  const warnings = job?.review?.diagnostics.filter((item) => item.severity === 'warning') ?? [];

  async function start() {
    if (!draft || (!automatic && request.trim().length < 20)) return;
    setBusy(true); setError('');
    try {
      const queued = await api<{ jobId: string }>(`/api/builder/drafts/${draft.id}/improve`, { method: 'POST', body: JSON.stringify({ request: request.trim(), repair: automatic, staff, baseRevision:job?.source_revision ?? draft.revision }) });
      setJob(null); setJobId(queued.jobId);
      window.history.replaceState({}, '', `/builder/improve?draft=${draft.id}&job=${queued.jobId}${automatic ? '&repair=1' : ''}`);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function apply() {
    if (!job || job.status !== 'ready' || job.applied_at) return;
    setBusy(true); setError('');
    try {
      await api(`/api/builder/ai-jobs/${job.id}/apply`, { method: 'POST', body: '{}' });
      window.location.href = `/builder?draft=${draftId}`;
    } catch (cause) { setError((cause as Error).message); setBusy(false); }
  }

  return <main className={`improve${automatic ? ' improve--repair' : ''}`}>
    <header className="improve__top"><a href={`/builder?draft=${draftId}`}>← Back to draft</a><span>PatForm · {automatic ? 'Repair draft' : 'AI revision'}</span></header>
    <div className="improve__wrap">
      <span className="improve__eyebrow">{automatic ? 'REPAIR AND RETEST' : 'IMPROVE AN EXISTING PROCESS'}</span>
      <h1>{draft?.processName ?? 'Loading draft…'}</h1>
      <p className="improve__lead">{automatic ? 'Repair checks the form and its tests, fixes clear mistakes, then saves the verified result to your private draft.' : 'Describe what to change. AI uses this draft as its starting point and proposes a revision for you to review.'}</p>
      {error && <p className="improve__error" role="alert">{error}</p>}
      {automatic && error && !jobId && draft && <button disabled={busy} onClick={() => void start()}>Try repair again</button>}
      {!jobId && !automatic && <section className="improve__card"><label htmlFor="improve-request">What should change?</label>
        <textarea id="improve-request" value={request} maxLength={8000} rows={9} onChange={(event) => setRequest(event.target.value)} placeholder="For example: Add a finance review when the total exceeds $2,500. Keep the existing approval steps and questions."/>
        <div className="improve__foot"><span>{request.length} / 8,000</span><button disabled={busy || !draft || request.trim().length < 20} onClick={() => void start()}>{busy ? 'Starting…' : 'Create proposal'}</button></div>
      </section>}
      {(automatic || jobId) && !job && !error && <section className="improve__card" role="status">Checking your draft…</section>}
      {job && job.status !== 'ready' && job.status !== 'failed' && <section className="improve__card" role="status"><div className="improve__spinner"/> <strong>{automatic ? 'Repairing and retesting your draft' : job.stage === 'checking' ? 'Checking the proposed workflow' : 'AI is revising your draft'}</strong><p>You can leave and return using this page link.</p></section>}
      {job?.status === 'failed' && <section className="improve__card improve__card--warning"><h2>{automatic ? 'Repair could not finish' : 'AI could not make a proposal'}</h2><p>{job.error}</p><button onClick={() => { autoStarted.current = false; setJob(null); setJobId(''); window.history.replaceState({}, '', `/builder/improve?draft=${draftId}${automatic ? '&repair=1' : ''}`); }}>Try again</button></section>}
      {automatic && job?.status === 'ready' && <section className="improve__card" role="status">
        <h2>{job.review?.ready ? 'Checks passed. Saving repairs…' : job.review?.decisions?.length ? 'A few choices to finish your draft' : 'A decision or further repair is needed'}</h2>
        <p>{job.review?.tests.passed ?? 0} of {job.review?.tests.total ?? 0} tests passed.</p>
        {!job.review?.ready && <><p>Your choices will be applied together, then checked and tested again before saving.</p>
          {!!job.review?.decisions?.length && <div className="improve__staff"><RepairReview key={job.id} draftId={draftId} decisions={job.review.decisions} answers={staff} setAnswers={setStaff} busy={busy} apply={()=>void start()}/></div>}
          {job.review?.questions?.map((question,index)=><p key={index}>{question}</p>)}
          {!!job.review?.tests.failures.length && <details><summary>Test details</summary>{job.review.tests.failures.map(item=><p key={item.name}>{item.name}: {item.failures.join('; ')}</p>)}</details>}
          <a href={`/builder?draft=${draftId}`}>Return to draft</a></>}
        <details><summary>Repairs checked</summary>{job.review?.changes?.map((change,index)=><p key={index}>{change.change}</p>)}</details>
      </section>}
      {!automatic && job?.status === 'ready' && job.proposal && <>
        <section className="improve__card"><h2>Proposed changes</h2><p>Review what AI added or removed before applying it to your private draft.</p>
          <div className="improve__diff">{diff.map((item) => <div key={item.label}><strong>{item.label}</strong><span>{item.before} → {item.after}</span>{item.added.length > 0 && <small>Added: {item.added.join(', ')}</small>}{item.changed.length > 0 && <small>Changed: {item.changed.join(', ')}</small>}{item.removed.length > 0 && <small className="improve__removed">Removed: {item.removed.join(', ')}</small>}</div>)}</div>
          <details><summary>Review complete proposed blueprint</summary><pre>{JSON.stringify(job.proposal, null, 2)}</pre></details>
        </section>
        <section className="improve__card"><h2>Workflow checks</h2><p>{errors.length} errors · {warnings.length} warnings · {errors.length ? 'Tests wait until errors are fixed' : `${job.review?.tests.passed ?? 0} of ${job.review?.tests.total ?? 0} tests passed`}{job.review?.provider ? ` · Proposed by ${job.review.provider}` : ''}</p>
          {(errors.length > 0 || !!job.review?.tests.failures.length) && <p>This proposal needs more work. You can describe the change differently to get a new proposal, or apply it privately and fix the listed issues in Builder.</p>}
          {errors.map((item, index) => <p className="improve__issue improve__issue--error" key={`e${index}`}><strong>{item.code}</strong> {item.message}</p>)}
          {job.review?.tests.failures.map((item) => <p className="improve__issue improve__issue--error" key={item.name}><strong>{item.name}</strong> {item.failures.join('; ')}</p>)}
          {warnings.length > 0 && <details><summary>Read {warnings.length} warnings</summary>{warnings.map((item, index) => <p className="improve__issue" key={`w${index}`}><strong>{item.code}</strong> {item.message}</p>)}</details>}
          <div className="improve__foot"><span>{job.applied_at ? 'Applied to your private draft' : 'The live process has not changed.'}</span><div className="improve__actions"><a href={`/builder/improve?draft=${draftId}`}>Create another proposal</a><button disabled={busy || !!job.applied_at} onClick={() => void apply()}>{busy ? 'Applying…' : errors.length || job.review?.tests.failures.length ? 'Apply to draft for fixes' : 'Apply to private draft'}</button></div></div>
        </section>
      </>}
    </div>
  </main>;
}
