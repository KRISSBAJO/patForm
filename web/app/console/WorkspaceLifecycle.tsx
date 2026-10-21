'use client';

import { useCallback, useEffect, useState } from 'react';
import { postJson } from './stepup';

/*
 * Export the whole workspace, or close it (PRD 17.3). Owners only; anyone
 * else sees nothing here. Closing is four steps: ask (an export starts),
 * suspend once the export is ready, wait, then a site owner approves the
 * deletion. Until deletion starts, the owner can cancel.
 */
type Export = { id: string; reason: string; status: string; sha256: string | null; byte_size: number | null; error: string | null; created_at: string; ready_at: string | null; expires_at: string | null; totals: { tables: number; rows: number; attachments: number } | null };
type Closure = { closure: { id: string; status: string; reason: string; created_at: string; suspended_at: string | null; waiting_until: string | null; export_status: string | null; export_waived: boolean } | null; legalHolds: number; waitDays: number };

export function WorkspaceLifecycle({ workspaceName }: { workspaceName: string }) {
  const [exports, setExports] = useState<Export[] | null>(null);
  const [closure, setClosure] = useState<Closure | null>(null);
  const [owner, setOwner] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const load = useCallback(async () => {
    const [e, c] = await Promise.all([fetch('/api/workspace/exports', { credentials: 'same-origin' }), fetch('/api/workspace/closure', { credentials: 'same-origin' })]);
    if (!e.ok) { setOwner(false); return; }
    setExports(await e.json()); setClosure(await c.json());
  }, []);
  useEffect(() => { void load(); }, [load]);
  // While an export is being prepared, look again every few seconds.
  useEffect(() => {
    if (!exports?.some((x) => x.status === 'queued' || x.status === 'running')) return;
    const t = setTimeout(() => { void load(); }, 5000);
    return () => clearTimeout(t);
  }, [exports, load]);
  if (!owner) return null;
  const act = async (work: () => Promise<string>) => { setBusy(true); setNote(null); try { setNote(await work()); await load(); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } };
  const day = (v: string | null) => (v ? new Date(v).toLocaleString() : '');
  const c = closure?.closure && !['closed', 'cancelled'].includes(closure.closure.status) ? closure.closure : null;

  return <section className="ig__surface wl" aria-labelledby="ws-life-title">
    <div className="wl__heading">
      <span className="ig__eyebrow">OWNER CONTROLS</span>
      <h3 id="ws-life-title">Export and closure</h3>
      <p>Take your records with you, or manage the end of a workspace.</p>
    </div>
      {note && <p className="ig__notice" role="status">{note}</p>}
      <div className="wl__action">
        <span className="wl__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg></span>
        <div className="wl__copy"><h4>Export your workspace</h4><p>Records, processes and attachments in one package. Passwords and keys stay out. Downloads remain available for seven days.</p></div>
        <button type="button" className="cs__btn" disabled={busy} onClick={() => void act(async () => { await postJson('/api/workspace/exports', {}); return 'Export started. It appears below when ready.'; })}>Create export</button>
      </div>
      {(exports?.length ?? 0) > 0 && <ul className="wl__exports">{exports!.map((x) => <li key={x.id} className="ig__row"><div className="ig__rowMain">
        <strong>{x.reason === 'closure' ? 'Closure export' : 'Export'} · {day(x.created_at)}</strong><span className={`ig__status ${x.status === 'ready' ? '' : 'ig__status--off'}`}>{x.status}</span>
        <p>{x.totals ? `${x.totals.tables} tables · ${x.totals.rows} rows · ${x.totals.attachments} attachments` : ''}{x.byte_size ? ` · ${(x.byte_size / 1048576).toFixed(1)} MB` : ''}{x.expires_at && x.status === 'ready' ? ` · until ${day(x.expires_at)}` : ''}{x.sha256 ? ` · SHA-256 ${x.sha256.slice(0, 16)}…` : ''}{x.error ? ` · ${x.error}` : ''}</p></div>
        {x.status === 'ready' && <button type="button" className="cs__btn" onClick={() => void act(async () => { const r = await postJson<{ url: string }>(`/api/workspace/exports/${x.id}/download`, {}); window.location.href = r.url; return 'Download started.'; })}>Download</button>}
      </li>)}</ul>}

      <div className="wl__action wl__action--closure">
        <span className="wl__icon wl__icon--closure" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></svg></span>
        <div className="wl__copy"><h4>Close this workspace</h4><p>Start with an export. Suspension and a waiting period follow before deletion can be approved.</p></div>
        {!c && !closing && <button type="button" className="cs__btn" onClick={() => setClosing(true)}>Review closure</button>}
      </div>
      {c ? <div className="ig__notice wl__closureState">
        <strong>Closing: {c.status}</strong>
        <p>{c.reason} · asked {day(c.created_at)}{c.suspended_at ? ` · suspended ${day(c.suspended_at)}` : ''}{c.waiting_until ? ` · deletion can be approved from ${day(c.waiting_until)}` : ''}{closure!.legalHolds ? ` · ${closure!.legalHolds} legal hold(s) block deletion` : ''}</p>
        <div className="pp2__roleEdit">
          {c.status === 'requested' && <button type="button" className="cs__btn cs__btn--primary" disabled={busy || c.export_status !== 'ready'} onClick={() => void act(async () => { const r = await postJson<{ membersSuspended: number }>('/api/workspace/closure/suspend', {}); return `Suspended. ${r.membersSuspended} member(s) signed out; keys, webhooks and intake stopped.`; })}>{c.export_status === 'ready' ? 'Suspend the workspace' : 'Waiting for the export…'}</button>}
          {c.status === 'requested' && <button type="button" className="cs__btn" disabled={busy} onClick={() => void act(async () => { await postJson('/api/workspace/closure/suspend', { waiveExport: true }); return 'Suspended without waiting for the export.'; })}>Suspend without an export</button>}
          {['requested', 'suspended', 'approved'].includes(c.status) && <button type="button" className="cs__btn" disabled={busy} onClick={() => void act(async () => { const r = await postJson<{ restored: number; note: string }>('/api/workspace/closure/cancel', {}); return `Cancelled. ${r.restored} member(s) restored. ${r.note}`; })}>Cancel closing</button>}
        </div>
      </div> : <>
        {closing && <form className="ig__form wl__closureForm" onSubmit={(e) => { e.preventDefault(); void act(async () => { await postJson('/api/workspace/closure', { reason, confirmName: confirm }); setClosing(false); setReason(''); setConfirm(''); return 'Closure started. An export is being prepared; suspend the workspace once it is ready.'; }); }}>
          <div className="ig__formTitle"><strong>Close the workspace</strong><p>After you suspend it, a {closure?.waitDays ?? 14}-day wait starts. Then a Patform site owner approves deletion, unless a legal hold is in place. Deleted data cannot be recovered; backups expire on their own schedule.</p></div>
          <div><label className="cs__label" htmlFor="cl-why">Why</label><input id="cl-why" className="cs__input" required value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div><label className="cs__label" htmlFor="cl-name">Type the workspace name: {workspaceName}</label><input id="cl-name" className="cs__input" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
          <div className="pp2__roleEdit" style={{ alignSelf: 'end' }}><button type="submit" className="cs__btn cs__btn--primary" disabled={busy || confirm !== workspaceName}>Start closing</button><button type="button" className="cs__btn" onClick={() => setClosing(false)}>Never mind</button></div>
        </form>}
      </>}
  </section>;
}
