import { createHash, createPublicKey, randomBytes, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { FRESH_MINUTES } from './step-up.js';
import { logIfEnabled } from './trace.js';

/**
 * Passkeys, for proving it is still you.
 *
 * The console asks for a recent sign-in before pay, bank details, budgets or
 * a legal hold change (step-up.ts). On a laptop that is a password; on a
 * phone it should be a thumb or a face. A passkey is a key pair the phone's
 * secure hardware holds: the browser signs a challenge we issued, and the
 * signature proves both that this device holds the key and that the device
 * checked the person (the UV flag). We store the public half only.
 *
 * This is WebAuthn with attestation "none": we do not care which make of
 * authenticator it is, only that the same key answers next time. What is
 * verified, in order: the challenge is the one we issued and has not been
 * used, the origin is this site, the relying-party hash is this host, the
 * device says it checked the person, and the signature covers the
 * authenticator data and the client data. The counter, where a device keeps
 * one, must move forward; a cloned key that replays an old counter is
 * refused.
 *
 * A passkey here is a second proof for a session that already exists, not a
 * way to sign in. Signing in stays password (and authenticator code), so a
 * lost phone does not become a lost account.
 */

export interface RelyingParty {
  id: string;
  origin: string;
  name: string;
}

export function relyingParty(env: NodeJS.ProcessEnv = process.env): RelyingParty {
  const url = new URL(env.APP_URL || 'http://localhost:3210');
  return { id: url.hostname, origin: url.origin, name: 'Patform' };
}

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const fromB64u = (s: unknown): Buffer => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new InvalidInput('that is not a passkey response');
  return Buffer.from(s, 'base64url');
};
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

// ------------------------------------------------------------------- CBOR

/** The little of CBOR that attestation objects and COSE keys use. */
export function decodeCbor(buf: Buffer): unknown {
  let at = 0;
  const need = (n: number) => { if (at + n > buf.length) throw new InvalidInput('malformed passkey data'); };
  const read = (): unknown => {
    need(1);
    const head = buf[at++]!;
    const major = head >> 5;
    let info: number = head & 0x1f;
    let len: number;
    if (info < 24) len = info;
    else if (info === 24) { need(1); len = buf[at++]!; }
    else if (info === 25) { need(2); len = buf.readUInt16BE(at); at += 2; }
    else if (info === 26) { need(4); len = buf.readUInt32BE(at); at += 4; }
    else if (info === 27) { need(8); const big = buf.readBigUInt64BE(at); at += 8; len = Number(big); }
    else throw new InvalidInput('unsupported passkey encoding');
    switch (major) {
      case 0: return len;
      case 1: return -1 - len;
      case 2: need(len); { const out = buf.subarray(at, at + len); at += len; return Buffer.from(out); }
      case 3: need(len); { const out = buf.subarray(at, at + len).toString('utf8'); at += len; return out; }
      case 4: { const arr: unknown[] = []; for (let i = 0; i < len; i++) arr.push(read()); return arr; }
      case 5: { const map = new Map<unknown, unknown>(); for (let i = 0; i < len; i++) { const k = read(); map.set(k, read()); } return map; }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new InvalidInput('unsupported passkey encoding');
      default: throw new InvalidInput('unsupported passkey encoding');
    }
  };
  const value = read();
  return value;
}

// --------------------------------------------------------- authenticator data

export interface AuthData {
  rpIdHash: Buffer;
  flags: { userPresent: boolean; userVerified: boolean; attested: boolean };
  counter: number;
  credentialId?: Buffer;
  publicKey?: Map<unknown, unknown>;
}

