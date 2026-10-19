import { test } from 'node:test';
import assert from 'node:assert/strict';
import forge from 'node-forge';
import { PDFDocument } from 'pdf-lib';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { memoryObjectStore, setObjectStoreForTests } from '../src/runtime/object-store.js';
import { setGovTeamMember, updateGovSettings, uploadGovFile } from '../src/runtime/gov.js';
import {
  createEnvelope, envelopeDetail, finalDocument, giveConsent, requestCode, sendEnvelope, setFields, setSignMailerForTests, signDocument, signerView, verifyCode, verifyFingerprint,
} from '../src/runtime/esign.js';
import { checkSeal, setSealForTests } from '../src/runtime/esign-seal.js';
import { setSmsSenderForTests } from '../src/runtime/sms.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function testCertificate(passphrase: string) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date(Date.now() + 86400000 * 365);
  const attrs = [{ name: 'commonName', value: 'Patform Sign Test Seal' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: '3des' })).getBytes(), 'binary');
}

async function setup(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`signx-${stamp()}`, { scenario: true });
  const mk = async (who: string, role: 'owner' | 'admin' | 'operator') => {
    const id = await engine.createActor(tenantId, `${who.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@signx.test`, who, role);
    return { id, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner'); const admin = await mk('Ada Admin', 'admin'); const staff = await mk('Sam Staff', 'operator');
  await setModule(pool, owner.p, 'contracts', { enabled: true });
  await setGovTeamMember(pool, admin.p, { team: 'legal', actorId: staff.id });
  await updateGovSettings(pool, admin.p, { alwaysReview: ['legal'] });
  const mails: { kind: string; to: string; subject: string; text: string }[] = [];
  const texts: { to: string; body: string }[] = [];
  setSignMailerForTests(async (_p, m) => { mails.push(m); });
  setSmsSenderForTests(async (to, body) => { texts.push({ to, body }); });
  const doc = await PDFDocument.create(); doc.addPage([595, 842]);
  const up = await uploadGovFile(pool, staff.p, { purpose: 'signing', filename: 'agreement.pdf', base64: Buffer.from(await doc.save()).toString('base64') });
  const link = (to: string, kind = 'signature_request') => { const m = [...mails].reverse().find((x) => x.to === to && x.kind === kind); return m ? /\/sign\/([A-Za-z0-9_-]+)/.exec(m.text)![1]! : null; };
  const emailCode = (to: string) => /is (\d{6})/.exec([...mails].reverse().find((x) => x.to === to && x.kind === 'signature_code')!.text)![1]!;
  const smsCode = (to: string) => /^(\d{6})/.exec([...texts].reverse().find((x) => x.to === to)!.body)![1]!;
  return { tenantId, staff, mails, texts, up, link, emailCode, smsCode };
}
const typed = (name: string) => ({ method: 'typed', name, style: 'flowing' });
/** Asks for a fresh code, then reads it, the way a signer would. */
async function signAs(pool: Pool, t: string, code: () => string, name: string, extra: Record<string, unknown> = {}, smsCode?: () => string) {
  await requestCode(pool, t);
  const { session } = await verifyCode(pool, t, code(), {}, smsCode?.());
  await giveConsent(pool, t, session);
  return signDocument(pool, t, session, { signature: typed(name), ...extra });
}

test('certificate seal: the finished PDF carries a digital signature over the whole file; changing one byte breaks it', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  setSealForTests({ p12: testCertificate('seal-pass-123'), passphrase: 'seal-pass-123' });
  try {
    const w = await setup(pool, engine);
    const email = `ola-${stamp()}@signx.test`;
    const env = await createEnvelope(pool, w.staff.p, { documentRef: w.up.reference, title: 'Sealed deal', recipients: [{ name: 'Ola Signer', email }] });
    await sendEnvelope(pool, w.staff.p, env.id);
    const t = w.link(email)!;
    await requestCode(pool, t);
    assert.equal((await signAs(pool, t, () => '000000', 'Ola Signer').catch(() => null)), null, 'a wrong code does not sign');
    const done = await signAs(pool, t, () => w.emailCode(email), 'Ola Signer');
    assert.equal(done.completed, true);
    const sealed = await finalDocument(pool, t);
    const seal = checkSeal(sealed);
    assert.equal(seal.sealed, true);
    assert.ok(seal.sealed && seal.intact, 'the seal checks out');
    assert.ok(seal.sealed && seal.covers === 'whole file');
    assert.ok(seal.sealed && /Patform Sign Test Seal/.test(seal.signer));
    const d = await envelopeDetail(pool, w.staff.p, env.id);
    assert.equal((d.envelope as unknown as { seal: { selfIssued: boolean } }).seal.selfIssued, true);
    // One byte changed inside the signed part: the seal no longer holds, and the fingerprint no longer matches.
    const tampered = Buffer.from(sealed); const i = Math.floor(tampered.length / 3); tampered[i] = tampered[i]! ^ 1;
    const broken = checkSeal(tampered);
    assert.ok(broken.sealed && !broken.intact);
    const check = await verifyFingerprint(pool, { base64: sealed.toString('base64') });
    assert.equal(check.valid, true);
    assert.ok(check.seal && check.seal.sealed && check.seal.intact);
    assert.equal((await verifyFingerprint(pool, { base64: tampered.toString('base64') })).valid, false);
  } finally { setSealForTests(undefined); setSignMailerForTests(null); setSmsSenderForTests(null); setObjectStoreForTests(undefined); await pool.end(); }
});

