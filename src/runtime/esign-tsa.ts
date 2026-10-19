/**
 * The seal's trusted time stamp (RFC 3161).
 *
 * After the seal's signature is made, its bytes are hashed and sent to a
 * timestamping authority, which signs the hash together with the time from
 * its own clock. That token goes into the seal as an unsigned attribute, so
 * a PDF reader can show "signed at <time>, as attested by <authority>" and
 * can keep trusting the time after Patform's own certificate has expired.
 *
 * SIGN_TSA_URL names the authority; the default, DigiCert's public service,
 * is free and on Adobe's trusted list. When the authority cannot be
 * reached the seal is still made, without the stamp, and that is recorded.
 */
import { createHash, randomBytes } from 'node:crypto';
import forge from 'node-forge';
import { P12Signer } from '@signpdf/signer-p12';

export const DEFAULT_TSA = 'http://timestamp.digicert.com';
const OID_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const { asn1 } = forge;
const der = (v: forge.asn1.Asn1) => Buffer.from(asn1.toDer(v).getBytes(), 'binary');

/** A TimeStampReq over the SHA-256 of `signature`. */
export function timestampRequest(signature: Buffer, nonce = randomBytes(8)): Buffer {
  const seq = (...v: forge.asn1.Asn1[]) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, v);
  const int = (b: Buffer) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, b.toString('binary'));
  return der(seq(
    int(Buffer.from([1])),
    seq(seq(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(OID_SHA256).getBytes()), asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, '')),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, createHash('sha256').update(signature).digest('binary'))),
    int(Buffer.concat([Buffer.from([0]), nonce])),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, '\xff'),
  ));
}

export interface Timestamp { time: string; authority: string; token: Buffer }

/** Reads a TimeStampResp: the token, when it says, and who issued it. Throws when the authority refused. */
export function readTimestampResponse(resp: Buffer): Timestamp {
  const top = asn1.fromDer(forge.util.createBuffer(resp.toString('binary')));
  const status = top.value[0] as forge.asn1.Asn1;
  const code = (status.value[0] as forge.asn1.Asn1).value as string;
  if (code.charCodeAt(code.length - 1) > 1) throw new Error(`the timestamping authority refused the request (status ${code.charCodeAt(code.length - 1)})`);
  const token = top.value[1] as forge.asn1.Asn1 | undefined;
  if (!token) throw new Error('the timestamping authority sent no token');
  return { ...describeToken(token), token: der(token) };
}

/** When and by whom, from a TimeStampToken (a ContentInfo holding SignedData over TSTInfo). */
export function describeToken(token: forge.asn1.Asn1): { time: string; authority: string; imprint: string } {
  const signedData = (token.value[1] as forge.asn1.Asn1).value[0] as forge.asn1.Asn1;
  const encap = signedData.value[2] as forge.asn1.Asn1;
  const tstDer = ((encap.value[1] as forge.asn1.Asn1).value[0] as forge.asn1.Asn1).value as string;
  const tst = asn1.fromDer(forge.util.createBuffer(tstDer));
  const imprint = forge.util.bytesToHex(((tst.value[2] as forge.asn1.Asn1).value[1] as forge.asn1.Asn1).value as string);
  const genTime = (tst.value[4] as forge.asn1.Asn1).value as string;
  const time = asn1.generalizedTimeToDate(genTime).toISOString();
  let authority = 'unknown authority';
  for (const v of signedData.value as forge.asn1.Asn1[]) {
    if (v.tagClass !== asn1.Class.CONTEXT_SPECIFIC || v.type !== 0) continue;
    try {
      const cert = forge.pki.certificateFromAsn1(v.value[0] as forge.asn1.Asn1);
      const cn = cert.subject.getField('CN') as { value?: string } | null;
      const o = cert.subject.getField('O') as { value?: string } | null;
      authority = [cn?.value, o?.value].filter(Boolean).join(', ') || authority;
    } catch { /* not a certificate */ }
  }
  return { time, authority, imprint };
}

export async function fetchTimestamp(signature: Buffer, url = process.env.SIGN_TSA_URL ?? DEFAULT_TSA, doFetch: typeof fetch = fetch): Promise<Timestamp> {
  const res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/timestamp-query' }, body: new Uint8Array(timestampRequest(signature)), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`the timestamping authority answered HTTP ${res.status}`);
  return readTimestampResponse(Buffer.from(await res.arrayBuffer()));
}

/**
 * The seal's signer with the time stamp added: the plain PKCS#7 signature,
 * then the authority's token as the signer's unsigned attribute.
 */
export class TimestampedP12Signer extends P12Signer {
  lastTimestamp: Timestamp | null = null;
  lastError: string | null = null;
  constructor(p12: Buffer, opts: { passphrase: string; tsaUrl?: string | null; fetchImpl?: typeof fetch }) {
    super(p12, { passphrase: opts.passphrase });
    this.tsaUrl = opts.tsaUrl === undefined ? process.env.SIGN_TSA_URL ?? DEFAULT_TSA : opts.tsaUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }
  private tsaUrl: string | null;
  private fetchImpl: typeof fetch;

  async sign(pdfBuffer: Buffer, signingTime?: Date): Promise<Buffer> {
    const plain = await super.sign(pdfBuffer, signingTime);
    this.lastTimestamp = null; this.lastError = null;
    if (!this.tsaUrl) return plain;
    const p7 = asn1.fromDer(forge.util.createBuffer(plain.toString('binary')));
    const signedData = (p7.value[1] as forge.asn1.Asn1).value[0] as forge.asn1.Asn1;
    const signerInfos = signedData.value[signedData.value.length - 1] as forge.asn1.Asn1;
    const signerInfo = signerInfos.value[0] as forge.asn1.Asn1;
    const encryptedDigest = signerInfo.value[signerInfo.value.length - 1] as forge.asn1.Asn1;
    let stamp: Timestamp;
    try { stamp = await fetchTimestamp(Buffer.from(encryptedDigest.value as string, 'binary'), this.tsaUrl, this.fetchImpl); }
    catch (err) { this.lastError = err instanceof Error ? err.message : String(err); return plain; }
    const attr = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(OID_TIMESTAMP_TOKEN).getBytes()),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [asn1.fromDer(forge.util.createBuffer(stamp.token.toString('binary')))]),
    ]);
    (signerInfo.value as forge.asn1.Asn1[]).push(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 1, true, [attr]));
    this.lastTimestamp = stamp;
    return der(p7);
  }
}

/** The time stamp inside a seal's SignerInfo, if there is one, and whether it covers that signature. */
export function timestampIn(signerInfo: forge.asn1.Asn1, encryptedDigest: Buffer): { time: string; authority: string; coversSignature: boolean } | null {
  for (const v of signerInfo.value as forge.asn1.Asn1[]) {
    if (v.tagClass !== asn1.Class.CONTEXT_SPECIFIC || v.type !== 1) continue;
    for (const attr of v.value as forge.asn1.Asn1[]) {
      const oid = asn1.derToOid((attr.value as forge.asn1.Asn1[])[0]!.value as string);
      if (oid !== OID_TIMESTAMP_TOKEN) continue;
      const token = ((attr.value as forge.asn1.Asn1[])[1]!.value as forge.asn1.Asn1[])[0]!;
      const d = describeToken(token);
      return { time: d.time, authority: d.authority, coversSignature: d.imprint === createHash('sha256').update(encryptedDigest).digest('hex') };
    }
  }
  return null;
}
void OID_TST_INFO;
