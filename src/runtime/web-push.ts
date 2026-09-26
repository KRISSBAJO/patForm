import { createCipheriv, createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';

/**
 * Web Push, written against the two RFCs rather than pulled in.
 *
 * A push message is an HTTP POST to a URL the browser handed out, carrying a
 * payload only that browser can read. Two standards make it work:
 *
 * - **RFC 8291, message encryption.** An ephemeral P-256 key agreement with
 *   the browser's public key, an HKDF chain salted with the browser's auth
 *   secret, then AES-128-GCM. The `aes128gcm` content coding puts the salt
 *   and our public key at the front of the body, so the message stands alone.
 * - **RFC 8292, VAPID.** A short JWT signed with the application's own P-256
 *   key, so the push service knows which application is talking to it and
 *   whom to contact if it misbehaves. The public half goes to the browser
 *   when it subscribes and is what ties a subscription to this deployment.
 *
 * Node's crypto has every primitive: ECDH, HKDF, AES-GCM, ES256. Fifty lines
 * of plumbing is less to carry than a library that also does GCM-legacy,
 * proxies and Node 8, and every step here can be read against the RFC.
 */
export interface PushSubscriptionKeys {
  endpoint: string;
  /** The browser's P-256 public key, base64url, 65 bytes uncompressed. */
  p256dh: string;
  /** The browser's 16-byte auth secret, base64url. */
  auth: string;
}

export interface VapidKeys {
  /** base64url of the uncompressed public point, as the browser wants it. */
  publicKey: string;
  /** base64url of the 32-byte private scalar. */
  privateKey: string;
  /** mailto: or https: contact for the push service. */
  subject: string;
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** 404 or 410: the subscription is dead and should be forgotten. */
  gone: boolean;
  detail?: string;
}

const b64u = {
  encode: (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url'),
  decode: (s: string): Buffer => Buffer.from(s, 'base64url'),
};

/** A fresh VAPID key pair, for `npm run push:keys`. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  const point = Buffer.concat([Buffer.from([0x04]), b64u.decode(jwk.x), b64u.decode(jwk.y)]);
  void publicKey;
  return { publicKey: b64u.encode(point), privateKey: jwk.d };
}

/** The keys from the environment, or null when push is not configured. */
export function vapidKeysFromEnv(env: NodeJS.ProcessEnv = process.env): VapidKeys | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  const subject = env.VAPID_SUBJECT?.trim() || 'mailto:hello@patforms.com';
  return { publicKey, privateKey, subject };
}

/** RFC 8292 §2: a JWT for the push service's origin, valid twelve hours. */
export function vapidAuthorization(keys: VapidKeys, endpoint: string, now = new Date()): string {
  const aud = new URL(endpoint).origin;
  const header = b64u.encode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(
    Buffer.from(JSON.stringify({ aud, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: keys.subject })),
  );
  const signingInput = `${header}.${claims}`;
  const point = b64u.decode(keys.publicKey);
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('VAPID_PUBLIC_KEY is not an uncompressed P-256 point');
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u.encode(point.subarray(1, 33)), y: b64u.encode(point.subarray(33, 65)), d: keys.privateKey },
    format: 'jwk',
  });
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signingInput}.${b64u.encode(signature)}, k=${keys.publicKey}`;
}

/** RFC 8291: the payload, encrypted for one subscription, as an aes128gcm body. */
export function encryptForSubscription(sub: PushSubscriptionKeys, plaintext: Buffer, salt = randomBytes(16)): Buffer {
  const uaPublic = b64u.decode(sub.p256dh);
  const authSecret = b64u.decode(sub.auth);
  if (uaPublic.length !== 65) throw new Error('subscription p256dh is not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('subscription auth secret is not 16 bytes');

  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);

  // §3.4: IKM from the shared secret, salted with the auth secret and bound
  // to both public keys.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  // RFC 8188 §2.2 / 2.3: the content key and nonce, salted with the message salt.
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // One record: the plaintext, then the delimiter 0x02 marking the last record.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  // RFC 8188 §2.1 header: salt(16) | rs(4) | idlen(1) | keyid(idlen) | records.
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Sends one message. Never throws for a push-service answer; only for a broken key. */
export async function sendWebPush(
  keys: VapidKeys,
  sub: PushSubscriptionKeys,
  payload: unknown,
  options: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string } = {},
): Promise<PushResult> {
  const body = encryptForSubscription(sub, Buffer.from(JSON.stringify(payload)));
  const headers: Record<string, string> = {
    authorization: vapidAuthorization(keys, sub.endpoint),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(options.ttl ?? 24 * 3600),
    urgency: options.urgency ?? 'normal',
  };
  if (options.topic) headers.topic = options.topic.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '-');
  try {
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body: body as unknown as BodyInit });
    const gone = res.status === 404 || res.status === 410;
    return { ok: res.ok, status: res.status, gone, ...(res.ok ? {} : { detail: (await res.text().catch(() => '')).slice(0, 200) }) };
  } catch (err) {
    return { ok: false, status: 0, gone: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** The browser-side check of a public key, exposed for tests. */
export function publicKeyFromJwk(jwk: { x: string; y: string }): string {
  return b64u.encode(Buffer.concat([Buffer.from([0x04]), b64u.decode(jwk.x), b64u.decode(jwk.y)]));
}

export const __test = { b64u, createPublicKey };
