'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Notifications on this device, and installing the console.
 *
 * Both live on the account page because both are about this phone or this
 * laptop, not about the workspace. The browser decides what is possible:
 * no service worker means no notifications; an iPhone only allows them once
 * the console is on the home screen; a denied permission can only be undone
 * in the browser's own settings. Each of those is said plainly rather than
 * shown as a button that does nothing.
 */
type State = 'checking' | 'unsupported' | 'not-configured' | 'needs-install' | 'denied' | 'off' | 'on';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.reason ?? json.error ?? `HTTP ${res.status}`);
  return json as T;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const isIos = () => typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export function NotificationsPanel() {
  const [state, setState] = useState<State>('checking');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [installable, setInstallable] = useState(false);
  const [installed, setInstalled] = useState(false);

  const refresh = useCallback(async () => {
    setInstalled(isStandalone());
    setInstallable(Boolean(window.__patformInstall));
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setState(isIos() && !isStandalone() ? 'needs-install' : 'unsupported');
      return;
    }
    try {
      const cfg = await fetch('/api/push/config', { credentials: 'same-origin' }).then((r) => r.json());
      if (!cfg.enabled) { setState('not-configured'); return; }
      setPublicKey(cfg.publicKey);
    } catch {
      setState('not-configured');
      return;
    }
    if (Notification.permission === 'denied') { setState('denied'); return; }
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    setState(sub ? 'on' : 'off');
  }, []);

  useEffect(() => {
    void refresh();
    const onInstallable = () => setInstallable(true);
    window.addEventListener('patform:installable', onInstallable);
    return () => window.removeEventListener('patform:installable', onInstallable);
  }, [refresh]);

  const turnOn = async () => {
    setBusy(true);
    setNote(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setState(permission === 'denied' ? 'denied' : 'off'); return; }
      const reg = (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey!) });
      await post('/api/push/subscribe', { subscription: sub.toJSON(), userAgent: navigator.userAgent });
      setState('on');
      setNote('On. A decision or a task waiting for you will show here, and a tap opens the record.');
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setNote(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
        await sub.unsubscribe();
      }
      setState('off');
      setNote('Off on this device.');
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await post<{ sent: number; devices: number }>('/api/push/test', {});
      setNote(r.sent ? `Sent to ${r.sent} of your ${r.devices} device${r.devices === 1 ? '' : 's'}. It should appear in a moment.` : 'Nothing was sent. Turn notifications on first.');
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    const p = window.__patformInstall;
    if (!p) return;
    await p.prompt();
    const choice = await p.userChoice;
    if (choice.outcome === 'accepted') { setInstalled(true); setInstallable(false); window.__patformInstall = null; }
  };

  return (
    <section className="cs__panel sv__panel" aria-labelledby="notif-title">
      <div className="sv__head">
        <div>
          <h3 id="notif-title">Notifications on this device</h3>
          <p>
            When a decision or a task is waiting for you, this device says so, and a tap opens the record. Nothing a form collected is in the message: only the process and the reference.
          </p>
        </div>
      </div>

      {state === 'checking' && <p className="vw__footnote">Checking what this device can do…</p>}
      {state === 'unsupported' && <p className="vw__footnote">This browser cannot show notifications from a website. Chrome, Edge, Firefox and Safari 16.4 or later can.</p>}
      {state === 'not-configured' && <p className="vw__footnote">Notifications are not set up on this deployment yet. The operator adds a push key to turn them on.</p>}
      {state === 'needs-install' && (
        <p className="vw__footnote">
          On an iPhone or iPad, notifications work once the console is on your home screen. In Safari, tap Share, then <strong>Add to Home Screen</strong>, then open Patform from there and come back to this page.
        </p>
      )}
      {state === 'denied' && <p className="vw__footnote">Notifications are blocked for this site in the browser's settings. Allow them there, then come back.</p>}

      {(state === 'off' || state === 'on') && (
        <div className="sv__actions">
          {state === 'off' ? (
            <button type="button" className="cs__btn cs__btn--primary" disabled={busy} onClick={() => void turnOn()}>
              {busy ? 'Asking…' : 'Turn on notifications'}
            </button>
          ) : (
            <>
              <span className="sv__on"><span aria-hidden="true" /> On</span>
              <button type="button" className="cs__btn" disabled={busy} onClick={() => void sendTest()}>Send a test</button>
              <button type="button" className="cs__btn" disabled={busy} onClick={() => void turnOff()}>Turn off</button>
            </>
          )}
        </div>
      )}

      {note && <p className="vw__footnote" role="status">{note}</p>}

      <div className="sv__install">
        <h4>On your home screen</h4>
        {installed ? (
          <p className="vw__footnote">You are using the installed console.</p>
        ) : installable ? (
          <>
            <p className="vw__footnote">Install the console as an app: it opens in its own window, with an icon, and notifications reach it.</p>
            <button type="button" className="cs__btn" onClick={() => void install()}>Install</button>
          </>
        ) : isIos() ? (
          <p className="vw__footnote">In Safari, tap Share, then <strong>Add to Home Screen</strong>.</p>
        ) : (
          <p className="vw__footnote">Your browser offers this from its menu: look for <strong>Install</strong> or <strong>Add to Home Screen</strong>.</p>
        )}
      </div>
    </section>
  );
}
