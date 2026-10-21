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
import { checkSeal, sealConfig } from './esign-seal.js';
import { PHONE, maskPhone, normalisePhone, sendSms, smsConfigured } from './sms.js';
import { lookupCompany, matchOfficer, type RegisterResult } from './company-register.js';
import { PDFDocument } from 'pdf-lib';

const UUID = /^[0-9a-f-]{36}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const CODE_MINUTES = 10; const SESSION_HOURS = 2; const FINAL_DAYS = 30;
export const authorityText = (party: string) => `I confirm I am authorised to sign this document on behalf of ${party}.`;
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
  page_count: number; routing: 'sequential' | 'parallel'; status: string; reminder_days: number; expires_at: Date; created_by: string | null; completed_at: Date | null; final_file_id: string | null; final_sha256: string | null; allow_attachments: boolean }

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

type VerifyBy = 'email' | 'sms' | 'email_and_sms';
interface RecipientIn { name: string; email: string; role: 'signer' | 'cc'; order: number; title: string | null; phone: string | null; verifyBy: VerifyBy; party: string | null }
function readRecipients(v: unknown): RecipientIn[] {
  const list = (Array.isArray(v) ? v : []).map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const verifyBy: VerifyBy = o.verifyBy === 'sms' ? 'sms' : o.verifyBy === 'email_and_sms' ? 'email_and_sms' : 'email';
    const phone = text(o.phone, 30) ? normalisePhone(text(o.phone, 30)) : null;
    const r: RecipientIn = { name: text(o.name, 120), email: text(o.email, 200).toLowerCase(), role: o.role === 'cc' ? 'cc' : 'signer', order: Math.max(1, Math.trunc(Number(o.order ?? i + 1)) || i + 1),
      title: text(o.title, 120) || null, phone, verifyBy, party: text(o.party, 200) || null };
    if (r.name.length < 2 || !EMAIL.test(r.email)) throw new InvalidInput(`recipient ${i + 1} needs a name and an email address`);
    if (phone && !PHONE.test(phone)) throw new InvalidInput(`recipient ${i + 1}: write the phone number in international form, e.g. +2348012345678`);
    if (verifyBy !== 'email' && !phone) throw new InvalidInput(`recipient ${i + 1}: a text-message code needs a phone number`);
    if (r.party && r.role !== 'signer') throw new InvalidInput(`recipient ${i + 1}: only signers sign for a company`);
    return r;
  });
  if (!list.some((r) => r.role === 'signer')) throw new InvalidInput('add at least one signer');
  if (list.length > 20) throw new InvalidInput('at most 20 recipients');
  if (new Set(list.map((r) => `${r.email}:${r.role}`)).size !== list.length) throw new InvalidInput('the same person is listed twice');
  return list;
}

/** A draft: a contract's current document, or any uploaded PDF, with its recipients. */
export async function createEnvelope(pool: Pool, principal: Principal, body: Record<string, unknown>, bulkKey?: string) {
  const w = await govMember(pool, principal);
  const recipients = readRecipients(body.recipients);
  const routing = body.routing === 'parallel' ? 'parallel' : 'sequential';
  const days = body.expiresInDays === undefined ? 30 : Math.trunc(Number(body.expiresInDays));
  if (!(days >= 1 && days <= 365)) throw new InvalidInput('expiresInDays must be 1 to 365');
  const reminder = body.reminderDays === undefined ? 3 : Math.trunc(Number(body.reminderDays));
  if (!(reminder >= 0 && reminder <= 30)) throw new InvalidInput('reminderDays must be 0 to 30');
  if (recipients.some((r) => r.verifyBy !== 'email') && !smsConfigured()) throw new InvalidInput('text messages are not set up on this server; use email codes or ask whoever runs Patform to add an SMS provider');
  // Companies signing through several authorised people: "any 2 of these 3".
  const parties = (Array.isArray(body.parties) ? body.parties : []).map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const name = text(o.name, 200);
    const members = recipients.filter((r) => r.party === name);
    const required = Math.trunc(Number(o.required ?? 1));
    if (!name) throw new InvalidInput(`company ${i + 1} needs a name`);
    if (!members.length) throw new InvalidInput(`no signers are listed for ${name}`);
    if (!(required >= 1 && required <= members.length)) throw new InvalidInput(`${name}: between 1 and ${members.length} signatures can be required`);
    const reg = (o.register ?? null) as { country?: unknown; number?: unknown } | null;
    const register = reg && text(reg.number, 40) ? { country: text(reg.country, 2).toUpperCase() || 'GB', number: text(reg.number, 40) } : null;
    return { name, required, order: Math.max(1, Math.trunc(Number(o.order ?? members[0]!.order)) || 1), authorityNote: text(o.authorityNote, 500) || null, register, requireRegistered: o.requireRegistered === true };
  });
  for (const r of recipients) if (r.party && !parties.some((pp) => pp.name === r.party)) throw new InvalidInput(`say how many signatures ${r.party} needs`);
  // Register checks, before anything is written: a company that is not active cannot sign; an
  // unlisted signatory is allowed (board resolutions and powers of attorney exist) unless the
  // sender asked for listed officers only. What the register said is kept with the envelope.
  const registers = new Map<string, { result: RegisterResult; matches: Map<string, ReturnType<typeof matchOfficer>> }>();
  for (const pp of parties) {
    if (!pp.register) continue;
    let result: RegisterResult;
    try { result = await lookupCompany(pp.register.country, pp.register.number); }
    catch (err) { throw new InvalidInput(`the ${pp.register.country} company register could not be reached: ${err instanceof Error ? err.message : String(err)}`); }
    if (pp.requireRegistered && !result.available) throw new InvalidInput(`${pp.name}: ${result.reason}`);
    if (result.available && result.status !== 'active') throw new InvalidInput(`${pp.name}: the register lists ${pp.register.country} ${result.number} as ${result.status ?? 'not found'}${result.companyName ? ` (${result.companyName})` : ''}`);
    const matches = new Map<string, ReturnType<typeof matchOfficer>>();
    for (const r of recipients.filter((x) => x.party === pp.name)) {
      const m = result.available ? matchOfficer(r.name, result.officers ?? []) : null;
      matches.set(r.email, m);
      if (pp.requireRegistered && !m) throw new InvalidInput(`${r.name} is not listed as a current officer of ${result.companyName ?? pp.name} at ${result.source ?? 'the register'}`);
    }
    registers.set(pp.name, { result, matches });
  }
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
  const extraRefs = Array.isArray(body.documentRefs) ? body.documentRefs : [];
  if (extraRefs.length > 9) throw new InvalidInput('an envelope can contain at most 10 PDFs');
  const fileIds = [fileId, ...extraRefs.map((ref, i) => {
    const m = GOV_FILE_REF.exec(text(ref, 60));
    if (!m) throw new InvalidInput(`document ${i + 2} has no valid upload reference`);
    return m[1]!;
  })];
  if (new Set(fileIds).size !== fileIds.length) throw new InvalidInput('the same PDF is in the envelope twice');
  const documents: { fileId: string; filename: string; sha256: string; pages: number; bytes: Buffer; pageStart: number }[] = [];
  let pageStart = 1;
  for (const id of fileIds) {
    const { rows: f } = await pool.query<{ content_type: string; storage_key: string; purpose: string; sha256: string; filename: string }>(
      'select content_type, storage_key, purpose, sha256, filename from gov_file where id = $1 and tenant_id = $2', [id, w.tenantId]);
    if (!f[0]) throw new InvalidInput('no such document');
    if (f[0].content_type !== 'application/pdf') throw new InvalidInput('Patform Sign signs PDFs; save the Word file as PDF and upload that');
    if ((!contractId || id !== fileId) && !['signing', 'contract'].includes(f[0].purpose)) throw new InvalidInput('that file was not uploaded for signing');
    const scan = await objectStore().scan(f[0].storage_key);
    if (scan !== 'clean') throw new InvalidInput(scan === 'scanning' ? `${f[0].filename} is still being checked for malware; try again shortly` : `${f[0].filename} failed its malware check`);
    const bytes = await objectStore().get(f[0].storage_key);
    if (hash(bytes) !== f[0].sha256) throw new InvalidInput('the stored document does not match what was uploaded');
    const pages = await pageCount(bytes).catch((err: Error) => { throw new InvalidInput(err.message); });
    if (pageStart + pages - 1 > 100) throw new InvalidInput('an envelope can contain at most 100 pages');
    documents.push({ fileId: id, filename: f[0].filename, sha256: f[0].sha256, pages, bytes, pageStart });
    pageStart += pages;
  }
  let combined: Buffer | null = null;
  let combinedKey: string | null = null;
  if (documents.length > 1) {
    const merged = await PDFDocument.create();
    for (const source of documents) {
      const pdf = await PDFDocument.load(source.bytes).catch(() => { throw new InvalidInput(`${source.filename} is not a readable PDF`); });
      const copied = await merged.copyPages(pdf, pdf.getPageIndices());
      copied.forEach((page) => merged.addPage(page));
    }
    combined = Buffer.from(await merged.save());
    if (combined.length > 50 * 1024 * 1024) throw new InvalidInput('the combined PDF must be 50 MB or smaller');
    combinedKey = `${w.tenantId}/signing/${randomUUID()}.pdf`;
    await objectStore().put(combinedKey, combined, 'application/pdf', { sha256: hash(combined) });
  }
  const pages = pageStart - 1;
  const docSha = combined ? hash(combined) : documents[0]!.sha256;
  try { return await inTransaction(pool, async (client) => {
    if (combined && combinedKey) {
      const mergedId = randomUUID();
      await client.query(`insert into gov_file (id, tenant_id, purpose, contract_id, filename, content_type, byte_size, sha256, storage_key, scan_status, uploaded_by) values ($1, $2, 'signing', $3, $4, 'application/pdf', $5, $6, $7, 'clean', $8)`,
        [mergedId, w.tenantId, contractId, `${title}.pdf`, combined.length, docSha, combinedKey, w.actorId]);
      fileId = mergedId;
    }
    const number = await nextNumber(client, w.tenantId);
    const { rows } = await client.query<{ id: string }>(
      `insert into sign_envelope (tenant_id, number, title, message, contract_id, contract_version, document_file_id, original_sha256, page_count, routing, reminder_days, expires_at, created_by, allow_attachments, bulk_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(days => $12), $13, $14, $15) returning id`,
      [w.tenantId, number, title, text(body.message, 2000) || null, contractId, version, fileId, docSha, pages, routing, reminder, days, w.actorId, body.allowAttachments === true, bulkKey ?? null]);
    const envelopeId = rows[0]!.id;
    for (const [ordinal, doc] of documents.entries()) await client.query(
      `insert into sign_envelope_document (envelope_id, ordinal, file_id, filename, sha256, page_start, page_count) values ($1, $2, $3, $4, $5, $6, $7)`,
      [envelopeId, ordinal + 1, doc.fileId, doc.filename, doc.sha256, doc.pageStart, doc.pages]);
    const partyIds = new Map<string, { id: string; order: number }>();
    for (const pp of parties) {
      const reg = registers.get(pp.name);
      const { rows: made } = await client.query<{ id: string }>(`insert into sign_party (envelope_id, name, required_count, routing_order, authority_note, register, register_required) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [envelopeId, pp.name, pp.required, routing === 'parallel' ? 1 : pp.order, pp.authorityNote, reg ? JSON.stringify(reg.result) : null, pp.requireRegistered]);
      partyIds.set(pp.name, { id: made[0]!.id, order: pp.order });
    }
    const ids: string[] = [];
    for (const [position, r] of recipients.entries()) {
      const { rows: a } = await client.query<{ id: string }>('select id from actor where tenant_id = $1 and lower(email) = $2 and active', [w.tenantId, r.email]);
      const party = r.party ? partyIds.get(r.party)! : null;
      const reg = r.party ? registers.get(r.party) : undefined;
      const match = reg?.result.available ? { officer: reg.matches.get(r.email) ?? null, checkedAt: reg.result.checkedAt } : null;
      const { rows: made } = await client.query<{ id: string }>(
        `insert into sign_recipient (envelope_id, name, email, role, routing_order, actor_id, title, phone, verify_by, party_id, register_match, position) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [envelopeId, r.name, r.email, r.role, routing === 'parallel' ? 1 : party ? party.order : r.order, a[0]?.id ?? null, r.title, r.phone, r.verifyBy, party?.id ?? null, match ? JSON.stringify(match) : null, position]);
      ids.push(made[0]!.id);
    }
    await event(client, envelopeId, null, 'created', { by: w.actorId, sha256: docSha, pages, companies: parties.map((pp) => `${pp.name} (${pp.required} required)`),
      registers: [...registers.entries()].map(([name, v]) => ({ company: name, ...(v.result.available ? { source: v.result.source, found: v.result.companyName, status: v.result.status, listed: [...v.matches.entries()].filter(([, m]) => m).map(([e]) => e) } : { unavailable: v.result.reason }) })) });
    return { id: envelopeId, number, pages, documents: documents.map(({ filename, pageStart, pages }) => ({ filename, pageStart, pages })), recipients: ids, parties: [...partyIds.entries()].map(([name, v]) => ({ name, id: v.id, register: registers.get(name)?.result ?? null,
      // Only a register that answered can say who is not listed.
      unlisted: registers.get(name)?.result.available ? [...registers.get(name)!.matches.entries()].filter(([, m]) => !m).map(([e]) => e) : [] })) };
  }); } catch (err) { if (combinedKey) await objectStore().remove(combinedKey).catch(() => undefined); throw err; }
}

