'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ReauthDialog, postJson } from '../console/stepup';
import { PasskeysPanel } from '../console/Passkeys';
import { Mark } from '@/components/icons';

/**
 * Patform on a phone.
 *
 * Five things, one thumb: what needs me, a receipt I can snap now, leave,
 * and nothing else. Everything here goes through the same API the console
 * uses, under the same session, so this screen can do nothing the console
 * would refuse. Building a process, calibrating a review, changing a
 * setting — that is laptop work and stays in the console.
 */

interface Home {
  approvals: { processKey: string; processName: string; instanceId: string; reference: string; approvalKey: string; approvalName: string; stateName: string; waitingHours: number; late: boolean; summary: string; signatureRequired: boolean }[];
  tasks: { processKey: string; processName: string; instanceId: string; reference: string; taskKey: string; taskName: string; late: boolean; summary: string }[];
  late: number;
  capture: { processKey: string; name: string; publicId: string; fieldKey: string; fieldLabel: string }[];
  leave: null | {
    toApprove: { id: string; who: string; type: string; start: string; end: string; days: number; reason: string | null }[];
    mine: { balances: { type: string; left: number | null; unlimited: boolean }[]; requests: { id: string; type: string; start_date: string; end_date: string; days: number; status: string }[] } | null;
  };
}

interface Me { actor: { display_name: string }; modules?: string[] }

class SignedOut extends Error {}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (res.status === 401) throw new SignedOut();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