export function parseAuthData(buf: Buffer): AuthData {
  if (buf.length < 37) throw new InvalidInput('malformed passkey data');
  const flagByte = buf[32]!;
  const out: AuthData = {
    rpIdHash: buf.subarray(0, 32),
    flags: { userPresent: (flagByte & 0x01) !== 0, userVerified: (flagByte & 0x04) !== 0, attested: (flagByte & 0x40) !== 0 },
    counter: buf.readUInt32BE(33),
  };
  if (out.flags.attested) {
    if (buf.length < 55) throw new InvalidInput('malformed passkey data');
    const idLen = buf.readUInt16BE(53);
    out.credentialId = buf.subarray(55, 55 + idLen);
    out.publicKey = decodeCbor(buf.subarray(55 + idLen)) as Map<unknown, unknown>;
    if (!(out.publicKey instanceof Map)) throw new InvalidInput('malformed passkey data');
  }
  return out;
}

/** COSE → the JWK we keep, and the algorithm it signs with. */
export function coseToJwk(cose: Map<unknown, unknown>): { jwk: Record<string, string>; alg: number } {
  const kty = cose.get(1);
  const alg = Number(cose.get(3));
  if (kty === 2) {
    if (cose.get(-1) !== 1 || alg !== -7) throw new InvalidInput('this passkey uses a curve we do not accept');
    const x = cose.get(-2); const y = cose.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new InvalidInput('malformed passkey key');
    return { jwk: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }, alg };
  }
  if (kty === 3) {
    if (alg !== -257) throw new InvalidInput('this passkey uses an algorithm we do not accept');
    const n = cose.get(-1); const e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new InvalidInput('malformed passkey key');
    return { jwk: { kty: 'RSA', n: b64u(n), e: b64u(e) }, alg };
  }
  throw new InvalidInput('this passkey uses a key type we do not accept');
}

function keyFromJwk(jwk: Record<string, string>): KeyObject {
  return createPublicKey({ key: jwk, format: 'jwk' });
}

// ----------------------------------------------------------------- storage

const CHALLENGE_MINUTES = 5;

async function issueChallenge(pool: Pool, actorId: string, kind: 'register' | 'reauth'): Promise<string> {
  const challenge = b64u(randomBytes(32));
  await pool.query('delete from passkey_challenge where actor_id = $1 and kind = $2', [actorId, kind]);
  await pool.query(
    `insert into passkey_challenge (actor_id, kind, challenge, expires_at) values ($1, $2, $3, now() + make_interval(mins => $4))`,
    [actorId, kind, challenge, CHALLENGE_MINUTES],
  );
  return challenge;
}

/** Takes the live challenge of this kind, so it can be answered once only. */
async function takeChallenge(pool: Pool, actorId: string, kind: 'register' | 'reauth'): Promise<string> {
  const { rows } = await pool.query<{ challenge: string }>(
    `delete from passkey_challenge where actor_id = $1 and kind = $2 returning challenge, (expires_at > now()) as live`,
    [actorId, kind],
  );
  const row = rows[0] as ({ challenge: string; live: boolean } | undefined);
  if (!row || !row.live) throw new InvalidInput('that passkey request has expired — try again');
  return row.challenge;
}

interface ClientData { type: string; challenge: string; origin: string }

function readClientData(raw: Buffer, expect: { type: string; challenge: string; rp: RelyingParty }): ClientData {
  let data: ClientData;
  try { data = JSON.parse(raw.toString('utf8')) as ClientData; } catch { throw new InvalidInput('that is not a passkey response'); }
  if (data.type !== expect.type) throw new InvalidInput('that is not the passkey response we asked for');
  if (data.challenge !== expect.challenge) throw new InvalidInput('that passkey response answers a different request');
  if (data.origin !== expect.rp.origin) throw new InvalidInput('that passkey response came from another site');
  return data;
}

export interface PasskeyRow { id: string; label: string | null; created_at: string; last_used_at: string | null; transports: string[] | null }

export async function listPasskeys(pool: Pool, actorId: string): Promise<PasskeyRow[]> {
  const { rows } = await pool.query<PasskeyRow>(
    `select id, label, created_at::text, last_used_at::text, transports from passkey where actor_id = $1 order by created_at`, [actorId]);
  return rows;
}

export async function hasPasskeys(pool: Pool, actorId: string): Promise<boolean> {
  const { rows } = await pool.query('select 1 from passkey where actor_id = $1 limit 1', [actorId]);
  return rows.length > 0;
}