/** Fields are placed on the pages as fractions of the page, from the top left, as the screen shows them. */
export async function setFields(pool: Pool, principal: Principal, envelopeId: string, body: Record<string, unknown>) {
  return inTransaction(pool, async (client) => {
    const { e } = await envelopeFor(client, principal, envelopeId, true);
    if (e.status !== 'draft') throw new InvalidInput('fields can only change before the envelope is sent');
    const { rows: rec } = await client.query<{ id: string; role: string }>('select id, role from sign_recipient where envelope_id = $1', [envelopeId]);
    const { rows: prt } = await client.query<{ id: string; required_count: number }>('select id, required_count from sign_party where envelope_id = $1', [envelopeId]);
    const fields = (Array.isArray(body.fields) ? body.fields : []).map((x, i) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const kind = text(o.kind, 20);
      if (!['signature', 'initials', 'date', 'name', 'text', 'title'].includes(kind)) throw new InvalidInput(`field ${i + 1}: kind must be signature, initials, date, name, title or text`);
      let r: { id: string } | null = null; let partyId: string | null = null; let slot: number | null = null;
      if (o.partyId) {
        const pp = prt.find((y) => y.id === o.partyId);
        slot = Math.trunc(Number(o.slot));
        if (!pp || !(slot >= 1 && slot <= pp.required_count)) throw new InvalidInput(`field ${i + 1}: a company box is for signatory 1 to the number required`);
        partyId = pp.id;
      } else {
        const found = rec.find((y) => y.id === o.recipientId);
        if (!found || found.role !== 'signer') throw new InvalidInput(`field ${i + 1} must belong to a signer`);
        r = found;
      }
      const n = (k: string) => Number(o[k]);
      const page = Math.trunc(n('page'));
      if (!(page >= 1 && page <= e.page_count)) throw new InvalidInput(`field ${i + 1}: the document has ${e.page_count} page(s)`);
      const [x0, y0, wd, ht] = [n('x'), n('y'), n('width'), n('height')];
      if (![x0, y0, wd, ht].every(Number.isFinite) || x0 < 0 || y0 < 0 || wd <= 0 || ht <= 0 || x0 + wd > 1.0001 || y0 + ht > 1.0001) throw new InvalidInput(`field ${i + 1} is off the page`);
      return { recipientId: r?.id ?? null, partyId, slot, kind, page, x: x0, y: y0, width: wd, height: ht, required: o.required !== false, label: text(o.label, 120) || null };
    });
    if (fields.length > 400) throw new InvalidInput('at most 400 fields');
    await client.query('delete from sign_field where envelope_id = $1', [envelopeId]);
    for (const fl of fields) await client.query(`insert into sign_field (envelope_id, recipient_id, party_id, slot, kind, page, x, y, width, height, required, label) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [envelopeId, fl.recipientId, fl.partyId, fl.slot, fl.kind, fl.page, fl.x, fl.y, fl.width, fl.height, fl.required, fl.label]);
    return { fields: fields.length };
  });
}

/** Emails the next signers their personal links (in order, or all at once). */
async function notifyNext(client: Client | Pool, e: EnvelopeRow, from: string) {
  const { rows: pending } = await client.query<{ id: string; name: string; email: string; routing_order: number; role: string; status: string; party: string | null; title: string | null; verify_by: VerifyBy }>(
    `select r.id, r.name, r.email, r.routing_order, r.role, r.status, p.name as party, r.title, r.verify_by from sign_recipient r left join sign_party p on p.id = r.party_id
      where r.envelope_id = $1 and r.role = 'signer' and r.status in ('waiting', 'sent', 'viewed') order by r.routing_order`, [e.id]);
  if (!pending.length) return 0;
  const next = e.routing === 'parallel' ? pending : pending.filter((p) => p.routing_order === pending[0]!.routing_order);
  let sent = 0;
  for (const r of next.filter((p) => p.status === 'waiting')) {
    const t = token();
    await client.query(`update sign_recipient set status = 'sent', token_hash = $2, token_sealed = $3, notified_at = now() where id = $1`, [r.id, hash(t), seal(t, `sign_recipient:${r.id}`)]);
    await mailer(client, { kind: 'signature_request', to: r.email, tenantId: e.tenant_id, idempotencyKey: `sign-request:${r.id}`,
      subject: `Please sign: ${e.title}`,
      text: `Hello ${r.name},\n\n${from} has asked you to sign "${e.title}"${r.party ? ` on behalf of ${r.party}${r.title ? ` as ${r.title}` : ''}` : ''}.${e.message ? `\n\n${e.message}` : ''}\n\nReview and sign here: ${appUrl()}/sign/${t}\n\nThis link is personal to you; do not forward it. We will ${r.verify_by === 'email' ? 'email you a code' : r.verify_by === 'sms' ? 'text a code to your phone' : 'email you a code and text another to your phone'} to confirm it is you. It expires on ${e.expires_at.toISOString().slice(0, 10)}.\n\nSent with Patform Sign.` });
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

/** Correct a recipient who has not signed. Old links and verification sessions
 * stop working immediately; a current-stage signer gets a fresh invitation. */
export async function correctRecipient(pool: Pool, principal: Principal, envelopeId: string, recipientId: string, body: Record<string, unknown>) {
  const name = text(body.name, 120);
  const email = text(body.email, 200).toLowerCase();
  const reason = text(body.reason, 500);
  if (name.length < 2 || !EMAIL.test(email)) throw new InvalidInput('give the corrected signer a name and a valid email');
  if (!reason) throw new InvalidInput('say why the signer is being corrected');
  return inTransaction(pool, async (client) => {
    const { w, e } = await envelopeFor(client, principal, envelopeId, true);
    if (e.status !== 'sent') throw new InvalidInput('only an envelope out for signature can be corrected');
    const { rows } = await client.query<{ id: string; name: string; email: string; role: string; status: string; party_id: string | null; routing_order: number }>(
      'select id, name, email, role, status, party_id, routing_order from sign_recipient where id = $1 and envelope_id = $2 for update', [recipientId, envelopeId]);
    const r = rows[0];
    if (!r || r.role !== 'signer') throw new InvalidInput('no such signer');
    if (r.party_id) throw new InvalidInput('company signers need a new envelope so their authority can be checked again');
    if (r.status === 'signed' || r.status === 'declined') throw new InvalidInput('a signer who already responded cannot be corrected');
    if (r.name === name && r.email === email) throw new InvalidInput('the signer has not changed');
    const duplicate = await client.query('select 1 from sign_recipient where envelope_id = $1 and lower(email) = $2 and id <> $3', [envelopeId, email, r.id]);
    if (duplicate.rowCount) throw new InvalidInput('this email already receives the envelope');
    const actor = await client.query<{ id: string }>('select id from actor where tenant_id = $1 and lower(email) = $2 and active', [w.tenantId, email]);
    await client.query(`update sign_recipient set name = $2, email = $3, actor_id = $4, status = 'waiting', token_hash = null, token_sealed = null,
      otp_hash = null, otp_expires_at = null, otp_attempts = 0, session_hash = null, session_expires_at = null, verified_at = null, consented_at = null,
      viewed_at = null, notified_at = null, last_reminded_at = null where id = $1`, [r.id, name, email, actor.rows[0]?.id ?? null]);
    await client.query('delete from sign_embed_session where recipient_id = $1', [r.id]);
    await event(client, envelopeId, r.id, 'recipient_corrected', { by: w.actorId, reason, previous: { name: r.name, email: r.email }, current: { name, email } });
    const from = await client.query<{ display_name: string; workspace: string }>('select a.display_name, t.name as workspace from actor a join tenant t on t.id = a.tenant_id where a.id = $1', [w.actorId]);
    const notified = await notifyNext(client, e, `${from.rows[0]!.display_name} (${from.rows[0]!.workspace})`);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'sign.recipient_corrected', targetId: envelopeId, detail: { recipientId: r.id, previousEmail: r.email, email, reason } });
    return { corrected: true, notified: notified > 0 };
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
            (select count(*)::int from sign_recipient r where r.envelope_id = e.id and r.role = 'signer' and r.status = 'signed') as signed,
            (select coalesce(json_agg(json_build_object('name', r.name, 'status', r.status, 'order', r.routing_order) order by r.routing_order, r.created_at), '[]'::json)
               from sign_recipient r where r.envelope_id = e.id and r.role = 'signer') as people,
            (select display_name from actor where id = e.created_by) as sender
       from sign_envelope e left join contract c on c.id = e.contract_id
      where e.tenant_id = $1 and ($2 or e.created_by = $3 or c.owner_id = $3) order by e.created_at desc limit 200`, [w.tenantId, all, w.actorId]);
  return rows;
}

/** The sender's dashboard numbers. */
export async function signSummary(pool: Pool, principal: Principal) {
  const w = await govMember(pool, principal);
  const all = govInTeam(w, 'legal', 'compliance');
  const { rows } = await pool.query<{ out: number; drafts: number; finalizing: number; done30: number; expiring: number; declined: number }>(
    `select count(*) filter (where status = 'sent')::int as out,
            count(*) filter (where status = 'draft')::int as drafts,
            count(*) filter (where status = 'finalizing')::int as finalizing,
            count(*) filter (where status = 'completed' and completed_at > now() - interval '30 days')::int as done30,
            count(*) filter (where status = 'sent' and expires_at < now() + interval '7 days')::int as expiring,
            count(*) filter (where status = 'declined')::int as declined
       from sign_envelope e where e.tenant_id = $1 and ($2 or e.created_by = $3)`, [w.tenantId, all, w.actorId]);
  const mine = await mySignatures(pool, principal);
  const configuredSeal = sealConfig()?.info ?? null;
  return { ...rows[0]!, waitingForMe: mine.length, certificateSeal: Boolean(configuredSeal), selfIssuedSeal: configuredSeal?.selfIssued ?? false };
}

/** Documents waiting for this person's own signature, with their personal link. Their own email, nobody else's. */
export async function mySignatures(pool: Pool, principal: Principal) {
  if (principal.kind !== 'actor') return [];
  const { rows: me } = await pool.query<{ email: string }>('select email from actor where id = $1', [principal.actorId]);
  if (!me[0]) return [];
  const { rows } = await pool.query<{ recipient_id: string; token_sealed: string | null; status: string; id: string; number: number; title: string; sent_at: Date; expires_at: Date; workspace: string; sender: string | null }>(
    `select r.id as recipient_id, r.token_sealed, r.status, e.id, e.number, e.title, e.sent_at, e.expires_at, t.name as workspace, (select display_name from actor where id = e.created_by) as sender
       from sign_recipient r join sign_envelope e on e.id = r.envelope_id join tenant t on t.id = e.tenant_id
      where lower(r.email) = lower($1) and r.role = 'signer' and r.status in ('sent', 'viewed') and e.status = 'sent' and e.expires_at > now() order by e.sent_at`, [me[0].email]);
  return rows.map((r) => ({ envelopeId: r.id, number: r.number, title: r.title, sentAt: r.sent_at, expiresAt: r.expires_at, workspace: r.workspace, sender: r.sender, status: r.status,
    url: r.token_sealed ? `${appUrl()}/sign/${unseal(r.token_sealed, `sign_recipient:${r.recipient_id}`).plaintext}` : null }));
}

// ----------------------------------------------------------- templates

export async function listTemplates(pool: Pool, principal: Principal) {
  const w = await govMember(pool, principal);
  const { rows } = await pool.query(`select t.id, t.name, t.recipients, t.parties, t.routing, t.message, t.expires_in_days, t.created_at, a.display_name as created_by from sign_template t left join actor a on a.id = t.created_by where t.tenant_id = $1 order by t.name`, [w.tenantId]);
  return rows;
}
export async function saveTemplate(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await govMember(pool, principal);
  const name = text(body.name, 120); if (!name) throw new InvalidInput('give the template a name');
  const recipients = readRecipients(body.recipients);
  if (!recipients.length) throw new InvalidInput('a template needs at least one signer');
  const parties = Array.isArray(body.parties) ? body.parties.slice(0, 10) : [];
  const days = body.expiresInDays === undefined ? 30 : Math.trunc(Number(body.expiresInDays));
  if (!(days >= 1 && days <= 365)) throw new InvalidInput('expiresInDays must be 1 to 365');
  const { rows } = await pool.query<{ id: string }>(
    `insert into sign_template (tenant_id, name, recipients, parties, routing, message, expires_in_days, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [w.tenantId, name, JSON.stringify(recipients), JSON.stringify(parties), body.routing === 'parallel' ? 'parallel' : 'sequential', text(body.message, 2000) || null, days, w.actorId]);
  return { id: rows[0]!.id };
}
export async function deleteTemplate(pool: Pool, principal: Principal, id: string) {
  const w = await govMember(pool, principal);
  const { rowCount } = await pool.query('delete from sign_template where id = $1 and tenant_id = $2', [id, w.tenantId]);
  return { removed: Boolean(rowCount) };
}

/** A reusable agreement keeps clean source PDFs, signer roles and box
 * coordinates. Names and email addresses are supplied for each send. */
export async function saveAgreementTemplate(pool: Pool, principal: Principal, envelopeId: string, body: Record<string, unknown>) {
  const { w, e } = await envelopeFor(pool, principal, envelopeId);
  if (e.status !== 'draft' || e.contract_id) throw new InvalidInput('save a standalone draft as an agreement template');
  const name = text(body.name, 120);
  if (!name) throw new InvalidInput('give the agreement template a name');
  const { rows: recipients } = await pool.query<{ id: string; role: string; routing_order: number }>(
    'select id, role, routing_order from sign_recipient where envelope_id = $1 order by position nulls last, created_at, id', [envelopeId]);
  if (!recipients.length) throw new InvalidInput('add signer roles first');
  const labels = Array.isArray(body.roles) ? body.roles.map((x) => text(x, 80)) : [];
  if (labels.length !== recipients.length || labels.some((x) => !x)) throw new InvalidInput('give each recipient a role name');
  if (new Set(labels.map((x) => x.toLowerCase())).size !== labels.length) throw new InvalidInput('role names must be different');
  const party = await pool.query('select 1 from sign_party where envelope_id = $1 limit 1', [envelopeId]);
  if (party.rowCount) throw new InvalidInput('company-signatory rules need their own agreement; this role template supports named people');
  const { rows: docs } = await pool.query<{ file_id: string; filename: string }>('select file_id, filename from sign_envelope_document where envelope_id = $1 order by ordinal', [envelopeId]);
  const { rows: boxes } = await pool.query<{ recipient_id: string; kind: string; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string | null }>(
    'select recipient_id, kind, page, x::float, y::float, width::float, height::float, required, label from sign_field where envelope_id = $1 order by page, y', [envelopeId]);
  if (!boxes.length) throw new InvalidInput('place the agreement fields before saving a template');
  const fields = boxes.map((b) => ({ recipientIndex: recipients.findIndex((r) => r.id === b.recipient_id), kind: b.kind, page: b.page, x: b.x, y: b.y, width: b.width, height: b.height, required: b.required, label: b.label }));
  if (fields.some((f) => f.recipientIndex < 0)) throw new InvalidInput('every template field must belong to a named role');
  const roles = recipients.map((r, i) => ({ label: labels[i], role: r.role, order: r.routing_order }));
  const documents = docs.map((d) => ({ ref: `gov-file:${d.file_id}`, name: d.filename }));
  const { rows } = await pool.query<{ id: string }>(
    `insert into sign_agreement_template (tenant_id, name, documents, roles, fields, routing, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [w.tenantId, name, JSON.stringify(documents), JSON.stringify(roles), JSON.stringify(fields), e.routing, w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'sign.agreement_template_saved', targetId: rows[0]!.id, detail: { name, documents: documents.length, roles: roles.length } });
  return { id: rows[0]!.id };
}

export async function listAgreementTemplates(pool: Pool, principal: Principal) {
  const w = await govMember(pool, principal);
  const { rows } = await pool.query('select id, name, documents, roles, fields, routing, created_at from sign_agreement_template where tenant_id = $1 order by name', [w.tenantId]);
  return rows;
}

export async function deleteAgreementTemplate(pool: Pool, principal: Principal, id: string) {
  const w = await govMember(pool, principal);
  const { rowCount } = await pool.query('delete from sign_agreement_template where id = $1 and tenant_id = $2', [id, w.tenantId]);
  return { removed: Boolean(rowCount) };
}

/** Send the same role-based agreement to several independent groups. A caller
 * supplies one stable batch key; retries resume drafts instead of duplicating
 * envelopes. The response reports each row, including individual failures. */
export async function bulkSendAgreement(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await govMember(pool, principal);
  const templateId = text(body.templateId, 36);
  const batchKey = text(body.batchKey, 120);
  if (!UUID.test(templateId)) throw new InvalidInput('choose an agreement template');
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(batchKey)) throw new InvalidInput('batchKey must be a stable identifier');
  const { rows: templates } = await pool.query<{ id: string; name: string; documents: { ref: string; name: string }[]; roles: { label: string; role: 'signer' | 'cc'; order: number }[]; fields: { recipientIndex: number; kind: string; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string | null }[]; routing: string }>(
    'select id, name, documents, roles, fields, routing from sign_agreement_template where id = $1 and tenant_id = $2', [templateId, w.tenantId]);
  const template = templates[0];
  if (!template) throw new InvalidInput('no such agreement template');
  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (!rawRows.length || rawRows.length > 20) throw new InvalidInput('send between 1 and 20 agreements per batch');
  const rows = rawRows.map((item, index) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    const people = Array.isArray(obj.people) ? obj.people : [];
    if (people.length !== template.roles.length) throw new InvalidInput(`row ${index + 1} needs ${template.roles.length} people`);
    const recipients = readRecipients(people.map((p, i) => {
      const person = (p ?? {}) as Record<string, unknown>;
      return { name: person.name, email: person.email, role: template.roles[i]!.role, order: template.roles[i]!.order };
    }));
    return { recipients, title: text(obj.title, 200) || template.name };
  });
  if (body.dryRun === true) return { ready: rows.length, roles: template.roles.map((r) => r.label), rows: rows.map((row, i) => ({ index: i + 1, title: row.title, people: row.recipients.map((r) => r.email) })) };
  const fingerprint = hash(JSON.stringify({ templateId, rows }));
  const lock = await pool.connect();
  try {
    await lock.query('select pg_advisory_lock(hashtext($1), hashtext($2))', [w.tenantId, batchKey]);
    const existing = await lock.query<{ payload_sha256: string; created_by: string }>('select payload_sha256, created_by from sign_bulk_batch where tenant_id = $1 and batch_key = $2', [w.tenantId, batchKey]);
    if (existing.rows[0] && existing.rows[0].created_by !== w.actorId) throw new InvalidInput('this batch belongs to another sender');
    if (existing.rows[0] && existing.rows[0].payload_sha256 !== fingerprint) throw new InvalidInput('this batch key was already used for different recipients');
    if (!existing.rows[0]) await lock.query('insert into sign_bulk_batch (tenant_id, batch_key, payload_sha256, template_id, created_by) values ($1, $2, $3, $4, $5)', [w.tenantId, batchKey, fingerprint, templateId, w.actorId]);
    const results: { index: number; envelopeId?: string; status: string; error?: string }[] = [];
    for (const [index, row] of rows.entries()) {
      const itemKey = `${batchKey}:${index + 1}`;
      try {
        let found = await pool.query<{ id: string; status: string }>('select id, status from sign_envelope where tenant_id = $1 and bulk_key = $2', [w.tenantId, itemKey]);
        if (!found.rows[0]) {
          const made = await createEnvelope(pool, principal, { documentRef: template.documents[0]!.ref, documentRefs: template.documents.slice(1).map((d) => d.ref), title: row.title, routing: template.routing,
            recipients: row.recipients.map((r) => ({ name: r.name, email: r.email, role: r.role, order: r.order })) }, itemKey);
          found = { ...found, rows: [{ id: made.id, status: 'draft' }] };
        }
        const env = found.rows[0]!;
        if (env.status === 'draft') {
          const ids = await pool.query<{ id: string }>('select id from sign_recipient where envelope_id = $1 order by position', [env.id]);
          await setFields(pool, principal, env.id, { fields: template.fields.map((field) => ({ ...field, recipientId: ids.rows[field.recipientIndex]?.id })) });
          await sendEnvelope(pool, principal, env.id);
        }
        results.push({ index: index + 1, envelopeId: env.id, status: env.status === 'draft' ? 'sent' : env.status });
      } catch (err) { results.push({ index: index + 1, status: 'failed', error: err instanceof Error ? err.message : String(err) }); }
    }
    return { batchKey, sent: results.filter((r) => r.status === 'sent').length, results };
  } finally {
    await lock.query('select pg_advisory_unlock(hashtext($1), hashtext($2))', [w.tenantId, batchKey]).catch(() => undefined);
    lock.release();
  }
}

