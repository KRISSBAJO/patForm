/**
 * One screenshot of the console, for showing a change rather than describing
 * it. Uses the same seeded dev account as the accessibility scan.
 *
 *   node scripts/shot.mjs <out.png> [nav item]
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:3210';
const EMAIL = process.env.A11Y_EMAIL ?? 'joy@example.test';
const PASSWORD = process.env.A11Y_PASSWORD ?? 'patform-dev-password';
const out = process.argv[2] ?? 'output/console.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
await page.fill('input[type=email]', EMAIL);
await page.fill('input[type=password]', PASSWORD);
await page.click('button[type=submit]');
await page.waitForTimeout(4500);

const nav = process.argv[3];
if (nav) {
  await page.locator('button', { hasText: new RegExp(`^${nav}`, 'i') }).first().click();
  await page.waitForTimeout(2500);
}

await page.screenshot({ path: out });
await browser.close();
console.log(out);
