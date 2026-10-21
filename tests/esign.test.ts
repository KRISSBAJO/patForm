import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { memoryObjectStore, setObjectStoreForTests } from '../src/runtime/object-store.js';
import { createContract, reviewContract, reviseContract, setGovTeamMember, submitContract, updateGovSettings, uploadGovFile, contractDetail } from '../src/runtime/gov.js';
import {
  createEnvelope, declineDocument, envelopeDetail, finalDocument, giveConsent, listEnvelopes, remindNow, requestCode, sendEnvelope, setFields, setSignMailerForTests,
  signDocument, signerDocument, signerView, sweepSignatures, verifyCode, verifyFingerprint, voidEnvelope,
} from '../src/runtime/esign.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function twoPagePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]); doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

type Mail = { kind: string; to: string; subject: string; text: string };
async function setup(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`sign-${stamp()}`, { scenario: true });
  const mk = async (who: string, role: 'owner' | 'admin' | 'operator' | 'read_only') => {
    const email = `${who.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@sign.test`;
    const id = await engine.createActor(tenantId, email, who, role);
    return { id, email, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner'); const admin = await mk('Ada Admin', 'admin'); const legal = await mk('Lola Legal', 'operator'); const staff = await mk('Sam Staff', 'read_only');
  await setModule(pool, owner.p, 'contracts', { enabled: true });
  await setGovTeamMember(pool, admin.p, { team: 'legal', actorId: legal.id });
  await updateGovSettings(pool, admin.p, { alwaysReview: ['legal'] });
  const mails: Mail[] = [];
  setSignMailerForTests(async (_p, m) => { mails.push(m); });
  const link = (to: string, kind = 'signature_request') => { const m = [...mails].reverse().find((x) => x.to === to && x.kind === kind); return m ? /\/sign\/([A-Za-z0-9_-]+)/.exec(m.text)![1]! : null; };
  const code = (to: string) => /code[^0-9]*(\d{6})/i.exec([...mails].reverse().find((x) => x.to === to && x.kind === 'signature_code')!.text)![1]!;
  return { tenantId, owner, admin, legal, staff, mails, link, code };
}

async function signIn(pool: Pool, t: string, email: string, code: (to: string) => string, ip = '203.0.113.7') {
  await requestCode(pool, t, { ip, userAgent: 'TestBrowser/1' });
  const { session } = await verifyCode(pool, t, code(email), { ip, userAgent: 'TestBrowser/1' });
  return session;
}

test('Patform Sign: a contract goes to two signers in order, each verified by email code, and comes back sealed with a certificate and a checkable fingerprint', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  try {
    const w = await setup(pool, engine);
    const pdf = await twoPagePdf();
    const up = await uploadGovFile(pool, w.staff.p, { purpose: 'contract', filename: 'supply.pdf', base64: pdf.toString('base64') });
    const c = await createContract(pool, w.staff.p, { title: 'Supply agreement', counterparty: 'Acme Ltd', documentRef: up.reference });
    const supplier = { name: 'Ade Supplier', email: `ade-${stamp()}@acme.test` };
    await assert.rejects(createEnvelope(pool, w.staff.p, { contractId: c.id, recipients: [supplier] }), /approved in its current version/);
    await submitContract(pool, w.staff.p, c.id);
    await reviewContract(pool, w.legal.p, c.id, { discipline: 'legal', decision: 'approve' });
    await assert.rejects(createEnvelope(pool, w.staff.p, { contractId: c.id, recipients: [{ name: 'x', email: 'nope' }] }), /name and an email/);
    const env = await createEnvelope(pool, w.staff.p, { contractId: c.id, routing: 'sequential', message: 'Please sign by Friday',
      recipients: [{ ...supplier, order: 1 }, { name: 'Owner', email: w.owner.email, order: 2 }, { name: 'Fin Copy', email: `fin-${stamp()}@sign.test`, role: 'cc' }] });
    assert.equal(env.pages, 2);
    const [rSupplier, rOwner] = env.recipients;
    await assert.rejects(setFields(pool, w.staff.p, env.id, { fields: [{ recipientId: rSupplier, kind: 'signature', page: 3, x: 0.1, y: 0.1, width: 0.2, height: 0.05 }] }), /2 page/);
    await assert.rejects(setFields(pool, w.staff.p, env.id, { fields: [{ recipientId: rSupplier, kind: 'signature', page: 1, x: 0.9, y: 0.1, width: 0.3, height: 0.05 }] }), /off the page/);
    await setFields(pool, w.staff.p, env.id, { fields: [
      { recipientId: rSupplier, kind: 'signature', page: 2, x: 0.1, y: 0.7, width: 0.3, height: 0.06 },
      { recipientId: rSupplier, kind: 'date', page: 2, x: 0.45, y: 0.72, width: 0.15, height: 0.03 },
      { recipientId: rSupplier, kind: 'text', page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.03, label: 'Company number' },
      { recipientId: rOwner, kind: 'signature', page: 2, x: 0.6, y: 0.7, width: 0.3, height: 0.06 },
    ] });
    await sendEnvelope(pool, w.staff.p, env.id);
    assert.equal((await contractDetail(pool, w.staff.p, c.id)).contract.status, 'out_for_signature');
    // In order: only the supplier has been asked so far.
    const t1 = w.link(supplier.email)!;
    assert.ok(t1);
    assert.equal(w.link(w.owner.email), null);

    // Nothing about the document before the code.
    const before = await signerView(pool, t1);
    assert.equal(before.stage, 'verify');
    assert.ok(!('fields' in before));
    await assert.rejects(signerDocument(pool, t1, undefined), /confirm it is you/);
    await requestCode(pool, t1);
    await assert.rejects(verifyCode(pool, t1, '000000'), /not right|expired/);
    const s1 = await signIn(pool, t1, supplier.email, w.code);
    const view = await signerView(pool, t1, s1);
    assert.equal(view.stage, 'sign');
    assert.equal((view as { fields: unknown[] }).fields.length, 3);
    assert.ok((await signerDocument(pool, t1, s1)).equals(pdf));
    const sig = { method: 'drawn', name: 'Ade Supplier', image: PNG };
    await assert.rejects(signDocument(pool, t1, s1, { signature: sig }), /agree to sign electronically/);
    await giveConsent(pool, t1, s1, { ip: '203.0.113.7' });
    const textField = (view as { fields: { id: string; kind: string }[] }).fields.find((f) => f.kind === 'text')!;
    await assert.rejects(signDocument(pool, t1, s1, { signature: sig }), /Company number/);
    await assert.rejects(signDocument(pool, t1, s1, { signature: { method: 'drawn', name: 'A' }, values: { [textField.id]: 'RC 12345' } }), /full name|Draw/);
    const first = await signDocument(pool, t1, s1, { signature: sig, values: { [textField.id]: 'RC 12345' } }, { ip: '203.0.113.7', userAgent: 'TestBrowser/1' });
    assert.deepEqual(first, { signed: true, completed: false });
    // Codes travel in the body only; subjects are logged.
    assert.ok(w.mails.filter((m) => m.kind === 'signature_code').every((m) => !/\d{6}/.test(m.subject)));
    await assert.rejects(signDocument(pool, t1, s1, { signature: sig }), /confirm it is you|already responded/);

    // Now the owner is asked; typed signature.
    const t2 = w.link(w.owner.email)!;
    const s2 = await signIn(pool, t2, w.owner.email, w.code, '198.51.100.9');
    await giveConsent(pool, t2, s2);
    const done = await signDocument(pool, t2, s2, { signature: { method: 'typed', name: 'Hana Owner', style: 'flowing' } }, { ip: '198.51.100.9', userAgent: 'TestBrowser/2' });
    assert.deepEqual(done, { signed: true, completed: true });

    const d = await envelopeDetail(pool, w.staff.p, env.id);
    assert.equal(d.envelope.status, 'completed');
    assert.match(d.envelope.final_sha256!, /^[0-9a-f]{64}$/);
    assert.deepEqual(d.events.map((e: { kind: string }) => e.kind).filter((k: string) => ['created', 'sent', 'verified', 'consented', 'signed', 'completed'].includes(k)),
      ['created', 'sent', 'verified', 'consented', 'signed', 'sent', 'verified', 'consented', 'signed', 'completed']);
    // The contract is signed, with the sealed copy attached.
    const cd = await contractDetail(pool, w.staff.p, c.id);
    assert.equal(cd.contract.status, 'signed');
    assert.ok(cd.files.some((f: { purpose: string; sha256: string }) => f.purpose === 'signed' && f.sha256 === d.envelope.final_sha256));

    // Everyone, the copy included, gets the signed copy; it is a valid PDF with the extra certificate page.
    // A signer's own link still works, now for the signed copy.
    assert.equal(w.link(supplier.email, 'signature_completed'), t1);
    assert.ok((await finalDocument(pool, t1)).length > 0);
    const finalLink = w.link(d.recipients.find((r: { role: string }) => r.role === 'cc').email, 'signature_completed')!;
    const sealed = await finalDocument(pool, finalLink);
    assert.equal(sha(sealed), d.envelope.final_sha256);
    const parsed = await PDFDocument.load(sealed, { updateMetadata: false });
    assert.equal(parsed.getPageCount(), 3, 'two original pages plus the certificate');
    assert.equal(parsed.getProducer(), 'Patform Sign');
    assert.match(parsed.getKeywords() ?? '', new RegExp(`original-sha256:${sha(pdf)}`));

    // Anyone can check a copy; a changed copy does not match.
    const ok = await verifyFingerprint(pool, { base64: sealed.toString('base64') });
    assert.equal(ok.valid, true);
    assert.deepEqual((ok as { signers: { name: string }[] }).signers.map((s) => s.name), ['Ade Supplier', 'Owner']);
    const tampered = Buffer.concat([sealed, Buffer.from('\n%tampered')]);
    assert.equal((await verifyFingerprint(pool, { base64: tampered.toString('base64') })).valid, false);
    await assert.rejects(pool.query('delete from sign_event where envelope_id = $1', [env.id]), /append-only/);
    assert.equal((await listEnvelopes(pool, w.staff.p))[0].signed, 2);
  } finally { setSignMailerForTests(null); setObjectStoreForTests(undefined); await pool.end(); }
});