export async function envelopeDetail(pool: Pool, principal: Principal, envelopeId: string) {
  const { e } = await envelopeFor(pool, principal, envelopeId);
  const { rows: recipients } = await pool.query(
    `select r.id, r.name, r.email, r.role, r.routing_order, r.status, r.notified_at, r.viewed_at, r.verified_at, r.consented_at, r.signed_at, r.declined_at, r.decline_reason, r.last_reminded_at, r.title, r.verify_by, r.party_id, r.register_match, p.name as party
       from sign_recipient r left join sign_party p on p.id = r.party_id where r.envelope_id = $1 order by r.position nulls last, r.created_at, r.id`, [envelopeId]);
  const { rows: fields } = await pool.query(`select id, recipient_id, party_id, slot, kind, page, x::float, y::float, width::float, height::float, required, label, (value is not null) as filled from sign_field where envelope_id = $1 order by page, y`, [envelopeId]);
  const { rows: events } = await pool.query(`select v.kind, v.detail, v.ip, v.occurred_at, r.name as recipient from sign_event v left join sign_recipient r on r.id = v.recipient_id where v.envelope_id = $1 order by v.id`, [envelopeId]);
  const { rows: parties } = await pool.query(
    `select p.id, p.name, p.required_count, p.authority_note, p.completed_at, p.register, p.register_required, (select count(*)::int from sign_recipient r where r.party_id = p.id and r.status = 'signed') as signed from sign_party p where p.envelope_id = $1 order by p.routing_order`, [envelopeId]);
  const { rows: documents } = await pool.query('select ordinal, filename, sha256, page_start, page_count from sign_envelope_document where envelope_id = $1 order by ordinal', [envelopeId]);
  const { rows: attachments } = await pool.query('select id, recipient_id, filename, content_type, byte_size, sha256, uploaded_at from sign_attachment where envelope_id = $1 order by uploaded_at', [envelopeId]);
  return { envelope: e, recipients, fields, events, parties, documents, attachments };
}

