'use client';

import { useCallback, useEffect, useState } from 'react';
import { postJson } from './stepup';

/*
 * Modules: the shelves this workspace has switched on, and the workspace
 * settings the modules share (PRD ORG-01). The platform is always on.
 * Switching a module off hides its templates and menus; it deletes nothing,
 * and the page says so where the switch is.
 */

type Module = {
  key: string; name: string; summary: string; core?: boolean; categories: string[];
  status: 'available' | 'templates_only' | 'coming'; enabled: boolean;
  changedAt: string | null; changedBy: string | null; plan: string | null;
};
type Settings = { name: string; timezone: string; defaultCurrency: string; locale: string; createdAt: string };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

const STATUS_WORDS: Record<Module['status'], string> = {
  available: 'Ready to use',
  templates_only: 'Templates now; shared records to follow',
  coming: 'Not built yet',
};

const ZONES = ['Europe/London', 'Africa/Lagos', 'Africa/Nairobi', 'Africa/Johannesburg', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Australia/Sydney', 'UTC'];
const CURRENCIES = ['GBP', 'NGN', 'USD', 'EUR', 'KES', 'GHS', 'ZAR', 'AED', 'INR'];
const LOCALES = ['en-GB', 'en-NG', 'en-US', 'en-KE', 'en-ZA', 'fr-FR'];

export function ModulesView({ canAdminister, onChanged }: { canAdminister: boolean; onChanged: () => void }) {
  const [modules, setModules] = useState<Module[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([get<Module[]>('/api/modules'), get<Settings>('/api/workspace/settings')]);
      setModules(m); setSettings(s); setDraft(s); setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (m: Module) => {
    setBusy(m.key); setNote(null);
    try {
      await postJson(`/api/modules/${m.key}`, { enabled: !m.enabled });
      await load();
      onChanged();
      setNote(m.enabled
        ? `${m.name} is off. Its templates and menus are hidden; nothing was deleted.`
        : `${m.name} is on. Its templates are in the builder gallery.`);
    } catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy('settings'); setNote(null);
    try {
      const saved = await postJson<Settings>('/api/workspace/settings', {
        name: draft.name, timezone: draft.timezone, defaultCurrency: draft.defaultCurrency, locale: draft.locale,
      });
      setSettings(saved); setDraft(saved); onChanged();
      setNote('Workspace settings saved.');
    } catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const dirty = !!draft && !!settings && (draft.name !== settings.name || draft.timezone !== settings.timezone || draft.defaultCurrency !== settings.defaultCurrency || draft.locale !== settings.locale);

  return <div className="ig__workspace">
    <header className="ig__hero">
      <span className="ig__eyebrow">WORKSPACE SETUP</span>
      <h2>Choose what this workspace uses</h2>
      <p>The platform is always on. Switch on the modules your organisation needs; switch one off and its templates and menus go away, with nothing deleted.</p>
    </header>

    {note && <p className="ig__notice" role="status">{note}</p>}
    {error && <p className="ig__error" role="alert">{error}</p>}

    <div className="ig__surface">
      <section className="ig__panel" aria-labelledby="modules-heading">
        <div className="ig__panelHead"><div><h3 id="modules-heading">Modules</h3><p>{canAdminister ? 'Owners and admins can switch modules on and off.' : 'Only owners and admins can change these.'}</p></div></div>
        {modules === null ? <p className="ig__rowMain" style={{ padding: '0 28px 24px' }}>Loading…</p> : <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {modules.map((m) => <li key={m.key} className="ig__row">
            <div className="ig__rowMain">
              <strong>{m.name}</strong>
              <span className={`ig__status ${m.enabled ? '' : 'ig__status--off'}`}>{m.core ? 'Always on' : m.enabled ? 'On' : 'Off'}</span>
              <p>{m.summary}</p>
              <p>{STATUS_WORDS[m.status]}{m.categories.length ? ` · Templates: ${m.categories.join(', ')}` : ''}{m.changedBy && !m.core ? ` · Changed by ${m.changedBy}` : ''}</p>
            </div>
            {!m.core && canAdminister && <button
              type="button"
              className={`cs__btn ${m.enabled ? '' : 'cs__btn--primary'}`}
              role="switch"
              aria-checked={m.enabled}
              aria-label={`${m.name}: ${m.enabled ? 'on' : 'off'}`}
              disabled={busy === m.key}
              onClick={() => void toggle(m)}
            >{busy === m.key ? 'Saving…' : m.enabled ? 'Switch off' : 'Switch on'}</button>}
          </li>)}
        </ul>}
      </section>
    </div>

    <div className="ig__surface" style={{ marginTop: 18 }}>
      <section className="ig__panel" aria-labelledby="settings-heading">
        <div className="ig__panelHead"><div><h3 id="settings-heading">Workspace settings</h3><p>Name, time zone, currency and language. Dates, deadlines and amounts follow these.</p></div></div>
        {draft && <form className="ig__form" onSubmit={saveSettings}>
          <div>
            <label className="cs__label" htmlFor="ws-name">Workspace name</label>
            <input id="ws-name" className="cs__input" value={draft.name} maxLength={120} disabled={!canAdminister} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div>
            <label className="cs__label" htmlFor="ws-tz">Time zone</label>
            <input id="ws-tz" className="cs__input" list="ws-tz-list" value={draft.timezone} disabled={!canAdminister} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} />
            <datalist id="ws-tz-list">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
          </div>
          <div>
            <label className="cs__label" htmlFor="ws-currency">Default currency</label>
            <input id="ws-currency" className="cs__input" list="ws-currency-list" value={draft.defaultCurrency} maxLength={3} disabled={!canAdminister} onChange={(e) => setDraft({ ...draft, defaultCurrency: e.target.value.toUpperCase() })} />
            <datalist id="ws-currency-list">{CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
          </div>
          <div>
            <label className="cs__label" htmlFor="ws-locale">Language and format</label>
            <input id="ws-locale" className="cs__input" list="ws-locale-list" value={draft.locale} disabled={!canAdminister} onChange={(e) => setDraft({ ...draft, locale: e.target.value })} />
            <datalist id="ws-locale-list">{LOCALES.map((l) => <option key={l} value={l} />)}</datalist>
          </div>
          {canAdminister && <button type="submit" className="cs__btn cs__btn--primary" disabled={!dirty || busy === 'settings'}>{busy === 'settings' ? 'Saving…' : 'Save settings'}</button>}
        </form>}
      </section>
    </div>
  </div>;
}
