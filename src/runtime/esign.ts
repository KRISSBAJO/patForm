/**
 * Patform Sign: electronic signature built into Patform (PRD GOV-03).
 *
 * How a signature is made trustworthy here:
 *   - Attribution: each signer opens a personal link (only its hash is
 *     stored) and then proves control of their email address with a
 *     one-time code. Five wrong codes lock the code; codes expire in ten
 *     minutes; sends are rate-limited.
 *   - Intent and consent: the signer agrees to sign electronically, in
 *     words that are stored with the time, before anything is signed, and
 *     signs with the draw-or-type pad, their name printed with it.
 *   - Integrity: the original document's SHA-256 is taken when the envelope
 *     is made and checked again before sealing. The finished PDF carries the
 *     signatures and a certificate of completion, and its own SHA-256 is
 *     kept, so any copy can be checked on the public verify page.
 *   - Record: every step — sent, opened, code sent, verified, consented,
 *     signed, declined, voided, reminded, completed — is an append-only
 *     event with time, IP address and browser.
 * This is a simple electronic signature. It is what most commercial
 * contracts need; documents that the law requires to carry a qualified
 * signature (some deeds and wills, in some countries) need a qualified
 * provider.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { objectStore } from './object-store.js';
import { appUrl, sendPlatformMail, type PlatformMailKind } from './platform-mail.js';
import { seal, open as unseal } from './secret-box.js';
import { signatureProblem, type SignatureValue } from '../blueprint/signature.js';
import { govContractFor, govInTeam, govMember, GOV_FILE_REF } from './gov.js';
import { sealPdf, pageCount } from './esign-pdf.js';

const UUID = /^[0-9a-f-]{36}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const CODE_MINUTES = 10; const SESSION_HOURS = 2; const FINAL_DAYS = 30;
export const CONSENT_TEXT = 'I agree to use electronic records and signatures for this document. I understand my electronic signature is as binding as a signature on paper, and that I can ask the sender for a paper copy.';

export interface Ctx { ip?: string | null; userAgent?: string | null }

// ------------------------------------------------------------------ mail

type Mail = { kind: PlatformMailKind; to: string; subject: string; text: string; tenantId: string; idempotencyKey: string };
let mailer: (pool: Pool | Client, m: Mail) => Promise<void> = async (pool, m) => { await sendPlatformMail(pool as Pool, m); };
/** Tests read the codes and links Patform would have emailed. */
export function setSignMailerForTests(fn: ((pool: Pool | Client, m: Mail) => Promise<void>) | null) {
  mailer = fn ?? (async (pool, m) => { await sendPlatformMail(pool as Pool, m); });
}

async function event(client: Client | Pool, envelopeId: string, recipientId: string | null, kind: string, detail: Record<string, unknown> = {}, ctx: Ctx = {}) {
  await client.query('insert into sign_event (envelope_id, recipient_id, kind, detail, ip, user_agent) values ($1, $2, $3, $4, $5, $6)',
    [envelopeId, recipientId, kind, JSON.stringify(detail), ctx.ip?.slice(0, 80) ?? null, ctx.userAgent?.slice(0, 300) ?? null]);
}

// ---------------------------------------------------------------- sender

interface EnvelopeRow { id: string; tenant_id: string; number: number; title: string; message: string | null; contract_id: string | null; contract_version: number | null; document_file_id: string; original_sha256: string;
  page_count: number; routing: 'sequential' | 'parallel'; status: string; reminder_days: number; expires_at: Date; created_by: string | null; completed_at: Date | null; final_file_id: string | null; final_sha256: string | null }

async function envelopeFor(client: Client | Pool, principal: Principal, envelopeId: string, lock = false) {
  const w = await govMember(client, principal);
  if (!UUID.test(envelopeId)) throw new InvalidInput('no such envelope');
  const { rows } = await client.query<EnvelopeRow>(`select * from sign_envelope where id = $1 and tenant_id = $2 ${lock ? 'for update' : ''}`, [envelopeId, w.tenantId]);
  const e = rows[0];
  if (!e) throw new InvalidInput('no such envelope');
  if (e.contract_id) await govContractFor(client, w, e.contract_id);
  else if (!(e.created_by === w.actorId || govInTeam(w, 'legal', 'compliance'))) throw new InvalidInput('no such envelope');
  return { w, e };
}

async function nextNumber(client: Client, tenantId: string) {
  await client.query('select pg_advisory_xact_lock(hashtext($1 || $2))', ['sign_envelope', tenantId]);
  const { rows } = await client.query<{ n: number }>('select coalesce(max(number), 1000) + 1 as n from sign_envelope where tenant_id = $1', [tenantId]);
  return rows[0]!.n;
}

