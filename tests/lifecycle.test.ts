import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { setPassword } from '../src/runtime/auth.js';
import { memoryObjectStore, setObjectStoreForTests } from '../src/runtime/object-store.js';
import { clearDocusignCacheForTests } from '../src/runtime/docusign.js';
import {
  contractDetail, createContract, createEngagement, createHold, docusignConnect, govFileLink, grantAuditor, releaseHold, clearHold, reviewContract, reviseContract,
  sendForSignature, setGovTeamMember, submitContract, syncEnvelopes, updateGovSettings, uploadGovFile,
} from '../src/runtime/gov.js';
import { approveClosure, buildExport, cancelClosure, exportLink, requestClosure, requestExport, runClosures, suspendWorkspace, workspaceTables } from '../src/runtime/tenant-lifecycle.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300, 65)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 1)]);

async function workspace(pool: Pool, engine: Engine) {
  const name = `life-${stamp()}`;
  const tenantId = await engine.createTenant(name, { scenario: true });
  const mk = async (who: string, role: 'owner' | 'admin' | 'operator' | 'read_only' | 'auditor') => {
    const id = await engine.createActor(tenantId, `${who.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@life.test`, who, role);
    return { id, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner');
  const admin = await mk('Ada Admin', 'admin');
  const legal = await mk('Lola Legal', 'operator');
  const staff = await mk('Sam Staff', 'read_only');
  const auditor = await mk('Audrey Auditor', 'auditor');
  await setModule(pool, owner.p, 'contracts', { enabled: true });
  await setGovTeamMember(pool, admin.p, { team: 'legal', actorId: legal.id });
  await updateGovSettings(pool, admin.p, { alwaysReview: ['legal'] });
  return { name, tenantId, owner, admin, legal, staff, auditor };
}

test('documents: uploaded to the bucket, typed by their bytes, shown only after the scan and only to those who may see the contract', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  try {
    const w = await workspace(pool, engine);
    await assert.rejects(uploadGovFile(pool, w.staff.p, { purpose: 'contract', filename: 'x.pdf', base64: Buffer.from('<html>').toString('base64') }), /PDF or Word/);
    await assert.rejects(uploadGovFile(pool, w.staff.p, { purpose: 'contract', filename: 'x.zip', base64: DOCX.toString('base64') }), /PDF or Word/);
    await assert.rejects(uploadGovFile(pool, w.staff.p, { purpose: 'policy', filename: 'p.pdf', base64: PDF.toString('base64') }), /only compliance/);
    assert.ok((await uploadGovFile(pool, w.staff.p, { purpose: 'contract', filename: 'draft.docx', base64: DOCX.toString('base64') })).reference);
    const up = await uploadGovFile(pool, w.staff.p, { purpose: 'contract', filename: 'cleaning.pdf', base64: PDF.toString('base64') });
    assert.equal(up.sha256, createHash('sha256').update(PDF).digest('hex'));
    const c = await createContract(pool, w.staff.p, { title: 'Cleaning', counterparty: 'SparkleCo', documentRef: up.reference });
    await assert.rejects(createContract(pool, w.staff.p, { title: 'Other', counterparty: 'X', documentRef: up.reference }), /belongs to another contract/);
    const key = [...mem.objects.keys()].find((k) => k.endsWith(up.id))!;
    mem.scans.set(key, 'scanning');
    await assert.rejects(govFileLink(pool, w.staff.p, up.id), /still being checked/);
    mem.scans.set(key, 'clean');
    assert.match((await govFileLink(pool, w.staff.p, up.id)).url, /signed=1/);
    assert.match((await govFileLink(pool, w.legal.p, up.id)).url, /signed=1/);
    const outsider = await engine.createActor(w.tenantId, `out-${stamp()}@life.test`, 'Olu', 'operator');
    await assert.rejects(govFileLink(pool, { kind: 'actor', tenantId: w.tenantId, actorId: outsider }, up.id), /no such contract/);
    // An auditor reaches it only through an engagement that covers the contract, and it is logged.
    await assert.rejects(govFileLink(pool, w.auditor.p, up.id), /no such document/);
    await setGovTeamMember(pool, w.admin.p, { team: 'compliance', actorId: w.legal.id });
    const eng = await createEngagement(pool, w.legal.p, { title: 'Contracts', scope: { contractIds: [c.id] }, periodFrom: '2026-01-01', periodTo: '2026-12-31' });
    await grantAuditor(pool, w.legal.p, eng.id, { actorId: w.auditor.id, expiresAt: new Date(Date.now() + 86400000).toISOString() });
    assert.match((await govFileLink(pool, w.auditor.p, up.id)).url, /signed=1/);
    const log = await pool.query(`select action, target_kind from auditor_access_log where actor_id = $1 order by id`, [w.auditor.id]);
    assert.deepEqual(log.rows.map((r) => `${r.action}:${r.target_kind}`), ['denied:document', 'view:document']);
    mem.scans.set(key, 'quarantined');
    await assert.rejects(govFileLink(pool, w.staff.p, up.id), /did not pass/);
    assert.equal((await contractDetail(pool, w.staff.p, c.id)).files.length, 1);
  } finally { setObjectStoreForTests(undefined); await pool.end(); }
});

test('DocuSign: signs in as the workspace user, sends the approved version, follows it to completion, stores the signed PDF, and voids envelopes for changed versions', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const saved = { ...process.env };
  Object.assign(process.env, { DOCUSIGN_INTEGRATION_KEY: 'patform-ik', DOCUSIGN_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), DOCUSIGN_AUTH_SERVER: 'account-d.docusign.com', DOCUSIGN_CONNECT_HMAC_KEY: 'connect-key' });
  clearDocusignCacheForTests();
  try {
    const w = await workspace(pool, engine);
    const userId = '11111111-2222-3333-4444-555555555555';
    let status = 'sent'; let sentBody: { documents: { documentBase64: string }[]; recipients: { signers: { email: string }[] } } | null = null; const calls: string[] = [];
    const signed = Buffer.concat([Buffer.from('%PDF-1.7 signed\n'), Buffer.alloc(100, 66)]);
    const fake = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'; calls.push(`${method} ${url}`);
      if (url === 'https://account-d.docusign.com/oauth/token') {
        const [h, p, sig] = new URLSearchParams(String(init.body)).get('assertion')!.split('.');
        assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, 'base64url')));
        const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
        assert.equal(claims.iss, 'patform-ik'); assert.equal(claims.sub, userId); assert.equal(claims.aud, 'account-d.docusign.com'); assert.equal(claims.scope, 'signature impersonation');
        return new Response(JSON.stringify({ access_token: 'ds-token', expires_in: 3600 }), { status: 200 });
      }
      if (url.endsWith('/oauth/userinfo')) return new Response(JSON.stringify({ accounts: [{ account_id: 'acc-1', base_uri: 'https://demo.docusign.net', is_default: true }] }), { status: 200 });
      const base = 'https://demo.docusign.net/restapi/v2.1/accounts/acc-1';
      if (method === 'POST' && url === `${base}/envelopes`) { sentBody = JSON.parse(String(init.body)); return new Response(JSON.stringify({ envelopeId: 'aaaaaaaa-0000-0000-0000-000000000001' }), { status: 201 }); }
      if (method === 'GET' && url.endsWith('/documents/combined')) return new Response(signed, { status: 200 });
      if (method === 'GET' && url.startsWith(`${base}/envelopes/`)) return new Response(JSON.stringify({ status }), { status: 200 });
      if (method === 'PUT' && url.startsWith(`${base}/envelopes/`)) return new Response(JSON.stringify({}), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const up = await uploadGovFile(pool, w.staff.p, { purpose: 'contract', filename: 'lease.pdf', base64: PDF.toString('base64') });
    const c = await createContract(pool, w.staff.p, { title: 'Office lease', counterparty: 'Landlord Ltd', documentRef: up.reference });
    await submitContract(pool, w.staff.p, c.id);
    await reviewContract(pool, w.legal.p, c.id, { discipline: 'legal', decision: 'approve' });
    const signers = [{ name: 'Lan Lord', email: 'lan@landlord.test' }, { name: 'Owner', email: 'owner@life.test' }];
    await assert.rejects(sendForSignature(pool, w.staff.p, c.id, { via: 'docusign', signers }, fake), /not connected/);
    await updateGovSettings(pool, w.admin.p, { docusign: { userId } });
    await assert.rejects(sendForSignature(pool, w.staff.p, c.id, { via: 'docusign', signers: [{ name: 'x', email: 'bad' }] }, fake), /name and an email/);
    const sent = await sendForSignature(pool, w.staff.p, c.id, { via: 'docusign', signers }, fake) as { id: string; envelopeId: string };
    assert.equal(sent.envelopeId, 'aaaaaaaa-0000-0000-0000-000000000001');
    assert.equal(Buffer.from(sentBody!.documents[0]!.documentBase64, 'base64').toString(), PDF.toString(), 'the uploaded document is what is sent');
    assert.deepEqual(sentBody!.recipients.signers.map((x) => x.email), ['lan@landlord.test', 'owner@life.test']);

    // Still out: nothing changes. Then DocuSign says completed.
    await syncEnvelopes(pool, { tenantId: w.tenantId, envelopeId: sent.id, doFetch: fake });
    assert.equal((await contractDetail(pool, w.staff.p, c.id)).contract.status, 'out_for_signature');
    status = 'completed';
    // A forged Connect call is refused; a signed one only prompts a real check.
    const body = JSON.stringify({ event: 'envelope-completed', data: { envelopeId: sent.envelopeId } });
    assert.equal((await docusignConnect(pool, body, 'forged', fake)).status, 401);
    assert.equal((await docusignConnect(pool, body, createHmac('sha256', 'connect-key').update(body).digest('base64'), fake)).status, 200);
    const d = await contractDetail(pool, w.staff.p, c.id);
    assert.equal(d.contract.status, 'signed');
    const signedFile = d.files.find((f: { purpose: string }) => f.purpose === 'signed')!;
    assert.equal(signedFile.sha256, createHash('sha256').update(signed).digest('hex'));
    assert.match(d.envelopes[0]!.signed_artifact_ref!, /^gov-file:/);

    // A second contract: revised while out for signature, so DocuSign is told to void it.
    const up2 = await uploadGovFile(pool, w.staff.p, { purpose: 'contract', filename: 'cleaning.pdf', base64: PDF.toString('base64') });
    const c2 = await createContract(pool, w.staff.p, { title: 'Cleaning', counterparty: 'SparkleCo', documentRef: up2.reference });
    await submitContract(pool, w.staff.p, c2.id);
    await reviewContract(pool, w.legal.p, c2.id, { discipline: 'legal', decision: 'approve' });
    status = 'sent';
    await sendForSignature(pool, w.staff.p, c2.id, { via: 'docusign', signers }, fake);
    await reviseContract(pool, w.legal.p, c2.id, { changes: 'New price', value: 100, currency: 'NGN' });
    await syncEnvelopes(pool, { tenantId: w.tenantId, doFetch: fake });
    assert.ok(calls.some((x) => x.startsWith('PUT https://demo.docusign.net/restapi/v2.1/accounts/acc-1/envelopes/')), 'void sent to DocuSign');
    const after = (await pool.query(`select status, remote_void_pending from contract_envelope where contract_id = $1`, [c2.id])).rows[0];
    assert.deepEqual(after, { status: 'voided', remote_void_pending: false });
  } finally { process.env = saved; clearDocusignCacheForTests(); setObjectStoreForTests(undefined); await pool.end(); }
});

