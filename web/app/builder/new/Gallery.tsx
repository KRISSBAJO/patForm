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
import './cards.css';
import { PackCard, type Pack } from './PackCard';

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

  /** The shown packs, under their area. One group when a filter is on. */
  const grouped = useMemo(() => {
    const by = new Map<string, Pack[]>();
    for (const p of shown) by.set(p.category, [...(by.get(p.category) ?? []), p]);
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown]);

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
      window.location.href = `/builder/launch?draft=${done.draftId}`;
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

      <div className="gl__head">
        <div className="gl__headInner">
          <h1>Start from something that already works</h1>
          <p>
            A whole process — the form, the approvals, the reminders and the dashboard — not a form
            template. Installing opens it as a draft; nothing goes live until you publish it.
          </p>
          <div className="gl__search">
            <label className="vw__srOnly" htmlFor="pack-search">
              Search the packs
            </label>
            <svg
              className="gl__searchIcon"
              width="17"
              height="17"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="8.8" cy="8.8" r="5.6" />
              <path d="m13 13 4 4" />
            </svg>
            <input
              id="pack-search"
              className="gl__searchInput"
              type="search"
              placeholder="Search — leave, expenses, wedding, milestone…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="gl__body" id="gallery-main">
        {/*
          * Categories run down the side rather than wrapping across the top.
          * Nineteen of them wrapped into three ragged rows that fought the
          * search box for the same corner; a list is scannable at any length
          * and does not reflow when one is added.
          */}
        <nav className="gl__side" aria-label="Filter by area">
          <button
            type="button"
            className={`gl__cat${category === 'all' ? ' gl__cat--on' : ''}`}
            aria-current={category === 'all' ? 'true' : undefined}
            onClick={() => setCategory('all')}
          >
            Everything <span className="gl__count">{packs?.length ?? 0}</span>
          </button>
          {categories.map(([name, count]) => (
            <button
              key={name}
              type="button"
              className={`gl__cat${category === name ? ' gl__cat--on' : ''}`}
              aria-current={category === name ? 'true' : undefined}
              onClick={() => setCategory(name)}
            >
              {name} <span className="gl__count">{count}</span>
            </button>
          ))}
        </nav>

        <div className="gl__results">
        <p className="gl__resultCount" role="status">
          {packs === null
            ? ' '
            : `${shown.length} ${shown.length === 1 ? 'process' : 'processes'}${
                category === 'all' ? '' : ` in ${category}`
              }${query.trim() ? ` matching “${query.trim()}”` : ''}`}
        </p>

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
          /*
           * Grouped under their area, the way a template gallery is — rather
           * than one flat grid where eighty-eight cards of three categories
           * interleave and nothing can be found twice.
           */
          grouped.map(([area, items]) => (
            <section key={area} className="gl__group">
              <h2 className="gl__groupName">
                {area} <span className="gl__count">{items.length}</span>
              </h2>
              <ul className="gl__grid">
                {items.map((p) => (
                  <PackCard
                    key={p.id}
                    pack={p}
                    onUse={() => {
                      setInstalling(p);
                      setProcessKey(keyFrom(p.name));
                      setProcessName(p.name);
                    }}
                  />
                ))}
              </ul>
            </section>
          ))
        )}

        <p className="gl__other">
          Nothing here fits? <a href="/builder/ai">Describe your process in a sentence</a> and the
          builder will draft it, or copy one you already have.
        </p>
        </div>
      </div>

      {/* What is inside, counted from the blueprint rather than written. */}
      {installing && (
        <div className="gl__sheet" role="dialog" aria-modal="true" aria-labelledby="install-title">
          <div className="gl__sheetBox">
            <h2 id="install-title">Name it</h2>
            <p className="gl__sheetNote">
              This key identifies the process in your workspace. The public form gets its own link when you publish.
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
            <p id="new-key-hint" className="gl__sheetNote">Process key: {processKey || 'your_process'}</p>

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
                {busy ? 'Installing…' : 'Continue to setup'}
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
