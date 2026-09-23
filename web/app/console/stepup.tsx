'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Confirming it is you, in the middle of doing something.
 *
 * Some actions — issuing a key, adding a webhook, changing a role, deleting
 * records — ask for a recent sign-in (runtime/step-up.ts). When one answers
 * `reauthenticate`, the request is not failed: the person is asked for their
 * password (and code, if two-step is on), and the same request is sent again.
 * Cancelling fails it with a plain message. Nothing about the action has to
 * know this happens.
 */

type Ask = { reason: string; mfa: boolean; resolve: (confirmed: boolean) => void };

const EVENT = 'patform:reauth';

function ask(reason: string, mfa: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent<Ask>(EVENT, { detail: { reason, mfa, resolve } }));
  });
}

/** POSTs JSON, and handles a step-up by asking and trying once more. */
export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const parsed = await res.json().catch(() => ({}));
    if (res.status === 403 && parsed.error === 'reauthenticate' && attempt === 0) {
      if (!(await ask(parsed.reason ?? 'Confirm it is you to continue.', Boolean(parsed.mfa)))) {
        throw new Error('Not done — you did not confirm it was you.');
      }
      continue;
    }
    if (!res.ok) throw new Error(parsed.reason ?? parsed.error ?? `HTTP ${res.status}`);
    return parsed as T;
  }
}

/** Mounted once, at the console's root. Renders nothing until asked. */
export function ReauthDialog() {
  const [asking, setAsking] = useState<Ask | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      returnTo.current = document.activeElement;
      setAsking((e as CustomEvent<Ask>).detail);
      setPassword('');
      setCode('');
      setError(null);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);

  useEffect(() => {
    if (asking) first.current?.focus();
  }, [asking]);

  const close = (confirmed: boolean) => {
    asking?.resolve(confirmed);
    setAsking(null);
    (returnTo.current as HTMLElement | null)?.focus?.();
  };

  if (!asking) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/reauthenticate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, code: asking.mfa ? code : undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        // Five wrong answers end the session; say so the way the console does.
        window.dispatchEvent(new CustomEvent('patform:signed-out'));
        close(false);
        return;
      }
      if (!res.ok) {
        setError(body.reason ?? body.error ?? 'that did not work');
        if (/signed out/.test(body.error ?? '')) {
          window.dispatchEvent(new CustomEvent('patform:signed-out'));
          close(false);
        }
        return;
      }
      close(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ru__backdrop" onKeyDown={(e) => e.key === 'Escape' && close(false)}>
      <form className="ru" role="dialog" aria-modal="true" aria-labelledby="ru-title" onSubmit={(e) => void submit(e)}>
        <h2 id="ru-title" className="ru__title">
          Confirm it is you
        </h2>
        <p className="ru__reason">{asking.reason} It has been a while since you signed in.</p>
        <label className="ru__row">
          <span>Password</span>
          <input
            ref={first}
            className="cs__input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {asking.mfa && (
          <label className="ru__row">
            <span>Code from your authenticator</span>
            <input
              className="cs__input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>
        )}
        {error && (
          <p className="ru__error" role="alert">
            {error}
          </p>
        )}
        <div className="ru__actions">
          <button type="submit" className="cs__btn cs__btn--primary" disabled={busy || !password}>
            {busy ? 'Checking…' : 'Confirm'}
          </button>
          <button type="button" className="cs__btn" onClick={() => close(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
