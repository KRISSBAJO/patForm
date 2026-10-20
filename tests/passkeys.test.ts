import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { resolveSession, startSession } from '../src/runtime/auth.js';
import { isFresh } from '../src/runtime/step-up.js';
import { beginAssertion, beginRegistration, coseToJwk, decodeCbor, finishAssertion, finishRegistration, hasPasskeys, listPasskeys, parseAuthData, removePasskey, type RelyingParty } from '../src/runtime/passkeys.js';

/**
 * Passkeys, checked by playing the phone.
 *
 * A real authenticator holds a P-256 key, signs what the browser hands it,
 * and reports its flags and counter. This test builds one from node's own
 * crypto and walks registration and step-up exactly as a browser would,
 * then tries the things an attacker would: another site's origin, a stale
 * challenge, a cloned key with an old counter, and an unverified press.
 */
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const RP: RelyingParty = { id: 'localhost', origin: 'http://localhost:3210', name: 'Patform' };
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const b64u = (b: Buffer) => b.toString('base64url');

// ---- a tiny CBOR encoder: what an authenticator emits, no more
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v.entries()].flatMap(([k, val]) => [cbor(k), cbor(val)])]);
  throw new Error('unsupported');
}

function authenticator(rp: RelyingParty = RP) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const credentialId = Buffer.from(`cred-${stamp()}`);
  let counter = 0;
  const cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  const authData = (flags: number, withKey: boolean) => {
    const base = Buffer.alloc(37);
    sha256(rp.id).copy(base, 0);
    base[32] = flags;
    base.writeUInt32BE(counter, 33);
    if (!withKey) return base;
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credentialId.length);
    return Buffer.concat([base, Buffer.alloc(16), idLen, credentialId, cbor(cose)]);
  };
  return {
    credentialId,
    privateKey: privateKey as KeyObject,
    create(challenge: string, opts: { origin?: string; flags?: number } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: opts.origin ?? rp.origin }));
      const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(opts.flags ?? 0x45, true)]]));
      return { id: b64u(credentialId), rawId: b64u(credentialId), response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] } };
    },
    get(challenge: string, opts: { origin?: string; flags?: number; bump?: boolean; forge?: boolean } = {}) {
      if (opts.bump !== false) counter += 1;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: opts.origin ?? rp.origin }));
      const data = authData(opts.flags ?? 0x05, false);
      let signature = sign('sha256', Buffer.concat([data, sha256(clientDataJSON)]), privateKey);
      if (opts.forge) signature = Buffer.from(signature.map((b, i) => (i === 10 ? b ^ 0xff : b)));
      return { id: b64u(credentialId), rawId: b64u(credentialId), response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(data), signature: b64u(signature) } };
    },
  };
}

test('the CBOR reader and COSE key reader understand what an authenticator emits', () => {
  const a = authenticator();
  const reg = a.create('abc');
  const att = decodeCbor(Buffer.from(reg.response.attestationObject, 'base64url')) as Map<string, unknown>;
  assert.equal(att.get('fmt'), 'none');
  const auth = parseAuthData(att.get('authData') as Buffer);
  assert.ok(auth.flags.userPresent && auth.flags.userVerified && auth.flags.attested);
  assert.ok(auth.credentialId!.equals(a.credentialId));
  const { jwk, alg } = coseToJwk(auth.publicKey!);
  assert.equal(alg, -7);
  assert.equal(jwk.crv, 'P-256');
  assert.throws(() => coseToJwk(new Map<number, unknown>([[1, 1]])), /key type/);
});

async function person(pool: Pool) {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant(`pk-${stamp()}`, { scenario: true });
  const actorId = await engine.createActor(tenantId, `pk-${stamp()}@pk.test`, 'Pat Key', 'owner');
  await pool.query('update actor set email_verified_at = now() where id = $1', [actorId]);
  const signedIn = (await startSession(pool, { actorId }))!;
  const session = (await resolveSession(pool, signedIn.token))!;
  // Make the session stale, as it would be after ten minutes.
  await pool.query(`update session set authenticated_at = now() - interval '1 hour' where id = $1`, [session.sessionId]);
  return { actorId, sessionId: session.sessionId };
}

