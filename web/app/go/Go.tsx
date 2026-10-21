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
  actions?: { id: string; number: number; title: string; body: string; due_on: string | null; late: boolean }[];
  start: { processKey: string; name: string; publicId: string }[];
  leave: null | {
    toApprove: { id: string; who: string; type: string; start: string; end: string; days: number; reason: string | null }[];
    mine: { balances: { type: string; left: number | null; unlimited: boolean }[]; requests: { id: string; type: string; start_date: string; end_date: string; days: number; status: string }[] } | null;
  };
}

interface Me { actor: { display_name: string }; modules?: string[] }
interface WorkdayData {
  available: boolean;
  current: null | { id: string; shiftId: string | null; startedAt: string; endedAt: string | null; state: 'working' | 'break' | 'closed'; breakStartedAt: string | null; breakPaid: boolean; paidBreakSeconds: number; unpaidBreakSeconds: number; reviewStatus: string };
  shifts: { id: string; startsAt: string; endsAt: string; timezone: string; workplace: string | null; roleName: string | null }[];
  recent: { id: string; startedAt: string; endedAt: string | null; unpaidBreakSeconds: number; reviewStatus: string }[];
}

class SignedOut extends Error {}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', signal: AbortSignal.timeout(60000) });
  if (res.status === 401) throw new SignedOut();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

