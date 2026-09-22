'use client';

/**
 * Choosing what to build, on a page rather than in a dialog.
 *
 * A modal was the wrong container the moment there were more than a handful
 * of packs: it cannot be scrolled comfortably, cannot be linked to, cannot be
 * filtered without feeling cramped, and it closes if you look away. Fifty-odd
 * starting points need a page.
 *
 * Each card carries a name, a sentence, and a **view** control that opens
 * what is actually inside — counted from the blueprint, so a card cannot
 * claim something installing it does not give you.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import '../builder.css';
import './gallery.css';

interface PackContents {
  fields: number;
  states: number;
  approvals: number;
  tasks: number;
  emails: number;
  documents: number;
  metrics: number;
  roles: { key: string; name: string; kind: string }[];
  policy: {
    sensitivityCeiling: string;
    retentionDays: number | null;
    restrictedFields: number;
    fieldsHiddenFromSomeone: number;
  };
}

interface Pack {
  id: string;
  packKey: string;
  version: number;
  name: string;
  summary: string;
  category: string;
  audience: string;
  contents: PackContents;
  builtIn: boolean;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('signed-out');
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

/** A key the compiler will accept, derived from a name somebody typed. */
function keyFrom(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

export function Gallery() {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [viewing, setViewing] = useState<Pack | null>(null);
  const [installing, setInstalling] = useState<Pack | null>(null);
  const [processKey, setProcessKey] = useState('');
  const [processName, setProcessName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPacks(await call<Pack[]>('/api/packs'));
    } catch (err) {
      if (err instanceof Error && err.message === 'signed-out') {
        window.location.href = '/console';
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setPacks([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of packs ?? []) seen.set(p.category, (seen.get(p.category) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [packs]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (packs ?? []).filter(
      (p) =>
        (category === 'all' || p.category === category) &&
        (!q ||
          p.name.toLowerCase().includes(q) ||
          p.summary.toLowerCase().includes(q) ||
          p.audience.toLowerCase().includes(q)),
    );
  }, [packs, query, category]);

  const install = async () => {
    if (!installing) return;
    setBusy(true);
    setError(null);
    try {
      // Installing opens a draft. Nothing goes live until somebody publishes
      // it, which is the same rule a generated process follows.
      const done = await call<{ draftId: string }>(`/api/packs/${installing.id}/install`, {
        method: 'POST',
        body: JSON.stringify({ processKey, name: processName || undefined }),
      });
      window.location.href = `/builder?draft=${done.draftId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="gl">
      <header className="bd__top">
        <span className="bd__topBrand">
          <svg width="20" height="20" viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="var(--green-mint)" strokeWidth="1.8" />
            <path
              d="M7 13.2L11 17L19 9"
              stroke="var(--green-mint)"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Patform
        </span>
        <span className="bd__topDivider" aria-hidden="true" />
        <span className="bd__topWhere">New process</span>
        <span style={{ flexGrow: 1 }} />
        <a className="bd__topLink" href="/builder">
          Back to the builder
        </a>
      </header>

      <main className="gl__main" id="gallery-main">
        <div className="gl__head">
          <h1>Start from something that already works</h1>
          <p>
            Every one of these is a whole process — the form, the approvals, the reminders and the
            dashboard — not a form template. Installing opens it as a draft; nothing goes live until
            you publish it.
          </p>
        </div>

        <div className="gl__controls">
          <div className="gl__search">
            <label className="vw__srOnly" htmlFor="pack-search">
              Search the packs
            </label>
            <input
              id="pack-search"
              className="cs__input"
              type="search"
              placeholder="Search — leave, expenses, incident, consent…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="gl__cats" role="group" aria-label="Filter by area">
            <button
              type="button"
              className={`gl__cat${category === 'all' ? ' gl__cat--on' : ''}`}
              aria-pressed={category === 'all'}
              onClick={() => setCategory('all')}
            >
              Everything <span className="gl__count">{packs?.length ?? 0}</span>
            </button>
            {categories.map(([name, count]) => (
              <button
                key={name}
                type="button"
                className={`gl__cat${category === name ? ' gl__cat--on' : ''}`}
                aria-pressed={category === name}
                onClick={() => setCategory(name)}
              >
                {name} <span className="gl__count">{count}</span>
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="gl__error" role="alert">
            {error}
          </p>
        )}

        {packs === null ? (
          <p className="gl__empty">Loading the catalogue…</p>
        ) : shown.length === 0 ? (
          <p className="gl__empty" role="status">
            Nothing matches “{query}”. Try a different word, or{' '}
            <a href="/builder">describe the process instead</a> — that route does not need a pack.
          </p>
        ) : (
          <ul className="gl__grid">
            {shown.map((p) => (
              <li key={p.id} className="gl__card">
                <span className="gl__cardCat">{p.category}</span>
                <h2 className="gl__cardName">{p.name}</h2>
                <p className="gl__cardSummary">{p.summary}</p>

                <div className="gl__cardFoot">
                  <button
                    type="button"
                    className="gl__view"
                    onClick={() => setViewing(p)}
                    /* The name is in the accessible label, because "View" on
                       its own is fifty identical buttons to a screen reader. */
                    aria-label={`What is inside ${p.name}`}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.7}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M1.8 10S4.9 4.4 10 4.4 18.2 10 18.2 10 15.1 15.6 10 15.6 1.8 10 1.8 10Z" />
                      <circle cx="10" cy="10" r="2.4" />
                    </svg>
                    View
                  </button>
                  <button
                    type="button"
                    className="cs__btn cs__btn--primary gl__use"
                    onClick={() => {
                      setInstalling(p);
                      setProcessKey(keyFrom(p.name));
                      setProcessName(p.name);
                    }}
                    aria-label={`Use ${p.name}`}
                  >
                    Use this
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="gl__other">
          Nothing here fits? <a href="/builder">Describe your process in a sentence</a> and the
          builder will draft it, or copy one you already have.
        </p>
      </main>

      {/* What is inside, counted from the blueprint rather than written. */}
      {viewing && (
        <PackSheet
          pack={viewing}
          onClose={() => setViewing(null)}
          onUse={() => {
            setInstalling(viewing);
            setProcessKey(keyFrom(viewing.name));
            setProcessName(viewing.name);
            setViewing(null);
          }}
        />
      )}

      {installing && (
        <div className="gl__sheet" role="dialog" aria-modal="true" aria-labelledby="install-title">
          <div className="gl__sheetBox">
            <h2 id="install-title">Name it</h2>
            <p className="gl__sheetNote">
              The key ends up in the public form link, so it is worth getting right — it cannot be
              changed once anybody has the link.
            </p>

            <label className="cs__label" htmlFor="new-key">
              Key
            </label>
            <input
              id="new-key"
              className="cs__input"
              value={processKey}
              onChange={(e) => setProcessKey(keyFrom(e.target.value))}
              aria-describedby="new-key-hint"
            />
            <p id="new-key-hint" className="gl__sheetNote">
              /f/{processKey || 'your_process'}
            </p>

            <label className="cs__label" htmlFor="new-name">
              Name
            </label>
            <input
              id="new-name"
              className="cs__input"
              value={processName}
              onChange={(e) => setProcessName(e.target.value)}
            />

            {error && (
              <p className="gl__error" role="alert">
                {error}
              </p>
            )}

            <div className="gl__sheetActions">
              <button
                type="button"
                className="cs__btn cs__btn--primary"
                disabled={busy || processKey.length < 3}
                onClick={() => void install()}
              >
                {busy ? 'Installing…' : 'Install as a draft'}
              </button>
              <button type="button" className="cs__btn" onClick={() => setInstalling(null)}>
                Cancel
              </button>
              {processKey.length < 3 && (
                <span className="gl__sheetNote">A key of at least three characters.</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PackSheet({
  pack,
  onClose,
  onUse,
}: {
  pack: Pack;
  onClose: () => void;
  onUse: () => void;
}) {
  const c = pack.contents;
  return (
    <div className="gl__sheet" role="dialog" aria-modal="true" aria-labelledby="pack-title">
      <div className="gl__sheetBox">
        <span className="gl__cardCat">{pack.category}</span>
        <h2 id="pack-title">{pack.name}</h2>
        <p className="gl__sheetSummary">{pack.summary}</p>
        <p className="gl__sheetAudience">{pack.audience}</p>

        <dl className="gl__specs">
          <div>
            <dt>The form</dt>
            <dd>{c.fields} fields</dd>
          </div>
          <div>
            <dt>The workflow</dt>
            <dd>
              {c.states} states, {c.approvals} approval(s), {c.tasks} task(s)
            </dd>
          </div>
          <div>
            <dt>The messages</dt>
            <dd>{c.emails} email templates</dd>
          </div>
          <div>
            <dt>The dashboard</dt>
            <dd>{c.metrics} measures</dd>
          </div>
          <div>
            <dt>Who is involved</dt>
            <dd>{c.roles.map((r) => r.name).join(', ')}</dd>
          </div>
          <div>
            <dt>Data policy</dt>
            <dd>
              Holds up to <strong>{c.policy.sensitivityCeiling}</strong> data
              {c.policy.restrictedFields > 0
                ? `, ${c.policy.restrictedFields} restricted field(s) hidden from ${c.policy.fieldsHiddenFromSomeone > 0 ? 'some roles' : 'nobody'}`
                : ''}
              .{' '}
              {c.policy.retentionDays
                ? `Records kept ${Math.round(c.policy.retentionDays / 365)} year(s) after completion.`
                : 'Records kept indefinitely.'}
            </dd>
          </div>
        </dl>

        <p className="gl__sheetNote">
          {/* §1.2's distinction, said plainly: this is the part a form
              template has no way to carry. */}
          A form template gives you fields. This gives you the approvals, the reminders, the
          permissions and the retention as well — and the compiler checks all of it before it can
          go live.
        </p>

        <div className="gl__sheetActions">
          <button type="button" className="cs__btn cs__btn--primary" onClick={onUse}>
            Use this
          </button>
          <button type="button" className="cs__btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