test('register a passkey, then prove it is you with it; the session becomes fresh', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const { actorId, sessionId } = await person(pool);
    const a = authenticator();
    assert.equal(await hasPasskeys(pool, actorId), false);
    const options = await beginRegistration(pool, { actorId, rp: RP });
    assert.equal(options.rp.id, 'localhost');
    assert.equal(options.authenticatorSelection.userVerification, 'required');
    const added = await finishRegistration(pool, { actorId, label: 'My phone', response: a.create(options.challenge), rp: RP });
    assert.equal(added.label, 'My phone');
    assert.equal(await hasPasskeys(pool, actorId), true);
    assert.equal((await listPasskeys(pool, actorId)).length, 1);

    // The same challenge cannot register twice.
    await assert.rejects(finishRegistration(pool, { actorId, response: a.create(options.challenge), rp: RP }), /expired/);

    const before = (await pool.query<{ authenticated_at: Date }>('select authenticated_at from session where id = $1', [sessionId])).rows[0]!;
    assert.equal(isFresh(before.authenticated_at), false);

    const ask = await beginAssertion(pool, { actorId, rp: RP });
    assert.equal(ask.allowCredentials[0]!.id, b64u(a.credentialId));
    const fresh = await finishAssertion(pool, { actorId, sessionId, response: a.get(ask.challenge), rp: RP });
    assert.ok(new Date(fresh.freshUntil).getTime() > Date.now());
    const after = (await pool.query<{ authenticated_at: Date }>('select authenticated_at from session where id = $1', [sessionId])).rows[0]!;
    assert.equal(isFresh(after.authenticated_at), true);
    const stored = (await pool.query<{ counter: string; last_used_at: Date | null }>('select counter::text, last_used_at from passkey where actor_id = $1', [actorId])).rows[0]!;
    assert.equal(stored.counter, '1');
    assert.ok(stored.last_used_at);

    const removed = await removePasskey(pool, actorId, (await listPasskeys(pool, actorId))[0]!.id);
    assert.equal(removed.removed, true);
    await assert.rejects(beginAssertion(pool, { actorId, rp: RP }), /no passkey/);
  } finally { await pool.end(); }
});

test('what is refused: another origin, no user check, a forged signature, a replayed counter, five wrong answers', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const { actorId, sessionId } = await person(pool);
    const a = authenticator();

    let opts = await beginRegistration(pool, { actorId, rp: RP });
    await assert.rejects(finishRegistration(pool, { actorId, response: a.create(opts.challenge, { origin: 'https://evil.example' }), rp: RP }), /another site/);
    opts = await beginRegistration(pool, { actorId, rp: RP });
    await assert.rejects(finishRegistration(pool, { actorId, response: a.create(opts.challenge, { flags: 0x41 }), rp: RP }), /did not check it was you/);
    opts = await beginRegistration(pool, { actorId, rp: RP });
    await finishRegistration(pool, { actorId, response: a.create(opts.challenge), rp: RP });

    const failures = async () => (await pool.query<{ reauth_failures: number }>('select reauth_failures from session where id = $1', [sessionId])).rows[0]!.reauth_failures;

    let ask = await beginAssertion(pool, { actorId, rp: RP });
    await assert.rejects(finishAssertion(pool, { actorId, sessionId, response: a.get(ask.challenge, { forge: true }), rp: RP }), /signature/);
    assert.equal(await failures(), 1);

    ask = await beginAssertion(pool, { actorId, rp: RP });
    await assert.rejects(finishAssertion(pool, { actorId, sessionId, response: a.get(ask.challenge, { flags: 0x01 }), rp: RP }), /did not check/);
    assert.equal(await failures(), 2);

    // A good answer resets the count and moves the counter on.
    ask = await beginAssertion(pool, { actorId, rp: RP });
    await finishAssertion(pool, { actorId, sessionId, response: a.get(ask.challenge), rp: RP });
    assert.equal(await failures(), 0);

    // A clone that still carries an old counter is refused.
    await pool.query('update passkey set counter = 50 where actor_id = $1', [actorId]);
    ask = await beginAssertion(pool, { actorId, rp: RP });
    await assert.rejects(finishAssertion(pool, { actorId, sessionId, response: a.get(ask.challenge), rp: RP }), /cloned/);

    // A stale challenge answers nothing.
    ask = await beginAssertion(pool, { actorId, rp: RP });
    await pool.query(`update passkey_challenge set expires_at = now() - interval '1 minute' where actor_id = $1`, [actorId]);
    await assert.rejects(finishAssertion(pool, { actorId, sessionId, response: a.get(ask.challenge), rp: RP }), /expired/);

    // Wrong answers end the session, as a wrong password would.
    await pool.query('update passkey set counter = 0 where actor_id = $1', [actorId]);
    await pool.query('update session set reauth_failures = 4 where id = $1', [sessionId]);
    ask = await beginAssertion(pool, { actorId, rp: RP });
    await assert.rejects(finishAssertion(pool, { actorId, sessionId, response: a.get(ask.challenge, { forge: true }), rp: RP }), /signed out/);
    const revoked = (await pool.query<{ revoked_at: Date | null }>('select revoked_at from session where id = $1', [sessionId])).rows[0]!;
    assert.ok(revoked.revoked_at);
  } finally { await pool.end(); }
});
