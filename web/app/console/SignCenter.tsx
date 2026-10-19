'use client';

/*
 * Patform Sign, the sender's side: send a contract or any PDF for signature,
 * place the boxes each signer fills, follow who has signed, remind, cancel,
 * and download the sealed copy.
 */
import { useCallback, useEffect, useState } from 'react';
import { postJson } from './stepup';
import { PdfPages, PageBox } from '../../components/pdf-pages';

type Envelope = { id: string; number: number; title: string; status: string; routing: string; created_at: string; sent_at: string | null; completed_at: string | null; expires_at: string; final_sha256: string | null; contract: string | null; signers: number; signed: number };
type Recipient = { id: string; name: string; email: string; role: string; routing_order: number; status: string; notified_at: string | null; verified_at: string | null; signed_at: string | null; declined_at: string | null; decline_reason: string | null };
type Field = { id?: string; recipient_id: string; kind: Kind; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string | null };
type Detail = { envelope: Envelope & { page_count: number; original_sha256: string; void_reason: string | null }; recipients: Recipient[]; fields: Field[]; events: { kind: string; occurred_at: string; recipient: string | null; ip: string | null }[] };
type Kind = 'signature' | 'initials' | 'date' | 'name' | 'text';
type Row = { name: string; email: string; role: 'signer' | 'cc'; order: number };

const SIZE: Record<Kind, [number, number]> = { signature: [0.26, 0.06], initials: [0.1, 0.05], date: [0.16, 0.03], name: [0.26, 0.03], text: [0.26, 0.03] };
const COLORS = ['#1f6feb', '#b26b00', '#8250df', '#1a7f37', '#cf222e', '#0969da'];
const day = (v: string | null) => (v ? new Date(v).toLocaleString() : '');

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}
async function pdfOf(envelopeId: string): Promise<ArrayBuffer> {
  const res = await fetch(`/api/sign/envelopes/${envelopeId}/document`, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error('The document could not be loaded.');
  return res.arrayBuffer();
}
async function readBase64(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] ?? ''); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
}

