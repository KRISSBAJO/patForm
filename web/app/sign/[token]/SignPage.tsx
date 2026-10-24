'use client';

/*
 * Signing a document sent with Patform Sign. No account: the personal link,
 * then a code emailed to the signer, then agreement to sign electronically,
 * then the document with the signer's own boxes to fill. The server checks
 * every step again; this page only walks through them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PdfPages, PageBox } from '../../../components/pdf-pages';
import { SignatureField, SignatureView, isSignature, type SignatureValue } from '../../../components/signature-field';
import '../sign.css';

type Field = { id: string; kind: 'signature' | 'initials' | 'date' | 'name' | 'text' | 'title' | 'email' | 'company' | 'checkbox' | 'dropdown' | 'radio' | 'payment'; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string | null; choices: string[]; amountMinor?: number | null; currency?: string | null; paymentStatus?: string | null };
type View = { stage: 'verify' | 'sign' | 'signed' | 'completed' | 'closed'; title: string; workspace: string; sender: string | null; name: string; email: string; expiresAt: string; status?: string;
  codeExpiresAt?: string | null; codeRequestAvailableAt?: string | null;
  finalizing?: boolean;
  message?: string | null; pages?: number; consented?: boolean; consentText?: string; fields?: Field[]; completedAt?: string;
  verifyBy?: 'email' | 'sms' | 'email_and_sms'; phone?: string | null; party?: { name: string; required: number; signed: number; register?: { source?: string; companyName?: string; status?: string; number: string } | null; listedAs?: string | null } | null; signerTitle?: string | null; authorityText?: string | null; authorityNote?: string | null; allowAttachments?: boolean; attachments?: { id: string; filename: string; sha256: string }[] };

const KEY = (t: string) => `patform-sign:${t.slice(0, 12)}`;
const initialsOf = (name: string) => {
  const parts = name.trim().split(/[\s\-]+/u).map((part) => Array.from(part.replace(/[^\p{L}]/gu, ''))).filter((part) => part.length);
  return (parts.length > 1 ? parts.map((part) => part[0]) : parts[0]?.slice(0, 2) ?? []).slice(0, 8).join('').toUpperCase();
};
async function call<T>(path: string, init: RequestInit & { session?: string | null } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.session ? { 'x-sign-session': init.session } : {}) }, cache: 'no-store', signal: AbortSignal.timeout(75_000) });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('This is taking too long. Please try again; if your code has expired, request a new one.');
    throw error;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `Something went wrong (${res.status})`);
  return body as T;
}
async function fileBase64(file: File) { return await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }

function CodeInput({ id, label, value, onChange, autoFocus = false }: { id: string; label: string; value: string; onChange: (value: string) => void; autoFocus?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="ps__otpGroup">
    <label htmlFor={id} className="ps__otpLabel">{label}</label>
    <div className="ps__otp" onClick={() => input.current?.focus()}>
      <input ref={input} id={id} className="ps__otpInput" type="text" inputMode="numeric" autoComplete={id === 'ps-code' ? 'one-time-code' : 'off'}
        pattern="[0-9]*" maxLength={6} value={value} autoFocus={autoFocus} aria-label={label}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))} />
      {Array.from({ length: 6 }, (_, index) => <span key={index} aria-hidden="true" className={`ps__otpDigit${value.length === index ? ' ps__otpDigit--next' : ''}${value.length === 6 && index === 5 ? ' ps__otpDigit--last' : ''}`}>
        {value[index] ?? ''}
      </span>)}
    </div>
  </div>;
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
  const [agree, setAgree] = useState(false);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfAttempt, setPdfAttempt] = useState(0);
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
    if (view?.stage !== 'verify') return;
    const refresh = () => { if (document.visibilityState === 'visible') void load(session); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('pageshow', refresh);
    return () => { document.removeEventListener('visibilitychange', refresh); window.removeEventListener('pageshow', refresh); };
  }, [view?.stage, load, session]);
  useEffect(() => {
    if (view?.stage !== 'sign' || pdf) return;
    let cancelled = false;
    setPdfError(null);
    fetch(`${base}/document`, { headers: { 'x-sign-session': session ?? '' }, cache: 'no-store', signal: AbortSignal.timeout(75_000) })
      .then(async (r) => { if (!r.ok) throw new Error('The document could not be loaded.'); const bytes = await r.arrayBuffer(); if (!cancelled) setPdf(bytes); })
      .catch(() => { if (!cancelled) setPdfError('The document is taking too long to open. Try again.'); });
    return () => { cancelled = true; };
  }, [view, pdf, base, session, pdfAttempt]);
  useEffect(() => {
    if (!pdf) return;
    const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    setPdfUrl(url);
    return () => { URL.revokeObjectURL(url); };
  }, [pdf]);
  useEffect(() => {
    if (view?.stage !== 'sign' || !view.consented || !view.fields?.some((f) => f.kind === 'payment' && f.paymentStatus !== 'paid') || !session) return;
    if (!new URLSearchParams(window.location.search).has('payment')) return;
    const timer = window.setInterval(() => {
      void call<{ status: string }>(`${base}/payment-status`, { session }).then((result) => {
        if (result.status === 'paid') { window.clearInterval(timer); window.history.replaceState(null, '', window.location.pathname); void load(session); }
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [view, session, base, load]);

  const act = async (work: () => Promise<void>) => { setBusy(true); setNote(null); try { await work(); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } };

  if (error && !view) return <div className="ps"><div className="ps__main"><div className="ps__card"><h1>This link does not work</h1><p className="ps__muted">{error} If you expected a document to sign, ask the sender to send it again.</p></div></div></div>;
  if (!view) return <div className="ps"><div className="ps__main"><p>Loading…</p></div></div>;

  const fields = view.fields ?? [];
  const filled = (f: Field) => f.kind === 'signature' ? Boolean(signature) : f.kind === 'initials' ? Boolean(initials) : f.kind === 'payment' ? f.paymentStatus === 'paid' : f.kind === 'checkbox' ? values[f.id] === 'Yes' : ['text', 'dropdown', 'radio'].includes(f.kind) || (f.kind === 'title' && !view.signerTitle) || (f.kind === 'company' && !view.party) ? Boolean(values[f.id]?.trim()) : true;
  const missing = fields.filter((f) => f.required && !filled(f));
  const needsSignature = !fields.some((f) => f.kind === 'signature');
  const ready = Boolean(signature) && missing.length === 0 && (!view.party || authority);
  const shown = (f: Field) => f.kind === 'signature' ? (signature ? signature.name : 'Sign') : f.kind === 'initials' ? (initials ? initials.name : 'Initials') : f.kind === 'payment' ? (f.paymentStatus === 'paid' ? 'Payment verified' : `${f.currency} ${((f.amountMinor ?? 0) / 100).toFixed(2)} · pay securely`) : f.kind === 'date' ? new Date().toLocaleDateString() : f.kind === 'name' ? (signature?.name ?? view.name) : f.kind === 'email' ? view.email : f.kind === 'company' && view.party ? view.party.name : f.kind === 'title' ? (view.signerTitle ?? values[f.id] ?? 'Job title') : f.kind === 'checkbox' ? (values[f.id] === 'Yes' ? '☑' : '☐') : (values[f.id] || f.label || (f.kind === 'dropdown' || f.kind === 'radio' ? 'Choose' : 'Text'));
  const openField = (f: Field) => {
    setEditing(f);
    setDraft(f.kind === 'signature' ? signature ?? { method: 'typed', name: view.name, style: 'flowing' }
      : f.kind === 'initials' ? initials ?? { method: 'typed', name: initialsOf(view.name), style: 'flowing' }
      : values[f.id] ?? '');
  };

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
        {!view.codeExpiresAt ? <div className="ps__verifyActions">
          <button type="button" className="ps__btn ps__btn--primary" disabled={busy || Boolean(view.codeRequestAvailableAt)} onClick={() => void act(async () => { await call(`${base}/code`, { method: 'POST', body: '{}' }); await load(null); })}>{view.verifyBy === 'sms' ? 'Text me a code' : view.verifyBy === 'email_and_sms' ? 'Send my codes' : 'Email me a code'}</button>
          {view.codeRequestAvailableAt && <p className="ps__muted" role="status">You can request another code after {new Date(view.codeRequestAvailableAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>}
        </div>
          : <form className="ps__verifyForm" onSubmit={(e) => { e.preventDefault(); void act(async () => { const r = await call<{ session: string }>(`${base}/verify`, { method: 'POST', body: JSON.stringify({ code, smsCode: smsCode || undefined }) }); try { sessionStorage.setItem(KEY(token), r.session); } catch { /* private window */ } setSession(r.session); await load(r.session); }); }}>
            <p className="ps__muted ps__codeHelp">The code is on its way. You can leave to check your email and return here.</p>
            <CodeInput id="ps-code" label={view.verifyBy === 'sms' ? 'Code from the text message' : 'Code from the email'} value={code} onChange={setCode} autoFocus />
            {view.verifyBy === 'email_and_sms' && <CodeInput id="ps-sms-code" label="Code from the text message" value={smsCode} onChange={setSmsCode} />}
            <div className="ps__verifyActions"><button type="submit" className="ps__btn ps__btn--primary" disabled={busy || code.length !== 6 || (view.verifyBy === 'email_and_sms' && smsCode.length !== 6)}>{busy ? 'Checking…' : 'Verify and continue'}</button>
              <button type="button" className="ps__btn ps__resend" disabled={busy || Boolean(view.codeRequestAvailableAt)} onClick={() => void act(async () => { await call(`${base}/code`, { method: 'POST', body: '{}' }); setCode(''); setSmsCode(''); await load(null); setNote('A new code is on its way. Use the latest code.'); })}>Send a new code</button></div>
            <p className="ps__muted ps__codeHelp">This code expires at {new Date(view.codeExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Sending a new one replaces it.</p>
            {view.codeRequestAvailableAt && <p className="ps__muted" role="status">You can request another code after {new Date(view.codeRequestAvailableAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>}
            {busy && <p className="ps__muted" role="status">Checking your code. You can leave this page open while it finishes.</p>}
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
        {fields.filter((f) => f.kind === 'payment').map((f) => <div className="ps__card" key={`pay-${f.id}`}>
          <h2 style={{ fontSize: 18, margin: '0 0 5px' }}>{f.label || 'Payment Item'}</h2>
          <p className="ps__muted">{f.currency} {((f.amountMinor ?? 0) / 100).toFixed(2)} · {f.currency === 'NGN' ? 'Paystack' : 'Stripe'} secure checkout</p>
          {f.paymentStatus === 'paid' ? <strong className="ps__ok">Payment verified. You can finish signing.</strong> : <div className="ps__row">
            <button type="button" className="ps__btn ps__btn--primary" disabled={busy} onClick={() => void act(async () => { const result = await call<{ status: string; url?: string }>(`${base}/payment`, { method: 'POST', body: '{}', session }); if (result.status === 'paid') { await load(session); return; } if (!result.url) throw new Error('Checkout is unavailable.'); sessionStorage.setItem('patform-sign-resume', token); window.location.assign(result.url); })}>Pay securely</button>
            <button type="button" className="ps__btn" disabled={busy} onClick={() => void act(async () => { const result = await call<{ status: string }>(`${base}/payment-status`, { session }); if (result.status === 'paid') await load(session); else setNote('Payment is still waiting for confirmation.'); })}>Check payment</button>
          </div>}
        </div>)}
        <div className="ps__card">
          <p style={{ margin: 0 }}>{fields.length ? `Fill the ${fields.length} highlighted box${fields.length === 1 ? '' : 'es'} — tap one to fill it.` : 'Read the document, then sign below.'} Nothing is sent until you press Finish.</p>
          {view.party && <div style={{ marginTop: 12 }}>
            {view.authorityNote && <p className="ps__muted">The sender recorded this authority: {view.authorityNote}</p>}
            <label className="ps__row"><input type="checkbox" checked={authority} onChange={(e) => setAuthority(e.target.checked)} /> {view.authorityText}</label>
          </div>}
          {needsSignature && <div style={{ marginTop: 12 }}><strong>Your signature</strong><SignatureField id="ps-sig" value={signature ?? undefined} onChange={(v) => setSignature((v as SignatureValue) ?? null)} /></div>}
        </div>
        {view.allowAttachments && <div className="ps__card"><h2 style={{ fontSize: 17, margin: '0 0 5px' }}>Supporting files</h2><p className="ps__muted">Add a PDF or image if the sender needs proof or a supporting document. Each file is checked before you can finish.</p><label className="ps__btn" style={{ display: 'inline-block', cursor: 'pointer' }}>+ Add a file<input type="file" accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg" hidden disabled={busy || (view.attachments?.length ?? 0) >= 5} onChange={(ev) => { const file = ev.target.files?.[0]; ev.target.value = ''; if (!file) return; void act(async () => { if (file.size > 10 * 1024 * 1024) throw new Error('Choose a file of 10 MB or less.'); const response = await call<{ status: string }>(`${base}/attachment`, { method: 'POST', session, body: JSON.stringify({ filename: file.name, contentType: file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : ''), base64: await fileBase64(file) }) }); await load(session); setNote(response.status === 'clean' ? 'File attached.' : 'File attached. Its security check is still running; wait before finishing.'); }); }} /></label><ul className="ps__attachments">{(view.attachments ?? []).map((file) => <li key={file.id}><strong>{file.filename}</strong><small>Recorded with this agreement · {file.sha256.slice(0, 12)}…</small></li>)}</ul></div>}
        {pdfUrl && <div className="ps__card"><strong>Review the document</strong><p className="ps__muted">If the preview is slow on your phone, open the PDF in your device’s viewer, then return here to complete the boxes.</p><a className="ps__documentLink" href={pdfUrl} target="_blank" rel="noopener noreferrer">Open the PDF ↗</a></div>}
        {fields.some((f) => !['payment', 'date', 'name', 'email'].includes(f.kind)) && <div className="ps__card"><strong>Your boxes</strong><div className="ps__fieldList">{fields.filter((f) => !['payment', 'date', 'name', 'email'].includes(f.kind)).map((f) => <button type="button" key={f.id} className="ps__fieldAction" disabled={f.kind === 'company' && !!view.party || f.kind === 'title' && !!view.signerTitle} onClick={() => openField(f)}><span>{f.label || (f.kind === 'signature' ? 'Signature' : f.kind === 'initials' ? 'Initials' : f.kind)}{f.kind === 'signature' && signature ? <SignatureView value={signature} /> : f.kind === 'initials' && initials ? <SignatureView value={initials} variant="initials" /> : null}</span><small>{filled(f) ? 'Done' : 'Tap to fill'}</small></button>)}</div></div>}
        {pdf ? <PdfPages data={pdf} overlay={(page) => fields.filter((f) => f.page === page).map((f) =>
          <PageBox key={f.id} x={f.x} y={f.y} width={f.width} height={f.height} color={filled(f) ? '#1d6b3a' : '#b26b00'} title={f.label ?? f.kind} onClick={f.kind === 'payment' || f.kind === 'date' || f.kind === 'name' || f.kind === 'email' || (f.kind === 'company' && view.party) || (f.kind === 'title' && view.signerTitle) ? undefined : () => openField(f)}>
            {f.kind === 'signature' && signature?.method === 'drawn' ? <img src={signature.image} alt="Your drawn signature" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : f.kind === 'initials' && initials?.method === 'drawn' ? <img src={initials.image} alt="Your drawn initials" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span>{shown(f)}{f.required && !filled(f) ? ' *' : ''}</span>}
          </PageBox>)} /> : <div className="ps__card" role="status"><p>{pdfError ?? 'Opening the PDF…'}</p>{pdfError && <button type="button" className="ps__btn" onClick={() => setPdfAttempt((attempt) => attempt + 1)}>Try opening it again</button>}</div>}
        <div className="ps__bar">
          <span className="ps__muted">{ready ? 'Ready to finish.' : missing.length ? `${missing.length} box${missing.length === 1 ? '' : 'es'} still to fill` : !signature ? 'Add your signature' : `Confirm you may sign for ${view.party?.name}`}</span>
          <div className="ps__row">
            <button type="button" className="ps__btn" onClick={() => setDeclining(true)}>Decline</button>
            <button type="button" className="ps__btn ps__btn--primary" disabled={!ready || busy} onClick={() => void act(async () => {
              const r = await call<{ completed: boolean; finalizing?: boolean }>(`${base}/sign`, { method: 'POST', session, body: JSON.stringify({ signature, initials: initials ?? undefined, values, authority: view.party ? authority : undefined }) });
              if (window.parent !== window) window.parent.postMessage({ type: 'patform-sign-complete', status: r.completed ? 'completed' : 'signed' }, window.location.origin);
              try { sessionStorage.removeItem(KEY(token)); } catch { /* ignore */ }
              setNote(null); setView(r.completed ? { ...view, stage: 'completed', completedAt: new Date().toISOString() } : { ...view, stage: 'signed', finalizing: r.finalizing });
            })}>Finish</button>
          </div>
        </div>
      </>}

      {view.stage === 'signed' && <div className="ps__card"><h2 className="ps__ok" style={{ fontSize: 18, margin: 0 }}>You have signed</h2><p className="ps__muted">{view.finalizing ? 'Everyone has signed. We are preparing the final copy and will email it when it is ready.' : 'When everyone has signed, we will email you the signed copy.'}</p>{view.finalizing && <button type="button" className="ps__btn" onClick={() => void load(null)}>Check progress</button>}</div>}
      {view.stage === 'completed' && <div className="ps__card"><h2 className="ps__ok" style={{ fontSize: 18, margin: 0 }}>Signed by everyone</h2>
        <p className="ps__muted">Completed {view.completedAt ? new Date(view.completedAt).toLocaleString() : ''}. A copy is also on its way to your email.</p>
        <a className="ps__btn ps__btn--primary" href={`${base}/final`} style={{ display: 'inline-block', textDecoration: 'none', padding: '10px 16px', borderRadius: 10 }}>Download the signed copy</a>
        <p className="ps__muted">Check any copy at <a href="/sign/verify">the verify page</a>.</p></div>}
      {view.stage === 'closed' && <div className="ps__card"><h2 style={{ fontSize: 18, margin: 0 }}>This document is no longer open for signing</h2><p className="ps__muted">It was {view.status}. Contact the sender if you think this is a mistake.</p></div>}
    </main>

    {editing && <div className="ps__sheet" role="dialog" aria-modal="true" aria-label="Fill this box"><div className="ps__sheetBody">
      <h2 style={{ fontSize: 17, marginTop: 0 }}>{editing.kind === 'signature' ? 'Your signature' : editing.kind === 'initials' ? 'Your initials' : editing.label ?? 'Fill in'}</h2>
      {editing.kind === 'signature' || editing.kind === 'initials'
        ? <SignatureField key={editing.id} id="ps-edit" value={draft} onChange={setDraft} variant={editing.kind === 'initials' ? 'initials' : 'signature'} />
        : editing.kind === 'checkbox' ? <label className="ps__row"><input type="checkbox" checked={draft === 'Yes'} onChange={(e) => setDraft(e.target.checked ? 'Yes' : 'No')} />{editing.label ?? 'I confirm'}</label>
        : editing.kind === 'dropdown' ? <select className="ps__input" autoFocus value={String(draft ?? '')} onChange={(e) => setDraft(e.target.value)}><option value="">Choose an option</option>{editing.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select>
        : editing.kind === 'radio' ? <div className="ps__choices">{editing.choices.map((choice) => <label key={choice} className="ps__row"><input type="radio" name="ps-field-choice" checked={draft === choice} onChange={() => setDraft(choice)} />{choice}</label>)}</div>
        : <input className="ps__input" autoFocus maxLength={editing.kind === 'company' ? 160 : editing.kind === 'title' ? 120 : 500} value={String(draft ?? '')} onChange={(e) => setDraft(e.target.value)} />}
      <div className="ps__row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button type="button" className="ps__btn" onClick={() => setEditing(null)}>Cancel</button>
        <button type="button" className="ps__btn ps__btn--primary" disabled={(editing.kind === 'signature' || editing.kind === 'initials') && !isSignature(draft)} onClick={() => {
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
