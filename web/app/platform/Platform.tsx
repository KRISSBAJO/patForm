'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import './platform.css';

type Section = 'overview' | 'workspaces' | 'people' | 'integrations' | 'security' | 'jobs' | 'trace' | 'mail' | 'audit' | 'operators';
type Json = Record<string, any>;
type Action = { path: string; label: string; body?: object; needsReason?: boolean };

const sections: { key: Section; label: string; description: string; icon: string; group: string }[] = [
  { key: 'overview', label: 'Overview', description: 'The health of PatForm at a glance.', icon: 'overview', group: 'Monitor' },
  { key: 'workspaces', label: 'Workspaces', description: 'Find customers, processes and people.', icon: 'workspaces', group: 'Monitor' },
  { key: 'people', label: 'People', description: 'Find accounts and their workspace access.', icon: 'operators', group: 'Manage' },
  { key: 'integrations', label: 'Integrations', description: 'Review connected apps and delivery health.', icon: 'trace', group: 'Monitor' },
  { key: 'security', label: 'Security', description: 'See account protection and active access.', icon: 'audit', group: 'Manage' },
  { key: 'jobs', label: 'Failed jobs', description: 'Investigate and retry work that stopped.', icon: 'jobs', group: 'Monitor' },
  { key: 'trace', label: 'Trace a request', description: 'Follow one request through events and actions.', icon: 'trace', group: 'Investigate' },
  { key: 'mail', label: 'Email delivery', description: 'See delivery outcomes and open alerts.', icon: 'mail', group: 'Investigate' },
  { key: 'audit', label: 'Admin audit', description: 'Review actions taken across the site.', icon: 'audit', group: 'Manage' },
  { key: 'operators', label: 'Site admins', description: 'Manage who can operate PatForm.', icon: 'operators', group: 'Manage' },
];

async function api(path: string, init?: RequestInit): Promise<Json> {
  const response = await fetch(`/api/platform/${path}`, { credentials: 'include', cache: 'no-store', ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.reason || data.error || `Request failed (${response.status})`), { status: response.status });
  return data;
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    workspaces: <><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 21V8h8v13M3 11h18M11 8h2"/></>,
    jobs: <><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2M16 3h5v5"/></>,
    trace: <><circle cx="5" cy="5" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><path d="M7 5h5a5 5 0 0 1 5 5M17 14a5 5 0 0 1-5 5H7"/></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
    audit: <><path d="M8 3h8l4 4v14H4V3h4ZM16 3v5h4M8 12h8M8 16h6"/></>,
    operators: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 8h4M19 6v4"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.7 9A7 7 0 0 1 18 7l2 5M4 12l2 5a7 7 0 0 0 12 0"/></>,
    arrow: <><path d="M4 12h16m-6-6 6 6-6 6"/></>,
    check: <><path d="m4 12 5 5L20 6"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    shield: <><path d="M12 2 4 5v6c0 5 3 8 8 11 5-3 8-6 8-11V5l-8-3Z"/><path d="m9 12 2 2 4-4"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name] || paths.overview}</svg>;
}

function DateText({ value }: { value?: string }) {
  if (!value) return <>—</>;
  const date = new Date(value);
  return <>{Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()}</>;
}

function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'bad' | 'warn' }) {
  return <span className={`platform__pill platform__pill--${tone}`}>{children}</span>;
}

function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="platform__empty"><span className="platform__emptyIcon"><Icon name="check" size={22}/></span><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

function Panel({ title, aside, children, className = '' }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`platform__panel ${className}`}><div className="platform__panelHead"><h2>{title}</h2>{aside}</div>{children}</section>;
}