interface RecipientIn { name: string; email: string; role: 'signer' | 'cc'; order: number }
function readRecipients(v: unknown): RecipientIn[] {
  const list = (Array.isArray(v) ? v : []).map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const r: RecipientIn = { name: text(o.name, 120), email: text(o.email, 200).toLowerCase(), role: o.role === 'cc' ? 'cc' : 'signer', order: Math.max(1, Math.trunc(Number(o.order ?? i + 1)) || i + 1) };
    if (r.name.length < 2 || !EMAIL.test(r.email)) throw new InvalidInput(`recipient ${i + 1} needs a name and an email address`);
    return r;
  });
  if (!list.some((r) => r.role === 'signer')) throw new InvalidInput('add at least one signer');
  if (list.length > 20) throw new InvalidInput('at most 20 recipients');
  if (new Set(list.map((r) => `${r.email}:${r.role}`)).size !== list.length) throw new InvalidInput('the same person is listed twice');
  return list;
}

/** A draft: a contract's current document, or any uploaded PDF, with its recipients. */
export async function createEnvelope(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await govMember(pool, principal);
  const recipients = readRecipients(body.recipients);
  const routing = body.routing === 'parallel' ? 'parallel' : 'sequential';
  const days = body.expiresInDays === undefined ? 30 : Math.trunc(Number(body.expiresInDays));
  if (!(days >= 1 && days <= 365)) throw new InvalidInput('expiresInDays must be 1 to 365');
  const reminder = body.reminderDays === undefined ? 3 : Math.trunc(Number(body.reminderDays));
  if (!(reminder >= 0 && reminder <= 30)) throw new InvalidInput('reminderDays must be 0 to 30');
  let fileId: string; let contractId: string | null = null; let version: number | null = null; let title = text(body.title, 200);
  if (body.contractId) {
    contractId = text(body.contractId, 36);
    const c = await govContractFor(pool, w, contractId);
    if (c.owner_id !== w.actorId && !govInTeam(w, 'legal')) throw new InvalidInput('the owner or Legal sends a contract for signature');
    if (c.status !== 'approved') throw new InvalidInput('only a contract approved in its current version can go for signature');
    const { rows } = await pool.query<{ document_ref: string | null }>('select document_ref from contract_version where contract_id = $1 and version = $2', [contractId, c.current_version]);
    const m = GOV_FILE_REF.exec(rows[0]?.document_ref ?? '');
    if (!m) throw new InvalidInput('upload the contract document (PDF) to this version first');
    fileId = m[1]!; version = c.current_version; title = title || c.title;
  } else {
    const m = GOV_FILE_REF.exec(text(body.documentRef, 60));
    if (!m) throw new InvalidInput('upload the PDF to be signed first');
    fileId = m[1]!;
    if (!title) throw new InvalidInput('give the envelope a title');
  }
  const { rows: f } = await pool.query<{ content_type: string; storage_key: string; scan_status: string; purpose: string; sha256: string }>(
    'select content_type, storage_key, scan_status, purpose, sha256 from gov_file where id = $1 and tenant_id = $2', [fileId, w.tenantId]);
  if (!f[0]) throw new InvalidInput('no such document');
  if (f[0].content_type !== 'application/pdf') throw new InvalidInput('Patform Sign signs PDFs; save the Word file as PDF and upload that');
  if (!contractId && !['signing', 'contract'].includes(f[0].purpose)) throw new InvalidInput('that file was not uploaded for signing');
  const scan = await objectStore().scan(f[0].storage_key);
  if (scan !== 'clean') throw new InvalidInput(scan === 'scanning' ? 'the document is still being checked for malware; try again shortly' : 'the document failed its malware check');
  const bytes = await objectStore().get(f[0].storage_key);
  if (hash(bytes) !== f[0].sha256) throw new InvalidInput('the stored document does not match what was uploaded');
  const pages = await pageCount(bytes).catch((err: Error) => { throw new InvalidInput(err.message); });
  const docSha = f[0].sha256;
  return inTransaction(pool, async (client) => {
    const number = await nextNumber(client, w.tenantId);
    const { rows } = await client.query<{ id: string }>(
      `insert into sign_envelope (tenant_id, number, title, message, contract_id, contract_version, document_file_id, original_sha256, page_count, routing, reminder_days, expires_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(days => $12), $13) returning id`,
      [w.tenantId, number, title, text(body.message, 2000) || null, contractId, version, fileId, docSha, pages, routing, reminder, days, w.actorId]);
    const envelopeId = rows[0]!.id;
    const ids: string[] = [];
    for (const r of recipients) {
      const { rows: a } = await client.query<{ id: string }>('select id from actor where tenant_id = $1 and lower(email) = $2 and active', [w.tenantId, r.email]);
      const { rows: made } = await client.query<{ id: string }>(`insert into sign_recipient (envelope_id, name, email, role, routing_order, actor_id) values ($1, $2, $3, $4, $5, $6) returning id`,
        [envelopeId, r.name, r.email, r.role, routing === 'parallel' ? 1 : r.order, a[0]?.id ?? null]);
      ids.push(made[0]!.id);
    }
    await event(client, envelopeId, null, 'created', { by: w.actorId, sha256: docSha, pages });
    return { id: envelopeId, number, pages, recipients: ids };
  });
}

