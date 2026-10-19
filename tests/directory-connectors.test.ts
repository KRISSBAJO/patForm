import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createPool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { clearTokenCacheForTests, runDirectoryJob, testDirectory, Transient, type DirectoryConfig } from '../src/runtime/directory-connectors.js';
import { decideAccess, deliverConnectors, listAccess, listSystems, queueRevocations, requestAccess, saveSystem, setOpsTeamMember } from '../src/runtime/ops.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const GROUP = '11111111-2222-3333-4444-555555555555';
const USER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

type Call = { method: string; url: string; body: string; auth: string | null };
/** A fake Microsoft or Google: records every call and answers from a table of routes. */
function fakeServer(routes: (c: Call) => { status: number; body?: unknown } | undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const c: Call = { method: init.method ?? 'GET', url: String(url), body: String(init.body ?? ''), auth: headers.authorization ?? null };
    calls.push(c);
    const r = routes(c) ?? { status: 404, body: { error: { message: 'not found' } } };
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; process.env[k] = v; }
  clearTokenCacheForTests();
  return fn().finally(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } clearTokenCacheForTests(); });
}
const MS_ENV = { MS365_CLIENT_ID: 'patform-app-id', MS365_CLIENT_SECRET: 'patform-app-secret' };

const microsoft = (overrides: Partial<Record<string, { status: number; body?: unknown }>> = {}) => fakeServer((c) => {
  if (c.url.includes('/oauth2/v2.0/token')) return { status: 200, body: { access_token: 'ms-token', expires_in: 3600 } };
  if (c.method === 'GET' && c.url.includes(`/users/${encodeURIComponent('sam@acme.test')}`)) return overrides.user ?? { status: 200, body: { id: USER, accountEnabled: true } };
  if (c.method === 'POST' && c.url.endsWith(`/groups/${GROUP}/members/$ref`)) return overrides.add ?? { status: 204 };
  if (c.method === 'DELETE' && c.url.endsWith(`/groups/${GROUP}/members/${USER}/$ref`)) return overrides.remove ?? { status: 204 };
  if (c.method === 'PATCH' && c.url.endsWith(`/users/${USER}`)) return { status: 204 };
  if (c.method === 'POST' && c.url.endsWith(`/users/${USER}/revokeSignInSessions`)) return { status: 200, body: { value: true } };
  if (c.method === 'GET' && c.url.includes(`/groups/${GROUP}`)) return { status: 200, body: { id: GROUP, displayName: 'Payroll editors' } };
  return undefined;
});
const msCfg: DirectoryConfig = { tenantId: 'acme.onmicrosoft.com', domains: ['acme.test'], roleGroups: { editor: GROUP }, suspendOnLeave: true };

test('Microsoft 365: signs in as the Patform app for the customer tenant, adds and removes group membership, suspends leavers', () => withEnv(MS_ENV, async () => {
  const ms = microsoft();
  const add = await runDirectoryJob('microsoft365', msCfg, { kind: 'provision', email: 'sam@acme.test', role: 'editor' }, ms.fetchImpl);
  assert.deepEqual(add, { status: 'done', reference: `entra:${GROUP}:${USER}` });
  const token = ms.calls[0]!;
  assert.match(token.url, /login\.microsoftonline\.com\/acme\.onmicrosoft\.com\/oauth2\/v2\.0\/token$/);
  const form = new URLSearchParams(token.body);
  assert.equal(form.get('client_id'), 'patform-app-id');
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('scope'), 'https://graph.microsoft.com/.default');
  const addCall = ms.calls.find((c) => c.method === 'POST' && c.url.endsWith('/members/$ref'))!;
  assert.equal(addCall.auth, 'Bearer ms-token');
  assert.equal(JSON.parse(addCall.body)['@odata.id'], `https://graph.microsoft.com/v1.0/directoryObjects/${USER}`);

  // The token is reused, not fetched for every call.
  await runDirectoryJob('microsoft365', msCfg, { kind: 'revoke', email: 'sam@acme.test', role: 'editor' }, ms.fetchImpl);
  assert.equal(ms.calls.filter((c) => c.url.includes('/token')).length, 1);
  assert.ok(!ms.calls.some((c) => c.method === 'PATCH'), 'an ordinary removal does not suspend the account');

  const leaver = await runDirectoryJob('microsoft365', msCfg, { kind: 'revoke', email: 'sam@acme.test', role: 'editor', leaving: true }, ms.fetchImpl);
  assert.equal(leaver.status, 'done');
  assert.match((leaver as { reference: string }).reference, /account disabled and signed out/);
  assert.deepEqual(JSON.parse(ms.calls.find((c) => c.method === 'PATCH')!.body), { accountEnabled: false });
  assert.ok(ms.calls.some((c) => c.url.endsWith('/revokeSignInSessions')));

  // Already a member, or already removed: both count as done.
  assert.equal((await runDirectoryJob('microsoft365', msCfg, { kind: 'provision', email: 'sam@acme.test', role: 'editor' }, microsoft({ add: { status: 400, body: { error: { message: 'One or more added object references already exist' } } } }).fetchImpl)).status, 'done');
  assert.equal((await runDirectoryJob('microsoft365', msCfg, { kind: 'revoke', email: 'sam@acme.test', role: 'editor' }, microsoft({ remove: { status: 404 } }).fetchImpl)).status, 'done');
  // Permanent problems are failures with a reason; rate limits are retried.
  const denied = await runDirectoryJob('microsoft365', msCfg, { kind: 'provision', email: 'sam@acme.test', role: 'editor' }, microsoft({ add: { status: 403, body: { error: { message: 'Insufficient privileges' } } } }).fetchImpl);
  assert.deepEqual(denied, { status: 'failed', error: 'Microsoft refused: grant the app GroupMember.ReadWrite.All' });
  await assert.rejects(runDirectoryJob('microsoft365', msCfg, { kind: 'provision', email: 'sam@acme.test', role: 'editor' }, microsoft({ add: { status: 429 } }).fetchImpl), Transient);
  assert.match((await runDirectoryJob('microsoft365', msCfg, { kind: 'provision', email: 'eve@evil.test', role: 'editor' }, ms.fetchImpl) as { error: string }).error, /not in acme\.test/);
  assert.match((await runDirectoryJob('microsoft365', msCfg, { kind: 'provision', email: 'sam@acme.test', role: 'admin' }, ms.fetchImpl) as { error: string }).error, /not mapped/);

  const check = await testDirectory('microsoft365', msCfg, ms.fetchImpl);
  assert.equal(check.ok, true);
  assert.equal(check.checks[1]!.what, 'role "editor" → Payroll editors');
}));