export function SignCenter({ startContract, onClose }: { startContract?: { id: string; title: string } | null; onClose?: () => void }) {
  const [list, setList] = useState<Envelope[] | null>(null);
  const [mode, setMode] = useState<'list' | 'compose' | 'place' | 'detail'>(startContract ? 'compose' : 'list');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(startContract?.title ?? '');
  const [message, setMessage] = useState('');
  const [routing, setRouting] = useState<'sequential' | 'parallel'>('sequential');
  const [days, setDays] = useState('30');
  const [rows, setRows] = useState<Row[]>([{ name: '', email: '', role: 'signer', order: 1 }]);
  const [docRef, setDocRef] = useState<{ ref: string; name: string } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [current, setCurrent] = useState<{ recipient: string; kind: Kind }>({ recipient: '', kind: 'signature' });
  const [textLabel, setTextLabel] = useState('');
  const [voidWhy, setVoidWhy] = useState('');

  const loadList = useCallback(async () => { try { setList(await get<Envelope[]>('/api/sign/envelopes')); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } }, []);
  useEffect(() => { void loadList(); }, [loadList]);
  const open = async (id: string, next: 'place' | 'detail') => {
    const d = await get<Detail>(`/api/sign/envelopes/${id}`);
    setDetail(d); setFields(d.fields); setPdf(await pdfOf(id));
    setCurrent({ recipient: d.recipients.find((r) => r.role === 'signer')?.id ?? '', kind: 'signature' });
    setMode(next);
  };
  const act = async (work: () => Promise<string | void>) => { setBusy(true); setNote(null); try { const m = await work(); if (m) setNote(m); await loadList(); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } };
  const signers = (detail?.recipients ?? []).filter((r) => r.role === 'signer');
  const color = (rid: string) => COLORS[Math.max(0, signers.findIndex((s) => s.id === rid)) % COLORS.length]!;

  return <div className="ig__form" style={{ gridTemplateColumns: '1fr' }}>
    <div className="ig__formTitle"><strong>Patform Sign</strong><p>Send a document for signature. Each signer confirms their email with a code, agrees to sign electronically and signs; the finished PDF carries every signature and a certificate, and can be checked at <a href="/sign/verify" target="_blank" rel="noopener">the verify page</a>.</p></div>
    {note && <p className="ig__notice" role="status">{note}</p>}

    {mode === 'list' && <>
      <div className="pp2__roleEdit"><button type="button" className="cs__btn cs__btn--primary" onClick={() => { setMode('compose'); setTitle(''); setDocRef(null); setRows([{ name: '', email: '', role: 'signer', order: 1 }]); }}>Send a PDF for signature</button>{onClose && <button type="button" className="cs__btn" onClick={onClose}>Close</button>}</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{(list ?? []).map((e) => <li key={e.id} className="ig__row"><div className="ig__rowMain">
        <strong>PS-{e.number} {e.title}</strong><span className={`ig__status ${e.status === 'completed' ? '' : 'ig__status--off'}`}>{e.status}{e.status === 'sent' ? ` · ${e.signed} of ${e.signers} signed` : ''}</span>
        <p>{e.contract ? `Contract: ${e.contract} · ` : ''}{e.routing === 'parallel' ? 'all at once' : 'in order'} · {e.sent_at ? `sent ${day(e.sent_at)}` : `created ${day(e.created_at)}`}{e.completed_at ? ` · completed ${day(e.completed_at)}` : ''}</p></div>
        <button type="button" className="cs__btn" onClick={() => void act(() => open(e.id, e.status === 'draft' ? 'place' : 'detail'))}>{e.status === 'draft' ? 'Continue' : 'Open'}</button>
      </li>)}{list && !list.length && <li className="ig__row"><div className="ig__rowMain"><p>Nothing sent for signature yet.</p></div></li>}</ul>
    </>}

    {mode === 'compose' && <form onSubmit={(e) => { e.preventDefault(); void act(async () => {
      const r = await postJson<{ id: string }>('/api/sign/envelopes', { ...(startContract ? { contractId: startContract.id } : { documentRef: docRef?.ref }), title, message, routing, expiresInDays: Number(days), recipients: rows.filter((x) => x.name || x.email) });
      await open(r.id, 'place');
      return 'Saved as a draft. Now place the boxes each signer fills, then send.';
    }); }} style={{ display: 'grid', gap: 12 }}>
      {startContract ? <p>Contract: <strong>{startContract.title}</strong> (its current, approved version)</p>
        : <div><label className="cs__label" htmlFor="ps-file">PDF to sign{docRef ? ` — ${docRef.name} uploaded` : ''}</label><input id="ps-file" type="file" accept="application/pdf,.pdf" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; void act(async () => { const r = await postJson<{ reference: string; filename: string }>('/api/gov/files', { purpose: 'signing', filename: file.name, base64: await readBase64(file) }); setDocRef({ ref: r.reference, name: r.filename }); if (!title) setTitle(file.name.replace(/\.pdf$/i, '')); return 'Uploaded. It can be sent once the malware check passes (usually under a minute).'; }); }} /></div>}
      <div><label className="cs__label" htmlFor="ps-title">Title</label><input id="ps-title" className="cs__input" required value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      <div><label className="cs__label" htmlFor="ps-msg">Message to signers (optional)</label><input id="ps-msg" className="cs__input" value={message} onChange={(e) => setMessage(e.target.value)} /></div>
      <div className="pp2__roleEdit">
        <div><label className="cs__label" htmlFor="ps-route">Signing order</label><select id="ps-route" className="cs__input" value={routing} onChange={(e) => setRouting(e.target.value as 'sequential' | 'parallel')}><option value="sequential">One after another</option><option value="parallel">All at once</option></select></div>
        <div><label className="cs__label" htmlFor="ps-days">Expires after (days)</label><input id="ps-days" type="number" min={1} max={365} className="cs__input" value={days} onChange={(e) => setDays(e.target.value)} /></div>
      </div>
      <strong>Recipients</strong>
      {rows.map((r, i) => <div key={i} className="pp2__roleEdit" style={{ alignItems: 'end' }}>
        <div><label className="cs__label" htmlFor={`ps-n${i}`}>Name</label><input id={`ps-n${i}`} className="cs__input" value={r.name} onChange={(e) => setRows((x) => x.map((y, j) => j === i ? { ...y, name: e.target.value } : y))} /></div>
        <div><label className="cs__label" htmlFor={`ps-e${i}`}>Email</label><input id={`ps-e${i}`} type="email" className="cs__input" value={r.email} onChange={(e) => setRows((x) => x.map((y, j) => j === i ? { ...y, email: e.target.value } : y))} /></div>
        <div><label className="cs__label" htmlFor={`ps-r${i}`}>Role</label><select id={`ps-r${i}`} className="cs__input" value={r.role} onChange={(e) => setRows((x) => x.map((y, j) => j === i ? { ...y, role: e.target.value as 'signer' | 'cc' } : y))}><option value="signer">Signs</option><option value="cc">Gets a copy</option></select></div>
        {routing === 'sequential' && r.role === 'signer' && <div><label className="cs__label" htmlFor={`ps-o${i}`}>Order</label><input id={`ps-o${i}`} type="number" min={1} className="cs__input" style={{ width: 70 }} value={r.order} onChange={(e) => setRows((x) => x.map((y, j) => j === i ? { ...y, order: Number(e.target.value) || 1 } : y))} /></div>}
        <button type="button" className="cs__btn" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} disabled={rows.length === 1}>Remove</button>
      </div>)}
      <div className="pp2__roleEdit"><button type="button" className="cs__btn" onClick={() => setRows((x) => [...x, { name: '', email: '', role: 'signer', order: x.length + 1 }])}>Add a recipient</button>
        <button type="submit" className="cs__btn cs__btn--primary" disabled={busy || (!startContract && !docRef)}>Next: place the boxes</button>
        <button type="button" className="cs__btn" onClick={() => { if (onClose && startContract) onClose(); else setMode('list'); }}>Cancel</button></div>
    </form>}

    {mode === 'place' && detail && pdf && <>
      <div className="pp2__roleEdit" style={{ position: 'sticky', top: 0, background: 'var(--surface, #fff)', zIndex: 3, padding: '8px 0' }}>
        <div><label className="cs__label" htmlFor="pl-who">Box for</label><select id="pl-who" className="cs__input" value={current.recipient} onChange={(e) => setCurrent((c) => ({ ...c, recipient: e.target.value }))}>{signers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label className="cs__label" htmlFor="pl-kind">Kind</label><select id="pl-kind" className="cs__input" value={current.kind} onChange={(e) => setCurrent((c) => ({ ...c, kind: e.target.value as Kind }))}><option value="signature">Signature</option><option value="initials">Initials</option><option value="date">Date signed</option><option value="name">Printed name</option><option value="text">Text to fill</option></select></div>
        {current.kind === 'text' && <div><label className="cs__label" htmlFor="pl-label">Label</label><input id="pl-label" className="cs__input" placeholder="e.g. Company number" value={textLabel} onChange={(ev) => setTextLabel(ev.target.value)} /></div>}
        <span className="ig__muted" style={{ alignSelf: 'center' }}>Click a page to place a box; click a box to remove it. {fields.length} placed.</span>
        <button type="button" className="cs__btn" disabled={busy} onClick={() => void act(async () => { await postJson(`/api/sign/envelopes/${detail.envelope.id}/fields`, { fields: fields.map((f) => ({ recipientId: f.recipient_id, kind: f.kind, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label })) }); return 'Boxes saved.'; })}>Save</button>
        <button type="button" className="cs__btn cs__btn--primary" disabled={busy} onClick={() => void act(async () => {
          await postJson(`/api/sign/envelopes/${detail.envelope.id}/fields`, { fields: fields.map((f) => ({ recipientId: f.recipient_id, kind: f.kind, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label })) });
          const r = await postJson<{ notified: number }>(`/api/sign/envelopes/${detail.envelope.id}/send`, {});
          await open(detail.envelope.id, 'detail');
          return `Sent. ${r.notified} signer(s) emailed.${signers.some((s) => !fields.some((f) => f.recipient_id === s.id && f.kind === 'signature')) ? ' Signers without a signature box sign on an added signature page.' : ''}`;
        })}>Send</button>
        <button type="button" className="cs__btn" onClick={() => { setMode('list'); setDetail(null); setPdf(null); }}>Later</button>
      </div>
      <p className="ig__muted">{signers.map((s) => <span key={s.id} style={{ color: color(s.id), marginRight: 12 }}>■ {s.name}</span>)}</p>
      <PdfPages data={pdf}
        onPageClick={(page, x, y) => { if (!current.recipient) return; const [w, h] = SIZE[current.kind]; const label = current.kind === 'text' ? (textLabel.trim() || 'Text') : null;
          setFields((f) => [...f, { recipient_id: current.recipient, kind: current.kind, page, x: Math.max(0, Math.min(1 - w, x - w / 2)), y: Math.max(0, Math.min(1 - h, y - h / 2)), width: w, height: h, required: true, label }]); }}
        overlay={(page) => fields.map((f, i) => f.page === page && <PageBox key={i} x={f.x} y={f.y} width={f.width} height={f.height} color={color(f.recipient_id)} title="Click to remove" onClick={() => setFields((all) => all.filter((_, j) => j !== i))}>{f.kind} · {signers.find((s) => s.id === f.recipient_id)?.name.split(' ')[0]}</PageBox>)} />
    </>}

    {mode === 'detail' && detail && <>
      <p><strong>PS-{detail.envelope.number} {detail.envelope.title}</strong> · {detail.envelope.status}{detail.envelope.void_reason ? ` (${detail.envelope.void_reason})` : ''} · expires {day(detail.envelope.expires_at)}</p>
      {detail.envelope.final_sha256 && <p className="ig__muted" style={{ wordBreak: 'break-all' }}>Signed copy SHA-256: {detail.envelope.final_sha256}</p>}
      <table className="ex__table"><thead><tr><th scope="col">Recipient</th><th scope="col">Status</th><th scope="col">Verified</th><th scope="col">Signed</th></tr></thead>
        <tbody>{detail.recipients.map((r) => <tr key={r.id}><td>{r.name}<br /><small>{r.email} · {r.role === 'cc' ? 'copy' : `signer ${r.routing_order}`}</small></td><td>{r.status}{r.decline_reason ? `: ${r.decline_reason}` : ''}</td><td>{day(r.verified_at)}</td><td>{day(r.signed_at)}</td></tr>)}</tbody></table>
      <div className="pp2__roleEdit">
        {detail.envelope.status === 'completed' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(async () => { const blob = new Blob([await pdfOf(detail.envelope.id)], { type: 'application/pdf' }); const url = URL.createObjectURL(blob); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000); })}>Open the signed copy</button>}
        {detail.envelope.status === 'sent' && <button type="button" className="cs__btn" disabled={busy} onClick={() => void act(async () => { const r = await postJson<{ reminded: number }>(`/api/sign/envelopes/${detail.envelope.id}/remind`, {}); return `Reminded ${r.reminded} signer(s).`; })}>Remind now</button>}
        {['draft', 'sent'].includes(detail.envelope.status) && <button type="button" className="cs__btn" disabled={busy} onClick={() => { setNote(null); const why = voidWhy.trim(); if (!why) { setNote('Type why you are cancelling in the box, then press Cancel envelope.'); return; } void act(async () => { await postJson(`/api/sign/envelopes/${detail.envelope.id}/void`, { reason: why }); await open(detail.envelope.id, 'detail'); return 'Cancelled. Signers who were asked have been told.'; }); }}>Cancel envelope</button>}
        {['draft', 'sent'].includes(detail.envelope.status) && <input id="ps-void" aria-label="Why cancel" className="cs__input" placeholder="Why cancel?" style={{ maxWidth: 260 }} value={voidWhy} onChange={(e) => setVoidWhy(e.target.value)} />}
        <button type="button" className="cs__btn" onClick={() => { setMode('list'); setDetail(null); setPdf(null); if (onClose && startContract) onClose(); }}>Back</button>
      </div>
      <p className="ig__muted"><small>{detail.events.map((e) => `${day(e.occurred_at)} ${e.kind.replace(/_/g, ' ')}${e.recipient ? ` (${e.recipient})` : ''}`).join(' · ')}</small></p>
    </>}
  </div>;
}
