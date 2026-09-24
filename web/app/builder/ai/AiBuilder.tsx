'use client';

import { useEffect, useState } from 'react';
import './ai.css';

type Job = { id: string; status: 'queued' | 'running' | 'ready' | 'failed'; stage: 'waiting' | 'generating' | 'checking' | 'saving'; process_key: string; process_name?: string | null; created_at: string; draft_id?: string | null; error?: string | null };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'include', cache: 'no-store', headers: { 'content-type': 'application/json' }, ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.reason || body.error || `Request failed (${response.status})`);
  return body as T;
}

const example = 'A parent requests a place for a student. Collect the student and guardian details, emergency contact and documents. School administration checks the information, requests corrections if needed, then approves or rejects the request and sends the guardian an update.';
const asKey = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);

export function AiBuilder() {
  const [description, setDescription] = useState('');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const saved = sessionStorage.getItem('patform:new-process-description');
    if (saved) { setDescription(saved); sessionStorage.removeItem('patform:new-process-description'); }
    const existing = new URLSearchParams(window.location.search).get('job');
    if (existing && /^[0-9a-f-]{36}$/.test(existing)) {
      setJobId(existing);
      const previous = sessionStorage.getItem(`patform:ai-prompt:${existing}`);
      if (previous) setDescription(previous);
    }
  }, []);

  useEffect(() => {
    if (!jobId || job?.status === 'ready' || job?.status === 'failed') return;
    let live = true;
    const poll = async () => {
      try {
        const result = await api<Job>(`/api/builder/ai-jobs/${jobId}`);
        if (live) { setJob(result); setKey(result.process_key); if (result.process_name) setName(result.process_name); setError(''); }
      } catch (e) { if (live) setError((e as Error).message); }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => { live = false; window.clearInterval(timer); };
  }, [jobId, job?.status]);

  useEffect(() => {
    if (!job || job.status === 'ready' || job.status === 'failed') return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - new Date(job.created_at).getTime()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status, job?.created_at]);

  const activeStep = job?.status === 'ready' ? 4 : job?.status === 'queued' || !job ? 1 : job.stage === 'generating' ? 2 : job.stage === 'checking' ? 3 : 4;
  const needsReview = job?.status === 'ready' && !!job.error;
  const reviewCount = job?.error?.match(/(\d+) (?:validation error|sample check)/)?.[1];
  const progressTitle = job?.status === 'ready' ? job.error ? 'Draft saved for review' : 'Your draft is ready' : job?.status === 'failed' ? 'Draft could not be saved' : job?.status === 'queued' || !job ? 'Request queued' : job.stage === 'checking' ? 'Checking the draft' : job.stage === 'saving' ? 'Saving your draft' : 'AI is drafting';
  const stageDetail = !job || job.status === 'queued' ? 'Waiting for the drafting worker' : job.status === 'failed' ? 'Generation stopped' : job.status === 'ready' ? 'Ready to open in the builder' : job.stage === 'checking' ? 'Checking the form and workflow' : job.stage === 'saving' ? 'Saving your private draft' : 'Generating questions and workflow';

  const ready = /^[a-z][a-z0-9_]{2,}$/.test(key) && description.trim().length >= 20 && description.length <= 8000 && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError(''); setJob(null);
    try {
      const result = await api<{ jobId: string }>('/api/builder/ai-jobs', { method: 'POST',
        body: JSON.stringify({ key, name: name.trim() || undefined, description: description.trim() }) });
      sessionStorage.setItem(`patform:ai-prompt:${result.jobId}`, description.trim());
      setJobId(result.jobId);
      window.history.replaceState({}, '', `/builder/ai?job=${result.jobId}`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return <main className="aiPage">
    <header className="aiPage__top"><nav className="aiPage__breadcrumb" aria-label="Breadcrumb"><a className="aiPage__brand" href="/builder"><span className="aiPage__brandMark">✦</span> PatForm</a><span aria-hidden="true">/</span><a href="/builder">Processes</a><span aria-hidden="true">/</span><strong>AI draft</strong></nav><div className="aiPage__topActions"><span className="aiPage__engine"><span/> AI builder</span><a href="/builder" className="aiPage__back">Back to builder</a></div></header>
    <div className="aiPage__body">
      <div className="aiPage__grid">
        <div className="aiPage__main">
        <section className="aiPage__card" aria-label="Describe your process">
          <div className="aiPage__cardHead"><span className="aiPage__number">01</span><div><h2>What should happen?</h2><p>Include who submits, what they provide, who reviews it, and the final outcome.</p></div></div>
          <div className="aiPage__labelRow"><label className="aiPage__label" htmlFor="ai-description">Describe the process</label><span>{description.trim().length} / 8,000 characters</span></div>
          <textarea id="ai-description" value={description} maxLength={8000} onChange={(e) => setDescription(e.target.value)} disabled={!!jobId && job?.status !== 'failed'} placeholder="For example: A parent applies for a school place. Collect student details and documents. The school checks the application, asks for missing details, then approves or declines it and emails the parent." rows={8}/>
          <div className="aiPage__promptFoot"><button type="button" onClick={() => { setDescription(example); if (!name) setName('Student registration'); if (!keyEdited) setKey('student_registration'); }} disabled={!!jobId && job?.status !== 'failed'}>Use an example</button><span>Be specific about decisions and outcomes.</span></div>
        </section>
        <section className="aiPage__card" aria-label="Name your draft">
          <div className="aiPage__cardHead"><span className="aiPage__number">02</span><div><h2>Name the draft</h2><p>You can change it later.</p></div></div>
          <div className="aiPage__fields"><label>Process name <span>optional</span><input value={name} maxLength={120} onChange={(e) => { setName(e.target.value); if (!keyEdited) setKey(asKey(e.target.value)); }} placeholder="Student registration" disabled={!!jobId && job?.status !== 'failed'}/></label><label>Short link key <span>required</span><input value={key} onChange={(e) => { setKeyEdited(true); setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')); }} placeholder="student_registration" disabled={!!jobId && job?.status !== 'failed'}/></label></div>
          <p className="aiPage__hint">The key becomes part of the form link. Use letters, numbers and underscores.</p>
          {error && <div className="aiPage__error" role="alert">{error}</div>}
          {!jobId && <div className="aiPage__submit"><span>Only you can review the draft until you publish it.</span><button type="button" disabled={!ready} onClick={() => void submit()}>{busy ? 'Starting…' : 'Create draft'} <span aria-hidden="true">→</span></button></div>}
        </section>
          {jobId && <section className={`aiPage__progress${job?.status === 'failed' ? ' aiPage__progress--failed' : needsReview ? ' aiPage__progress--review' : ''}`} aria-label="Draft progress">
            <div className="aiPage__progressHeading"><span className={`aiPage__progressIcon ${job?.status === 'ready' || job?.status === 'failed' ? 'done' : ''}`} aria-hidden="true">{job?.status === 'ready' ? job.error ? '!' : '✓' : job?.status === 'failed' ? '!' : '✳'}</span><div><strong role="status" aria-live="polite">{progressTitle}</strong><p>{job?.status === 'failed' ? job.error : needsReview ? `${reviewCount ?? 'Some'} checks need fixes before publishing. Open the draft to review them.` : job?.status === 'ready' ? 'Open the draft to review and edit it.' : 'You can leave this page and return with this link.'}</p></div></div>
            {job?.status !== 'failed' && <div className="aiPage__steps" aria-label="Creation progress">{['Request saved','AI drafting','Workflow checks','Private draft'].map((label, i) => {
              const warning = needsReview && i === 2;
              const done = job?.status === 'ready' ? !warning : i + 1 < activeStep;
              const active = job?.status !== 'ready' && i + 1 === activeStep;
              return <div className={`aiPage__step ${warning ? 'isWarning' : done ? 'isDone' : active ? 'isActive' : ''}`} key={label}><span aria-hidden="true">{warning ? '!' : done ? '✓' : i + 1}</span><small>{warning ? 'Checks need fixes' : label}</small></div>;
            })}</div>}
            {job?.status !== 'ready' && job?.status !== 'failed' && <div className="aiPage__activity" role="progressbar" aria-label={stageDetail} aria-valuetext={stageDetail}><span/></div>}
            <div className="aiPage__progressFoot">{job?.status === 'running' || job?.status === 'queued' ? <span>Working for {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}{elapsed >= 90 ? ' · Taking longer than expected' : ''}</span> : job?.status === 'failed' ? <span>No draft was saved</span> : null}{job?.status === 'ready' && job.draft_id && <a href={`/builder?draft=${job.draft_id}`}>Open draft →</a>}{job?.status === 'failed' && <button type="button" onClick={() => { setJobId(null); setJob(null); window.history.replaceState({}, '', '/builder/ai'); }}>Try again</button>}</div>
          </section>}
        </div>
        <aside className="aiPage__side"><section className="aiPage__aside"><div className="aiPage__asideTop"><span className="aiPage__orb">✳</span><span>IN YOUR DRAFT</span></div><h2>Form and workflow</h2><p>AI creates a private draft from your description.</p><ol><li><strong>Questions</strong><span>Fields and pages for the person submitting.</span></li><li><strong>Decisions and work</strong><span>Approvals, routing and notifications.</span></li><li><strong>Checks before publishing</strong><span>Review issues in the builder.</span></li></ol>{jobId && <div className="aiPage__live"><span>LIVE STATUS</span><strong>{progressTitle}</strong><small>{stageDetail}</small></div>}</section><div className="aiPage__sideNote"><strong>Need custom logic?</strong><span>Open the draft to refine questions, rules and approvals before publishing.</span></div></aside>
      </div>
    </div>
  </main>;
}
