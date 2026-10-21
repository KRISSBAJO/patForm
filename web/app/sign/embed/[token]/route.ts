const API = process.env.API_URL ?? 'http://localhost:3310';

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const res = await fetch(`${API}/api/sign/embed/${encodeURIComponent(token)}`, { cache: 'no-store' });
  if (!res.ok) return new Response('<!doctype html><title>Signing link expired</title><p>This embedded signing link is no longer available. Ask the sender for a new one.</p>', {
    status: 410, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
  });
  const { signingPath, origin } = await res.json() as { signingPath: string; origin: string };
  if (!/^\/sign\/[A-Za-z0-9_-]{30,60}$/.test(signingPath) || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin) && !/^http:\/\/localhost(?::\d+)?$/.test(origin)) return new Response('Invalid embed session', { status: 500 });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Patform Sign</title><style>html,body{margin:0;width:100%;height:100%;background:#f7f8f5}iframe{border:0;width:100%;height:100%}</style></head><body><iframe title="Sign the agreement" src="${signingPath}?embed=${encodeURIComponent(token)}" allow="clipboard-write"></iframe><script>const frame=document.querySelector('iframe');window.addEventListener('message',function(event){if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.type!=='patform-sign-complete')return;window.parent.postMessage({type:'patform-sign-complete',status:event.data.status},${JSON.stringify(origin)});});</script></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': `default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors ${origin}` } });
}

export const dynamic = 'force-dynamic';
