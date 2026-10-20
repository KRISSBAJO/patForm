'use client';

import { useCallback, useEffect, useState } from 'react';
import { postJson } from './stepup';

/**
 * Passkeys on this account: a fingerprint, face or device PIN that stands in
 * for the password when the console asks you to confirm it is you.
 *
 * Adding one is itself a confirmation (the password is asked once more),
 * so a stolen unlocked session cannot quietly add a key that outlives it.
 * The browser decides whether a passkey is possible at all; where it is
 * not, this says so instead of showing a button that fails.
 */

interface Passkey { id: string; label: string | null; created_at: string; last_used_at: string | null }

const b64uToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};
export const bytesToB64u = (b: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const passkeysPossible = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window && window.isSecureContext;

/** Asks this device to sign the server's challenge. Shared with the re-auth dialog. */
export async function answerWithPasskey(): Promise<boolean> {
  const ask = await postJson<{ challenge: string; rpId: string; allowCredentials: { type: 'public-key'; id: string; transports?: AuthenticatorTransport[] }[]; userVerification: UserVerificationRequirement; timeout: number }>('/api/auth/reauthenticate/passkey/begin');
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: b64uToBytes(ask.challenge),
      rpId: ask.rpId,
      allowCredentials: ask.allowCredentials.map((c) => ({ type: 'public-key', id: b64uToBytes(c.id), transports: c.transports })),
      userVerification: ask.userVerification,
      timeout: ask.timeout,
    },
  })) as PublicKeyCredential | null;
  if (!cred) return false;
  const r = cred.response as AuthenticatorAssertionResponse;
  await postJson('/api/auth/reauthenticate/passkey/finish', {
    response: { id: cred.id, rawId: bytesToB64u(cred.rawId), response: { clientDataJSON: bytesToB64u(r.clientDataJSON), authenticatorData: bytesToB64u(r.authenticatorData), signature: bytesToB64u(r.signature) } },
  });
  return true;
}

export function PasskeysPanel({ className = '' }: { className?: string }) {
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const possible = passkeysPossible();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/account/passkeys', { credentials: 'same-origin' });
      const body = (await res.json()) as { passkeys?: Passkey[] };
      setKeys(body.passkeys ?? []);
    } catch { setKeys([]); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const add = async () => {
    setBusy(true); setNote(null);
    try {
      const opts = await postJson<{
        rp: { id: string; name: string }; user: { id: string; name: string; displayName: string }; challenge: string;
        pubKeyCredParams: PublicKeyCredentialParameters[]; authenticatorSelection: AuthenticatorSelectionCriteria;
        excludeCredentials: { type: 'public-key'; id: string; transports?: AuthenticatorTransport[] }[]; timeout: number; attestation: AttestationConveyancePreference;
      }>('/api/account/passkeys/begin');
      const cred = (await navigator.credentials.create({
        publicKey: {
          rp: opts.rp,
          user: { id: b64uToBytes(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
          challenge: b64uToBytes(opts.challenge),
          pubKeyCredParams: opts.pubKeyCredParams,
          authenticatorSelection: opts.authenticatorSelection,
          excludeCredentials: opts.excludeCredentials.map((c) => ({ type: 'public-key', id: b64uToBytes(c.id), transports: c.transports })),
          timeout: opts.timeout,
          attestation: opts.attestation,
        },
      })) as PublicKeyCredential | null;
      if (!cred) { setNote('No passkey was made.'); return; }
      const r = cred.response as AuthenticatorAttestationResponse;
      const label = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : /Mac/.test(navigator.userAgent) ? 'Mac' : /Windows/.test(navigator.userAgent) ? 'Windows PC' : 'This device';
      await postJson('/api/account/passkeys/finish', {
        label,
        response: { id: cred.id, rawId: bytesToB64u(cred.rawId), response: { clientDataJSON: bytesToB64u(r.clientDataJSON), attestationObject: bytesToB64u(r.attestationObject), transports: r.getTransports?.() ?? [] } },
      });
      setNote('Passkey added. Next time the console asks you to confirm it is you, use it instead of your password.');
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setNote(/NotAllowedError|not allowed|timed out|abort/i.test(message) ? 'That was cancelled.' : message);
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true); setNote(null);
    try { await postJson(`/api/account/passkeys/${id}/remove`); await refresh(); setNote('Passkey removed.'); }
    catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return (
    <section className={`pk ${className}`}>
      <h3 className="pk__title">Fingerprint or face</h3>
      <p className="pk__lede">When the console asks you to confirm it is you — pay, bank details, a legal hold — use this device instead of your password.</p>
      {!possible && <p className="pk__note">This browser cannot make passkeys here. On a phone, open the installed app or use Safari or Chrome over https.</p>}
      {keys && keys.length > 0 && (
        <ul className="pk__list">
          {keys.map((k) => (
            <li key={k.id}>
              <span><strong>{k.label ?? 'Passkey'}</strong><small>added {k.created_at.slice(0, 10)}{k.last_used_at ? ` · last used ${k.last_used_at.slice(0, 10)}` : ''}</small></span>
              <button type="button" className="pk__remove" disabled={busy} onClick={() => void remove(k.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {possible && <button type="button" className="pk__add" disabled={busy} onClick={() => void add()}>{busy ? 'Working…' : keys?.length ? 'Add another device' : 'Set up on this device'}</button>}
      {note && <p className="pk__note" role="status">{note}</p>}
    </section>
  );
}
