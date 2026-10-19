'use client';

/*
 * Signing a document sent with Patform Sign. No account: the personal link,
 * then a code emailed to the signer, then agreement to sign electronically,
 * then the document with the signer's own boxes to fill. The server checks
 * every step again; this page only walks through them.
 */
import { useCallback, useEffect, useState } from 'react';
import { PdfPages, PageBox } from '../../../components/pdf-pages';
import { SignatureField, type SignatureValue } from '../../../components/signature-field';
import '../sign.css';

type Field = { id: string; kind: 'signature' | 'initials' | 'date' | 'name' | 'text' | 'title'; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string | null };
type View = { stage: 'verify' | 'sign' | 'signed' | 'completed' | 'closed'; title: string; workspace: string; sender: string | null; name: string; email: string; expiresAt: string; status?: string;
  message?: string | null; pages?: number; consented?: boolean; consentText?: string; fields?: Field[]; completedAt?: string;
  verifyBy?: 'email' | 'sms' | 'email_and_sms'; phone?: string | null; party?: { name: string; required: number; signed: number; register?: { source?: string; companyName?: string; status?: string; number: string } | null; listedAs?: string | null } | null; signerTitle?: string | null; authorityText?: string | null; authorityNote?: string | null };

const KEY = (t: string) => `patform-sign:${t.slice(0, 12)}`;
async function call<T>(path: string, init: RequestInit & { session?: string | null } = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.session ? { 'x-sign-session': init.session } : {}) }, cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `Something went wrong (${res.status})`);
  return body as T;
}

