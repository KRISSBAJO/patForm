'use client';

/**
 * Creating a workspace, from a browser.
 *
 * `POST /api/workspaces` has existed since IAM-01 and nothing in the web app
 * called it. The endpoint was proved, documented and reachable by curl, and a
 * person arriving at the landing page could not get into the product — the
 * eighth instance of a control that is present in review and absent at
 * runtime, and the most expensive one, because it is the front door.
 *
 * The response signs you in, so this ends at the console rather than at a
 * login form asking for the password you chose ten seconds ago.
 */

import { useState } from 'react';
import Link from 'next/link';
import '../console/console.css';

export function Signup() {
  const [workspaceName, setWorkspaceName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceName, ownerName, ownerEmail, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
      window.location.href = '/console';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'that did not work');
      setBusy(false);
    }
  };

  return (
    <div className="cs__login">
      <form className="cs__loginBox" onSubmit={submit}>
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
        <h1 className="cs__loginTitle">Create a workspace</h1>

        <label className="cs__label" htmlFor="workspace">
          Workspace name
        </label>
        <input
          id="workspace"
          className="cs__input"
          type="text"
          autoComplete="organization"
          value={workspaceName}
          onChange={(e) => setWorkspaceName(e.target.value)}
          required
          autoFocus
          aria-describedby="workspace-hint"
        />
        <p id="workspace-hint" className="cs__loginNote" style={{ marginTop: 6 }}>
          Usually your organization or team.
        </p>

        <label className="cs__label" htmlFor="owner">
          Your name
        </label>
        <input
          id="owner"
          className="cs__input"
          type="text"
          autoComplete="name"
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value)}
          required
        />

        <label className="cs__label" htmlFor="signup-email">
          Work email
        </label>
        <input
          id="signup-email"
          className="cs__input"
          type="email"
          autoComplete="username"
          value={ownerEmail}
          onChange={(e) => setOwnerEmail(e.target.value)}
          required
          aria-describedby="signup-email-hint"
        />
        <p id="signup-email-hint" className="cs__loginNote" style={{ marginTop: 6 }}>
          We send a link to confirm it. Everything works while you wait — except inviting people,
          because those invitations go out under your name.
        </p>

        <label className="cs__label" htmlFor="signup-password">
          Password
        </label>
        <input
          id="signup-password"
          className="cs__input"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          aria-describedby="signup-password-hint"
        />
        <p id="signup-password-hint" className="cs__loginNote" style={{ marginTop: 6 }}>
          At least 12 characters. This account owns everything in the workspace.
        </p>

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
          {busy ? 'Creating…' : 'Create the workspace'}
        </button>

        <p className="cs__loginNote">
          {/* 1.4.1: a link inside a paragraph cannot be distinguished by
              colour alone, and this one failed the check at 2.9:1 against the
              text around it. Underlined, so it does not depend on colour. */}
          Already have one?{' '}
          <Link href="/console" style={{ textDecoration: 'underline' }}>
            Sign in
          </Link>
          .
        </p>
      </form>
    </div>
  );
}
