'use client';

/*
 * Check a signed copy: the file's SHA-256 is worked out in the browser and
 * only the fingerprint is sent. The answer says whether it is a sealed
 * Patform Sign document, and if so what was signed, when, and by whom.
 */
import { useState } from 'react';
import '../sign.css';

type Result = { valid: boolean; sha256: string; note?: string; title?: string; workspace?: string; envelope?: string; completedAt?: string; signers?: { name: string; signed_at: string }[] };

export default function VerifyPage() {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async (file: File) => {
    setBusy(true); setError(null); setResult(null);
    try {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const res = await fetch('/api/sign/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256 }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.reason ?? body.error ?? 'The check failed.');
      setResult(body);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };
  return <div className="ps">
    <header className="ps__top"><strong>Patform Sign</strong><span>Check a signed copy</span></header>
    <main className="ps__main">
      <div className="ps__card">
        <h1>Is this the genuine signed copy?</h1>
        <p className="ps__muted">Choose the PDF. It stays on your device; only its fingerprint (SHA-256) is checked.</p>
        <input type="file" accept="application/pdf,.pdf" aria-label="Choose the signed PDF" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void check(f); }} />
      </div>
      {error && <p className="ps__error" role="alert">{error}</p>}
      {result && <div className="ps__card" role="status">
        {result.valid ? <>
          <h2 className="ps__ok" style={{ fontSize: 18, marginTop: 0 }}>Genuine: unchanged since it was signed</h2>
          <p><strong>{result.title}</strong> · {result.envelope} · from {result.workspace}</p>
          <p className="ps__muted">Completed {result.completedAt ? new Date(result.completedAt).toLocaleString() : ''}</p>
          <ul>{result.signers?.map((s) => <li key={s.name + s.signed_at}>{s.name} — signed {new Date(s.signed_at).toLocaleString()}</li>)}</ul>
        </> : <><h2 className="ps__error" style={{ fontSize: 18, marginTop: 0 }}>Not a match</h2><p>{result.note}</p></>}
        <p className="ps__muted" style={{ wordBreak: 'break-all' }}>SHA-256: {result.sha256}</p>
      </div>}
    </main>
  </div>;
}
