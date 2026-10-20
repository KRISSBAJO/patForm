'use client';

/*
 * Patform Sign, the sender's side: send a contract or any PDF for signature,
 * place the boxes each signer fills, follow who has signed, remind, cancel,
 * and download the sealed copy.
 */
import { useCallback, useEffect, useState } from 'react';
import { postJson } from './stepup';
import { ShellSync, type ModuleShell } from './module-shell';
import { PdfPages, PageBox } from '../../components/pdf-pages';

type Envelope = { id: string; number: number; title: string; status: string; routing: string; created_at: string; sent_at: string | null; completed_at: string | null; expires_at: string; final_sha256: string | null; contract: string | null; signers: number; signed: number };
type Recipient = { id: string; name: string; email: string; role: string; routing_order: number; status: string; party_id: string | null; party: string | null; title: string | null; verify_by: string; register_match: { officer: { name: string; role: string; appointedOn: string | null } | null } | null; notified_at: string | null; verified_at: string | null; signed_at: string | null; declined_at: string | null; decline_reason: string | null };
type Field = { id?: string; recipient_id: string | null; party_id?: string | null; slot?: number | null; kind: Kind; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string | null };
type Register = { available: boolean; reason?: string; country: string; number: string; companyName?: string; status?: string; source?: string; checkedAt: string };
type Party = { id: string; name: string; required_count: number; signed: number; authority_note: string | null; completed_at: string | null; register: Register | null; register_required: boolean };
type Detail = { envelope: Envelope & { page_count: number; original_sha256: string; void_reason: string | null; seal: { subject: string; selfIssued: boolean } | null; seal_timestamp: { time?: string; authority?: string; missing?: string } | null }; recipients: Recipient[]; parties: Party[]; fields: Field[]; events: { kind: string; occurred_at: string; recipient: string | null; ip: string | null }[] };
type Mode = 'list' | 'compose' | 'place' | 'detail' | 'verify';
type Kind = 'signature' | 'initials' | 'date' | 'name' | 'text' | 'title';
type Row = { name: string; email: string; role: 'signer' | 'cc'; order: number; party: string; title: string; phone: string; verifyBy: 'email' | 'sms' | 'email_and_sms' };
const blank = (order: number): Row => ({ name: '', email: '', role: 'signer', order, party: '', title: '', phone: '', verifyBy: 'email' });

const SIZE: Record<Kind, [number, number]> = { signature: [0.26, 0.06], initials: [0.1, 0.05], date: [0.16, 0.03], name: [0.26, 0.03], text: [0.26, 0.03], title: [0.26, 0.03] };
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