test('Microsoft 365: without the server settings, or without consent, it fails with a reason instead of retrying', async () => {
  await withEnv({ MS365_CLIENT_ID: '', MS365_CLIENT_SECRET: '' }, async () => {
    const r = await runDirectoryJob('microsoft365', msCfg, { kind: 'provision', email: 'sam@acme.test', role: 'editor' }, microsoft().fetchImpl);
    assert.deepEqual(r, { status: 'failed', error: 'MS365_CLIENT_ID and MS365_CLIENT_SECRET are not set on the server' });
  });
  await withEnv(MS_ENV, async () => {
    const noConsent = fakeServer((c) => (c.url.includes('/token') ? { status: 400, body: { error: 'invalid_client', error_description: 'AADSTS65001 consent required' } } : undefined));
    const r = await runDirectoryJob('microsoft365', msCfg, { kind: 'provision', email: 'sam@acme.test', role: 'editor' }, noConsent.fetchImpl);
    assert.equal(r.status, 'failed');
    assert.match((r as { error: string }).error, /consent/);
  });
});

test('Google Workspace: a signed service-account token for the customer admin, group membership, and suspension of leavers', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n');
  await withEnv({ GOOGLE_WORKSPACE_SA_EMAIL: 'patform@patform-prod.iam.gserviceaccount.com', GOOGLE_WORKSPACE_SA_PRIVATE_KEY: pem }, async () => {
    const cfg: DirectoryConfig = { adminEmail: 'it-admin@acme.test', domains: ['acme.test'], roleGroups: { viewer: 'payroll-viewers@acme.test' }, suspendOnLeave: true };
    let claims: Record<string, unknown> = {};
    const g = fakeServer((c) => {
      if (c.url === 'https://oauth2.googleapis.com/token') {
        const form = new URLSearchParams(c.body);
        assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
        const [h, p, sig] = form.get('assertion')!.split('.');
        assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, 'base64url')), 'the token is signed with the service account key');
        claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
        return { status: 200, body: { access_token: 'g-token', expires_in: 3600 } };
      }
      const base = 'https://admin.googleapis.com/admin/directory/v1';
      if (c.method === 'POST' && c.url === `${base}/groups/${encodeURIComponent('payroll-viewers@acme.test')}/members`) return { status: 409, body: { error: { message: 'Member already exists.' } } };
      if (c.method === 'DELETE' && c.url === `${base}/groups/${encodeURIComponent('payroll-viewers@acme.test')}/members/${encodeURIComponent('sam@acme.test')}`) return { status: 204 };
      if (c.method === 'PUT' && c.url === `${base}/users/${encodeURIComponent('sam@acme.test')}`) return { status: 200, body: { suspended: true } };
      if (c.method === 'POST' && c.url === `${base}/users/${encodeURIComponent('sam@acme.test')}/signOut`) return { status: 204 };
      return undefined;
    });
    assert.equal((await runDirectoryJob('google_workspace', cfg, { kind: 'provision', email: 'sam@acme.test', role: 'viewer' }, g.fetchImpl)).status, 'done');
    assert.equal(claims.iss, 'patform@patform-prod.iam.gserviceaccount.com');
    assert.equal(claims.sub, 'it-admin@acme.test');
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    assert.match(String(claims.scope), /admin\.directory\.group\.member/);
    const out = await runDirectoryJob('google_workspace', cfg, { kind: 'revoke', email: 'sam@acme.test', role: 'viewer', leaving: true }, g.fetchImpl);
    assert.match((out as { reference: string }).reference, /suspended and signed out/);
    assert.deepEqual(JSON.parse(g.calls.find((c) => c.method === 'PUT')!.body), { suspended: true });
    assert.match((await runDirectoryJob('google_workspace', cfg, { kind: 'provision', email: 'sam@other.test', role: 'viewer' }, g.fetchImpl) as { error: string }).error, /not in acme\.test/);
  });
});

