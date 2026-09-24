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
  const progressTitle = job?.status === 'ready' ? job.error ? 'Your draft needs a review' : 'Your private draft is ready' : job?.status === 'failed' ? 'We could not create a safe draft' : job?.status === 'queued' || !job ? 'Your request is in the queue' : job.stage === 'checking' ? 'Checking the questions and workflow' : job.stage === 'saving' ? 'Saving your private draft' : 'AI is creating your process';

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
    <header className="aiPage__top"><a className="aiPage__brand" href="/builder"><span className="aiPage__brandMark">✓</span> PatForm <span>Builder</span></a><a href="/builder" className="aiPage__back">← Back to processes</a></header>
    <div className="aiPage__body">
      <div className="aiPage__intro"><span className="aiPage__eyebrow"><span className="aiPage__spark">✳</span> AI PROCESS STUDIO</span><h1>Tell us what needs to happen.<br/><em>We’ll build a starting point.</em></h1><p>Describe the form, decisions and work that follows. PatForm drafts the whole process, checks its rules, and gives you a draft to review before anything goes live.</p></div>
      <div className="aiPage__grid">
        <section className="aiPage__card" aria-label="Describe your process">
          <div className="aiPage__cardHead"><span className="aiPage__number">01</span><div><h2>Describe your process</h2><p>Write naturally. Include who fills it in, who decides, and what happens after approval.</p></div></div>
          <label className="aiPage__label" htmlFor="ai-description">What do you need?</label>
          <textarea id="ai-description" value={description} maxLength={8000} onChange={(e) => setDescription(e.target.value)} disabled={!!jobId && job?.status !== 'failed'} placeholder="For example: A parent applies for a school place. Collect student details and documents. The school checks the application, asks for missing details, then approves or declines it and emails the parent." rows={11}/>
          <div className="aiPage__promptFoot"><button type="button" onClick={() => { setDescription(example); if (!name) setName('Student registration'); if (!keyEdited) setKey('student_registration'); }} disabled={!!jobId && job?.status !== 'failed'}>Use an example</button><span>{description.trim().length} / 8,000 characters</span></div>
          <div className="aiPage__divider"/>
          <div className="aiPage__cardHead"><span className="aiPage__number">02</span><div><h2>Name your process</h2><p>You can change its questions and rules later in the builder.</p></div></div>
          <div className="aiPage__fields"><label>Process name <span>optional</span><input value={name} maxLength={120} onChange={(e) => { setName(e.target.value); if (!keyEdited) setKey(asKey(e.target.value)); }} placeholder="Student registration" disabled={!!jobId && job?.status !== 'failed'}/></label><label>Short link key <span>required</span><input value={key} onChange={(e) => { setKeyEdited(true); setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')); }} placeholder="student_registration" disabled={!!jobId && job?.status !== 'failed'}/></label></div>
          <p className="aiPage__hint">The key appears in the form link. Use lowercase letters, numbers and underscores.</p>
          {error && <div className="aiPage__error" role="alert">{error}</div>}
          {!jobId && <div className="aiPage__submit"><span>Creates a private draft. You decide when to publish.</span><button type="button" disabled={!ready} onClick={() => void submit()}>{busy ? 'Starting…' : 'Create my draft'} <span aria-hidden="true">→</span></button></div>}
          {jobId && <div className={`aiPage__progress ${job?.status === 'failed' ? 'aiPage__progress--failed' : ''}`}>
            <div className="aiPage__progressHeading"><span className={`aiPage__progressIcon ${job?.status === 'ready' || job?.status === 'failed' ? 'done' : ''}`} aria-hidden="true">{job?.status === 'ready' ? job.error ? '!' : '✓' : job?.status === 'failed' ? '!' : '✳'}</span><div><strong role="status" aria-live="polite">{progressTitle}</strong><p>{job?.status === 'failed' ? job.error : job?.status === 'ready' ? job.error ? `Saved privately. ${job.error} Open the draft and run its sample checks before publishing.` : 'Saved in your workspace. Open it to review and edit before publishing.' : 'We are preparing the form, decisions and checks. You can leave and return with this link.'}</p></div></div>
            {job?.status !== 'failed' && <div className="aiPage__steps" aria-label="Creation progress">{['Request saved','AI drafting','Workflow checks','Private draft'].map((label, i) => <div className={`aiPage__step ${i + 1 < activeStep || job?.status === 'ready' ? 'isDone' : i + 1 === activeStep ? 'isActive' : ''}`} key={label}><span aria-hidden="true">{i + 1 < activeStep || job?.status === 'ready' ? '✓' : i + 1}</span><small>{label}</small></div>)}</div>}
            <div className="aiPage__progressFoot">{job?.status === 'running' || job?.status === 'queued' ? <span>Working for {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} · {elapsed >= 90 ? 'Taking longer than expected. You can leave and return with this link.' : 'Creating and checking your draft'}</span> : <span>{job?.status === 'ready' ? job.error ? 'Needs sample-check fixes before launch' : 'Ready to review' : 'No draft was published'}</span>}{job?.status === 'ready' && job.draft_id && <a href={`/builder?draft=${job.draft_id}`}>Open draft →</a>}{job?.status === 'failed' && <button type="button" onClick={() => { setJobId(null); setJob(null); window.history.replaceState({}, '', '/builder/ai'); }}>Try again</button>}</div>
          </div>}
        </section>
        <aside className="aiPage__aside"><div className="aiPage__asideTop"><span className="aiPage__orb">✳</span><span>HOW IT WORKS</span></div><h2>More than a form.</h2><p>AI proposes a complete flow, then PatForm checks the parts that must work together.</p><ol><li><strong>Questions and pages</strong><span>What people fill in, including private fields.</span></li><li><strong>Decisions and handoffs</strong><span>Approvals, tasks, reminders and messages.</span></li><li><strong>Checks before launch</strong><span>Rules and sample scenarios are tested.</span></li></ol><div className="aiPage__asideNote">Your process stays in draft until you review and publish it.</div></aside>
      </div>
    </div>
  </main>;
}