test('codes by text message: by SMS alone, or email and SMS together; both must be right', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  try {
    const w = await setup(pool, engine);
    const a = { name: 'Amaka Phone', email: `amaka-${stamp()}@signx.test`, phone: '+2348012345678', verifyBy: 'sms' };
    const b = { name: 'Bayo Both', email: `bayo-${stamp()}@signx.test`, phone: '+44 7700 900123', verifyBy: 'email_and_sms' };
    await assert.rejects(createEnvelope(pool, w.staff.p, { documentRef: w.up.reference, title: 'x', recipients: [{ ...a, phone: '0801234' }] }), /international form/);
    await assert.rejects(createEnvelope(pool, w.staff.p, { documentRef: w.up.reference, title: 'x', recipients: [{ ...a, phone: '' }] }), /needs a phone number/);
    const env = await createEnvelope(pool, w.staff.p, { documentRef: w.up.reference, title: 'Two ways', routing: 'parallel', recipients: [a, b] });
    await sendEnvelope(pool, w.staff.p, env.id);
    assert.match(w.mails.find((m) => m.to === a.email && m.kind === 'signature_request')!.text, /text a code to your phone/);

    // SMS only: no email code is sent; the text carries it.
    const ta = w.link(a.email)!;
    const view = await signerView(pool, ta);
    assert.equal(view.verifyBy, 'sms');
    assert.match(view.phone!, /^\+234•+78$/);
    const sentTo = await requestCode(pool, ta);
    assert.match(sentTo.sentTo, /^\+234/);
    assert.ok(!w.mails.some((m) => m.to === a.email && m.kind === 'signature_code'));
    assert.equal(w.texts.at(-1)!.to, '+2348012345678');
    await signAs(pool, ta, () => w.smsCode('+2348012345678'), 'Amaka Phone');

    // Both: the email code alone is not enough.
    const tb = w.link(b.email)!;
    await requestCode(pool, tb);
    await assert.rejects(verifyCode(pool, tb, w.emailCode(b.email), {}, '000000'), /not right/);
    await assert.rejects(verifyCode(pool, tb, '000000', {}, w.smsCode('+447700900123')), /not right/);
    const done = await signAs(pool, tb, () => w.emailCode(b.email), 'Bayo Both', {}, () => w.smsCode('+447700900123'));
    assert.equal(done.completed, true);
    const ev = (await envelopeDetail(pool, w.staff.p, env.id)).events.filter((e: { kind: string }) => e.kind === 'verified').map((e: { detail: { method: string } }) => e.detail.method);
    assert.deepEqual(ev.sort(), ['email code and text-message code', 'text-message code']);

    // No provider set up: text-message codes are refused when sending, not faked.
    setSmsSenderForTests(null);
    const saved = process.env.SMS_PROVIDER; delete process.env.SMS_PROVIDER;
    await assert.rejects(createEnvelope(pool, w.staff.p, { documentRef: w.up.reference, title: 'x', recipients: [a] }), /text messages are not set up/);
    if (saved !== undefined) process.env.SMS_PROVIDER = saved;
  } finally { setSignMailerForTests(null); setSmsSenderForTests(null); setObjectStoreForTests(undefined); await pool.end(); }
});

