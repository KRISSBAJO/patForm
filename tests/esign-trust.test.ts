import { test } from 'node:test';
import assert from 'node:assert/strict';
import forge from 'node-forge';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { memoryObjectStore, setObjectStoreForTests } from '../src/runtime/object-store.js';
import { setGovTeamMember, updateGovSettings, uploadGovFile } from '../src/runtime/gov.js';
import { createEnvelope, envelopeDetail, finalDocument, giveConsent, requestCode, sendEnvelope, setSignMailerForTests, signDocument, signerView, verifyCode } from '../src/runtime/esign.js';
import { applySeal, checkSeal, setSealForTests } from '../src/runtime/esign-seal.js';
import { readTimestampResponse, timestampRequest } from '../src/runtime/esign-tsa.js';
import { matchOfficer, setRegisterProviderForTests, type RegisterLookup } from '../src/runtime/company-register.js';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function testCertificate(passphrase: string) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '02';
  cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date(Date.now() + 86400000 * 365);
  const attrs = [{ name: 'commonName', value: 'Patform Sign Test Seal' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: '3des' })).getBytes(), 'binary');
}
async function placeholderPdf() {
  const doc = await PDFDocument.create(); doc.addPage([595, 842]);
  pdflibAddPlaceholder({ pdfDoc: doc, reason: 'test', contactInfo: 'test', name: 'test', location: 'test', signatureLength: 32768 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test('time stamp: the request is well formed, a refusal is reported, and an unreachable authority leaves the seal without a stamp', async () => {
  const req = timestampRequest(Buffer.from('signature bytes'), Buffer.from('0102030405060708', 'hex'));
  assert.equal(req[0], 0x30, 'a DER SEQUENCE');
  assert.ok(req.toString('hex').includes('0609608648016503040201'), 'asks for SHA-256');
  assert.ok(req.toString('hex').endsWith('0101ff'), 'asks for the authority certificate');
  // A rejection (status 2) throws rather than pretending.
  const rejected = Buffer.from('300d300b0201020906300406010201', 'hex');
  assert.throws(() => readTimestampResponse(rejected), /refused the request/);

  setSealForTests({ p12: testCertificate('pw-123456789'), passphrase: 'pw-123456789' });
  try {
    const down = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    const out = await applySeal(await placeholderPdf(), { tsaUrl: 'http://tsa.invalid', fetchImpl: down });
    assert.equal(out.timestamp, null);
    assert.match(out.timestampError!, /HTTP 503/);
    const seal = checkSeal(out.bytes);
    assert.ok(seal.sealed && seal.intact, 'still sealed');
    assert.equal(seal.sealed && seal.timestamp, null);
    const off = await applySeal(await placeholderPdf(), { tsaUrl: null });
    assert.equal(off.timestamp, null); assert.equal(off.timestampError, null);
  } finally { setSealForTests(undefined); }
});

test('time stamp: DigiCert signs the time into the seal, and a reader can tie it to this signature', async () => {
  setSealForTests({ p12: testCertificate('pw-123456789'), passphrase: 'pw-123456789' });
  try {
    const out = await applySeal(await placeholderPdf(), { tsaUrl: 'http://timestamp.digicert.com' });
    if (!out.timestamp) { console.log(`  (timestamping authority not reachable from here: ${out.timestampError}; stamp checks skipped)`); return; }
    assert.match(out.timestamp.authority, /DigiCert/i);
    assert.ok(Math.abs(new Date(out.timestamp.time).getTime() - Date.now()) < 10 * 60_000, 'the stamped time is now');
    const seal = checkSeal(out.bytes);
    assert.ok(seal.sealed && seal.intact);
    assert.ok(seal.sealed && seal.timestamp && seal.timestamp.coversSignature, 'the stamp is over this very signature');
    assert.ok(seal.sealed && /DigiCert/i.test(seal.timestamp!.authority));
    // Tampering breaks the seal; the stamp is then over a signature that no longer matches the file.
    // A byte inside the signed range (the file's head), not in the signature's own padding.
    const t = Buffer.from(out.bytes); t[40] ^= 1;
    const broken = checkSeal(t);
    assert.ok(broken.sealed && !broken.intact);
  } finally { setSealForTests(undefined); }
});

test('register names: "SURNAME, Forename Middle" matches the signer with or without middle names or an initial, and nobody else', () => {
  const officers = [{ name: 'OKAFOR, Chidi Emeka', role: 'director', appointedOn: '2019-03-01' }, { name: 'SMITH, John Andrew', role: 'secretary', appointedOn: null }];
  assert.equal(matchOfficer('Chidi Okafor', officers)?.role, 'director');
  assert.equal(matchOfficer('Chidi Emeka Okafor', officers)?.role, 'director');
  assert.equal(matchOfficer('C. Okafor', officers)?.role, 'director');
  assert.equal(matchOfficer('Dr John Smith', officers)?.role, 'secretary');
  assert.equal(matchOfficer('Emeka Okafor', officers)?.role, 'director', 'people often go by a middle name');
  assert.equal(matchOfficer('Chidi Okoro', officers), null);
  assert.equal(matchOfficer('Okafor', officers), null, 'one word is not a name');
});

async function setup(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`signr-${stamp()}`, { scenario: true });
  const mk = async (who: string, role: 'owner' | 'admin' | 'operator') => {
    const id = await engine.createActor(tenantId, `${who.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@signr.test`, who, role);
    return { id, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner'); const admin = await mk('Ada Admin', 'admin'); const staff = await mk('Sam Staff', 'operator');
  await setModule(pool, owner.p, 'contracts', { enabled: true });
  await setGovTeamMember(pool, admin.p, { team: 'legal', actorId: staff.id });
  await updateGovSettings(pool, admin.p, { alwaysReview: ['legal'] });
  const mails: { kind: string; to: string; text: string }[] = [];
  setSignMailerForTests(async (_p, m) => { mails.push(m); });
  const doc = await PDFDocument.create(); doc.addPage([595, 842]);
  const up = await uploadGovFile(pool, staff.p, { purpose: 'signing', filename: 'deal.pdf', base64: Buffer.from(await doc.save()).toString('base64') });
  const link = (to: string) => /\/sign\/([A-Za-z0-9_-]+)/.exec([...mails].reverse().find((x) => x.to === to && x.kind === 'signature_request')!.text)![1]!;
  const code = (to: string) => /is (\d{6})/.exec([...mails].reverse().find((x) => x.to === to && x.kind === 'signature_code')!.text)![1]!;
  return { tenantId, staff, mails, up, link, code };
}

test('company register: an inactive company cannot sign; listed officers are recorded; unlisted ones are allowed unless the sender insists; no provider is said plainly', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  const calls: string[] = [];
  const fakeHouse: RegisterLookup = async (raw) => {
    const number = raw.padStart(8, '0'); // as Companies House numbers are written
    calls.push(number);
    const checkedAt = new Date().toISOString();
    if (number === '00000001') return { available: true, country: 'GB', number, companyName: 'GONE LTD', status: 'dissolved', officers: [], checkedAt, source: 'Companies House' };
    if (number === '00000404') return { available: true, country: 'GB', number, status: 'not found', officers: [], checkedAt, source: 'Companies House' };
    return { available: true, country: 'GB', number, companyName: 'ACME TRADING LIMITED', status: 'active', checkedAt, source: 'Companies House',
      officers: [{ name: 'OKAFOR, Chidi', role: 'director', appointedOn: '2019-03-01' }, { name: 'ADEBAYO, Bisi', role: 'secretary', appointedOn: '2021-06-15' }] };
  };
  setRegisterProviderForTests('GB', fakeHouse);
  try {
    const w = await setup(pool, engine);
    const dirs = [['Chidi Okafor', 'Director'], ['Bisi Adebayo', 'Company Secretary'], ['Tunde Outsider', 'Attorney']].map(([name, title]) => ({ name, title, email: `${name!.split(' ')[0]!.toLowerCase()}-${stamp()}@acme.test`, party: 'Acme Trading Ltd' }));
    const base = { documentRef: w.up.reference, title: 'Supply deal', recipients: dirs };
    await assert.rejects(createEnvelope(pool, w.staff.p, { ...base, parties: [{ name: 'Acme Trading Ltd', required: 2, register: { country: 'GB', number: '1' } }] }), /lists GB 00000001 as dissolved \(GONE LTD\)/);
    await assert.rejects(createEnvelope(pool, w.staff.p, { ...base, parties: [{ name: 'Acme Trading Ltd', required: 2, register: { country: 'GB', number: '404' } }] }), /as not found/);
    await assert.rejects(createEnvelope(pool, w.staff.p, { ...base, parties: [{ name: 'Acme Trading Ltd', required: 2, register: { country: 'GB', number: '12345678' }, requireRegistered: true }] }), /Tunde Outsider is not listed as a current officer of ACME TRADING LIMITED at Companies House/);
    const env = await createEnvelope(pool, w.staff.p, { ...base, parties: [{ name: 'Acme Trading Ltd', required: 2, register: { country: 'GB', number: '12345678' }, authorityNote: 'Power of attorney for Tunde, 2026-01-10' }] });
    assert.deepEqual(env.parties[0]!.unlisted, [dirs[2]!.email]);
    assert.equal(env.parties[0]!.register!.companyName, 'ACME TRADING LIMITED');
    const d = await envelopeDetail(pool, w.staff.p, env.id);
    assert.equal(d.parties[0].register.status, 'active');
    const byName = Object.fromEntries(d.recipients.map((r: { name: string; register_match: { officer: { role: string } | null } | null }) => [r.name, r.register_match?.officer?.role ?? null]));
    assert.deepEqual(byName, { 'Chidi Okafor': 'director', 'Bisi Adebayo': 'secretary', 'Tunde Outsider': null });

    // The signer sees what the register says about them; the sealed certificate carries it too.
    await sendEnvelope(pool, w.staff.p, env.id);
    const t = w.link(dirs[0]!.email);
    const view = await signerView(pool, t);
    assert.equal(view.party!.register!.companyName, 'ACME TRADING LIMITED');
    assert.equal(view.party!.listedAs, 'director since 2019-03-01');
    assert.equal((await signerView(pool, w.link(dirs[2]!.email))).party!.listedAs, 'not listed as an officer');
    for (const who of [dirs[0]!, dirs[2]!]) {
      const tk = w.link(who.email);
      await requestCode(pool, tk);
      const { session } = await verifyCode(pool, tk, w.code(who.email));
      await giveConsent(pool, tk, session);
      await signDocument(pool, tk, session, { signature: { method: 'typed', name: who.name, style: 'flowing' }, authority: true });
    }
    const sealed = await finalDocument(pool, t);
    const parsed = await PDFDocument.load(sealed, { updateMetadata: false });
    assert.ok(parsed.getPageCount() >= 2);
    // The certificate page's text sits in compressed streams.
    const streams = [...sealed.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((m) => { try { return inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1'); } catch { return ''; } }).join('\n');
    // Text is written as hex-encoded strings; decode them before looking.
    const decoded = streams.replace(/<([0-9A-Fa-f]+)>/g, (_, h: string) => Buffer.from(h, 'hex').toString('latin1'));
    assert.ok(/Companies House/.test(decoded), 'the certificate names the register');
    assert.ok(/Not listed as an officer/.test(decoded), 'and says who was not listed');

    // Nigeria: no provider, said plainly; insisting on the register is refused.
    await assert.rejects(createEnvelope(pool, w.staff.p, { ...base, parties: [{ name: 'Acme Trading Ltd', required: 2, register: { country: 'NG', number: 'RC123456' }, requireRegistered: true }] }), /no register provider is set up for Nigeria/);
    const ng = await createEnvelope(pool, w.staff.p, { ...base, parties: [{ name: 'Acme Trading Ltd', required: 2, register: { country: 'NG', number: 'RC123456' } }] });
    assert.equal(ng.parties[0]!.register!.available, false);
    assert.deepEqual(ng.parties[0]!.unlisted, [], 'nobody is called unlisted when nothing was checked');
    assert.deepEqual(calls, ['00000001', '00000404', '12345678', '12345678']);
  } finally { setRegisterProviderForTests('GB', undefined); setSignMailerForTests(null); setObjectStoreForTests(undefined); await pool.end(); }
});