export async function envelopeAttachment(pool: Pool, principal: Principal, envelopeId: string, attachmentId: string) {
  await envelopeFor(pool, principal, envelopeId);
  const { rows } = await pool.query<{ storage_key: string; filename: string; content_type: string; sha256: string }>(
    'select storage_key, filename, content_type, sha256 from sign_attachment where id = $1 and envelope_id = $2', [attachmentId, envelopeId]);
  const item = rows[0];
  if (!item) throw new InvalidInput('no such attachment');
  const scan = await objectStore().scan(item.storage_key);
  if (scan !== 'clean') throw new InvalidInput('this attachment is not cleared for opening');
  const bytes = await objectStore().get(item.storage_key);
  if (hash(bytes) !== item.sha256) throw new InvalidInput('the attachment does not match its fingerprint');
  return { bytes, filename: item.filename, contentType: item.content_type };
}

/** A short-lived URL for showing the verified signing page inside one
 * specified site. The personal signer token never leaves Patform's origin. */
export async function createEmbedSession(pool: Pool, principal: Principal, envelopeId: string, recipientId: string, body: Record<string, unknown>) {
  const { w, e } = await envelopeFor(pool, principal, envelopeId);
  if (e.status !== 'sent') throw new InvalidInput('only active envelopes can be embedded');
  const raw = text(body.origin, 300);
  let origin: URL;
  try { origin = new URL(raw); } catch { throw new InvalidInput('give the exact HTTPS origin of the embedding site'); }
  if (origin.origin !== raw || (origin.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))))
    throw new InvalidInput('give the exact HTTPS origin, without a path or trailing slash');
  const { rows } = await pool.query<{ id: string; role: string; status: string; token_sealed: string | null }>(
    'select id, role, status, token_sealed from sign_recipient where id = $1 and envelope_id = $2', [recipientId, envelopeId]);
  const recipient = rows[0];
  if (!recipient || recipient.role !== 'signer' || !['sent', 'viewed'].includes(recipient.status) || !recipient.token_sealed) throw new InvalidInput('that signer is not active yet');
  const embedToken = token();
  await pool.query(`insert into sign_embed_session (token_hash, envelope_id, recipient_id, allowed_origin, expires_at, created_by)
    values ($1, $2, $3, $4, least(now() + interval '15 minutes', $5), $6)`, [hash(embedToken), envelopeId, recipientId, origin.origin, e.expires_at, w.actorId]);
  await event(pool, envelopeId, recipientId, 'embed_created', { by: w.actorId, origin: origin.origin });
  return { url: `${appUrl()}/sign/embed/${embedToken}`, expiresInMinutes: 15, origin: origin.origin };
}