test('directory connectors in the workflow: setup is checked, approval adds the person, HR removal takes them out and suspends them', { skip: !localDatabase }, () => withEnv(MS_ENV, async () => {
  const pool = createPool(3); const engine = new Engine(pool);
  try {
    const tenantId = await engine.createTenant(`dir-${stamp()}`, { scenario: true });
    const mk = async (email: string, name: string, role: 'owner' | 'admin' | 'operator' | 'read_only') => {
      const id = await engine.createActor(tenantId, email, name, role);
      return { id, p: { kind: 'actor', tenantId, actorId: id } as Principal };
    };
    const owner = await mk(`owner-${stamp()}@acme.test`, 'Owner', 'owner');
    const admin = await mk(`admin-${stamp()}@acme.test`, 'Ada Admin', 'admin');
    const it = await mk(`it-${stamp()}@acme.test`, 'Ivo IT', 'operator');
    const sysOwner = await mk(`fin-${stamp()}@acme.test`, 'Fin Owner', 'operator');
    const samEmail = `sam-${stamp()}@acme.test`;
    const sam = await mk(samEmail, 'Sam Staff', 'read_only');
    await setModule(pool, owner.p, 'assets', { enabled: true });
    await setOpsTeamMember(pool, admin.p, { team: 'it', actorId: it.id });

    await assert.rejects(saveSystem(pool, admin.p, { name: 'Payroll', ownerId: sysOwner.id, roles: ['editor', 'viewer'], connectorKind: 'microsoft365', directory: { tenantId: 'acme.onmicrosoft.com', roleGroups: { editor: GROUP } } }), /map the role "viewer" to a group/);
    await assert.rejects(saveSystem(pool, admin.p, { name: 'Payroll', ownerId: sysOwner.id, roles: ['editor'], connectorKind: 'microsoft365', directory: { tenantId: 'acme.onmicrosoft.com', roleGroups: { editor: 'Payroll Editors' } } }), /object ID/);
    const sys = await saveSystem(pool, admin.p, { name: 'Payroll', ownerId: sysOwner.id, roles: ['editor'], connectorKind: 'microsoft365', directory: { tenantId: 'acme.onmicrosoft.com', domains: ['acme.test'], roleGroups: { editor: GROUP }, suspendOnLeave: true } });
    assert.equal(sys.secret, null, 'a directory connector needs no signing secret');
    const listed = (await listSystems(pool, admin.p)).find((s: { id: string }) => s.id === sys.id);
    assert.match(listed.connector_setup.consentUrl, /adminconsent\?client_id=patform-app-id/);
    assert.ok(listed.connector_setup.permissions.includes('User.RevokeSessions.All'));

    const fake = fakeServer((c) => {
      if (c.url.includes('/token')) return { status: 200, body: { access_token: 'ms-token', expires_in: 3600 } };
      if (c.method === 'GET' && c.url.includes(`/users/${encodeURIComponent(samEmail)}`)) return { status: 200, body: { id: USER } };
      if (c.url.endsWith('/members/$ref') || c.url.endsWith(`/members/${USER}/$ref`) || c.method === 'PATCH') return { status: 204 };
      if (c.url.endsWith('/revokeSignInSessions')) return { status: 200, body: { value: true } };
      return undefined;
    });
    const r = await requestAccess(pool, sam.p, { systemId: sys.id, role: 'editor', justification: 'Month-end' });
    await decideAccess(pool, sysOwner.p, r.id, { decision: 'approve' });
    await deliverConnectors(pool, { workerId: 't', fetchImpl: fake.fetchImpl });
    let access = await listAccess(pool, sam.p);
    assert.equal(access.requests[0].status, 'provisioned');
    assert.equal(access.requests[0].provisioned_via, 'connector');
    assert.equal(access.grants[0].status, 'active');

    await queueRevocations(pool, tenantId, sam.id, 'access revoked by HR');
    await deliverConnectors(pool, { workerId: 't', fetchImpl: fake.fetchImpl });
    access = await listAccess(pool, it.p);
    const g = access.grants.find((x: { holder: string }) => x.holder === 'Sam Staff');
    assert.equal(g.status, 'revoked');
    assert.ok(fake.calls.some((c) => c.method === 'PATCH'), 'the leaver was suspended');
    assert.ok(fake.calls.some((c) => c.url.endsWith('/revokeSignInSessions')), 'and signed out');
  } finally { await pool.end(); }
}));
