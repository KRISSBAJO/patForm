import { NextResponse, type NextRequest } from 'next/server';

const API = process.env.API_URL ?? 'http://localhost:3310';

export async function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set('Referrer-Policy', 'no-referrer');
  const embed = request.nextUrl.searchParams.get('embed');
  if (embed && /^[A-Za-z0-9_-]{30,60}$/.test(embed)) {
    try {
      const resolved = await fetch(`${API}/api/sign/embed/${embed}`, { cache: 'no-store' });
      if (resolved.ok) {
        const { signingPath, origin } = await resolved.json() as { signingPath: string; origin: string };
        if (signingPath === request.nextUrl.pathname && /^https?:\/\/[^/\s]+$/.test(origin)) {
          response.headers.set('Content-Security-Policy', `frame-ancestors 'self' ${origin}`);
          return response;
        }
      }
    } catch { /* deny framing when the embed cannot be verified */ }
  }
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  return response;
}

export const config = { matcher: ['/sign/:token'] };