const hours = (h: number) => (h < 1 ? 'just now' : h < 24 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
const toSignIn = () => window.location.assign('/console?next=%2Fgo');

/* ------------------------------------------------------------- receipts */

function Snap({ targets, onDone }: { targets: Home['capture']; onDone: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState(targets[0]?.publicId ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const chosen = targets.find((t) => t.publicId === target) ?? targets[0];
  if (!chosen) return null;

  const upload = async (file: File) => {
    setBusy('Reading the photo…');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read that photo.'));
        reader.readAsDataURL(file);
      });
      setBusy('Starting your claim…');
      const draft = await postJson<{ token: string }>(`/api/forms/${chosen.publicId}/draft`, { answers: {}, page: 0 });
      setBusy('Uploading the receipt…');
      const uploaded = await postJson<{ reference: string }>(`/api/forms/${chosen.publicId}/receipts`, {
        token: draft.token, fieldKey: chosen.fieldKey, filename: file.name || 'receipt.jpg', base64: dataUrl.split(',')[1],
      });
      await postJson(`/api/forms/${chosen.publicId}/draft`, { token: draft.token, answers: { [chosen.fieldKey]: uploaded.reference }, page: 0 });
      window.location.assign(`/f/${chosen.publicId}?resume=${encodeURIComponent(draft.token)}`);
    } catch (err) {
      setBusy(null);
      onDone(err instanceof Error ? err.message : 'That did not work.');
    }
  };

  return (
    <section className="go__snap">
      <input ref={input} type="file" accept="image/*,application/pdf" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
      <button type="button" className="go__snapBtn" disabled={Boolean(busy)} onClick={() => input.current?.click()}>
        <span className="go__snapIcon" aria-hidden="true">📷</span>
        <span>
          <strong>{busy ?? 'Snap a receipt'}</strong>
          <small>{busy ? 'Hold on' : `Starts ${chosen.name} with the photo attached`}</small>
        </span>
      </button>
      {targets.length > 1 && (
        <label className="go__select">
          <span>For</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>{targets.map((t) => <option key={t.publicId} value={t.publicId}>{t.name}</option>)}</select>
        </label>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ approvals */

function Approval({ a, onDone }: { a: Home['approvals'][number]; onDone: (message: string, refresh?: boolean) => void }) {
  const [mode, setMode] = useState<'idle' | 'reject' | 'busy'>('idle');
  const [reason, setReason] = useState('');
  const decide = async (decision: 'approved' | 'rejected') => {
    setMode('busy');
    try {
      await postJson(`/api/records/${a.instanceId}/decide`, { approvalKey: a.approvalKey, decision, reason: reason || undefined });
      onDone(decision === 'approved' ? `${a.reference} approved.` : `${a.reference} rejected.`, true);
    } catch (err) {
      setMode('idle');
      onDone(err instanceof Error ? err.message : 'That did not work.');
    }
  };
  return (
    <article className={`go__card ${a.late ? 'is-late' : ''}`}>
      <header>
        <span className="go__ref mono">{a.reference}</span>
        <span className={`go__age ${a.late ? 'is-late' : ''}`}>{a.late ? 'LATE · ' : ''}{hours(a.waitingHours)}</span>
      </header>
      <h3>{a.summary}</h3>
      <p>{a.processName} · {a.approvalName} · {a.stateName}</p>
      {a.signatureRequired ? (
        <a className="go__btn go__btn--secondary" href={`/console?record=${a.instanceId}`}>Review and sign in the console</a>
      ) : mode === 'reject' ? (
        <div className="go__reject">
          <input className="go__input" placeholder="Why? (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="go__row">
            <button type="button" className="go__btn go__btn--danger" onClick={() => void decide('rejected')}>Reject</button>
            <button type="button" className="go__btn go__btn--secondary" onClick={() => setMode('idle')}>Back</button>
          </div>
        </div>
      ) : (
        <div className="go__row">
          <button type="button" className="go__btn go__btn--primary" disabled={mode === 'busy'} onClick={() => void decide('approved')}>{mode === 'busy' ? 'Working…' : 'Approve'}</button>
          <button type="button" className="go__btn go__btn--secondary" disabled={mode === 'busy'} onClick={() => setMode('reject')}>Reject</button>
          <a className="go__link" href={`/console?record=${a.instanceId}`}>Open</a>
        </div>
      )}
    </article>
  );
}

/* ---------------------------------------------------------------- leave */

function LeaveToApprove({ r, onDone }: { r: NonNullable<Home['leave']>['toApprove'][number]; onDone: (message: string, refresh?: boolean) => void }) {
  const [mode, setMode] = useState<'idle' | 'reject' | 'busy'>('idle');
  const [note, setNote] = useState('');
  const decide = async (decision: 'approve' | 'reject') => {
    setMode('busy');
    try {
      await postJson(`/api/hr/leave/${r.id}/decide`, { decision, note: note || undefined });
      onDone(`${r.who}'s leave ${decision === 'approve' ? 'approved' : 'declined'}.`, true);
    } catch (err) {
      setMode('idle');
      onDone(err instanceof Error ? err.message : 'That did not work.');
    }
  };
  return (
    <article className="go__card">
      <header><span className="go__ref mono">LEAVE</span><span className="go__age">{r.days} day{r.days === 1 ? '' : 's'}</span></header>
      <h3>{r.who} · {r.type}</h3>
      <p>{r.start} to {r.end}{r.reason ? ` · ${r.reason}` : ''}</p>
      {mode === 'reject' ? (
        <div className="go__reject">
          <input className="go__input" placeholder="Say why" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="go__row">
            <button type="button" className="go__btn go__btn--danger" disabled={!note.trim()} onClick={() => void decide('reject')}>Decline</button>
            <button type="button" className="go__btn go__btn--secondary" onClick={() => setMode('idle')}>Back</button>
          </div>
        </div>
      ) : (
        <div className="go__row">
          <button type="button" className="go__btn go__btn--primary" disabled={mode === 'busy'} onClick={() => void decide('approve')}>{mode === 'busy' ? 'Working…' : 'Approve'}</button>
          <button type="button" className="go__btn go__btn--secondary" disabled={mode === 'busy'} onClick={() => setMode('reject')}>Decline</button>
        </div>
      )}
    </article>
  );
}

function RequestLeave({ onDone }: { onDone: (message: string, refresh?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [types, setTypes] = useState<{ key: string; name: string }[]>([]);
  const [form, setForm] = useState({ type: '', startDate: '', endDate: '', reason: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || types.length) return;
    void get<{ key: string; name: string }[] | { types: { key: string; name: string }[] }>('/api/hr/leave/types')
      .then((t) => { const list = Array.isArray(t) ? t : t.types; setTypes(list); setForm((f) => ({ ...f, type: f.type || list[0]?.key || '' })); })
      .catch(() => setTypes([{ key: 'annual', name: 'Annual leave' }]));
  }, [open, types.length]);
  if (!open) return <button type="button" className="go__btn go__btn--secondary go__btn--wide" onClick={() => setOpen(true)}>Request leave</button>;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await postJson<{ days: number; approver: string }>('/api/hr/leave', form);
      setOpen(false);
      setForm({ type: form.type, startDate: '', endDate: '', reason: '' });
      onDone(`Asked for ${r.days} day${r.days === 1 ? '' : 's'}. It goes to ${r.approver}.`, true);
    } catch (err) {
      onDone(err instanceof Error ? err.message : 'That did not work.');
    } finally { setBusy(false); }
  };
  return (
    <form className="go__form" onSubmit={(e) => void submit(e)}>
      <label className="go__select"><span>Type</span><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{types.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>
      <div className="go__row">
        <label className="go__field"><span>From</span><input className="go__input" type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></label>
        <label className="go__field"><span>To</span><input className="go__input" type="date" required value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></label>
      </div>
      <input className="go__input" placeholder="Reason (optional)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      <div className="go__row">
        <button type="submit" className="go__btn go__btn--primary" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
        <button type="button" className="go__btn go__btn--secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

/* --------------------------------------------------------- notifications */

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function Nudges() {
  const [state, setState] = useState<'checking' | 'unsupported' | 'off' | 'on' | 'denied' | 'needs-install' | 'install'>('checking');
  const [busy, setBusy] = useState(false);
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const refresh = useCallback(async () => {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { setState(ios && !standalone() ? 'needs-install' : 'unsupported'); return; }
    const cfg = await fetch('/api/push/config', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({ enabled: false }));
    if (!cfg.enabled) { setState('unsupported'); return; }
    if (Notification.permission === 'denied') { setState('denied'); return; }
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) setState('on');
    else setState(window.__patformInstall && !standalone() ? 'install' : 'off');
  }, []);
  useEffect(() => {
    void refresh();
    const on = () => void refresh();
    window.addEventListener('patform:installable', on);
    return () => window.removeEventListener('patform:installable', on);
  }, [refresh]);

  const turnOn = async () => {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { await refresh(); return; }
      const reg = (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
      await navigator.serviceWorker.ready;
      const cfg = await fetch('/api/push/config', { credentials: 'same-origin' }).then((r) => r.json());
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.publicKey) });
      await postJson('/api/push/subscribe', { subscription: sub.toJSON(), userAgent: navigator.userAgent });
      setState('on');
    } catch { await refresh(); }
    finally { setBusy(false); }
  };
  const install = async () => { await window.__patformInstall?.prompt(); await refresh(); };

  if (state === 'checking' || state === 'unsupported') return null;
  return (
    <section className="go__nudge">
      {state === 'on' && <p>🔔 You will get a nudge here when something needs you.</p>}
      {state === 'off' && <button type="button" className="go__btn go__btn--secondary go__btn--wide" disabled={busy} onClick={() => void turnOn()}>Nudge me when something needs me</button>}
      {state === 'install' && <button type="button" className="go__btn go__btn--secondary go__btn--wide" onClick={() => void install()}>Add Patform to your home screen</button>}
      {state === 'needs-install' && <p>On iPhone, tap Share → <strong>Add to Home Screen</strong> to get nudges.</p>}
      {state === 'denied' && <p>Notifications are blocked for this site in your browser settings.</p>}
    </section>
  );
}

/* ----------------------------------------------------------------- page */

export function Go() {
  const [me, setMe] = useState<Me | null>(null);
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, h] = await Promise.all([get<Me>('/api/session'), get<Home>('/api/go')]);
      setMe(m); setHome(h); setError(null);
    } catch (err) {
      if (err instanceof SignedOut) { toSignIn(); return; }
      setError(err instanceof Error ? err.message : 'Could not load.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onOut = () => toSignIn();
    window.addEventListener('patform:signed-out', onOut);
    const onShow = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { window.removeEventListener('patform:signed-out', onOut); document.removeEventListener('visibilitychange', onShow); };
  }, [load]);

  const done = (message: string, refresh?: boolean) => {
    setToast(message);
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 4000);
    if (refresh) void load();
  };

  const needs = (home?.approvals.length ?? 0) + (home?.tasks.length ?? 0) + (home?.leave?.toApprove.length ?? 0);
  const first = me?.actor.display_name.split(' ')[0] ?? '';

  return (
    <main className="go">
      <header className="go__top">
        <a className="go__brand" href="/" aria-label="Patform home"><Mark /> <span>Patform</span></a>
        <a className="go__console" href="/console">Console</a>
      </header>

      {error && <p className="go__error" role="alert">{error} <button type="button" className="go__link" onClick={() => void load()}>Try again</button></p>}
      {!home && !error && <p className="go__loading">Loading…</p>}

      {home && (
        <>
          <section className="go__hello">
            <h1>{first ? `Hi ${first}.` : 'Hi.'}</h1>
            <p>{needs === 0 ? 'Nothing needs you right now.' : `${needs} thing${needs === 1 ? '' : 's'} need${needs === 1 ? 's' : ''} you${home.late ? `, ${home.late} late` : ''}.`}</p>
          </section>

          {home.capture.length > 0 && <Snap targets={home.capture} onDone={done} />}

          {home.approvals.length > 0 && (
            <section className="go__section">
              <h2>Decide</h2>
              {home.approvals.map((a) => <Approval key={`${a.instanceId}-${a.approvalKey}`} a={a} onDone={done} />)}
            </section>
          )}

          {home.leave && home.leave.toApprove.length > 0 && (
            <section className="go__section">
              <h2>Leave to approve</h2>
              {home.leave.toApprove.map((r) => <LeaveToApprove key={r.id} r={r} onDone={done} />)}
            </section>
          )}

          {home.tasks.length > 0 && (
            <section className="go__section">
              <h2>Do</h2>
              {home.tasks.map((t) => (
                <a className={`go__card go__card--link ${t.late ? 'is-late' : ''}`} key={`${t.instanceId}-${t.taskKey}`} href={`/console?record=${t.instanceId}`}>
                  <header><span className="go__ref mono">{t.reference}</span>{t.late && <span className="go__age is-late">LATE</span>}</header>
                  <h3>{t.taskName}</h3>
                  <p>{t.summary} · {t.processName}</p>
                </a>
              ))}
            </section>
          )}

          {home.leave?.mine && (
            <section className="go__section">
              <h2>My leave</h2>
              <div className="go__chips">
                {home.leave.mine.balances.map((b) => <span className="go__chip" key={b.type}>{b.type}: <strong>{b.unlimited ? '∞' : b.left ?? '—'}</strong></span>)}
              </div>
              {home.leave.mine.requests.slice(0, 3).map((r) => (
                <p className="go__line" key={r.id}><span>{r.type} · {r.start_date} → {r.end_date}</span><span className={`go__status go__status--${r.status}`}>{r.status}</span></p>
              ))}
              <RequestLeave onDone={done} />
            </section>
          )}

          <Nudges />

          <section className="go__section go__section--quiet">
            <button type="button" className="go__link" onClick={() => setShowKeys((s) => !s)}>{showKeys ? 'Hide' : 'Use fingerprint or face for confirmations'}</button>
            {showKeys && <PasskeysPanel className="go__keys" />}
          </section>
        </>
      )}

      {toast && <div className="go__toast" role="status">{toast}</div>}
      <ReauthDialog />
    </main>
  );
}