const hours = (h: number) => (h < 1 ? 'just now' : h < 24 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
const toSignIn = () => window.location.assign('/console?next=%2Fgo');

function Workday({ data, onRefresh, onDone }: { data: WorkdayData; onRefresh: () => Promise<void>; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const pendingAction = useRef<{ kind: string; key: string } | null>(null);
  const [reason, setReason] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!data.current) return; const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, [data.current]);
  const current = data.current;
  const relevant = data.shifts.filter((shift) => new Date(shift.startsAt).getTime() <= now + 30 * 60000 && new Date(shift.endsAt).getTime() >= now - 2 * 3600000);
  const chosen = relevant.find((shift) => shift.id === shiftId) ?? relevant[0];
  const dateTime = (value: string, zone?: string) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(new Date(value));
  const elapsed = current ? Math.max(0, Math.floor((now - new Date(current.startedAt).getTime()) / 60000) - Math.floor(current.unpaidBreakSeconds / 60) - (current.state === 'break' && !current.breakPaid && current.breakStartedAt ? Math.floor((now - new Date(current.breakStartedAt).getTime()) / 60000) : 0)) : 0;
  const act = async (kind: 'clock_in' | 'break_start' | 'break_end' | 'clock_out', paid = false) => {
    if (kind === 'clock_out' && !confirm) { setConfirm(true); return; }
    setBusy(true);
    try {
      const key = pendingAction.current?.kind === kind ? pendingAction.current.key : crypto.randomUUID();
      pendingAction.current = { kind, key };
      await postJson('/api/attendance/clock', { kind, idempotencyKey: key, ...(kind === 'clock_in' ? { shiftId: chosen?.id ?? null, reason: chosen ? undefined : reason } : {}), ...(kind === 'break_start' ? { paid } : {}) });
      pendingAction.current = null;
      setConfirm(false); setReason(''); await onRefresh();
      onDone(kind === 'clock_in' ? 'You are clocked in.' : kind === 'clock_out' ? 'Your workday was recorded.' : kind === 'break_start' ? 'Break started.' : 'Break ended.');
    } catch (err) { onDone(err instanceof Error ? err.message : 'Could not record that action.'); }
    finally { setBusy(false); }
  };
  if (!data.available) return null;
  return <section className="go__workday" aria-labelledby="go-workday-title">
    <div className="go__workdayTop"><span className="go__eyebrow">MY WORKDAY</span><span className={`go__workStatus ${current ? 'is-live' : ''}`}>{current ? current.state === 'break' ? 'On break' : 'Working' : 'Not clocked in'}</span></div>
    <h2 id="go-workday-title">{current ? current.state === 'break' ? 'Take your time.' : 'Your day is underway.' : chosen ? 'Ready for your shift?' : 'Starting work?'}</h2>
    {current ? <><p>Clocked in at {dateTime(current.startedAt)} · {Math.floor(elapsed / 60)}h {elapsed % 60}m recorded</p>{current.reviewStatus === 'pending' && <small className="go__workNotice">Schedule approval pending. Your time is still being recorded.</small>}
      <div className="go__workActions">{current.state === 'break' ? <button type="button" className="go__btn go__btn--primary" disabled={busy} onClick={() => void act('break_end')}>End break</button> : <><button type="button" className="go__btn go__btn--primary" disabled={busy} onClick={() => void act('break_start')}>Unpaid break</button><button type="button" className="go__btn go__btn--secondary" disabled={busy} onClick={() => void act('break_start', true)}>Paid break</button></>}<button type="button" className="go__btn go__btn--secondary" disabled={busy} onClick={() => void act('clock_out')}>Clock out</button></div>
      {confirm && <div className="go__workConfirm"><strong>Finish this workday?</strong><p>Your actual clock-out time and break will be saved. Signing out of Patform alone does not clock you out.</p><div className="go__workActions"><button type="button" className="go__btn go__btn--primary" disabled={busy} onClick={() => void act('clock_out')}>Confirm clock-out</button><button type="button" className="go__btn go__btn--secondary" onClick={() => setConfirm(false)}>Keep working</button></div></div>}</>
      : <>{chosen ? <><p>{chosen.workplace || 'Your workplace'} · {dateTime(chosen.startsAt, chosen.timezone)}–{dateTime(chosen.endsAt, chosen.timezone)}{chosen.roleName ? ` · ${chosen.roleName}` : ''}</p>{Math.abs(now - new Date(chosen.startsAt).getTime()) > 15 * 60000 && <small className="go__workNotice">Your start time is outside the usual 15-minute window. It will be recorded and sent for manager review.</small>}</> : <p>No shift is scheduled for this time. You can still record actual work and send a reason for review.</p>}
        {relevant.length > 1 && <label className="go__workField">Choose shift<select value={shiftId || chosen?.id} onChange={(event) => setShiftId(event.target.value)}>{relevant.map((shift) => <option value={shift.id} key={shift.id}>{dateTime(shift.startsAt, shift.timezone)} · {shift.workplace || 'Workplace'}</option>)}</select></label>}
        {!chosen && <label className="go__workField">Why are you starting work?<input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="Manager asked me to come in…" /></label>}
        <div className="go__workActions"><button type="button" className="go__btn go__btn--primary" disabled={busy || (!chosen && !reason.trim())} onClick={() => void act('clock_in')}>Clock in now</button><span className="go__workHint">Only when you tap. Opening Patform never clocks you in.</span></div></>}
    {data.recent.length > 0 && <details className="go__workHistory"><summary>Recent time records</summary>{data.recent.slice(0, 3).map((session) => <p key={session.id}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(session.startedAt))} · {dateTime(session.startedAt)}–{session.endedAt ? dateTime(session.endedAt) : 'open'} · {session.reviewStatus === 'pending' ? 'Needs review' : 'Recorded'}</p>)}</details>}
  </section>;
}

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

  if (state === 'checking') return null;
  return (
    <section className="go__nudge">
      {state === 'unsupported' && <p>Notifications are not available in this browser. You can still check your inbox here.</p>}
      {state === 'on' && <p>🔔 You will get a nudge here when something needs you.</p>}
      {state === 'off' && <button type="button" className="go__btn go__btn--secondary go__btn--wide" disabled={busy} onClick={() => void turnOn()}>Nudge me when something needs me</button>}
      {state === 'install' && <button type="button" className="go__btn go__btn--secondary go__btn--wide" onClick={() => void install()}>Add Patform to your home screen</button>}
      {state === 'needs-install' && <p>On iPhone, tap Share → <strong>Add to Home Screen</strong> to get nudges.</p>}
      {state === 'denied' && <p>Notifications are blocked for this site in your browser settings.</p>}
    </section>
  );
}

/* ----------------------------------------------------------------- page */

