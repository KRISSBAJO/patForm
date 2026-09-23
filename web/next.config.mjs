import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The repo root has its own lockfile for the compiler and runtime packages,
  // so Next has to be told which one is this app's.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  /*
   * A production build writes somewhere else.
   *
   * `next build` and `next dev` both own `.next` by default, so building while
   * the dev server is up replaces the chunks it has open and every request
   * after that is "Cannot find module './873.js'". That is not a subtle
   * failure but it is a confusing one: the page it serves has no <title> and
   * no lang, so the accessibility gate reports two serious violations on four
   * pages and the cause looks like the last thing that was edited.
   *
   * Four times in one session before it was worth fixing.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',

  /*
   * No other site may put these pages in a frame.
   *
   * The consent screen above all: framed invisibly under something the
   * visitor means to click, "Allow" is a click they never chose to make. The
   * console and the builder have buttons with the same property — confirm a
   * bulk action, publish a process — so they get the same header. Public
   * forms are left framable, because embedding a form on an organisation's
   * own site is what some of them will want.
   */
  async headers() {
    const noFraming = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    ];
    return [
      { source: '/oauth/:path*', headers: [...noFraming, { key: 'Referrer-Policy', value: 'no-referrer' }] },
      { source: '/console', headers: noFraming },
      { source: '/console/:path*', headers: noFraming },
      { source: '/builder', headers: noFraming },
      { source: '/builder/:path*', headers: noFraming },
    ];
  },
};

export default nextConfig;