/** Reads a .tar.gz into { path: bytes }. */
function untar(gz: Buffer) {
  const tar = gunzipSync(gz); const out = new Map<string, Buffer>();
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, ''); const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
    out.set(prefix ? `${prefix}/${name}` : name, tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

test('export: every workspace table, definitions and attachments with a manifest; no secrets; owners only', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  try {
    const w = await workspace(pool, engine);
    await setPassword(pool, w.staff.id, 'a-long-password-for-export-1');
    const up = await uploadGovFile(pool, w.staff.p, { purpose: 'contract', filename: 'deal.pdf', base64: PDF.toString('base64') });
    await createContract(pool, w.staff.p, { title: 'Deal', counterparty: 'Partner Ltd', documentRef: up.reference });
    await assert.rejects(requestExport(pool, w.admin.p), /only a workspace owner/);
    const x = await requestExport(pool, w.owner.p);
    await assert.rejects(requestExport(pool, w.owner.p), /already being prepared/);
    await assert.rejects(exportLink(pool, w.owner.p, x.id), /not ready/);
    const built = (await buildExport(pool, x.id))!;
    const archive = [...mem.objects.entries()].find(([k]) => k === `exports/${w.tenantId}/${x.id}.tar.gz`)![1].bytes;
    assert.equal(createHash('sha256').update(archive).digest('hex'), built.sha256);
    const files = untar(archive);
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    assert.equal(manifest.format, 'patform-workspace-export');
    assert.ok(!files.has('data/credential.json'), 'credentials are never exported');
    assert.ok(!files.has('data/session.json'));
    const contract = JSON.parse(files.get('data/contract.json')!.toString());
    assert.equal(contract[0].title, 'Deal');
    for (const [path, bytes] of files) if (path.startsWith('data/')) assert.doesNotMatch(bytes.toString(), /"[a-z_]*(password|secret|_hash|sealed)[a-z_]*":/, `${path} has a secret column`);
    for (const t of manifest.tables) assert.equal(t.sha256, createHash('sha256').update(files.get(t.file)!).digest('hex'));
    const att = manifest.attachments.find((a: { source: string }) => a.source === `gov_file:${up.id}`);
    assert.equal(att.sha256, createHash('sha256').update(PDF).digest('hex'));
    assert.ok(files.get(att.file)!.equals(PDF));
    const actors = JSON.parse(files.get('data/actor.json')!.toString());
    assert.ok(actors.length >= 5 && actors.every((a: { tenant_id: string }) => a.tenant_id === w.tenantId), 'only this workspace');
    assert.match((await exportLink(pool, w.owner.p, x.id)).url, /signed=1/);
  } finally { setObjectStoreForTests(undefined); await pool.end(); }
});

