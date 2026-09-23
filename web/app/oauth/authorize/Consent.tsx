'use client';

import { useEffect, useState } from 'react';

/**
 * The consent screen an integration sends somebody to.
 *
 * It asks the API the same questions the grant asks, before drawing
 * anything: a request with the wrong client, a redirect address that is not
 * registered exactly, or a scope this system does not have gets an error
 * page and is never redirected — an unverified redirect is where an
 * authorization code leaks to. Only a request that would work if allowed is
 * shown, and it is shown in words: which app, which workspace, what it will
 * be able to do, what it asked for and will not get, and where the browser
 * goes next, so a lookalike address stands out.
 */

interface ConsentView {
  client: { name: string; registeredAt: string };
  workspace: string;
  member: { name: string; email: string };
  granted: string[];
  withheld: string[];
  returnsTo: string;
}

const SCOPE_WORDS: Record<string, { title: string; detail: string }> = {
  view: { title: 'See records', detail: 'The records and answers you can see, with the same fields hidden.' },
  report: { title: 'Read reports', detail: 'Dashboards, measures and exports.' },
  edit: { title: 'Change answers', detail: 'Only the answers your roles let you change.' },
  operate: { title: 'Work records', detail: 'Complete tasks, send reminders and move records along.' },
  administer: {
    title: 'Manage the workspace',
    detail: 'Processes, members and settings — everything an administrator can do.',
  },
};

type Stage =
  | { kind: 'loading' }
  | { kind: 'signin' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; view: ConsentView }
  | { kind: 'leaving' };

export function Consent() {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const query = typeof window === 'undefined' ? '' : window.location.search.slice(1);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/oauth/consent?${query}`, { credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) return setStage({ kind: 'signin' });
      if (!res.ok) return setStage({ kind: 'error', message: body.reason ?? body.error ?? `HTTP ${res.status}` });
      setStage({ kind: 'ready', view: body as ConsentView });
    })().catch((err) => setStage({ kind: 'error', message: String(err) }));
  }, [query]);

  const decide = async (allow: boolean) => {
    setBusy(true);
    try {
      const q = new URLSearchParams(query);
      const res = await fetch(allow ? '/api/oauth/authorize' : '/api/oauth/deny', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          allow
            ? {
                clientId: q.get('client_id'),
                redirectUri: q.get('redirect_uri'),
                scopes: (q.get('scope') ?? '').split(/\s+/).filter(Boolean),
                state: q.get('state') ?? undefined,
                codeChallenge: q.get('code_challenge'),
                codeChallengeMethod: q.get('code_challenge_method'),
              }
            : { query },
        ),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.redirectTo) {
        setStage({ kind: 'error', message: body.reason ?? body.error ?? `HTTP ${res.status}` });
        return;
      }
      setStage({ kind: 'leaving' });
      window.location.assign(body.redirectTo);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="oc">
      <div className="oc__card">
        <div className="oc__brand">
          <svg width="22" height="22" viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="currentColor" strokeWidth="1.8" />
            <path d="M7 13.2L11 17L19 9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Patform
        </div>

        {stage.kind === 'loading' && <p className="oc__quiet">Checking the request…</p>}

        {stage.kind === 'signin' && (
          <>
            <h1 className="oc__title">Sign in to continue</h1>
            <p className="oc__lede">An app is asking for access to your Patform workspace. Sign in first to see what it wants.</p>
            <a className="oc__btn oc__btn--primary" href={`/console?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`}>
              Sign in
            </a>
          </>
        )}

        {stage.kind === 'error' && (
          <>
            <h1 className="oc__title">This request cannot go ahead</h1>
            <p className="oc__lede" role="alert">
              {stage.message}.
            </p>
            <p className="oc__quiet">
              Nothing was shared, and you have not been sent anywhere. If you did not expect this, close the page. If you
              are setting up an integration, the address above is what its developer needs to fix.
            </p>
          </>
        )}

        {stage.kind === 'ready' && (
          <>
            <h1 className="oc__title">
              Allow <strong>{stage.view.client.name}</strong> to use {stage.view.workspace}?
            </h1>
            <p className="oc__lede">
              It will act as you, {stage.view.member.name} ({stage.view.member.email}), with no more access than you have —
              and less if you take any away later.
            </p>

            <h2 className="oc__section">It will be able to</h2>
            <ul className="oc__scopes">
              {stage.view.granted.map((sc) => (
                <li key={sc}>
                  <strong>{SCOPE_WORDS[sc]?.title ?? sc}</strong>
                  <span>{SCOPE_WORDS[sc]?.detail}</span>
                </li>
              ))}
            </ul>

            {stage.view.withheld.length > 0 && (
              <>
                <h2 className="oc__section">It asked for, and will not get</h2>
                <ul className="oc__scopes oc__scopes--withheld">
                  {stage.view.withheld.map((sc) => (
                    <li key={sc}>
                      <strong>{SCOPE_WORDS[sc]?.title ?? sc}</strong>
                      <span>You do not hold this yourself, so you cannot give it.</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <p className="oc__quiet">
              Afterwards you will be sent to <strong className="oc__host">{stage.view.returnsTo}</strong>. It was registered
              by your workspace on {new Date(stage.view.client.registeredAt).toLocaleDateString()}. An administrator can
              revoke it at any time under Integrations.
            </p>

            <div className="oc__actions">
              <button type="button" className="oc__btn oc__btn--primary" disabled={busy} onClick={() => void decide(true)}>
                Allow
              </button>
              <button type="button" className="oc__btn" disabled={busy} onClick={() => void decide(false)}>
                Deny
              </button>
            </div>
          </>
        )}

        {stage.kind === 'leaving' && <p className="oc__quiet">Sending you back…</p>}
      </div>
    </main>
  );
}
