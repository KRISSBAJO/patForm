'use client';

import { useCallback, useEffect, useState } from 'react';
import './platform.css';

type Section = 'overview' | 'workspaces' | 'jobs' | 'trace' | 'mail' | 'audit' | 'operators';
type Json = Record<string, any>;

async function api(path: string, init?: RequestInit): Promise<Json> {
  const response = await fetch(`/api/platform/${path}`, { credentials: 'include', cache: 'no-store', ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.reason || data.error || `Request failed (${response.status})`), { status: response.status, data });
  return data;
}

const sections: { key: Section; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'workspaces', label: 'Workspaces' },
  { key: 'jobs', label: 'Failed jobs' },
  { key: 'trace', label: 'Trace a request' },
  { key: 'mail', label: 'Email delivery' },
  { key: 'audit', label: 'Admin audit' },
  { key: 'operators', label: 'Site admins' },
];

function DateText({ value }: { value?: string }) {
  return <>{value ? new Date(value).toLocaleString() : '—'}</>;
}

export function Platform() {
  const [role, setRole] = useState<string>('');
  const [section, setSection] = useState<Section>('overview');
  const [data, setData] = useState<Json | null>(null);
  const [detail, setDetail] = useState<Json | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{ path: string; label: string; body?: object } | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('viewer');
  const [requestId, setRequestId] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      if (section === 'trace') {
        if (/^[\w.:-]{8,64}$/.test(requestId.trim())) setData(await api(`trace/${requestId.trim()}`));
        else setData(null);
      } else {
        const query = section === 'workspaces' ? `?q=${encodeURIComponent(search)}&page=${page}` : `?page=${page}`;
        setData(await api(section + query));
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [section, search, page, requestId]);

  useEffect(() => {
    api('me').then((v) => setRole(v.role)).catch((e) => setError(e.status === 401
      ? 'Sign in to your account first.'
      : e.status === 403
        ? 'Site administration needs an approved platform role, a verified email, and two-step verification. Check Your account in the customer console to turn on two-step verification.'
        : e.message));
  }, []);
  useEffect(() => { if (role) void load(); }, [role, load]);

  async function selectWorkspace(id: string) {
    setBusy(true); setError('');
    try { setDetail(await api(`workspaces/${id}`)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function runAction() {
    if (!action) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/reauthenticate', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, code }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.reason || result.error || 'Could not confirm your identity');
      const actionResult = await api(action.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action.body ?? {}) });
      if (actionResult.granted === false || actionResult.revoked === false || actionResult.retried === false) throw new Error(actionResult.reason || 'Action could not be completed');
      setAction(null); setPassword(''); setCode('');
      await load();
      if (detail?.workspace?.id) await selectWorkspace(detail.workspace.id);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  function navigate(next: Section) { setSection(next); setData(null); setDetail(null); setPage(1); }
  const mayAct = role === 'owner' || role === 'operator';

  return <main className="platform">
    <header className="platform__top"><div><strong>PatForm</strong><span>Site administration</span></div><a href="/console">Customer console ↗</a></header>
    <div className="platform__layout">
      <nav className="platform__nav" aria-label="Site administration">
        <p>OPERATIONS</p>
        {sections.map((s) => <button key={s.key} className={section === s.key ? 'active' : ''} onClick={() => navigate(s.key)}>{s.label}</button>)}
        <small>Platform access: {role || 'checking…'}</small>
      </nav>
      <div className="platform__main">
        <div className="platform__heading"><div><span className="platform__eyebrow">SITE ADMIN</span><h1>{sections.find((s) => s.key === section)?.label}</h1></div><button onClick={() => void load()} disabled={!role || busy}>Refresh</button></div>
        {error && <div className="platform__error" role="alert">{error} {!role && <a href="/console">Open your account</a>}</div>}
        {!role && !error && <p>Checking your access…</p>}
        {data && section === 'overview' && <>
          <div className="platform__metrics">
            {Object.entries({ Workspaces: data.counts.workspaces, People: data.counts.people, Processes: data.counts.processes, Records: data.counts.records, 'Open records': data.counts.open_records, 'Failed jobs': data.counts.failed_jobs, 'Dead webhooks': data.counts.dead_webhooks, 'Overdue timers': data.counts.overdue_timers }).map(([label, value]) =>
              <article key={label} className="platform__card"><span>{label}</span><strong>{String(value ?? 0)}</strong></article>)}
          </div>
          <div className="platform__columns"><section className="platform__panel"><h2>Service health</h2><p>API is responding · Uptime {data.api.uptimeSeconds}s</p><p>Revision {data.api.revision || 'not reported by host'}</p><h3>Workers</h3>{data.workers.length ? data.workers.map((w: Json) => <p key={w.worker_id}><b className={w.healthy ? 'platform__good' : 'platform__bad'}>{w.healthy ? 'Running' : 'Stale'}</b> · last seen <DateText value={w.seen_at} /> · {w.errors} errors</p>) : <p>No worker heartbeat recorded.</p>}{data.stagingCombinedService && <small>Staging worker pauses when the free service sleeps.</small>}</section>
          <section className="platform__panel"><h2>Email, last 7 days</h2>{data.mail.length ? data.mail.map((m: Json) => <p key={m.status}>{m.status}: <b>{m.count}</b></p>) : <p>No email yet.</p>}{data.deliveryAlert && <p className="platform__bad">Open {data.deliveryAlert.level} delivery alert · {data.deliveryAlert.bounced} bounced</p>}</section></div>
          <div className="platform__columns"><section className="platform__panel"><h2>Recent workspaces</h2>{data.recentWorkspaces.map((w: Json) => <button className="platform__rowbutton" key={w.id} onClick={() => { navigate('workspaces'); void selectWorkspace(w.id); }}>{w.name}<span>{w.records} records →</span></button>)}</section>
          <section className="platform__panel"><h2>Recent service starts</h2>{data.deployments.map((d: Json, i: number) => <p key={i}><DateText value={d.started_at} /> · {d.environment} · {d.revision?.slice(0, 12) || 'revision unavailable'}</p>)}<small>These show service starts. Hosting provider deploy status needs a provider connection.</small></section></div>
        </>}
        {data && section === 'workspaces' && <>
          <div className="platform__filters"><label>Find a workspace <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Workspace name" /></label><span>{data.total} workspaces</span></div>
          <div className="platform__table"><table><thead><tr><th>Workspace</th><th>People</th><th>Processes</th><th>Records</th><th>Failed jobs</th><th>Created</th></tr></thead><tbody>{data.rows.map((w: Json) => <tr key={w.id}><td><button className="platform__link" onClick={() => void selectWorkspace(w.id)}>{w.name}</button></td><td>{w.people}</td><td>{w.processes}</td><td>{w.records}</td><td>{w.failed_jobs}</td><td><DateText value={w.created_at} /></td></tr>)}</tbody></table></div>
          {detail && <section className="platform__panel platform__detail"><button className="platform__close" onClick={() => setDetail(null)}>Close</button><h2>{detail.workspace.name}</h2><p>{detail.workspace.id}</p><h3>Installed processes</h3><p>{detail.processes.map((p: Json) => `${p.process_key} v${p.version}`).join(' · ') || 'None yet'}</p><h3>People</h3><div className="platform__table"><table><thead><tr><th>Name</th><th>Email</th><th>Workspace role</th><th>Sessions</th><th>Access</th></tr></thead><tbody>{detail.people.map((p: Json) => <tr key={p.id}><td>{p.display_name}</td><td>{p.email}</td><td>{p.workspace_role}</td><td>{p.sessions}</td><td>{mayAct && p.sessions > 0 && <button onClick={() => setAction({ path: `people/${p.id}/revoke-sessions`, label: `Sign ${p.display_name} out of every device` })}>Revoke sessions</button>}</td></tr>)}</tbody></table></div></section>}
        </>}
        {data && section === 'jobs' && <section className="platform__panel"><h2>Failed workflow jobs</h2>{!data.rows.length && <p>No failed jobs.</p>}{data.rows.map((j: Json) => <div className="platform__job" key={j.id}><div><b>{j.workspace}</b> · {j.transition_key} · job #{j.id}</div><p>Attempts {j.attempts} · <DateText value={j.created_at} /> · request {j.request_id}</p><p>Error details stay in the workspace support trace.</p>{mayAct && <button onClick={() => setAction({ path: `jobs/${j.id}/retry`, label: `Retry job #${j.id}` })}>Retry job</button>}</div>)}</section>}
        {section === 'trace' && <><div className="platform__filters"><label>Request ID<input value={requestId} onChange={(e) => setRequestId(e.target.value)} placeholder="Paste a request ID" /></label></div>{data && <div className="platform__columns"><section className="platform__panel"><h2>Events ({data.events.length})</h2>{data.events.map((e: Json, i: number) => <p key={i}><DateText value={e.occurred_at} /> · {e.workspace} · {e.type} · sequence {e.seq}</p>)}</section><section className="platform__panel"><h2>Jobs ({data.jobs.length})</h2>{data.jobs.map((j: Json) => <p key={j.id}>#{j.id} · {j.workspace} · {j.transition_key} · {j.has_error ? 'failed' : j.done_at ? 'done' : 'pending'}</p>)}<h2>Actions ({data.actions.length})</h2>{data.actions.map((a: Json) => <p key={a.id}>{a.workspace} · {a.action_do} · {a.status} · {a.attempts} attempts</p>)}</section></div>}</>}
        {data && section === 'mail' && <div className="platform__columns"><section className="platform__panel"><h2>Process email, last 7 days</h2>{data.process.map((m: Json, i: number) => <p key={i}>{m.workspace}: {m.status} <b>{m.count}</b></p>)}{!data.process.length && <p>No process email.</p>}</section><section className="platform__panel"><h2>Account email, last 7 days</h2>{data.account.map((m: Json, i: number) => <p key={i}>{m.workspace || 'Platform'} · {m.kind}: {m.status} <b>{m.count}</b></p>)}{!data.account.length && <p>No account email.</p>}<h3>Delivery alerts</h3>{data.alerts.map((a: Json) => <p key={a.id}>{a.level} · {a.bounced} bounces, {a.complained} complaints · <DateText value={a.raised_at} /></p>)}</section></div>}
        {data && section === 'audit' && <section className="platform__panel"><h2>Site admin actions</h2>{data.rows.map((a: Json) => <p key={a.id}><DateText value={a.occurred_at} /> · <b>{a.actor || 'System'}</b> · {a.action} · {a.workspace || a.target_id || 'Platform'}</p>)}{!data.rows.length && <p>No admin actions yet.</p>}</section>}
        {data && section === 'operators' && <><section className="platform__panel"><h2>Site admins</h2><p>Roles here are separate from customer workspace roles. Every site admin must have a verified email and two-step verification.</p><div className="platform__table"><table><thead><tr><th>Name</th><th>Email</th><th>Site role</th><th>Status</th><th>MFA</th><th>Granted</th><th></th></tr></thead><tbody>{data.rows.map((p: Json) => <tr key={p.actor_id}><td>{p.display_name}</td><td>{p.email}</td><td>{p.role}</td><td>{p.revoked_at ? 'Revoked' : p.active ? 'Active' : 'Inactive'}</td><td>{p.mfa_enabled ? 'On' : 'Setup needed'}</td><td><DateText value={p.granted_at} /></td><td>{!p.revoked_at && <button onClick={() => setAction({ path: `operators/${p.actor_id}/revoke`, label: `Revoke site admin access for ${p.display_name}` })}>Revoke</button>}</td></tr>)}</tbody></table></div></section><section className="platform__panel"><h2>Grant site access</h2><p>The person must already have an account and a verified email.</p><div className="platform__filters"><label>Email<input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} /></label><label>Role<select value={newRole} onChange={(e) => setNewRole(e.target.value)}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="owner">Owner</option></select></label><button disabled={!newEmail.includes('@')} onClick={() => setAction({ path: 'operators', label: `Give ${newEmail} the ${newRole} site role`, body: { email: newEmail, role: newRole } })}>Review grant</button></div></section></>}
        {data && ['workspaces', 'jobs', 'audit'].includes(section) && <div className="platform__pager"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page}</span><button disabled={section === 'workspaces' ? page * 25 >= data.total : data.rows.length < (section === 'audit' ? 50 : 25)} onClick={() => setPage(page + 1)}>Next</button></div>}
      </div>
    </div>
    {action && <div className="platform__shade" role="presentation"><div className="platform__dialog" role="dialog" aria-modal="true" aria-labelledby="platform-confirm-title"><h2 id="platform-confirm-title">Confirm admin action</h2><p>{action.label}. This action is recorded in the site admin audit.</p><label>Password <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label><label>Authenticator code <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label><div><button onClick={() => { setAction(null); setPassword(''); setCode(''); }}>Cancel</button><button className="platform__primary" disabled={busy || !password || !code} onClick={() => void runAction()}>Confirm action</button></div></div></div>}
  </main>;
}