test('closure: ask, export, suspend, cancel restores; then a site owner approves after the wait, holds block, and deletion removes every row and file of this workspace only', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  try {
    const w = await workspace(pool, engine);
    const other = await workspace(pool, engine);
    const otherContract = await createContract(pool, other.staff.p, { title: 'Keep me', counterparty: 'Other Ltd' });
    const up = await uploadGovFile(pool, w.staff.p, { purpose: 'contract', filename: 'gone.pdf', base64: PDF.toString('base64') });
    await createContract(pool, w.staff.p, { title: 'Goes away', counterparty: 'Partner', documentRef: up.reference });
    await pool.query(`insert into api_key (tenant_id, actor_id, name, key_hash, key_prefix, scopes) values ($1, $2, 'ci', $3, 'p', '{}')`, [w.tenantId, w.admin.id, `h-${stamp()}`]);
    await pool.query(`insert into webhook_endpoint (tenant_id, url, secret) values ($1, 'https://hooks.test/x', 's')`, [w.tenantId]);

    await assert.rejects(requestClosure(pool, w.admin.p, { reason: 'x', confirmName: w.name }), /only a workspace owner/);
    await assert.rejects(requestClosure(pool, w.owner.p, { reason: 'Moving on', confirmName: 'wrong' }), /type the workspace name/);
    const cl = await requestClosure(pool, w.owner.p, { reason: 'Moving to another system', confirmName: w.name });
    await assert.rejects(suspendWorkspace(pool, w.owner.p, {}), /export is not ready/);
    await buildExport(pool, cl.exportId);
    const s = await suspendWorkspace(pool, w.owner.p, {});
    assert.equal(s.membersSuspended, 4);
    assert.equal((await pool.query(`select count(*)::int as n from actor where tenant_id = $1 and active`, [w.tenantId])).rows[0].n, 1, 'only the owner remains');
    assert.ok((await pool.query(`select revoked_at from api_key where tenant_id = $1`, [w.tenantId])).rows[0].revoked_at);
    assert.equal((await pool.query(`select active from webhook_endpoint where tenant_id = $1`, [w.tenantId])).rows[0].active, false);
    const back = await cancelClosure(pool, w.owner.p);
    assert.equal(back.restored, 4);
    assert.equal((await pool.query(`select count(*)::int as n from actor where tenant_id = $1 and active`, [w.tenantId])).rows[0].n, 5);
    assert.equal((await pool.query(`select active from webhook_endpoint where tenant_id = $1`, [w.tenantId])).rows[0].active, true);

    // Again, for real this time. A second owner stays active through suspension, like the first.
    const owner2 = await engine.createActor(w.tenantId, `owner2-${stamp()}@life.test`, 'Second Owner', 'owner');
    const owner2p = { kind: 'actor', tenantId: w.tenantId, actorId: owner2 } as Principal;
    const cl2 = await requestClosure(pool, w.owner.p, { reason: 'Moving to another system', confirmName: w.name });
    await suspendWorkspace(pool, w.owner.p, { waiveExport: true });
    const siteOwner = await engine.createActor(other.tenantId, `site-${stamp()}@life.test`, 'Site Owner', 'owner');
    await pool.query('update actor set email_verified_at = now() where id = $1', [siteOwner]);
    await assert.rejects(approveClosure(pool, siteOwner, cl2.id), /platform access/);
    await pool.query(`insert into platform_operator (actor_id, role) values ($1, 'owner')`, [siteOwner]);
    await pool.query(`insert into mfa_enrolment (actor_id, secret, confirmed_at) values ($1, 'x', now())`, [siteOwner]);
    await assert.rejects(approveClosure(pool, siteOwner, cl2.id), /waiting period ends/);
    await pool.query(`update tenant_closure set waiting_until = now() - interval '1 minute' where id = $1`, [cl2.id]);
    const hold = await createHold(pool, w.owner.p, { title: 'Dispute', reason: 'Claim pending', scope: { processKeys: ['anything'] } });
    await assert.rejects(approveClosure(pool, siteOwner, cl2.id), /legal hold/);
    await releaseHold(pool, w.owner.p, hold.id, { reason: 'Settled' });
    await assert.rejects(approveClosure(pool, siteOwner, cl2.id), /legal hold/, 'a released hold still blocks until reviewed');
    await clearHold(pool, owner2p, hold.id, { note: 'Reviewed' });
    await approveClosure(pool, siteOwner, cl2.id);

    await runClosures(pool);
    const scope = await workspaceTables(pool);
    for (const t of scope) {
      const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from "${t.table}" where ${t.where}`, [w.tenantId]);
      assert.equal(rows[0]!.n, 0, `${t.table} still has rows`);
    }
    assert.ok(![...mem.objects.keys()].some((k) => k.endsWith(up.id)), 'the document was deleted from the bucket');
    const { rows: c } = await pool.query(`select status, certificate from tenant_closure where id = $1`, [cl2.id]);
    assert.equal(c[0].status, 'closed');
    assert.ok(c[0].certificate.total_rows > 20);
    assert.equal(c[0].certificate.export, 'waived by the owner');
    assert.match(c[0].certificate.backups, /not edited/);
    assert.equal((await pool.query(`select name, closed_at is not null as closed from tenant where id = $1`, [w.tenantId])).rows[0].name, 'Closed workspace');
    // The other workspace is untouched.
    assert.equal((await pool.query(`select count(*)::int as n from contract where id = $1`, [otherContract.id])).rows[0].n, 1);
    assert.equal((await pool.query(`select count(*)::int as n from actor where tenant_id = $1`, [other.tenantId])).rows[0].n, 6);
  } finally { setObjectStoreForTests(undefined); await pool.end(); }
});
