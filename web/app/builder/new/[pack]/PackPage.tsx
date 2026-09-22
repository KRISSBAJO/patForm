'use client';

/**
 * One pack, on its own page.
 *
 * It was a modal, and a modal was wrong for it in every way that matters:
 * this is a screenful somebody reads carefully, compares against another
 * pack, sends to a colleague to check, and comes back to after installing
 * something else. A dialog has no address, closes when you look away, and
 * takes the page behind it hostage while it is open.
 *
 * The naming step is still a dialog, because that one really is a step in the
 * middle of an action rather than something to read.
 */

import { useCallback, useEffect, useState } from 'react';
import '../../builder.css';
import '../gallery.css';
import '../cards.css';
import { PackBody } from '../PackDetail';
import type { Pack } from '../PackCard';

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

export function PackPage({ packId }: { packId: string }) {
  const [pack, setPack] = useState<Pack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [processKey, setProcessKey] = useState('');
  const [processName, setProcessName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const p = await call<Pack>(`/api/packs/${packId}`);
        setPack(p);
        setProcessKey(keyFrom(p.name));
        setProcessName(p.name);
      } catch (err) {
        if (err instanceof Error && err.message === 'signed-out') {
          window.location.href = '/console';
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [packId]);

  const install = useCallback(async () => {
    if (!pack) return;
    setBusy(true);
    setError(null);
    try {
      const done = await call<{ draftId: string }>(`/api/packs/${pack.id}/install`, {
        method: 'POST',
        body: JSON.stringify({ processKey, processName }),
      });
      window.location.href = `/builder?draft=${done.draftId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [pack, processKey, processName]);

  if (error && !pack) {
    return (
      <main className="gl">
        <p className="gl__error" role="alert">
          {error}
        </p>
        <a className="pd__back" href="/builder/new">
          Back to the catalogue
        </a>
      </main>
    );
  }

  if (!pack) {
    return (
      <main className="gl">
        <p className="gl__loading">Reading the pack…</p>
      </main>
    );
  }

  return (
    <main className="gl pdp">
      <a className="pd__back" href="/builder/new">
        ← Back to the catalogue
      </a>

      <header className="pdp__head">
        <div>
          <span className="pd__cat">{pack.category}</span>
          <h1 className="pdp__title">{pack.name}</h1>
          <p className="pd__audience">{pack.audience}</p>
        </div>
        <div className="pdp__actions">
          <button type="button" className="pd__use" onClick={() => setNaming(true)}>
            Use this
          </button>
          <span className="pd__footNote">Installing opens a draft. Nothing goes live until you publish it.</span>
        </div>
      </header>

      {error && (
        <p className="gl__error" role="alert">
          {error}
        </p>
      )}

      <div className="pdp__body">
        <PackBody pack={pack} />
      </div>

      {/*
        * A step in the middle of an action, not something to read — which is
        * what a dialog is for, and why this one stayed one.
        */}
      {naming && (
        <div className="gl__sheet" role="dialog" aria-modal="true" aria-labelledby="name-title">
          <div className="gl__sheetBox">
            <h2 id="name-title">Name it</h2>
            <p className="gl__sheetNote">
              The key ends up in the public form link, so it is worth getting right — it cannot be changed once
              anybody has the link.
            </p>

            <label className="cs__label" htmlFor="pack-key">
              Key
            </label>
            <input
              id="pack-key"
              className="cs__input"
              value={processKey}
              onChange={(e) => setProcessKey(keyFrom(e.target.value))}
              aria-describedby="pack-key-hint"
            />
            <p id="pack-key-hint" className="gl__sheetNote">
              /f/{processKey || 'your_process'}
            </p>

            <label className="cs__label" htmlFor="pack-name">
              Name
            </label>
            <input
              id="pack-name"
              className="cs__input"
              value={processName}
              onChange={(e) => setProcessName(e.target.value)}
            />

            <div className="gl__sheetActions">
              <button type="button" className="pd__cancel" onClick={() => setNaming(false)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="pd__use"
                onClick={() => void install()}
                disabled={busy || !processKey || !processName.trim()}
              >
                {busy ? 'Installing…' : 'Install'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