export async function resolveEmbedSession(pool: Pool, embedToken: string) {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(embedToken)) throw new InvalidInput('this embed link is not valid');
  const { rows } = await pool.query<{ token_sealed: string | null; recipient_id: string; allowed_origin: string }>(
    `select r.token_sealed, r.id as recipient_id, s.allowed_origin from sign_embed_session s
      join sign_recipient r on r.id = s.recipient_id join sign_envelope e on e.id = s.envelope_id
      where s.token_hash = $1 and s.expires_at > now() and e.status = 'sent' and r.status in ('sent', 'viewed')`, [hash(embedToken)]);
  const item = rows[0];
  if (!item?.token_sealed) throw new InvalidInput('this embed link has expired or is no longer active');
  const personal = unseal(item.token_sealed, `sign_recipient:${item.recipient_id}`).plaintext;
  return { signingPath: `/sign/${personal}`, origin: item.allowed_origin };
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
  const { rows: finishing } = await pool.query<EnvelopeRow>(
    `select * from sign_envelope where status = 'finalizing' order by sent_at limit 20`);
  let finalized = 0;
  for (const e of finishing) {
    try { await completeEnvelope(pool, e); finalized++; }
    catch (err) { console.error(`signature finalization failed for ${e.id}:`, err instanceof Error ? err.message : err); }
  }
  const { rows: due } = await pool.query<EnvelopeRow>(`select * from sign_envelope where status = 'sent' and reminder_days > 0 and expires_at > now()`);
  let reminded = 0;
  for (const e of due) reminded += await remind(pool, e, false);
  const { rows: expired } = await pool.query<EnvelopeRow>(`update sign_envelope set status = 'expired' where status = 'sent' and expires_at <= now() returning *`);
  for (const e of expired) { await event(pool, e.id, null, 'expired', {}); await closeContractEnvelope(pool, e, 'voided', null); }
  return { reminded, expired: expired.length, finalized };
}

// ---------------------------------------------------------------- signer

interface RecipientRow { id: string; envelope_id: string; name: string; email: string; role: string; routing_order: number; status: string; otp_hash: string | null; otp_expires_at: Date | null; otp_attempts: number;
  otp_sent_count: number; otp_window_start: Date | null; session_hash: string | null; session_expires_at: Date | null; verified_at: Date | null; consented_at: Date | null; signed_at: Date | null }