test('Patform Sign: codes are limited, links are personal, declining closes the envelope, revising the contract voids it, and envelopes expire', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  try {
    const w = await setup(pool, engine);
    const pdf = await twoPagePdf();
    // A standalone PDF, sent to two people at once.
    await assert.rejects(uploadGovFile(pool, w.staff.p, { purpose: 'signing', filename: 'nda.docx', base64: pdf.toString('base64') }), /upload a PDF/);
    const up = await uploadGovFile(pool, w.staff.p, { purpose: 'signing', filename: 'nda.pdf', base64: pdf.toString('base64') });
    const a = { name: 'Amaka A', email: `amaka-${stamp()}@sign.test` }; const b = { name: 'Bayo B', email: `bayo-${stamp()}@sign.test` };
    const env = await createEnvelope(pool, w.staff.p, { documentRef: up.reference, title: 'NDA', routing: 'parallel', recipients: [a, b] });
    await sendEnvelope(pool, w.staff.p, env.id);
    const ta = w.link(a.email)!; const tb = w.link(b.email)!;
    assert.ok(ta && tb && ta !== tb, 'each signer has their own link');
    await assert.rejects(signerView(pool, 'x'.repeat(43)), /not valid/);

    // Wrong codes lock; too many sends are refused.
    await requestCode(pool, ta);
    for (let i = 0; i < 5; i++) await assert.rejects(verifyCode(pool, ta, '999999'), /not right/);
    await assert.rejects(verifyCode(pool, ta, w.code(a.email)), /too many wrong codes/);
    for (let i = 0; i < 4; i++) await requestCode(pool, ta);
    await assert.rejects(requestCode(pool, ta), /too many codes/);
    // A session from one signer does not open another's link.
    const sb = await signIn(pool, tb, b.email, w.code);
    await assert.rejects(signerDocument(pool, ta, sb), /confirm it is you/);

    // Reminders resend the same personal link.
    const before = w.mails.length;
    await remindNow(pool, w.staff.p, env.id);
    const reminders = w.mails.slice(before).filter((m) => m.kind === 'signature_reminder');
    assert.equal(reminders.length, 2);
    assert.ok(reminders.some((m) => m.text.includes(`/sign/${ta}`)));

    // Declining closes it for everyone and tells the sender.
    await giveConsent(pool, tb, sb);
    await assert.rejects(declineDocument(pool, tb, sb, {}), /say why/);
    await declineDocument(pool, tb, sb, { reason: 'Wrong company name' });
    assert.equal((await envelopeDetail(pool, w.staff.p, env.id)).envelope.status, 'declined');
    assert.ok(w.mails.some((m) => m.kind === 'signature_declined' && m.to === w.staff.email && /Wrong company name/.test(m.text)));
    assert.equal((await signerView(pool, ta)).stage, 'closed');

    // A contract revised while out for signature voids the Patform envelope.
    const up2 = await uploadGovFile(pool, w.staff.p, { purpose: 'contract', filename: 'lease.pdf', base64: pdf.toString('base64') });
    const c = await createContract(pool, w.staff.p, { title: 'Lease', counterparty: 'Landlord', documentRef: up2.reference });
    await submitContract(pool, w.staff.p, c.id);
    await reviewContract(pool, w.legal.p, c.id, { discipline: 'legal', decision: 'approve' });
    const e2 = await createEnvelope(pool, w.staff.p, { contractId: c.id, recipients: [a] });
    await sendEnvelope(pool, w.staff.p, e2.id);
    await reviseContract(pool, w.legal.p, c.id, { changes: 'Rent changed', value: 5, currency: 'NGN' });
    assert.equal((await envelopeDetail(pool, w.staff.p, e2.id)).envelope.status, 'voided');

    // Expiry, and voiding by the sender.
    const e3 = await createEnvelope(pool, w.staff.p, { documentRef: (await uploadGovFile(pool, w.staff.p, { purpose: 'signing', filename: 'x.pdf', base64: pdf.toString('base64') })).reference, title: 'Old', recipients: [a] });
    await sendEnvelope(pool, w.staff.p, e3.id);
    await pool.query(`update sign_envelope set expires_at = now() - interval '1 minute' where id = $1`, [e3.id]);
    await sweepSignatures(pool);
    assert.equal((await envelopeDetail(pool, w.staff.p, e3.id)).envelope.status, 'expired');
    const e4 = await createEnvelope(pool, w.staff.p, { documentRef: (await uploadGovFile(pool, w.staff.p, { purpose: 'signing', filename: 'y.pdf', base64: pdf.toString('base64') })).reference, title: 'Cancel me', recipients: [a] });
    await assert.rejects(voidEnvelope(pool, w.staff.p, e4.id, {}), /say why/);
    await voidEnvelope(pool, w.staff.p, e4.id, { reason: 'Sent by mistake' });
    // Someone with no part in an envelope cannot see it.
    const outsider = await engine.createActor(w.tenantId, `out-${stamp()}@sign.test`, 'Olu', 'operator');
    await assert.rejects(envelopeDetail(pool, { kind: 'actor', tenantId: w.tenantId, actorId: outsider }, e4.id), /no such envelope/);
    // A document changed in storage is refused rather than signed.
    const up5 = await uploadGovFile(pool, w.staff.p, { purpose: 'signing', filename: 'z.pdf', base64: pdf.toString('base64') });
    const key = [...mem.objects.keys()].find((k) => k.endsWith(up5.id))!;
    mem.objects.set(key, { bytes: Buffer.concat([pdf, Buffer.from('x')]), type: 'application/pdf' });
    await assert.rejects(createEnvelope(pool, w.staff.p, { documentRef: up5.reference, title: 'Tampered', recipients: [a] }), /does not match/);
  } finally { setSignMailerForTests(null); setObjectStoreForTests(undefined); await pool.end(); }
});