// ------------------------------------------------------------ registration

export async function beginRegistration(pool: Pool, args: { actorId: string; rp?: RelyingParty }) {
  const rp = args.rp ?? relyingParty();
  const { rows } = await pool.query<{ email: string; display_name: string }>('select email, display_name from actor where id = $1', [args.actorId]);
  const me = rows[0];
  if (!me) throw new InvalidInput('sign in first');
  const existing = await pool.query<{ credential_id: string; transports: string[] | null }>('select credential_id, transports from passkey where actor_id = $1', [args.actorId]);
  const challenge = await issueChallenge(pool, args.actorId, 'register');
  return {
    rp: { id: rp.id, name: rp.name },
    user: { id: b64u(Buffer.from(args.actorId.replace(/-/g, ''), 'hex')), name: me.email, displayName: me.display_name },
    challenge,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    excludeCredentials: existing.rows.map((r) => ({ type: 'public-key', id: r.credential_id, transports: r.transports ?? undefined })),
    timeout: 60_000,
    attestation: 'none',
  };
}

export interface RegistrationResponse {
  id?: unknown;
  rawId?: unknown;
  response?: { clientDataJSON?: unknown; attestationObject?: unknown; transports?: unknown };
}

export async function finishRegistration(
  pool: Pool,
  args: { actorId: string; label?: unknown; response: RegistrationResponse; rp?: RelyingParty },
): Promise<{ id: string; label: string | null }> {
  const rp = args.rp ?? relyingParty();
  const challenge = await takeChallenge(pool, args.actorId, 'register');
  const clientDataJSON = fromB64u(args.response?.response?.clientDataJSON);
  readClientData(clientDataJSON, { type: 'webauthn.create', challenge, rp });
  const attestation = decodeCbor(fromB64u(args.response?.response?.attestationObject));
  if (!(attestation instanceof Map) || !Buffer.isBuffer(attestation.get('authData'))) throw new InvalidInput('malformed passkey data');
  const auth = parseAuthData(attestation.get('authData') as Buffer);
  if (!auth.rpIdHash.equals(sha256(rp.id))) throw new InvalidInput('that passkey was made for another site');
  if (!auth.flags.userPresent || !auth.flags.userVerified) throw new InvalidInput('the device did not check it was you — use a passkey with a fingerprint, face or PIN');
  if (!auth.flags.attested || !auth.credentialId || !auth.publicKey) throw new InvalidInput('malformed passkey data');
  const { jwk, alg } = coseToJwk(auth.publicKey);
  keyFromJwk(jwk); // refuses a key node cannot load before we store it
  const credentialId = b64u(auth.credentialId);
  const claimedId = typeof args.response?.rawId === 'string' ? args.response.rawId : args.response?.id;
  if (typeof claimedId === 'string' && claimedId !== credentialId) throw new InvalidInput('that passkey response names a different key');
  const transports = Array.isArray(args.response?.response?.transports)
    ? (args.response.response.transports as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 6)
    : null;
  const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim().slice(0, 60) : null;
  const { rows } = await pool.query<{ id: string }>(
    `insert into passkey (actor_id, credential_id, public_key, alg, counter, transports, label)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (credential_id) do nothing returning id`,
    [args.actorId, credentialId, JSON.stringify(jwk), alg, auth.counter, transports, label],
  );
  if (!rows[0]) throw new InvalidInput('that passkey is already registered');
  logIfEnabled('info', 'auth.passkey_added', { actorId: args.actorId });
  return { id: rows[0].id, label };
}

export async function removePasskey(pool: Pool, actorId: string, id: string): Promise<{ removed: boolean }> {
  const { rowCount } = await pool.query('delete from passkey where id = $1 and actor_id = $2', [id, actorId]);
  if (rowCount) logIfEnabled('info', 'auth.passkey_removed', { actorId });
  return { removed: Boolean(rowCount) };
}

// --------------------------------------------------------------- assertion

