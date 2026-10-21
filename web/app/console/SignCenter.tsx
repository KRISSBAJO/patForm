'use client';

/*
 * Patform Sign, the sender's side.
 *
 * Dashboard: what is out, what waits for you, what expires soon. Waiting
 * for me: sign from here. Envelopes: every document with who has signed,
 * reminders, the sealed copy. Send: document → signers → boxes → send,
 * with saved signer sets. Verify: drop a PDF and know if it is genuine.
 */
import './meetings.css';
import './sign-center.css';
import { useCallback, useEffect, useState } from 'react';
import { postJson } from './stepup';
import { EmptyState, ShellSync, type ModuleShell } from './module-shell';
import { Illustration } from './illustrations';
import { PdfPages, PageBox } from '../../components/pdf-pages';

type Envelope = { id: string; number: number; title: string; status: string; routing: string; created_at: string; sent_at: string | null; completed_at: string | null; expires_at: string; final_sha256: string | null; contract: string | null; signers: number; signed: number; people: { name: string; status: string; order: number }[]; sender: string | null };
type Recipient = { id: string; name: string; email: string; role: string; routing_order: number; status: string; party_id: string | null; party: string | null; title: string | null; verify_by: string; register_match: { officer?: { role: string } } | null; notified_at: string | null; viewed_at: string | null; verified_at: string | null; consented_at: string | null; signed_at: string | null; declined_at: string | null; decline_reason: string | null; last_reminded_at: string | null };
type Field = { id?: string; recipient_id: string | null; party_id?: string | null; slot?: number | null; kind: Kind; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string | null };
type Register = { available: boolean; reason?: string; country: string; number: string; companyName?: string; status?: string; source?: string; checkedAt: string };
type Party = { id: string; name: string; required_count: number; signed: number; authority_note: string | null; completed_at: string | null; register: Register | null; register_required: boolean };
type Detail = { envelope: Envelope & { page_count: number; original_sha256: string; void_reason: string | null; seal: { subject: string; selfIssued: boolean } | null; seal_timestamp: { time?: string; authority?: string; missing?: string } | null }; recipients: Recipient[]; fields: Field[]; events: { kind: string; detail: Record<string, unknown>; occurred_at: string; recipient: string | null }[]; parties: Party[] };
type Kind = 'signature' | 'initials' | 'date' | 'name' | 'text' | 'title';
type Row = { name: string; email: string; role: 'signer' | 'cc'; order: number; party: string; title: string; phone: string; verifyBy: 'email' | 'sms' | 'email_and_sms' };
type Mine = { envelopeId: string; number: number; title: string; sentAt: string; expiresAt: string; workspace: string; sender: string | null; status: string; url: string | null };
type Summary = { out: number; drafts: number; finalizing: number; done30: number; expiring: number; declined: number; waitingForMe: number; certificateSeal: boolean; selfIssuedSeal: boolean };
type Template = { id: string; name: string; recipients: Row[]; parties: unknown[]; routing: string; message: string | null; expires_in_days: number; created_by: string | null };
type Mode = 'list' | 'compose' | 'place' | 'detail' | 'verify' | 'overview' | 'mine' | 'templates';
const blank = (order: number): Row => ({ name: '', email: '', role: 'signer', order, party: '', title: '', phone: '', verifyBy: 'email' });
const SIZE: Record<Kind, [number, number]> = { signature: [0.26, 0.06], initials: [0.1, 0.05], date: [0.16, 0.03], name: [0.26, 0.03], text: [0.26, 0.03], title: [0.26, 0.03] };
const COLORS = ['#1f6feb', '#b26b00', '#8250df', '#1a7f37', '#cf222e', '#0969da'];
const day = (v: string | null | undefined) => (v ? new Date(v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const initials = (n: string) => n.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
const STATUS: Record<string, string> = { draft: 'Draft', sent: 'Out for signature', finalizing: 'Preparing final copy', completed: 'Completed', declined: 'Declined', voided: 'Cancelled', expired: 'Expired', viewed: 'Viewed', signed: 'Signed', waiting: 'Waiting', not_needed: 'Not needed' };
const st = (s: string) => STATUS[s] ?? s;
const pillOf = (s: string) => ({ draft: 'draft', sent: 'open', finalizing: 'called', completed: 'passed', declined: 'failed', voided: 'cancelled', expired: 'cancelled', signed: 'passed', viewed: 'called', waiting: 'draft', not_needed: 'withdrawn' }[s] ?? 'draft');
const Pill = ({ s }: { s: string }) => <span className={`mx__pill mx__pill--${pillOf(s)}`}><i />{st(s)}</span>;
const daysLeft = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);

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
const Field = ({ label, children, wide, id }: { label: string; children: React.ReactNode; wide?: boolean; id?: string }) => <div className={`mx__field ${wide ? 'mx__field--wide' : ''}`}><label htmlFor={id}>{label}</label>{children}</div>;

function Progress({ signed, total }: { signed: number; total: number }) {
  return <div className="mx__voteBar" style={{ height: 6, width: 120 }} aria-label={`${signed} of ${total} signed`}><span className="is-for" style={{ width: `${total ? (signed / total) * 100 : 0}%` }} /></div>;
}
function People({ people }: { people: { name: string; status: string }[] }) {
  return <div className="mx__avatars">{people.map((p, i) => <span key={i} className={`mx__avatar ${p.status === 'signed' ? 'mx__avatar--on' : ''}`} title={`${p.name} · ${st(p.status)}`} style={p.status === 'declined' ? { background: '#b0463f', color: '#fff' } : undefined}>{initials(p.name)}</span>)}</div>;
}

/* ------------------------------------------------------------------ verify */
function Verify() {
  const [result, setResult] = useState<{ valid: boolean; sha256: string; note?: string; title?: string; workspace?: string; envelope?: string; completedAt?: string; signers?: { name: string; signed_at: string; party?: string | null; title?: string | null }[]; seal?: { intact?: boolean; signer?: string; signedAt?: string; timestamp?: { time?: string; authority?: string } | null } | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const check = async (file: File) => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const buf = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      let bin = ''; const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const res = await fetch('/api/sign/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256, base64: btoa(bin) }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
      setResult(body);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div className="mx__grid" style={{ marginTop: 0 }}>
    <div className="mx__card"><div className="mx__cardHead"><h3>Verify a signed copy</h3><small>Nothing is uploaded until you choose a file; the fingerprint is computed in your browser.</small></div>
      <div className="mx__cardBody">
        <label className="mx__drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void check(f); }}>
          <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void check(f); e.target.value = ''; }} />
          <strong>{busy ? 'Checking…' : 'Drop a PDF here, or click to choose'}</strong><small>Works for any copy, however it reached you.</small>
        </label>
        {err && <p className="mx__notice mx__notice--err" style={{ marginTop: 12 }}>{err}</p>}
        {result && <div className={`mx__verdict ${result.valid ? 'is-ok' : 'is-bad'}`}>
          <strong>{result.valid ? 'Genuine' : 'Not a match'}</strong>
          <p>{result.valid ? `${result.title} · ${result.envelope} · ${result.workspace} · completed ${day(result.completedAt)}` : result.note}</p>
          {result.valid && result.signers && <ul className="mx__list" style={{ marginTop: 8 }}>{result.signers.map((s, i) => <li key={i}><span className="mx__avatar mx__avatar--on" style={{ marginLeft: 0 }}>{initials(s.name)}</span><div className="mx__main"><strong>{s.name}{s.title ? `, ${s.title}` : ''}</strong><small>{s.party ? `for ${s.party} · ` : ''}signed {day(s.signed_at)}</small></div></li>)}</ul>}
          {result.seal && <p className="mx__tiny" style={{ marginTop: 8 }}>{result.seal.intact ? `Digital seal intact${result.seal.signer ? ` · ${result.seal.signer}` : ''}${result.seal.timestamp?.time ? ` · time-stamped ${day(result.seal.timestamp.time)} by ${result.seal.timestamp.authority}` : ''}` : 'No intact digital seal in this file'}</p>}
          <p className="mx__tiny" style={{ wordBreak: 'break-all', marginTop: 6 }}>SHA-256 {result.sha256}</p>
        </div>}
      </div>
    </div>
    <div className="mx__card"><div className="mx__cardHead"><h3>What is checked</h3></div><div className="mx__cardBody"><ol className="mx__howto">
      <li><strong>Fingerprint.</strong> The file's SHA-256 must equal the one recorded when the envelope completed. One changed byte, no match.</li>
      <li><strong>Seal.</strong> The certificate seal inside the PDF is opened and must cover the whole file.</li>
      <li><strong>Time stamp.</strong> Where a timestamping authority signed the seal, its time is read from the file, not from us.</li>
    </ol><p className="mx__tiny" style={{ marginTop: 10 }}>Anyone can do this without an account at <a className="mx__link" href="/sign/verify" target="_blank" rel="noreferrer">/sign/verify</a>.</p></div></div>
  </div>;
}

/* ------------------------------------------------------------------- main */
export function SignCenter({ startContract, onClose, shell }: { startContract?: { id: string; title: string } | null; onClose?: () => void; shell?: ModuleShell }) {
  const [list, setList] = useState<Envelope[] | null>(null);
  const [mine, setMine] = useState<Mine[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [mode, setMode] = useState<Mode>(startContract ? 'compose' : shell ? 'overview' : 'list');
  const sectionOf = (m: Mode) => (m === 'verify' ? 'verify' : m === 'compose' || m === 'place' ? 'send' : m === 'overview' ? 'overview' : m === 'mine' ? 'mine' : m === 'templates' ? 'templates' : 'envelopes');
  const go = (m: Mode) => { setMode(m); shell?.onSection?.(sectionOf(m)); };
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
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
  const [previewPdf, setPreviewPdf] = useState<ArrayBuffer | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [current, setCurrent] = useState<{ recipient: string; kind: Kind }>({ recipient: '', kind: 'signature' });
  const [textLabel, setTextLabel] = useState('');
  const [voidWhy, setVoidWhy] = useState('');
  const [filter, setFilter] = useState<'all' | 'sent' | 'draft' | 'finalizing' | 'completed' | 'declined' | 'other'>('all');
  const [q, setQ] = useState('');
  const [tplName, setTplName] = useState('');
  const [composeStep, setComposeStep] = useState<0 | 1>(0);

  const loadAll = useCallback(async () => {
    try {
      const [l, m, s, t] = await Promise.all([get<Envelope[]>('/api/sign/envelopes'), get<Mine[]>('/api/sign/mine').catch(() => []), get<Summary>('/api/sign/summary').catch(() => null), get<Template[]>('/api/sign/templates').catch(() => [])]);
      setList(l); setMine(m); setSummary(s); setTemplates(t);
    } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); }
  }, []);
  useEffect(() => { void loadAll(); }, [loadAll]);
  useEffect(() => {
    const want = shell?.section;
    if (!want || want === sectionOf(mode)) return;
    if (want === 'envelopes') { setMode('list'); setDetail(null); setPdf(null); }
    else if (want === 'send') { setMode('compose'); setComposeStep(0); setTitle(''); setDocRef(null); setPreviewPdf(null); setRows([blank(1)]); setPartyRules({}); }
    else if (want === 'verify') setMode('verify');
    else if (want === 'overview') setMode('overview');
    else if (want === 'mine') setMode('mine');
    else if (want === 'templates') setMode('templates');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell?.section]);
  const sections = [
    { id: 'overview', name: 'Dashboard', count: null },
    { id: 'mine', name: 'Waiting for me', count: mine.length || null },
    { id: 'envelopes', name: 'Envelopes', count: (list ?? []).filter((e) => e.status === 'sent').length || null },
    { id: 'send', name: 'Send a document', count: null },
    { id: 'templates', name: 'Signer sets', count: templates.length || null },
    { id: 'verify', name: 'Verify a copy', count: null },
  ];

  const open = async (id: string, next: 'place' | 'detail') => {
    const d = await get<Detail>(`/api/sign/envelopes/${id}`);
    setDetail(d); setFields(d.fields); setPdf(await pdfOf(id));
    const firstPerson = d.recipients.find((r) => r.role === 'signer' && !r.party_id);
    setCurrent({ recipient: firstPerson ? `r:${firstPerson.id}` : d.parties[0] ? `p:${d.parties[0].id}:1` : '', kind: 'signature' });
    go(next);
  };
  const act = async (work: () => Promise<string | void>) => { setBusy(true); setNote(null); try { const m = await work(); if (m) setNote({ text: m }); await loadAll(); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } finally { setBusy(false); } };
  const uploadDocument = (file: File) => void act(async () => {
    if (!/\.pdf$/i.test(file.name) || file.type && file.type !== 'application/pdf') throw new Error('Choose a PDF document.');
    if (file.size > 20 * 1024 * 1024) throw new Error('The PDF must be 20 MB or smaller.');
    const r = await postJson<{ reference: string; filename: string }>('/api/gov/files', { purpose: 'signing', filename: file.name, base64: await readBase64(file) });
    setDocRef({ ref: r.reference, name: r.filename });
    setPreviewPdf(await file.arrayBuffer());
    if (!title) setTitle(file.name.replace(/\.pdf$/i, ''));
    return 'Uploaded. The document must pass its malware check before it can be sent.';
  });
  const signers = (detail?.recipients ?? []).filter((r) => r.role === 'signer');
  const owners = [
    ...signers.filter((s) => !s.party_id).map((s) => ({ key: `r:${s.id}`, label: s.name })),
    ...(detail?.parties ?? []).flatMap((p) => Array.from({ length: p.required_count }, (_, i) => ({ key: `p:${p.id}:${i + 1}`, label: `${p.name} — signatory ${i + 1}` }))),
  ];
  const keyOf = (f: Field) => f.party_id ? `p:${f.party_id}:${f.slot}` : `r:${f.recipient_id}`;
  const color = (key: string) => COLORS[Math.max(0, owners.findIndex((o) => o.key === key)) % COLORS.length]!;
  const toBody = (f: Field) => ({ ...(f.party_id ? { partyId: f.party_id, slot: f.slot } : { recipientId: f.recipient_id }), kind: f.kind, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label });
  const companies = [...new Set(rows.filter((r) => r.role === 'signer' && r.party.trim()).map((r) => r.party.trim()))];
  const setRow = (i: number, patch: Partial<Row>) => setRows((x) => x.map((y, j) => (j === i ? { ...y, ...patch } : y)));
  const startCompose = () => { setTitle(''); setDocRef(null); setPreviewPdf(null); setRows([blank(1)]); setPartyRules({}); setMessage(''); setComposeStep(0); go('compose'); };
  const applyTemplate = (t: Template) => { setRows(t.recipients.map((r, i) => ({ ...blank(i + 1), ...r }))); setRouting(t.routing === 'parallel' ? 'parallel' : 'sequential'); setDays(String(t.expires_in_days)); if (t.message) setMessage(t.message); const rules: typeof partyRules = {}; for (const p of t.parties as { name: string; required?: number; authorityNote?: string; register?: { country: string; number: string }; requireRegistered?: boolean }[]) rules[p.name] = { required: String(p.required ?? 1), note: p.authorityNote ?? '', country: p.register?.country ?? 'GB', number: p.register?.number ?? '', strict: Boolean(p.requireRegistered) }; setPartyRules(rules); setComposeStep(1); go('compose'); setNote({ text: `Signer set "${t.name}" loaded. Add the document and send.` }); };
  const filtered = (list ?? []).filter((e) => (filter === 'all' || (filter === 'other' ? ['voided', 'expired'].includes(e.status) : e.status === filter)) && (!q.trim() || `${e.title} PS-${e.number} ${e.people.map((p) => p.name).join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  const expiring = (list ?? []).filter((e) => e.status === 'sent' && daysLeft(e.expires_at) <= 7);
  const recent = (list ?? []).filter((e) => e.status === 'completed').slice(0, 5);

  const envRow = (e: Envelope) => <li key={e.id}>
    <People people={e.people} />
    <div className="mx__main"><strong>PS-{e.number} · {e.title}</strong><small>{e.contract ? `Contract: ${e.contract} · ` : ''}{e.sender ? `from ${e.sender} · ` : ''}{e.routing === 'parallel' ? 'all at once' : 'in order'} · {e.sent_at ? `sent ${day(e.sent_at)}` : `created ${day(e.created_at)}`}{e.completed_at ? ` · completed ${day(e.completed_at)}` : e.status === 'sent' ? ` · ${daysLeft(e.expires_at)} day${daysLeft(e.expires_at) === 1 ? '' : 's'} left` : ''}</small></div>
    {e.status === 'sent' && <div style={{ display: 'grid', gap: 4, justifyItems: 'end' }}><Progress signed={e.signed} total={e.signers} /><span className="mx__tiny">{e.signed} of {e.signers} signed</span></div>}
    <Pill s={e.status} />
    {e.status === 'sent' && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy} onClick={() => void act(async () => { const r = await postJson<{ reminded: number }>(`/api/sign/envelopes/${e.id}/remind`, {}); return `Reminded ${r.reminded} signer(s).`; })}>Remind</button>}
    <button type="button" className={`mx__btn mx__btn--sm ${e.status === 'draft' ? '' : 'mx__btn--ghost'}`} onClick={() => void act(() => open(e.id, e.status === 'draft' ? 'place' : 'detail'))}>{e.status === 'draft' ? 'Continue' : 'Open'}</button>
  </li>;
  const mineRow = (m: Mine) => <li key={m.envelopeId}>
    <Illustration name="sign" size={40} />
    <div className="mx__main"><strong>PS-{m.number} · {m.title}</strong><small>{m.sender ? `from ${m.sender} · ` : ''}{m.workspace} · sent {day(m.sentAt)} · {daysLeft(m.expiresAt)} day{daysLeft(m.expiresAt) === 1 ? '' : 's'} left</small></div>
    {m.url ? <a className="mx__btn mx__btn--sm" href={m.url} target="_blank" rel="noreferrer">Sign now</a> : <span className="mx__tiny">Use the link in your email</span>}
  </li>;
  const empty = (t: string, s: string, action?: { label: string; onClick: () => void; secondary?: boolean }, icon?: 'inbox' | 'send' | 'vote' | 'check' | 'people' | 'search' | 'register') => <li><EmptyState icon={icon} title={t} text={s} action={action} /></li>;

  return <div className="mx">
    <ShellSync sections={sections} onSections={shell?.onSections} />
    {!shell && <div className="mx__segs" style={{ marginBottom: 14 }}>{sections.map((s) => <button key={s.id} type="button" className={`mx__seg ${sectionOf(mode) === s.id ? 'is-on' : ''}`} onClick={() => { const m: Mode = s.id === 'envelopes' ? 'list' : s.id === 'send' ? 'compose' : (s.id as Mode); go(m); }}>{s.name}{s.count ? ` · ${s.count}` : ''}</button>)}</div>}
    {note && <p className={`mx__notice ${note.err ? 'mx__notice--err' : ''}`} role="status">{note.text}</p>}

    {mode === 'overview' && <div className="sc__dashboard">
      <section className="sc__hero">
        <div className="sc__heroCopy">
          <span className="sc__eyebrow">PAT FORM / SIGNATURE WORKSPACE</span>
          <h2>{mine.length ? 'Your signature is needed.' : summary?.out ? 'Keep every signature moving.' : 'Make it official.'}</h2>
          <p>{mine.length ? `${mine.length} document${mine.length === 1 ? '' : 's'} waiting for you. Review the details before you sign.` : summary?.out ? 'Follow each document from the first invitation to the finished copy.' : 'Prepare a document, invite the right people and follow every decision in one place.'}</p>
          <div className="sc__heroActions">
            <button type="button" className="mx__btn" onClick={startCompose}>Send a document <span aria-hidden="true">↗</span></button>
            {mine.length > 0 && <button type="button" className="mx__btn mx__btn--ghost" onClick={() => go('mine')}>Review mine ({mine.length})</button>}
          </div>
        </div>
        <div className="sc__heroVisual" aria-hidden="true">
          <div className="sc__visualSpine" />
          <div className="sc__visualPage"><span className="sc__visualMark">P.</span><i /><i /><i /><div className="sc__visualSignature">signed</div><span className="sc__visualStamp">✓</span></div>
          <div className="sc__visualLabel">PREPARE <span>→</span> SIGN <span>→</span> VERIFY</div>
        </div>
      </section>
      <section className="sc__metrics" aria-label="Signature activity">
        <button type="button" onClick={() => { setFilter('sent'); go('list'); }}><span>OUT FOR SIGNATURE</span><strong>{summary?.out ?? '–'}</strong><small>Track people and reminders ↗</small></button>
        <button type="button" onClick={() => { setFilter('draft'); go('list'); }}><span>DRAFTS</span><strong>{summary?.drafts ?? '–'}</strong><small>Finish preparing ↗</small></button>
        <button type="button" onClick={() => { setFilter('completed'); go('list'); }}><span>COMPLETED · 30 DAYS</span><strong>{summary?.done30 ?? '–'}</strong><small>Download and verify ↗</small></button>
        <button type="button" onClick={() => { setFilter('finalizing'); go('list'); }}><span>PREPARING FINAL COPY</span><strong>{summary?.finalizing ?? '–'}</strong><small>Finishing in the background ↗</small></button>
      </section>
      <nav className="sc__tools" aria-label="Signing tools">
        <button type="button" onClick={() => go('mine')}><Illustration name="sign" size={34} /><span><strong>Waiting for me</strong><small>{mine.length} to sign</small></span><b aria-hidden="true">↗</b></button>
        <button type="button" onClick={() => go('templates')}><Illustration name="templates" size={34} /><span><strong>Signer sets</strong><small>Use a familiar group</small></span><b aria-hidden="true">↗</b></button>
        <button type="button" onClick={() => go('verify')}><Illustration name="verify" size={34} /><span><strong>Verify a copy</strong><small>Check its fingerprint</small></span><b aria-hidden="true">↗</b></button>
      </nav>
      <div className="mx__grid">
        <div className="mx__stack">
          {mine.length > 0 && <div className="mx__card"><div className="mx__cardHead"><h3>Waiting for your signature</h3></div><ul className="mx__list" style={{ marginTop: 10 }}>{mine.map(mineRow)}</ul></div>}
          {expiring.length > 0 && <div className="mx__card"><div className="mx__cardHead"><h3>Expiring soon</h3><small>remind or extend before they lapse</small></div><ul className="mx__list" style={{ marginTop: 10 }}>{expiring.map(envRow)}</ul></div>}
          <div className="mx__card"><div className="mx__cardHead"><h3>Out for signature</h3><small>{(list ?? []).filter((e) => e.status === 'sent').length}</small></div><ul className="mx__list" style={{ marginTop: 10 }}>{(list ?? []).filter((e) => e.status === 'sent').slice(0, 6).map(envRow)}{list && !list.some((e) => e.status === 'sent') && empty('Nothing out right now', 'Send a document; every signer, reminder and seal shows here as it happens.', { label: '+ Send a document', onClick: startCompose }, 'send')}</ul></div>
        </div>
        <div className="mx__stack">
          <div className="mx__card"><div className="mx__cardHead"><h3>Recently completed</h3></div><ul className="mx__list" style={{ marginTop: 10 }}>{recent.map(envRow)}{list && !recent.length && empty('No completed documents yet', 'When everyone has signed, the final copy and its fingerprint appear here.', undefined, 'register')}</ul></div>
          <div className="mx__card"><div className="mx__cardHead"><h3>How it works</h3></div><div className="mx__cardBody"><ol className="mx__howto"><li><strong>Place the boxes.</strong> Signers in order or at once; a company can sign through any two of three directors.</li><li><strong>They prove it is them.</strong> A one-time code by email or text, then consent in words that are kept.</li><li><strong>Check the copy.</strong> Every finished PDF has a certificate page and fingerprint. {summary?.certificateSeal ? 'A PDF certificate seal is configured for this deployment.' : 'A PDF certificate seal has not been configured for this deployment.'}</li></ol></div></div>
        </div>
      </div>
    </div>}

    {mode === 'mine' && <div className="mx__card"><div className="mx__cardHead"><h3>Waiting for your signature</h3><small>Your personal links, same as in your email</small></div><ul className="mx__list" style={{ marginTop: 10 }}>{mine.map(mineRow)}{!mine.length && empty('Nothing waiting for you', 'When someone sends you a document to sign, it appears here with a Sign now button — the same link as in your email.', undefined, 'vote')}</ul></div>}

    {mode === 'list' && <div className="mx__card">
      <div className="mx__cardHead"><h3>Envelopes</h3><div className="mx__voteBtns" style={{ marginTop: 0 }}><input className="mx__input" style={{ height: 36, width: 220 }} placeholder="Search title, number, signer" value={q} onChange={(e) => setQ(e.target.value)} /><button type="button" className="mx__btn mx__btn--sm" onClick={startCompose}>+ Send a document</button>{onClose && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={onClose}>Close</button>}</div></div>
      <div className="mx__segs" style={{ padding: '12px 20px 4px' }}>{([['all', 'All'], ['sent', 'Out'], ['draft', 'Drafts'], ['finalizing', 'Preparing'], ['completed', 'Completed'], ['declined', 'Declined'], ['other', 'Cancelled / expired']] as const).map(([k, v]) => <button key={k} type="button" className={`mx__seg ${filter === k ? 'is-on' : ''}`} onClick={() => setFilter(k)}>{v}</button>)}</div>
      <ul className="mx__list" style={{ marginTop: 6 }}>{filtered.map(envRow)}{list && !filtered.length && empty(q ? 'No match' : 'Nothing sent for signature yet', q ? 'No envelope matches that search. Try a signer\'s name or the PS number.' : 'Upload a PDF, add the signers, place their boxes and send. They sign from a link; you follow it here.', q ? undefined : { label: '+ Send a document', onClick: startCompose }, q ? 'search' : 'send')}</ul>
    </div>}

    {mode === 'templates' && <div className="mx__card">
      <div className="mx__cardHead"><h3>Signer sets</h3><small>Save the people who sign a recurring document; load them in one click when sending.</small></div>
      <ul className="mx__list" style={{ marginTop: 10 }}>{templates.map((t) => <li key={t.id}><People people={t.recipients.filter((r) => r.role === 'signer').map((r) => ({ name: r.name, status: 'waiting' }))} /><div className="mx__main"><strong>{t.name}</strong><small>{t.recipients.length} recipient{t.recipients.length === 1 ? '' : 's'} · {t.routing === 'parallel' ? 'all at once' : 'in order'} · expires after {t.expires_in_days} days{t.created_by ? ` · by ${t.created_by}` : ''}</small></div><button type="button" className="mx__btn mx__btn--sm" onClick={() => applyTemplate(t)}>Use</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy} onClick={() => void act(async () => { await postJson(`/api/sign/templates/${t.id}/delete`, {}); return 'Signer set removed.'; })}>Remove</button></li>)}{!templates.length && empty('No signer sets yet', 'Save the people who sign a recurring document once; next time, load them in one click.', { label: 'Send a document and save its signers', onClick: startCompose, secondary: true }, 'people')}</ul>
    </div>}

    {mode === 'verify' && <Verify />}

    {mode === 'compose' && <div className="mx__wizard sc__wizard">
      <div className="mx__steps">{['Document', 'Signers', 'Place & send'].map((s, i) => <div key={s} className={`mx__step ${i === composeStep ? 'is-on' : ''} ${i < composeStep ? 'is-done' : ''}`}><i>{i < composeStep ? '✓' : i + 1}</i>{s}</div>)}</div>
      <div className="mx__wizBody">
        {composeStep === 0 && <div className="sc__prepare">
          <header className="sc__intro"><span className="sc__eyebrow">01 / PREPARE</span><h2>Start with the document.</h2><p>Preview the PDF, set the context, then choose who needs to sign.</p></header>
          <div className="sc__prepareGrid">
            <section className="sc__documentPane" aria-label="Document preview">
              <div className="sc__paneHead"><span>DOCUMENT</span><span>{docRef ? 'Ready to prepare' : 'PDF · UP TO 20 MB'}</span></div>
              {startContract ? <div className="sc__contract"><Illustration name="sign" size={64} /><strong>{startContract.title}</strong><span>The current approved contract version will be signed.</span></div>
                : <>
                  <label className={`sc__upload ${docRef ? 'is-set' : ''}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files?.[0]; if (file) uploadDocument(file); }}>
                    <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) uploadDocument(file); e.target.value = ''; }} />
                    <span className="sc__uploadIcon" aria-hidden="true">↥</span><strong>{docRef ? docRef.name : 'Choose a PDF or drop it here'}</strong><small>{docRef ? 'Choose another document' : 'We check every document before it goes out.'}</small>
                  </label>
                  {previewPdf && <div className="sc__preview"><PdfPages data={previewPdf} maxWidth={500} /></div>}
                </>}
            </section>
            <section className="sc__detailsPane" aria-label="Envelope details">
              <div className="sc__paneHead"><span>DETAILS</span><span>PRIVATE DRAFT</span></div>
              <div className="sc__detailsContent">
                <Field label="Document title" id="sc-title"><input id="sc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Supply agreement with Acme" maxLength={200} /></Field>
                <Field label="Message to signers" id="sc-message"><textarea id="sc-message" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Add a short note about what you need them to sign" /></Field>
                <div className="sc__detailRule" />
                <Field label="Signing order"><div className="mx__segs"><button type="button" className={`mx__seg ${routing === 'sequential' ? 'is-on' : ''}`} onClick={() => setRouting('sequential')}>In order</button><button type="button" className={`mx__seg ${routing === 'parallel' ? 'is-on' : ''}`} onClick={() => setRouting('parallel')}>All at once</button></div></Field>
                <Field label="Expires after" id="sc-days"><div className="sc__days"><input id="sc-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} /><span>days</span></div></Field>
                {templates.length > 0 && <Field label="Use a signer set"><div className="mx__segs">{templates.map((t) => <button key={t.id} type="button" className="mx__seg" onClick={() => applyTemplate(t)}>{t.name}</button>)}</div></Field>}
                <p className="sc__helper">Signers receive a personal link. You will place their signature fields before sending.</p>
              </div>
            </section>
          </div>
        </div>}
        {composeStep === 1 && <div className="sc__signers">
          <div className="sc__recipientIntro"><span className="sc__eyebrow">02 / RECIPIENTS</span><h2>Who needs to sign?</h2><p>Add each person and choose how they confirm their identity.</p></div>
          <div className="sc__recipientList">
            {rows.map((r, i) => <section key={i} className="sc__recipient">
              <div className="sc__recipientHead"><span className="sc__recipientNo">{String(i + 1).padStart(2, '0')}</span><strong>{r.name || (r.role === 'cc' ? 'Copy recipient' : `Signer ${i + 1}`)}</strong><select aria-label={`Role for recipient ${i + 1}`} className="mx__input" value={r.role} onChange={(e) => setRow(i, { role: e.target.value as Row['role'] })}><option value="signer">Needs to sign</option><option value="cc">Gets a copy</option></select><button type="button" className="sc__remove" aria-label={`Remove recipient ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>Remove</button></div>
              <div className="sc__recipientFields">
                <Field label="Full name" id={`sc-name-${i}`}><input id={`sc-name-${i}`} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} autoComplete="name" placeholder="Name as it should appear" /></Field>
                <Field label="Email address" id={`sc-email-${i}`}><input id={`sc-email-${i}`} type="email" value={r.email} onChange={(e) => setRow(i, { email: e.target.value })} autoComplete="email" placeholder="name@company.com" /></Field>
                {r.role === 'signer' && <>
                  <Field label="Company · optional" id={`sc-party-${i}`}><input id={`sc-party-${i}`} value={r.party} onChange={(e) => setRow(i, { party: e.target.value })} placeholder="Company they represent" /></Field>
                  <Field label="Job title · optional" id={`sc-job-${i}`}><input id={`sc-job-${i}`} value={r.title} onChange={(e) => setRow(i, { title: e.target.value })} placeholder="e.g. Director" /></Field>
                  <Field label="Identity check" id={`sc-check-${i}`}><select id={`sc-check-${i}`} value={r.verifyBy} onChange={(e) => setRow(i, { verifyBy: e.target.value as Row['verifyBy'] })}><option value="email">Code by email</option><option value="sms">Code by text</option><option value="email_and_sms">Code by email and text</option></select></Field>
                  {r.verifyBy !== 'email' && <Field label="Mobile number" id={`sc-phone-${i}`}><input id={`sc-phone-${i}`} type="tel" value={r.phone} onChange={(e) => setRow(i, { phone: e.target.value })} placeholder="+2348012345678" /></Field>}
                  {routing === 'sequential' && <Field label="Signing position" id={`sc-order-${i}`}><input id={`sc-order-${i}`} type="number" min={1} value={r.order} onChange={(e) => setRow(i, { order: Number(e.target.value) || 1 })} /></Field>}
                </>}
              </div>
            </section>)}
          </div>
          <div className="mx__voteBtns"><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setRows((x) => [...x, blank(x.length + 1)])}>+ Add a signer</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setRows((x) => [...x, { ...blank(x.length + 1), role: 'cc' }])}>+ Add someone who gets a copy</button></div>
          {companies.map((c) => { const members = rows.filter((x) => x.role === 'signer' && x.party.trim() === c).length; return <div key={c} className="mx__reviewBox" style={{ marginTop: 14 }}><h4>{c} signs as a company</h4><div className="mx__form">
            <Field label={`Signatures needed (of ${members})`}><input type="number" min={1} max={members} value={rule(c).required} onChange={(e) => setRule(c, { required: e.target.value })} /></Field>
            <Field label="Authority (e.g. board resolution reference)"><input value={rule(c).note} onChange={(e) => setRule(c, { note: e.target.value })} /></Field>
            <Field label="Register"><select value={rule(c).country} onChange={(e) => setRule(c, { country: e.target.value })}><option value="GB">UK Companies House</option><option value="NG">Nigeria CAC</option></select></Field>
            <Field label="Company number (optional)"><input placeholder={rule(c).country === 'NG' ? 'RC123456' : '12345678'} value={rule(c).number} onChange={(e) => setRule(c, { number: e.target.value })} /></Field>
            {rule(c).number.trim() && <label className="mx__tiny mx__field--wide" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={rule(c).strict} onChange={(e) => setRule(c, { strict: e.target.checked })} /> Only officers listed at the register may sign</label>}
          </div></div>; })}
          <div className="mx__reviewBox" style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}><span className="mx__tiny">Save these signers as a set:</span><input className="mx__input" style={{ height: 36, width: 220 }} placeholder="e.g. Board of Acme" value={tplName} onChange={(e) => setTplName(e.target.value)} /><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={!tplName.trim() || busy} onClick={() => void act(async () => { await postJson('/api/sign/templates', { name: tplName.trim(), recipients: rows.filter((x) => x.name || x.email).map((x) => ({ name: x.name, email: x.email, role: x.role, order: x.order, party: x.role === 'signer' ? x.party.trim() || undefined : undefined, title: x.title || undefined, phone: x.phone || undefined, verifyBy: x.verifyBy })), parties: companies.map((c) => ({ name: c, required: Number(rule(c).required || 1), authorityNote: rule(c).note || undefined, register: rule(c).number.trim() ? { country: rule(c).country, number: rule(c).number.trim() } : undefined, requireRegistered: rule(c).strict })), routing, message, expiresInDays: Number(days) }); setTplName(''); return 'Signer set saved.'; })}>Save set</button></div>
        </div>}
      </div>
      <div className="mx__wizFoot">
        <button type="button" className="mx__btn mx__btn--ghost" onClick={() => { if (composeStep === 1) setComposeStep(0); else if (onClose && startContract) onClose(); else go('overview'); }}>{composeStep === 1 ? '‹ Back' : 'Cancel'}</button>
        {composeStep === 0 && <button type="button" className="mx__btn" disabled={busy || !title.trim() || (!startContract && !docRef) || !Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 365} onClick={() => setComposeStep(1)}>Continue to signers →</button>}
        {composeStep === 1 && <button type="button" className="mx__btn" disabled={busy || !rows.some((r) => r.role === 'signer' && r.name && r.email)} onClick={() => void act(async () => {
          const r = await postJson<{ id: string; parties: { name: string; unlisted: string[]; register: Register | null }[] }>('/api/sign/envelopes', { ...(startContract ? { contractId: startContract.id } : { documentRef: docRef?.ref }), title, message, routing, expiresInDays: Number(days),
            recipients: rows.filter((x) => x.name || x.email).map((x) => ({ name: x.name, email: x.email, role: x.role, order: x.order, party: x.role === 'signer' ? x.party.trim() || undefined : undefined, title: x.title || undefined, phone: x.phone || undefined, verifyBy: x.verifyBy })),
            parties: companies.map((c) => ({ name: c, required: Number(rule(c).required || 1), order: rows.find((x) => x.party.trim() === c)?.order ?? 1, authorityNote: rule(c).note || undefined, register: rule(c).number.trim() ? { country: rule(c).country, number: rule(c).number.trim() } : undefined, requireRegistered: rule(c).strict })) });
          await open(r.id, 'place');
          const notes = r.parties.flatMap((p) => [
            ...(p.register && !p.register.available ? [`${p.name}: register check not available (${p.register.reason}).`] : []),
            ...(p.register?.available ? [`${p.name}: ${p.register.source} lists ${p.register.companyName} as ${p.register.status}.`] : []),
            ...(p.unlisted.length ? [`Not listed as officers of ${p.name}: ${p.unlisted.join(', ')} — they can still sign under the authority you recorded.`] : []),
          ]);
          return `Saved as a draft. Place the boxes each signer fills, then send.${notes.length ? ` ${notes.join(' ')}` : ''}`;
        })}>{busy ? 'Working…' : 'Next: place the boxes ›'}</button>}
      </div>
    </div>}

    {mode === 'place' && detail && pdf && <div className="mx__wizard">
      <div className="mx__steps">{['Document', 'Signers', 'Place & send'].map((s, i) => <div key={s} className={`mx__step ${i === 2 ? 'is-on' : 'is-done'}`}><i>{i < 2 ? '✓' : 3}</i>{s}</div>)}</div>
      <div className="mx__bar" style={{ borderTop: 0, position: 'sticky', top: 0, zIndex: 3 }}>
        <select className="mx__input" style={{ height: 38 }} value={current.recipient} onChange={(e) => setCurrent((c) => ({ ...c, recipient: e.target.value }))}>{owners.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
        <div className="mx__segs">{(['signature', 'initials', 'date', 'name', 'title', 'text'] as Kind[]).map((k) => <button key={k} type="button" className={`mx__seg ${current.kind === k ? 'is-on' : ''}`} onClick={() => setCurrent((c) => ({ ...c, kind: k }))}>{k === 'text' ? 'Text to fill' : k === 'date' ? 'Date signed' : k === 'name' ? 'Printed name' : k === 'title' ? 'Job title' : k[0]!.toUpperCase() + k.slice(1)}</button>)}</div>
        {current.kind === 'text' && <input className="mx__input" style={{ height: 38, width: 180 }} placeholder="Label, e.g. Company number" value={textLabel} onChange={(ev) => setTextLabel(ev.target.value)} />}
        <span className="mx__tiny">Click a page to place; click a box to remove. {fields.length} placed.</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy} onClick={() => void act(async () => { await postJson(`/api/sign/envelopes/${detail.envelope.id}/fields`, { fields: fields.map(toBody) }); return 'Boxes saved.'; })}>Save</button>
          <button type="button" className="mx__btn mx__btn--sm" disabled={busy} onClick={() => void act(async () => { await postJson(`/api/sign/envelopes/${detail.envelope.id}/fields`, { fields: fields.map(toBody) }); const r = await postJson<{ notified: number }>(`/api/sign/envelopes/${detail.envelope.id}/send`, {}); await open(detail.envelope.id, 'detail'); return `Sent. ${r.notified} signer(s) emailed.${owners.some((o) => !fields.some((f) => keyOf(f) === o.key && f.kind === 'signature')) ? ' Anyone without a signature box signs on an added signature page.' : ''}`; })}>Send for signature</button>
          <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { go('list'); setDetail(null); setPdf(null); }}>Later</button>
        </span>
      </div>
      <div className="mx__wizBody">
        <p className="mx__tiny" style={{ marginBottom: 10 }}>{owners.map((o) => <span key={o.key} style={{ color: color(o.key), marginRight: 12 }}>■ {o.label}</span>)}</p>
        <PdfPages data={pdf}
          onPageClick={(page, x, y) => { if (!current.recipient) return; const [w, h] = SIZE[current.kind]; const label = current.kind === 'text' ? (textLabel.trim() || 'Text') : null; const [kindOf, idOf, slotOf] = current.recipient.split(':'); const owner = kindOf === 'p' ? { recipient_id: null, party_id: idOf!, slot: Number(slotOf) } : { recipient_id: idOf!, party_id: null, slot: null }; setFields((f) => [...f, { ...owner, kind: current.kind, page, x: Math.max(0, Math.min(1 - w, x - w / 2)), y: Math.max(0, Math.min(1 - h, y - h / 2)), width: w, height: h, required: true, label }]); }}
          overlay={(page) => fields.map((f, i) => f.page === page && <PageBox key={i} x={f.x} y={f.y} width={f.width} height={f.height} color={color(keyOf(f))} title="Click to remove" onClick={() => setFields((all) => all.filter((_, j) => j !== i))}>{f.kind} · {owners.find((o) => o.key === keyOf(f))?.label.split(' ')[0]}{f.party_id ? ` ${f.slot}` : ''}</PageBox>)} />
      </div>
    </div>}

    {mode === 'detail' && detail && (() => { const e = detail.envelope; const flow = ['draft', 'sent', 'completed']; const at = e.status === 'completed' ? 2 : ['sent', 'finalizing'].includes(e.status) ? 1 : 0; return <div className="mx__room">
      <div className="mx__card">
        <div className="mx__roomHead"><div>
          <button type="button" className="mx__link" onClick={() => { go('list'); setDetail(null); setPdf(null); if (onClose && startContract) onClose(); }}>‹ All envelopes</button>
          <div className="mx__eyebrow" style={{ color: 'var(--mx-muted)', marginTop: 8 }}>PS-{e.number}{e.contract ? ` · contract: ${e.contract}` : ''}</div>
          <h2 className="mx__roomTitle">{e.title}</h2>
          <div className="mx__roomMeta"><Pill s={e.status} /><span>{e.routing === 'parallel' ? 'All at once' : 'In order'}</span>{e.sent_at && <span>· sent {day(e.sent_at)}</span>}<span>· expires {day(e.expires_at)}</span>{e.void_reason && <span>· {e.void_reason}</span>}</div>
        </div><div style={{ textAlign: 'right' }}><Progress signed={e.signed} total={e.signers} /><span className="mx__tiny">{e.signed} of {e.signers} signed</span></div></div>
        <div className="mx__flow">{flow.map((s, i) => <span key={s} className={i < at ? 'is-done' : i === at ? 'is-on' : ''}>{s === 'draft' ? 'Draft' : s === 'sent' ? 'Out for signature' : 'Completed'}</span>)}{['declined', 'voided', 'expired', 'finalizing'].includes(e.status) && <span className="is-on">{st(e.status)}</span>}</div>
        <div className="mx__bar">
          {e.status === 'completed' && <button type="button" className="mx__btn" onClick={() => void act(async () => { const blob = new Blob([await pdfOf(e.id)], { type: 'application/pdf' }); const url = URL.createObjectURL(blob); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000); })}>Open the sealed copy</button>}
          {e.status === 'sent' && <button type="button" className="mx__btn" disabled={busy} onClick={() => void act(async () => { const r = await postJson<{ reminded: number }>(`/api/sign/envelopes/${e.id}/remind`, {}); return `Reminded ${r.reminded} signer(s).`; })}>Remind now</button>}
          {e.status === 'draft' && <button type="button" className="mx__btn" onClick={() => void act(() => open(e.id, 'place'))}>Continue placing boxes</button>}
          {['draft', 'sent'].includes(e.status) && <><input className="mx__input" style={{ height: 38, width: 220 }} placeholder="Why cancel?" value={voidWhy} onChange={(ev) => setVoidWhy(ev.target.value)} /><button type="button" className="mx__btn mx__btn--danger mx__btn--sm" disabled={busy || !voidWhy.trim()} onClick={() => void act(async () => { await postJson(`/api/sign/envelopes/${e.id}/void`, { reason: voidWhy.trim() }); await open(e.id, 'detail'); return 'Cancelled. Signers who were asked have been told.'; })}>Cancel envelope</button></>}
          {e.final_sha256 && <span className="mx__tiny" style={{ wordBreak: 'break-all' }}>SHA-256 {e.final_sha256}{e.seal ? ` · sealed with ${e.seal.subject}${e.seal.selfIssued ? ' (self-issued)' : ''}` : ''}{e.seal_timestamp?.time ? ` · time-stamped ${day(e.seal_timestamp.time)} by ${e.seal_timestamp.authority}` : e.seal_timestamp?.missing ? ` · no trusted time stamp: ${e.seal_timestamp.missing}` : ''}</span>}
        </div>
      </div>
      <div className="mx__grid" style={{ marginTop: 0 }}>
        <div className="mx__card"><div className="mx__cardHead"><h3>Signers</h3><small>{e.routing === 'parallel' ? 'all at once' : 'in order'}</small></div>
          <div className="mx__people" style={{ paddingTop: 12 }}>{detail.recipients.map((r) => <div key={r.id} className={`mx__person ${['signed', 'viewed', 'sent'].includes(r.status) ? 'is-present' : ''}`}>
            <span className={`mx__avatar ${r.status === 'signed' ? 'mx__avatar--on' : ''}`} style={{ marginLeft: 0, ...(r.status === 'declined' ? { background: '#b0463f', color: '#fff' } : {}) }}>{initials(r.name)}</span>
            <span className="mx__personText"><strong>{r.name}{r.title ? `, ${r.title}` : ''}</strong><small>{r.email} · {r.role === 'cc' ? 'copy' : r.party ? `for ${r.party}` : `signer ${r.routing_order}`}{r.verify_by !== 'email' ? ` · ${r.verify_by === 'sms' ? 'text code' : 'email + text'}` : ''}{r.register_match ? ` · ${r.register_match.officer ? `listed as ${r.register_match.officer.role}` : 'not listed at the register'}` : ''}<br />{r.signed_at ? `signed ${day(r.signed_at)}` : r.declined_at ? `declined ${day(r.declined_at)}${r.decline_reason ? `: ${r.decline_reason}` : ''}` : r.verified_at ? `verified ${day(r.verified_at)}` : r.viewed_at ? `opened ${day(r.viewed_at)}` : r.notified_at ? `emailed ${day(r.notified_at)}${r.last_reminded_at ? ` · reminded ${day(r.last_reminded_at)}` : ''}` : 'waiting for their turn'}</small></span>
            <Pill s={r.status} />
          </div>)}</div>
          {detail.parties.length > 0 && <div className="mx__cardBody">{detail.parties.map((p) => <p key={p.id} className="mx__tiny"><strong>{p.name}</strong>: {p.signed} of {p.required_count} required signature(s){p.completed_at ? ' — done' : ''}{p.authority_note ? ` · authority: ${p.authority_note}` : ''}{p.register ? <><br />{p.register.available ? `${p.register.source} (${p.register.country} ${p.register.number}): ${p.register.companyName ?? 'not found'}${p.register.status ? `, ${p.register.status}` : ''}, checked ${day(p.register.checkedAt)}${p.register_required ? ' · listed officers only' : ''}` : `Register check not available: ${p.register.reason}`}</> : null}</p>)}</div>}
        </div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Record</h3><small>{detail.events.length} events</small></div><ul className="mx__log" style={{ paddingTop: 12 }}>{detail.events.map((ev, i) => <li key={i}><span /><span><time>{day(ev.occurred_at)}</time>{ev.kind.replace(/_/g, ' ')}{ev.recipient ? ` — ${ev.recipient}` : ''}</span></li>)}</ul></div>
      </div>
    </div>; })()}
  </div>;
}