test('Patform Sign retries a final PDF storage failure without losing the last signature', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  try {
    const w = await setup(pool, engine);
    const pdf = await twoPagePdf();
    const up = await uploadGovFile(pool, w.staff.p, { purpose: 'signing', filename: 'retry.pdf', base64: pdf.toString('base64') });
    const signer = { name: 'Ada Signer', email: `ada-${stamp()}@sign.test` };
    const env = await createEnvelope(pool, w.staff.p, { documentRef: up.reference, title: 'Retry final copy', recipients: [signer] });
    await sendEnvelope(pool, w.staff.p, env.id);
    const token = w.link(signer.email)!;
    const session = await signIn(pool, token, signer.email, w.code);
    await giveConsent(pool, token, session);
    let failOnce = true;
    setObjectStoreForTests({ ...mem.store, async put(key, bytes, type, meta) {
      if (key.startsWith('gov/files/') && failOnce) { failOnce = false; throw new Error('temporary storage outage'); }
      await mem.store.put(key, bytes, type, meta);
    } });
    const response = await signDocument(pool, token, session, { signature: { method: 'typed', name: signer.name, style: 'flowing' } });
    assert.deepEqual(response, { signed: true, completed: false, finalizing: true });
    assert.equal((await envelopeDetail(pool, w.staff.p, env.id)).envelope.status, 'finalizing');
    assert.equal((await signerView(pool, token)).stage, 'signed');
    await sweepSignatures(pool);
    const detail = await envelopeDetail(pool, w.staff.p, env.id);
    assert.equal(detail.envelope.status, 'completed');
    assert.equal(detail.events.filter((e: { kind: string }) => e.kind === 'signed').length, 1);
    assert.equal(detail.events.filter((e: { kind: string }) => e.kind === 'completed').length, 1);
    assert.equal((await verifyFingerprint(pool, { base64: (await finalDocument(pool, token)).toString('base64') })).valid, true);
  } finally { setSignMailerForTests(null); setObjectStoreForTests(undefined); await pool.end(); }
});