test('a company signs through any 2 of 3 authorised people: each confirms authority, the third is told they are not needed', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  try {
    const w = await setup(pool, engine);
    const client = { name: 'Kemi Client', email: `kemi-${stamp()}@signx.test`, order: 1 };
    const dirs = [['Ade Director', 'Director'], ['Bisi Secretary', 'Company Secretary'], ['Chidi Director', 'Director']].map(([name, title]) => ({ name, title, email: `${name!.split(' ')[0]!.toLowerCase()}-${stamp()}@acme.test`, party: 'Acme Ltd', order: 2 }));
    await assert.rejects(createEnvelope(pool, w.staff.p, { documentRef: w.up.reference, title: 'x', recipients: [client, ...dirs] }), /say how many signatures Acme Ltd needs/);
    await assert.rejects(createEnvelope(pool, w.staff.p, { documentRef: w.up.reference, title: 'x', recipients: [client, ...dirs], parties: [{ name: 'Acme Ltd', required: 4 }] }), /between 1 and 3/);
    const env = await createEnvelope(pool, w.staff.p, { documentRef: w.up.reference, title: 'Supply contract', recipients: [client, ...dirs],
      parties: [{ name: 'Acme Ltd', required: 2, order: 2, authorityNote: 'Board resolution 2026/14' }] });
    const acme = env.parties[0]!.id;
    await setFields(pool, w.staff.p, env.id, { fields: [
      { recipientId: env.recipients[0], kind: 'signature', page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.06 },
      { partyId: acme, slot: 1, kind: 'signature', page: 1, x: 0.1, y: 0.6, width: 0.3, height: 0.06 },
      { partyId: acme, slot: 1, kind: 'title', page: 1, x: 0.1, y: 0.67, width: 0.3, height: 0.03 },
      { partyId: acme, slot: 2, kind: 'signature', page: 1, x: 0.55, y: 0.6, width: 0.3, height: 0.06 },
      { partyId: acme, slot: 2, kind: 'title', page: 1, x: 0.55, y: 0.67, width: 0.3, height: 0.03 },
    ] });
    await assert.rejects(setFields(pool, w.staff.p, env.id, { fields: [{ partyId: acme, slot: 3, kind: 'signature', page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.05 }] }), /signatory 1 to the number required/);
    await sendEnvelope(pool, w.staff.p, env.id);
    // In order: the client first, then all three directors together.
    assert.ok(w.link(client.email));
    assert.equal(w.link(dirs[0]!.email), null);
    await signAs(pool, w.link(client.email)!, () => w.emailCode(client.email), 'Kemi Client');
    for (const d of dirs) assert.match(w.mails.find((m) => m.to === d.email && m.kind === 'signature_request')!.text, /on behalf of Acme Ltd as /);

    const [ta, tb, tc] = dirs.map((d) => w.link(d.email)!);
    const view = await signerView(pool, ta!);
    assert.deepEqual(view.party, { name: 'Acme Ltd', required: 2, signed: 0 });
    // Authority must be confirmed.
    await requestCode(pool, ta!);
    const { session } = await verifyCode(pool, ta!, w.emailCode(dirs[0]!.email));
    await giveConsent(pool, ta!, session);
    const signedView = await signerView(pool, ta!, session) as { authorityText: string; fields: { kind: string }[] };
    assert.match(signedView.authorityText, /authorised to sign this document on behalf of Acme Ltd/);
    assert.equal(signedView.fields.length, 2, "signatory 1's signature and title");
    await assert.rejects(signDocument(pool, ta!, session, { signature: typed('Ade Director') }), /confirm you are authorised/);
    await signDocument(pool, ta!, session, { signature: typed('Ade Director'), authority: true });
    const second = await signAs(pool, tb!, () => w.emailCode(dirs[1]!.email), 'Bisi Secretary', { authority: true });
    assert.equal(second.completed, true, 'two of three is enough, and the client has signed');

    // The third director is told, and their link says so.
    assert.ok(w.mails.some((m) => m.to === dirs[2]!.email && m.kind === 'signature_not_needed'));
    const third = await signerView(pool, tc!);
    assert.equal(third.stage, 'closed');
    assert.match((third as { status: string }).status, /no longer needed/);
    assert.ok(!w.mails.some((m) => m.to === dirs[2]!.email && m.kind === 'signature_completed'), 'not sent the signed copy');

    const d = await envelopeDetail(pool, w.staff.p, env.id);
    assert.equal(d.envelope.status, 'completed');
    assert.deepEqual(d.parties.map((p: { name: string; signed: number; required_count: number }) => [p.name, p.signed, p.required_count]), [['Acme Ltd', 2, 2]]);
    const { rows: slots } = await pool.query<{ slot: number; kind: string; value: string; name: string }>(
      `select f.slot, f.kind, f.value, r.name from sign_field f join sign_recipient r on r.id = f.filled_by where f.party_id = $1 order by f.slot, f.kind`, [acme]);
    assert.deepEqual(slots.map((x) => `${x.slot}:${x.kind}:${x.name}:${x.kind === 'title' ? x.value : ''}`),
      ['1:signature:Ade Director:', '1:title:Ade Director:Director', '2:signature:Bisi Secretary:', '2:title:Bisi Secretary:Company Secretary']);
    const { rows: auth } = await pool.query<{ name: string; authority_statement: string | null }>(`select name, authority_statement from sign_recipient where party_id = $1 and status = 'signed' order by party_slot`, [acme]);
    assert.ok(auth.every((x) => /on behalf of Acme Ltd/.test(x.authority_statement ?? '')));
    const check = await verifyFingerprint(pool, { base64: (await finalDocument(pool, ta!)).toString('base64') });
    assert.deepEqual((check as { signers: { name: string; party: string | null; title: string | null }[] }).signers.map((s) => [s.name, s.party, s.title]),
      [['Kemi Client', null, null], ['Ade Director', 'Acme Ltd', 'Director'], ['Bisi Secretary', 'Acme Ltd', 'Company Secretary']]);
  } finally { setSignMailerForTests(null); setSmsSenderForTests(null); setObjectStoreForTests(undefined); await pool.end(); }
});
