import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { sign } from '../src/runtime/webhooks.js';
import {
  assetDetail, assignAsset, completeJob, confirmProvisioning, connectorCallback, createPlan, decideAccess, deliverConnectors, listAccess, listMaintenance,
  opsDashboard, queueRevocations, registerAsset, requestAccess, returnAsset, saveJobDraft, saveSystem, setOpsTeamMember, listSystems,
} from '../src/runtime/ops.js';
import { opsPhotoLink, setPhotoStoreForTests, uploadOpsPhoto, type PhotoStore } from '../src/runtime/ops-files.js';
import type { Principal } from '../src/runtime/policy.js';

// Photos in S3, and the general access connector.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]).toString('base64');

/** Stands in for the bucket: keeps objects in memory and lets a test decide the scan result. */
function memoryStore() {
  const objects = new Map<string, { bytes: Buffer; type: string }>();
  const scans = new Map<string, 'clean' | 'quarantined' | 'scanning'>();
  const store: PhotoStore = {
    async put(key, bytes, type) { objects.set(key, { bytes, type }); },
    async scan(key) { return scans.get(key) ?? 'scanning'; },
    async link(key) { return `https://bucket.test/${key}?signed=1`; },
  };
  return { store, objects, scans };
}

async function workspace(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`opsx-${stamp()}`, { scenario: true });
  const mk = async (name: string, role: 'owner' | 'admin' | 'operator' | 'read_only') => {
    const id = await engine.createActor(tenantId, `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@opsx.test`, name, role);
    return { id, name, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner');
  const admin = await mk('Ada Admin', 'admin');
  const it1 = await mk('Ivo IT', 'operator');
  const fac = await mk('Fay Facilities', 'operator');
  const sysOwner = await mk('Sola Owner', 'operator');
  const staff = await mk('Sam Staff', 'read_only');
  const staff2 = await mk('Tia Two', 'read_only');
  await setModule(pool, owner.p, 'assets', { enabled: true });
  await setOpsTeamMember(pool, admin.p, { team: 'it', actorId: it1.id });
  await setOpsTeamMember(pool, admin.p, { team: 'facilities', actorId: fac.id });
  return { tenantId, owner, admin, it1, fac, sysOwner, staff, staff2 };
}

test('photos: uploaded to the bucket, checked by type and team, shown only after the malware scan, and attached to jobs, hand-outs and returns', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  const mem = memoryStore();
  setPhotoStoreForTests(mem.store);
  try {
    const w = await workspace(pool, engine);
    const a = await registerAsset(pool, w.it1.p, { tag: `GEN-${stamp()}`, name: 'Generator', category: 'Equipment', acquisitionRef: 'Invoice 1' });
    await createPlan(pool, w.fac.p, { assetId: a.id, title: 'Generator check', everyDays: 30, checklist: ['Battery'], team: 'facilities', firstDue: addDays(0) });
    const [job] = (await listMaintenance(pool, w.fac.p)).jobs;

    // The bytes decide the type; the IT team cannot add photos to a Facilities job; staff cannot add asset photos.
    await assert.rejects(uploadOpsPhoto(pool, w.fac.p, { jobId: job.id, filename: 'x.jpg', base64: Buffer.from('<script>').toString('base64') }), /JPEG, PNG or WebP/);
    await assert.rejects(uploadOpsPhoto(pool, w.it1.p, { jobId: job.id, filename: 'x.jpg', base64: JPEG }), /job for the FACILITIES team/);
    await assert.rejects(uploadOpsPhoto(pool, w.staff.p, { assetId: a.id, filename: 'x.jpg', base64: JPEG }), /only the IT or Facilities team/);
    const up = await uploadOpsPhoto(pool, w.fac.p, { jobId: job.id, filename: 'battery.jpg', base64: JPEG });
    assert.match(up.reference, /^ops-photo:/);
    assert.equal(mem.objects.size, 1);
    assert.ok([...mem.objects.keys()][0]!.startsWith(`ops/photos/${w.tenantId}/`));

    // Not viewable until the scan passes; never viewable if it fails.
    await assert.rejects(opsPhotoLink(pool, w.fac.p, up.id), /still being checked/);
    mem.scans.set([...mem.objects.keys()][0]!, 'clean');
    assert.match((await opsPhotoLink(pool, w.fac.p, up.id)).url, /signed=1/);
    await assert.rejects(opsPhotoLink(pool, w.staff.p, up.id), /No such photo/);

    // A job accepts only its own uploads; a typed reference is refused.
    await assert.rejects(saveJobDraft(pool, w.fac.p, job.id, { version: 0, photos: ['some-photo.jpg'] }), /uploaded, not typed in/);
    const other = await uploadOpsPhoto(pool, w.it1.p, { assetId: a.id, filename: 'other.jpg', base64: JPEG });
    await assert.rejects(completeJob(pool, w.fac.p, job.id, { results: { Battery: 'pass' }, photos: [other.reference] }), /does not belong here/);
    const bad = await uploadOpsPhoto(pool, w.fac.p, { jobId: job.id, filename: 'bad.jpg', base64: JPEG });
    await opsPhotoLink(pool, w.fac.p, bad.id).catch(() => null);
    await pool.query(`update ops_photo set scan_status = 'quarantined' where id = $1`, [bad.id]);
    await assert.rejects(completeJob(pool, w.fac.p, job.id, { results: { Battery: 'pass' }, photos: [up.reference, bad.reference] }), /failed its malware check/);
    await completeJob(pool, w.fac.p, job.id, { results: { Battery: 'pass' }, photos: [up.reference] });

    // Hand-out and return photos are linked to that assignment.
    const out = await uploadOpsPhoto(pool, w.it1.p, { assetId: a.id, filename: 'out.jpg', base64: JPEG });
    const s1 = await assignAsset(pool, w.it1.p, a.id, { custodianId: w.staff.id, photos: [out.reference] });
    const back = await uploadOpsPhoto(pool, w.it1.p, { assetId: a.id, filename: 'back.jpg', base64: JPEG });
    await returnAsset(pool, w.it1.p, s1.id, { condition: 'good', photos: [back.reference] });
    const d = await assetDetail(pool, w.it1.p, a.id);
    const linked = d.photos.filter((p: { assignment_id: string | null }) => p.assignment_id === s1.id).map((p: { filename: string }) => p.filename).sort();
    assert.deepEqual(linked, ['back.jpg', 'out.jpg']);
    assert.ok(d.photos.some((p: { job_id: string | null; filename: string }) => p.job_id === job.id && p.filename === 'battery.jpg'));
  } finally { setPhotoStoreForTests(undefined as unknown as null); await pool.end(); }
});

