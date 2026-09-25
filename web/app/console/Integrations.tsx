'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { postJson } from './stepup';

type Tab = 'keys' | 'webhooks' | 'deliveries' | 'apps';
type ApiKey = { id: string; name: string; key_prefix: string; scopes: string[]; created_by: string; created_at: string; last_used_at: string | null; revoked_at: string | null };
type Endpoint = { id: string; url: string; description: string | null; events: string[]; active: boolean; rotating: boolean; dead_letters: number };
type Delivery = { id: number; event_name: string; status: string; attempts: number; response_status: number | null; last_error: string | null; url: string | null; created_at: string };
type Grant = { id: string; client_name: string; scopes: string[]; granted_by: string; created_at: string; revoked_at: string | null };

const SCOPES = [
  { value: 'view', label: 'Read processes and records' },
  { value: 'edit', label: 'Create records and import them' },
  { value: 'report', label: 'Read metrics' },
];

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

function useFeed<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setData(await get<T>(path)); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="ig__empty"><span className="ig__emptyMark" aria-hidden="true"><Icon name="done" /></span><strong>{title}</strong><p>{body}</p></div>;
}

function date(value: string | null) { return value ? new Date(value).toLocaleDateString() : 'Never'; }

export function IntegrationsView() {
  const keys = useFeed<ApiKey[]>('/api/keys');
  const endpoints = useFeed<Endpoint[]>('/api/webhooks');
  const deliveries = useFeed<Delivery[]>('/api/webhooks/deliveries');
  const grants = useFeed<Grant[]>('/api/oauth/grants');
  const [tab, setTab] = useState<Tab>('keys');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ what: string; value: string } | null>(null);
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<string[]>(['view']);
  const [hookUrl, setHookUrl] = useState('');
  const [hookKind, setHookKind] = useState<'http' | 'slack' | 'teams'>('http');
  const [clientName, setClientName] = useState('');
  const [clientRedirects, setClientRedirects] = useState('');
  const [confidential, setConfidential] = useState(true);

  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { setNote(await work()); }
    catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const tabs: { id: Tab; name: string; count: number; icon: 'table' | 'export' | 'trail' | 'account' }[] = [
    { id: 'keys', name: 'API keys', count: keys.data?.filter(k => !k.revoked_at).length ?? 0, icon: 'table' },
    { id: 'webhooks', name: 'Webhooks', count: endpoints.data?.length ?? 0, icon: 'export' },
    { id: 'deliveries', name: 'Deliveries', count: deliveries.data?.length ?? 0, icon: 'trail' },
    { id: 'apps', name: 'Applications', count: grants.data?.filter(g => !g.revoked_at).length ?? 0, icon: 'account' },
  ];
  const copy = {
    keys: ['API keys', 'Give a trusted system access to PatForm through the public API.', 'Create key'],
    webhooks: ['Webhooks', 'Send record events to your own service or a team channel.', 'Add endpoint'],
    deliveries: ['Deliveries', 'Check recent webhook attempts and replay an event when needed.', ''],
    apps: ['Connected applications', 'Manage apps people have authorised and register a new one.', 'Register app'],
  }[tab];
  const activeError = { keys: keys.error, webhooks: endpoints.error, deliveries: deliveries.error, apps: grants.error }[tab];
  const activeKeys = keys.data?.filter(key => !key.revoked_at) ?? [];
  const revokedKeys = keys.data?.filter(key => !!key.revoked_at) ?? [];
  const keyRow = (key: ApiKey) => <li key={key.id} className="ig__row"><div className="ig__rowMain"><strong>{key.name}</strong><span className="ig__mono">{key.key_prefix}…</span><span className={`ig__status ${key.revoked_at ? 'ig__status--off' : ''}`}>{key.revoked_at ? 'Revoked' : 'Active'}</span><p>{key.scopes.join(' · ')} · Created by {key.created_by} · Last used {date(key.last_used_at)}</p></div>{!key.revoked_at && <button type="button" className="cs__btn" disabled={busy === key.id} onClick={() => void act(key.id, async () => { await postJson(`/api/keys/${key.id}/revoke`); await keys.reload(); return `“${key.name}” stops working immediately.`; })}>Revoke</button>}</li>;

  return <div className="ig__workspace">
    <header className="ig__hero">
      <span className="ig__eyebrow">WORKSPACE CONNECTIONS</span>
      <h2>Connect PatForm to your tools</h2>
      <p>Manage access, event notifications and applications from one place.</p>
    </header>

    <div className="ig__surface">
      <div className="ig__tabs" role="tablist" aria-label="Integration areas">
        {tabs.map((item, index) => <button key={item.id} id={`ig-tab-${item.id}`} type="button" role="tab" aria-controls={`ig-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className="ig__tab" onClick={() => { setTab(item.id); setCreating(false); setNote(null); }} onKeyDown={event => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1; if (next < 0) return; event.preventDefault(); const id = tabs[next]!.id; setTab(id); setCreating(false); setNote(null); document.getElementById(`ig-tab-${id}`)?.focus(); }}>
          <Icon name={item.icon} /><span>{item.name}</span><span className="ig__tabCount">{item.count}</span>
        </button>)}
      </div>

      <section id={`ig-panel-${tab}`} role="tabpanel" aria-labelledby={`ig-tab-${tab}`} className="ig__panel">
        <div className="ig__panelHead"><div><h3>{copy[0]}</h3><p>{copy[1]}</p></div>{copy[2] && <button type="button" className="cs__btn cs__btn--primary" aria-expanded={creating} onClick={() => setCreating(v => !v)}>{creating ? 'Close form' : copy[2]}</button>}</div>

        {minted && <div className="ig__secret" role="status"><div><strong>Copy your {minted.what} now</strong><p>It is shown once. Save it somewhere secure before closing this message.</p></div><code>{minted.value}</code><div className="ig__secretActions"><button type="button" className="cs__btn" onClick={() => void navigator.clipboard?.writeText(minted.value)}>Copy</button><button type="button" className="cs__btn" onClick={() => setMinted(null)}>I’ve saved it</button></div></div>}
        {note && <p className="ig__notice" role="status">{note}</p>}
        {activeError && <p className="ig__error" role="alert">{activeError}</p>}

        {tab === 'keys' && <>
          {creating && <form className="ig__form" onSubmit={e => { e.preventDefault(); void act('new-key', async () => { const made = await postJson<{ key: string }>('/api/keys', { name: keyName, scopes: keyScopes }); setKeyName(''); setCreating(false); setMinted({ what: 'API key', value: made.key }); await keys.reload(); return 'API key created.'; }); }}>
            <div className="ig__formTitle"><strong>Create an API key</strong><p>Its access is limited by your role and the permissions you select.</p></div>
            <label className="ig__field">Key name<input className="cs__input" value={keyName} onChange={e => setKeyName(e.target.value)} placeholder="e.g. HR system" required /></label>
            <fieldset className="ig__scope"><legend>What it may do</legend>{SCOPES.map(scope => <label key={scope.value}><input type="checkbox" checked={keyScopes.includes(scope.value)} onChange={e => setKeyScopes(was => e.target.checked ? [...was, scope.value] : was.filter(s => s !== scope.value))} />{scope.label}</label>)}</fieldset>
            <button className="cs__btn cs__btn--primary" type="submit" disabled={busy === 'new-key' || !keyScopes.length}>Create key</button>
          </form>}
          {keys.data === null && !keys.error ? <div className="ig__loading">Loading keys…</div> : activeKeys.length ? <ul className="ig__list">{activeKeys.map(keyRow)}</ul> : <EmptyState title="No active API keys" body="Create a key when a trusted system needs to call the API." />}
          {revokedKeys.length > 0 && <details className="ig__archive"><summary>Revoked keys ({revokedKeys.length})</summary><ul className="ig__list">{revokedKeys.map(keyRow)}</ul></details>}
        </>}

        {tab === 'webhooks' && <>
          {creating && <form className="ig__form" onSubmit={e => { e.preventDefault(); void act('new-hook', async () => { const made = await postJson<{ secret?: string }>('/api/webhooks', { url: hookUrl, kind: hookKind }); setHookUrl(''); setCreating(false); if (made.secret) setMinted({ what: 'signing secret', value: made.secret }); await endpoints.reload(); return 'Webhook endpoint added.'; }); }}>
            <div className="ig__formTitle"><strong>Add a webhook endpoint</strong><p>Record events are signed so your receiver can verify them.</p></div>
            <label className="ig__field">Endpoint URL<input className="cs__input" type="url" value={hookUrl} onChange={e => setHookUrl(e.target.value)} placeholder="https://example.com/hooks/patform" required /></label>
            <label className="ig__field">Destination<select className="cs__input" value={hookKind} onChange={e => setHookKind(e.target.value as typeof hookKind)}><option value="http">Your own service</option><option value="slack">Slack</option><option value="teams">Microsoft Teams</option></select></label>
            <p className="ig__formHint">{hookKind === 'http' ? 'Your service receives signed JSON.' : 'Team channels receive a reference, without private form answers.'}</p>
            <button className="cs__btn cs__btn--primary" type="submit" disabled={busy === 'new-hook'}>Add endpoint</button>
          </form>}
          {endpoints.data === null && !endpoints.error ? <div className="ig__loading">Loading webhooks…</div> : endpoints.data?.length ? <ul className="ig__list">{endpoints.data.map(endpoint => <li key={endpoint.id} className="ig__row"><div className="ig__rowMain"><strong className="ig__url">{endpoint.url}</strong><span className={`ig__status ${!endpoint.active ? 'ig__status--off' : ''}`}>{!endpoint.active ? 'Disabled' : endpoint.dead_letters ? `${endpoint.dead_letters} failed` : endpoint.rotating ? 'Rotating' : 'Active'}</span><p>{endpoint.description || 'Webhook endpoint'} · Events: {endpoint.events.length ? endpoint.events.join(', ') : 'All'}</p></div><button type="button" className="cs__btn" disabled={busy === endpoint.id} onClick={() => void act(endpoint.id, async () => { if (endpoint.rotating) { await postJson(`/api/webhooks/${endpoint.id}/rotate/complete`); await endpoints.reload(); return 'Old signing secret retired.'; } const done = await postJson<{ secret: string }>(`/api/webhooks/${endpoint.id}/rotate`); setMinted({ what: 'new signing secret', value: done.secret }); await endpoints.reload(); return 'Both secrets sign until you finish rotation.'; })}>{endpoint.rotating ? 'Finish rotation' : 'Rotate secret'}</button></li>)}</ul> : <EmptyState title="No webhooks yet" body="Add an endpoint to send record events to another tool." />}
        </>}

        {tab === 'deliveries' && <>{deliveries.data === null && !deliveries.error ? <div className="ig__loading">Loading deliveries…</div> : deliveries.data?.length ? <ul className="ig__list">{deliveries.data.slice(0, 25).map(delivery => <li key={delivery.id} className="ig__row"><div className="ig__rowMain"><strong>{delivery.event_name}</strong><span className={`ig__status ${delivery.status !== 'delivered' ? 'ig__status--off' : ''}`}>{delivery.status}</span><p>{delivery.url || 'Endpoint removed'} · {date(delivery.created_at)} · {delivery.attempts} {delivery.attempts === 1 ? 'attempt' : 'attempts'}</p>{delivery.last_error && <p className="ig__rowError">{delivery.last_error}</p>}</div>{delivery.status !== 'delivered' && <button type="button" className="cs__btn" disabled={busy === `d${delivery.id}`} onClick={() => void act(`d${delivery.id}`, async () => { await postJson(`/api/webhooks/deliveries/${delivery.id}/replay`); await deliveries.reload(); return 'Event queued for replay.'; })}>Replay</button>}</li>)}</ul> : <EmptyState title="No deliveries yet" body="Delivery attempts will appear here after a record event is sent." />}</>}

        {tab === 'apps' && <>
          {creating && <form className="ig__form" onSubmit={e => { e.preventDefault(); void act('new-client', async () => { const made = await postJson<{ clientId: string; clientSecret?: string }>('/api/oauth/clients', { name: clientName, redirectUris: clientRedirects.split(/\s+/).filter(Boolean), confidential }); setClientName(''); setClientRedirects(''); setCreating(false); if (made.clientSecret) setMinted({ what: 'client secret', value: made.clientSecret }); return `Application registered. Client ID: ${made.clientId}`; }); }}>
            <div className="ig__formTitle"><strong>Register an application</strong><p>People approve an app before it can act with their permissions.</p></div>
            <label className="ig__field">Application name<input className="cs__input" value={clientName} onChange={e => setClientName(e.target.value)} required /></label>
            <label className="ig__field">Where it runs<select className="cs__input" value={confidential ? 'server' : 'device'} onChange={e => setConfidential(e.target.value === 'server')}><option value="server">On a server — can keep a secret</option><option value="device">In a browser or phone — no secret</option></select></label>
            <label className="ig__field ig__field--wide">Redirect URLs, one per line<textarea className="cs__input" rows={3} value={clientRedirects} onChange={e => setClientRedirects(e.target.value)} required /></label>
            <button className="cs__btn cs__btn--primary" type="submit" disabled={busy === 'new-client'}>Register application</button>
          </form>}
          {grants.data === null && !grants.error ? <div className="ig__loading">Loading applications…</div> : grants.data?.filter(grant => !grant.revoked_at).length ? <ul className="ig__list">{grants.data.filter(grant => !grant.revoked_at).map(grant => <li key={grant.id} className="ig__row"><div className="ig__rowMain"><strong>{grant.client_name}</strong><span className="ig__status">Connected</span><p>{grant.scopes.join(' · ')} · Approved by {grant.granted_by} · {date(grant.created_at)}</p></div><button type="button" className="cs__btn" disabled={busy === grant.id} onClick={() => void act(grant.id, async () => { await postJson(`/api/oauth/grants/${grant.id}/revoke`); await grants.reload(); return `${grant.client_name} can no longer act for anyone here.`; })}>Revoke access</button></li>)}</ul> : <EmptyState title="No connected applications" body="Applications people authorise will appear here." />}
        </>}
      </section>
    </div>
  </div>;
}
