'use client';

/**
 * The OAuth consent screen.
 *
 * `POST /api/oauth/authorize` existed, was proved, and had no page — which
 * made the whole authorization-code flow unreachable: an application could be
 * registered and then had nowhere to send anybody.
 *
 * Three things this screen has to get right, and each is a way consent
 * screens are usually theatre:
 *
 *   1. **Name what is being granted in words**, not in scope strings. Nobody
 *      consents to `records:write`.
 *   2. **Show where they will be sent.** The redirect is matched exactly by
 *      the server, so showing it lets the person check it is the application
 *      they think it is.
 *   3. **Refusing is a real option**, on the same screen, with the same
 *      weight — and it returns them to the application with a refusal rather
 *      than leaving them on a dead page.
 */

import { useState } from 'react';
import '../console/console.css';

const MEANS: Record<string, string> = {
  view: 'Read records you can see',
  edit: 'Change answers on records you can edit',
  operate: 'Complete tasks and move records along',
  report: 'Read dashboards and metrics',
  approve: 'Approve and reject on your behalf',
  administer: 'Manage the workspace, including people',
};

export function Consent({
  clientId,
  redirectUri,
  scopes,
  state,
  codeChallenge,
  codeChallengeMethod,
}: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missing = !clientId || !redirectUri || !codeChallenge;

  const decide = async (approved: boolean) => {
    if (!approved) {
      /*
       * A refusal goes back to the application as `access_denied`, which is
       * what the RFC says and what lets the application say something useful.
       * Leaving somebody on a dead page is how they try again and again.
       */
      const back = new URL(redirectUri);
      back.searchParams.set('error', 'access_denied');
      if (state) back.searchParams.set('state', state);
      window.location.href = back.toString();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/oauth/authorize', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId,
          redirectUri,
          scopes,
          state,
          codeChallenge,
          codeChallengeMethod,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
      window.location.href = body.redirectTo;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'that did not work');
      setBusy(false);
    }
  };

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

        {missing ? (
          <>
            <h1 className="cs__loginTitle">That link is incomplete</h1>
            <p className="cs__loginNote" style={{ marginTop: 0 }} role="alert">
              An application sent you here without everything needed to identify it. Go back and
              start again from the application itself.
            </p>
          </>
        ) : (
          <>
            <h1 className="cs__loginTitle">Allow access?</h1>
            <p className="cs__loginNote" style={{ marginTop: 0, marginBottom: 14 }}>
              An application wants to act as you in this workspace. It will only ever be able to do
              what <em>you</em> can do — if your permissions shrink, so do its.
            </p>

            <ul className="cn__scopes">
              {(scopes.length ? scopes : ['view']).map((s) => (
                <li key={s}>{MEANS[s] ?? s}</li>
              ))}
            </ul>

            <p className="cs__loginNote">
              Afterwards you will be sent to:
              <br />
              <code style={{ overflowWrap: 'anywhere' }}>{redirectUri}</code>
              <br />
              If that is not the application you started from, refuse.
            </p>

            {error && (
              <p className="cs__loginError" role="alert">
                {error}
              </p>
            )}

            <div className="cn__actions">
              <button
                type="button"
                className="cs__btn cs__btn--primary"
                disabled={busy}
                onClick={() => void decide(true)}
              >
                {busy ? 'Allowing…' : 'Allow'}
              </button>
              <button type="button" className="cs__btn" disabled={busy} onClick={() => void decide(false)}>
                Refuse
              </button>
            </div>

            <p className="cs__loginNote">
              You can revoke this later under <strong>Integrations</strong> in the console.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