test('connector: signed requests on approval and removal; done, failed and accepted answers; signed call back; retries end in a visible failure', { skip: !localDatabase }, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const w = await workspace(pool, engine);
    await assert.rejects(saveSystem(pool, w.admin.p, { name: 'x', ownerId: w.sysOwner.id, roles: ['user'], connectorUrl: 'http://payroll.example.com/hook' }), /must be https/);
    const sys = await saveSystem(pool, w.admin.p, { name: `Payroll ${stamp()}`, ownerId: w.sysOwner.id, roles: ['user'], connectorUrl: 'https://payroll.example.com/patform' });
    assert.match(sys.secret!, /^pcs_/);
    // The secret is shown once and stored sealed.
    const again = await saveSystem(pool, w.admin.p, { id: sys.id, name: 'Payroll renamed', ownerId: w.sysOwner.id, roles: ['user'], connectorUrl: 'https://payroll.example.com/patform' });
    assert.equal(again.secret, null);
    const stored = (await pool.query('select connector_secret from access_system where id = $1', [sys.id])).rows[0].connector_secret;
    assert.ok(!String(stored).includes(sys.secret!));
    assert.ok(!JSON.stringify(await listSystems(pool, w.admin.p)).includes('pcs_'));

    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    let reply: () => Response = () => new Response(JSON.stringify({ status: 'done', reference: 'payroll-user-77' }), { status: 200 });
    const fake = (async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) }); return reply(); }) as unknown as typeof fetch;

    // 1. Approved, then the system confirms in its reply.
    const r1 = await requestAccess(pool, w.staff.p, { systemId: sys.id, role: 'user', justification: 'Payslips' });
    await deliverConnectors(pool, { workerId: 't', fetchImpl: fake });
    assert.equal(calls.length, 0, 'nothing is sent before approval');
    await decideAccess(pool, w.sysOwner.p, r1.id, { decision: 'approve' });
    assert.equal((await listAccess(pool, w.staff.p)).requests[0].status, 'approved');
    await deliverConnectors(pool, { workerId: 't', fetchImpl: fake });
    assert.equal(calls.length, 1);
    const sent = JSON.parse(calls[0]!.body);
    assert.equal(sent.event, 'access.provision');
    assert.equal(sent.role, 'user');
    assert.match(calls[0]!.headers['patform-signature']!, /^t=\d+,v1=[0-9a-f]{64}$/);
    let mine = await listAccess(pool, w.staff.p);
    assert.equal(mine.requests[0].status, 'provisioned');
    assert.equal(mine.requests[0].provisioned_via, 'connector');
    assert.equal(mine.grants[0].status, 'active');
    // Delivered once only.
    await deliverConnectors(pool, { workerId: 't', fetchImpl: fake });
    assert.equal(calls.length, 1);

    // 2. Accepted now, confirmed later by a signed call back.
    reply = () => new Response(JSON.stringify({ status: 'accepted' }), { status: 202 });
    const r2 = await requestAccess(pool, w.staff2.p, { systemId: sys.id, role: 'user', justification: 'Payslips' });
    await decideAccess(pool, w.sysOwner.p, r2.id, { decision: 'approve' });
    await deliverConnectors(pool, { workerId: 't', fetchImpl: fake });
    const delivery = JSON.parse(calls[1]!.body).delivery;
    assert.equal((await listAccess(pool, w.staff2.p)).requests[0].status, 'approved', 'accepted is not done');
    const cb = JSON.stringify({ delivery, status: 'done', reference: 'payroll-user-78' });
    assert.equal((await connectorCallback(pool, sys.id, cb, sign(cb, ['wrong-secret']))).status, 401);
    assert.equal((await connectorCallback(pool, sys.id, cb, sign(cb, [sys.secret!], Math.floor(Date.now() / 1000) - 3600))).status, 401, 'an old signature is refused');
    const ok = await connectorCallback(pool, sys.id, cb, sign(cb, [sys.secret!]));
    assert.equal(ok.status, 200);
    assert.equal((await listAccess(pool, w.staff2.p)).requests[0].status, 'provisioned');
    assert.equal((await connectorCallback(pool, sys.id, cb, sign(cb, [sys.secret!]))).already, 'done', 'a repeated call back changes nothing');

    // 3. Removal: the system reports a failure, which lands on the critical list.
    reply = () => new Response(JSON.stringify({ status: 'failed', error: 'user is locked by payroll run' }), { status: 200 });
    await queueRevocations(pool, w.tenantId, w.staff.id, 'leaving');
    await deliverConnectors(pool, { workerId: 't', fetchImpl: fake });
    assert.equal(JSON.parse(calls[2]!.body).event, 'access.revoke');
    const dash = await opsDashboard(pool, w.it1.p);
    const failure = dash.failedAccess.find((f: { holder: string }) => f.holder === 'Sam Staff');
    assert.equal(failure.status, 'revoke_failed');
    assert.match(failure.note, /user is locked by payroll run/);

    // 4. An unreachable system: retried with backoff, then a failure IT can see.
    reply = () => new Response('down', { status: 503 });
    const r3 = await requestAccess(pool, w.it1.p, { systemId: sys.id, role: 'user', justification: 'Support' });
    await decideAccess(pool, w.sysOwner.p, r3.id, { decision: 'approve' });
    for (let i = 0; i < 8; i++) {
      await pool.query(`update ops_connector_delivery set available_at = now() - interval '1 second' where request_id = $1`, [r3.id]);
      await deliverConnectors(pool, { workerId: 't', fetchImpl: fake });
    }
    const { rows } = await pool.query('select status, attempts from ops_connector_delivery where request_id = $1', [r3.id]);
    assert.deepEqual(rows[0], { status: 'failed', attempts: 8 });
    const req3 = (await listAccess(pool, w.it1.p)).requests.find((r: { id: string }) => r.id === r3.id);
    assert.equal(req3.status, 'failed');
    assert.match(req3.failure_note, /unreachable after 8 attempt/);
    // IT can still finish it by hand, with evidence.
    await assert.rejects(confirmProvisioning(pool, w.it1.p, r3.id, { via: 'manual', evidenceRef: 'x' }), /someone other than the person getting the access/);
    await confirmProvisioning(pool, w.admin.p, r3.id, { via: 'manual', evidenceRef: 'Created by hand, ticket 9' });
  } finally { await pool.end(); }
});
