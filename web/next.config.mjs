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
};

export default nextConfig;
