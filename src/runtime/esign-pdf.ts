/**
 * Patform Sign's sealed PDF: the signers' fields stamped onto the original
 * pages, then a certificate of completion — who signed, how they were
 * verified, when, from where — with the original document's SHA-256.
 *
 * Field positions are fractions of the page's visible area (its crop box),
 * measured from the top left, exactly as the browser showed the page when
 * the sender placed them. A signer with no signature field gets a block on
 * an added signature page, so nobody's signature is ever left off.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { SignatureValue } from '../blueprint/signature.js';
import { addSealPlaceholder, applySeal, sealConfig } from './esign-seal.js';

export async function pageCount(bytes: Buffer): Promise<number> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
    return doc.getPageCount();
  } catch (err) {
    throw new Error(/encrypt/i.test(String(err)) ? 'the PDF is password-protected; upload an unprotected copy' : 'the file is not a readable PDF');
  }
}

interface Recipient { id: string; name: string; email: string; role: string; routing_order: number; signature: SignatureValue | null; initials: SignatureValue | null;
  verified_at: Date | null; consented_at: Date | null; viewed_at: Date | null; signed_at: Date | null; ip: string | null; user_agent: string | null; notified_at: Date | null;
  status?: string; title?: string | null; phone?: string | null; verify_by?: string; party_id?: string | null; party_slot?: number | null; authority_confirmed_at?: Date | null; authority_statement?: string | null }
interface Field { recipient_id: string | null; filled_by?: string | null; kind: string; page: number; x: number; y: number; width: number; height: number; value: string | null }
interface Party { id: string; name: string; required_count: number; authority_note: string | null }
interface Event { kind: string; occurred_at: Date; ip: string | null; name: string | null }
export interface SealInput {
  envelope: { id: string; number: number; title: string; workspace: string; originalSha256: string; routing: string; completedAt: Date };
  recipients: Recipient[]; fields: Field[]; events: Event[]; parties?: Party[];
}

const ink = rgb(0.05, 0.12, 0.35);
const grey = rgb(0.35, 0.35, 0.35);
const when = (d: Date | null) => (d ? `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC` : '—');

function fitText(font: PDFFont, s: string, maxWidth: number, maxSize: number) {
  let size = maxSize;
  while (size > 4 && font.widthOfTextAtSize(s, size) > maxWidth) size -= 0.5;
  return size;
}

async function drawSignature(doc: PDFDocument, page: PDFPage, sig: SignatureValue, box: { x: number; y: number; w: number; h: number }, script: PDFFont) {
  if (sig.method === 'drawn') {
    const png = await doc.embedPng(Buffer.from(sig.image.split(',')[1] ?? '', 'base64'));
    const scale = Math.min(box.w / png.width, box.h / png.height);
    const w = png.width * scale; const h = png.height * scale;
    page.drawImage(png, { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, width: w, height: h });
  } else {
    const s = sig.name.trim();
    const size = fitText(script, s, box.w * 0.95, box.h * 0.75);
    page.drawText(s, { x: box.x + 2, y: box.y + (box.h - size) / 2 + size * 0.2, size, font: script, color: ink });
  }
}

function wrap(font: PDFFont, s: string, size: number, width: number): string[] {
  const out: string[] = []; let line = '';
  for (const word of s.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

export async function sealPdf(original: Buffer, input: SealInput): Promise<Buffer> {
  // Keep our own metadata; pdf-lib would otherwise stamp itself as the producer.
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const script = await doc.embedFont(StandardFonts.TimesRomanBoldItalic);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const byId = new Map(input.recipients.map((r) => [r.id, r]));
  const pages = doc.getPages();

  for (const f of input.fields) {
    // A company box belongs to whoever signed that signatory slot.
    const r = byId.get(f.filled_by ?? f.recipient_id ?? '');
    const page = pages[f.page - 1];
    if (!r || !page || !f.value) continue;
    const cb = page.getCropBox();
    const box = { x: cb.x + f.x * cb.width, y: cb.y + cb.height - (f.y + f.height) * cb.height, w: f.width * cb.width, h: f.height * cb.height };
    if (f.kind === 'signature' && r.signature) await drawSignature(doc, page, r.signature, box, script);
    else if (f.kind === 'initials' && r.initials) await drawSignature(doc, page, r.initials, box, script);
    else {
      const s = f.value;
      const size = fitText(regular, s, box.w * 0.95, Math.min(box.h * 0.7, 11));
      page.drawText(s, { x: box.x + 2, y: box.y + (box.h - size) / 2 + size * 0.2, size, font: regular, color: rgb(0, 0, 0) });
    }
  }

  // Signers with no signature field get a block on a signature page.
  const parties = new Map((input.parties ?? []).map((p) => [p.id, p]));
  const unplaced = input.recipients.filter((r) => r.role === 'signer' && r.signature && r.status !== 'not_needed' && !input.fields.some((f) => (f.filled_by ?? f.recipient_id) === r.id && f.kind === 'signature'));
  if (unplaced.length) {
    let page = doc.addPage([595.28, 841.89]); let y = 780;
    page.drawText('Signatures', { x: 50, y, size: 16, font: bold }); y -= 30;
    for (const r of unplaced) {
      if (y < 120) { page = doc.addPage([595.28, 841.89]); y = 780; }
      await drawSignature(doc, page, r.signature!, { x: 50, y: y - 50, w: 240, h: 50 }, script);
      page.drawLine({ start: { x: 50, y: y - 55 }, end: { x: 300, y: y - 55 }, thickness: 0.5, color: grey });
      const party = r.party_id ? parties.get(r.party_id) : null;
      page.drawText(`${party ? `For and on behalf of ${party.name}: ` : ''}${r.name}${r.title ? `, ${r.title}` : ''} · ${r.email}`, { x: 50, y: y - 70, size: 9, font: regular });
      page.drawText(`Signed ${when(r.signed_at)}`, { x: 50, y: y - 82, size: 9, font: regular, color: grey });
      y -= 110;
    }
  }

  // The certificate of completion.
  const e = input.envelope;
  let page = doc.addPage([595.28, 841.89]); let y = 790;
  const line = (s: string, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; indent?: number } = {}) => {
    const size = opts.size ?? 9; const font = opts.font ?? regular;
    for (const part of wrap(font, s, size, 495 - (opts.indent ?? 0))) {
      if (y < 50) { page = doc.addPage([595.28, 841.89]); y = 790; }
      page.drawText(part, { x: 50 + (opts.indent ?? 0), y, size, font, color: opts.color ?? rgb(0, 0, 0) });
      y -= size + 4;
    }
  };
  line('Certificate of completion', { size: 18, font: bold }); y -= 6;
  line(`Envelope PS-${e.number} · ${e.id}`, { color: grey });
  line(`Document: ${e.title}`, { size: 11, font: bold });
  line(`Sent from: ${e.workspace} · signing order: ${e.routing === 'parallel' ? 'all at once' : 'one after another'}`);
  line(`Completed: ${when(e.completedAt)}`);
  line(`Original document SHA-256: ${e.originalSha256}`, { size: 8 });
  y -= 8;
  const how = (r: Recipient) => r.verify_by === 'sms' ? `one-time code by text message to ${r.phone ?? 'their phone'}` : r.verify_by === 'email_and_sms' ? `one-time codes to the same address and by text message to ${r.phone ?? 'their phone'}` : 'one-time code to the same address';
  for (const party of input.parties ?? []) {
    const signed = input.recipients.filter((r) => r.party_id === party.id && r.status === 'signed');
    line(`${party.name}: ${party.required_count} authorised signature(s) required; signed by ${signed.map((r) => `${r.name}${r.title ? ` (${r.title})` : ''}`).join(', ') || 'nobody'}`, { size: 10, font: bold });
    if (party.authority_note) line(`Authority recorded by the sender: ${party.authority_note}`, { indent: 12 });
  }
  if ((input.parties ?? []).length) y -= 4;
  line('Signers and copies', { size: 12, font: bold });
  for (const r of input.recipients) {
    y -= 4;
    const party = r.party_id ? parties.get(r.party_id) : null;
    line(`${r.name} <${r.email}> — ${r.role === 'cc' ? 'receives a copy' : party ? `signatory for ${party.name}${r.title ? `, ${r.title}` : ''}` : `signer ${r.routing_order}`}${r.status === 'not_needed' ? ' — not needed (enough signatories signed)' : ''}`, { font: bold });
    if (r.role === 'signer' && r.status !== 'not_needed') {
      line(`Identity: link sent to this email address; ${how(r)} verified ${when(r.verified_at)}`, { indent: 12 });
      line(`Agreed to sign electronically: ${when(r.consented_at)}`, { indent: 12 });
      if (r.authority_statement) line(`Confirmed authority: "${r.authority_statement}" ${when(r.authority_confirmed_at ?? null)}`, { indent: 12 });
      line(`Signed: ${when(r.signed_at)} · method: ${r.signature?.method === 'drawn' ? 'drawn' : 'typed and adopted'} · printed name: ${r.signature?.name ?? '—'}`, { indent: 12 });
      line(`IP address: ${r.ip ?? '—'} · browser: ${(r.user_agent ?? '—').slice(0, 110)}`, { indent: 12, color: grey, size: 8 });
    }
  }
  y -= 8;
  line('Event history', { size: 12, font: bold });
  for (const v of input.events) line(`${when(v.occurred_at)}  ${v.kind.replace(/_/g, ' ')}${v.name ? ` · ${v.name}` : ''}${v.ip ? ` · ${v.ip}` : ''}`, { size: 8 });
  y -= 8;
  line('About this signature', { size: 12, font: bold });
  line('Each signer opened a personal link and confirmed it was them with a one-time code, agreed to sign electronically, and signed. This is a simple electronic signature. The SHA-256 of this completed file is recorded by Patform; any copy can be checked at the verify page named in the completion email. A changed copy will not match.', { size: 8 });
  const sealInfo = sealConfig()?.info;
  if (sealInfo) line(`This file is sealed with a digital certificate (${sealInfo.subject}; issued by ${sealInfo.issuer}${sealInfo.selfIssued ? ', self-issued' : ''}). PDF readers show the seal and report any change made after it.`, { size: 8 });

  doc.setProducer('Patform Sign');
  doc.setSubject(`Envelope PS-${e.number}`);
  doc.setKeywords([`envelope:${e.id}`, `original-sha256:${e.originalSha256}`]);
  doc.setModificationDate(e.completedAt);
  if (sealInfo) addSealPlaceholder(doc, { number: e.number, workspace: e.workspace });
  const saved = Buffer.from(await doc.save({ useObjectStreams: false }));
  return sealInfo ? applySeal(saved) : saved;
}
