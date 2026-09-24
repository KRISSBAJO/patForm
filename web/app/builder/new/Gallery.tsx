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
  const [view, setView] = useState<'choose' | 'templates'>('choose');
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

  useEffect(() => {
    const syncView = () => setView(new URLSearchParams(window.location.search).get('view') === 'templates' ? 'templates' : 'choose');
    syncView();
    window.addEventListener('popstate', syncView);
    return () => window.removeEventListener('popstate', syncView);
  }, []);

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

      {view === 'choose' ? (
        <main className="gl__choose">
          <span className="gl__eyebrow">Start a process</span>
          <h1>How would you like to begin?</h1>
          <p className="gl__chooseIntro">Choose a starting point. Everything opens as a private draft for you to review.</p>
          <div className="gl__paths">
            <button type="button" className="gl__path gl__path--featured" onClick={() => {
              window.history.pushState(null, '', '/builder/new?view=templates');
              setView('templates');
            }}>
              <PathIcon name="template" />
              <span className="gl__pathText"><strong>Start from a template</strong><span>Choose a ready-made process with its form and approvals already connected.</span></span>
              <span className="gl__pathArrow" aria-hidden="true">→</span>
            </button>
            <a className="gl__path" href="/builder/ai">
              <PathIcon name="sparkles" />
              <span className="gl__pathText"><strong>Describe your process</strong><span>Tell us what happens. AI will prepare a draft for you to check.</span></span>
              <span className="gl__pathArrow" aria-hidden="true">→</span>
            </a>
            <a className="gl__path" href="/builder?new=copy">
              <PathIcon name="copy" />
              <span className="gl__pathText"><strong>Adapt an existing process</strong><span>Copy one of your published processes and change what differs.</span></span>
              <span className="gl__pathArrow" aria-hidden="true">→</span>
            </a>
          </div>
          <p className="gl__chooseFoot">Your process stays private until you publish it.</p>
        </main>
      ) : <>
      <div className="gl__head">
        <div className="gl__headInner">
          <a className="gl__back" href="/builder/new">← All starting options</a>
          <h1>Start from something that already works</h1>
          <p>
            Choose a ready-made process. Review and edit your private draft before publishing.
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
        <div className="gl__mobileFilter">
          <label htmlFor="pack-category">Category</label>
          <select id="pack-category" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="all">Everything ({packs?.length ?? 0})</option>
            {categories.map(([name, count]) => (
              <option key={name} value={name}>{name} ({count})</option>
            ))}
          </select>
        </div>
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
      </>}

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

function PathIcon({ name }: { name: 'template' | 'sparkles' | 'copy' }) {
  return <span className="gl__pathIcon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {name === 'template' && <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 13h4M8 16h8" /></>}
    {name === 'sparkles' && <><path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z" /><path d="m19 17 .6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6L19 17Z" /></>}
    {name === 'copy' && <><rect x="8" y="7" width="12" height="13" rx="2" /><path d="M16 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" /></>}
  </svg></span>;
}