export function SignCenter({ startContract, onClose, shell }: { startContract?: { id: string; title: string } | null; onClose?: () => void; shell?: ModuleShell }) {
  const [list, setList] = useState<Envelope[] | null>(null);
  const [mode, setMode] = useState<Mode>(startContract ? 'compose' : 'list');
  // The rail's section for a mode, and a mode change that tells the rail.
  const sectionOf = (m: Mode) => (m === 'verify' ? 'verify' : m === 'compose' || m === 'place' ? 'send' : 'envelopes');
  const go = (m: Mode) => { setMode(m); shell?.onSection?.(sectionOf(m)); };
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(startContract?.title ?? '');
  const [message, setMessage] = useState('');
  const [routing, setRouting] = useState<'sequential' | 'parallel'>('sequential');
  const [days, setDays] = useState('30');
  const [rows, setRows] = useState<Row[]>([blank(1)]);
  const [partyRules, setPartyRules] = useState<Record<string, { required: string; note: string; country: string; number: string; strict: boolean }>>({});
  const rule = (c: string) => partyRules[c] ?? { required: '1', note: '', country: 'GB', number: '', strict: false };
  const setRule = (c: string, patch: Partial<ReturnType<typeof rule>>) => setPartyRules((x) => ({ ...x, [c]: { ...rule(c), ...patch } }));
  const [docRef, setDocRef] = useState<{ ref: string; name: string } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  // A box belongs to a person ("r:<id>") or to a company's numbered signatory ("p:<id>:<slot>").
  const [current, setCurrent] = useState<{ recipient: string; kind: Kind }>({ recipient: '', kind: 'signature' });
  const [textLabel, setTextLabel] = useState('');
  const [voidWhy, setVoidWhy] = useState('');

  const loadList = useCallback(async () => { try { setList(await get<Envelope[]>('/api/sign/envelopes')); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } }, []);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    const want = shell?.section;
    if (!want || want === sectionOf(mode)) return;
    if (want === 'envelopes') { setMode('list'); setDetail(null); setPdf(null); }
    else if (want === 'send') { setMode('compose'); setTitle(''); setDocRef(null); setRows([blank(1)]); setPartyRules({}); }
    else if (want === 'verify') setMode('verify');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell?.section]);
  const sections = [
    { id: 'envelopes', name: 'Envelopes', count: (list ?? []).filter((e) => e.status === 'sent').length },
    { id: 'send', name: 'Send a document', count: null },
    { id: 'verify', name: 'Verify a copy', count: null },
  ];
  const open = async (id: string, next: 'place' | 'detail') => {
    const d = await get<Detail>(`/api/sign/envelopes/${id}`);
    setDetail(d); setFields(d.fields); setPdf(await pdfOf(id));
    const firstPerson = d.recipients.find((r) => r.role === 'signer' && !r.party_id);
    setCurrent({ recipient: firstPerson ? `r:${firstPerson.id}` : d.parties[0] ? `p:${d.parties[0].id}:1` : '', kind: 'signature' });
    go(next);
  };
  const act = async (work: () => Promise<string | void>) => { setBusy(true); setNote(null); try { const m = await work(); if (m) setNote(m); await loadList(); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } };
  const signers = (detail?.recipients ?? []).filter((r) => r.role === 'signer');
  const owners = [
    ...signers.filter((s) => !s.party_id).map((s) => ({ key: `r:${s.id}`, label: s.name })),
    ...(detail?.parties ?? []).flatMap((p) => Array.from({ length: p.required_count }, (_, i) => ({ key: `p:${p.id}:${i + 1}`, label: `${p.name} — signatory ${i + 1}` }))),
  ];
  const keyOf = (f: Field) => f.party_id ? `p:${f.party_id}:${f.slot}` : `r:${f.recipient_id}`;
  const color = (key: string) => COLORS[Math.max(0, owners.findIndex((o) => o.key === key)) % COLORS.length]!;
  const toBody = (f: Field) => ({ ...(f.party_id ? { partyId: f.party_id, slot: f.slot } : { recipientId: f.recipient_id }), kind: f.kind, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label });
  const companies = [...new Set(rows.filter((r) => r.role === 'signer' && r.party.trim()).map((r) => r.party.trim()))];

  return <div className={shell ? 'ig__workspace' : undefined}>{shell && <header className="ig__hero" style={{ marginBottom: 18 }}><span className="ig__eyebrow">PATFORM SIGN</span><h2>Send, sign, seal, verify</h2><p>Each signer confirms a code, agrees to sign electronically and signs; the finished PDF carries every signature, a certificate page and a seal with a trusted time stamp, and anyone can check a copy.</p></header>}<div className={shell ? 'ig__form ig__form--plain' : 'ig__form'} style={{ gridTemplateColumns: '1fr' }}>
    {!shell && <div className="ig__formTitle"><strong>Patform Sign</strong><p>Send a document for signature. Each signer confirms their email with a code, agrees to sign electronically and signs; the finished PDF carries every signature and a certificate, and can be checked at <a href="/sign/verify" target="_blank" rel="noopener">the verify page</a>.</p></div>}
    <ShellSync sections={sections} onSections={shell?.onSections} />
    {note && <p className="ig__notice" role="status">{note}</p>}

    {mode === 'list' && <>
      <div className="pp2__roleEdit"><button type="button" className="cs__btn cs__btn--primary" onClick={() => { go('compose'); setTitle(''); setDocRef(null); setRows([blank(1)]); setPartyRules({}); }}>Send a PDF for signature</button>{onClose && <button type="button" className="cs__btn" onClick={onClose}>Close</button>}</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{(list ?? []).map((e) => <li key={e.id} className="ig__row"><div className="ig__rowMain">
        <strong>PS-{e.number} {e.title}</strong><span className={`ig__status ${e.status === 'completed' ? '' : 'ig__status--off'}`}>{e.status}{e.status === 'sent' ? ` · ${e.signed} of ${e.signers} signed` : ''}</span>
        <p>{e.contract ? `Contract: ${e.contract} · ` : ''}{e.routing === 'parallel' ? 'all at once' : 'in order'} · {e.sent_at ? `sent ${day(e.sent_at)}` : `created ${day(e.created_at)}`}{e.completed_at ? ` · completed ${day(e.completed_at)}` : ''}</p></div>
        <button type="button" className="cs__btn" onClick={() => void act(() => open(e.id, e.status === 'draft' ? 'place' : 'detail'))}>{e.status === 'draft' ? 'Continue' : 'Open'}</button>
      </li>)}{list && !list.length && <li className="ig__row"><div className="ig__rowMain"><p>Nothing sent for signature yet.</p></div></li>}</ul>
    </>}

    {mode === 'verify' && <div className="ig__panelHead"><div><h3>Verify a signed copy</h3><p>Anyone holding the PDF can check it; no account is needed. The page reads the file in the browser, finds the seal and the fingerprint, and says whether the copy is genuine and who signed it.</p></div><a className="cs__btn cs__btn--primary" href="/sign/verify" target="_blank" rel="noreferrer">Open the verify page</a></div>}

    {mode === 'compose' && <form onSubmit={(e) => { e.preventDefault(); void act(async () => {
      const r = await postJson<{ id: string; parties: { name: string; unlisted: string[]; register: Register | null }[] }>('/api/sign/envelopes', { ...(startContract ? { contractId: startContract.id } : { documentRef: docRef?.ref }), title, message, routing, expiresInDays: Number(days),
        recipients: rows.filter((x) => x.name || x.email).map((x) => ({ name: x.name, email: x.email, role: x.role, order: x.order, party: x.role === 'signer' ? x.party.trim() || undefined : undefined, title: x.title || undefined, phone: x.phone || undefined, verifyBy: x.verifyBy })),
        parties: companies.map((c) => ({ name: c, required: Number(rule(c).required || 1), order: rows.find((x) => x.party.trim() === c)?.order ?? 1, authorityNote: rule(c).note || undefined,
          register: rule(c).number.trim() ? { country: rule(c).country, number: rule(c).number.trim() } : undefined, requireRegistered: rule(c).strict })) });
      await open(r.id, 'place');
      const notes = r.parties.flatMap((p) => [
        ...(p.register && !p.register.available ? [`${p.name}: register check not available (${p.register.reason}).`] : []),
        ...(p.register?.available ? [`${p.name}: ${p.register.source} lists ${p.register.companyName} as ${p.register.status}.`] : []),
        ...(p.unlisted.length ? [`Not listed as officers of ${p.name}: ${p.unlisted.join(', ')} — they can still sign under the authority you recorded.`] : []),
      ]);
      return `Saved as a draft. Now place the boxes each signer fills, then send.${notes.length ? ` ${notes.join(' ')}` : ''}`;
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
        {r.role === 'signer' && <div><label className="cs__label" htmlFor={`ps-c${i}`}>For a company (optional)</label><input id={`ps-c${i}`} className="cs__input" placeholder="e.g. Acme Ltd" value={r.party} onChange={(e) => setRows((x) => x.map((y, j) => j === i ? { ...y, party: e.target.value } : y))} /></div>}
        {r.role === 'signer' && <div><label className="cs__label" htmlFor={`ps-t${i}`}>Job title</label><input id={`ps-t${i}`} className="cs__input" value={r.title} onChange={(e) => setRows((x) => x.map((y, j) => j === i ? { ...y, title: e.target.value } : y))} /></div>}
        {r.role === 'signer' && <div><label className="cs__label" htmlFor={`ps-v${i}`}>Confirm by</label><select id={`ps-v${i}`} className="cs__input" value={r.verifyBy} onChange={(e) => setRows((x) => x.map((y, j) => j === i ? { ...y, verifyBy: e.target.value as Row['verifyBy'] } : y))}><option value="email">Email code</option><option value="sms">Text-message code</option><option value="email_and_sms">Email and text codes</option></select></div>}
        {r.role === 'signer' && r.verifyBy !== 'email' && <div><label className="cs__label" htmlFor={`ps-p${i}`}>Mobile (+country code)</label><input id={`ps-p${i}`} className="cs__input" inputMode="tel" placeholder="+2348012345678" value={r.phone} onChange={(e) => setRows((x) => x.map((y, j) => j === i ? { ...y, phone: e.target.value } : y))} /></div>}
        {routing === 'sequential' && r.role === 'signer' && <div><label className="cs__label" htmlFor={`ps-o${i}`}>Order</label><input id={`ps-o${i}`} type="number" min={1} className="cs__input" style={{ width: 70 }} value={r.order} onChange={(e) => setRows((x) => x.map((y, j) => j === i ? { ...y, order: Number(e.target.value) || 1 } : y))} /></div>}
        <button type="button" className="cs__btn" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} disabled={rows.length === 1}>Remove</button>
      </div>)}
      {companies.map((c) => { const members = rows.filter((x) => x.role === 'signer' && x.party.trim() === c).length; return <div key={c} className="pp2__roleEdit" style={{ alignItems: 'end' }}>
        <strong style={{ alignSelf: 'center' }}>{c}</strong>
        <div><label className="cs__label" htmlFor={`pr-${c}`}>Signatures needed (of {members})</label><input id={`pr-${c}`} type="number" min={1} max={members} className="cs__input" style={{ width: 90 }} value={rule(c).required} onChange={(e) => setRule(c, { required: e.target.value })} /></div>
        <div><label className="cs__label" htmlFor={`pn-${c}`}>Authority (e.g. board resolution reference)</label><input id={`pn-${c}`} className="cs__input" value={rule(c).note} onChange={(e) => setRule(c, { note: e.target.value })} /></div>
        <div><label className="cs__label" htmlFor={`pc-${c}`}>Register</label><select id={`pc-${c}`} className="cs__input" value={rule(c).country} onChange={(e) => setRule(c, { country: e.target.value })}><option value="GB">UK Companies House</option><option value="NG">Nigeria CAC</option></select></div>
        <div><label className="cs__label" htmlFor={`pk-${c}`}>Company number (optional)</label><input id={`pk-${c}`} className="cs__input" style={{ width: 150 }} placeholder={rule(c).country === 'NG' ? 'RC123456' : '12345678'} value={rule(c).number} onChange={(e) => setRule(c, { number: e.target.value })} /></div>
        {rule(c).number.trim() && <div><label className="pp2__inlineLabel"><input type="checkbox" checked={rule(c).strict} onChange={(e) => setRule(c, { strict: e.target.checked })} /> Only listed officers may sign</label></div>}
      </div>; })}
      <div className="pp2__roleEdit"><button type="button" className="cs__btn" onClick={() => setRows((x) => [...x, blank(x.length + 1)])}>Add a recipient</button>
        <button type="submit" className="cs__btn cs__btn--primary" disabled={busy || (!startContract && !docRef)}>Next: place the boxes</button>
        <button type="button" className="cs__btn" onClick={() => { if (onClose && startContract) onClose(); else go('list'); }}>Cancel</button></div>
    </form>}

    {mode === 'place' && detail && pdf && <>
      <div className="pp2__roleEdit" style={{ position: 'sticky', top: 0, background: 'var(--surface, #fff)', zIndex: 3, padding: '8px 0' }}>
        <div><label className="cs__label" htmlFor="pl-who">Box for</label><select id="pl-who" className="cs__input" value={current.recipient} onChange={(e) => setCurrent((c) => ({ ...c, recipient: e.target.value }))}>{owners.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select></div>
        <div><label className="cs__label" htmlFor="pl-kind">Kind</label><select id="pl-kind" className="cs__input" value={current.kind} onChange={(e) => setCurrent((c) => ({ ...c, kind: e.target.value as Kind }))}><option value="signature">Signature</option><option value="initials">Initials</option><option value="date">Date signed</option><option value="name">Printed name</option><option value="title">Job title</option><option value="text">Text to fill</option></select></div>
        {current.kind === 'text' && <div><label className="cs__label" htmlFor="pl-label">Label</label><input id="pl-label" className="cs__input" placeholder="e.g. Company number" value={textLabel} onChange={(ev) => setTextLabel(ev.target.value)} /></div>}
        <span className="ig__muted" style={{ alignSelf: 'center' }}>Click a page to place a box; click a box to remove it. {fields.length} placed.</span>
        <button type="button" className="cs__btn" disabled={busy} onClick={() => void act(async () => { await postJson(`/api/sign/envelopes/${detail.envelope.id}/fields`, { fields: fields.map(toBody) }); return 'Boxes saved.'; })}>Save</button>
        <button type="button" className="cs__btn cs__btn--primary" disabled={busy} onClick={() => void act(async () => {
          await postJson(`/api/sign/envelopes/${detail.envelope.id}/fields`, { fields: fields.map(toBody) });
          const r = await postJson<{ notified: number }>(`/api/sign/envelopes/${detail.envelope.id}/send`, {});
          await open(detail.envelope.id, 'detail');
          return `Sent. ${r.notified} signer(s) emailed.${owners.some((o) => !fields.some((f) => keyOf(f) === o.key && f.kind === 'signature')) ? ' Anyone without a signature box signs on an added signature page.' : ''}`;
        })}>Send</button>
        <button type="button" className="cs__btn" onClick={() => { go('list'); setDetail(null); setPdf(null); }}>Later</button>
      </div>
      <p className="ig__muted">{owners.map((o) => <span key={o.key} style={{ color: color(o.key), marginRight: 12 }}>■ {o.label}</span>)}</p>
      <PdfPages data={pdf}
        onPageClick={(page, x, y) => { if (!current.recipient) return; const [w, h] = SIZE[current.kind]; const label = current.kind === 'text' ? (textLabel.trim() || 'Text') : null;
          const [kindOf, idOf, slotOf] = current.recipient.split(':');
          const owner = kindOf === 'p' ? { recipient_id: null, party_id: idOf!, slot: Number(slotOf) } : { recipient_id: idOf!, party_id: null, slot: null };
          setFields((f) => [...f, { ...owner, kind: current.kind, page, x: Math.max(0, Math.min(1 - w, x - w / 2)), y: Math.max(0, Math.min(1 - h, y - h / 2)), width: w, height: h, required: true, label }]); }}
        overlay={(page) => fields.map((f, i) => f.page === page && <PageBox key={i} x={f.x} y={f.y} width={f.width} height={f.height} color={color(keyOf(f))} title="Click to remove" onClick={() => setFields((all) => all.filter((_, j) => j !== i))}>{f.kind} · {owners.find((o) => o.key === keyOf(f))?.label.split(' ')[0]}{f.party_id ? ` ${f.slot}` : ''}</PageBox>)} />
    </>}

    {mode === 'detail' && detail && <>
      <p><strong>PS-{detail.envelope.number} {detail.envelope.title}</strong> · {detail.envelope.status}{detail.envelope.void_reason ? ` (${detail.envelope.void_reason})` : ''} · expires {day(detail.envelope.expires_at)}</p>
      {detail.envelope.final_sha256 && <p className="ig__muted" style={{ wordBreak: 'break-all' }}>Signed copy SHA-256: {detail.envelope.final_sha256}{detail.envelope.seal ? ` · sealed with ${detail.envelope.seal.subject}${detail.envelope.seal.selfIssued ? ' (self-issued certificate)' : ''}` : ''}</p>}
      {detail.parties.map((p) => <p key={p.id}><strong>{p.name}</strong>: {p.signed} of {p.required_count} required signature(s){p.completed_at ? ' — done' : ''}{p.authority_note ? ` · authority: ${p.authority_note}` : ''}
        {p.register && <><br /><small>{p.register.available ? `${p.register.source} (${p.register.country} ${p.register.number}): ${p.register.companyName ?? 'not found'}${p.register.status ? `, ${p.register.status}` : ''}, checked ${day(p.register.checkedAt)}${p.register_required ? ' · listed officers only' : ''}` : `Register check not available: ${p.register.reason}`}</small></>}</p>)}
      {detail.envelope.seal_timestamp && <p className="ig__muted">{detail.envelope.seal_timestamp.time ? `Time stamped ${day(detail.envelope.seal_timestamp.time)} by ${detail.envelope.seal_timestamp.authority}` : `No trusted time stamp: ${detail.envelope.seal_timestamp.missing}`}</p>}
      <table className="ex__table"><thead><tr><th scope="col">Recipient</th><th scope="col">Status</th><th scope="col">Verified</th><th scope="col">Signed</th></tr></thead>
        <tbody>{detail.recipients.map((r) => <tr key={r.id}><td>{r.name}{r.title ? `, ${r.title}` : ''}<br /><small>{r.email} · {r.role === 'cc' ? 'copy' : r.party ? `for ${r.party}` : `signer ${r.routing_order}`}{r.verify_by !== 'email' ? ` · ${r.verify_by === 'sms' ? 'text code' : 'email + text codes'}` : ''}{r.register_match ? ` · ${r.register_match.officer ? `listed as ${r.register_match.officer.role}` : 'not listed at the register'}` : ''}</small></td><td>{r.status === 'not_needed' ? 'not needed' : r.status}{r.decline_reason ? `: ${r.decline_reason}` : ''}</td><td>{day(r.verified_at)}</td><td>{day(r.signed_at)}</td></tr>)}</tbody></table>
      <div className="pp2__roleEdit">
        {detail.envelope.status === 'completed' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(async () => { const blob = new Blob([await pdfOf(detail.envelope.id)], { type: 'application/pdf' }); const url = URL.createObjectURL(blob); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000); })}>Open the signed copy</button>}
        {detail.envelope.status === 'sent' && <button type="button" className="cs__btn" disabled={busy} onClick={() => void act(async () => { const r = await postJson<{ reminded: number }>(`/api/sign/envelopes/${detail.envelope.id}/remind`, {}); return `Reminded ${r.reminded} signer(s).`; })}>Remind now</button>}
        {['draft', 'sent'].includes(detail.envelope.status) && <button type="button" className="cs__btn" disabled={busy} onClick={() => { setNote(null); const why = voidWhy.trim(); if (!why) { setNote('Type why you are cancelling in the box, then press Cancel envelope.'); return; } void act(async () => { await postJson(`/api/sign/envelopes/${detail.envelope.id}/void`, { reason: why }); await open(detail.envelope.id, 'detail'); return 'Cancelled. Signers who were asked have been told.'; }); }}>Cancel envelope</button>}
        {['draft', 'sent'].includes(detail.envelope.status) && <input id="ps-void" aria-label="Why cancel" className="cs__input" placeholder="Why cancel?" style={{ maxWidth: 260 }} value={voidWhy} onChange={(e) => setVoidWhy(e.target.value)} />}
        <button type="button" className="cs__btn" onClick={() => { go('list'); setDetail(null); setPdf(null); if (onClose && startContract) onClose(); }}>Back</button>
      </div>
      <p className="ig__muted"><small>{detail.events.map((e) => `${day(e.occurred_at)} ${e.kind.replace(/_/g, ' ')}${e.recipient ? ` (${e.recipient})` : ''}`).join(' · ')}</small></p>
    </>}
  </div></div>;
}