export function SignPage({ token }: { token: string }) {
  const base = `/api/sign/t/${token}`;
  const [session, setSession] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [authority, setAuthority] = useState(false);
  const [codeSent, setCodeSent] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [signature, setSignature] = useState<SignatureValue | null>(null);
  const [initials, setInitials] = useState<SignatureValue | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Field | null>(null);
  const [draft, setDraft] = useState<unknown>(undefined);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(async (s: string | null) => {
    try { setView(await call<View>(base, { session: s })); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [base]);
  useEffect(() => {
    let s: string | null = null;
    try { s = sessionStorage.getItem(KEY(token)); } catch { /* private window */ }
    setSession(s); void load(s);
  }, [token, load]);
  useEffect(() => {
    if (view?.stage !== 'sign' || pdf) return;
    fetch(`${base}/document`, { headers: { 'x-sign-session': session ?? '' }, cache: 'no-store' })
      .then(async (r) => { if (!r.ok) throw new Error('The document could not be loaded.'); setPdf(await r.arrayBuffer()); })
      .catch((e: Error) => setError(e.message));
  }, [view, pdf, base, session]);

  const act = async (work: () => Promise<void>) => { setBusy(true); setNote(null); try { await work(); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } };

  if (error && !view) return <div className="ps"><div className="ps__main"><div className="ps__card"><h1>This link does not work</h1><p className="ps__muted">{error} If you expected a document to sign, ask the sender to send it again.</p></div></div></div>;
  if (!view) return <div className="ps"><div className="ps__main"><p>Loading…</p></div></div>;

  const fields = view.fields ?? [];
  const filled = (f: Field) => f.kind === 'signature' ? Boolean(signature) : f.kind === 'initials' ? Boolean(initials) : f.kind === 'text' || (f.kind === 'title' && !view.signerTitle) ? Boolean(values[f.id]?.trim()) : true;
  const missing = fields.filter((f) => f.required && !filled(f));
  const needsSignature = !fields.some((f) => f.kind === 'signature');
  const ready = Boolean(signature) && missing.length === 0 && (!view.party || authority);
  const shown = (f: Field) => f.kind === 'signature' ? (signature ? signature.name : 'Sign') : f.kind === 'initials' ? (initials ? initials.name : 'Initials') : f.kind === 'date' ? new Date().toLocaleDateString() : f.kind === 'name' ? (signature?.name ?? view.name) : f.kind === 'title' ? (view.signerTitle ?? values[f.id] ?? 'Job title') : (values[f.id] || f.label || 'Text');

  return <div className="ps">
    <header className="ps__top"><strong>Patform Sign</strong><span>{view.workspace}</span></header>
    <main className="ps__main">
      <div className="ps__card">
        <h1>{view.title}</h1>
        <p className="ps__muted">From {view.sender ? `${view.sender}, ` : ''}{view.workspace} · for {view.name}{view.signerTitle ? `, ${view.signerTitle}` : ''} ({view.email})</p>
        {view.party && <p><strong>You are signing on behalf of {view.party.name}.</strong> {view.party.required} authorised signature{view.party.required === 1 ? '' : 's'} needed; {view.party.signed} so far.
          {view.party.register && <><br /><span className="ps__muted">{view.party.register.source} lists {view.party.register.companyName} ({view.party.register.number}) as {view.party.register.status}{view.party.listedAs ? `; you are ${view.party.listedAs}` : ''}.</span></>}</p>}
        {view.message && <p>{view.message}</p>}
      </div>
      {note && <p className="ps__error" role="alert">{note}</p>}

      {view.stage === 'verify' && <div className="ps__card">
        <h2 style={{ fontSize: 17, margin: '0 0 6px' }}>First, confirm it is you</h2>
        <p className="ps__muted">{view.verifyBy === 'sms' ? `We will text a 6-digit code to ${view.phone}.` : view.verifyBy === 'email_and_sms' ? `We will email a code to ${view.email} and text another to ${view.phone}.` : `We will email a 6-digit code to ${view.email}.`}</p>
        {!codeSent ? <button type="button" className="ps__btn ps__btn--primary" disabled={busy} onClick={() => void act(async () => { const r = await call<{ sentTo: string }>(`${base}/code`, { method: 'POST', body: '{}' }); setCodeSent(r.sentTo); })}>{view.verifyBy === 'sms' ? 'Text me a code' : view.verifyBy === 'email_and_sms' ? 'Send my codes' : 'Email me a code'}</button>
          : <form onSubmit={(e) => { e.preventDefault(); void act(async () => { const r = await call<{ session: string }>(`${base}/verify`, { method: 'POST', body: JSON.stringify({ code, smsCode: smsCode || undefined }) }); try { sessionStorage.setItem(KEY(token), r.session); } catch { /* private window */ } setSession(r.session); await load(r.session); }); }}>
            <label htmlFor="ps-code" className="ps__muted">{view.verifyBy === 'email_and_sms' ? 'Code from the email' : `Code sent to ${codeSent}`}</label>
            <div className="ps__row" style={{ marginTop: 6 }}><input id="ps-code" className="ps__input ps__code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
              {view.verifyBy === 'email_and_sms' && <input aria-label="Code from the text message" placeholder="Text code" className="ps__input ps__code" inputMode="numeric" maxLength={6} value={smsCode} onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, ''))} />}
              <button type="submit" className="ps__btn ps__btn--primary" disabled={busy || code.length !== 6 || (view.verifyBy === 'email_and_sms' && smsCode.length !== 6)}>Continue</button>
              <button type="button" className="ps__btn" disabled={busy} onClick={() => void act(async () => { const r = await call<{ sentTo: string }>(`${base}/code`, { method: 'POST', body: '{}' }); setCodeSent(r.sentTo); setNote('A new code is on its way.'); })}>Send another</button></div>
          </form>}
      </div>}

      {view.stage === 'sign' && !view.consented && <div className="ps__card">
        <h2 style={{ fontSize: 17, margin: '0 0 6px' }}>Signing electronically</h2>
        <p>{view.consentText}</p>
        <label className="ps__row"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree</label>
        <div className="ps__row" style={{ marginTop: 10 }}>
          <button type="button" className="ps__btn ps__btn--primary" disabled={!agree || busy} onClick={() => void act(async () => { await call(`${base}/consent`, { method: 'POST', body: '{}', session }); await load(session); })}>Continue</button>
          <button type="button" className="ps__btn" onClick={() => setDeclining(true)}>Decline to sign</button>
        </div>
      </div>}

      {view.stage === 'sign' && view.consented && <>
        <div className="ps__card">
          <p style={{ margin: 0 }}>{fields.length ? `Fill the ${fields.length} highlighted box${fields.length === 1 ? '' : 'es'} — tap one to fill it.` : 'Read the document, then sign below.'} Nothing is sent until you press Finish.</p>
          {view.party && <div style={{ marginTop: 12 }}>
            {view.authorityNote && <p className="ps__muted">The sender recorded this authority: {view.authorityNote}</p>}
            <label className="ps__row"><input type="checkbox" checked={authority} onChange={(e) => setAuthority(e.target.checked)} /> {view.authorityText}</label>
          </div>}
          {needsSignature && <div style={{ marginTop: 12 }}><strong>Your signature</strong><SignatureField id="ps-sig" value={signature ?? undefined} onChange={(v) => setSignature((v as SignatureValue) ?? null)} /></div>}
        </div>
        {pdf ? <PdfPages data={pdf} overlay={(page) => fields.filter((f) => f.page === page).map((f) =>
          <PageBox key={f.id} x={f.x} y={f.y} width={f.width} height={f.height} color={filled(f) ? '#1d6b3a' : '#b26b00'} title={f.label ?? f.kind} onClick={f.kind === 'date' || f.kind === 'name' || (f.kind === 'title' && view.signerTitle) ? undefined : () => { setEditing(f); setDraft(f.kind === 'signature' ? signature ?? undefined : f.kind === 'initials' ? initials ?? undefined : values[f.id] ?? ''); }}>
            {f.kind === 'signature' && signature?.method === 'drawn' ? <img src={signature.image} alt={`Signature of ${signature.name}`} style={{ maxWidth: '100%', maxHeight: '100%' }} /> : <span>{shown(f)}{f.required && !filled(f) ? ' *' : ''}</span>}
          </PageBox>)} /> : <p>Loading the document…</p>}
        <div className="ps__bar">
          <span className="ps__muted">{ready ? 'Ready to finish.' : missing.length ? `${missing.length} box${missing.length === 1 ? '' : 'es'} still to fill` : !signature ? 'Add your signature' : `Confirm you may sign for ${view.party?.name}`}</span>
          <div className="ps__row">
            <button type="button" className="ps__btn" onClick={() => setDeclining(true)}>Decline</button>
            <button type="button" className="ps__btn ps__btn--primary" disabled={!ready || busy} onClick={() => void act(async () => {
              const r = await call<{ completed: boolean }>(`${base}/sign`, { method: 'POST', session, body: JSON.stringify({ signature, initials: initials ?? undefined, values, authority: view.party ? authority : undefined }) });
              try { sessionStorage.removeItem(KEY(token)); } catch { /* ignore */ }
              setNote(null); setView(r.completed ? { ...view, stage: 'completed', completedAt: new Date().toISOString() } : { ...view, stage: 'signed' });
            })}>Finish</button>
          </div>
        </div>
      </>}

      {view.stage === 'signed' && <div className="ps__card"><h2 className="ps__ok" style={{ fontSize: 18, margin: 0 }}>You have signed</h2><p className="ps__muted">When everyone has signed, we will email you the signed copy.</p></div>}
      {view.stage === 'completed' && <div className="ps__card"><h2 className="ps__ok" style={{ fontSize: 18, margin: 0 }}>Signed by everyone</h2>
        <p className="ps__muted">Completed {view.completedAt ? new Date(view.completedAt).toLocaleString() : ''}. A copy is also on its way to your email.</p>
        <a className="ps__btn ps__btn--primary" href={`${base}/final`} style={{ display: 'inline-block', textDecoration: 'none', padding: '10px 16px', borderRadius: 10 }}>Download the signed copy</a>
        <p className="ps__muted">Check any copy at <a href="/sign/verify">the verify page</a>.</p></div>}
      {view.stage === 'closed' && <div className="ps__card"><h2 style={{ fontSize: 18, margin: 0 }}>This document is no longer open for signing</h2><p className="ps__muted">It was {view.status}. Contact the sender if you think this is a mistake.</p></div>}
    </main>

    {editing && <div className="ps__sheet" role="dialog" aria-modal="true" aria-label="Fill this box"><div className="ps__sheetBody">
      <h2 style={{ fontSize: 17, marginTop: 0 }}>{editing.kind === 'signature' ? 'Your signature' : editing.kind === 'initials' ? 'Your initials' : editing.label ?? 'Fill in'}</h2>
      {editing.kind === 'signature' || editing.kind === 'initials'
        ? <SignatureField id="ps-edit" value={draft} onChange={setDraft} />
        : <input className="ps__input" autoFocus value={String(draft ?? '')} onChange={(e) => setDraft(e.target.value)} />}
      <div className="ps__row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button type="button" className="ps__btn" onClick={() => setEditing(null)}>Cancel</button>
        <button type="button" className="ps__btn ps__btn--primary" onClick={() => {
          if (editing.kind === 'signature') setSignature((draft as SignatureValue) ?? null);
          else if (editing.kind === 'initials') setInitials((draft as SignatureValue) ?? null);
          else setValues((v) => ({ ...v, [editing.id]: String(draft ?? '') }));
          setEditing(null);
        }}>Apply</button>
      </div>
    </div></div>}

    {declining && <div className="ps__sheet" role="dialog" aria-modal="true" aria-label="Decline to sign"><div className="ps__sheetBody">
      <h2 style={{ fontSize: 17, marginTop: 0 }}>Decline to sign</h2>
      <p className="ps__muted">The sender and anyone who has signed will be told, with your reason. The document will be closed.</p>
      <textarea className="ps__input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you declining?" />
      <div className="ps__row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button type="button" className="ps__btn" onClick={() => setDeclining(false)}>Back</button>
        <button type="button" className="ps__btn ps__btn--primary" disabled={!reason.trim() || busy} onClick={() => void act(async () => { await call(`${base}/decline`, { method: 'POST', session, body: JSON.stringify({ reason }) }); setDeclining(false); await load(null); })}>Decline</button>
      </div>
    </div></div>}
  </div>;
}