type GoTab = 'today' | 'inbox' | 'create' | 'you';

function GoIcon({ name }: { name: GoTab | 'arrow' | 'refresh' }) {
  const paths: Record<GoTab | 'arrow' | 'refresh', React.ReactNode> = {
    today: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 21v-7h6v7"/></>,
    inbox: <><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 14h5l2 3h4l2-3h5"/></>,
    create: <><circle cx="12" cy="12" r="9"/><path d="M12 7v10M7 12h10"/></>,
    you: <><circle cx="12" cy="8" r="3.5"/><path d="M5 21c0-4 2.6-6 7-6s7 2 7 6"/></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2"/></>,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function Go() {
  const [me, setMe] = useState<Me | null>(null);
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [tab, setTab] = useState<GoTab>('today');
  const [refreshing, setRefreshing] = useState(false);
  const [workday, setWorkday] = useState<WorkdayData | null>(null);
  const [workdayError, setWorkdayError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const refreshWorkday = useCallback(async () => {
    try { setWorkday(await get<WorkdayData>('/api/attendance/workday')); setWorkdayError(null); }
    catch (err) { setWorkdayError(err instanceof Error ? err.message : 'Could not load your workday.'); }
  }, []);

  const load = useCallback(async () => {
    try {
      const m = await get<Me>('/api/session');
      setMe(m);
      if (m.modules?.includes('attendance')) void refreshWorkday();
      const h = await get<Home>('/api/go');
      setHome(h); setError(null);
    } catch (err) {
      if (err instanceof SignedOut) { toSignIn(); return; }
      setError(err instanceof Error ? err.message : 'Could not load.');
    }
  }, [refreshWorkday]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onOut = () => toSignIn();
    window.addEventListener('patform:signed-out', onOut);
    const onShow = () => { if (!signedOut && document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { window.removeEventListener('patform:signed-out', onOut); document.removeEventListener('visibilitychange', onShow); };
  }, [load, signedOut]);

  const done = (message: string, refresh?: boolean) => {
    setToast(message);
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 4000);
    if (refresh) void load();
  };

  const needs = (home?.approvals.length ?? 0) + (home?.tasks.length ?? 0) + (home?.leave?.toApprove.length ?? 0) + (home?.actions?.length ?? 0);
  const first = me?.actor.display_name.split(' ')[0] ?? '';
  const moduleLinks = [
    { key: 'expenses', label: 'Expenses', view: 'expenses' },
    { key: 'procurement', label: 'Procurement', view: 'procurement' },
    { key: 'hr', label: 'HR', view: 'hr' },
    { key: 'attendance', label: 'Time & attendance', view: 'attendance' },
    { key: 'appraisals', label: 'Appraisals', view: 'appraisals' },
    { key: 'assets', label: 'Assets & IT', view: 'operations' },
    { key: 'contracts', label: 'Contracts & compliance', view: 'compliance' },
    { key: 'meetings', label: 'Meetings', view: 'meetings' },
  ].filter((module) => me?.modules?.includes(module.key));
  const switchTab = (next: GoTab) => { setTab(next); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  const signOut = async () => {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok && response.status !== 401) throw new Error('Sign-out did not finish. Please try again.');
      setHome(null); setMe(null); setWorkday(null); setConfirmSignOut(false); setSignedOut(true);
    } catch (err) { done(err instanceof Error ? err.message : 'Sign-out did not finish.'); }
  };

  if (signedOut) return <main className="go go--signedOut"><header className="go__top"><a className="go__brand" href="/"><Mark /> <span>Patform</span></a></header><section className="go__signedOut"><span className="go__signedMark"><Mark /></span><span className="go__eyebrow">ALL DONE FOR NOW</span><h1>You’re signed out.</h1><p>Your account is secure. Any workday you left running remains recorded until you explicitly clock out.</p><a className="go__btn go__btn--primary" href="/console?next=%2Fgo">Sign in again</a></section></main>;

  return (
    <main className="go">
      <header className="go__top">
        <a className="go__brand" href="/" aria-label="Patform home"><Mark /> <span>Patform</span></a>
        <button className="go__refresh" type="button" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh your workspace"><GoIcon name="refresh" /></button>
        {home && <button type="button" className="go__profile" onClick={() => switchTab('you')} aria-label="Open your account">{me?.actor.display_name.split(/\s+/).slice(0,2).map((part) => part.charAt(0)).join('').toUpperCase() || 'P'}</button>}
      </header>

      {error && <p className="go__error" role="alert">{error} <button type="button" className="go__link" onClick={() => void load()}>Try again</button></p>}
      {!home && !error && <section className="go__boot" role="status" aria-live="polite" aria-busy="true"><span className="go__eyebrow">YOUR WORKSPACE</span><h1>{first ? `Good to see you, ${first}.` : 'Your day starts here.'}</h1><p>Bringing your work together…</p><div className="go__bootShape" aria-hidden="true"><span /><span /><span /></div></section>}

      {!home && me?.modules?.includes('attendance') && workday && <div className="go__workdayWrap"><Workday data={workday} onRefresh={refreshWorkday} onDone={done} /></div>}

      {home && (
        <>
          {tab === 'today' && <div className="go__pane" id="go-main">
            <section className="go__hero">
              <span className="go__eyebrow">TODAY</span>
              <h1>{first ? `Hi, ${first}` : 'Hi there'}</h1>
              <p>{needs === 0 ? 'Your desk is clear. You can start something new or check your workspace.' : `${needs} ${needs === 1 ? 'item needs' : 'items need'} your attention${home.late ? ` · ${home.late} overdue` : ''}.`}</p>
              <div className="go__heroCounts">
                <button type="button" onClick={() => switchTab('inbox')}><strong>{home.approvals.length + (home.leave?.toApprove.length ?? 0)}</strong><span>Decisions</span></button>
                <button type="button" onClick={() => switchTab('inbox')}><strong>{home.tasks.length}</strong><span>Tasks</span></button>
                <button type="button" onClick={() => switchTab('inbox')}><strong>{home.late}</strong><span>Overdue</span></button>
              </div>
            </section>
            {me?.modules?.includes('attendance') && <div className="go__workdayWrap">{workday ? <Workday data={workday} onRefresh={refreshWorkday} onDone={done} /> : workdayError ? <div className="go__workday"><p>{workdayError}</p><button type="button" className="go__link" onClick={() => void refreshWorkday()}>Try again</button></div> : <div className="go__workday go__workday--loading" role="status">Checking your workday…</div>}</div>}
            <div className="go__sectionHead"><div><span className="go__eyebrow">AT YOUR FINGERTIPS</span><h2>Quick actions</h2></div></div>
            <div className="go__quickGrid">
              <button type="button" className="go__quick go__quick--green" onClick={() => switchTab('inbox')}><span className="go__quickIcon"><GoIcon name="inbox" /></span><strong>Review work</strong><small>{needs ? `${needs} waiting for you` : 'Your inbox is clear'}</small><GoIcon name="arrow" /></button>
              <button type="button" className="go__quick" onClick={() => switchTab('create')}><span className="go__quickIcon"><GoIcon name="create" /></span><strong>Start something</strong><small>{home.start.length ? `${home.start.length} available forms` : 'See what you can create'}</small><GoIcon name="arrow" /></button>
            </div>
            {needs > 0 && <section className="go__section"><div className="go__sectionHead"><div><span className="go__eyebrow">UP NEXT</span><h2>First on your desk</h2></div><button type="button" className="go__textAction" onClick={() => switchTab('inbox')}>View all <GoIcon name="arrow" /></button></div>{home.approvals[0] ? <Approval a={home.approvals[0]} onDone={done} /> : home.tasks[0] ? <a className="go__card go__card--link" href={`/console?record=${home.tasks[0].instanceId}`}><h3>{home.tasks[0].taskName}</h3><p>{home.tasks[0].summary}</p></a> : home.leave?.toApprove[0] ? <LeaveToApprove r={home.leave.toApprove[0]} onDone={done} /> : null}</section>}
            <section className="go__section go__workspaceLink"><div><span className="go__eyebrow">FULL WORKSPACE</span><h2>Need the complete view?</h2><p>Records, reports, settings and every module are in the console.</p></div><a href="/console" aria-label="Open full console"><GoIcon name="arrow" /></a></section>
          </div>}

          {tab === 'inbox' && <div className="go__pane" id="go-main"><div className="go__pageHeading"><span className="go__eyebrow">YOUR INBOX</span><h1>Work that needs you</h1><p>{needs ? `${needs} open ${needs === 1 ? 'item' : 'items'} across your workspace.` : 'You are all caught up.'}</p></div>
            {needs === 0 && <div className="go__empty"><span className="go__emptyMark">✓</span><h2>All clear for now</h2><p>New decisions and tasks will appear here as soon as they are assigned.</p><button type="button" className="go__btn go__btn--primary" onClick={() => switchTab('create')}>Start something</button></div>}
            {home.approvals.length > 0 && <section className="go__section"><div className="go__sectionHead"><h2>Decisions <span>{home.approvals.length}</span></h2></div>{home.approvals.map((a) => <Approval key={`${a.instanceId}-${a.approvalKey}`} a={a} onDone={done} />)}</section>}
            {home.leave && home.leave.toApprove.length > 0 && <section className="go__section"><div className="go__sectionHead"><h2>Leave requests <span>{home.leave.toApprove.length}</span></h2></div>{home.leave.toApprove.map((r) => <LeaveToApprove key={r.id} r={r} onDone={done} />)}</section>}
            {home.tasks.length > 0 && <section className="go__section"><div className="go__sectionHead"><h2>Tasks <span>{home.tasks.length}</span></h2></div>{home.tasks.map((t) => <a className={`go__card go__card--link ${t.late ? 'is-late' : ''}`} key={`${t.instanceId}-${t.taskKey}`} href={`/console?record=${t.instanceId}`}><header><span className="go__ref mono">{t.reference}</span>{t.late && <span className="go__age is-late">OVERDUE</span>}</header><h3>{t.taskName}</h3><p>{t.summary} · {t.processName}</p><span className="go__cardArrow">Open record <GoIcon name="arrow" /></span></a>)}</section>}
            {(home.actions?.length ?? 0) > 0 && <section className="go__section"><div className="go__sectionHead"><h2>Agreed in a meeting <span>{home.actions!.length}</span></h2></div>{home.actions!.map((a) => <article className={`go__card ${a.late ? 'is-late' : ''}`} key={a.id}><header><span className="go__ref mono">A-{a.number}</span>{a.due_on && <span className={`go__age ${a.late ? 'is-late' : ''}`}>{a.late ? 'OVERDUE · ' : 'due '}{a.due_on}</span>}</header><h3>{a.title}</h3><p>{a.body}</p><div className="go__row"><button type="button" className="go__btn go__btn--primary" onClick={() => void (async () => { try { await postJson(`/api/meetings/actions/${a.id}/close`, {}); done(`A-${a.number} done.`, true); } catch (err) { done(err instanceof Error ? err.message : 'That did not work.'); } })()}>Done</button><a className="go__link" href="/console?view=meetings">Open</a></div></article>)}</section>}
          </div>}

          {tab === 'create' && <div className="go__pane" id="go-main"><div className="go__pageHeading"><span className="go__eyebrow">GET SOMETHING MOVING</span><h1>Start from your phone</h1><p>Open a form, add evidence, or request time away.</p></div>
            {home.capture.length > 0 && <section className="go__section"><div className="go__sectionHead"><h2>Capture evidence</h2></div><Snap targets={home.capture} onDone={done} /></section>}
            <section className="go__section"><div className="go__sectionHead"><h2>Available forms <span>{home.start.length}</span></h2></div>{home.start.length ? <div className="go__formList">{home.start.map((p) => <a className="go__formLink" key={p.processKey} href={`/f/${p.publicId}`}><span className="go__formInitial">{p.name.charAt(0).toUpperCase()}</span><span><strong>{p.name}</strong><small>Start a new submission</small></span><GoIcon name="arrow" /></a>)}</div> : <div className="go__empty go__empty--small"><h3>No forms available yet</h3><p>Your workspace will show forms here when you have permission to start them.</p></div>}</section>
            {home.leave?.mine && <section className="go__section"><div className="go__sectionHead"><h2>Time away</h2></div><RequestLeave onDone={done} /></section>}
          </div>}

          {tab === 'you' && <div className="go__pane" id="go-main"><div className="go__pageHeading"><span className="go__eyebrow">YOUR ACCOUNT</span><h1>{me?.actor.display_name ?? 'Your workspace'}</h1><p>Preferences, leave and your full console.</p></div>
            {moduleLinks.length > 0 && <section className="go__section"><div className="go__sectionHead"><h2>Your modules</h2></div><div className="go__formList">{moduleLinks.map((module) => <a className="go__formLink" href={`/console?view=${module.view}`} key={module.key}><span className="go__formInitial">{module.label.charAt(0)}</span><span><strong>{module.label}</strong><small>Open in the full console</small></span><GoIcon name="arrow" /></a>)}</div></section>}
            {home.leave?.mine && <section className="go__section"><div className="go__sectionHead"><h2>My leave</h2></div><div className="go__chips">{home.leave.mine.balances.map((b) => <span className="go__chip" key={b.type}>{b.type}: <strong>{b.unlimited ? '∞' : b.left ?? '—'}</strong></span>)}</div>{home.leave.mine.requests.slice(0, 3).map((r) => <p className="go__line" key={r.id}><span>{r.type} · {r.start_date} → {r.end_date}</span><span className={`go__status go__status--${r.status}`}>{r.status}</span></p>)}</section>}
            <section className="go__section go__settingsCard"><div className="go__sectionHead"><h2>Stay in the loop</h2></div><Nudges /></section>
            <section className="go__section go__settingsCard"><div className="go__sectionHead"><h2>Sign in securely</h2></div><button type="button" className="go__textAction" onClick={() => setShowKeys((s) => !s)} aria-expanded={showKeys}>{showKeys ? 'Hide passkeys' : 'Use fingerprint or face'} <GoIcon name="arrow" /></button>{showKeys && <PasskeysPanel className="go__keys" />}</section>
            <a className="go__fullConsole" href="/console"><span><strong>Open full console</strong><small>All modules, records and settings</small></span><GoIcon name="arrow" /></a>
            <button type="button" className="go__signOut" onClick={() => setConfirmSignOut(true)}>Sign out of Patform</button>
          </div>}
        </>
      )}

      {home && <nav className="go__bottomNav" aria-label="Phone workspace">{([['today', 'Today'], ['inbox', 'Inbox'], ['create', 'Create'], ['you', 'You']] as const).map(([key, label]) => <button key={key} type="button" aria-current={tab === key ? 'page' : undefined} onClick={() => switchTab(key)}><GoIcon name={key} /><span>{label}</span>{key === 'inbox' && needs > 0 && <i aria-label={`${needs} waiting`}>{needs}</i>}</button>)}</nav>}

      {toast && <div className="go__toast" role="status">{toast}</div>}
      {confirmSignOut && <div className="go__dialogBackdrop"><section className="go__dialog" role="dialog" aria-modal="true" aria-labelledby="go-signout-title"><span className="go__eyebrow">YOUR SESSION</span><h2 id="go-signout-title">Sign out of Patform?</h2><p>{workday?.current ? 'You are still clocked in. Signing out will leave your workday running until you clock out explicitly.' : 'You can sign back in whenever you need your workspace.'}</p>{workday?.current && <button type="button" className="go__link" onClick={() => { setConfirmSignOut(false); switchTab('today'); }}>Review workday first</button>}<div className="go__workActions"><button type="button" className="go__btn go__btn--primary" onClick={() => void signOut()}>Sign out</button><button type="button" className="go__btn go__btn--secondary" onClick={() => setConfirmSignOut(false)}>Stay here</button></div></section></div>}
      <ReauthDialog />
    </main>
  );
}
