'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import './share-form.css';

/**
 * The ways a form link travels beyond copy and paste.
 *
 * A link on its own suits an email. A notice board wants a QR code and a
 * poster; an organisation's own website wants the form inside a page; and
 * the commonest of all, "send it to the volunteers", wants a mail with the
 * link already in it. Each is made here in the browser from the link alone,
 * so nothing is stored and nothing is sent: the mail opens in the person's
 * own mail program, addressed by them.
 */
export function ShareForm({ url, name, collapsed = false }: { url: string; name: string; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<'embed' | null>(null);

  useEffect(() => {
    if (!open || !url) return;
    let live = true;
    QRCode.toDataURL(url, { width: 512, margin: 1, errorCorrectionLevel: 'M' })
      .then((data) => { if (live) setQr(data); })
      .catch(() => { if (live) setQr(null); });
    return () => { live = false; };
  }, [url, open]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(t);
  }, [copied]);

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'form';
  const embed = `<iframe src="${url}" title="${escapeHtml(name)}" style="width:100%;min-height:900px;border:0" loading="lazy"></iframe>`;
  const mail = `mailto:?subject=${encodeURIComponent(name)}&body=${encodeURIComponent(`Please fill in "${name}" here:\n\n${url}\n\nIt takes a few minutes and you do not need an account.\n`)}`;

  /*
   * A poster is its own small page: the name, the code, the link, and a
   * line saying what to do. Opened in a new window so the print dialog
   * sees only that, rather than the console around it.
   */
  const poster = () => {
    if (!qr) return;
    const w = window.open('', '_blank', 'width=720,height=960');
    if (!w) return;
    w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(name)}</title>
<style>
  @page { margin: 18mm; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; display: grid; min-height: 100vh; place-items: center; text-align: center; }
  main { max-width: 560px; }
  h1 { font-size: 34px; letter-spacing: -0.02em; margin: 0 0 6px; }
  p.lead { font-size: 18px; color: #444; margin: 0 0 28px; }
  img { width: 320px; height: 320px; }
  p.url { font-size: 15px; word-break: break-all; margin: 24px 0 0; color: #333; }
  p.foot { font-size: 12px; color: #777; margin-top: 36px; }
  @media print { p.foot { display: none; } }
</style></head>
<body onload="setTimeout(function(){window.print()},150)"><main>
  <h1>${escapeHtml(name)}</h1>
  <p class="lead">Scan the code with your phone's camera to open the form.</p>
  <img src="${qr}" alt="QR code for ${escapeHtml(url)}">
  <p class="url">${escapeHtml(url)}</p>
  <p class="foot">Close this window when you have printed it.</p>
</main></body></html>`);
    w.document.close();
  };

  if (!url) return null;

  return (
    <div className="sf">
      {collapsed && (
        <button type="button" className="sf__toggle" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h2v2h-2zM15 15h2v2h-2zM12 15h1M16 12h1" />
          </svg>
          {open ? 'Fewer ways to share' : 'More ways to share: QR code, poster, embed, email'}
        </button>
      )}
      {open && (
        <div className="sf__grid">
          <section className="sf__card" aria-labelledby={`sf-qr-${slug}`}>
            <h3 id={`sf-qr-${slug}`}>On paper</h3>
            <p>A QR code for a notice board, a leaflet or a slide.</p>
            <div className="sf__qr">
              {qr ? <img src={qr} alt={`QR code that opens ${name}`} width={144} height={144} /> : <span className="sf__qrWait" aria-hidden="true" />}
            </div>
            <div className="sf__actions">
              <button type="button" className="sf__btn sf__btn--primary" onClick={poster} disabled={!qr}>Print a poster</button>
              {qr && <a className="sf__btn" href={qr} download={`${slug}-qr.png`}>Download the code</a>}
            </div>
          </section>

          <section className="sf__card" aria-labelledby={`sf-embed-${slug}`}>
            <h3 id={`sf-embed-${slug}`}>On your website</h3>
            <p>Paste this where the form should appear. It fills the width of whatever holds it.</p>
            <label className="sf__srOnly" htmlFor={`sf-embed-code-${slug}`}>Embed code</label>
            <textarea id={`sf-embed-code-${slug}`} className="sf__code" readOnly rows={4} value={embed} onFocus={(e) => e.currentTarget.select()} />
            <div className="sf__actions">
              <button
                type="button"
                className="sf__btn sf__btn--primary"
                onClick={() => { void navigator.clipboard?.writeText(embed).then(() => setCopied('embed')); }}
              >
                {copied === 'embed' ? 'Copied' : 'Copy the code'}
              </button>
              <span className="sf__status" role="status">{copied === 'embed' ? 'Embed code copied.' : ''}</span>
            </div>
          </section>

          <section className="sf__card" aria-labelledby={`sf-mail-${slug}`}>
            <h3 id={`sf-mail-${slug}`}>By email</h3>
            <p>Opens a new message in your own mail program with the link already written in. You choose who gets it.</p>
            <div className="sf__actions">
              <a className="sf__btn sf__btn--primary" href={mail}>Write the email</a>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
