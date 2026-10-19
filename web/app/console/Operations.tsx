'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { postJson } from './stepup';

/*
 * Assets, IT and service operations (PRD Module 9). Everyone: my requests,
 * my equipment, access. Managers: requests to approve. IT and Facilities:
 * overview, queue, assets, maintenance and changes. Admins: setup.
 * An approved access request is still pending until the system confirms or
 * IT records evidence; a failed revocation stays on the overview.
 */

type Tab = 'requests' | 'equipment' | 'access' | 'approve' | 'overview' | 'queue' | 'assets' | 'maintenance' | 'changes' | 'setup';
type Summary = { mine: number; assets_to_ack: number; approvals: number; access_to_decide: number; queue: number; staff: boolean; admin: boolean; teams: string[]; role: string };
type Field = { key: string; label: string; required: boolean };
type Service = { id: string; key: string; name: string; description: string | null; team: string; approval: string; fields: Field[]; respond_hours: string; resolve_hours: string; evidence_required: boolean; active: boolean };
type Ticket = { id: string; number: number; kind: string; title: string; status: string; priority: number; team: string; created_at: string; resolve_due: string | null; breached_at: string | null; escalated_at: string | null; paused_since: string | null; requester: string; assignee: string | null; service: string | null; asset_tag: string | null };
type TicketDetail = { ticket: Ticket & { description: string | null; details: Record<string, string>; resolution: string | null; fields: Field[] | null }; notes: { kind: string; body: string; occurred_at: string; author: string | null }[]; canWork: boolean; photos: Photo[] };
type MyAsset = { assignment_id: string; status: string; condition_out: string; accessories: string[]; acknowledgement: string | null; id: string; tag: string; name: string; category: string; serial: string | null };
type Asset = { id: string; tag: string; category: string; name: string; serial: string | null; location: string | null; condition: string; status: string; shared: boolean; warranty_until: string | null; acquisition_ref: string | null; restricted_reason: string | null; holders: { id: string; name: string; status: string }[] | null; maintenance_due: string | null };
type AssetDetail = { asset: Asset; assignments: { id: string; status: string; holder: string; condition_out: string; condition_in: string | null; accessories: string[]; accessories_in: string[] | null; created_at: string; returned_at: string | null; assigned_by: string | null; approved_by: string | null; returned_by: string | null }[]; history: { kind: string; occurred_at: string; actor: string | null; detail: Record<string, unknown> }[]; maintenance: { title: string; due_on: string; status: string; outcome: string | null }[]; tickets: { number: number; title: string; status: string }[]; photos: Photo[] };
type System = { id: string; name: string; roles: string[]; max_days: number | null; owner: string; owner_id: string; connector: string | null; connector_actor_id: string | null; connector_url: string | null; active: boolean; connector_kind: 'webhook' | 'microsoft365' | 'google_workspace' | null; connector_config: { tenantId?: string; adminEmail?: string; domains?: string[]; roleGroups: Record<string, string>; suspendOnLeave?: boolean } | null; connector_setup: { configured: boolean; consentUrl?: string | null; permissions?: string[]; clientId?: string | null; serviceAccount?: string | null; scopes?: string[] } | null };
type AccessReq = { id: string; number: number; role: string; status: string; justification: string; expires_on: string | null; decision_note: string | null; failure_note: string | null; provisioned_via: string | null; system: string; holder: string; holder_id: string; requested_by: string; requested_by_id: string; i_own: boolean };
type Grant = { id: string; role: string; status: string; expires_on: string | null; revoke_reason: string | null; failure_note: string | null; system: string; holder: string; holder_active: boolean; i_own: boolean; reviewed_at: string | null };
type Job = { id: string; due_on: string; status: string; outcome: string | null; version: number; draft: { results?: Record<string, string>; findings?: string | null } | null; title: string; checklist: string[]; team: string; tag: string; asset: string };
type Change = { id: string; number: number; title: string; kind: string; risk: string; status: string; impact: string; rollback_plan: string; preconditions: { text: string; done: boolean }[]; window_start: string | null; window_end: string | null; decision_note: string | null; verification: string | null; retrospective: string | null; finished_at: string | null; requested_by: string; approved_by: string | null; started_by: string | null; system: string | null; asset: string | null };
type Dashboard = { backlog: { team: string; status: string; n: number }[]; aging: { bucket: string; n: number }[]; breached: { id: string; number: number; title: string; team: string }[]; recovery: { assignment_id: string; tag: string; name: string; holder: string; holder_active: boolean; end_date: string | null }[]; maintenance: { id: string; due_on: string; title: string; tag: string; overdue: boolean }[]; failedAccess: { kind: string; id: string; system: string; role: string; holder: string; status: string; note: string | null }[]; pendingRevocations: number; retrospectivesDue: { id: string; number: number; title: string }[]; restricted: { id: string; tag: string; name: string; restricted_reason: string }[] };
type Member = { id: string; display_name: string; active: boolean };
type Photo = { id: string; filename: string; scan_status: string; job_id: string | null; assignment_id: string | null; ticket_id: string | null; created_at: string; uploaded_by: string | null };
type Settings = { settings: { categories: string[]; allocationNeedsApproval: boolean; captureLocation: boolean; pauseWhileWaiting: boolean; reopenDays: number }; teams: { team: string; actor_id: string; display_name: string }[] };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}
function useFeed<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try { setData(await get<T>(path)); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}
const day = (v: string | null | undefined) => (v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toLocaleDateString() : '');
const time = (v: string | null | undefined) => (v ? new Date(v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const list = { listStyle: 'none', margin: 0, padding: 0 } as const;
const STATUS: Record<string, string> = { awaiting_approval: 'Awaiting approval', new: 'New', in_progress: 'In progress', waiting_on_user: 'Waiting on requester', resolved: 'Resolved', closed: 'Closed', cancelled: 'Cancelled', rejected: 'Not approved',
  requested: 'Waiting for the system owner', approved: 'Approved — waiting to be set up', provisioned: 'Set up', failed: 'Set-up failed', active: 'Active', revoking: 'Being removed', revoked: 'Removed', revoke_failed: 'Removal failed',
  pending_approval: 'Waiting for approval', pending_ack: 'Waiting for you to confirm', in_stock: 'In stock', assigned: 'Assigned', in_repair: 'In repair', restricted: 'Restricted', lost: 'Lost', retired: 'Retired', disposed: 'Disposed', returned: 'Returned' };
const st = (s: string) => STATUS[s] ?? s.replace(/_/g, ' ');
const TEAM: Record<string, string> = { it: 'IT', facilities: 'Facilities' };

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div><label className="cs__label" htmlFor={id}>{label}</label>{children}</div>;
}
/** Phone photos are large: send at most 1600 px as JPEG, which also drops the location the camera stored. */
async function shrink(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('That photo could not be read.'))), 'image/jpeg', 0.8));
  return await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] ?? ''); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
}
async function uploadPhotos(target: Record<string, string>, files: FileList | null): Promise<{ reference: string; filename: string }[]> {
  const out = [];
  for (const file of Array.from(files ?? [])) {
    out.push(await postJson<{ reference: string; filename: string }>('/api/ops/photos', { ...target, filename: `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, base64: await shrink(file) }));
  }
  return out;
}
const empty = (text: string) => <li className="ig__row"><div className="ig__rowMain"><p>{text}</p></div></li>;

export function OperationsView() {
  const summary = useFeed<Summary>('/api/ops/summary');
  const s = summary.data;
  const staff = s?.staff === true;
  const [tab, setTab] = useState<Tab>('requests');
  const services = useFeed<Service[]>(s ? '/api/ops/services' : null);
  const mine = useFeed<Ticket[]>(s ? '/api/ops/tickets?scope=mine' : null);
  const toApprove = useFeed<Ticket[]>(s ? '/api/ops/tickets?scope=approve' : null);
  const equipment = useFeed<MyAsset[]>(s ? '/api/ops/assets/mine' : null);
  const systems = useFeed<System[]>(s ? '/api/ops/systems' : null);
  const access = useFeed<{ requests: AccessReq[]; grants: Grant[] }>(s ? '/api/ops/access' : null);
  const dash = useFeed<Dashboard>(staff ? '/api/ops/dashboard' : null);
  const queue = useFeed<Ticket[]>(staff ? '/api/ops/tickets?scope=queue' : null);
  const assets = useFeed<Asset[]>(staff ? '/api/ops/assets' : null);
  const waiting = useFeed<{ line_id: string; order_number: number; description: string; vendor: string; waiting: number }[]>(staff ? '/api/ops/assets/awaiting-registration' : null);
  const maint = useFeed<{ jobs: Job[]; plans: { id: string; title: string; every_days: number; next_due: string; team: string; tag: string }[]; captureLocation: boolean }>(staff ? '/api/ops/maintenance' : null);
  const changes = useFeed<Change[]>(staff ? '/api/ops/changes' : null);
  const settings = useFeed<Settings>(s ? '/api/ops/settings' : null);
  const members = useFeed<Member[]>(staff ? '/api/members' : null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<{ id: string; label: string; run: (answer: string) => Promise<string> } | null>(null);
  const [answer, setAnswer] = useState('');
  const [openTicket, setOpenTicket] = useState<TicketDetail | null>(null);
  const [openAsset, setOpenAsset] = useState<AssetDetail | null>(null);
  const [openJob, setOpenJob] = useState<Job | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState<string | null>(null);
  const [jobPhotos, setJobPhotos] = useState<{ reference: string; filename: string }[]>([]);
  const [assetPhotos, setAssetPhotos] = useState<{ reference: string; filename: string }[]>([]);
  const f = (k: string) => form[k] ?? '';
  const setF = (k: string, v: string) => setForm((x) => ({ ...x, [k]: v }));

  const reloadAll = async () => { await Promise.all([summary.reload(), services.reload(), mine.reload(), toApprove.reload(), equipment.reload(), systems.reload(), access.reload(), dash.reload(), queue.reload(), assets.reload(), waiting.reload(), maint.reload(), changes.reload(), settings.reload()]); };
  const act = async (key: string, work: () => Promise<string>) => {
    setBusy(key); setNote(null);
    try { const message = await work(); await reloadAll(); setNote(message); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } finally { setBusy(null); }
  };
  const showTicket = async (ticketId: string) => { try { setOpenTicket(await get<TicketDetail>(`/api/ops/tickets/${ticketId}`)); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } };
  const showAsset = async (assetId: string) => { try { setOpenAsset(await get<AssetDetail>(`/api/ops/assets/${assetId}`)); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } };
  const viewPhoto = async (photoId: string) => { try { const r = await get<{ url: string }>(`/api/ops/photos/${photoId}`); window.open(r.url, '_blank', 'noopener'); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } };
  const photoList = (photos: Photo[]) => photos.length > 0 && <p><small><strong>Photos:</strong> {photos.map((ph) => <span key={ph.id} style={{ marginRight: 10 }}>{ph.filename}{ph.scan_status === 'quarantined' ? ' (failed malware check)' : ''} <button type="button" className="cs__btn" disabled={ph.scan_status === 'quarantined'} onClick={() => void viewPhoto(ph.id)}>View</button></span>)}</small></p>;
  const refreshOpen = async () => { if (openTicket) await showTicket(openTicket.ticket.id); if (openAsset) await showAsset(openAsset.asset.id); };

  if (summary.error) return <div className="ig__workspace"><p className="ig__error" role="alert">{summary.error}</p></div>;
  if (!s) return <div className="ig__workspace"><p className="ig__rowMain">Loading…</p></div>;

  const people = (members.data ?? []).filter((m) => m.active);
  const accessRequests = access.data?.requests ?? [];
  const grants = access.data?.grants ?? [];
  const failedCount = (dash.data?.failedAccess.length ?? 0);
  const tabs: { id: Tab; name: string; count: number | null; icon: 'table' | 'export' | 'trail' | 'account' | 'done' }[] = [
    { id: 'requests', name: 'My requests', count: s.mine, icon: 'done' },
    { id: 'equipment', name: 'My equipment', count: s.assets_to_ack, icon: 'account' },
    { id: 'access', name: 'Access', count: s.access_to_decide + (staff ? accessRequests.filter((r) => r.status === 'approved').length : 0), icon: 'trail' },
    ...(s.approvals ? [{ id: 'approve' as const, name: 'To approve', count: s.approvals, icon: 'done' as const }] : []),
    ...(staff ? [
      { id: 'overview' as const, name: 'Overview', count: failedCount || null, icon: 'table' as const },
      { id: 'queue' as const, name: 'Queue', count: s.queue, icon: 'table' as const },
      { id: 'assets' as const, name: 'Assets', count: waiting.data?.length ?? 0, icon: 'export' as const },
      { id: 'maintenance' as const, name: 'Maintenance', count: (maint.data?.jobs ?? []).filter((j) => j.status === 'open').length, icon: 'trail' as const },
      { id: 'changes' as const, name: 'Changes', count: (changes.data ?? []).filter((c) => ['submitted', 'approved', 'in_progress'].includes(c.status)).length, icon: 'trail' as const },
    ] : []),
    ...(s.admin ? [{ id: 'setup' as const, name: 'Setup', count: null, icon: 'trail' as const }] : []),
  ];

  const ticketRow = (t: Ticket, onOpen = true) => <li key={t.id} className="ig__row"><div className="ig__rowMain">
    <strong>#{t.number} {t.title}</strong><span className={`ig__status ${['resolved', 'closed'].includes(t.status) ? '' : 'ig__status--off'}`}>{st(t.status)}</span>{t.breached_at && <span className="ig__status ig__status--off">Target missed</span>}
    <p>{[t.service ?? (t.kind === 'corrective' ? 'Corrective work' : 'Incident'), TEAM[t.team], `priority ${t.priority}`, t.asset_tag, t.assignee ? `with ${t.assignee}` : null, t.paused_since ? 'clock paused' : t.resolve_due ? `due ${time(t.resolve_due)}` : null, `raised by ${t.requester} ${day(t.created_at)}`].filter(Boolean).join(' · ')}</p></div>
    {onOpen && <button type="button" className="cs__btn" onClick={() => void showTicket(t.id)}>Open</button>}</li>;

  const ticketPanel = openTicket && (() => {
    const t = openTicket.ticket; const can = openTicket.canWork;
    return <div className="ig__form" style={{ gridTemplateColumns: '1fr' }}>
      <div className="ig__formTitle"><strong>#{t.number} {t.title}</strong><p>{st(t.status)} · {TEAM[t.team]} · priority {t.priority}{t.resolve_due ? ` · due ${time(t.resolve_due)}` : ''}{t.paused_since ? ' · clock paused while waiting on the requester' : ''}</p></div>
      {t.description && <p>{t.description}</p>}
      {Object.keys(t.details ?? {}).length > 0 && <p><small>{Object.entries(t.details).map(([k, v]) => `${(t.fields ?? []).find((x) => x.key === k)?.label ?? k}: ${v}`).join(' · ')}</small></p>}
      {t.resolution && <p><strong>Resolution:</strong> {t.resolution}</p>}
      {photoList(openTicket.photos)}
      {!['closed', 'cancelled', 'rejected'].includes(t.status) && <div><label className="cs__label" htmlFor="tk-photo">Add a photo</label><input id="tk-photo" type="file" accept="image/*" multiple onChange={(e) => { const files = e.target.files; void act('photo', async () => { const up = await uploadPhotos({ ticketId: t.id }, files); await refreshOpen(); return `${up.length} photo(s) added. They can be viewed once the malware check passes.`; }); }} /></div>}
      <ul style={list}>{openTicket.notes.map((n, i) => <li key={i}><small><strong>{n.kind === 'work_note' ? 'Work note' : n.kind === 'system' ? 'System' : 'Update'}</strong> · {n.author ?? 'Patform'} · {time(n.occurred_at)}: {n.body}</small></li>)}</ul>
      <div className="pp2__roleEdit">
        {can && !['closed', 'cancelled', 'rejected', 'awaiting_approval'].includes(t.status) && <>
          <button type="button" className="cs__btn" onClick={() => void act('t', async () => { await postJson(`/api/ops/tickets/${t.id}/work`, { action: 'assign' }); await refreshOpen(); return 'Assigned to you.'; })}>Take it</button>
          <button type="button" className="cs__btn" onClick={() => setAsking({ id: t.id, label: 'Work note (only your team sees it)', run: async (b) => { await postJson(`/api/ops/tickets/${t.id}/work`, { action: 'note', body: b }); await refreshOpen(); return 'Note added.'; } })}>Work note</button>
          <button type="button" className="cs__btn" onClick={() => setAsking({ id: t.id, label: 'Update for the requester', run: async (b) => { await postJson(`/api/ops/tickets/${t.id}/work`, { action: 'note', body: b, visible: true }); await refreshOpen(); return 'Update sent.'; } })}>Update requester</button>
          <button type="button" className="cs__btn" onClick={() => setAsking({ id: t.id, label: 'What do you need from the requester? (the clock pauses)', run: async (b) => { await postJson(`/api/ops/tickets/${t.id}/work`, { action: 'wait', body: b }); await refreshOpen(); return 'Waiting on the requester; the clock is paused.'; } })}>Ask requester</button>
          <button type="button" className="cs__btn" onClick={() => setAsking({ id: t.id, label: 'Why escalate?', run: async (b) => { await postJson(`/api/ops/tickets/${t.id}/work`, { action: 'escalate', body: b }); await refreshOpen(); return 'Escalated.'; } })}>Escalate</button>
          {t.status !== 'resolved' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => setAsking({ id: t.id, label: 'How was it resolved? Add " | evidence" if this service needs it', run: async (b) => { const [resolution, evidenceRef] = b.split('|').map((x) => x.trim()); await postJson(`/api/ops/tickets/${t.id}/work`, { action: 'resolve', resolution, evidenceRef }); await refreshOpen(); return 'Resolved.'; } })}>Resolve</button>}
        </>}
        {!can && !['closed', 'cancelled', 'rejected'].includes(t.status) && <button type="button" className="cs__btn" onClick={() => setAsking({ id: t.id, label: 'Your reply', run: async (b) => { await postJson(`/api/ops/tickets/${t.id}/requester`, { action: 'reply', body: b }); await refreshOpen(); return 'Reply sent.'; } })}>Reply</button>}
        {!can && t.status === 'resolved' && <>
          <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act('t', async () => { await postJson(`/api/ops/tickets/${t.id}/requester`, { action: 'confirm' }); await refreshOpen(); return 'Closed. Thank you.'; })}>It is fixed</button>
          <button type="button" className="cs__btn" onClick={() => setAsking({ id: t.id, label: 'What is still wrong?', run: async (b) => { await postJson(`/api/ops/tickets/${t.id}/requester`, { action: 'reopen', body: b }); await refreshOpen(); return 'Reopened.'; } })}>Reopen</button>
        </>}
        {!can && ['awaiting_approval', 'new', 'in_progress', 'waiting_on_user'].includes(t.status) && <button type="button" className="cs__btn" onClick={() => void act('t', async () => { await postJson(`/api/ops/tickets/${t.id}/requester`, { action: 'cancel' }); await refreshOpen(); return 'Cancelled.'; })}>Cancel request</button>}
        <button type="button" className="cs__btn" onClick={() => setOpenTicket(null)}>Close</button>
      </div>
    </div>;
  })();

  const pickedService = (services.data ?? []).find((x) => x.id === f('svc'));

  return <div className="ig__workspace">
    <header className="ig__hero">
      <span className="ig__eyebrow">ASSETS &amp; IT</span>
      <h2>{staff ? 'Equipment, access, requests and maintenance' : 'Your equipment, access and requests'}</h2>
      <p>Equipment is registered only from what was received. Access counts only once the system confirms it, or IT records evidence. Removing access is tracked until it is confirmed done.</p>
    </header>

    <div className="ig__surface">
      <div className="ig__tabs" role="tablist" aria-label="Assets and IT areas">
        {tabs.map((item, index) => <button key={item.id} id={`ops-tab-${item.id}`} type="button" role="tab" aria-controls={`ops-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className="ig__tab" onClick={() => { setTab(item.id); setNote(null); setForm({}); setAsking(null); setOpenTicket(null); setOpenAsset(null); setOpenJob(null); setStarting(null); }} onKeyDown={(event) => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : -1; if (next < 0) return; event.preventDefault(); const id = tabs[next]!.id; setTab(id); document.getElementById(`ops-tab-${id}`)?.focus(); }}>
          <Icon name={item.icon} /><span>{item.name}</span>{item.count !== null && <span className="ig__tabCount">{item.count}</span>}
        </button>)}
      </div>
      <section id={`ops-panel-${tab}`} role="tabpanel" aria-labelledby={`ops-tab-${tab}`} className="ig__panel">
        {note && <p className="ig__notice" role="status">{note}</p>}
        {asking && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); const a = answer.trim(); if (!a) return; const job = asking; setAsking(null); setAnswer(''); void act(job.id, () => job.run(a)); }}>
          <Field id="ops-ask" label={asking.label}><input id="ops-ask" className="cs__input" required autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} /></Field>
          <div className="pp2__roleEdit" style={{ alignSelf: 'end' }}><button type="submit" className="cs__btn cs__btn--primary">Save</button><button type="button" className="cs__btn" onClick={() => { setAsking(null); setAnswer(''); }}>Cancel</button></div>
        </form>}
        {ticketPanel}

        {tab === 'requests' && !openTicket && <>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('raise', async () => {
            const details: Record<string, string> = {}; for (const fl of pickedService?.fields ?? []) details[fl.key] = f(`d_${fl.key}`);
            const r = await postJson<{ number: number; status: string }>('/api/ops/tickets', pickedService ? { typeId: pickedService.id, title: f('title'), description: f('desc'), details } : { team: f('team') || 'it', title: f('title'), description: f('desc'), impact: Number(f('impact') || 3), urgency: Number(f('urgency') || 3) });
            setForm({}); return `Raised #${r.number}${r.status === 'awaiting_approval' ? '. It goes to your manager first.' : '.'}`; }); }}>
            <div className="ig__formTitle"><strong>Ask for something, or report a problem</strong><p>{pickedService ? `${pickedService.description ?? ''} Target: answer within ${Number(pickedService.respond_hours)} h, done within ${Number(pickedService.resolve_hours)} h${pickedService.approval === 'manager' ? '; your manager approves first' : ''}.` : 'Pick a service, or leave it empty to report a problem.'}</p></div>
            <Field id="svc" label="Service"><select id="svc" className="cs__input" value={f('svc')} onChange={(e) => setF('svc', e.target.value)}><option value="">Report a problem</option>{(services.data ?? []).filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field id="t-title" label="Short title"><input id="t-title" className="cs__input" required value={f('title')} onChange={(e) => setF('title', e.target.value)} /></Field>
            {!pickedService && <>
              <Field id="t-team" label="Team"><select id="t-team" className="cs__input" value={f('team')} onChange={(e) => setF('team', e.target.value)}><option value="it">IT</option><option value="facilities">Facilities</option></select></Field>
              <Field id="t-impact" label="How many affected"><select id="t-impact" className="cs__input" value={f('impact') || '3'} onChange={(e) => setF('impact', e.target.value)}><option value="1">Many people</option><option value="2">A team</option><option value="3">Just me</option></select></Field>
              <Field id="t-urg" label="How urgent"><select id="t-urg" className="cs__input" value={f('urgency') || '3'} onChange={(e) => setF('urgency', e.target.value)}><option value="1">Work has stopped</option><option value="2">Slowed down</option><option value="3">Can wait</option></select></Field>
            </>}
            {(pickedService?.fields ?? []).map((fl) => <Field key={fl.key} id={`d-${fl.key}`} label={`${fl.label}${fl.required ? '' : ' (optional)'}`}><input id={`d-${fl.key}`} className="cs__input" required={fl.required} value={f(`d_${fl.key}`)} onChange={(e) => setF(`d_${fl.key}`, e.target.value)} /></Field>)}
            <Field id="t-desc" label="Details"><input id="t-desc" className="cs__input" value={f('desc')} onChange={(e) => setF('desc', e.target.value)} /></Field>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'raise'}>Send</button>
          </form>
          <ul style={list}>{(mine.data ?? []).map((t) => ticketRow(t))}{mine.data && !mine.data.length && empty('Nothing raised yet.')}</ul>
        </>}

        {tab === 'equipment' && <ul style={list}>
          {(equipment.data ?? []).map((a) => <li key={a.assignment_id} className="ig__row"><div className="ig__rowMain">
            <strong>{a.tag} · {a.name}</strong><span className={`ig__status ${a.status === 'active' ? '' : 'ig__status--off'}`}>{st(a.status)}</span>
            <p>{a.category}{a.serial ? ` · serial ${a.serial}` : ''} · handed over in {a.condition_out} condition{a.accessories.length ? ` with ${a.accessories.join(', ')}` : ''}{a.acknowledgement ? ` · "${a.acknowledgement}"` : ''}</p></div>
            {a.status === 'pending_ack' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(a.assignment_id, async () => { const r = await postJson<{ statement: string }>(`/api/ops/assignments/${a.assignment_id}/acknowledge`, {}); return `Recorded: "${r.statement}"`; })}>I have received it</button>}
          </li>)}
          {equipment.data && !equipment.data.length && empty('No equipment is signed out to you.')}
        </ul>}

        {tab === 'access' && <>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('acc', async () => { const r = await postJson<{ number: number }>('/api/ops/access', { systemId: f('sys'), role: f('role'), holderId: f('holder') || undefined, justification: f('why'), expiresOn: f('exp') || undefined }); setForm({}); return `Asked (#${r.number}). The system owner decides; then it is set up and confirmed.`; }); }}>
            <div className="ig__formTitle"><strong>Ask for access</strong><p>The system&apos;s owner approves. It counts as access only when the system confirms it or IT records evidence.</p></div>
            <Field id="a-sys" label="System"><select id="a-sys" className="cs__input" required value={f('sys')} onChange={(e) => { setF('sys', e.target.value); setF('role', ''); }}><option value="">Choose…</option>{(systems.data ?? []).filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field id="a-role" label="Role"><select id="a-role" className="cs__input" required value={f('role')} onChange={(e) => setF('role', e.target.value)}><option value="">Choose…</option>{((systems.data ?? []).find((x) => x.id === f('sys'))?.roles ?? []).map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
            {staff && <Field id="a-holder" label="For (optional)"><select id="a-holder" className="cs__input" value={f('holder')} onChange={(e) => setF('holder', e.target.value)}><option value="">Me</option>{people.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>}
            <Field id="a-why" label="Business reason"><input id="a-why" className="cs__input" required value={f('why')} onChange={(e) => setF('why', e.target.value)} /></Field>
            <Field id="a-exp" label={`Until${(systems.data ?? []).find((x) => x.id === f('sys'))?.max_days ? ' (required)' : ' (optional)'}`}><input id="a-exp" type="date" className="cs__input" value={f('exp')} onChange={(e) => setF('exp', e.target.value)} /></Field>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'acc'}>Ask</button>
          </form>
          <ul style={list}>{accessRequests.map((r) => <li key={r.id} className="ig__row"><div className="ig__rowMain">
            <strong>#{r.number} {r.system}: {r.role} for {r.holder}</strong><span className={`ig__status ${r.status === 'provisioned' ? '' : 'ig__status--off'}`}>{st(r.status)}</span>
            <p>{r.justification}{r.expires_on ? ` · until ${day(r.expires_on)}` : ''} · asked by {r.requested_by}{r.decision_note ? ` · ${r.decision_note}` : ''}{r.failure_note ? ` · ${r.failure_note}` : ''}{r.provisioned_via ? ` · confirmed ${r.provisioned_via === 'connector' ? 'by the system' : 'by IT with evidence'}` : ''}</p></div>
            <div className="pp2__roleEdit">
              {r.status === 'requested' && r.i_own && <>
                <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(r.id, async () => { const x = await postJson<{ next: string }>(`/api/ops/access/${r.id}/decide`, { decision: 'approve' }); return x.next; })}>Approve</button>
                <button type="button" className="cs__btn" onClick={() => setAsking({ id: r.id, label: 'Why not?', run: async (n) => { await postJson(`/api/ops/access/${r.id}/decide`, { decision: 'reject', note: n }); return 'Rejected.'; } })}>Reject</button>
              </>}
              {['approved', 'failed'].includes(r.status) && staff && <>
                <button type="button" className="cs__btn cs__btn--primary" onClick={() => setAsking({ id: r.id, label: 'Evidence that it was set up (ticket, screenshot or log reference)', run: async (ev) => { await postJson(`/api/ops/access/${r.id}/provisioned`, { via: 'manual', evidenceRef: ev }); return 'Recorded as set up.'; } })}>Record as set up</button>
                {r.status === 'approved' && <button type="button" className="cs__btn" onClick={() => setAsking({ id: r.id, label: 'What went wrong?', run: async (n) => { await postJson(`/api/ops/access/${r.id}/failed`, { note: n }); return 'Marked as failed.'; } })}>Set-up failed</button>}
              </>}
            </div>
          </li>)}{access.data && !accessRequests.length && empty('No access requests.')}</ul>
          {grants.length > 0 && <table className="ex__table"><thead><tr><th scope="col">System</th><th scope="col">Who</th><th scope="col">State</th><th scope="col"><span className="ex__sr">Actions</span></th></tr></thead>
            <tbody>{grants.map((g) => <tr key={g.id}>
              <td>{g.system} · {g.role}{g.expires_on ? <><br /><small>until {day(g.expires_on)}</small></> : null}</td>
              <td>{g.holder}{!g.holder_active ? ' (inactive)' : ''}</td>
              <td>{st(g.status)}{g.revoke_reason ? <><br /><small>{g.revoke_reason}</small></> : null}{g.failure_note ? <><br /><small className="ig__rowError">{g.failure_note}</small></> : null}{g.reviewed_at ? <><br /><small>reviewed {day(g.reviewed_at)}</small></> : null}</td>
              <td><div className="pp2__roleEdit">
                {g.status === 'active' && (g.i_own || s.admin) && <>
                  <button type="button" className="cs__btn" onClick={() => setAsking({ id: g.id, label: 'Why keep it?', run: async (n) => { await postJson(`/api/ops/grants/${g.id}/review`, { decision: 'keep', note: n }); return 'Reviewed: kept.'; } })}>Keep</button>
                  <button type="button" className="cs__btn" onClick={() => setAsking({ id: g.id, label: 'Why remove it?', run: async (n) => { await postJson(`/api/ops/grants/${g.id}/review`, { decision: 'revoke', note: n }); return 'Sent for removal.'; } })}>Remove</button>
                </>}
                {['revoking', 'revoke_failed'].includes(g.status) && staff && <>
                  <button type="button" className="cs__btn cs__btn--primary" onClick={() => setAsking({ id: g.id, label: 'Evidence it was removed', run: async (ev) => { await postJson(`/api/ops/grants/${g.id}/revoked`, { evidenceRef: ev }); return 'Recorded as removed.'; } })}>Confirm removed</button>
                  {g.status === 'revoking' && <button type="button" className="cs__btn" onClick={() => setAsking({ id: g.id, label: 'What went wrong?', run: async (n) => { await postJson(`/api/ops/grants/${g.id}/revoke-failed`, { note: n }); return 'Marked as a failed removal. It stays on the overview until confirmed.'; } })}>Removal failed</button>}
                </>}
              </div></td>
            </tr>)}</tbody></table>}
        </>}

        {tab === 'approve' && !openTicket && <ul style={list}>
          {(toApprove.data ?? []).map((t) => <li key={t.id} className="ig__row"><div className="ig__rowMain"><strong>#{t.number} {t.title}</strong><p>{t.service} · {t.requester} · {day(t.created_at)}</p></div>
            <div className="pp2__roleEdit">
              <button type="button" className="cs__btn" onClick={() => void showTicket(t.id)}>Details</button>
              <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(t.id, async () => { await postJson(`/api/ops/tickets/${t.id}/decide`, { decision: 'approve' }); return 'Approved. It goes to the team now.'; })}>Approve</button>
              <button type="button" className="cs__btn" onClick={() => setAsking({ id: t.id, label: 'Why not?', run: async (n) => { await postJson(`/api/ops/tickets/${t.id}/decide`, { decision: 'reject', note: n }); return 'Not approved.'; } })}>Decline</button>
            </div></li>)}
          {toApprove.data && !toApprove.data.length && empty('Nothing waiting for you.')}
        </ul>}

        {tab === 'overview' && dash.data && <>
          {dash.data.failedAccess.length > 0 && <div className="ig__notice" role="alert" style={{ borderColor: 'var(--danger, #b42318)' }}>
            <strong>Access problems — critical</strong>
            <ul style={list}>{dash.data.failedAccess.map((x) => <li key={x.id}><small>{x.kind === 'revocation' ? (x.status === 'revoke_failed' ? 'Removal failed' : 'Removal overdue') : 'Set-up failed'}: {x.system} · {x.role} · {x.holder}{x.note ? ` — ${x.note}` : ''}</small></li>)}</ul>
          </div>}
          <section className="pp2__overview" aria-label="At a glance" style={{ margin: '0 0 18px' }}>
            <div><span>Open tickets</span><strong>{dash.data.backlog.filter((b) => b.status !== 'awaiting_approval').reduce((a, b) => a + b.n, 0)}</strong><small>{dash.data.aging.map((a) => `${a.bucket}: ${a.n}`).join(' · ') || 'none'}</small></div>
            <div><span>Targets missed</span><strong>{dash.data.breached.length}</strong><small>{dash.data.pendingRevocations} access removals in progress</small></div>
            <div><span>To recover</span><strong>{dash.data.recovery.length}</strong><small>{dash.data.maintenance.filter((m) => m.overdue).length} maintenance overdue, {dash.data.restricted.length} restricted</small></div>
          </section>
          <ul style={list}>
            {dash.data.breached.map((b) => <li key={b.id} className="ig__row"><div className="ig__rowMain"><strong>#{b.number} {b.title}</strong><span className="ig__status ig__status--off">Target missed</span><p>{TEAM[b.team]}</p></div><button type="button" className="cs__btn" onClick={() => void showTicket(b.id)}>Open</button></li>)}
            {dash.data.recovery.map((r) => <li key={r.assignment_id} className="ig__row"><div className="ig__rowMain"><strong>Recover {r.tag} · {r.name}</strong><span className="ig__status ig__status--off">{r.holder_active ? 'Leaving' : 'Inactive'}</span><p>{r.holder}{r.end_date ? ` · last day ${day(r.end_date)}` : ''}</p></div></li>)}
            {dash.data.maintenance.map((m) => <li key={m.id} className="ig__row"><div className="ig__rowMain"><strong>{m.title} · {m.tag}</strong><span className={`ig__status ${m.overdue ? 'ig__status--off' : ''}`}>{m.overdue ? 'Overdue' : 'Due'} {day(m.due_on)}</span></div></li>)}
            {dash.data.restricted.map((r) => <li key={r.id} className="ig__row"><div className="ig__rowMain"><strong>{r.tag} · {r.name}</strong><span className="ig__status ig__status--off">Restricted</span><p>{r.restricted_reason}</p></div></li>)}
            {dash.data.retrospectivesDue.map((c) => <li key={c.id} className="ig__row"><div className="ig__rowMain"><strong>Change #{c.number} {c.title}</strong><span className="ig__status ig__status--off">Emergency — review due</span></div></li>)}
          </ul>
        </>}

        {tab === 'queue' && !openTicket && <ul style={list}>{(queue.data ?? []).map((t) => ticketRow(t))}{queue.data && !queue.data.length && empty('The queue is empty.')}</ul>}

        {tab === 'assets' && <>
          {openAsset ? <div className="ig__form" style={{ gridTemplateColumns: '1fr' }}>
            <div className="ig__formTitle"><strong>{openAsset.asset.tag} · {openAsset.asset.name}</strong><p>{st(openAsset.asset.status)} · {openAsset.asset.condition} · {openAsset.asset.category}{openAsset.asset.serial ? ` · serial ${openAsset.asset.serial}` : ''}{openAsset.asset.location ? ` · ${openAsset.asset.location}` : ''}{openAsset.asset.acquisition_ref ? ` · ${openAsset.asset.acquisition_ref}` : ''}{openAsset.asset.warranty_until ? ` · warranty to ${day(openAsset.asset.warranty_until)}` : ''}{openAsset.asset.shared ? ' · shared' : ''}</p></div>
            {openAsset.asset.restricted_reason && <p className="ig__rowError">Restricted: {openAsset.asset.restricted_reason}</p>}
            {photoList(openAsset.photos)}
            <div><label className="cs__label" htmlFor="as-photo">Photos for the next hand-out or return{assetPhotos.length ? ` (${assetPhotos.length} ready: ${assetPhotos.map((x) => x.filename).join(', ')})` : ''}</label><input id="as-photo" type="file" accept="image/*" capture="environment" multiple onChange={(e) => { const files = e.target.files; void act('photo', async () => { const up = await uploadPhotos({ assetId: openAsset.asset.id }, files); setAssetPhotos((x) => [...x, ...up]); await refreshOpen(); return `${up.length} photo(s) uploaded; they are attached to the next hand-out or return you record.`; }); }} /></div>
            <div className="pp2__roleEdit">
              {['in_stock', 'assigned'].includes(openAsset.asset.status) && <>
                <Field id="as-who" label="Hand out to"><select id="as-who" className="cs__input" value={f('who')} onChange={(e) => setF('who', e.target.value)}><option value="">Choose…</option>{people.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
                <Field id="as-acc" label="Accessories (comma separated)"><input id="as-acc" className="cs__input" value={f('acc')} onChange={(e) => setF('acc', e.target.value)} /></Field>
                <Field id="as-ref" label="Handover form or reference"><input id="as-ref" className="cs__input" value={f('ref')} onChange={(e) => setF('ref', e.target.value)} /></Field>
                <button type="button" className="cs__btn cs__btn--primary" disabled={!f('who')} onClick={() => void act('assign', async () => { const r = await postJson<{ status: string }>(`/api/ops/assets/${openAsset.asset.id}/assign`, { custodianId: f('who'), accessories: f('acc').split(',').map((x) => x.trim()).filter(Boolean), handoverRef: f('ref'), photos: assetPhotos.map((x) => x.reference) }); setForm({}); setAssetPhotos([]); await refreshOpen(); return r.status === 'pending_approval' ? 'Handed out, waiting for approval.' : 'Handed out. They confirm receipt on their equipment tab.'; })}>Hand out</button>
              </>}
              {openAsset.asset.status === 'restricted' && <button type="button" className="cs__btn" onClick={() => setAsking({ id: openAsset.asset.id, label: 'What was done to fix it?', run: async (n) => { await postJson(`/api/ops/assets/${openAsset.asset.id}/lift-restriction`, { note: n }); await refreshOpen(); return 'Restriction lifted.'; } })}>Lift restriction</button>}
              <button type="button" className="cs__btn" onClick={() => setAsking({ id: openAsset.asset.id, label: 'New location', run: async (n) => { await postJson(`/api/ops/assets/${openAsset.asset.id}`, { location: n }); await refreshOpen(); return 'Location updated.'; } })}>Move</button>
              <button type="button" className="cs__btn" onClick={() => setAsking({ id: openAsset.asset.id, label: 'New status (in_stock, in_repair, lost, retired or disposed), then " | " and why', run: async (n) => { const [status, reason] = n.split('|').map((x) => x.trim()); await postJson(`/api/ops/assets/${openAsset.asset.id}`, { status, reason }); await refreshOpen(); return 'Status changed.'; } })}>Change status</button>
              <button type="button" className="cs__btn" onClick={() => setAsking({ id: openAsset.asset.id, label: 'Maintenance: title | every N days | first due YYYY-MM-DD | team (it or facilities) | checks separated by ;', run: async (n) => { const [title, every, first, team, checks] = n.split('|').map((x) => x.trim()); await postJson('/api/ops/maintenance/plans', { assetId: openAsset.asset.id, title, everyDays: Number(every), firstDue: first, team, checklist: (checks ?? '').split(';').map((x) => x.trim()).filter(Boolean) }); await refreshOpen(); return 'Maintenance planned.'; } })}>Plan maintenance</button>
              <button type="button" className="cs__btn" onClick={() => { setOpenAsset(null); setForm({}); setAssetPhotos([]); }}>Close</button>
            </div>
            <table className="ex__table"><thead><tr><th scope="col">Holder</th><th scope="col">Out</th><th scope="col">Back</th><th scope="col"><span className="ex__sr">Action</span></th></tr></thead>
              <tbody>{openAsset.assignments.map((x) => <tr key={x.id}>
                <td>{x.holder}<br /><small>{st(x.status)}{x.approved_by ? ` · approved by ${x.approved_by}` : ''}</small></td>
                <td>{day(x.created_at)} · {x.condition_out}{x.accessories.length ? ` · ${x.accessories.join(', ')}` : ''}{x.assigned_by ? <><br /><small>by {x.assigned_by}</small></> : null}</td>
                <td>{x.returned_at ? `${day(x.returned_at)} · ${x.condition_in}${x.returned_by ? ` · by ${x.returned_by}` : ''}` : '—'}</td>
                <td>{['pending_approval', 'pending_ack', 'active'].includes(x.status) && <div className="pp2__roleEdit">
                  {x.status === 'pending_approval' && s.admin && <button type="button" className="cs__btn" onClick={() => void act(x.id, async () => { await postJson(`/api/ops/assignments/${x.id}/approve`, {}); await refreshOpen(); return 'Approved.'; })}>Approve</button>}
                  <button type="button" className="cs__btn" onClick={() => setAsking({ id: x.id, label: `Condition back (new, good, fair, poor, broken) | accessories returned, comma separated | reference`, run: async (n) => { const [condition, acc, ref] = n.split('|').map((y) => y.trim()); const r = await postJson<{ missing: string[] }>(`/api/ops/assignments/${x.id}/return`, { condition, accessories: (acc ?? '').split(',').map((y) => y.trim()).filter(Boolean), returnRef: ref, photos: assetPhotos.map((y) => y.reference) }); setAssetPhotos([]); await refreshOpen(); return `Returned.${r.missing.length ? ` Missing: ${r.missing.join(', ')}.` : ''}`; } })}>Record return</button>
                </div>}</td>
              </tr>)}{!openAsset.assignments.length && <tr><td colSpan={4}>Never handed out.</td></tr>}</tbody></table>
            <p><small><strong>History:</strong> {openAsset.history.map((h) => `${day(h.occurred_at)} ${h.kind.replace(/_/g, ' ')}${h.actor ? ` (${h.actor})` : ''}`).join(' · ')}</small></p>
            {openAsset.maintenance.length > 0 && <p><small><strong>Maintenance:</strong> {openAsset.maintenance.map((m) => `${day(m.due_on)} ${m.title} ${m.outcome ?? m.status}`).join(' · ')}</small></p>}
            {openAsset.tickets.length > 0 && <p><small><strong>Tickets:</strong> {openAsset.tickets.map((t) => `#${t.number} ${t.title} (${st(t.status)})`).join(' · ')}</small></p>}
          </div> : <>
            {(waiting.data ?? []).length > 0 && <div className="ig__notice"><strong>Received, not yet registered</strong>
              <ul style={list}>{(waiting.data ?? []).map((x) => <li key={x.line_id}><small>PO {x.order_number} · {x.description} · {x.vendor} · {x.waiting} to register </small><button type="button" className="cs__btn" onClick={() => { setForm({ line: x.line_id, name: x.description }); }}>Register</button></li>)}</ul></div>}
            <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('reg', async () => { const r = await postJson<{ tag: string }>('/api/ops/assets', { tag: f('tag'), name: f('name'), category: f('cat'), serial: f('serial'), location: f('loc'), warrantyUntil: f('warranty') || undefined, condition: f('cond') || 'new', shared: f('shared') === 'yes', orderLineId: f('line') || undefined, acquisitionRef: f('line') ? undefined : f('acq') }); setForm({}); return `Registered ${r.tag}.`; }); }}>
              <div className="ig__formTitle"><strong>{f('line') ? 'Register from the goods receipt' : 'Register an asset'}</strong><p>{f('line') ? 'Linked to the purchase order line, one asset per unit received.' : 'For items bought outside Procurement, give the purchase reference.'}</p></div>
              <Field id="r-tag" label="Tag"><input id="r-tag" className="cs__input" required value={f('tag')} onChange={(e) => setF('tag', e.target.value)} /></Field>
              <Field id="r-name" label="Description"><input id="r-name" className="cs__input" required value={f('name')} onChange={(e) => setF('name', e.target.value)} /></Field>
              <Field id="r-cat" label="Category"><select id="r-cat" className="cs__input" required value={f('cat')} onChange={(e) => setF('cat', e.target.value)}><option value="">Choose…</option>{(settings.data?.settings.categories ?? []).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
              <Field id="r-serial" label="Serial"><input id="r-serial" className="cs__input" value={f('serial')} onChange={(e) => setF('serial', e.target.value)} /></Field>
              <Field id="r-loc" label="Location"><input id="r-loc" className="cs__input" value={f('loc')} onChange={(e) => setF('loc', e.target.value)} /></Field>
              <Field id="r-war" label="Warranty to"><input id="r-war" type="date" className="cs__input" value={f('warranty')} onChange={(e) => setF('warranty', e.target.value)} /></Field>
              {!f('line') && <Field id="r-acq" label="Purchase reference"><input id="r-acq" className="cs__input" required value={f('acq')} onChange={(e) => setF('acq', e.target.value)} /></Field>}
              <div><label className="pp2__inlineLabel"><input type="checkbox" checked={f('shared') === 'yes'} onChange={(e) => setF('shared', e.target.checked ? 'yes' : '')} /> Shared (more than one holder)</label></div>
              <div className="pp2__roleEdit"><button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'reg'}>Register</button>{f('line') && <button type="button" className="cs__btn" onClick={() => setForm({})}>Not from a receipt</button>}</div>
            </form>
            <table className="ex__table"><thead><tr><th scope="col">Asset</th><th scope="col">State</th><th scope="col">Holder</th><th scope="col"><span className="ex__sr">Open</span></th></tr></thead>
              <tbody>{(assets.data ?? []).map((a) => <tr key={a.id}>
                <td><strong>{a.tag}</strong> · {a.name}<br /><small>{a.category}{a.location ? ` · ${a.location}` : ''}{a.maintenance_due ? ` · maintenance due ${day(a.maintenance_due)}` : ''}</small></td>
                <td>{st(a.status)}<br /><small>{a.condition}</small></td>
                <td>{(a.holders ?? []).map((h) => `${h.name}${h.status !== 'active' ? ` (${st(h.status).toLowerCase()})` : ''}`).join(', ') || '—'}</td>
                <td><button type="button" className="cs__btn" onClick={() => void showAsset(a.id)}>Open</button></td>
              </tr>)}{assets.data && !assets.data.length && <tr><td colSpan={4}>No assets yet.</td></tr>}</tbody></table>
          </>}
        </>}

        {tab === 'maintenance' && maint.data && <>
          {openJob && <form className="ig__form" style={{ gridTemplateColumns: '1fr' }} onSubmit={(e) => e.preventDefault()}>
            <div className="ig__formTitle"><strong>{openJob.title} · {openJob.tag}</strong><p>Due {day(openJob.due_on)}. Save a draft at any point; a failed check restricts the asset and opens corrective work.</p></div>
            {openJob.checklist.map((c) => <div key={c} className="pp2__roleEdit" style={{ alignItems: 'center' }}>
              <span style={{ flex: 1 }}>{c}</span>
              {(['pass', 'fail', 'na'] as const).map((r) => <label key={r} className="pp2__inlineLabel"><input type="radio" name={`chk-${c}`} checked={results[c] === r} onChange={() => setResults((x) => ({ ...x, [c]: r }))} /> {r === 'na' ? 'N/A' : r === 'pass' ? 'Pass' : 'Fail'}</label>)}
            </div>)}
            <Field id="j-find" label="Findings"><input id="j-find" className="cs__input" value={f('find')} onChange={(e) => setF('find', e.target.value)} /></Field>
            <div><label className="cs__label" htmlFor="j-photo">Photos{jobPhotos.length ? ` (${jobPhotos.map((x) => x.filename).join(', ')})` : ''}</label><input id="j-photo" type="file" accept="image/*" capture="environment" multiple onChange={(e) => { const files = e.target.files; void act('photo', async () => { const up = await uploadPhotos({ jobId: openJob.id }, files); setJobPhotos((x) => [...x, ...up]); return `${up.length} photo(s) uploaded.`; }); }} /></div>
            <div className="pp2__roleEdit">
              <button type="button" className="cs__btn" onClick={() => void act('job', async () => { const r = await postJson<{ version: number }>(`/api/ops/maintenance/jobs/${openJob.id}/draft`, { version: openJob.version, results, findings: f('find'), photos: jobPhotos.map((x) => x.reference) }); setOpenJob({ ...openJob, version: r.version }); return 'Draft saved.'; })}>Save draft</button>
              <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act('job', async () => { const r = await postJson<{ outcome: string }>(`/api/ops/maintenance/jobs/${openJob.id}/complete`, { version: openJob.version, results, findings: f('find'), photos: jobPhotos.map((x) => x.reference) }); setOpenJob(null); setResults({}); setForm({}); setJobPhotos([]); return r.outcome === 'fail' ? 'Done: failed. The asset is restricted and corrective work is open.' : 'Done: passed.'; })}>Finish</button>
              <button type="button" className="cs__btn" onClick={() => { setOpenJob(null); setResults({}); setJobPhotos([]); }}>Close</button>
            </div>
          </form>}
          {!openJob && <p className="ig__notice">On a phone in the field? <a href="/field.html" target="_blank" rel="noopener">Open the field checklists</a> — they work without signal and send when you are back online.</p>}
          {!openJob && <ul style={list}>{maint.data.jobs.map((j) => <li key={j.id} className="ig__row"><div className="ig__rowMain">
            <strong>{j.title} · {j.tag}</strong><span className={`ig__status ${j.status === 'done' && j.outcome === 'pass' ? '' : 'ig__status--off'}`}>{j.status === 'done' ? (j.outcome === 'pass' ? 'Passed' : 'Failed') : j.due_on < new Date().toISOString().slice(0, 10) ? 'Overdue' : 'Due'}</span>
            <p>{day(j.due_on)} · {TEAM[j.team]} · {j.asset}{j.draft ? ' · draft saved' : ''}</p></div>
            {j.status === 'open' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => { setOpenJob(j); setResults(j.draft?.results ?? {}); setForm({ find: j.draft?.findings ?? '' }); setJobPhotos([]); }}>Do it</button>}
          </li>)}{!maint.data.jobs.length && empty('No maintenance due. Plan it from an asset.')}</ul>}
        </>}

        {tab === 'changes' && <>
          <div className="pp2__roleEdit" style={{ padding: '16px 28px 0' }}>
            <button type="button" className="cs__btn" aria-expanded={starting === 'normal'} onClick={() => { setStarting(starting === 'normal' ? null : 'normal'); setForm({}); }}>New change</button>
            <button type="button" className="cs__btn" aria-expanded={starting === 'emergency'} onClick={() => { setStarting(starting === 'emergency' ? null : 'emergency'); setForm({}); }}>Emergency change</button>
          </div>
          {starting && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('chg', async () => { const r = await postJson<{ number: number }>('/api/ops/changes', { kind: starting, title: f('title'), impact: f('impact'), risk: f('risk') || 'low', rollbackPlan: f('rollback'), preconditions: f('pre').split(';').map((x) => x.trim()).filter(Boolean), windowStart: f('ws') ? new Date(f('ws')).toISOString() : undefined, windowEnd: f('we') ? new Date(f('we')).toISOString() : undefined }); setStarting(null); setForm({}); return `Change #${r.number} ${starting === 'emergency' ? 'logged. You can start it now; an admin reviews it afterwards.' : 'submitted for approval.'}`; }); }}>
            <div className="ig__formTitle"><strong>{starting === 'emergency' ? 'Emergency change' : 'Change request'}</strong><p>{starting === 'emergency' ? 'Starts without approval. An owner or admin who did not run it reviews it afterwards.' : 'Runs only once approved, inside its window, with every precondition ticked.'}</p></div>
            <Field id="c-title" label="What is changing"><input id="c-title" className="cs__input" required value={f('title')} onChange={(e) => setF('title', e.target.value)} /></Field>
            <Field id="c-impact" label="Impact"><input id="c-impact" className="cs__input" required value={f('impact')} onChange={(e) => setF('impact', e.target.value)} /></Field>
            <Field id="c-risk" label="Risk"><select id="c-risk" className="cs__input" value={f('risk') || 'low'} onChange={(e) => setF('risk', e.target.value)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field>
            <Field id="c-roll" label="Rollback plan"><input id="c-roll" className="cs__input" required value={f('rollback')} onChange={(e) => setF('rollback', e.target.value)} /></Field>
            <Field id="c-pre" label="Preconditions (separate with ;)"><input id="c-pre" className="cs__input" value={f('pre')} onChange={(e) => setF('pre', e.target.value)} /></Field>
            {starting === 'normal' && <>
              <Field id="c-ws" label="Window starts"><input id="c-ws" type="datetime-local" className="cs__input" required value={f('ws')} onChange={(e) => setF('ws', e.target.value)} /></Field>
              <Field id="c-we" label="Window ends"><input id="c-we" type="datetime-local" className="cs__input" required value={f('we')} onChange={(e) => setF('we', e.target.value)} /></Field>
            </>}
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'chg'}>Submit</button>
          </form>}
          <ul style={list}>{(changes.data ?? []).map((c) => <li key={c.id} className="ig__row" style={{ flexWrap: 'wrap' }}><div className="ig__rowMain">
            <strong>#{c.number} {c.title}</strong><span className={`ig__status ${c.status === 'completed' ? '' : 'ig__status--off'}`}>{c.kind === 'emergency' ? 'Emergency · ' : ''}{st(c.status)}</span>
            <p>Risk {c.risk} · {c.impact} · rollback: {c.rollback_plan}{c.window_start ? ` · window ${time(c.window_start)} to ${time(c.window_end)}` : ''} · by {c.requested_by}{c.approved_by ? ` · approved by ${c.approved_by}` : ''}{c.decision_note ? ` (${c.decision_note})` : ''}</p>
            {c.preconditions.length > 0 && <p>{c.preconditions.map((p, i) => <span key={i} style={{ marginRight: 10 }}>{p.done ? '☑' : '☐'} {p.text}{!p.done && ['submitted', 'approved'].includes(c.status) && <> <button type="button" className="cs__btn" onClick={() => void act(c.id, async () => { await postJson(`/api/ops/changes/${c.id}/precondition`, { index: i }); return 'Ticked.'; })}>Tick</button></>}</span>)}</p>}
            {c.verification && <p>Checked: {c.verification}</p>}
            {c.retrospective && <p>Review: {c.retrospective}</p>}</div>
            <div className="pp2__roleEdit">
              {c.kind === 'normal' && c.status === 'submitted' && s.admin && <>
                <button type="button" className="cs__btn cs__btn--primary" onClick={() => setAsking({ id: c.id, label: 'Approval note', run: async (n) => { await postJson(`/api/ops/changes/${c.id}/decide`, { decision: 'approve', note: n }); return 'Approved.'; } })}>Approve</button>
                <button type="button" className="cs__btn" onClick={() => setAsking({ id: c.id, label: 'Why not?', run: async (n) => { await postJson(`/api/ops/changes/${c.id}/decide`, { decision: 'reject', note: n }); return 'Rejected.'; } })}>Reject</button>
              </>}
              {((c.kind === 'normal' && c.status === 'approved') || (c.kind === 'emergency' && c.status === 'submitted')) && <button type="button" className="cs__btn" onClick={() => void act(c.id, async () => { await postJson(`/api/ops/changes/${c.id}/start`, {}); return 'Started.'; })}>Start</button>}
              {c.status === 'in_progress' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => setAsking({ id: c.id, label: 'Outcome (completed, failed or rolled_back) | how you checked the result', run: async (n) => { const [outcome, verification] = n.split('|').map((x) => x.trim()); await postJson(`/api/ops/changes/${c.id}/finish`, { outcome, verification }); return 'Finished.'; } })}>Finish</button>}
              {c.kind === 'emergency' && c.finished_at && !c.retrospective && s.admin && <button type="button" className="cs__btn" onClick={() => setAsking({ id: c.id, label: 'Your review of the emergency change', run: async (n) => { await postJson(`/api/ops/changes/${c.id}/review`, { review: n }); return 'Reviewed.'; } })}>Review</button>}
            </div>
          </li>)}{changes.data && !changes.data.length && empty('No changes.')}</ul>
        </>}

        {tab === 'setup' && s.admin && settings.data && <>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('set', async () => { await postJson('/api/ops/settings', { categories: (f('cats') || settings.data!.settings.categories.join(', ')).split(',').map((x) => x.trim()).filter(Boolean), allocationNeedsApproval: (f('appr') || String(settings.data!.settings.allocationNeedsApproval)) === 'true', pauseWhileWaiting: (f('pause') || String(settings.data!.settings.pauseWhileWaiting)) === 'true', reopenDays: Number(f('reopen') || settings.data!.settings.reopenDays) }); setForm({}); return 'Settings saved.'; }); }}>
            <div className="ig__formTitle"><strong>Rules</strong><p>Changing these asks for your password again.</p></div>
            <Field id="s-cats" label="Asset categories (comma separated)"><input id="s-cats" className="cs__input" value={f('cats') || settings.data.settings.categories.join(', ')} onChange={(e) => setF('cats', e.target.value)} /></Field>
            <Field id="s-appr" label="Hand-outs need an admin's approval"><select id="s-appr" className="cs__input" value={f('appr') || String(settings.data.settings.allocationNeedsApproval)} onChange={(e) => setF('appr', e.target.value)}><option value="false">No</option><option value="true">Yes</option></select></Field>
            <Field id="s-pause" label="Pause targets while waiting on the requester"><select id="s-pause" className="cs__input" value={f('pause') || String(settings.data.settings.pauseWhileWaiting)} onChange={(e) => setF('pause', e.target.value)}><option value="true">Yes</option><option value="false">No</option></select></Field>
            <Field id="s-reopen" label="Days a requester can reopen"><input id="s-reopen" type="number" min={0} max={90} className="cs__input" value={f('reopen') || String(settings.data.settings.reopenDays)} onChange={(e) => setF('reopen', e.target.value)} /></Field>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'set'}>Save rules</button>
          </form>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('team', async () => { await postJson('/api/ops/teams', { team: f('tteam') || 'it', actorId: f('tactor') }); setForm({}); return 'Added to the team.'; }); }}>
            <div className="ig__formTitle"><strong>Teams</strong><p>{settings.data.teams.map((t) => `${TEAM[t.team]}: ${t.display_name}`).join(' · ') || 'Nobody yet.'}</p></div>
            <Field id="tm-team" label="Team"><select id="tm-team" className="cs__input" value={f('tteam')} onChange={(e) => setF('tteam', e.target.value)}><option value="it">IT</option><option value="facilities">Facilities</option></select></Field>
            <Field id="tm-who" label="Person"><select id="tm-who" className="cs__input" required value={f('tactor')} onChange={(e) => setF('tactor', e.target.value)}><option value="">Choose…</option>{people.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'team'}>Add</button>
          </form>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('sys', async () => { const kind = f('skind');
              const roleGroups: Record<string, string> = {};
              for (const line of f('sgroups').split('\n')) { const [role, group] = line.split('=').map((x) => x.trim()); if (role && group) roleGroups[role] = group; }
              const roles = f('sroles') ? f('sroles').split(',').map((x) => x.trim()).filter(Boolean) : Object.keys(roleGroups);
              const directory = kind === 'microsoft365' || kind === 'google_workspace' ? { tenantId: f('stenant') || undefined, adminEmail: f('sadmin') || undefined, domains: f('sdomains').split(',').map((x) => x.trim()).filter(Boolean), roleGroups, suspendOnLeave: f('ssuspend') === 'yes' } : undefined;
              const r = await postJson<{ secret: string | null }>('/api/ops/systems', { name: f('sname'), ownerId: f('sowner'), roles, maxDays: f('smax') || undefined, connectorActorId: f('sconn') || undefined, connectorKind: kind || undefined, connectorUrl: kind === 'webhook' ? f('surl') : undefined, directory }); setForm({});
              return r.secret ? `System saved. Connector signing secret (shown once — give it to the system's administrator now): ${r.secret}` : kind === 'microsoft365' || kind === 'google_workspace' ? 'System saved. Follow the steps shown under it, then press Test connection.' : 'System saved.'; }); }}>
            <div className="ig__formTitle"><strong>Systems people can ask access to</strong><p>People ask for access to these. The owner approves; a connector then makes the change and confirms it.</p></div>
            <ul style={{ ...list, gridColumn: '1 / -1' }}>{(systems.data ?? []).map((x) => <li key={x.id} className="ig__row" style={{ flexWrap: 'wrap' }}><div className="ig__rowMain">
              <strong>{x.name}</strong><span className="ig__status">{x.connector_kind === 'microsoft365' ? 'Microsoft 365' : x.connector_kind === 'google_workspace' ? 'Google Workspace' : x.connector_kind === 'webhook' ? 'Web address' : x.connector ? 'Connector account' : 'IT records by hand'}</span>
              <p>Owner {x.owner} · roles {x.roles.join(', ')}{x.connector_url ? ` · sends to ${x.connector_url}` : ''}{x.connector_config ? ` · ${Object.entries(x.connector_config.roleGroups).map(([r, g]) => `${r} → ${g}`).join(', ')}${x.connector_config.suspendOnLeave ? ' · suspends leavers' : ''}` : ''}</p>
              {x.connector_setup && !x.connector_setup.configured && <p className="ig__rowError">The server is missing its {x.connector_kind === 'microsoft365' ? 'MS365_CLIENT_ID / MS365_CLIENT_SECRET' : 'GOOGLE_WORKSPACE_SA_* settings'}; ask whoever runs Patform to add them.</p>}
              {x.connector_kind === 'microsoft365' && x.connector_setup?.configured && <p><small>On the customer side: an Entra admin opens {x.connector_setup.consentUrl ? <a href={x.connector_setup.consentUrl} target="_blank" rel="noopener noreferrer">this consent link</a> : 'the consent link'} and approves {x.connector_setup.permissions?.join(', ')}.</small></p>}
              {x.connector_kind === 'google_workspace' && x.connector_setup?.configured && <p><small>On the customer side: a super admin opens Admin console → Security → API controls → Domain-wide delegation, adds client ID <strong>{x.connector_setup.clientId ?? '(set GOOGLE_WORKSPACE_SA_CLIENT_ID)'}</strong> with the scopes {x.connector_setup.scopes?.join(', ')}.</small></p>}
            </div>
              {(x.connector_kind === 'microsoft365' || x.connector_kind === 'google_workspace') && <button type="button" className="cs__btn" onClick={() => void act(x.id, async () => { const r = await postJson<{ ok: boolean; checks: { what: string; ok: boolean; detail?: string }[] }>(`/api/ops/systems/${x.id}/test`, {}); return `${r.ok ? 'Connected.' : 'Not working yet.'} ${r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.what}${c.detail ? ` (${c.detail})` : ''}`).join(' · ')}`; })}>Test connection</button>}
            </li>)}{!(systems.data ?? []).length && empty('None yet.')}</ul>
            <Field id="sy-name" label="System"><input id="sy-name" className="cs__input" required value={f('sname')} onChange={(e) => setF('sname', e.target.value)} /></Field>
            <Field id="sy-owner" label="Owner (approves access)"><select id="sy-owner" className="cs__input" required value={f('sowner')} onChange={(e) => setF('sowner', e.target.value)}><option value="">Choose…</option>{people.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
            <Field id="sy-roles" label={f('skind') === 'microsoft365' || f('skind') === 'google_workspace' ? 'Roles (optional: taken from the group list)' : 'Roles (comma separated)'}><input id="sy-roles" className="cs__input" required={!(f('skind') === 'microsoft365' || f('skind') === 'google_workspace')} value={f('sroles')} onChange={(e) => setF('sroles', e.target.value)} /></Field>
            <Field id="sy-max" label="Longest access in days (optional)"><input id="sy-max" type="number" className="cs__input" value={f('smax')} onChange={(e) => setF('smax', e.target.value)} /></Field>
            <Field id="sy-conn" label="Connector account (optional)"><select id="sy-conn" className="cs__input" value={f('sconn')} onChange={(e) => setF('sconn', e.target.value)}><option value="">None — IT records evidence</option>{people.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
            <Field id="sy-kind" label="How access is given"><select id="sy-kind" className="cs__input" value={f('skind')} onChange={(e) => setF('skind', e.target.value)}><option value="">IT records it by hand</option><option value="microsoft365">Microsoft 365 group</option><option value="google_workspace">Google Workspace group</option><option value="webhook">Our own web address</option></select></Field>
            {f('skind') === 'webhook' && <Field id="sy-url" label="Connector address (https)"><input id="sy-url" type="url" className="cs__input" required placeholder="https://system.example.com/patform" value={f('surl')} onChange={(e) => setF('surl', e.target.value)} /></Field>}
            {f('skind') === 'microsoft365' && <Field id="sy-tenant" label="Microsoft tenant ID or primary domain"><input id="sy-tenant" className="cs__input" required value={f('stenant')} onChange={(e) => setF('stenant', e.target.value)} /></Field>}
            {f('skind') === 'google_workspace' && <Field id="sy-admin" label="Google admin email Patform acts as"><input id="sy-admin" type="email" className="cs__input" required value={f('sadmin')} onChange={(e) => setF('sadmin', e.target.value)} /></Field>}
            {(f('skind') === 'microsoft365' || f('skind') === 'google_workspace') && <>
              <Field id="sy-domains" label={`Email domains${f('skind') === 'google_workspace' ? '' : ' (optional)'}, comma separated`}><input id="sy-domains" className="cs__input" required={f('skind') === 'google_workspace'} placeholder="example.com" value={f('sdomains')} onChange={(e) => setF('sdomains', e.target.value)} /></Field>
              <Field id="sy-groups" label={`One role per line: role = ${f('skind') === 'microsoft365' ? 'group object ID' : 'group email'}`}><textarea id="sy-groups" className="cs__input" rows={3} required placeholder={f('skind') === 'microsoft365' ? 'viewer = 3f2a…-…' : 'viewer = payroll-viewers@example.com'} value={f('sgroups')} onChange={(e) => setF('sgroups', e.target.value)} /></Field>
              <div><label className="pp2__inlineLabel"><input type="checkbox" checked={f('ssuspend') === 'yes'} onChange={(e) => setF('ssuspend', e.target.checked ? 'yes' : '')} /> When someone leaves, also suspend their account and sign them out</label></div>
            </>}
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'sys'}>Save system</button>
          </form>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('svc', async () => { await postJson('/api/ops/services', { name: f('vname'), description: f('vdesc'), team: f('vteam') || 'it', approval: f('vappr') || 'none', respondHours: Number(f('vresp') || 8), resolveHours: Number(f('vres') || 40), evidenceRequired: f('vev') === 'yes', fields: f('vfields').split(',').map((x) => x.trim()).filter(Boolean).map((x) => ({ label: x.replace(/\*$/, ''), required: x.endsWith('*') })) }); setForm({}); return 'Service saved.'; }); }}>
            <div className="ig__formTitle"><strong>Service catalogue</strong><p>{(services.data ?? []).map((x) => `${x.name} (${TEAM[x.team]}, ${Number(x.respond_hours)}/${Number(x.resolve_hours)} h${x.approval === 'manager' ? ', manager approves' : ''})`).join(' · ') || 'No services yet.'}</p></div>
            <Field id="sv-name" label="Service"><input id="sv-name" className="cs__input" required value={f('vname')} onChange={(e) => setF('vname', e.target.value)} /></Field>
            <Field id="sv-desc" label="Description"><input id="sv-desc" className="cs__input" value={f('vdesc')} onChange={(e) => setF('vdesc', e.target.value)} /></Field>
            <Field id="sv-team" label="Team"><select id="sv-team" className="cs__input" value={f('vteam')} onChange={(e) => setF('vteam', e.target.value)}><option value="it">IT</option><option value="facilities">Facilities</option></select></Field>
            <Field id="sv-appr" label="Approval"><select id="sv-appr" className="cs__input" value={f('vappr')} onChange={(e) => setF('vappr', e.target.value)}><option value="none">None</option><option value="manager">Requester&apos;s manager</option></select></Field>
            <Field id="sv-resp" label="Answer within (hours)"><input id="sv-resp" type="number" className="cs__input" value={f('vresp')} onChange={(e) => setF('vresp', e.target.value)} /></Field>
            <Field id="sv-res" label="Done within (hours)"><input id="sv-res" type="number" className="cs__input" value={f('vres')} onChange={(e) => setF('vres', e.target.value)} /></Field>
            <Field id="sv-fields" label="Questions (comma separated; end with * if required)"><input id="sv-fields" className="cs__input" value={f('vfields')} onChange={(e) => setF('vfields', e.target.value)} /></Field>
            <div><label className="pp2__inlineLabel"><input type="checkbox" checked={f('vev') === 'yes'} onChange={(e) => setF('vev', e.target.checked ? 'yes' : '')} /> Needs evidence of completion</label></div>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'svc'}>Save service</button>
          </form>
        </>}
      </section>
    </div>
  </div>;
}
