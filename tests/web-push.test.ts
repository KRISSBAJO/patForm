import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { encryptForSubscription, generateVapidKeys, vapidAuthorization } from '../src/runtime/web-push.js';

/**
 * The push encryption, checked by playing the browser.
 *
 * A browser holds a P-256 key and a 16-byte auth secret; the server gets the
 * public half of each. This test makes such a browser, encrypts a message
 * for it exactly as the server would, then decrypts with the browser's
 * private key following RFC 8291 step by step. If the two agree, a real
 * browser will too, because the steps are the RFC's, not ours.
 */
function browser() {
  const ecdh = createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    sub: { endpoint: 'https://push.example.test/send/abc', p256dh: pub.toString('base64url'), auth: auth.toString('base64url') },
  };
}

function decrypt(b: ReturnType<typeof browser>, body: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const shared = b.ecdh.computeSecret(asPublic);
  const uaPublic = b.ecdh.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, b.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 0x02, 'last-record delimiter');
  return plain.subarray(0, plain.length - 1);
}

test('a message encrypted for a browser decrypts with that browser\'s key and no other', () => {
  const b = browser();
  const payload = Buffer.from(JSON.stringify({ title: 'Decision waiting', body: 'Leave request AB12CD34', url: '/console?record=x' }));
  const body = encryptForSubscription(b.sub, payload);
  assert.equal(body.readUInt32BE(16), 4096, 'record size');
  assert.equal(body[20], 65, 'key id is the 65-byte public point');
  assert.equal(decrypt(b, body).toString(), payload.toString());

  const other = browser();
  assert.throws(() => decrypt({ ...other, auth: other.auth }, body), 'another browser cannot read it');
});

test('two encryptions of the same message differ, because the salt and key are fresh', () => {
  const b = browser();
  const one = encryptForSubscription(b.sub, Buffer.from('hello'));
  const two = encryptForSubscription(b.sub, Buffer.from('hello'));
  assert.ok(!one.equals(two));
});

test('the VAPID header carries a JWT the public key verifies, scoped to the push service', () => {
  const pair = generateVapidKeys();
  const keys = { ...pair, subject: 'mailto:ops@example.test' };
  const header = vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/xyz', new Date('2026-09-26T12:00:00Z'));
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m![2], pair.publicKey);
  const [h, c, s] = m![1]!.split('.');
  const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:ops@example.test');
  assert.equal(claims.exp, Math.floor(Date.parse('2026-09-26T12:00:00Z') / 1000) + 12 * 3600);
  assert.equal(JSON.parse(Buffer.from(h!, 'base64url').toString()).alg, 'ES256');

  const point = Buffer.from(pair.publicKey, 'base64url');
  const pub = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') },
    format: 'jwk',
  });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url')));
});