/** Fields are placed on the pages as fractions of the page, from the top left, as the screen shows them. */
export async function setFields(pool: Pool, principal: Principal, envelopeId: string, body: Record<string, unknown>) {
  return inTransaction(pool, async (client) => {
    const { e } = await envelopeFor(client, principal, envelopeId, true);
    if (e.status !== 'draft') throw new InvalidInput('fields can only change before the envelope is sent');
    const { rows: rec } = await client.query<{ id: string; role: string }>('select id, role from sign_recipient where envelope_id = $1', [envelopeId]);
    const fields = (Array.isArray(body.fields) ? body.fields : []).map((x, i) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const kind = text(o.kind, 20);
      if (!['signature', 'initials', 'date', 'name', 'text'].includes(kind)) throw new InvalidInput(`field ${i + 1}: kind must be signature, initials, date, name or text`);
      const r = rec.find((y) => y.id === o.recipientId);
      if (!r || r.role !== 'signer') throw new InvalidInput(`field ${i + 1} must belong to a signer`);
      const n = (k: string) => Number(o[k]);
      const page = Math.trunc(n('page'));
      if (!(page >= 1 && page <= e.page_count)) throw new InvalidInput(`field ${i + 1}: the document has ${e.page_count} page(s)`);
      const [x0, y0, wd, ht] = [n('x'), n('y'), n('width'), n('height')];
      if (![x0, y0, wd, ht].every(Number.isFinite) || x0 < 0 || y0 < 0 || wd <= 0 || ht <= 0 || x0 + wd > 1.0001 || y0 + ht > 1.0001) throw new InvalidInput(`field ${i + 1} is off the page`);
      return { recipientId: r.id, kind, page, x: x0, y: y0, width: wd, height: ht, required: o.required !== false, label: text(o.label, 120) || null };
    });
    if (fields.length > 400) throw new InvalidInput('at most 400 fields');
    await client.query('delete from sign_field where envelope_id = $1', [envelopeId]);
    for (const fl of fields) await client.query(`insert into sign_field (envelope_id, recipient_id, kind, page, x, y, width, height, required, label) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [envelopeId, fl.recipientId, fl.kind, fl.page, fl.x, fl.y, fl.width, fl.height, fl.required, fl.label]);
    return { fields: fields.length };
  });
}

/** Emails the next signers their personal links (in order, or all at once). */
async function notifyNext(client: Client | Pool, e: EnvelopeRow, from: string) {
  const { rows: pending } = await client.query<{ id: string; name: string; email: string; routing_order: number; role: string; status: string }>(
    `select id, name, email, routing_order, role, status from sign_recipient where envelope_id = $1 and role = 'signer' and status in ('waiting', 'sent', 'viewed') order by routing_order`, [e.id]);
  if (!pending.length) return 0;
  const next = e.routing === 'parallel' ? pending : pending.filter((p) => p.routing_order === pending[0]!.routing_order);
  let sent = 0;
  for (const r of next.filter((p) => p.status === 'waiting')) {
    const t = token();
    await client.query(`update sign_recipient set status = 'sent', token_hash = $2, token_sealed = $3, notified_at = now() where id = $1`, [r.id, hash(t), seal(t, `sign_recipient:${r.id}`)]);
    await mailer(client, { kind: 'signature_request', to: r.email, tenantId: e.tenant_id, idempotencyKey: `sign-request:${r.id}`,
      subject: `Please sign: ${e.title}`,
      text: `Hello ${r.name},\n\n${from} has asked you to sign "${e.title}".${e.message ? `\n\n${e.message}` : ''}\n\nReview and sign here: ${appUrl()}/sign/${t}\n\nThis link is personal to you; do not forward it. We will email you a code to confirm it is you. It expires on ${e.expires_at.toISOString().slice(0, 10)}.\n\nSent with Patform Sign.` });
    await event(client, e.id, r.id, 'sent', { to: r.email });
    sent++;
  }
  return sent;
}

export async function sendEnvelope(pool: Pool, principal: Principal, envelopeId: string) {
  return inTransaction(pool, async (client) => {
    const { w, e } = await envelopeFor(client, principal, envelopeId, true);
    if (e.status !== 'draft') throw new InvalidInput('this envelope has already been sent');
    if (e.contract_id) {
      const c = await govContractFor(client, w, e.contract_id, true);
      if (c.status !== 'approved' || c.current_version !== e.contract_version) throw new InvalidInput('the contract has changed since this envelope was made; make a new one');
    }
    const { rows: from } = await client.query<{ display_name: string; name: string }>('select a.display_name, t.name from actor a join tenant t on t.id = a.tenant_id where a.id = $1', [w.actorId]);
    await client.query(`update sign_envelope set status = 'sent', sent_at = now() where id = $1`, [envelopeId]);
    const sent = await notifyNext(client, { ...e, status: 'sent' }, `${from[0]!.display_name} (${from[0]!.name})`);
    if (e.contract_id) {
      await client.query(`insert into contract_envelope (contract_id, version, provider, envelope_ref, history, created_by) values ($1, $2, 'Patform Sign', $3, $4, $5)`,
        [e.contract_id, e.contract_version, `PS-${e.number}`, JSON.stringify([{ at: new Date().toISOString(), status: 'sent', via: 'patform-sign', envelope: e.id }]), w.actorId]);
      await client.query(`update contract set status = 'out_for_signature', updated_at = now() where id = $1`, [e.contract_id]);
    }
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'sign.envelope_sent', targetId: envelopeId, detail: { number: e.number, title: e.title } });
    return { id: envelopeId, status: 'sent', notified: sent };
  });
}

async function closeContractEnvelope(client: Client | Pool, e: EnvelopeRow, status: 'completed' | 'declined' | 'voided', artifact: string | null) {
  if (!e.contract_id) return;
  await client.query(`update contract_envelope set status = $3, signed_artifact_ref = coalesce($4, signed_artifact_ref), updated_at = now(), history = history || $5::jsonb
                       where contract_id = $1 and envelope_ref = $2 and status in ('sent', 'delivered')`,
    [e.contract_id, `PS-${e.number}`, status, artifact, JSON.stringify([{ at: new Date().toISOString(), status, via: 'patform-sign' }])]);
  if (status === 'completed') {
    await client.query(`update contract set status = 'signed', updated_at = now() where id = $1 and current_version = $2`, [e.contract_id, e.contract_version]);
  } else {
    await client.query(`update contract set status = 'approved', updated_at = now() where id = $1 and status = 'out_for_signature'
                          and not exists (select 1 from contract_envelope where contract_id = $1 and status in ('sent', 'delivered'))`, [e.contract_id]);
  }
}

export async function voidEnvelope(pool: Pool, principal: Principal, envelopeId: string, body: Record<string, unknown>) {
  const reason = text(body.reason, 500);
  if (!reason) throw new InvalidInput('say why it is cancelled');
  return inTransaction(pool, async (client) => {
    const { w, e } = await envelopeFor(client, principal, envelopeId, true);
    if (!['draft', 'sent'].includes(e.status)) throw new InvalidInput(`this envelope is ${e.status}`);
    await client.query(`update sign_envelope set status = 'voided', voided_at = now(), void_reason = $2 where id = $1`, [envelopeId, reason]);
    await event(client, envelopeId, null, 'voided', { by: w.actorId, reason });
    await closeContractEnvelope(client, e, 'voided', null);
    const { rows } = await client.query<{ email: string; name: string }>(`select email, name from sign_recipient where envelope_id = $1 and status in ('sent', 'viewed', 'signed')`, [envelopeId]);
    for (const r of rows) await mailer(client, { kind: 'signature_declined', to: r.email, tenantId: e.tenant_id, idempotencyKey: `sign-void:${envelopeId}:${r.email}`, subject: `Cancelled: ${e.title}`, text: `Hello ${r.name},\n\nThe request to sign "${e.title}" has been cancelled by the sender: ${reason}\n\nNothing more is needed from you.` });
    return { id: envelopeId, status: 'voided' };
  });
}

export async function listEnvelopes(pool: Pool, principal: Principal) {
  const w = await govMember(pool, principal);
  const all = govInTeam(w, 'legal', 'compliance');
  const { rows } = await pool.query(
    `select e.id, e.number, e.title, e.status, e.routing, e.created_at, e.sent_at, e.completed_at, e.expires_at, e.final_sha256, e.contract_id, c.title as contract,
            (select count(*)::int from sign_recipient r where r.envelope_id = e.id and r.role = 'signer') as signers,
            (select count(*)::int from sign_recipient r where r.envelope_id = e.id and r.role = 'signer' and r.status = 'signed') as signed
       from sign_envelope e left join contract c on c.id = e.contract_id
      where e.tenant_id = $1 and ($2 or e.created_by = $3 or c.owner_id = $3) order by e.created_at desc limit 200`, [w.tenantId, all, w.actorId]);
  return rows;
}

export async function envelopeDetail(pool: Pool, principal: Principal, envelopeId: string) {
  const { e } = await envelopeFor(pool, principal, envelopeId);
  const { rows: recipients } = await pool.query(
    `select id, name, email, role, routing_order, status, notified_at, viewed_at, verified_at, consented_at, signed_at, declined_at, decline_reason, last_reminded_at from sign_recipient where envelope_id = $1 order by role, routing_order, created_at`, [envelopeId]);
  const { rows: fields } = await pool.query(`select id, recipient_id, kind, page, x::float, y::float, width::float, height::float, required, label, (value is not null) as filled from sign_field where envelope_id = $1 order by page, y`, [envelopeId]);
  const { rows: events } = await pool.query(`select v.kind, v.detail, v.ip, v.occurred_at, r.name as recipient from sign_event v left join sign_recipient r on r.id = v.recipient_id where v.envelope_id = $1 order by v.id`, [envelopeId]);
  return { envelope: e, recipients, fields, events };
}

/** The document's bytes for the sender's field placement and preview, or the sealed copy once complete. */
export async function envelopeDocument(pool: Pool, principal: Principal, envelopeId: string): Promise<Buffer> {
  const { e } = await envelopeFor(pool, principal, envelopeId);
  return documentBytes(pool, e.final_file_id ?? e.document_file_id);
}
async function documentBytes(client: Client | Pool, fileId: string): Promise<Buffer> {
  const { rows } = await client.query<{ storage_key: string; sha256: string }>('select storage_key, sha256 from gov_file where id = $1', [fileId]);
  const bytes = await objectStore().get(rows[0]!.storage_key);
  if (hash(bytes) !== rows[0]!.sha256) throw new InvalidInput('the stored document does not match its fingerprint; it will not be shown');
  return bytes;
}

export async function remindNow(pool: Pool, principal: Principal, envelopeId: string) {
  const { e } = await envelopeFor(pool, principal, envelopeId);
  if (e.status !== 'sent') throw new InvalidInput('only an envelope out for signature gets reminders');
  return { reminded: await remind(pool, e, true) };
}

async function remind(client: Client | Pool, e: EnvelopeRow, force: boolean) {
  const { rows } = await client.query<{ id: string; name: string; email: string; token_sealed: string | null }>(
    `select id, name, email, token_sealed from sign_recipient where envelope_id = $1 and role = 'signer' and status in ('sent', 'viewed')
        and ($2 or coalesce(last_reminded_at, notified_at) < now() - make_interval(days => $3))`, [e.id, force, Math.max(1, e.reminder_days)]);
  for (const r of rows) {
    if (!r.token_sealed) continue;
    const t = unseal(r.token_sealed, `sign_recipient:${r.id}`).plaintext;
    await mailer(client, { kind: 'signature_reminder', to: r.email, tenantId: e.tenant_id, idempotencyKey: `sign-remind:${r.id}:${Date.now()}`, subject: `Reminder: please sign ${e.title}`,
      text: `Hello ${r.name},\n\nA reminder that "${e.title}" is waiting for your signature: ${appUrl()}/sign/${t}\n\nIt expires on ${e.expires_at.toISOString().slice(0, 10)}.` });
    await client.query('update sign_recipient set last_reminded_at = now() where id = $1', [r.id]);
    await event(client, e.id, r.id, 'reminded', {});
  }
  return rows.length;
}

/** The worker: reminders on schedule, and envelopes past their date expire. */
export async function sweepSignatures(pool: Pool) {
  const { rows: due } = await pool.query<EnvelopeRow>(`select * from sign_envelope where status = 'sent' and reminder_days > 0 and expires_at > now()`);
  let reminded = 0;
  for (const e of due) reminded += await remind(pool, e, false);
  const { rows: expired } = await pool.query<EnvelopeRow>(`update sign_envelope set status = 'expired' where status = 'sent' and expires_at <= now() returning *`);
  for (const e of expired) { await event(pool, e.id, null, 'expired', {}); await closeContractEnvelope(pool, e, 'voided', null); }
  return { reminded, expired: expired.length };
}

// ---------------------------------------------------------------- signer

interface RecipientRow { id: string; envelope_id: string; name: string; email: string; role: string; routing_order: number; status: string; otp_hash: string | null; otp_expires_at: Date | null; otp_attempts: number;
  otp_sent_count: number; otp_window_start: Date | null; session_hash: string | null; session_expires_at: Date | null; verified_at: Date | null; consented_at: Date | null; signed_at: Date | null }

async function byToken(client: Client | Pool, t: string, lock = false) {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(t)) throw new InvalidInput('this link is not valid');
  const { rows } = await client.query<RecipientRow & { e_status: string; tenant_id: string; expires_at: Date; title: string; message: string | null; workspace: string; sender: string | null; completed_at: Date | null; page_count: number }>(
    `select r.*, e.status as e_status, e.tenant_id, e.expires_at, e.title, e.message, e.completed_at, e.page_count, t.name as workspace, a.display_name as sender
       from sign_recipient r join sign_envelope e on e.id = r.envelope_id join tenant t on t.id = e.tenant_id left join actor a on a.id = e.created_by
      where r.token_hash = $1 ${lock ? 'for update of r' : ''}`, [hash(t)]);
  if (!rows[0]) throw new InvalidInput('this link is not valid');
  return rows[0];
}
function sessionOk(r: { session_hash: string | null; session_expires_at: Date | null }, session: string | undefined) {
  if (!session || !r.session_hash || !r.session_expires_at || r.session_expires_at < new Date()) return false;
  const a = Buffer.from(hash(session)); const b = Buffer.from(r.session_hash);
  return a.length === b.length && timingSafeEqual(a, b);
}
const mask = (email: string) => email.replace(/^(.)(.*)(@.*)$/, (_, a: string, b: string, c: string) => `${a}${'•'.repeat(Math.min(6, b.length))}${c}`);

/** What the signing page shows. Nothing about the document until the code is verified. */
export async function signerView(pool: Pool, t: string, session?: string) {
  const r = await byToken(pool, t);
  const base = { title: r.title, workspace: r.workspace, sender: r.sender, name: r.name, email: mask(r.email), expiresAt: r.expires_at };
  if (r.e_status === 'completed') return { ...base, stage: 'completed' as const, completedAt: r.completed_at };
  if (r.e_status !== 'sent' || r.expires_at < new Date()) return { ...base, stage: 'closed' as const, status: r.e_status === 'sent' ? 'expired' : r.e_status };
  if (r.status === 'signed') return { ...base, stage: 'signed' as const };
  if (r.status === 'declined') return { ...base, stage: 'closed' as const, status: 'declined' };
  if (!sessionOk(r, session)) return { ...base, stage: 'verify' as const };
  const { rows: fields } = await pool.query(`select id, kind, page, x::float, y::float, width::float, height::float, required, label from sign_field where recipient_id = $1 order by page, y, x`, [r.id]);
  return { ...base, stage: 'sign' as const, message: r.message, pages: r.page_count, consented: Boolean(r.consented_at), consentText: CONSENT_TEXT, fields };
}

export async function requestCode(pool: Pool, t: string, ctx: Ctx = {}) {
  return inTransaction(pool, async (client) => {
    const r = await byToken(client, t, true);
    if (r.e_status !== 'sent' || !['sent', 'viewed'].includes(r.status)) throw new InvalidInput('this document is not waiting for your signature');
    const windowStart = r.otp_window_start && r.otp_window_start > new Date(Date.now() - 3600_000) ? r.otp_window_start : new Date();
    const count = windowStart === r.otp_window_start ? r.otp_sent_count : 0;
    if (count >= 5) throw new InvalidInput('too many codes sent; try again in an hour');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await client.query(`update sign_recipient set otp_hash = $2, otp_expires_at = now() + make_interval(mins => $3), otp_attempts = 0, otp_sent_count = $4, otp_window_start = $5 where id = $1`,
      [r.id, hash(`${r.id}:${code}`), CODE_MINUTES, count + 1, windowStart]);
    await mailer(client, { kind: 'signature_code', to: r.email, tenantId: r.tenant_id, idempotencyKey: `sign-code:${r.id}:${Date.now()}`, subject: `Your Patform Sign code`,
      text: `Your code to open "${r.title}" is ${code}.\n\nIt expires in ${CODE_MINUTES} minutes. If you did not ask for it, ignore this email.` });
    await event(client, r.envelope_id, r.id, 'code_sent', {}, ctx);
    return { sentTo: mask(r.email) };
  });
}

export async function verifyCode(pool: Pool, t: string, code: unknown, ctx: Ctx = {}) {
  // A wrong code is counted and committed before it is refused; refusing inside
  // the transaction would undo the count, and the lock would never close.
  const out = await inTransaction(pool, async (client): Promise<{ session: string } | { wrong: true }> => {
    const r = await byToken(client, t, true);
    if (r.e_status !== 'sent' || !['sent', 'viewed'].includes(r.status)) throw new InvalidInput('this document is not waiting for your signature');
    if (!r.otp_hash || !r.otp_expires_at || r.otp_expires_at < new Date()) throw new InvalidInput('the code has expired; ask for a new one');
    if (r.otp_attempts >= 5) throw new InvalidInput('too many wrong codes; ask for a new one');
    const given = hash(`${r.id}:${text(code, 10)}`);
    if (given !== r.otp_hash) {
      await client.query('update sign_recipient set otp_attempts = otp_attempts + 1 where id = $1', [r.id]);
      await event(client, r.envelope_id, r.id, 'code_wrong', {}, ctx);
      return { wrong: true };
    }
    const session = token();
    await client.query(`update sign_recipient set otp_hash = null, session_hash = $2, session_expires_at = now() + make_interval(hours => $3), verified_at = coalesce(verified_at, now()),
                          viewed_at = coalesce(viewed_at, now()), status = 'viewed', ip = $4, user_agent = $5 where id = $1`, [r.id, hash(session), SESSION_HOURS, ctx.ip ?? null, ctx.userAgent?.slice(0, 300) ?? null]);
    await event(client, r.envelope_id, r.id, 'verified', { method: 'email code' }, ctx);
    return { session };
  });
  if ('wrong' in out) throw new InvalidInput('that code is not right');
  return out;
}

export async function signerDocument(pool: Pool, t: string, session: string | undefined): Promise<Buffer> {
  const r = await byToken(pool, t);
  if (!sessionOk(r, session)) throw new InvalidInput('confirm it is you first');
  const { rows } = await pool.query<{ document_file_id: string }>('select document_file_id from sign_envelope where id = $1', [r.envelope_id]);
  return documentBytes(pool, rows[0]!.document_file_id);
}

export async function giveConsent(pool: Pool, t: string, session: string | undefined, ctx: Ctx = {}) {
  const r = await byToken(pool, t);
  if (!sessionOk(r, session)) throw new InvalidInput('confirm it is you first');
  await pool.query('update sign_recipient set consented_at = coalesce(consented_at, now()), consent_text = $2 where id = $1', [r.id, CONSENT_TEXT]);
  await event(pool, r.envelope_id, r.id, 'consented', { text: CONSENT_TEXT }, ctx);
  return { consented: true };
}

/** Signs: every required field filled, the signature checked, then routing moves on or the envelope is sealed. */
export async function signDocument(pool: Pool, t: string, session: string | undefined, body: Record<string, unknown>, ctx: Ctx = {}) {
  const sealed = await inTransaction(pool, async (client) => {
    const r = await byToken(client, t, true);
    if (!sessionOk(r, session)) throw new InvalidInput('confirm it is you first');
    if (r.e_status !== 'sent' || r.expires_at < new Date()) throw new InvalidInput('this document is no longer waiting for signatures');
    if (!['sent', 'viewed'].includes(r.status)) throw new InvalidInput('you have already responded');
    if (!r.consented_at) throw new InvalidInput('agree to sign electronically first');
    const signature = body.signature as SignatureValue;
    const problem = signatureProblem(signature);
    if (problem) throw new InvalidInput(problem);
    const initials = body.initials as SignatureValue | undefined;
    const values = (body.values && typeof body.values === 'object' ? body.values : {}) as Record<string, unknown>;
    const { rows: fields } = await client.query<{ id: string; kind: string; required: boolean; label: string | null }>('select id, kind, required, label from sign_field where recipient_id = $1', [r.id]);
    if (fields.some((f) => f.kind === 'initials') && signatureProblem(initials)) throw new InvalidInput('add your initials');
    const today = new Date().toISOString().slice(0, 10);
    for (const f of fields) {
      let value: string | null = null;
      if (f.kind === 'signature') value = 'signature';
      else if (f.kind === 'initials') value = 'initials';
      else if (f.kind === 'date') value = today;
      else if (f.kind === 'name') value = signature.name.trim();
      else { value = text(values[f.id], 500) || null; if (!value && f.required) throw new InvalidInput(`fill in "${f.label ?? 'the text field'}"`); }
      await client.query('update sign_field set value = $2, filled_at = now() where id = $1', [f.id, value]);
    }
    await client.query(`update sign_recipient set status = 'signed', signed_at = now(), signature = $2, initials = $3, ip = $4, user_agent = $5, session_hash = null where id = $1`,
      [r.id, JSON.stringify(signature), initials ? JSON.stringify(initials) : null, ctx.ip ?? null, ctx.userAgent?.slice(0, 300) ?? null]);
    await event(client, r.envelope_id, r.id, 'signed', { method: signature.method, name: signature.name.trim(), fields: fields.length }, ctx);
    const { rows: e } = await client.query<EnvelopeRow>('select * from sign_envelope where id = $1 for update', [r.envelope_id]);
    const { rows: left } = await client.query<{ n: number }>(`select count(*)::int as n from sign_recipient where envelope_id = $1 and role = 'signer' and status <> 'signed'`, [r.envelope_id]);
    if (left[0]!.n > 0) { await notifyNext(client, e[0]!, r.sender ? `${r.sender} (${r.workspace})` : r.workspace); return null; }
    return e[0]!;
  });
  if (sealed) await completeEnvelope(pool, sealed);
  return { signed: true, completed: Boolean(sealed) };
}

export async function declineDocument(pool: Pool, t: string, session: string | undefined, body: Record<string, unknown>, ctx: Ctx = {}) {
  const reason = text(body.reason, 1000);
  if (!reason) throw new InvalidInput('say why you are declining');
  return inTransaction(pool, async (client) => {
    const r = await byToken(client, t, true);
    if (!sessionOk(r, session)) throw new InvalidInput('confirm it is you first');
    if (r.e_status !== 'sent' || !['sent', 'viewed'].includes(r.status)) throw new InvalidInput('you have already responded');
    await client.query(`update sign_recipient set status = 'declined', declined_at = now(), decline_reason = $2, session_hash = null where id = $1`, [r.id, reason]);
    const { rows: e } = await client.query<EnvelopeRow>(`update sign_envelope set status = 'declined' where id = $1 returning *`, [r.envelope_id]);
    await event(client, r.envelope_id, r.id, 'declined', { reason }, ctx);
    await closeContractEnvelope(client, e[0]!, 'declined', null);
    const { rows: tell } = await client.query<{ email: string; name: string }>(
      `select a.email, a.display_name as name from actor a where a.id = $1 union select email, name from sign_recipient where envelope_id = $2 and id <> $3 and status in ('sent', 'viewed', 'signed')`, [e[0]!.created_by, r.envelope_id, r.id]);
    for (const p of tell) await mailer(client, { kind: 'signature_declined', to: p.email, tenantId: r.tenant_id, idempotencyKey: `sign-decline:${r.id}:${p.email}`, subject: `Declined: ${r.title}`, text: `Hello ${p.name},\n\n${r.name} declined to sign "${r.title}": ${reason}\n\nThe envelope is closed.` });
    return { declined: true };
  });
}

/** Seals: stamps the fields, adds the certificate, checks the original first, stores the result with its hash, tells everyone. */
export async function completeEnvelope(pool: Pool, e: EnvelopeRow) {
  const original = await documentBytes(pool, e.document_file_id);
  if (hash(original) !== e.original_sha256) throw new Error('the original document changed after the envelope was made');
  const { rows: recipients } = await pool.query<{ id: string; name: string; email: string; role: string; routing_order: number; signature: SignatureValue | null; initials: SignatureValue | null; verified_at: Date | null; consented_at: Date | null; viewed_at: Date | null; signed_at: Date | null; ip: string | null; user_agent: string | null; notified_at: Date | null }>(
    `select id, name, email, role, routing_order, signature, initials, verified_at, consented_at, viewed_at, signed_at, ip, user_agent, notified_at from sign_recipient where envelope_id = $1 order by role desc, routing_order, created_at`, [e.id]);
  const { rows: fields } = await pool.query<{ recipient_id: string; kind: string; page: number; x: number; y: number; width: number; height: number; value: string | null }>(
    `select recipient_id, kind, page, x::float, y::float, width::float, height::float, value from sign_field where envelope_id = $1`, [e.id]);
  const { rows: events } = await pool.query<{ kind: string; occurred_at: Date; ip: string | null; name: string | null }>(
    `select v.kind, v.occurred_at, v.ip, r.name from sign_event v left join sign_recipient r on r.id = v.recipient_id where v.envelope_id = $1 order by v.id`, [e.id]);
  const { rows: t } = await pool.query<{ name: string }>('select name from tenant where id = $1', [e.tenant_id]);
  const completedAt = new Date();
  const finalBytes = await sealPdf(original, {
    envelope: { id: e.id, number: e.number, title: e.title, workspace: t[0]!.name, originalSha256: e.original_sha256, routing: e.routing, completedAt },
    recipients, fields, events,
  });
  const finalSha = hash(finalBytes);
  const fileId = randomUUID();
  const key = `gov/files/${e.tenant_id}/${fileId}`;
  await objectStore().put(key, finalBytes, 'application/pdf', { sha256: finalSha });
  await inTransaction(pool, async (client) => {
    await client.query(`insert into gov_file (id, tenant_id, purpose, contract_id, filename, content_type, byte_size, sha256, storage_key, scan_status) values ($1, $2, 'signed', $3, $4, 'application/pdf', $5, $6, $7, 'clean')`,
      [fileId, e.tenant_id, e.contract_id, `${e.title.replace(/[^a-zA-Z0-9 ._-]/g, '').slice(0, 60) || 'document'} - signed.pdf`, finalBytes.length, finalSha, key]);
    await client.query(`update sign_envelope set status = 'completed', completed_at = $2, final_file_id = $3, final_sha256 = $4 where id = $1`, [e.id, completedAt, fileId, finalSha]);
    await event(client, e.id, null, 'completed', { sha256: finalSha });
    await closeContractEnvelope(client, e, 'completed', `gov-file:${fileId}`);
    // Everyone, copies included, gets a personal link to the signed copy for 30 days. Signers keep
    // the link they signed with; only those who never had one (copies) get a new one.
    const { rows: links } = await client.query<{ id: string; token_sealed: string | null }>('select id, token_sealed from sign_recipient where envelope_id = $1', [e.id]);
    for (const r of recipients) {
      const sealedTk = links.find((l) => l.id === r.id)?.token_sealed;
      let tk: string;
      if (sealedTk) tk = unseal(sealedTk, `sign_recipient:${r.id}`).plaintext;
      else { tk = token(); await client.query('update sign_recipient set token_hash = $2, token_sealed = $3 where id = $1', [r.id, hash(tk), seal(tk, `sign_recipient:${r.id}`)]); }
      await mailer(client, { kind: 'signature_completed', to: r.email, tenantId: e.tenant_id, idempotencyKey: `sign-done:${r.id}`, subject: `Signed by everyone: ${e.title}`,
        text: `Hello ${r.name},\n\n"${e.title}" has been signed by everyone.\n\nDownload the signed copy (for ${FINAL_DAYS} days): ${appUrl()}/sign/${tk}\n\nIts fingerprint (SHA-256) is ${finalSha}. Anyone can check a copy at ${appUrl()}/sign/verify.` });
    }
  });
  return { sha256: finalSha, fileId };
}

/** The signed copy, through any recipient's link, for 30 days after completion. */
export async function finalDocument(pool: Pool, t: string): Promise<Buffer> {
  const r = await byToken(pool, t);
  if (r.e_status !== 'completed' || !r.completed_at) throw new InvalidInput('the document is not complete');
  if (Date.now() - r.completed_at.getTime() > FINAL_DAYS * 86400000) throw new InvalidInput('this download link has expired; ask the sender for a copy');
  const { rows } = await pool.query<{ final_file_id: string }>('select final_file_id from sign_envelope where id = $1', [r.envelope_id]);
  return documentBytes(pool, rows[0]!.final_file_id);
}

/** Public check: is this the sealed copy Patform produced? Says only what the signers already know. */
export async function verifyFingerprint(pool: Pool, body: Record<string, unknown>) {
  let sha = text(body.sha256, 64).toLowerCase();
  if (!sha && typeof body.base64 === 'string') sha = hash(Buffer.from(body.base64, 'base64'));
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new InvalidInput('give the file or its SHA-256');
  const { rows } = await pool.query<{ id: string; number: number; title: string; completed_at: Date; workspace: string }>(
    `select e.id, e.number, e.title, e.completed_at, t.name as workspace from sign_envelope e join tenant t on t.id = e.tenant_id where e.final_sha256 = $1 and e.status = 'completed'`, [sha]);
  if (!rows[0]) return { valid: false, sha256: sha, note: 'No document signed with Patform Sign has this fingerprint. If it was signed here, it has been changed since.' };
  const { rows: signers } = await pool.query<{ name: string; signed_at: Date }>(`select name, signed_at from sign_recipient where envelope_id = $1 and role = 'signer' order by signed_at`, [rows[0].id]);
  return { valid: true, sha256: sha, title: rows[0].title, workspace: rows[0].workspace, envelope: `PS-${rows[0].number}`, completedAt: rows[0].completed_at, signers };
}
