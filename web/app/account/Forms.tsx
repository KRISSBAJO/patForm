'use client';

/**
 * The three pages an account link lands on: join, verify, reset.
 *
 * They exist because the emails point at them. An invitation that arrives with
 * a link to a route the app does not serve is the same failure this project
 * keeps finding in other forms — a control that is present in review and
 * absent at runtime — and it is worse here, because the mail has already left.
 *
 * All three reuse the sign-in card's styling rather than inventing a second
 * look for the same moment, and all three follow the accessibility rules the
 * §20.2 gate established: a live region for the result, a real <h1>, labels
 * tied to inputs, and no state announced by colour alone.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import '../console/console.css';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(parsed.reason ?? parsed.error ?? `HTTP ${res.status}`);
  return parsed as T;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="cs__login">
      <div className="cs__loginBox">
        <div className="cs__brand" style={{ color: 'var(--ink)', padding: 0 }}>
          <svg width="24" height="24" viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="var(--green)" strokeWidth="1.8" />
            <path
              d="M7 13.2L11 17L19 9"
              stroke="var(--green)"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Patform
        </div>
        <h1 className="cs__loginTitle">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function Password({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <>
      <label className="cs__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="cs__input"
        type="password"
        autoComplete="new-password"
        minLength={12}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        // The rule is stated before they type rather than after they fail.
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="cs__loginNote" style={{ marginTop: 6 }}>
        At least 12 characters.
      </p>
    </>
  );
}

// ------------------------------------------------------------------- join

interface Preview {
  workspaceName: string;
  email: string;
  workspaceRole: string;
  invitedBy: string;
  expiresAt: string;
}

export function JoinForm({ token }: { token: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/invitations/${encodeURIComponent(token)}/preview`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) setFailed(body.reason ?? body.error ?? 'that invitation is not valid any more');
        else setPreview(body as Preview);
      })
      .catch(() => live && setFailed('that invitation is not valid any more'));
    return () => {
      live = false;
    };
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/invitations/accept', { token, displayName, password });
      // The response set a session cookie, so this arrives signed in.
      window.location.href = '/console';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'that did not work');
      setBusy(false);
    }
  };

  if (failed) {
    return (
      <Card title="That invitation has expired">
        <p className="cs__loginNote" role="alert">
          {failed} Ask whoever invited you to send another one — links are single use and expire.
        </p>
      </Card>
    );
  }

  if (!preview) {
    return (
      <Card title="Checking your invitation">
        <p className="cs__loginNote" aria-live="polite">
          One moment.
        </p>
      </Card>
    );
  }

  return (
    <Card title={`Join ${preview.workspaceName}`}>
      {/*
        * Two things a longer address broke here. It ran past the card, so it
        * gets `overflow-wrap`; and the sentence used to end "as a
        * {role}", which reads "a analyst" for half the roles and cannot be
        * fixed by guessing an article. The role is its own line instead.
        */}
      <p className="cs__loginNote" style={{ marginTop: 0, marginBottom: 4, overflowWrap: 'anywhere' }}>
        {preview.invitedBy} invited <strong>{preview.email}</strong> to join.
      </p>
      <p className="cs__loginNote" style={{ marginTop: 0, marginBottom: 18 }}>
        Role: {preview.workspaceRole.replace(/_/g, ' ')}
      </p>

      <form onSubmit={submit}>
        <label className="cs__label" htmlFor="name">
          Your name
        </label>
        <input
          id="name"
          className="cs__input"
          type="text"
          autoComplete="name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          autoFocus
        />

        <Password id="join-password" label="Choose a password" value={password} onChange={setPassword} />

        {error && (
          <p className="cs__loginError" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="cs__btn cs__btn--primary"
          style={{ marginTop: 18, width: '100%', height: 44 }}
          disabled={busy}
        >
          {busy ? 'Setting up…' : 'Create my account'}
        </button>
      </form>
    </Card>
  );
}

// ----------------------------------------------------------------- verify

export function VerifyPanel({ token }: { token: string }) {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let live = true;
    post<{ email: string }>('/api/auth/verify', { token })
      .then((body) => {
        if (!live) return;
        setMessage(body.email);
        setState('done');
      })
      .catch((err: Error) => {
        if (!live) return;
        setMessage(err.message);
        setState('failed');
      });
    return () => {
      live = false;
    };
  }, [token]);

  return (
    <Card
      title={
        state === 'working'
          ? 'Confirming your address'
          : state === 'done'
            ? 'Address confirmed'
            : 'That link did not work'
      }
    >
      {/* One live region for all three states, so the change is announced
          rather than only rendered. */}
      <p className="cs__loginNote" style={{ marginTop: 0 }} aria-live="polite">
        {state === 'working' && 'One moment.'}
        {state === 'done' && `${message} is confirmed. You can invite people into your workspace now.`}
        {state === 'failed' && `${message} Sign in and ask for a new link.`}
      </p>
      <Link
        href="/console"
        className="cs__btn cs__btn--primary"
        style={{ marginTop: 18, width: '100%', height: 44, display: 'grid', placeItems: 'center' }}
      >
        Go to the console
      </Link>
    </Card>
  );
}

// ------------------------------------------------------------------ reset

export function ResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = await post<{ sessionsRevoked: number }>('/api/auth/reset', { token, password });
      setDone(body.sessionsRevoked);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'that did not work');
    } finally {
      setBusy(false);
    }
  };

  if (done !== null) {
    return (
      <Card title="Password changed">
        <p className="cs__loginNote" style={{ marginTop: 0 }} aria-live="polite">
          {done === 0
            ? 'You were not signed in anywhere else.'
            : `Signed out of ${done} other ${done === 1 ? 'session' : 'sessions'}.`}{' '}
          Sign in with your new password.
        </p>
        <Link
          href="/console"
          className="cs__btn cs__btn--primary"
          style={{ marginTop: 18, width: '100%', height: 44, display: 'grid', placeItems: 'center' }}
        >
          Sign in
        </Link>
      </Card>
    );
  }

  return (
    <Card title="Choose a new password">
      <form onSubmit={submit}>
        <Password id="new-password" label="New password" value={password} onChange={setPassword} />
        <p className="cs__loginNote">Using this link signs you out everywhere else.</p>

        {error && (
          <p className="cs__loginError" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="cs__btn cs__btn--primary"
          style={{ marginTop: 18, width: '100%', height: 44 }}
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Change my password'}
        </button>
      </form>
    </Card>
  );
}
