/**
 * Same-origin proxy to the console API.
 *
 * The session cookie is HttpOnly and SameSite=Lax. A browser will not send a
 * Lax cookie on a cross-site fetch, so the console calling `localhost:3310`
 * directly would authenticate on the login response and then be signed out on
 * every request after it. Proxying through the app makes the API same-origin,
 * which is also how it would be deployed: one hostname, the API behind a path.
 *
 * SameSite=Lax is the point, not an obstacle — loosening it to None to avoid
 * this proxy would make the cookie ridable from any site.
 */
const API = process.env.API_URL ?? 'http://localhost:3310';

async function forward(req: Request, path: string[]): Promise<Response> {
  const incoming = new URL(req.url);
  const target = `${API}/api/${path.join('/')}${incoming.search}`;

  const headers = new Headers();
  const cookie = req.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  const contentType = req.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  const agent = req.headers.get('user-agent');
  if (agent) headers.set('user-agent', agent);

  const res = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
    redirect: 'manual',
  });

  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    return new Response(null, { status: res.status, headers: { location: res.headers.get('location')!, 'cache-control': 'no-store' } });
  }

  const out = new Headers({ 'content-type': 'application/json' });
  // getSetCookie keeps multiple Set-Cookie headers separate; joining them
  // would corrupt cookies whose values contain a comma.
  for (const value of res.headers.getSetCookie?.() ?? []) out.append('set-cookie', value);

  return new Response(await res.text(), { status: res.status, headers: out });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}

export async function POST(req: Request, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}

export const dynamic = 'force-dynamic';