test('Patform Sign routes a four-signer document in order and gives the copy recipient the completed PDF', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  try {
    const w = await setup(pool, engine);
    const pdf = process.env.SIGN_TEST_PDF ? readFileSync(process.env.SIGN_TEST_PDF) : await twoPagePdf();
    const up = await uploadGovFile(pool, w.staff.p, { purpose: 'signing', filename: 'test-contract-4-signers.pdf', base64: pdf.toString('base64') });
    const people = Array.from({ length: 4 }, (_, i) => ({ name: `Test Signer ${i + 1}`, email: `four-${i + 1}-${stamp()}@sign.test`, order: i + 1 }));
    const copy = { name: 'Record Keeper', email: `record-${stamp()}@sign.test`, role: 'cc' as const };
    const env = await createEnvelope(pool, w.staff.p, { documentRef: up.reference, title: 'Four signer contract', routing: 'sequential', recipients: [...people, copy] });
    await setFields(pool, w.staff.p, env.id, { fields: people.map((_, i) => ({ recipientId: env.recipients[i]!, kind: 'signature' as const, page: 2, x: 0.07 + i * 0.23, y: 0.72, width: 0.19, height: 0.06 })) });
    await sendEnvelope(pool, w.staff.p, env.id);
    for (let i = 0; i < people.length; i++) {
      const person = people[i]!;
      const token = w.link(person.email);
      assert.ok(token, `signer ${i + 1} is invited`);
      if (i < 3) assert.equal(w.link(people[i + 1]!.email), null, 'next signer waits for the previous one');
      const session = await signIn(pool, token, person.email, w.code);
      await giveConsent(pool, token, session);
      const result = await signDocument(pool, token, session, { signature: { method: 'typed', name: person.name, style: 'flowing' } });
      assert.equal(result.completed, i === 3);
    }
    const detail = await envelopeDetail(pool, w.staff.p, env.id);
    assert.equal(detail.envelope.status, 'completed');
    assert.equal(detail.events.filter((event: { kind: string }) => event.kind === 'signed').length, 4);
    const copyToken = w.link(copy.email, 'signature_completed');
    assert.ok(copyToken, 'copy recipient receives the final document');
    assert.equal((await verifyFingerprint(pool, { base64: (await finalDocument(pool, copyToken)).toString('base64') })).valid, true);
  } finally { setSignMailerForTests(null); setObjectStoreForTests(undefined); await pool.end(); }
});
