'use client';

import { useEffect, useState } from 'react';

/*
 * Workspace closures waiting for, or past, a site owner's decision
 * (PRD 17.3). Approval goes through the page's own confirm dialog, which
 * asks for the password and authenticator code first.
 */
type Closure = { id: string; workspace: string; status: string; reason: string; requested_by_email: string | null; created_at: string; suspended_at: string | null; waiting_until: string | null;
  approved_at: string | null; closed_at: string | null; export_waived: boolean; export_status: string | null; legal_holds: number; certificate: { total_rows: number; files_deleted: number } | null };

export function Closures({ reloadKey, mayApprove, onApprove }: { reloadKey: unknown; mayApprove: boolean; onApprove: (c: { id: string; workspace: string }) => void }) {
  const [rows, setRows] = useState<Closure[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch('/api/platform/closures', { credentials: 'include', cache: 'no-store' })
      .then(async (r) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.reason ?? b.error ?? `HTTP ${r.status}`); setRows(b as Closure[]); })
      .catch((e: Error) => setError(e.message));
  }, [reloadKey]);
  if (error) return <p className="platform__muted">{error}</p>;
  if (!rows) return <p className="platform__muted">Loading…</p>;
  if (!rows.length) return <p className="platform__muted">No workspace has asked to close.</p>;
  const day = (v: string | null) => (v ? new Date(v).toLocaleDateString() : '—');
  return <div className="platform__table"><table><thead><tr><th>Workspace</th><th>Status</th><th>Export</th><th>Deletable from</th><th>Holds</th><th></th></tr></thead><tbody>
    {rows.map((c) => {
      const due = !c.waiting_until || new Date(c.waiting_until) <= new Date();
      return <tr key={c.id}>
        <td><strong>{c.workspace}</strong><small>{c.requested_by_email} · {day(c.created_at)} · {c.reason}</small></td>
        <td>{c.status}{c.certificate ? ` · ${c.certificate.total_rows} rows, ${c.certificate.files_deleted} files deleted` : ''}</td>
        <td>{c.export_waived ? 'waived' : c.export_status ?? '—'}</td>
        <td>{day(c.waiting_until)}</td>
        <td>{c.legal_holds ? `${c.legal_holds} — blocks deletion` : 'none'}</td>
        <td>{mayApprove && c.status === 'suspended' && due && !c.legal_holds && <button className="platform__button" onClick={() => onApprove({ id: c.id, workspace: c.workspace })}>Approve deletion</button>}</td>
      </tr>;
    })}
  </tbody></table></div>;
}