export function Platform() {
  const [role, setRole] = useState('');
  const [section, setSection] = useState<Section>('overview');
  const [data, setData] = useState<Json | null>(null);
  const [detail, setDetail] = useState<Json | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [workspaceScope, setWorkspaceScope] = useState<'customers' | 'tests' | 'all'>('customers');
  const [peopleStatus, setPeopleStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('viewer');
  const [requestId, setRequestId] = useState('');
  const [traceQuery, setTraceQuery] = useState('');
  const [showTestMail, setShowTestMail] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [actionReason, setActionReason] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      if (section === 'trace') {
        setData(traceQuery ? await api(`trace/${traceQuery}`) : null);
      } else {
        const query = section === 'workspaces' ? `?q=${encodeURIComponent(search)}&page=${page}&scope=${workspaceScope}`
          : section === 'people' ? `?q=${encodeURIComponent(search)}&page=${page}&status=${peopleStatus}`
          : section === 'integrations' ? `?q=${encodeURIComponent(search)}&page=${page}` : `?page=${page}`;
        setData(await api(section + query));
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [section, search, page, traceQuery, workspaceScope, peopleStatus]);

  useEffect(() => {
    api('me').then((v) => setRole(v.role)).catch((e) => setError(e.status === 401
      ? 'Sign in to your account first.'
      : e.status === 403
        ? 'Site administration requires a site role, a verified email and two-step verification.'
        : e.message));
  }, []);
  useEffect(() => { if (role) void load(); }, [role, load]);

  const selectWorkspace = useCallback(async (id: string, updateAddress = true) => {
    if (updateAddress) {
      const address = new URL(window.location.href);
      address.searchParams.set('section', 'workspaces');
      address.searchParams.set('workspace', id);
      window.history.pushState({}, '', address);
    }
    setDetail(null);
    setDetailLoading(true);
    setBusy(true); setError('');
    try { const next = await api(`workspaces/${id}`); setDetail(next); setWorkspaceName(next.workspace.name); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setDetailLoading(false); }
  }, []);

  useEffect(() => {
    if (!role) return;
    const syncAddress = () => {
      const params = new URLSearchParams(window.location.search);
      const wanted = params.get('section');
      const next = sections.some((s) => s.key === wanted) ? wanted as Section : 'overview';
      const workspace = params.get('workspace');
      setSection(next); setData(null); setPage(1); setError('');
      if (next === 'workspaces' && workspace && /^[0-9a-f-]{36}$/.test(workspace)) {
        void selectWorkspace(workspace, false);
      } else { setDetail(null); setDetailLoading(false); }
    };
    syncAddress();
    window.addEventListener('popstate', syncAddress);
    return () => window.removeEventListener('popstate', syncAddress);
  }, [role, selectWorkspace]);

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
      const actionResult = await api(action.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...action.body, ...(action.needsReason ? { reason: actionReason.trim() } : {}) }) });
      if (actionResult.granted === false || actionResult.revoked === false || actionResult.retried === false || actionResult.changed === false) throw new Error(actionResult.reason || 'Action could not be completed');
      setAction(null); setPassword(''); setCode(''); setActionReason('');
      await load();
      if (detail?.workspace?.id) await selectWorkspace(detail.workspace.id, false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  function navigate(next: Section) {
    const address = new URL(window.location.href);
    if (next === 'overview') address.searchParams.delete('section');
    else address.searchParams.set('section', next);
    address.searchParams.delete('workspace');
    window.history.pushState({}, '', address);
    setSection(next); setData(null); setDetail(null); setDetailLoading(false); setPage(1); setSearch(''); setError('');
  }
  function trace(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const id = requestId.trim();
    if (!/^[\w.:-]{8,64}$/.test(id)) { setError('Enter a valid request ID (8–64 characters).'); return; }
    setTraceQuery(id); setData(null); setError('');
  }

  const current = sections.find((s) => s.key === section)!;
  const mayAct = role === 'owner' || role === 'operator';
  const isOwner = role === 'owner';
  const openWorkspace = (id: string) => { navigate('workspaces'); void selectWorkspace(id); };
  const processMail = data?.process || [];
  const realMail = processMail.filter((m: Json) => !String(m.workspace).startsWith('scenario:'));
  const testMail = processMail.filter((m: Json) => String(m.workspace).startsWith('scenario:'));
  const worker = data?.workers?.[0];

  return <main className="platform">
    <header className="platform__top">
      <div className="platform__brand"><span className="platform__brandMark"><Icon name="shield" size={18}/></span><strong>PatForm</strong><span className="platform__brandDivider"/><span>Site administration</span></div>
      <a className="platform__consoleLink" href="/console">Customer console <Icon name="arrow" size={16}/></a>
    </header>
    <div className="platform__layout">
      <nav className="platform__nav" aria-label="Site administration">
        {['Monitor', 'Investigate', 'Manage'].map((group) => <div className="platform__navGroup" key={group}>
          <p className="platform__navLabel">{group}</p>
          {sections.filter((s) => s.group === group).map((s) => <button key={s.key} type="button" className={`platform__navItem ${section === s.key ? 'active' : ''}`} aria-current={section === s.key ? 'page' : undefined} onClick={() => navigate(s.key)}><Icon name={s.icon}/><span>{s.label}</span></button>)}
        </div>)}
        <div className="platform__navIdentity"><span className="platform__identityIcon"><Icon name="shield" size={17}/></span><div><strong>Platform access</strong><span>{role || 'Checking access…'}</span></div></div>
      </nav>
      <div className="platform__main">
        <div className="platform__heading">
          <div><span className="platform__eyebrow">SITE ADMIN <span>/</span> {current.group.toUpperCase()}</span><h1>{section === 'workspaces' && detail ? detail.workspace.name : current.label}</h1><p>{section === 'workspaces' && detail ? 'Workspace activity, installed processes and access controls.' : current.description}</p></div>
          <button className="platform__button platform__button--refresh" type="button" onClick={() => void load()} disabled={!role || busy}><Icon name="refresh" size={16}/>{busy ? 'Loading…' : 'Refresh'}</button>
        </div>
        {error && <div className="platform__error" role="alert"><strong>Could not complete that request.</strong><span>{error}</span>{!role && <a href="/console">Open your account</a>}</div>}
        {!role && !error && <div className="platform__loading" role="status">Checking your access…</div>}

        {data && section === 'overview' && <>
          <div className="platform__healthBanner"><span className={`platform__healthDot ${worker?.healthy ? '' : 'platform__healthDot--warn'}`}/><div><strong>{worker?.healthy ? 'PatForm is running' : 'Worker needs attention'}</strong><span>API responding · {worker?.healthy ? 'Worker active' : 'No recent worker heartbeat'}</span></div><span className="platform__healthRevision">Revision {data.api.revision || 'unknown'}</span></div>
          <div className="platform__metrics">
            {([['Workspaces', data.counts.workspaces, 'workspaces'], ['People', data.counts.people, 'operators'], ['Processes', data.counts.processes, 'overview'], ['Records', data.counts.records, 'audit']] as const).map(([label, value, icon]) => <article key={label} className="platform__metric"><span className="platform__metricIcon"><Icon name={icon}/></span><span>{label}</span><strong>{String(value ?? 0)}</strong></article>)}
          </div>
          <div className="platform__minorMetrics">
            {([['Open records', data.counts.open_records], ['Failed jobs', data.counts.failed_jobs], ['Dead webhooks', data.counts.dead_webhooks], ['Overdue timers', data.counts.overdue_timers]] as const).map(([label, value]) => <div key={label}><strong className={Number(value) > 0 && label !== 'Open records' ? 'platform__dangerText' : ''}>{String(value ?? 0)}</strong><span>{label}</span></div>)}
          </div>
          <div className="platform__columns">
            <Panel title="Service health" aside={<Pill tone={worker?.healthy ? 'good' : 'warn'}>{worker?.healthy ? 'Operational' : 'Check worker'}</Pill>}>
              <div className="platform__fact"><span>API</span><strong>Responding</strong></div><div className="platform__fact"><span>Uptime</span><strong>{Math.floor(data.api.uptimeSeconds / 60)} min</strong></div>
              <h3 className="platform__subhead">Latest worker</h3>
              {worker ? <div className="platform__worker"><Pill tone={worker.healthy ? 'good' : 'warn'}>{worker.healthy ? 'Running' : 'Stale'}</Pill><span>Seen <DateText value={worker.seen_at}/></span><span>{worker.errors} errors</span></div> : <Empty title="No heartbeat yet"/>}
              {data.workers.length > 1 && <details className="platform__details"><summary>Previous worker instances ({data.workers.length - 1})</summary>{data.workers.slice(1).map((w: Json) => <div className="platform__fact" key={w.worker_id}><span><DateText value={w.seen_at}/></span><span>{w.errors} errors</span></div>)}</details>}
              {data.stagingCombinedService && <p className="platform__hint">The staging worker pauses when the free service sleeps.</p>}
            </Panel>
            <Panel title="Email delivery" aside={<span className="platform__panelAside">Last 7 days</span>}>
              {data.mail.length ? data.mail.map((m: Json) => <div className="platform__fact" key={m.status}><span><Pill tone={m.status === 'failed' || m.status === 'bounced' ? 'bad' : m.status === 'delivered' ? 'good' : 'neutral'}>{m.status}</Pill></span><strong>{m.count}</strong></div>) : <Empty title="No email yet"/>}
              {data.deliveryAlert && <p className="platform__notice">Open {data.deliveryAlert.level} delivery alert · {data.deliveryAlert.bounced} bounced</p>}
              <button className="platform__textAction" onClick={() => navigate('mail')}>Review delivery <Icon name="arrow" size={15}/></button>
            </Panel>
          </div>
          <div className="platform__columns">
            <Panel title="Recent workspaces" aside={<button className="platform__textAction" onClick={() => navigate('workspaces')}>View all <Icon name="arrow" size={15}/></button>}>
              {data.recentWorkspaces.length ? data.recentWorkspaces.map((w: Json) => <button className="platform__rowbutton" key={w.id} onClick={() => openWorkspace(w.id)}><span>{w.name}</span><span>{w.records} records <Icon name="arrow" size={15}/></span></button>) : <Empty title="No workspaces yet"/>}
            </Panel>
            <Panel title="Recent service starts" aside={<span className="platform__panelAside">Host activity</span>}>
              {data.deployments.length ? data.deployments.slice(0, 5).map((d: Json, i: number) => <div className="platform__fact" key={i}><span><DateText value={d.started_at}/></span><span className="platform__mono">{d.revision?.slice(0, 8) || 'unknown'}</span></div>) : <Empty title="No starts recorded"/>}
              <p className="platform__hint">These are service starts. Deployment status comes from the hosting provider.</p>
            </Panel>
          </div>
        </>}

        {data && section === 'workspaces' && !detail && !detailLoading && <>
          <div className="platform__toolbar"><label className="platform__search"><Icon name="search" size={18}/><span className="platform__srOnly">Find a workspace</span><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search workspaces"/></label><div className="platform__scope" aria-label="Workspace type">{(['customers', 'tests', 'all'] as const).map((scope) => <button key={scope} className={workspaceScope === scope ? 'active' : ''} aria-pressed={workspaceScope === scope} onClick={() => { setWorkspaceScope(scope); setPage(1); }}>{scope === 'customers' ? 'Customers' : scope === 'tests' ? 'Tests' : 'All'}</button>)}</div><span className="platform__toolbarCount">{data.total} workspaces</span></div>
          <div className="platform__table"><table><thead><tr><th>Workspace</th><th>Intake</th><th>People</th><th>Processes</th><th>Records</th><th>Failed jobs</th><th>Created</th></tr></thead><tbody>{data.rows.map((w: Json) => <tr key={w.id}><td><button className="platform__link" onClick={() => void selectWorkspace(w.id)}>{w.name}<Icon name="arrow" size={14}/></button></td><td><Pill tone={w.intake_paused_at ? 'warn' : 'good'}>{w.intake_paused_at ? 'Paused' : 'Open'}</Pill></td><td>{w.people}</td><td>{w.processes}</td><td>{w.records}</td><td><Pill tone={w.failed_jobs ? 'bad' : 'neutral'}>{w.failed_jobs}</Pill></td><td><DateText value={w.created_at}/></td></tr>)}</tbody></table>{!data.rows.length && <Empty title="No matching workspaces"/>}</div>
        </>}

        {section === 'workspaces' && (detail || detailLoading) && <div className="platform__workspacePage"><button className="platform__back" onClick={() => navigate('workspaces')}>← Back to workspaces</button>{detail ? <Panel title={detail.workspace.name} className="platform__detail">
            <p className="platform__hint platform__mono">{detail.workspace.id}</p>
            <div className="platform__detailMetrics"><span><strong>{detail.people.length}</strong> people</span><span><strong>{detail.processes.length}</strong> processes</span><span><strong>{detail.jobs.failed}</strong> failed jobs</span></div>
            <div className="platform__manageBox"><div className="platform__inlineForm"><h3>New submissions</h3><Pill tone={detail.workspace.intake_paused_at ? 'warn' : 'good'}>{detail.workspace.intake_paused_at ? 'Paused' : 'Open'}</Pill>{isOwner && <button className="platform__button" onClick={() => setAction({ path: `workspaces/${detail.workspace.id}/intake`, label: `${detail.workspace.intake_paused_at ? 'Resume' : 'Pause'} new submissions for ${detail.workspace.name}`, body: { paused: !detail.workspace.intake_paused_at }, needsReason: true })}>{detail.workspace.intake_paused_at ? 'Resume intake' : 'Pause intake'}</button>}</div><p className="platform__hint">Existing records and approvals remain available. New forms, drafts and submissions pause together.</p>{detail.workspace.intake_paused_at && <p className="platform__hint">Paused <DateText value={detail.workspace.intake_paused_at}/> · {detail.workspace.intake_pause_reason}</p>}</div>
            {mayAct && <div className="platform__manageBox"><h3>Workspace name</h3><div className="platform__inlineForm"><label className="platform__srOnly" htmlFor="platform-workspace-name">Workspace name</label><input id="platform-workspace-name" value={workspaceName} maxLength={120} onChange={(e) => setWorkspaceName(e.target.value)}/><button className="platform__button" disabled={workspaceName.trim() === detail.workspace.name || workspaceName.trim().length < 2} onClick={() => setAction({ path: `workspaces/${detail.workspace.id}/rename`, label: `Rename ${detail.workspace.name} to ${workspaceName.trim()}`, body: { name: workspaceName.trim() }, needsReason: true })}>Rename</button></div><p className="platform__hint">A reason and your password plus authenticator code are required.</p></div>}
            <h3 className="platform__subhead">Installed processes</h3><div className="platform__tags">{detail.processes.length ? detail.processes.map((p: Json) => <span key={p.process_key}>{p.process_key} · v{p.version}</span>) : <span>None yet</span>}</div>
            <h3 className="platform__subhead">People</h3><div className="platform__table"><table><thead><tr><th>Name</th><th>Email</th><th>Workspace role</th><th>Status</th><th>Sessions</th><th>Controls</th></tr></thead><tbody>{detail.people.map((p: Json) => <tr key={p.id}><td>{p.display_name}</td><td>{p.email}</td><td>{p.workspace_role}</td><td><Pill tone={p.active ? 'good' : 'bad'}>{p.active ? 'Active' : 'Inactive'}</Pill></td><td>{p.sessions}</td><td><div className="platform__cellActions">{mayAct && p.sessions > 0 && <button className="platform__button" onClick={() => setAction({ path: `people/${p.id}/revoke-sessions`, label: `Sign ${p.display_name} out of every device` })}>Sign out</button>}{isOwner && <><button className="platform__button" onClick={() => setAction({ path: `workspaces/${detail.workspace.id}/people/${p.id}/access`, label: `${p.active ? 'Deactivate' : 'Reactivate'} ${p.display_name}`, body: { active: !p.active }, needsReason: true })}>{p.active ? 'Deactivate' : 'Reactivate'}</button><select aria-label={`Change role for ${p.display_name}`} value={p.workspace_role} onChange={(e) => setAction({ path: `workspaces/${detail.workspace.id}/people/${p.id}/access`, label: `Change ${p.display_name} to ${e.target.value}`, body: { workspaceRole: e.target.value }, needsReason: true })}>{['owner', 'admin', 'builder', 'operator', 'approver', 'analyst', 'read_only'].map((r) => <option value={r} key={r}>{r.replace('_', ' ')}</option>)}</select></>}</div></td></tr>)}</tbody></table></div>
            <h3 className="platform__subhead">Recent records</h3><p className="platform__muted">Record status and request history are shown here. Form answers stay private.</p>{detail.records?.length ? <div className="platform__table"><table><thead><tr><th>Process</th><th>State</th><th>Created</th><th>Request</th></tr></thead><tbody>{detail.records.map((r: Json) => <tr key={r.id}><td><strong>{r.process_key}</strong><small className="platform__mono">{r.id.slice(0, 8)}</small></td><td><Pill tone={r.completed_at ? 'good' : 'warn'}>{r.state}</Pill></td><td><DateText value={r.created_at}/></td><td>{r.request_id && r.request_id !== 'unattributed' ? <button className="platform__button" onClick={() => { navigate('trace'); setRequestId(r.request_id); setTraceQuery(r.request_id); }}>Trace</button> : '—'}</td></tr>)}</tbody></table></div> : <Empty title="No records yet"/>}
            <h3 className="platform__subhead">Email delivery</h3>{detail.mail.length ? detail.mail.map((m: Json) => <div className="platform__fact" key={m.status}><span><Pill tone={m.status === 'failed' || m.status === 'bounced' ? 'bad' : m.status === 'delivered' ? 'good' : 'neutral'}>{m.status}</Pill></span><strong>{m.count}</strong></div>) : <p className="platform__muted">No process email in the last seven days.</p>}
            <h3 className="platform__subhead">Integrations</h3><p className="platform__muted">Connection names and activity are shown here. Keys, signing secrets and webhook addresses stay hidden.</p>
            <div className="platform__table"><table><thead><tr><th>Type</th><th>Name</th><th>Status</th><th>Last used</th><th>Control</th></tr></thead><tbody>
              {detail.integrations.endpoints.map((e: Json) => <tr key={e.id}><td>Webhook · {e.kind}</td><td>{e.description || `Endpoint ${e.id.slice(0, 8)}`}</td><td><Pill tone={e.active ? 'good' : 'warn'}>{e.active ? 'Active' : 'Disabled'}</Pill></td><td>—</td><td>{isOwner && <button className="platform__button" onClick={() => setAction({ path: `workspaces/${detail.workspace.id}/webhooks/${e.id}/status`, label: `${e.active ? 'Disable' : 'Enable'} this webhook for ${detail.workspace.name}`, body: { active: !e.active }, needsReason: true })}>{e.active ? 'Disable' : 'Enable'}</button>}</td></tr>)}
              {detail.integrations.keys.map((k: Json) => <tr key={k.id}><td>API key</td><td>{k.name} · {k.key_prefix}</td><td><Pill tone={k.revoked_at ? 'bad' : 'good'}>{k.revoked_at ? 'Revoked' : 'Active'}</Pill></td><td><DateText value={k.last_used_at}/></td><td>{isOwner && !k.revoked_at && <button className="platform__button platform__button--danger" onClick={() => setAction({ path: `workspaces/${detail.workspace.id}/keys/${k.id}/revoke`, label: `Revoke ${k.name} for ${detail.workspace.name}. This key will stop working immediately`, needsReason: true })}>Revoke</button>}</td></tr>)}
              {detail.integrations.clients.map((c: Json) => <tr key={c.client_id}><td>OAuth client</td><td>{c.name}</td><td><Pill>Configured</Pill></td><td>—</td><td>—</td></tr>)}
            </tbody></table>{!detail.integrations.endpoints.length && !detail.integrations.keys.length && !detail.integrations.clients.length && <Empty title="No integrations connected"/>}</div>
          </Panel> : <div className="platform__loading" role="status">Opening workspace…</div>}</div>}

        {data && section === 'people' && <>
          <div className="platform__toolbar"><label className="platform__search"><Icon name="search" size={18}/><span className="platform__srOnly">Find a person</span><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search people or workspaces"/></label><div className="platform__scope" aria-label="Account status">{(['all', 'active', 'inactive'] as const).map((status) => <button key={status} className={peopleStatus === status ? 'active' : ''} aria-pressed={peopleStatus === status} onClick={() => { setPeopleStatus(status); setPage(1); }}>{status[0]!.toUpperCase() + status.slice(1)}</button>)}</div><span className="platform__toolbarCount">{data.total} people</span></div>
          <div className="platform__table"><table><thead><tr><th>Person</th><th>Workspace</th><th>Role</th><th>Status</th><th>Two-step</th><th>Sessions</th></tr></thead><tbody>{data.rows.map((p: Json) => <tr key={p.id}><td><strong>{p.display_name}</strong><small>{p.email}</small></td><td><button className="platform__link" onClick={() => openWorkspace(p.tenant_id)}>{p.workspace}<Icon name="arrow" size={14}/></button></td><td>{p.workspace_role}</td><td><Pill tone={p.active ? 'good' : 'bad'}>{p.active ? 'Active' : 'Inactive'}</Pill></td><td><Pill tone={p.mfa_enabled ? 'good' : 'warn'}>{p.mfa_enabled ? 'On' : 'Off'}</Pill></td><td>{p.sessions}</td></tr>)}</tbody></table>{!data.rows.length && <Empty title="No matching people"/>}</div>
        </>}

        {data && section === 'integrations' && <>
          <div className="platform__toolbar"><label className="platform__search"><Icon name="search" size={18}/><span className="platform__srOnly">Find a workspace</span><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search workspaces"/></label><span className="platform__toolbarCount">{data.total} workspaces</span></div>
          <div className="platform__table"><table><thead><tr><th>Workspace</th><th>Active webhooks</th><th>Failed deliveries</th><th>Active API keys</th><th>OAuth clients</th></tr></thead><tbody>{data.rows.map((w: Json) => <tr key={w.id}><td><button className="platform__link" onClick={() => openWorkspace(w.id)}>{w.name}<Icon name="arrow" size={14}/></button></td><td>{w.active_webhooks}</td><td><Pill tone={w.dead_webhooks ? 'bad' : 'neutral'}>{w.dead_webhooks}</Pill></td><td>{w.active_keys}</td><td>{w.oauth_clients}</td></tr>)}</tbody></table>{!data.rows.length && <Empty title="No matching workspaces"/>}</div>
        </>}

        {data && section === 'security' && <>
          <div className="platform__metrics"><div className="platform__metric"><span>Active people</span><strong>{data.posture.active_people}</strong></div><div className="platform__metric"><span>Two-step enabled</span><strong>{data.posture.mfa_people}</strong></div><div className="platform__metric"><span>Active sessions</span><strong>{data.posture.active_sessions}</strong></div><div className="platform__metric"><span>Paused workspaces</span><strong>{data.posture.paused_workspaces}</strong></div></div>
          <div className="platform__columns"><Panel title="Site access"><p className="platform__muted">Site admin grants require two-step verification. Workspace accounts may have different requirements.</p>{data.admins.map((a: Json) => <div className="platform__fact" key={a.role}><span>{a.role}</span><strong>{a.count}</strong></div>)}<button className="platform__button" onClick={() => navigate('operators')}>Manage site admins</button></Panel><Panel title="API keys by workspace"><p className="platform__muted">Review unused keys with each workspace owner.</p>{data.keys.length ? data.keys.map((k: Json) => <div className="platform__fact" key={k.tenant_id}><button className="platform__link" onClick={() => openWorkspace(k.tenant_id)}>{k.workspace}<Icon name="arrow" size={14}/></button><span>{k.active} active · {k.never_used} never used</span></div>) : <Empty title="No customer API keys"/>}</Panel></div>
        </>}

        {data && section === 'jobs' && <Panel title="Workflow jobs" aside={<span className="platform__panelAside">Page {page}</span>}>
          {!data.rows.length && <Empty title="No failed jobs" >The workflow queue has nothing waiting for a retry.</Empty>}
          {data.rows.map((j: Json) => <article className="platform__job" key={j.id}><div><button className="platform__link" onClick={() => openWorkspace(j.tenant_id)}>{j.workspace}<Icon name="arrow" size={14}/></button><span className="platform__mono">{j.transition_key}</span><Pill tone="bad">Failed</Pill></div><p>Job #{j.id} · {j.attempts} attempts · <DateText value={j.created_at}/></p><p>Request <span className="platform__mono">{j.request_id || '—'}</span></p><div className="platform__cellActions">{j.request_id && <button className="platform__button" onClick={() => { navigate('trace'); setRequestId(j.request_id); setTraceQuery(j.request_id); }}>Trace request</button>}{mayAct && <button className="platform__button" onClick={() => setAction({ path: `jobs/${j.id}/retry`, label: `Retry job #${j.id}` })}>Retry job</button>}</div></article>)}
        </Panel>}

        {section === 'trace' && <>
          <Panel title="Find a request"><p className="platform__muted">Paste a request ID from a record or support report. The trace shows metadata without form answers.</p><form className="platform__traceForm" onSubmit={trace}><label className="platform__srOnly" htmlFor="platform-request-id">Request ID</label><input id="platform-request-id" value={requestId} onChange={(e) => setRequestId(e.target.value)} placeholder="Request ID"/><button className="platform__button platform__button--primary" type="submit">Trace request</button></form></Panel>
          {data && <><div className="platform__resultHeader">Results for <strong className="platform__mono">{data.requestId}</strong></div><div className="platform__columns"><Panel title={`Events (${data.events.length})`}>{data.events.length ? data.events.map((e: Json, i: number) => <div className="platform__timeline" key={i}><span className="platform__timelineDot"/><div><strong>{e.type}</strong><p>{e.workspace} · sequence {e.seq}</p><small><DateText value={e.occurred_at}/></small></div></div>) : <Empty title="No events found"/>}</Panel><Panel title={`Jobs (${data.jobs.length})`}>{data.jobs.length ? data.jobs.map((j: Json) => <div className="platform__fact" key={j.id}><span>#{j.id} · {j.workspace} · {j.transition_key}</span><Pill tone={j.has_error ? 'bad' : j.done_at ? 'good' : 'warn'}>{j.has_error ? 'Failed' : j.done_at ? 'Done' : 'Pending'}</Pill></div>) : <Empty title="No jobs found"/>}<h3 className="platform__subhead">Actions ({data.actions.length})</h3>{data.actions.length ? data.actions.map((a: Json) => <div className="platform__fact" key={a.id}><span>{a.workspace} · {a.action_do}</span><Pill>{a.status}</Pill></div>) : <p className="platform__muted">No actions found.</p>}</Panel></div></>}
        </>}

        {data && section === 'mail' && <>
          <div className="platform__summaryStrip"><span>Last 7 days</span><strong>{realMail.reduce((n: number, m: Json) => n + Number(m.count), 0)} customer process emails</strong><span>{testMail.length} test scenario rows separated below</span></div>
          <div className="platform__columns"><Panel title="Customer process email" aside={<span className="platform__panelAside">Last 7 days</span>}>{realMail.length ? realMail.map((m: Json, i: number) => <div className="platform__fact" key={i}><button className="platform__link" onClick={() => openWorkspace(m.tenant_id)}>{m.workspace}<Icon name="arrow" size={14}/></button><span><Pill tone={m.status === 'failed' || m.status === 'bounced' ? 'bad' : m.status === 'delivered' ? 'good' : 'neutral'}>{m.status}</Pill> <b>{m.count}</b></span></div>) : <Empty title="No customer process email"/>}</Panel><Panel title="Account email" aside={<span className="platform__panelAside">Last 7 days</span>}>{data.account.length ? data.account.map((m: Json, i: number) => <div className="platform__fact" key={i}><span>{m.tenant_id ? <button className="platform__link" onClick={() => openWorkspace(m.tenant_id)}>{m.workspace}<Icon name="arrow" size={14}/></button> : <strong>Platform</strong>}<small>{m.kind}</small></span><span><Pill tone={m.status === 'failed' ? 'bad' : m.status === 'delivered' ? 'good' : 'neutral'}>{m.status}</Pill> <b>{m.count}</b></span></div>) : <Empty title="No account email"/>}</Panel></div>
          <Panel title="Delivery alerts" className="platform__sectionGap">{data.alerts.length ? data.alerts.map((a: Json) => <div className="platform__fact" key={a.id}><span><Pill tone={a.cleared_at ? 'neutral' : 'bad'}>{a.level}</Pill> {a.bounced} bounces · {a.complained} complaints</span><span><DateText value={a.raised_at}/></span></div>) : <Empty title="No delivery alerts"/>}</Panel>
          <Panel title="Recent delivery failures" className="platform__sectionGap" aside={<span className="platform__panelAside">Last 7 days · no message content shown</span>}>{data.failures?.length ? <div className="platform__table"><table><thead><tr><th>Workspace</th><th>Type</th><th>Result</th><th>When</th></tr></thead><tbody>{data.failures.map((m: Json, i: number) => <tr key={`${m.id}-${i}`}><td>{m.tenant_id ? <button className="platform__link" onClick={() => openWorkspace(m.tenant_id)}>{m.workspace}<Icon name="arrow" size={14}/></button> : m.workspace}</td><td>{m.kind}</td><td><Pill tone="bad">{m.status}</Pill></td><td><DateText value={m.sent_at}/></td></tr>)}</tbody></table></div> : <Empty title="No recent delivery failures"/>}</Panel>
          {testMail.length > 0 && <details className="platform__testDetails" open={showTestMail} onToggle={(e) => setShowTestMail(e.currentTarget.open)}><summary>Test scenario email <span>{testMail.length} rows</span></summary><div>{testMail.map((m: Json, i: number) => <div className="platform__fact" key={i}><span>{m.workspace.replace(/^scenario:/, '')}</span><span><Pill tone={m.status === 'failed' ? 'bad' : 'neutral'}>{m.status}</Pill> <b>{m.count}</b></span></div>)}</div></details>}
        </>}

        {data && section === 'audit' && <Panel title="Recorded admin actions" aside={<span className="platform__panelAside">Newest first</span>}>
          {data.rows.length ? data.rows.map((a: Json) => <div className="platform__auditRow" key={a.id}><span className="platform__auditIcon"><Icon name="audit" size={17}/></span><div><strong>{a.action.replaceAll('_', ' ')}</strong><p>{a.actor || 'System'} · {a.tenant_id ? <button className="platform__link" onClick={() => openWorkspace(a.tenant_id)}>{a.workspace || 'Workspace'}<Icon name="arrow" size={13}/></button> : (a.target_id ? `Target ${String(a.target_id).slice(0, 8)}` : 'Platform')}</p>{a.detail?.reason && <p>Reason: {a.detail.reason}</p>}{a.detail?.from && a.detail?.to && <p>From {typeof a.detail.from === 'string' ? a.detail.from : `${a.detail.from.role}, ${a.detail.from.active ? 'active' : 'inactive'}`} to {typeof a.detail.to === 'string' ? a.detail.to : `${a.detail.to.role}, ${a.detail.to.active ? 'active' : 'inactive'}`}</p>}</div><time><DateText value={a.occurred_at}/></time></div>) : <Empty title="No admin actions yet"/>}
        </Panel>}

        {data && section === 'operators' && <>
          <Panel title="People with site access" aside={<span className="platform__panelAside">{data.rows.filter((p: Json) => !p.revoked_at).length} active grants</span>}><p className="platform__muted">Site roles are separate from customer workspace roles. Each admin needs a verified email and two-step verification.</p><div className="platform__table"><table><thead><tr><th>Person</th><th>Site role</th><th>Status</th><th>Two-step</th><th>Granted</th><th>Action</th></tr></thead><tbody>{data.rows.map((p: Json) => <tr key={p.actor_id}><td><strong>{p.display_name}</strong><small>{p.email}</small></td><td><Pill tone={p.role === 'owner' ? 'good' : 'neutral'}>{p.role}</Pill></td><td><Pill tone={p.revoked_at || !p.active ? 'bad' : 'good'}>{p.revoked_at ? 'Revoked' : p.active ? 'Active' : 'Inactive'}</Pill></td><td><Pill tone={p.mfa_enabled ? 'good' : 'warn'}>{p.mfa_enabled ? 'On' : 'Setup needed'}</Pill></td><td><DateText value={p.granted_at}/></td><td>{isOwner && !p.revoked_at && <button className="platform__button platform__button--danger" onClick={() => setAction({ path: `operators/${p.actor_id}/revoke`, label: `Revoke site admin access for ${p.display_name}` })}>Revoke</button>}</td></tr>)}</tbody></table></div></Panel>
          {isOwner && <Panel title="Grant site access" className="platform__sectionGap"><p className="platform__muted">The person must already have an active account and a verified email.</p><div className="platform__grantForm"><label>Email address<input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="person@example.com"/></label><label>Site role<select value={newRole} onChange={(e) => setNewRole(e.target.value)}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="owner">Owner</option></select></label><button className="platform__button platform__button--primary" disabled={!newEmail.includes('@')} onClick={() => setAction({ path: 'operators', label: `Give ${newEmail} the ${newRole} site role`, body: { email: newEmail, role: newRole } })}>Review grant</button></div></Panel>}
        </>}

        {data && ['workspaces', 'people', 'integrations', 'jobs', 'audit'].includes(section) && !(section === 'workspaces' && (detail || detailLoading)) && <div className="platform__pager"><button className="platform__button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page}</span><button className="platform__button" disabled={['workspaces', 'people', 'integrations'].includes(section) ? page * 25 >= data.total : data.rows.length < (section === 'audit' ? 50 : 25)} onClick={() => setPage(page + 1)}>Next</button></div>}
      </div>
    </div>
    {action && <div className="platform__shade" role="presentation"><div className="platform__dialog" role="dialog" aria-modal="true" aria-labelledby="platform-confirm-title"><div className="platform__dialogIcon"><Icon name="shield" size={23}/></div><h2 id="platform-confirm-title">Confirm admin action</h2><p>{action.label}. This action is recorded in the site admin audit.</p>{error && <div className="platform__error" role="alert">{error}</div>}{action.needsReason && <label>Reason for this change<textarea value={actionReason} maxLength={500} onChange={(e) => setActionReason(e.target.value)} placeholder="Explain why this change is needed"/></label>}<label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}/></label><label>Authenticator code<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)}/></label><div className="platform__dialogActions"><button className="platform__button" onClick={() => { setAction(null); setPassword(''); setCode(''); setActionReason(''); setError(''); }}>Cancel</button><button className="platform__button platform__button--primary" disabled={busy || !password || !code || (action.needsReason && actionReason.trim().length < 8)} onClick={() => void runAction()}>Confirm action</button></div></div></div>}
  </main>;
}