async function byToken(client: Client | Pool, t: string, lock = false) {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(t)) throw new InvalidInput('this link is not valid');
  const { rows } = await client.query<RecipientRow & { e_status: string; tenant_id: string; expires_at: Date; title: string; message: string | null; workspace: string; sender: string | null; completed_at: Date | null; page_count: number; allow_attachments: boolean }>(
    `select r.*, r.title as signer_title, e.status as e_status, e.tenant_id, e.expires_at, e.title, e.message, e.completed_at, e.page_count, e.allow_attachments, t.name as workspace, a.display_name as sender
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
interface SignerExtra { party_id: string | null; signer_title: string | null; register_match: { officer: { name: string; role: string; appointedOn: string | null } | null; checkedAt: string } | null; phone: string | null; verify_by: VerifyBy; sms_otp_hash: string | null; authority_confirmed_at: Date | null }
async function partyOf(client: Client | Pool, partyId: string | null) {
  if (!partyId) return null;
  const { rows } = await client.query<{ id: string; name: string; required_count: number; signed: number; authority_note: string | null; register: RegisterResult | null }>(
    `select p.id, p.name, p.required_count, p.authority_note, p.register, (select count(*)::int from sign_recipient r where r.party_id = p.id and r.status = 'signed') as signed from sign_party p where p.id = $1`, [partyId]);
  return rows[0] ?? null;
}
const mask = (email: string) => email.replace(/^(.)(.*)(@.*)$/, (_, a: string, b: string, c: string) => `${a}${'•'.repeat(Math.min(6, b.length))}${c}`);

/** What the signing page shows. Nothing about the document until the code is verified. */
export async function signerView(pool: Pool, t: string, session?: string) {
  const r = await byToken(pool, t);
  const x = r as typeof r & SignerExtra;
  const party = await partyOf(pool, x.party_id);
  const base = { title: r.title, workspace: r.workspace, sender: r.sender, name: r.name, email: mask(r.email), expiresAt: r.expires_at, verifyBy: x.verify_by, phone: x.phone ? maskPhone(x.phone) : null,
    party: party ? { name: party.name, required: party.required_count, signed: party.signed,
      register: party.register?.available ? { source: party.register.source, companyName: party.register.companyName, status: party.register.status, number: party.register.number } : null,
      listedAs: x.register_match?.officer ? `${x.register_match.officer.role}${x.register_match.officer.appointedOn ? ` since ${x.register_match.officer.appointedOn}` : ''}` : x.register_match ? 'not listed as an officer' : null } : null, signerTitle: x.signer_title };
  if (r.status === 'not_needed') return { ...base, stage: 'closed' as const, status: `no longer needed: enough people have signed for ${party?.name ?? 'the company'}` };
  if (r.e_status === 'completed') return { ...base, stage: 'completed' as const, completedAt: r.completed_at };
  if (r.e_status === 'finalizing' && r.status === 'signed') return { ...base, stage: 'signed' as const, finalizing: true };
  if (r.e_status !== 'sent' || r.expires_at < new Date()) return { ...base, stage: 'closed' as const, status: r.e_status === 'sent' ? 'expired' : r.e_status };
  if (r.status === 'signed') return { ...base, stage: 'signed' as const };
  if (r.status === 'declined') return { ...base, stage: 'closed' as const, status: 'declined' };
  if (!sessionOk(r, session)) return { ...base, stage: 'verify' as const };
  // Own boxes, and the company's boxes for the next signatory slot (the slot is fixed when signing).
  const { rows: fields } = await pool.query(
    `select id, kind, page, x::float, y::float, width::float, height::float, required, label, slot from sign_field
      where recipient_id = $1 or (party_id = $2 and slot = $3) order by page, y, x`, [r.id, x.party_id, (party?.signed ?? 0) + 1]);
  const { rows: attachments } = r.allow_attachments ? await pool.query('select id, filename, byte_size, sha256, uploaded_at from sign_attachment where recipient_id = $1 order by uploaded_at', [r.id]) : { rows: [] };
  return { ...base, stage: 'sign' as const, message: r.message, pages: r.page_count, consented: Boolean(r.consented_at), consentText: CONSENT_TEXT,
    authorityText: party ? authorityText(party.name) : null, authorityNote: party?.authority_note ?? null, fields, allowAttachments: r.allow_attachments, attachments };
}

export async function uploadSignerAttachment(pool: Pool, t: string, session: string | undefined, body: Record<string, unknown>, ctx: Ctx = {}) {
  const r = await byToken(pool, t);
  if (!sessionOk(r, session) || !r.consented_at) throw new InvalidInput('confirm your identity and agree to sign first');
  if (r.e_status !== 'sent' || !['sent', 'viewed'].includes(r.status) || r.expires_at < new Date()) throw new InvalidInput('this document is no longer waiting for you');
  if (!r.allow_attachments) throw new InvalidInput('the sender did not request supporting files');
  const filename = text(body.filename, 180).replace(/[\\/\x00-\x1f]/g, '_');
  const contentType = text(body.contentType, 100);
  if (!filename || !['application/pdf', 'image/png', 'image/jpeg'].includes(contentType)) throw new InvalidInput('attach a PDF, PNG or JPEG');
  if (typeof body.base64 !== 'string' || body.base64.length > 14 * 1024 * 1024) throw new InvalidInput('an attachment must be 10 MB or smaller');
  const encoded = body.base64;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new InvalidInput('the attachment is not valid base64');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new InvalidInput('an attachment must be 10 MB or smaller');
  const valid = contentType === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : contentType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.subarray(0, 3).equals(Buffer.from([255,216,255]));
  if (!valid) throw new InvalidInput('the file does not match its PDF or image type');
  const count = await pool.query<{ n: number }>('select count(*)::int as n from sign_attachment where recipient_id = $1', [r.id]);
  if (count.rows[0]!.n >= 5) throw new InvalidInput('at most five supporting files per signer');
  const id = randomUUID();
  const key = `sign/attachments/${r.tenant_id}/${r.envelope_id}/${id}`;
  await objectStore().put(key, bytes, contentType, { sha256: hash(bytes) });
  try {
    await pool.query('insert into sign_attachment (id, envelope_id, recipient_id, filename, content_type, byte_size, sha256, storage_key) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, r.envelope_id, r.id, filename, contentType, bytes.length, hash(bytes), key]);
    await event(pool, r.envelope_id, r.id, 'attachment_uploaded', { id, filename, sha256: hash(bytes), bytes: bytes.length }, ctx);
  } catch (err) { await objectStore().remove(key).catch(() => undefined); throw err; }
  return { id, filename, sha256: hash(bytes), status: await objectStore().scan(key) };
}

export async function requestCode(pool: Pool, t: string, ctx: Ctx = {}) {
  return inTransaction(pool, async (client) => {
    const r = await byToken(client, t, true);
    if (r.e_status !== 'sent' || !['sent', 'viewed'].includes(r.status)) throw new InvalidInput('this document is not waiting for your signature');
    const windowStart = r.otp_window_start && r.otp_window_start > new Date(Date.now() - 3600_000) ? r.otp_window_start : new Date();
    const count = windowStart === r.otp_window_start ? r.otp_sent_count : 0;
    if (count >= 5) throw new InvalidInput('too many codes sent; try again in an hour');
    const x = r as typeof r & SignerExtra;
    const byEmail = x.verify_by !== 'sms'; const bySms = x.verify_by !== 'email';
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const smsCode = bySms ? String(randomInt(0, 1_000_000)).padStart(6, '0') : null;
    await client.query(`update sign_recipient set otp_hash = $2, sms_otp_hash = $6, otp_expires_at = now() + make_interval(mins => $3), otp_attempts = 0, otp_sent_count = $4, otp_window_start = $5 where id = $1`,
      [r.id, byEmail ? hash(`${r.id}:${code}`) : null, CODE_MINUTES, count + 1, windowStart, smsCode ? hash(`${r.id}:sms:${smsCode}`) : null]);
    if (byEmail) await mailer(client, { kind: 'signature_code', to: r.email, tenantId: r.tenant_id, idempotencyKey: `sign-code:${r.id}:${Date.now()}`, subject: `Your Patform Sign code`,
      text: `Your code to open "${r.title}" is ${code}.\n\nIt expires in ${CODE_MINUTES} minutes. If you did not ask for it, ignore this email.` });
    if (smsCode) {
      try { await sendSms(x.phone!, `${smsCode} is your Patform Sign code for "${r.title.slice(0, 40)}". It expires in ${CODE_MINUTES} minutes.`); }
      catch (err) { throw new InvalidInput(`the text message could not be sent: ${err instanceof Error ? err.message : String(err)}`); }
    }
    await event(client, r.envelope_id, r.id, 'code_sent', { channels: [byEmail && 'email', bySms && 'sms'].filter(Boolean) }, ctx);
    return { sentTo: [byEmail ? mask(r.email) : null, bySms ? maskPhone(x.phone!) : null].filter(Boolean).join(' and ') };
  });
}

export async function verifyCode(pool: Pool, t: string, code: unknown, ctx: Ctx = {}, smsCode?: unknown) {
  // A wrong code is counted and committed before it is refused; refusing inside
  // the transaction would undo the count, and the lock would never close.
  const out = await inTransaction(pool, async (client): Promise<{ session: string } | { wrong: true }> => {
    const r = await byToken(client, t, true);
    if (r.e_status !== 'sent' || !['sent', 'viewed'].includes(r.status)) throw new InvalidInput('this document is not waiting for your signature');
    const x = r as typeof r & SignerExtra;
    const byEmail = x.verify_by !== 'sms'; const bySms = x.verify_by !== 'email';
    if ((byEmail && !r.otp_hash) || (bySms && !x.sms_otp_hash) || !r.otp_expires_at || r.otp_expires_at < new Date()) throw new InvalidInput('the code has expired; ask for a new one');
    if (r.otp_attempts >= 5) throw new InvalidInput('too many wrong codes; ask for a new one');
    const emailOk = !byEmail || hash(`${r.id}:${text(code, 10)}`) === r.otp_hash;
    const smsOk = !bySms || hash(`${r.id}:sms:${text(bySms && !byEmail ? code : smsCode, 10)}`) === x.sms_otp_hash;
    if (!emailOk || !smsOk) {
      await client.query('update sign_recipient set otp_attempts = otp_attempts + 1 where id = $1', [r.id]);
      await event(client, r.envelope_id, r.id, 'code_wrong', {}, ctx);
      return { wrong: true };
    }
    const session = token();
    await client.query(`update sign_recipient set otp_hash = null, sms_otp_hash = null, session_hash = $2, session_expires_at = now() + make_interval(hours => $3), verified_at = coalesce(verified_at, now()),
                          viewed_at = coalesce(viewed_at, now()), status = 'viewed', ip = $4, user_agent = $5 where id = $1`, [r.id, hash(session), SESSION_HOURS, ctx.ip ?? null, ctx.userAgent?.slice(0, 300) ?? null]);
    await event(client, r.envelope_id, r.id, 'verified', { method: x.verify_by === 'email' ? 'email code' : x.verify_by === 'sms' ? 'text-message code' : 'email code and text-message code' }, ctx);
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
    // One signature at a time per envelope, so company signatory slots are handed out in order.
    await client.query('select 1 from sign_envelope where id = $1 for update', [r.envelope_id]);
    if (r.e_status !== 'sent' || r.expires_at < new Date()) throw new InvalidInput('this document is no longer waiting for signatures');
    const { rows: still } = await client.query<{ status: string }>('select status from sign_recipient where id = $1', [r.id]);
    if (!['sent', 'viewed'].includes(still[0]!.status)) throw new InvalidInput(still[0]!.status === 'not_needed' ? 'enough people have already signed for the company; your signature is no longer needed' : 'you have already responded');
    if (!r.consented_at) throw new InvalidInput('agree to sign electronically first');
    const { rows: attachments } = await client.query<{ storage_key: string; filename: string; sha256: string }>('select storage_key, filename, sha256 from sign_attachment where recipient_id = $1', [r.id]);
    for (const attachment of attachments) {
      const scan = await objectStore().scan(attachment.storage_key);
      if (scan !== 'clean') throw new InvalidInput(scan === 'scanning' ? `${attachment.filename} is still being checked; try again shortly` : `${attachment.filename} failed its malware check`);
      if (hash(await objectStore().get(attachment.storage_key)) !== attachment.sha256) throw new InvalidInput(`${attachment.filename} failed its fingerprint check`);
    }
    const x = r as typeof r & SignerExtra;
    const party = await partyOf(client, x.party_id);
    let slot: number | null = null;
    if (party) {
      if (body.authority !== true) throw new InvalidInput(`confirm you are authorised to sign on behalf of ${party.name}`);
      slot = party.signed + 1;
      if (slot > party.required_count) throw new InvalidInput('enough people have already signed for the company; your signature is no longer needed');
    }
    const signature = body.signature as SignatureValue;
    const problem = signatureProblem(signature);
    if (problem) throw new InvalidInput(problem);
    const initials = body.initials as SignatureValue | undefined;
    const values = (body.values && typeof body.values === 'object' ? body.values : {}) as Record<string, unknown>;
    const { rows: fields } = await client.query<{ id: string; kind: string; required: boolean; label: string | null }>(
      'select id, kind, required, label from sign_field where recipient_id = $1 or (party_id = $2 and slot = $3)', [r.id, x.party_id, slot]);
    if (fields.some((f) => f.kind === 'initials') && signatureProblem(initials)) throw new InvalidInput('add your initials');
    const today = new Date().toISOString().slice(0, 10);
    for (const f of fields) {
      let value: string | null = null;
      if (f.kind === 'signature') value = 'signature';
      else if (f.kind === 'initials') value = 'initials';
      else if (f.kind === 'date') value = today;
      else if (f.kind === 'name') value = signature.name.trim();
      else if (f.kind === 'title') value = x.signer_title ?? (text(values[f.id], 120) || null);
      else { value = text(values[f.id], 500) || null; if (!value && f.required) throw new InvalidInput(`fill in "${f.label ?? 'the text field'}"`); }
      await client.query('update sign_field set value = $2, filled_at = now(), filled_by = $3 where id = $1', [f.id, value, r.id]);
    }
    await client.query(`update sign_recipient set status = 'signed', signed_at = now(), signature = $2, initials = $3, ip = $4, user_agent = $5, session_hash = null, party_slot = $6,
                          authority_confirmed_at = $7, authority_statement = $8 where id = $1`,
      [r.id, JSON.stringify(signature), initials ? JSON.stringify(initials) : null, ctx.ip ?? null, ctx.userAgent?.slice(0, 300) ?? null, slot, party ? new Date() : null, party ? authorityText(party.name) : null]);
    await event(client, r.envelope_id, r.id, 'signed', { method: signature.method, name: signature.name.trim(), fields: fields.length, ...(party ? { for: party.name, slot } : {}) }, ctx);
    const { rows: e } = await client.query<EnvelopeRow>('select * from sign_envelope where id = $1', [r.envelope_id]);
    if (party && slot === party.required_count) {
      // The company has enough: the others are told they are no longer needed.
      await client.query('update sign_party set completed_at = now() where id = $1', [party.id]);
      const { rows: others } = await client.query<{ id: string; name: string; email: string; status: string }>(
        `update sign_recipient set status = 'not_needed', session_hash = null where party_id = $1 and status in ('waiting', 'sent', 'viewed') returning id, name, email, status`, [party.id]);
      for (const o of others) {
        await event(client, r.envelope_id, o.id, 'not_needed', { for: party.name });
        await mailer(client, { kind: 'signature_not_needed', to: o.email, tenantId: r.tenant_id, idempotencyKey: `sign-not-needed:${o.id}`, subject: `No longer needed: ${r.title}`,
          text: `Hello ${o.name},\n\nEnough authorised people have now signed "${r.title}" on behalf of ${party.name}, so your signature is no longer needed. Nothing more is required from you.` });
      }
    }
    const { rows: left } = await client.query<{ n: number }>(
      `select (select count(*)::int from sign_recipient where envelope_id = $1 and role = 'signer' and party_id is null and status <> 'signed')
            + (select count(*)::int from sign_party p where p.envelope_id = $1 and (select count(*) from sign_recipient r where r.party_id = p.id and r.status = 'signed') < p.required_count) as n`, [r.envelope_id]);
    if (left[0]!.n > 0) { await notifyNext(client, e[0]!, r.sender ? `${r.sender} (${r.workspace})` : r.workspace); return null; }
    await client.query(`update sign_envelope set status = 'finalizing' where id = $1`, [r.envelope_id]);
    return { ...e[0]!, status: 'finalizing' };
  });
  if (sealed) {
    try { await completeEnvelope(pool, sealed); }
    catch (err) { console.error(`signature finalization queued for retry on ${sealed.id}:`, err instanceof Error ? err.message : err); }
  }
  const completed = sealed ? (await pool.query<{ status: string }>('select status from sign_envelope where id = $1', [sealed.id])).rows[0]?.status === 'completed' : false;
  return { signed: true, completed, ...((sealed && !completed) ? { finalizing: true } : {}) };
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
  const lock = await pool.connect();
  try {
    await lock.query('select pg_advisory_lock(hashtext($1), hashtext($2))', ['sign-finalize', e.id]);
    const { rows: current } = await lock.query<{ status: string; final_sha256: string | null; final_file_id: string | null }>(
      'select status, final_sha256, final_file_id from sign_envelope where id = $1', [e.id]);
    if (current[0]?.status === 'completed' && current[0].final_sha256 && current[0].final_file_id)
      return { sha256: current[0].final_sha256, fileId: current[0].final_file_id };
    if (current[0]?.status !== 'finalizing') throw new Error('the envelope is not ready to finalize');
  const original = await documentBytes(lock, e.document_file_id);
  if (hash(original) !== e.original_sha256) throw new Error('the original document changed after the envelope was made');
  const { rows: recipients } = await lock.query<{ id: string; name: string; email: string; role: string; routing_order: number; signature: SignatureValue | null; initials: SignatureValue | null; verified_at: Date | null; consented_at: Date | null; viewed_at: Date | null; signed_at: Date | null; ip: string | null; user_agent: string | null; notified_at: Date | null;
    status: string; title: string | null; phone: string | null; verify_by: string; party_id: string | null; party_slot: number | null; authority_confirmed_at: Date | null; authority_statement: string | null; register_match: { officer: { name: string; role: string; appointedOn: string | null } | null; checkedAt: string } | null }>(
    `select id, name, email, role, routing_order, signature, initials, verified_at, consented_at, viewed_at, signed_at, ip, user_agent, notified_at, status, title, phone, verify_by, party_id, party_slot, authority_confirmed_at, authority_statement, register_match
       from sign_recipient where envelope_id = $1 order by role desc, routing_order, party_slot nulls first, created_at`, [e.id]);
  const { rows: fields } = await lock.query<{ recipient_id: string | null; filled_by: string | null; kind: string; page: number; x: number; y: number; width: number; height: number; value: string | null }>(
    `select recipient_id, filled_by, kind, page, x::float, y::float, width::float, height::float, value from sign_field where envelope_id = $1`, [e.id]);
  const { rows: parties } = await lock.query<{ id: string; name: string; required_count: number; authority_note: string | null; register: RegisterResult | null }>('select id, name, required_count, authority_note, register from sign_party where envelope_id = $1 order by routing_order, created_at', [e.id]);
  const { rows: events } = await lock.query<{ kind: string; occurred_at: Date; ip: string | null; name: string | null }>(
    `select v.kind, v.occurred_at, v.ip, r.name from sign_event v left join sign_recipient r on r.id = v.recipient_id where v.envelope_id = $1 order by v.id`, [e.id]);
  const { rows: t } = await lock.query<{ name: string }>('select name from tenant where id = $1', [e.tenant_id]);
  const { rows: attachments } = await lock.query<{ recipient_id: string; filename: string; sha256: string }>('select recipient_id, filename, sha256 from sign_attachment where envelope_id = $1 order by uploaded_at', [e.id]);
  const completedAt = new Date();
  const sealed = await sealPdf(original, {
    envelope: { id: e.id, number: e.number, title: e.title, workspace: t[0]!.name, originalSha256: e.original_sha256, routing: e.routing, completedAt },
    recipients: recipients.map((r) => ({ ...r, phone: r.phone ? maskPhone(r.phone) : null })), fields, events, parties, attachments,
  });
  const finalBytes = sealed.bytes;
  const sealInfo = sealConfig()?.info ?? null;
  const finalSha = hash(finalBytes);
  // The key stays the same across retries, so a failed database commit cannot
  // leave a growing trail of unreferenced final copies in the object store.
  const fileId = e.id;
  const key = `gov/files/${e.tenant_id}/${fileId}`;
  await objectStore().put(key, finalBytes, 'application/pdf', { sha256: finalSha });
  await lock.query('begin');
  try {
    const client = lock;
    await client.query(`insert into gov_file (id, tenant_id, purpose, contract_id, filename, content_type, byte_size, sha256, storage_key, scan_status) values ($1, $2, 'signed', $3, $4, 'application/pdf', $5, $6, $7, 'clean')`,
      [fileId, e.tenant_id, e.contract_id, `${e.title.replace(/[^a-zA-Z0-9 ._-]/g, '').slice(0, 60) || 'document'} - signed.pdf`, finalBytes.length, finalSha, key]);
    await client.query(`update sign_envelope set status = 'completed', completed_at = $2, final_file_id = $3, final_sha256 = $4, seal = $5, seal_timestamp = $6 where id = $1`,
      [e.id, completedAt, fileId, finalSha, sealInfo ? JSON.stringify(sealInfo) : null, sealInfo ? JSON.stringify(sealed.timestamp ?? { missing: sealed.timestampError ?? 'no timestamping authority configured' }) : null]);
    await event(client, e.id, null, 'completed', { sha256: finalSha, ...(sealInfo ? { seal: sealInfo.subject, timestamp: sealed.timestamp ?? null, timestampError: sealed.timestampError } : {}) });
    await closeContractEnvelope(client, e, 'completed', `gov-file:${fileId}`);
    // Everyone, copies included, gets a personal link to the signed copy for 30 days. Signers keep
    // the link they signed with; only those who never had one (copies) get a new one.
    const { rows: links } = await client.query<{ id: string; token_sealed: string | null }>('select id, token_sealed from sign_recipient where envelope_id = $1', [e.id]);
    for (const r of recipients.filter((x) => x.status !== 'not_needed')) {
      const sealedTk = links.find((l) => l.id === r.id)?.token_sealed;
      let tk: string;
      if (sealedTk) tk = unseal(sealedTk, `sign_recipient:${r.id}`).plaintext;
      else { tk = token(); await client.query('update sign_recipient set token_hash = $2, token_sealed = $3 where id = $1', [r.id, hash(tk), seal(tk, `sign_recipient:${r.id}`)]); }
      await mailer(client, { kind: 'signature_completed', to: r.email, tenantId: e.tenant_id, idempotencyKey: `sign-done:${r.id}`, subject: `Signed by everyone: ${e.title}`,
        text: `Hello ${r.name},\n\n"${e.title}" has been signed by everyone.\n\nDownload the signed copy (for ${FINAL_DAYS} days): ${appUrl()}/sign/${tk}\n\nIts fingerprint (SHA-256) is ${finalSha}. Anyone can check a copy at ${appUrl()}/sign/verify.` });
    }
    await lock.query('commit');
  } catch (error) {
    await lock.query('rollback');
    throw error;
  }
  return { sha256: finalSha, fileId };
  } finally {
    try { await lock.query('select pg_advisory_unlock(hashtext($1), hashtext($2))', ['sign-finalize', e.id]); }
    finally { lock.release(); }
  }
}

/** The signed copy, through any recipient's link, for 30 days after completion. */
export async function finalDocument(pool: Pool, t: string): Promise<Buffer> {
  const r = await byToken(pool, t);
  if (r.e_status !== 'completed' || !r.completed_at) throw new InvalidInput('the document is not complete');
  if (r.status === 'not_needed') throw new InvalidInput('your signature was not needed; ask the sender for a copy');
  if (Date.now() - r.completed_at.getTime() > FINAL_DAYS * 86400000) throw new InvalidInput('this download link has expired; ask the sender for a copy');
  const { rows } = await pool.query<{ final_file_id: string }>('select final_file_id from sign_envelope where id = $1', [r.envelope_id]);
  return documentBytes(pool, rows[0]!.final_file_id);
}

/** Public check: is this the sealed copy Patform produced? Says only what the signers already know. */
export async function verifyFingerprint(pool: Pool, body: Record<string, unknown>) {
  let sha = text(body.sha256, 64).toLowerCase();
  const file = typeof body.base64 === 'string' ? Buffer.from(body.base64, 'base64') : null;
  if (!sha && file) sha = hash(file);
  const seal = file ? checkSeal(file) : null;
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new InvalidInput('give the file or its SHA-256');
  const { rows } = await pool.query<{ id: string; number: number; title: string; completed_at: Date; workspace: string }>(
    `select e.id, e.number, e.title, e.completed_at, t.name as workspace from sign_envelope e join tenant t on t.id = e.tenant_id where e.final_sha256 = $1 and e.status = 'completed'`, [sha]);
  if (!rows[0]) return { valid: false, sha256: sha, seal, note: 'No document signed with Patform Sign has this fingerprint. If it was signed here, it has been changed since.' };
  const { rows: signers } = await pool.query<{ name: string; signed_at: Date; title: string | null; party: string | null }>(
    `select r.name, r.signed_at, r.title, p.name as party from sign_recipient r left join sign_party p on p.id = r.party_id where r.envelope_id = $1 and r.role = 'signer' and r.status = 'signed' order by r.signed_at`, [rows[0].id]);
  return { valid: true, sha256: sha, seal, title: rows[0].title, workspace: rows[0].workspace, envelope: `PS-${rows[0].number}`, completedAt: rows[0].completed_at, signers };
}
