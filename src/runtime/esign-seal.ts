/**
 * The certificate seal on a finished Patform Sign PDF.
 *
 * A PDF signature (adbe.pkcs7.detached, SHA-256) made with the certificate in
 * SIGN_SEAL_P12_BASE64 (a PKCS#12 file, base64) and SIGN_SEAL_PASSPHRASE.
 * PDF readers such as Adobe Acrobat show the seal and report any change made
 * after it. Whether they also show it as *trusted* depends on the certificate:
 * one from a provider on Adobe's trusted list is shown as trusted; a
 * certificate made with scripts/make-seal-certificate.mts gives the same
 * tamper protection but is shown as "identity unknown".
 *
 * Without a certificate configured, files are still sealed the way they were
 * before — the recorded SHA-256 and the verify page — just without this.
 */
import { createHash } from 'node:crypto';
import forge from 'node-forge';
import { SignPdf } from '@signpdf/signpdf';
import { TimestampedP12Signer, timestampIn } from './esign-tsa.js';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import type { PDFDocument } from 'pdf-lib';

export interface SealInfo { subject: string; issuer: string; serial: string; notAfter: string; selfIssued: boolean }

let cached: { p12: Buffer; passphrase: string; info: SealInfo } | null | undefined;
export function setSealForTests(v: { p12: Buffer; passphrase: string } | null | undefined) { cached = v === undefined ? undefined : v === null ? null : { ...v, info: describe(v.p12, v.passphrase) }; }

function describe(p12: Buffer, passphrase: string): SealInfo {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12.toString('binary')));
  const bundle = forge.pkcs12.pkcs12FromAsn1(asn1, passphrase);
  const certBag = forge.pki.oids.certBag!;
  const bags = bundle.getBags({ bagType: certBag })[certBag] ?? [];
  const cert = bags[0]?.cert;
  if (!cert) throw new Error('the seal file holds no certificate');
  const name = (attrs: forge.pki.CertificateField[]) => attrs.map((a) => `${a.shortName ?? a.name}=${a.value}`).join(', ');
  return { subject: name(cert.subject.attributes), issuer: name(cert.issuer.attributes), serial: cert.serialNumber, notAfter: cert.validity.notAfter.toISOString(), selfIssued: name(cert.subject.attributes) === name(cert.issuer.attributes) };
}

/** The configured seal, or null. A broken configuration is an error, not a silent unsealed file. */
export function sealConfig() {
  if (cached !== undefined) return cached;
  const b64 = process.env.SIGN_SEAL_P12_BASE64;
  if (!b64) { cached = null; return cached; }
  const p12 = Buffer.from(b64, 'base64');
  const passphrase = process.env.SIGN_SEAL_PASSPHRASE ?? '';
  cached = { p12, passphrase, info: describe(p12, passphrase) };
  return cached;
}

/** Adds the empty signature to the document before it is saved. */
export function addSealPlaceholder(doc: PDFDocument, envelope: { number: number; workspace: string }) {
  // Room for the signature, the certificate chain and a timestamping authority's token.
  pdflibAddPlaceholder({ pdfDoc: doc, reason: `Patform Sign envelope PS-${envelope.number}: all parties have signed`, contactInfo: 'Patform Sign', name: 'Patform Sign', location: envelope.workspace, signatureLength: 32768, appName: 'Patform Sign' });
}

export interface SealOutcome { bytes: Buffer; timestamp: { time: string; authority: string } | null; timestampError: string | null }
/** Signs the saved bytes, with a trusted time stamp when the authority answers. */
export async function applySeal(bytes: Buffer, opts: { tsaUrl?: string | null; fetchImpl?: typeof fetch } = {}): Promise<SealOutcome> {
  const c = sealConfig();
  if (!c) return { bytes, timestamp: null, timestampError: null };
  const configured = process.env.SIGN_TSA_URL;
  const tsaUrl = opts.tsaUrl !== undefined ? opts.tsaUrl : configured === 'none' ? null : undefined;
  const signer = new TimestampedP12Signer(c.p12, { passphrase: c.passphrase, tsaUrl, fetchImpl: opts.fetchImpl });
  const out = await new SignPdf().sign(bytes, signer);
  return { bytes: out, timestamp: signer.lastTimestamp ? { time: signer.lastTimestamp.time, authority: signer.lastTimestamp.authority } : null, timestampError: signer.lastError };
}

/**
 * Checks a sealed file the way a PDF reader would: the bytes covered by the
 * signature hash to the digest inside it, and the certificate's key signed
 * that digest. Says nothing about whether the certificate is trusted.
 */
export function checkSeal(bytes: Buffer): { sealed: false } | { sealed: true; intact: boolean; covers: 'whole file' | 'part of the file'; signer: string; issuer: string; signedAt: string | null; timestamp: { time: string; authority: string; coversSignature: boolean } | null } {
  const text = bytes.toString('latin1');
  const at = text.lastIndexOf('/ByteRange');
  if (at < 0) return { sealed: false };
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text.slice(at));
  if (!m) return { sealed: false };
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
  const signed = Buffer.concat([bytes.subarray(a, a + b), bytes.subarray(c, c + d)]);
  const hex = text.slice(a + b, c).replace(/[<>\s]/g, '').replace(/(00)+$/, '');
  try {
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.hexToBytes(hex))) as forge.pkcs7.PkcsSignedData & { rawCapture: { authenticatedAttributes: forge.asn1.Asn1[]; signature: string } };
    const cert = p7.certificates[0]!;
    const attrs = p7.rawCapture.authenticatedAttributes;
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
    const md = forge.md.sha256.create(); md.update(forge.asn1.toDer(set).getBytes());
    const keyOk = (cert.publicKey as forge.pki.rsa.PublicKey).verify(md.digest().bytes(), p7.rawCapture.signature);
    let digest: string | null = null; let signedAt: string | null = null;
    for (const attr of attrs) {
      const oid = forge.asn1.derToOid((attr.value as forge.asn1.Asn1[])[0]!.value as string);
      const val = ((attr.value as forge.asn1.Asn1[])[1]!.value as forge.asn1.Asn1[])[0]!;
      if (oid === forge.pki.oids.messageDigest) digest = forge.util.bytesToHex(val.value as string);
      if (oid === forge.pki.oids.signingTime) signedAt = forge.asn1.utcTimeToDate(val.value as string).toISOString();
    }
    const intact = keyOk && digest === createHash('sha256').update(signed).digest('hex');
    const name = (attrs2: forge.pki.CertificateField[]) => attrs2.map((x) => `${x.shortName ?? x.name}=${x.value}`).join(', ');
    const signedData = (forge.asn1.fromDer(forge.util.hexToBytes(hex)).value[1] as forge.asn1.Asn1).value[0] as forge.asn1.Asn1;
    const infos = signedData.value[signedData.value.length - 1] as forge.asn1.Asn1;
    let timestamp: { time: string; authority: string; coversSignature: boolean } | null = null;
    try { timestamp = timestampIn(infos.value[0] as forge.asn1.Asn1, Buffer.from(p7.rawCapture.signature, 'binary')); } catch { timestamp = null; }
    return { sealed: true, intact, covers: c + d === bytes.length ? 'whole file' : 'part of the file', signer: name(cert.subject.attributes), issuer: name(cert.issuer.attributes), signedAt, timestamp };
  } catch {
    return { sealed: true, intact: false, covers: 'part of the file', signer: 'unreadable', issuer: 'unreadable', signedAt: null, timestamp: null };
  }
}
