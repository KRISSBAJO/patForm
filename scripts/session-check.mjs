/**
 * Does a session survive a reload?
 *
 * Reported as a bug and reproduced here rather than argued about: sign in, read
 * the session, reload the page, read it again. A cookie that works on the
 * response that set it and not on the next request is the whole failure.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:3210';
const EMAIL = process.env.A11Y_EMAIL ?? 'joy@example.test';
const PASSWORD = process.env.A11Y_PASSWORD ?? 'patform-dev-password';

const browser = await chromium.launch();
const page = await browser.newPage();

await page.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
await page.fill('input[type=email]', EMAIL);
await page.fill('input[type=password]', PASSWORD);
await page.click('button[type=submit]');
await page.waitForTimeout(4000);

const cookiesAfterLogin = await page.context().cookies();
const jar = cookiesAfterLogin.map((c) => ({
  name: c.name,
  domain: c.domain,
  path: c.path,
  httpOnly: c.httpOnly,
  sameSite: c.sameSite,
  expires: c.expires,
  session: c.expires === -1,
}));

const before = await page.evaluate(async () => {
  const r = await fetch('/api/session', { credentials: 'same-origin' });
  return r.status;
});

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const after = await page.evaluate(async () => {
  const r = await fetch('/api/session', { credentials: 'same-origin' });
  return r.status;
});

const signedInAfterReload = (await page.locator('text=Sign in to the console').count()) === 0;

console.log(
  JSON.stringify({ jar, sessionBeforeReload: before, sessionAfterReload: after, signedInAfterReload }, null, 2),
);

await browser.close();
process.exit(after === 200 && signedInAfterReload ? 0 : 1);
