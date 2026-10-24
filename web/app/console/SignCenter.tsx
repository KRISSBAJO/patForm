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
import { PdfPages, PageBox, findPdfFieldHints } from '../../components/pdf-pages';

type Envelope = { id: string; number: number; title: string; status: string; routing: string; created_at: string; sent_at: string | null; completed_at: string | null; expires_at: string; final_sha256: string | null; contract: string | null; signers: number; signed: number; people: { name: string; status: string; order: number }[]; sender: string | null };
type Recipient = { id: string; name: string; email: string; role: string; routing_order: number; status: string; party_id: string | null; party: string | null; title: string | null; verify_by: string; register_match: { officer?: { role: string } } | null; notified_at: string | null; viewed_at: string | null; verified_at: string | null; consented_at: string | null; signed_at: string | null; declined_at: string | null; decline_reason: string | null; last_reminded_at: string | null };
type Field = { id?: string; suggested?: boolean; recipient_id: string | null; party_id?: string | null; slot?: number | null; kind: Kind; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string | null; choices: string[]; amountMinor?: number | null; currency?: string | null; paymentStatus?: string | null };
type Register = { available: boolean; reason?: string; country: string; number: string; companyName?: string; status?: string; source?: string; checkedAt: string };
type Party = { id: string; name: string; required_count: number; signed: number; authority_note: string | null; completed_at: string | null; register: Register | null; register_required: boolean };
type Detail = { envelope: Envelope & { page_count: number; original_sha256: string; void_reason: string | null; seal: { subject: string; selfIssued: boolean } | null; seal_timestamp: { time?: string; authority?: string; missing?: string } | null; allow_attachments: boolean }; recipients: Recipient[]; fields: Field[]; events: { kind: string; detail: Record<string, unknown>; occurred_at: string; recipient: string | null }[]; parties: Party[]; documents: { ordinal: number; filename: string; page_start: number; page_count: number }[]; attachments: { id: string; recipient_id: string; filename: string; byte_size: number; sha256: string }[] };
type Kind = 'signature' | 'initials' | 'date' | 'name' | 'text' | 'title' | 'email' | 'company' | 'checkbox' | 'dropdown' | 'radio' | 'payment';
type Row = { name: string; email: string; role: 'signer' | 'cc'; order: number; party: string; title: string; phone: string; verifyBy: 'email' | 'sms' | 'email_and_sms' };
type Mine = { envelopeId: string; number: number; title: string; sentAt: string; expiresAt: string; workspace: string; sender: string | null; status: string; url: string | null };
type Summary = { out: number; drafts: number; finalizing: number; done30: number; expiring: number; declined: number; waitingForMe: number; certificateSeal: boolean; selfIssuedSeal: boolean };
type Template = { id: string; name: string; recipients: Row[]; parties: unknown[]; routing: string; message: string | null; expires_in_days: number; created_by: string | null };
type AgreementTemplate = { id: string; name: string; documents: { ref: string; name: string }[]; roles: { label: string; role: 'signer' | 'cc'; order: number }[]; fields: { recipientIndex: number; kind: Kind; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string | null; choices?: string[]; amountMinor?: number | null; currency?: string | null }[]; routing: 'sequential' | 'parallel' };
type Mode = 'list' | 'compose' | 'place' | 'detail' | 'verify' | 'overview' | 'mine' | 'templates' | 'bulk';
const blank = (order: number): Row => ({ name: '', email: '', role: 'signer', order, party: '', title: '', phone: '', verifyBy: 'email' });
const SIZE: Record<Kind, [number, number]> = { signature: [0.26, 0.06], initials: [0.1, 0.05], date: [0.16, 0.03], name: [0.26, 0.03], text: [0.26, 0.03], title: [0.26, 0.03], email: [0.3, 0.03], company: [0.26, 0.03], checkbox: [0.06, 0.04], dropdown: [0.26, 0.04], radio: [0.26, 0.04], payment: [0.30, 0.05] };
const FIELD_TOOLS: { kind: Kind; symbol: string; name: string; hint: string }[] = [
  { kind: 'signature', symbol: '✒', name: 'Signature', hint: 'Signer adopts their signature' },
  { kind: 'initials', symbol: 'IN', name: 'Initials', hint: 'Short mark on each page' },
  { kind: 'date', symbol: '▣', name: 'Date signed', hint: 'Filled at signing time' },
  { kind: 'name', symbol: '◉', name: 'Full name', hint: 'From the signer identity' },
  { kind: 'email', symbol: '@', name: 'Email', hint: 'Verified signer address' },
  { kind: 'company', symbol: '▥', name: 'Company', hint: 'Company name' },
  { kind: 'title', symbol: '▤', name: 'Job title', hint: 'Their role or title' },
  { kind: 'text', symbol: 'T', name: 'Text', hint: 'Answer they type' },
  { kind: 'checkbox', symbol: '☑', name: 'Checkbox', hint: 'Confirm one statement' },
  { kind: 'dropdown', symbol: '⌄', name: 'Dropdown', hint: 'Choose one option' },
  { kind: 'radio', symbol: '◉', name: 'Radio choice', hint: 'Choose one option' },
  { kind: 'payment', symbol: '¤', name: 'Payment Item', hint: 'Collect payment before signing' },
];
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
function parseCsv(source: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted && ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) { if (ch === '\r' && source[i + 1] === '\n') i++; row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (quoted) throw new Error('The CSV has an unclosed quote.');
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
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
  const [agreements, setAgreements] = useState<AgreementTemplate[]>([]);
  const [activeAgreement, setActiveAgreement] = useState<AgreementTemplate | null>(null);
  const [roleLabels, setRoleLabels] = useState<string[]>([]);
  const [agreementName, setAgreementName] = useState('');
  const [agreementRoles, setAgreementRoles] = useState<string[]>([]);
  const [showAgreementSave, setShowAgreementSave] = useState(false);
  const [bulkTemplate, setBulkTemplate] = useState<AgreementTemplate | null>(null);
  const [bulkRows, setBulkRows] = useState<{ people: { name: string; email: string }[] }[]>([]);
  const [bulkKey, setBulkKey] = useState('');
  const [bulkReady, setBulkReady] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ sent: number; pending: number; total: number; results: { index: number; envelopeId?: string; status: string; error?: string }[] } | null>(null);
  const [mode, setMode] = useState<Mode>(startContract ? 'compose' : shell ? 'overview' : 'list');
  const sectionOf = (m: Mode) => (m === 'verify' ? 'verify' : m === 'compose' || m === 'place' ? 'send' : m === 'overview' ? 'overview' : m === 'mine' ? 'mine' : m === 'templates' || m === 'bulk' ? 'templates' : 'envelopes');
  const go = (m: Mode) => { setMode(m); shell?.onSection?.(sectionOf(m)); };
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(startContract?.title ?? '');
  const [message, setMessage] = useState('');
  const [routing, setRouting] = useState<'sequential' | 'parallel'>('sequential');
  const [days, setDays] = useState('30');
  const [allowAttachments, setAllowAttachments] = useState(false);
  const [rows, setRows] = useState<Row[]>([blank(1)]);
  const [partyRules, setPartyRules] = useState<Record<string, { required: string; note: string; country: string; number: string; strict: boolean }>>({});
  const rule = (c: string) => partyRules[c] ?? { required: '1', note: '', country: 'GB', number: '', strict: false };
  const setRule = (c: string, patch: Partial<ReturnType<typeof rule>>) => setPartyRules((x) => ({ ...x, [c]: { ...rule(c), ...patch } }));
  const [documents, setDocuments] = useState<{ ref: string; name: string }[]>([]);
  const [previewPdf, setPreviewPdf] = useState<ArrayBuffer | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [selectedField, setSelectedField] = useState<number | null>(null);
  const [showSendReview, setShowSendReview] = useState(false);
  const [current, setCurrent] = useState<{ recipient: string; kind: Kind }>({ recipient: '', kind: 'signature' });
  const [textLabel, setTextLabel] = useState('');
  const [fieldSearch, setFieldSearch] = useState('');
  const [fieldCorrectionReason, setFieldCorrectionReason] = useState('');
  const [voidWhy, setVoidWhy] = useState('');
  const [correcting, setCorrecting] = useState<{ id: string; name: string; email: string; reason: string } | null>(null);
  const [embedFor, setEmbedFor] = useState<{ id: string; name: string } | null>(null);
  const [embedOrigin, setEmbedOrigin] = useState('');
  const [embedLink, setEmbedLink] = useState('');
  const [filter, setFilter] = useState<'all' | 'sent' | 'draft' | 'finalizing' | 'completed' | 'declined' | 'other'>('all');
  const [q, setQ] = useState('');
  const [tplName, setTplName] = useState('');
  const [composeStep, setComposeStep] = useState<0 | 1>(0);

  const loadAll = useCallback(async () => {
    try {
      const [l, m, s, t, a] = await Promise.all([get<Envelope[]>('/api/sign/envelopes'), get<Mine[]>('/api/sign/mine').catch(() => []), get<Summary>('/api/sign/summary').catch(() => null), get<Template[]>('/api/sign/templates').catch(() => []), get<AgreementTemplate[]>('/api/sign/agreements').catch(() => [])]);
      setList(l); setMine(m); setSummary(s); setTemplates(t); setAgreements(a);
    } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); }
  }, []);
  useEffect(() => { void loadAll(); }, [loadAll]);
  useEffect(() => {
    const want = shell?.section;
    if (!want || want === sectionOf(mode)) return;
    if (want === 'envelopes') { setMode('list'); setDetail(null); setPdf(null); }
    else if (want === 'send') { setMode('compose'); setComposeStep(0); setTitle(''); setDocuments([]); setPreviewPdf(null); setRows([blank(1)]); setPartyRules({}); setActiveAgreement(null); setRoleLabels([]); setAllowAttachments(false); }
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
    { id: 'templates', name: 'Templates', count: templates.length + agreements.length || null },
    { id: 'verify', name: 'Verify a copy', count: null },
  ];

  const open = async (id: string, next: 'place' | 'detail') => {
    const d = await get<Detail>(`/api/sign/envelopes/${id}`);
    setDetail(d); setFields(d.fields); setSelectedField(null); setShowSendReview(false); setCorrecting(null); setEmbedFor(null); setEmbedLink(''); setAgreementRoles(d.recipients.map((r) => r.name)); setShowAgreementSave(false); setPdf(await pdfOf(id));
    const firstPerson = d.recipients.find((r) => r.role === 'signer' && !r.party_id);
    setCurrent({ recipient: firstPerson ? `r:${firstPerson.id}` : d.parties[0] ? `p:${d.parties[0].id}:1` : '', kind: 'signature' });
    go(next);
  };
  const act = async (work: () => Promise<string | void>) => { setBusy(true); setNote(null); try { const m = await work(); if (m) setNote({ text: m }); await loadAll(); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } finally { setBusy(false); } };
  const uploadDocument = (file: File) => void act(async () => {
    if (!/\.pdf$/i.test(file.name) || file.type && file.type !== 'application/pdf') throw new Error('Choose a PDF document.');
    if (file.size > 20 * 1024 * 1024) throw new Error('The PDF must be 20 MB or smaller.');
    if (documents.length >= 10) throw new Error('An envelope can contain at most 10 PDFs.');
    const r = await postJson<{ reference: string; filename: string }>('/api/gov/files', { purpose: 'signing', filename: file.name, base64: await readBase64(file) });
    setDocuments((all) => [...all, { ref: r.reference, name: r.filename }]);
    if (!documents.length) setPreviewPdf(await file.arrayBuffer());
    if (!title) setTitle(file.name.replace(/\.pdf$/i, ''));
    return 'Document added. Every PDF must pass its malware check before sending.';
  });
  const signers = (detail?.recipients ?? []).filter((r) => r.role === 'signer');
  const owners = [
    ...signers.filter((s) => !s.party_id).map((s) => ({ key: `r:${s.id}`, label: s.name })),
    ...(detail?.parties ?? []).flatMap((p) => Array.from({ length: p.required_count }, (_, i) => ({ key: `p:${p.id}:${i + 1}`, label: `${p.name} — signatory ${i + 1}` }))),
  ];
  const keyOf = (f: Field) => f.party_id ? `p:${f.party_id}:${f.slot}` : `r:${f.recipient_id}`;
  const color = (key: string) => COLORS[Math.max(0, owners.findIndex((o) => o.key === key)) % COLORS.length]!;
  const toBody = (f: Field) => ({ ...(f.party_id ? { partyId: f.party_id, slot: f.slot } : { recipientId: f.recipient_id }), kind: f.kind, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label, choices: f.choices ?? [], ...(f.kind === 'payment' ? { amountMinor: f.amountMinor, currency: f.currency } : {}) });
  const updateField = (index: number, patch: Partial<Field>) => setFields((all) => all.map((field, i) => i === index ? { ...field, ...patch } : field));
  const placeField = (page: number, x: number, y: number, kind: Kind = current.kind) => {
    if (!current.recipient) return;
    if (kind === 'payment' && current.recipient.startsWith('p:')) { setNote({ text: 'Assign a Payment Item to a named signer.' }); return; }
    if (kind === 'payment' && fields.some((field) => field.kind === 'payment')) { setNote({ text: 'This agreement already has a Payment Item.' }); return; }
    const [w, h] = SIZE[kind];
    const [ownerKind, ownerId, slot] = current.recipient.split(':');
    const owner = ownerKind === 'p' ? { recipient_id: null, party_id: ownerId!, slot: Number(slot) } : { recipient_id: ownerId!, party_id: null, slot: null };
    setSelectedField(fields.length);
    setFields((all) => [...all, { ...owner, kind, page, x: Math.max(0, Math.min(1 - w, x - w / 2)), y: Math.max(0, Math.min(1 - h, y - h / 2)), width: w, height: h, required: true, label: kind === 'text' ? textLabel.trim() || 'Text' : kind === 'payment' ? 'Payment Item' : null, choices: kind === 'dropdown' || kind === 'radio' ? ['Option 1', 'Option 2'] : [], ...(kind === 'payment' ? { amountMinor: 100, currency: 'NGN' } : {}) }]);
  };
  const suggestFromLabels = async () => {
    if (!pdf || !current.recipient) throw new Error('Choose a signer first.');
    const hints = await findPdfFieldHints(pdf);
    const [ownerKind, ownerId, slot] = current.recipient.split(':');
    const owner = ownerKind === 'p' ? { recipient_id: null, party_id: ownerId!, slot: Number(slot) } : { recipient_id: ownerId!, party_id: null, slot: null };
    const additions = hints.filter((hint) => !fields.some((field) => field.page === hint.page && field.kind === hint.kind && Math.abs(field.x - hint.x) < .04 && Math.abs(field.y - hint.y) < .04))
      .map((hint): Field => ({ ...owner, suggested: true, kind: hint.kind, page: hint.page, x: hint.x, y: hint.y, width: SIZE[hint.kind][0], height: SIZE[hint.kind][1], required: true, label: hint.label, choices: [] }));
    if (!additions.length) return hints.length ? 'All matching labels already have a nearby box.' : 'No stand-alone field labels were found. Place boxes manually, especially if this PDF is scanned.';
    setFields((all) => [...all, ...additions]);
    setSelectedField(fields.length);
    return `${additions.length} box suggestions added for ${owners.find((o) => o.key === current.recipient)?.label ?? 'the selected signer'}. Check and move every box before sending.`;
  };
  const companies = [...new Set(rows.filter((r) => r.role === 'signer' && r.party.trim()).map((r) => r.party.trim()))];
  const setRow = (i: number, patch: Partial<Row>) => setRows((x) => x.map((y, j) => (j === i ? { ...y, ...patch } : y)));
  const startCompose = () => { setTitle(''); setDocuments([]); setPreviewPdf(null); setRows([blank(1)]); setPartyRules({}); setMessage(''); setComposeStep(0); setActiveAgreement(null); setRoleLabels([]); setAllowAttachments(false); go('compose'); };
  const applyAgreement = (template: AgreementTemplate) => { setActiveAgreement(template); setDocuments(template.documents); setTitle(template.name); setRows(template.roles.map((role) => ({ ...blank(role.order), role: role.role }))); setRoleLabels(template.roles.map((role) => role.label)); setRouting(template.routing); setComposeStep(1); go('compose'); setNote({ text: `Agreement template “${template.name}” loaded. Fill each role, then review and send.` }); };
  const startBulk = (template: AgreementTemplate) => { setBulkTemplate(template); setBulkRows([]); setBulkKey(crypto.randomUUID()); setBulkReady(false); setBulkResult(null); go('bulk'); };
  const loadBulkCsv = async (file: File, template: AgreementTemplate) => {
    if (file.size > 1024 * 1024) throw new Error('The recipient CSV must be under 1 MB.');
    const parsed = parseCsv((await file.text()).replace(/^\uFEFF/, ''));
    const expected = template.roles.flatMap((r) => [`${r.label} name`, `${r.label} email`]);
    if (!parsed.length || parsed[0]!.length !== expected.length || expected.some((name, i) => parsed[0]![i]?.toLowerCase() !== name.toLowerCase())) throw new Error(`CSV headings must be: ${expected.join(', ')}`);
    if (parsed.length < 2 || parsed.length > 1001) throw new Error('Include between 1 and 1,000 recipient rows.');
    const rows = parsed.slice(1).map((cells, index) => { if (cells.length !== expected.length) throw new Error(`Row ${index + 2} has the wrong number of columns.`); return { people: template.roles.map((_, i) => ({ name: cells[i * 2] ?? '', email: cells[i * 2 + 1] ?? '' })) }; });
    setBulkRows(rows); setBulkReady(false); setBulkResult(null);
  };
  useEffect(() => {
    if (mode !== 'bulk' || !bulkResult?.pending || !bulkKey) return;
    const timer = window.setInterval(() => {
      void get<NonNullable<typeof bulkResult>>(`/api/sign/agreements/bulk/${encodeURIComponent(bulkKey)}`)
        .then(setBulkResult).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [mode, bulkKey, bulkResult?.pending]);
  const applyTemplate = (t: Template) => { setActiveAgreement(null); setRoleLabels([]); setRows(t.recipients.map((r, i) => ({ ...blank(i + 1), ...r }))); setRouting(t.routing === 'parallel' ? 'parallel' : 'sequential'); setDays(String(t.expires_in_days)); if (t.message) setMessage(t.message); const rules: typeof partyRules = {}; for (const p of t.parties as { name: string; required?: number; authorityNote?: string; register?: { country: string; number: string }; requireRegistered?: boolean }[]) rules[p.name] = { required: String(p.required ?? 1), note: p.authorityNote ?? '', country: p.register?.country ?? 'GB', number: p.register?.number ?? '', strict: Boolean(p.requireRegistered) }; setPartyRules(rules); setComposeStep(0); go('compose'); setNote({ text: `Signer set "${t.name}" loaded. Add the document, then review the signers.` }); };
  const filtered = (list ?? []).filter((e) => (filter === 'all' || (filter === 'other' ? ['voided', 'expired'].includes(e.status) : e.status === filter)) && (!q.trim() || `${e.title} PS-${e.number} ${e.people.map((p) => p.name).join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  const expiring = (list ?? []).filter((e) => e.status === 'sent' && daysLeft(e.expires_at) <= 7);
  const recent = (list ?? []).filter((e) => e.status === 'completed').slice(0, 5);

  const envRow = (e: Envelope) => <li key={e.id} className="sc__envelopeRow">
    <div className="sc__envelopePeople"><People people={e.people} /></div>
    <div className="sc__envelopeMain">
      <span className="sc__envelopeNumber">PS-{e.number}</span>
      <strong>{e.title}</strong>
      <div className="sc__envelopeMeta">
        {e.contract && <span>Contract: {e.contract}</span>}
        {e.sender && <span>From {e.sender}</span>}
        <span>{e.routing === 'parallel' ? 'All at once' : 'In order'}</span>
        <span>{e.sent_at ? `Sent ${day(e.sent_at)}` : `Created ${day(e.created_at)}`}</span>
        {e.completed_at ? <span>Completed {day(e.completed_at)}</span> : e.status === 'sent' && <span>{daysLeft(e.expires_at)} day{daysLeft(e.expires_at) === 1 ? '' : 's'} left</span>}
      </div>
    </div>
    {e.status === 'sent' && <div className="sc__envelopeProgress"><Progress signed={e.signed} total={e.signers} /><span className="mx__tiny">{e.signed} of {e.signers} signed</span></div>}
    <div className="sc__envelopeStatus"><Pill s={e.status} /></div>
    <div className="sc__envelopeActions">
      {e.status === 'sent' && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy} onClick={() => void act(async () => { const r = await postJson<{ reminded: number }>(`/api/sign/envelopes/${e.id}/remind`, {}); return `Reminded ${r.reminded} signer(s).`; })}>Remind</button>}
      <button type="button" className={`mx__btn mx__btn--sm ${e.status === 'draft' ? '' : 'mx__btn--ghost'}`} onClick={() => void act(() => open(e.id, e.status === 'draft' ? 'place' : 'detail'))}>{e.status === 'draft' ? 'Continue' : 'Open'}</button>
    </div>
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
          <div className="mx__card"><div className="mx__cardHead"><h3>How it works</h3></div><div className="mx__cardBody"><ol className="mx__howto"><li><strong>Place the boxes.</strong> Signers in order or at once; a company can sign through any two of three directors.</li><li><strong>Confirm access and consent.</strong> A one-time code confirms access to email or a phone, then the signer records their consent. This is not a legal identity check.</li><li><strong>Check the copy.</strong> Every finished PDF has a certificate page and fingerprint. {summary?.certificateSeal ? summary.selfIssuedSeal ? 'This deployment uses a self-issued test seal, which is not independently trusted.' : 'A PDF certificate seal is configured for this deployment; check its issuer before relying on it.' : 'A PDF certificate seal has not been configured for this deployment.'}</li></ol></div></div>
        </div>
      </div>
    </div>}

    {mode === 'mine' && <div className="mx__card"><div className="mx__cardHead"><h3>Waiting for your signature</h3><small>Your personal links, same as in your email</small></div><ul className="mx__list" style={{ marginTop: 10 }}>{mine.map(mineRow)}{!mine.length && empty('Nothing waiting for you', 'When someone sends you a document to sign, it appears here with a Sign now button — the same link as in your email.', undefined, 'vote')}</ul></div>}

    {mode === 'list' && <div className="mx__card sc__envelopes">
      <div className="mx__cardHead"><h3>Envelopes</h3><div className="mx__voteBtns sc__envelopeToolbar" style={{ marginTop: 0 }}><input className="mx__input" placeholder="Search title, number, signer" aria-label="Search envelopes" value={q} onChange={(e) => setQ(e.target.value)} /><button type="button" className="mx__btn mx__btn--sm" onClick={startCompose}>+ Send a document</button>{onClose && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={onClose}>Close</button>}</div></div>
      <div className="mx__segs" style={{ padding: '12px 20px 4px' }}>{([['all', 'All'], ['sent', 'Out'], ['draft', 'Drafts'], ['finalizing', 'Preparing'], ['completed', 'Completed'], ['declined', 'Declined'], ['other', 'Cancelled / expired']] as const).map(([k, v]) => <button key={k} type="button" className={`mx__seg ${filter === k ? 'is-on' : ''}`} onClick={() => setFilter(k)}>{v}</button>)}</div>
      <ul className="mx__list" style={{ marginTop: 6 }}>{filtered.map(envRow)}{list && !filtered.length && empty(q ? 'No match' : 'Nothing sent for signature yet', q ? 'No envelope matches that search. Try a signer\'s name or the PS number.' : 'Upload a PDF, add the signers, place their boxes and send. They sign from a link; you follow it here.', q ? undefined : { label: '+ Send a document', onClick: startCompose }, q ? 'search' : 'send')}</ul>
    </div>}

    {mode === 'templates' && <div className="mx__card">
      <div className="mx__cardHead"><h3>Agreement templates</h3><small>Documents, role placeholders and signing fields, ready for a different group of people each time.</small></div>
      <ul className="mx__list" style={{ marginTop: 10 }}>{agreements.map((t) => <li key={t.id}><Illustration name="sign" size={32} /><div className="mx__main"><strong>{t.name}</strong><small>{t.documents.length} document{t.documents.length === 1 ? '' : 's'} · {t.roles.map((r) => r.label).join(', ')} · {t.routing === 'parallel' ? 'all at once' : 'in stages'}</small></div><button type="button" className="mx__btn mx__btn--sm" onClick={() => applyAgreement(t)}>Use template</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => startBulk(t)}>Bulk send</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy} onClick={() => void act(async () => { await postJson(`/api/sign/agreements/${t.id}/delete`, {}); return 'Agreement template removed.'; })}>Remove</button></li>)}{!agreements.length && empty('No agreement templates yet', 'Prepare a draft, place its fields, then save it as a reusable agreement.', { label: 'Prepare an agreement', onClick: startCompose }, 'send')}</ul>
      <div className="mx__cardHead"><h3>Signer sets</h3><small>Save the same people for a recurring document.</small></div>
      <ul className="mx__list" style={{ marginTop: 10 }}>{templates.map((t) => <li key={t.id}><People people={t.recipients.filter((r) => r.role === 'signer').map((r) => ({ name: r.name, status: 'waiting' }))} /><div className="mx__main"><strong>{t.name}</strong><small>{t.recipients.length} recipient{t.recipients.length === 1 ? '' : 's'} · {t.routing === 'parallel' ? 'all at once' : 'in order'} · expires after {t.expires_in_days} days{t.created_by ? ` · by ${t.created_by}` : ''}</small></div><button type="button" className="mx__btn mx__btn--sm" onClick={() => applyTemplate(t)}>Use</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy} onClick={() => void act(async () => { await postJson(`/api/sign/templates/${t.id}/delete`, {}); return 'Signer set removed.'; })}>Remove</button></li>)}{!templates.length && empty('No signer sets yet', 'Save the people who sign a recurring document once; next time, load them in one click.', { label: 'Send a document and save its signers', onClick: startCompose, secondary: true }, 'people')}</ul>
    </div>}

    {mode === 'bulk' && bulkTemplate && <div className="mx__card sc__bulk"><div className="mx__cardHead"><div><button type="button" className="mx__link" onClick={() => go('templates')}>‹ Templates</button><h3>Send {bulkTemplate.name} to many groups</h3><small>One separate envelope per row. Each group sees only its own agreement.</small></div></div><div className="mx__cardBody"><p>Prepare a CSV with these columns, in this order:</p><code>{bulkTemplate.roles.flatMap((role) => [`${role.label} name`, `${role.label} email`]).join(', ')}</code><div className="sc__bulkActions"><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { const header = bulkTemplate.roles.flatMap((role) => [`${role.label} name`, `${role.label} email`]).join(', '); const blob = new Blob([`${header}\n`], { type: 'text/csv' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${bulkTemplate.name.replace(/[^a-z0-9_-]/gi, '-')}-recipients.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download sample CSV</button><label className="mx__btn mx__btn--sm">Choose CSV<input type="file" accept=".csv,text/csv" hidden onChange={(ev) => { const file = ev.target.files?.[0]; ev.target.value = ''; if (file) void act(async () => { await loadBulkCsv(file, bulkTemplate); return `${file.name} loaded for review.`; }); }} /></label></div>{bulkRows.length > 0 && <><h4>Review {bulkRows.length} envelope{bulkRows.length === 1 ? '' : 's'}</h4><div className="sc__bulkTable"><table><thead><tr><th>#</th>{bulkTemplate.roles.map((role) => <th key={role.label}>{role.label}</th>)}</tr></thead><tbody>{bulkRows.map((row, i) => <tr key={i}><td>{i + 1}</td>{row.people.map((person, j) => <td key={j}><strong>{person.name}</strong><small>{person.email}</small></td>)}</tr>)}</tbody></table></div><div className="sc__bulkActions"><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy} onClick={() => void act(async () => { await postJson('/api/sign/agreements/bulk', { templateId: bulkTemplate.id, batchKey: bulkKey, rows: bulkRows, dryRun: true }); setBulkReady(true); return 'All rows are valid. Ready to send.'; })}>Validate all rows</button><button type="button" className="mx__btn mx__btn--sm" disabled={busy || !bulkReady} onClick={() => void act(async () => { await postJson('/api/sign/agreements/bulk', { templateId: bulkTemplate.id, batchKey: bulkKey, rows: bulkRows }); const result = await get<NonNullable<typeof bulkResult>>(`/api/sign/agreements/bulk/${encodeURIComponent(bulkKey)}`); setBulkResult(result); return `${result.total} envelopes queued. Progress updates here automatically.`; })}>Send {bulkRows.length} envelopes</button></div></>}{bulkResult && <div className="sc__bulkResults"><h4>Batch results · {bulkResult.sent} sent · {bulkResult.pending} processing</h4>{bulkResult.results.map((row) => <p key={row.index}>Row {row.index}: {row.status}{row.error ? ` — ${row.error}` : ''}</p>)}{bulkResult.results.some((row) => row.status === 'failed') && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy} onClick={() => void act(async () => { await postJson(`/api/sign/agreements/bulk/${encodeURIComponent(bulkKey)}/retry`, {}); setBulkResult(await get<NonNullable<typeof bulkResult>>(`/api/sign/agreements/bulk/${encodeURIComponent(bulkKey)}`)); return 'Failed rows queued again.'; })}>Retry failed rows</button>}</div>}</div></div>}

    {mode === 'verify' && <Verify />}

    {mode === 'compose' && <div className="mx__wizard sc__wizard">
      <div className="mx__steps">{['Document', 'Signers', 'Place & send'].map((s, i) => <div key={s} className={`mx__step ${i === composeStep ? 'is-on' : ''} ${i < composeStep ? 'is-done' : ''}`}><i>{i < composeStep ? '✓' : i + 1}</i>{s}</div>)}</div>
      <div className="mx__wizBody">
        {composeStep === 0 && <div className="sc__prepare">
          <header className="sc__intro"><span className="sc__eyebrow">01 / PREPARE</span><h2>Start with the document.</h2><p>Preview the PDF, set the context, then choose who needs to sign.</p></header>
          <div className="sc__prepareGrid">
            <section className="sc__documentPane" aria-label="Document preview">
              <div className="sc__paneHead"><span>DOCUMENTS</span><span>{documents.length ? `${documents.length} OF 10 PDFS` : 'PDF · UP TO 20 MB EACH'}</span></div>
              {startContract ? <div className="sc__contract"><Illustration name="sign" size={64} /><strong>{startContract.title}</strong><span>The current approved contract version will be signed.</span></div>
                : <>
                  <label className={`sc__upload ${documents.length ? 'is-set' : ''}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files?.[0]; if (file) uploadDocument(file); }}>
                    <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) uploadDocument(file); e.target.value = ''; }} />
                    <span className="sc__uploadIcon" aria-hidden="true">↥</span><strong>{documents.length ? 'Add another PDF' : 'Choose a PDF or drop it here'}</strong><small>Documents are signed together, in the order shown below.</small>
                  </label>
                  {documents.length > 0 && <ol className="sc__documents">{documents.map((doc, i) => <li key={doc.ref}><span>{String(i + 1).padStart(2, '0')}</span><strong>{doc.name}</strong><button type="button" aria-label={`Remove ${doc.name}`} onClick={() => { setDocuments((all) => all.filter((_, j) => j !== i)); if (i === 0) setPreviewPdf(null); }}>Remove</button></li>)}</ol>}
                  {previewPdf && documents.length === 1 && <div className="sc__preview"><PdfPages data={previewPdf} maxWidth={500} /></div>}
                </>}
            </section>
            <section className="sc__detailsPane" aria-label="Envelope details">
              <div className="sc__paneHead"><span>DETAILS</span><span>PRIVATE DRAFT</span></div>
              <div className="sc__detailsContent">
                <Field label="Document title" id="sc-title"><input id="sc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Supply agreement with Acme" maxLength={200} /></Field>
                <Field label="Message to signers" id="sc-message"><textarea id="sc-message" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Add a short note about what you need them to sign" /></Field>
                <div className="sc__detailRule" />
                <Field label="Signing order"><div className="mx__segs"><button type="button" className={`mx__seg ${routing === 'sequential' ? 'is-on' : ''}`} onClick={() => setRouting('sequential')}>Stages</button><button type="button" className={`mx__seg ${routing === 'parallel' ? 'is-on' : ''}`} onClick={() => setRouting('parallel')}>All at once</button></div><small className="sc__routingHelp">In stages, people with the same stage number receive the document together. The next stage starts when all required signatures in this stage are complete.</small></Field>
                <Field label="Expires after" id="sc-days"><div className="sc__days"><input id="sc-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} /><span>days</span></div></Field>
                <label className="sc__attachmentToggle"><input type="checkbox" checked={allowAttachments} onChange={(ev) => setAllowAttachments(ev.target.checked)} /><span><strong>Allow supporting files</strong><small>Signers may add up to five PDFs or images. Files are checked and recorded with the agreement.</small></span></label>
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
              <div className="sc__recipientHead"><span className="sc__recipientNo">{String(i + 1).padStart(2, '0')}</span><strong>{roleLabels[i] || r.name || (r.role === 'cc' ? 'Copy recipient' : `Signer ${i + 1}`)}</strong><select aria-label={`Role for recipient ${i + 1}`} className="mx__input" value={r.role} disabled={Boolean(activeAgreement)} onChange={(e) => setRow(i, { role: e.target.value as Row['role'] })}><option value="signer">Needs to sign</option><option value="cc">Gets a copy</option></select><button type="button" className="sc__remove" aria-label={`Remove recipient ${i + 1}`} disabled={rows.length === 1 || Boolean(activeAgreement)} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>Remove</button></div>
              <div className="sc__recipientFields">
                <Field label="Full name" id={`sc-name-${i}`}><input id={`sc-name-${i}`} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} autoComplete="name" placeholder="Name as it should appear" /></Field>
                <Field label="Email address" id={`sc-email-${i}`}><input id={`sc-email-${i}`} type="email" value={r.email} onChange={(e) => setRow(i, { email: e.target.value })} autoComplete="email" placeholder="name@company.com" /></Field>
                {r.role === 'signer' && <>
                  <Field label="Company · optional" id={`sc-party-${i}`}><input id={`sc-party-${i}`} value={r.party} onChange={(e) => setRow(i, { party: e.target.value })} placeholder="Company they represent" /></Field>
                  <Field label="Job title · optional" id={`sc-job-${i}`}><input id={`sc-job-${i}`} value={r.title} onChange={(e) => setRow(i, { title: e.target.value })} placeholder="e.g. Director" /></Field>
                  <Field label="Signing access code" id={`sc-check-${i}`}><select id={`sc-check-${i}`} value={r.verifyBy} onChange={(e) => setRow(i, { verifyBy: e.target.value as Row['verifyBy'] })}><option value="email">Code by email</option><option value="sms">Code by text</option><option value="email_and_sms">Code by email and text</option></select><small className="sc__routingHelp">Confirms access to a channel; it does not verify a legal identity.</small></Field>
                  {r.verifyBy !== 'email' && <Field label="Mobile number" id={`sc-phone-${i}`}><input id={`sc-phone-${i}`} type="tel" value={r.phone} onChange={(e) => setRow(i, { phone: e.target.value })} placeholder="+2348012345678" /></Field>}
                  {routing === 'sequential' && <Field label="Signing stage" id={`sc-order-${i}`}><input id={`sc-order-${i}`} type="number" min={1} max={20} value={r.order} onChange={(e) => setRow(i, { order: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} /><small className="sc__routingHelp">Use the same stage for people who can sign together.</small></Field>}
                </>}
              </div>
            </section>)}
          </div>
          {!activeAgreement && <div className="mx__voteBtns"><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setRows((x) => [...x, blank(x.length + 1)])}>+ Add a signer</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setRows((x) => [...x, { ...blank(x.length + 1), role: 'cc' }])}>+ Add someone who gets a copy</button></div>}
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
        {composeStep === 0 && <button type="button" className="mx__btn" disabled={busy || !title.trim() || (!startContract && !documents.length) || !Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 365} onClick={() => setComposeStep(1)}>Continue to signers →</button>}
        {composeStep === 1 && <button type="button" className="mx__btn" disabled={busy || !rows.some((r) => r.role === 'signer' && r.name && r.email) || Boolean(activeAgreement && rows.some((r) => !r.name.trim() || !r.email.trim()))} onClick={() => void act(async () => {
          const r = await postJson<{ id: string; recipients: string[]; parties: { name: string; unlisted: string[]; register: Register | null }[] }>('/api/sign/envelopes', { ...(startContract ? { contractId: startContract.id, documentRefs: documents.map((doc) => doc.ref) } : { documentRef: documents[0]?.ref, documentRefs: documents.slice(1).map((doc) => doc.ref) }), title, message, routing, expiresInDays: Number(days), allowAttachments,
            recipients: rows.filter((x) => x.name || x.email).map((x) => ({ name: x.name, email: x.email, role: x.role, order: x.order, party: x.role === 'signer' ? x.party.trim() || undefined : undefined, title: x.title || undefined, phone: x.phone || undefined, verifyBy: x.verifyBy })),
            parties: companies.map((c) => ({ name: c, required: Number(rule(c).required || 1), order: rows.find((x) => x.party.trim() === c)?.order ?? 1, authorityNote: rule(c).note || undefined, register: rule(c).number.trim() ? { country: rule(c).country, number: rule(c).number.trim() } : undefined, requireRegistered: rule(c).strict })) });
          if (activeAgreement) await postJson(`/api/sign/envelopes/${r.id}/fields`, { fields: activeAgreement.fields.map((f) => ({ ...f, recipientId: r.recipients[f.recipientIndex] })) });
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

    {mode === 'place' && detail && pdf && <div className="mx__wizard sc__wizard">
      <div className="mx__steps">{['Document', 'Signers', 'Place & send'].map((s, i) => <div key={s} className={`mx__step ${i === 2 ? 'is-on' : 'is-done'}`}><i>{i < 2 ? '✓' : 3}</i>{s}</div>)}</div>
      <div className="sc__editorTop">
        <div><span className="sc__eyebrow">03 / FIELD EDITOR</span><h2>Place the details where they belong.</h2><p>Choose a recipient, then drag a field onto the PDF or tap the page to place it. Select a field to refine it.</p></div>
        <div className="sc__editorActions">
          {detail.envelope.status === 'draft' && !detail.envelope.contract && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setShowAgreementSave((shown) => !shown)}>Save as template</button>}
          {detail.envelope.status === 'draft' && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy} onClick={() => void act(suggestFromLabels)}>Find labels on PDF</button>}
          {detail.envelope.status === 'draft' && fields.some((field) => field.suggested) && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setFields((all) => all.filter((field) => !field.suggested)); setSelectedField(null); setNote({ text: 'Suggested boxes removed. Your other boxes remain.' }); }}>Remove suggestions</button>}
          {detail.envelope.status === 'draft' && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy} onClick={() => void act(async () => { await postJson(`/api/sign/envelopes/${detail.envelope.id}/fields`, { fields: fields.map(toBody) }); return 'Boxes saved.'; })}>Save</button>}
          {detail.envelope.status === 'draft' && <button type="button" className="mx__btn mx__btn--sm" disabled={busy} onClick={() => setShowSendReview(true)}>Review placement</button>}
          {detail.envelope.status === 'sent' && <button type="button" className="mx__btn mx__btn--sm" disabled={busy || !fieldCorrectionReason.trim()} onClick={() => void act(async () => { const r = await postJson<{ notified: number }>(`/api/sign/envelopes/${detail.envelope.id}/fields`, { fields: fields.map(toBody), correctionReason: fieldCorrectionReason.trim() }); await open(detail.envelope.id, 'detail'); setFieldCorrectionReason(''); return `Fields corrected. Old links were revoked and ${r.notified} new invitation(s) sent.`; })}>Apply correction & resend</button>}
          <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { go('list'); setDetail(null); setPdf(null); }}>Later</button>
        </div>
      </div>
      {detail.envelope.status === 'sent' && <div className="sc__templateSave"><div><h3>Correct fields before anyone signs</h3><p>Changing the boxes revokes every signing link and sends fresh invitations to the current stage. Signed envelopes need a new agreement.</p></div><label>Reason for correction<input value={fieldCorrectionReason} maxLength={500} onChange={(e) => setFieldCorrectionReason(e.target.value)} placeholder="e.g. Corrected an incorrect field position" /></label></div>}
      {showAgreementSave && <div className="sc__templateSave"><div><h3>Save this agreement</h3><p>The PDFs and field positions are reused. Each role gets a new name and email when you send it again.</p></div><label>Template name<input value={agreementName} maxLength={120} placeholder="e.g. Employment agreement" onChange={(ev) => setAgreementName(ev.target.value)} /></label><div className="sc__templateRoles">{detail.recipients.map((r, i) => <label key={r.id}>Role {i + 1}<input value={agreementRoles[i] ?? ''} maxLength={80} placeholder={r.role === 'cc' ? 'Copy recipient' : 'Signer role'} onChange={(ev) => setAgreementRoles((all) => all.map((label, j) => j === i ? ev.target.value : label))} /></label>)}</div><button type="button" className="mx__btn mx__btn--sm" disabled={busy || !agreementName.trim() || agreementRoles.some((label) => !label.trim())} onClick={() => void act(async () => { await postJson(`/api/sign/envelopes/${detail.envelope.id}/fields`, { fields: fields.map(toBody) }); await postJson(`/api/sign/envelopes/${detail.envelope.id}/agreement-template`, { name: agreementName.trim(), roles: agreementRoles.map((label) => label.trim()) }); setShowAgreementSave(false); setAgreementName(''); return 'Agreement template saved. You can reuse it with new signers.'; })}>Save agreement template</button></div>}
      <div className="sc__editor">
        <aside className="sc__palette" aria-label="Signing fields">
          <label className="sc__paletteLabel" htmlFor="sc-field-recipient">FIELDS FOR</label>
          <select id="sc-field-recipient" value={current.recipient} onChange={(e) => { setCurrent((c) => ({ ...c, recipient: e.target.value })); setSelectedField(null); }} style={{ borderColor: color(current.recipient) }}>{owners.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
          <input className="sc__fieldSearch" aria-label="Search signing fields" placeholder="Search fields" value={fieldSearch} onChange={(e) => setFieldSearch(e.target.value)} /><div className="sc__paletteGroup"><span>STANDARD FIELDS</span>{FIELD_TOOLS.filter((tool) => `${tool.name} ${tool.hint}`.toLowerCase().includes(fieldSearch.toLowerCase())).map((tool) => <button key={tool.kind} type="button" draggable onDragStart={(e) => { e.dataTransfer.setData('application/x-patform-sign-field', tool.kind); setCurrent((c) => ({ ...c, kind: tool.kind })); }} className={current.kind === tool.kind ? 'is-current' : ''} onClick={() => setCurrent((c) => ({ ...c, kind: tool.kind }))}><b style={{ background: color(current.recipient) }}>{tool.symbol}</b><span><strong>{tool.name}</strong><small>{tool.hint}</small></span></button>)}</div>
          {current.kind === 'text' && <label className="sc__paletteLabel">Text field label<input value={textLabel} maxLength={120} onChange={(e) => setTextLabel(e.target.value)} placeholder="e.g. Company number" /></label>}
          <p className="sc__editorHint">Select a signer, then use “Find labels on PDF” for suggestions from clear, stand-alone labels. Check every box against the page before sending. Scanned PDFs need manual placement.</p>
        </aside>
        <main className="sc__canvas" aria-label="Document field placement"><div className="sc__canvasHead"><span>{detail.envelope.title} · {detail.envelope.page_count} page{detail.envelope.page_count === 1 ? '' : 's'}</span><span>{fields.length} field{fields.length === 1 ? '' : 's'} placed</span></div>
          {detail.documents.length > 1 && <div className="sc__documentIndex">{detail.documents.map((doc) => <span key={doc.ordinal}>{doc.ordinal}. {doc.filename} · pages {doc.page_start}–{doc.page_start + doc.page_count - 1}</span>)}</div>}
          <PdfPages data={pdf} onPageClick={(page, x, y) => placeField(page, x, y)} onPageDrop={(page, x, y, kind) => { if (FIELD_TOOLS.some((tool) => tool.kind === kind)) placeField(page, x, y, kind as Kind); }}
            overlay={(page) => fields.map((field, i) => field.page === page && <PageBox key={field.id ?? i} x={field.x} y={field.y} width={field.width} height={field.height} color={color(keyOf(field))} selected={selectedField === i} title={`${field.kind} for ${owners.find((o) => o.key === keyOf(field))?.label ?? 'signer'}`} onClick={() => setSelectedField(i)} onMove={(x, y) => updateField(i, { x, y })}>{FIELD_TOOLS.find((tool) => tool.kind === field.kind)?.symbol} {field.label ?? FIELD_TOOLS.find((tool) => tool.kind === field.kind)?.name} · {owners.find((o) => o.key === keyOf(field))?.label.split(' ')[0]}</PageBox>)} />
        </main>
        <aside className="sc__inspector" aria-label="Selected field settings">{selectedField !== null && fields[selectedField] ? (() => { const field = fields[selectedField]!; const i = selectedField; return <><span className="sc__eyebrow">FIELD SETTINGS</span><h3>{FIELD_TOOLS.find((tool) => tool.kind === field.kind)?.name}</h3><p>Page {field.page} · {owners.find((o) => o.key === keyOf(field))?.label}</p><label>Assigned to<select value={keyOf(field)} onChange={(e) => { const [ownerKind, id, slot] = e.target.value.split(':'); updateField(i, ownerKind === 'p' ? { recipient_id: null, party_id: id!, slot: Number(slot) } : { recipient_id: id!, party_id: null, slot: null }); }}>{owners.map((owner) => <option key={owner.key} value={owner.key}>{owner.label}</option>)}</select></label><label>Label<input value={field.label ?? ''} maxLength={120} onChange={(e) => updateField(i, { label: e.target.value || null })} placeholder={FIELD_TOOLS.find((tool) => tool.kind === field.kind)?.name} /></label>{field.kind === 'payment' && <><label>Currency<select value={field.currency ?? 'NGN'} onChange={(e) => updateField(i, { currency: e.target.value })}><option value="NGN">NGN · Paystack</option><option value="USD">USD · Stripe</option><option value="GBP">GBP · Stripe</option><option value="EUR">EUR · Stripe</option></select></label><label>Amount<input type="number" min="1" max="1000000" step="0.01" value={((field.amountMinor ?? 100) / 100).toFixed(2)} onChange={(e) => updateField(i, { amountMinor: Math.round(Number(e.target.value) * 100) })} /><small>Charged through hosted checkout before the signer finishes.</small></label></>}{(field.kind === 'dropdown' || field.kind === 'radio') && <label>Choices, one per line<textarea rows={5} value={(field.choices ?? []).join("\n")} onChange={(e) => updateField(i, { choices: e.target.value.split("\n") })} /><small>Add 2 to 20 different options.</small></label>}<label className="sc__required"><input type="checkbox" checked={field.required} onChange={(e) => updateField(i, { required: e.target.checked })} /> Required</label><div className="sc__sizeGrid"><label>Width<input type="number" min={5} max={100} value={Math.round(field.width * 100)} onChange={(e) => updateField(i, { width: Math.min(1 - field.x, Math.max(.05, Number(e.target.value) / 100 || .05)) })} /></label><label>Height<input type="number" min={2} max={100} value={Math.round(field.height * 100)} onChange={(e) => updateField(i, { height: Math.min(1 - field.y, Math.max(.02, Number(e.target.value) / 100 || .02)) })} /></label></div><button type="button" className="sc__deleteField" onClick={() => { setFields((all) => all.filter((_, index) => index !== i)); setSelectedField(null); }}>Remove field</button></>; })() : <><span className="sc__eyebrow">FIELD SETTINGS</span><h3>Select a field</h3><p>Click a box on the PDF to change its recipient, label, size or requirement.</p></>}</aside>
      </div>
    </div>}

    {mode === 'place' && showSendReview && detail?.envelope.status === 'draft' && pdf && <div className="sc__reviewBackdrop" role="presentation">
      <section className="sc__review" role="dialog" aria-modal="true" aria-labelledby="sc-review-title">
        <header className="sc__reviewHeader"><div><span className="sc__eyebrow">FINAL PLACEMENT CHECK</span><h2 id="sc-review-title">Look at every box before you send.</h2><p>These outlines mark the exact places where answers and signatures will appear in the finished PDF.</p></div><button type="button" className="sc__reviewClose" onClick={() => setShowSendReview(false)} aria-label="Back to field editor">×</button></header>
        <div className="sc__reviewBody"><div className="sc__reviewPages"><PdfPages data={pdf} maxWidth={760} overlay={(page) => fields.map((field, i) => field.page === page && <PageBox key={field.id ?? i} x={field.x} y={field.y} width={field.width} height={field.height} color={color(keyOf(field))} title={`${field.kind} for ${owners.find((o) => o.key === keyOf(field))?.label ?? 'signer'}`}>{FIELD_TOOLS.find((tool) => tool.kind === field.kind)?.symbol} {field.label ?? FIELD_TOOLS.find((tool) => tool.kind === field.kind)?.name}</PageBox>)} /></div>
          <aside className="sc__reviewAside"><strong>{detail.envelope.title}</strong><p>{detail.envelope.page_count} pages · {fields.length} fields · {signers.length} signer{signers.length === 1 ? '' : 's'}</p><ol>{Array.from({ length: detail.envelope.page_count }, (_, i) => <li key={i}>Page {i + 1}<span>{fields.filter((field) => field.page === i + 1).length} fields</span></li>)}</ol><p className="sc__reviewHint">Check each signature and payment box against the printed document. If one crosses text or sits between lines, return to the editor and move it.</p></aside></div>
        <footer className="sc__reviewFooter">{note?.err && <p className="sc__reviewError" role="alert">{note.text}</p>}<button type="button" className="mx__btn mx__btn--ghost" onClick={() => setShowSendReview(false)}>Move a box</button><button type="button" className="mx__btn" disabled={busy} onClick={() => void act(async () => { await postJson(`/api/sign/envelopes/${detail.envelope.id}/fields`, { fields: fields.map(toBody) }); const r = await postJson<{ notified: number }>(`/api/sign/envelopes/${detail.envelope.id}/send`, {}); await open(detail.envelope.id, 'detail'); return `Sent. ${r.notified} signer(s) emailed.${owners.some((o) => !fields.some((f) => keyOf(f) === o.key && f.kind === 'signature')) ? ' Anyone without a signature box signs on an added signature page.' : ''}`; })}>{busy ? 'Sending…' : 'Send invitations'}</button></footer>
      </section>
    </div>}

    {mode === 'detail' && detail && (() => { const e = detail.envelope; const signers = detail.recipients.filter((r) => r.role === 'signer'); const signed = signers.filter((r) => r.status === 'signed' || !!r.signed_at).length; const flow = ['draft', 'sent', 'completed']; const at = e.status === 'completed' ? 2 : ['sent', 'finalizing'].includes(e.status) ? 1 : 0; return <div className="mx__room">
      <div className="mx__card">
        <div className="mx__roomHead"><div>
          <button type="button" className="mx__link" onClick={() => { go('list'); setDetail(null); setPdf(null); if (onClose && startContract) onClose(); }}>‹ All envelopes</button>
          <div className="mx__eyebrow" style={{ color: 'var(--mx-muted)', marginTop: 8 }}>PS-{e.number}{e.contract ? ` · contract: ${e.contract}` : ''}</div>
          <h2 className="mx__roomTitle">{e.title}</h2>
          <div className="mx__roomMeta"><Pill s={e.status} /><span>{e.routing === 'parallel' ? 'All at once' : 'In order'}</span>{e.sent_at && <span>· sent {day(e.sent_at)}</span>}<span>· expires {day(e.expires_at)}</span>{e.void_reason && <span>· {e.void_reason}</span>}</div>
        </div><div style={{ textAlign: 'right' }}><Progress signed={signed} total={signers.length} /><span className="mx__tiny">{signed} of {signers.length} signed</span></div></div>
        <div className="mx__flow sc__detailFlow">{flow.map((s, i) => <span key={s} className={i < at ? 'is-done' : i === at ? 'is-on' : ''}>{s === 'draft' ? 'Draft' : s === 'sent' ? 'Out for signature' : 'Completed'}</span>)}{['declined', 'voided', 'expired', 'finalizing'].includes(e.status) && <span className="is-on">{st(e.status)}</span>}</div>
        <div className="mx__bar sc__detailToolbar">
          {e.status === 'completed' && <button type="button" className="mx__btn" onClick={() => void act(async () => { const blob = new Blob([await pdfOf(e.id)], { type: 'application/pdf' }); const url = URL.createObjectURL(blob); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000); })}>Open the sealed copy</button>}
          {e.status === 'sent' && <button type="button" className="mx__btn" disabled={busy} onClick={() => void act(async () => { const r = await postJson<{ reminded: number }>(`/api/sign/envelopes/${e.id}/remind`, {}); return `Reminded ${r.reminded} signer(s).`; })}>Remind now</button>}
          {e.status === 'sent' && signed === 0 && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setFieldCorrectionReason(''); go('place'); }}>Correct fields</button>}
          {e.status === 'draft' && <button type="button" className="mx__btn" onClick={() => void act(() => open(e.id, 'place'))}>Continue placing boxes</button>}
          {['draft', 'sent'].includes(e.status) && <div className="sc__cancelGroup"><input className="mx__input" aria-label="Reason for cancellation" placeholder="Why cancel?" value={voidWhy} onChange={(ev) => setVoidWhy(ev.target.value)} /><button type="button" className="mx__btn mx__btn--danger mx__btn--sm" disabled={busy || !voidWhy.trim()} onClick={() => void act(async () => { await postJson(`/api/sign/envelopes/${e.id}/void`, { reason: voidWhy.trim() }); await open(e.id, 'detail'); return 'Cancelled. Signers who were asked have been told.'; })}>Cancel envelope</button></div>}
          {e.final_sha256 && <><span className={`sc__trustLabel ${e.seal?.selfIssued ? 'sc__trustLabel--test' : ''}`}>{e.seal?.selfIssued ? 'Self-issued test seal · not independently trusted' : e.seal ? 'Certificate seal present · issuer trust varies' : 'Fingerprint recorded · no PDF certificate seal'}</span><details className="sc__sealDetails"><summary>Sealed copy details</summary><p><strong>SHA-256 fingerprint</strong><code>{e.final_sha256}</code></p>{e.seal && <p><strong>Certificate</strong><span>{e.seal.subject}{e.seal.selfIssued ? ' (self-issued)' : ''}</span></p>}{e.seal_timestamp?.time ? <p><strong>Time stamp</strong><span>{day(e.seal_timestamp.time)} · {e.seal_timestamp.authority}</span></p> : e.seal_timestamp?.missing ? <p><strong>Time stamp</strong><span>{e.seal_timestamp.missing}</span></p> : null}</details></>}
        </div>
      </div>
      <div className="sc__detailSections">
        <div className="mx__card"><div className="mx__cardHead"><h3>Signers</h3><small>{e.routing === 'parallel' ? 'all at once' : 'in order'}</small></div>
          <div className="mx__people sc__signerList" style={{ paddingTop: 12 }}>{detail.recipients.map((r) => <div key={r.id} className={`mx__person sc__signer ${['signed', 'viewed', 'sent'].includes(r.status) ? 'is-present' : ''}`}>
            <span className={`mx__avatar ${r.status === 'signed' ? 'mx__avatar--on' : ''}`} style={{ marginLeft: 0, ...(r.status === 'declined' ? { background: '#b0463f', color: '#fff' } : {}) }}>{initials(r.name)}</span>
            <span className="mx__personText"><strong>{r.name}{r.title ? `, ${r.title}` : ''}</strong><small>{r.email} · {r.role === 'cc' ? 'copy' : r.party ? `for ${r.party}` : `signer ${r.routing_order}`}{r.verify_by !== 'email' ? ` · ${r.verify_by === 'sms' ? 'text code' : 'email + text'}` : ''}{r.register_match ? ` · ${r.register_match.officer ? `listed as ${r.register_match.officer.role}` : 'not listed at the register'}` : ''}<br />{r.signed_at ? `signed ${day(r.signed_at)}` : r.declined_at ? `declined ${day(r.declined_at)}${r.decline_reason ? `: ${r.decline_reason}` : ''}` : r.verified_at ? `verified ${day(r.verified_at)}` : r.viewed_at ? `opened ${day(r.viewed_at)}` : r.notified_at ? `emailed ${day(r.notified_at)}${r.last_reminded_at ? ` · reminded ${day(r.last_reminded_at)}` : ''}` : 'waiting for their turn'}</small></span>
            <div className="sc__signerActions"><Pill s={r.status} />
            {e.status === 'sent' && r.role === 'signer' && !r.party_id && ['waiting', 'sent', 'viewed'].includes(r.status) && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setCorrecting({ id: r.id, name: r.name, email: r.email, reason: '' })}>Correct</button>}
            {e.status === 'sent' && r.role === 'signer' && ['sent', 'viewed'].includes(r.status) && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setEmbedFor({ id: r.id, name: r.name }); setEmbedLink(''); }}>Embed</button>}
            </div>
          </div>)}</div>
          {correcting && <form className="sc__correction" onSubmit={(ev) => { ev.preventDefault(); void act(async () => { await postJson(`/api/sign/envelopes/${e.id}/recipients/${correcting.id}/correct`, correcting); await open(e.id, 'detail'); return 'Signer corrected. The old link was revoked; a new invitation was sent when their stage is active.'; }); }}><h4>Correct a signer</h4><p>Use this for a name or email mistake before they sign. Their previous link will stop working.</p><label>Name<input required minLength={2} value={correcting.name} onChange={(ev) => setCorrecting({ ...correcting, name: ev.target.value })} /></label><label>Email<input required type="email" value={correcting.email} onChange={(ev) => setCorrecting({ ...correcting, email: ev.target.value })} /></label><label>Reason<input required value={correcting.reason} onChange={(ev) => setCorrecting({ ...correcting, reason: ev.target.value })} placeholder="e.g. Corrected email address" /></label><div><button type="submit" className="mx__btn mx__btn--sm" disabled={busy}>Save correction</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setCorrecting(null)}>Cancel</button></div></form>}
          {embedFor && <div className="sc__correction"><h4>Embed signing for {embedFor.name}</h4><p>Enter the exact address of the site that will show the signing frame. The embed link lasts 15 minutes; the signer still verifies their identity.</p><label>Allowed site origin<input type="url" value={embedOrigin} onChange={(ev) => setEmbedOrigin(ev.target.value)} placeholder="https://your-company.com" /></label><div><button type="button" className="mx__btn mx__btn--sm" disabled={busy || !embedOrigin} onClick={() => void act(async () => { const result = await postJson<{ url: string }>(`/api/sign/envelopes/${e.id}/recipients/${embedFor.id}/embed`, { origin: embedOrigin.trim() }); setEmbedLink(result.url); return 'Embedded signing link ready. It expires in 15 minutes.'; })}>Create embed link</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setEmbedFor(null)}>Close</button></div>{embedLink && <label>Embed code<textarea readOnly rows={3} value={`<iframe src="${embedLink}" title="Sign with Patform" style="width:100%;height:720px;border:0"></iframe>`} onFocus={(ev) => ev.target.select()} /></label>}</div>}
          {detail.parties.length > 0 && <div className="mx__cardBody">{detail.parties.map((p) => <p key={p.id} className="mx__tiny"><strong>{p.name}</strong>: {p.signed} of {p.required_count} required signature(s){p.completed_at ? ' — done' : ''}{p.authority_note ? ` · authority: ${p.authority_note}` : ''}{p.register ? <><br />{p.register.available ? `${p.register.source} (${p.register.country} ${p.register.number}): ${p.register.companyName ?? 'not found'}${p.register.status ? `, ${p.register.status}` : ''}, checked ${day(p.register.checkedAt)}${p.register_required ? ' · listed officers only' : ''}` : `Register check not available: ${p.register.reason}`}</> : null}</p>)}</div>}
        </div>
        <div className="mx__card sc__record"><div className="mx__cardHead"><h3>Activity record</h3><small>{detail.events.length} events</small></div><ol className="sc__eventList">{detail.events.map((ev, i) => <li key={i}><time dateTime={ev.occurred_at}>{day(ev.occurred_at)}</time><strong>{ev.kind.replace(/_/g, ' ')}</strong><span>{ev.recipient ?? 'Workspace'}</span></li>)}</ol></div>
        {detail.attachments.length > 0 && <div className="mx__card"><div className="mx__cardHead"><h3>Supporting files</h3><small>{detail.attachments.length}</small></div><ul className="mx__list">{detail.attachments.map((file) => <li key={file.id}><div className="mx__main"><strong>{file.filename}</strong><small>{detail.recipients.find((r) => r.id === file.recipient_id)?.name} · SHA-256 {file.sha256}</small></div><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(async () => { const res = await fetch(`/api/sign/envelopes/${e.id}/attachments/${file.id}`); if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.reason ?? 'The file is not ready to open.'); } const url = URL.createObjectURL(await res.blob()); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000); })}>Open</button></li>)}</ul></div>}
      </div>
    </div>; })()}
  </div>;
}
