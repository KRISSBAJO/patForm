import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Secrets that must be readable by the application and useless in a dump.
 *
 * The TOTP secret is the case this exists for. A second factor is only a
 * second factor if a copy of the database is not enough to pass it — and the
 * secret was stored as text, so anybody with a backup, a replica or one
 * `select` could generate the current code for every account. Hashing does
 * not work here the way it does for passwords and recovery codes: the server
 * has to compute codes from the secret, so it has to be able to read it.
 *
 * So it is encrypted, AES-256-GCM, with a key that is not in the database:
 * `MFA_ENCRYPTION_KEY`, 32 bytes, base64. A KMS would be better still — the
 * key would never be in this process's environment at all — and this format
 * leaves room for one: every value names the key that sealed it.
 *
 * Each value is bound to what it belongs to (the actor id, as GCM's
 * additional data). A ciphertext copied from one row into another does not
 * decrypt, so write access to the table is not a way to give yourself
 * somebody else's second factor.
 *
 * Stored as `v1.<key id>.<iv>.<ciphertext>.<tag>`, base64url throughout.
 */

const PREFIX = 'v1';
/** A fixed development key. Known to everybody, so never accepted in production. */
const DEV_KEY = createHash('sha256').update('patform development only — not a secret').digest();

let warned = false;

interface Key {
  id: string;
  bytes: Buffer;
}

function parse(value: string, name: string): Key {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
  return { id: createHash('sha256').update(bytes).digest('hex').slice(0, 8), bytes };
}

/** The key new values are sealed with, and every key a stored value may name. */
function keys(): { current: Key; all: Key[] } {
  const configured = process.env.MFA_ENCRYPTION_KEY;
  if (!configured) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'MFA_ENCRYPTION_KEY is not set. Two-factor secrets would be readable by anybody with a copy of the database. ' +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      );
    }
    if (!warned) {
      warned = true;
      console.warn('  MFA_ENCRYPTION_KEY is not set; two-factor secrets are sealed with the public development key.');
    }
    const dev = { id: 'dev00000', bytes: DEV_KEY };
    return { current: dev, all: [dev] };
  }
  const current = parse(configured, 'MFA_ENCRYPTION_KEY');
  const previous = process.env.MFA_ENCRYPTION_KEY_PREVIOUS
    ? [parse(process.env.MFA_ENCRYPTION_KEY_PREVIOUS, 'MFA_ENCRYPTION_KEY_PREVIOUS')]
    : [];
  return { current, all: [current, ...previous] };
}

/** Fails at startup rather than at somebody's first sign-in. */
export function assertSecretKeyConfigured(): void {
  keys();
}

export function seal(plaintext: string, boundTo: string): string {
  const { current } = keys();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.bytes, iv);
  cipher.setAAD(Buffer.from(boundTo));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const b = (x: Buffer) => x.toString('base64url');
  return [PREFIX, current.id, b(iv), b(body), b(cipher.getAuthTag())].join('.');
}

/**
 * The plaintext, and whether the stored value should be written again.
 *
 * `reseal` is true for a value sealed with a previous key, and for a legacy
 * value stored before encryption existed — which is read as it is, once, so
 * nobody enrolled before this change is locked out, and replaced by the
 * caller with a sealed one. A value that names a key this process does not
 * have, or that fails authentication, throws: it was tampered with, moved
 * from another row, or sealed under a key that has since been dropped.
 */
export function open(stored: string, boundTo: string): { plaintext: string; reseal: boolean } {
  if (!stored.startsWith(`${PREFIX}.`)) return { plaintext: stored, reseal: true };

  const [, keyId, iv, body, tag] = stored.split('.');
  const { current, all } = keys();
  const key = all.find((k) => k.id === keyId);
  if (!key || !iv || !body || !tag) throw new Error('a sealed secret names a key this deployment does not have');

  const decipher = createDecipheriv('aes-256-gcm', key.bytes, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(boundTo));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  return { plaintext, reseal: key.id !== current.id };
}
