/**
 * A screen-reader session on the public form, recorded.
 *
 * Runs the form in a headed Chromium while NVDA is running on this machine,
 * moves through it the way a keyboard user does (Tab, arrows, Enter), and
 * merges NVDA's own speech log with the steps taken into one transcript.
 * What comes out is what NVDA said at each step — not what the markup
 * promised, which is all the automated scan can check.
 *
 * NVDA must be started with speech logged, for example:
 *   nvda.exe -f C:\path\nvda-session.log -l 10
 *
 * Then:
 *   node scripts/screen-reader-session.mjs <form url> <nvda log> [out.md]
 *
 * The Chromium window has to be the foreground window for NVDA to follow it;
 * the script brings it forward at each step, but a hand on the mouse beats it.
 * Arrow-key reading in NVDA's browse mode cannot be driven this way (NVDA
 * intercepts real keyboards, not the browser's synthetic input), so this is a
 * focus-order session: what is said as focus moves, what is announced when a
 * check fails, when a page changes, and when the form is done.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execSync } from 'node:child_process';

const [url, nvdaLog, out = 'output/screen-reader-transcript.md'] = process.argv.slice(2);
if (!url || !nvdaLog) throw new Error('usage: node scripts/screen-reader-session.mjs <form url> <nvda log> [out.md]');
if (!existsSync(nvdaLog)) throw new Error(`NVDA log not found: ${nvdaLog}. Start NVDA with -f <log> -l 10 first.`);

const steps = [];
const step = (what) => { steps.push({ at: new Date(), what }); console.log(`  ${new Date().toLocaleTimeString()}  ${what}`); };
const activate = () => {
  if (process.platform !== 'win32') return;
  try { execSync(`powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate('Chromium') | Out-Null"`, { stdio: 'ignore', timeout: 5000 }); } catch { /* best effort */ }
};

const started = new Date();
const browser = await chromium.launch({ headless: false, args: ['--force-renderer-accessibility', '--window-size=1200,900', '--window-position=40,40'] });
const page = await browser.newPage({ viewport: { width: 1160, height: 800 } });
const settle = (ms = 1800) => page.waitForTimeout(ms);
const front = async () => { await page.bringToFront(); activate(); };

await page.goto(url, { waitUntil: 'networkidle' });
await front();
await settle(3000);
step('Form loaded');

const tab = async (n = 1) => { for (let i = 0; i < n; i++) { await front(); await page.keyboard.press('Tab'); step('Tab'); await settle(1500); } };
const press = async (key, what) => { await front(); await page.keyboard.press(key); step(`${key}: ${what}`); await settle(2600); };
const type = async (text) => { await front(); await page.keyboard.type(text, { delay: 40 }); step(`Typed "${text}"`); await settle(1200); };

// Page 1: reach the first field, the second, the Continue button.
await tab(3);
await press('Enter', 'Continue with nothing filled in');
await type('Ada Test');
await tab(1);
await type('ada@example.test');
await tab(1);
await press('Enter', 'Continue to the next page');

// Page 2: every control in order, choosing with the arrows where there is a choice.
await tab(1);
await press('ArrowDown', 'pick the first option of the list');
await tab(9);
await press('ArrowDown', 'move between the choices');
await tab(4);
await press('Enter', 'Submit with answers missing');
await settle(1500);

const finished = new Date();
await browser.close();

// ---- merge NVDA's speech with the steps
const log = readFileSync(nvdaLog, 'utf8').split(/\r?\n/);
const speech = [];
for (let i = 0; i < log.length - 1; i++) {
  const head = /speech\.speech\.speak \((\d\d):(\d\d):(\d\d)\.(\d+)\)/.exec(log[i]);
  if (!head || !log[i + 1].startsWith('Speaking [')) continue;
  const at = new Date(started);
  at.setHours(Number(head[1]), Number(head[2]), Number(head[3]), Number(head[4]));
  if (at < started || at > finished) continue;
  const said = [...log[i + 1].matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1] ?? m[2])
    .filter((s) => !/^(en_US|say-all:lineReached)$/.test(s))
    .join(' ');
  if (said.trim()) speech.push({ at, said });
}

const events = [...steps.map((s) => ({ ...s, kind: 'step' })), ...speech.map((s) => ({ at: s.at, what: s.said, kind: 'said' }))]
  .sort((a, b) => a.at - b.at);
const t = (d) => d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
const lines = [
  `# Screen-reader session: ${url}`,
  '',
  `NVDA, ${started.toISOString()} to ${finished.toISOString()}. Steps in bold; everything else is what NVDA said.`,
  '',
  ...events.map((e) => (e.kind === 'step' ? `- **${t(e.at)} ${e.what}**` : `  - ${t(e.at)} ${e.what}`)),
  '',
];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n'));
console.log(`\n${speech.length} phrases spoken across ${steps.length} steps. Transcript: ${out}`);