export async function beginAssertion(pool: Pool, args: { actorId: string; rp?: RelyingParty }) {
  const rp = args.rp ?? relyingParty();
  const { rows } = await pool.query<{ credential_id: string; transports: string[] | null }>('select credential_id, transports from passkey where actor_id = $1', [args.actorId]);
  if (!rows.length) throw new InvalidInput('no passkey is set up on this account');
  const challenge = await issueChallenge(pool, args.actorId, 'reauth');
  return {
    challenge,
    rpId: rp.id,
    allowCredentials: rows.map((r) => ({ type: 'public-key', id: r.credential_id, transports: r.transports ?? undefined })),
    userVerification: 'required',
    timeout: 60_000,
  };
}

export interface AssertionResponse {
  id?: unknown;
  rawId?: unknown;
  response?: { clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown };
}

/**
 * Checks the signed challenge and marks the session fresh, exactly as a
 * correct password would. Wrong answers count against the session the same
 * way (step-up.ts): five end it.
 */
export async function finishAssertion(
  pool: Pool,
  args: { actorId: string; sessionId: string; response: AssertionResponse; rp?: RelyingParty },
): Promise<{ freshUntil: string }> {
  const rp = args.rp ?? relyingParty();
  const fail = async (reason: string): Promise<never> => {
    const { rows } = await pool.query<{ reauth_failures: number }>(
      'update session set reauth_failures = reauth_failures + 1 where id = $1 returning reauth_failures', [args.sessionId]);
    if ((rows[0]?.reauth_failures ?? 5) >= 5) {
      await pool.query('update session set revoked_at = now() where id = $1', [args.sessionId]);
      logIfEnabled('warn', 'auth.step_up_locked', { actorId: args.actorId });
      throw new InvalidInput('too many wrong answers — you have been signed out');
    }
    throw new InvalidInput(reason);
  };
  const challenge = await takeChallenge(pool, args.actorId, 'reauth');
  let clientDataJSON: Buffer; let authData: Buffer; let signature: Buffer;
  try {
    clientDataJSON = fromB64u(args.response?.response?.clientDataJSON);
    authData = fromB64u(args.response?.response?.authenticatorData);
    signature = fromB64u(args.response?.response?.signature);
    readClientData(clientDataJSON, { type: 'webauthn.get', challenge, rp });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'that is not a passkey response');
  }
  const credentialId = typeof args.response?.rawId === 'string' ? args.response.rawId : args.response?.id;
  const { rows } = await pool.query<{ id: string; public_key: string; alg: number; counter: string }>(
    'select id, public_key, alg, counter::text from passkey where actor_id = $1 and credential_id = $2', [args.actorId, credentialId]);
  const key = rows[0];
  if (!key) return fail('that passkey is not registered on this account');
  const auth = parseAuthData(authData);
  if (!auth.rpIdHash.equals(sha256(rp.id))) return fail('that passkey response is for another site');
  if (!auth.flags.userPresent || !auth.flags.userVerified) return fail('the device did not check it was you');
  const publicKey = keyFromJwk(JSON.parse(key.public_key) as Record<string, string>);
  const signed = Buffer.concat([authData, sha256(clientDataJSON)]);
  let ok = false;
  try { ok = verifySignature('sha256', signed, publicKey, signature); } catch { ok = false; }
  if (!ok) return fail('that passkey signature is not right');
  const stored = Number(key.counter);
  if ((stored > 0 || auth.counter > 0) && auth.counter <= stored) {
    logIfEnabled('warn', 'auth.passkey_counter_replay', { actorId: args.actorId });
    return fail('this passkey looks cloned — remove it and add it again');
  }
  await pool.query('update passkey set counter = $2, last_used_at = now() where id = $1', [key.id, auth.counter]);
  const { rows: fresh } = await pool.query<{ authenticated_at: Date }>(
    'update session set authenticated_at = now(), reauth_failures = 0 where id = $1 returning authenticated_at', [args.sessionId]);
  logIfEnabled('info', 'auth.step_up', { actorId: args.actorId, via: 'passkey' });
  return { freshUntil: new Date(fresh[0]!.authenticated_at.getTime() + FRESH_MINUTES * 60_000).toISOString() };
}
