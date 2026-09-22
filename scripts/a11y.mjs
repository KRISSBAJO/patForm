/**
 * The accessibility check, as something that can be re-run.
 *
 * §20.2's gate names four flows, and an audit done once by hand is a claim
 * about a Tuesday. This drives a real browser through each of them and runs
 * axe-core against the WCAG 2.2 AA rule set.
 *
 * It is honest about its own reach. axe finds roughly a third of WCAG issues,
 * and the three that mattered most here — a focus ring invisible on the dark
 * sidebar, dialogs that claimed `aria-modal` and trapped nothing, and errors no
 * screen reader was ever told about — were all in the other two thirds. Those
 * are recorded in docs/accessibility.md and were found by reading. This catches
 * regressions in the part a machine can see, which is worth having and is not
 * the whole gate.
 *
 *   node scripts/a11y.mjs            against http://localhost:3210
 *   BASE=... node scripts/a11y.mjs   somewhere else
 *
 * The account pages need live single-use tokens, so this mints them first and
 * puts the scan account's verification back afterwards. A token that has
 * already been spent renders a different and much simpler screen than the one
 * anybody actually sees, so auditing a stale link would prove nothing.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE ?? 'http://localhost:3210';
const EMAIL = process.env.A11Y_EMAIL ?? 'joy@example.test';
const PASSWORD = process.env.A11Y_PASSWORD ?? 'patform-dev-password';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

async function audit(page, name) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(
    (tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags } }),
    TAGS,
  );
  const violations = result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.length,
    where: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
  }));

  const mark = violations.length ? `${RED}FAIL${OFF}` : `${GREEN}pass${OFF}`;
  console.log(`\n  ${mark}  ${BOLD}${name}${OFF}`);
  for (const v of violations) {
    console.log(`        ${RED}${v.id}${OFF} (${v.impact}) x${v.nodes} - ${v.help}`);
    for (const w of v.where) console.log(`          ${DIM}${w}${OFF}`);
  }
  return violations;
}

/** Mints live tokens and clears the scan account's verification. */
function fixtures(mode) {
  const out = execFileSync(
    'node',
    ['--env-file=.env', 'node_modules/tsx/dist/cli.mjs', 'scripts/account-fixtures.ts', ...(mode ? [mode] : [])],
    { encoding: 'utf8' },
  );
  const last = out.replace(/\r/g, '').trim().split('\n').pop();
  return mode ? null : JSON.parse(last);
}

async function main() {
  const links = fixtures();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const all = [];

  console.log(`\n${BOLD}Accessibility${OFF} ${DIM}- ${BASE}, axe-core, WCAG 2.2 AA${OFF}`);

  // ---- the front door. Nothing on it reached the application until now, so
  //      it had never been audited as part of a flow anybody completes.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  all.push(...(await audit(page, 'Landing page')));

  // The narrow-screen menu is the only navigation below 900px, and it is
  // rendered rather than hidden, so it has to be audited open.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const burger = page.locator('.nav__menu').first();
  if (await burger.count()) {
    await burger.click();
    await page.waitForTimeout(500);
    all.push(...(await audit(page, 'Landing page, narrow-screen menu open')));
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
  all.push(...(await audit(page, 'Create a workspace')));

  // ---- the pages the footer links to. They existed only as markdown in the
  //      repository until the footer stopped pointing at a marketing anchor.
  for (const [name, path] of [
    ['Security', '/security'],
    ['Privacy', '/privacy'],
    ['Subprocessors', '/subprocessors'],
    ['Developers', '/developers'],
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    all.push(...(await audit(page, name)));
  }

  // ---- respondent, including the state a form spends most of its life in
  await page.goto(`${BASE}/f/employee_onboarding`, { waitUntil: 'networkidle' });
  all.push(...(await audit(page, 'Respondent form')));

  const next = page.locator('button', { hasText: /continue|next|submit/i }).first();
  if (await next.count()) {
    await next.click();
    await page.waitForTimeout(1500);
    all.push(...(await audit(page, 'Respondent form, showing validation errors')));
  }

  // ---- console: sign-in, operator queue, approvals, ask
  await page.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
  all.push(...(await audit(page, 'Console sign-in')));

  // ---- account recovery: three pages an emailed link lands on, plus the
  //      state the sign-in card enters when somebody has lost their password.
  const forgot = page.locator('button', { hasText: /Forgotten your password/i }).first();
  if (await forgot.count()) {
    await forgot.click();
    await page.waitForTimeout(500);
    all.push(...(await audit(page, 'Reset your password')));

    // The confirmation is its own screen, and the one most likely to be
    // rendered without being announced.
    await page.fill('#forgot-email', 'nobody@example.test');
    await page.click('button[type=submit]');
    await page.waitForTimeout(2500);
    all.push(...(await audit(page, 'Reset link sent')));
  }

  for (const [name, path] of [
    ['Invitation, join a workspace', `/join/${links.join}`],
    ['Email verification', `/verify/${links.verify}`],
    ['Choose a new password', `/reset/${links.reset}`],
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    all.push(...(await audit(page, name)));
  }

  await page.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForTimeout(4000);
  // The fixtures cleared this account's verification, so the banner is on
  // screen for this audit — it is a live region on a coloured surface and is
  // exactly the kind of thing that passes review and fails a contrast check.
  all.push(...(await audit(page, 'Operator queue, with the unverified-address banner')));

  const openRecord = page.locator('button', { hasText: /^Open$/ }).first();
  if (await openRecord.count()) {
    await openRecord.click();
    await page.waitForTimeout(2000);
    all.push(...(await audit(page, 'Record panel')));
  }

  const health = page.locator('button', { hasText: /^Automation health/ }).first();
  if (await health.count()) {
    await health.click();
    await page.waitForTimeout(2000);
    all.push(...(await audit(page, 'Automation health and the suppression list')));
  }

  // The two views that answer "how do records arrive" and "how do people get
  // in". Both existed as endpoints with nothing calling them.
  for (const [name, label] of [
    ['Processes and forms', 'Processes & forms'],
    ['People, with the invitation form', 'People'],
  ]) {
    const item = page.locator('button', { hasText: new RegExp(`^${label.replace('&', '&')}`) }).first();
    if (await item.count()) {
      await item.click();
      await page.waitForTimeout(2000);
      all.push(...(await audit(page, name)));
    }
  }

  for (const [name, label] of [
    ['Integrations', 'Integrations'],
    ['Import and data', 'Import & data'],
  ]) {
    const item = page.locator('button', { hasText: new RegExp(`^${label}`) }).first();
    if (await item.count()) {
      await item.click();
      await page.waitForTimeout(2500);
      all.push(...(await audit(page, name)));
    }
  }

  // The OAuth consent screen, which an application sends somebody to. It had
  // no page at all until the authorize route was wired.
  await page.goto(
    `${BASE}/authorize?client_id=demo&redirect_uri=https%3A%2F%2Fexample.test%2Fcb&scope=view%20report&code_challenge=abc&state=s1`,
    { waitUntil: 'networkidle' },
  );
  all.push(...(await audit(page, 'Allow an application')));
  await page.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const account = page.locator('button', { hasText: /^Your account$/ }).first();
  if (await account.count()) {
    await account.click();
    await page.waitForTimeout(1500);
    all.push(...(await audit(page, 'Your account, two-step verification off')));

    // Mid-enrolment: the secret, the link and the code field. The same markup
    // the sign-in second step uses, so auditing it covers both.
    const setUp = page.locator('button', { hasText: /^Set it up$/ }).first();
    if (await setUp.count()) {
      await setUp.click();
      await page.waitForTimeout(2000);
      all.push(...(await audit(page, 'Setting up two-step verification')));
    }
  }

  const ask = page.locator('button', { hasText: /^Ask$/ }).first();
  if (await ask.count()) {
    await ask.click();
    await page.waitForTimeout(1500);
    all.push(...(await audit(page, 'Ask')));
  }

  // ---- the pack catalogue, as a page. Fifty-eight cards, a search and a
  //      filter: exactly the kind of screen where a control loses its label.
  await page.goto(`${BASE}/builder/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  all.push(...(await audit(page, 'The pack catalogue')));

  // The whole preview is the control now, so it is selected by class rather
  // than by text — its text includes the miniature's field labels.
  const view = page.locator('.pk__preview').first();
  if (await view.count()) {
    await view.click();
    await page.waitForTimeout(800);
    all.push(...(await audit(page, 'What is inside a pack')));
    await page.keyboard.press('Escape');
  }

  // ---- builder, and one of its dialogs
  await page.goto(`${BASE}/builder`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const processButton = page.locator('button', { hasText: /Employee Onboarding/ }).first();
  if (await processButton.count()) {
    await processButton.click();
    await page.waitForTimeout(3000);
  }
  all.push(...(await audit(page, 'Builder')));

  const publish = page.locator('button', { hasText: /Publish/ }).first();
  if (await publish.count()) {
    await publish.click();
    await page.waitForTimeout(3000);
    if (await page.locator('[role=dialog]').count()) {
      /*
       * Focus first, then axe.
       *
       * axe moves focus while it runs — it has to, to evaluate some rules —
       * and restores it to the document rather than to where it was. Auditing
       * before checking focus made the dialog look like it had lost focus when
       * the checker was what took it.
       */
      const keyboard = await page.evaluate(() => {
        const dialog = document.querySelector('[role=dialog]');
        const box = dialog.querySelector('[tabindex="-1"]');
        return {
          labelled: Boolean(dialog.getAttribute('aria-labelledby')),
          focusInside: dialog.contains(document.activeElement),
          focusedTheBox: document.activeElement === box,
          activeElement: document.activeElement
            ? `${document.activeElement.tagName}.${document.activeElement.className || '(none)'}`
            : 'null',
          boxExists: Boolean(box),
          hasFocusFlag: document.hasFocus(),
        };
      });
      all.push(...(await audit(page, 'Builder publish dialog')));

      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      const closed = (await page.locator('[role=dialog]').count()) === 0;

      const ok = keyboard.labelled && keyboard.focusInside && closed;
      console.log(`\n  ${ok ? `${GREEN}pass${OFF}` : `${RED}FAIL${OFF}`}  ${BOLD}Dialog keyboard behaviour${OFF}`);
      console.log(
        `        ${DIM}labelled ${keyboard.labelled}, focus moved in ${keyboard.focusInside}, Escape closed ${closed}${OFF}`,
      );
      if (!keyboard.focusInside) console.log(
        `        ${DIM}activeElement ${keyboard.activeElement}, box present ${keyboard.boxExists}, document focused ${keyboard.hasFocusFlag}${OFF}`,
      );
      if (!ok) all.push({ id: 'dialog-keyboard', impact: 'serious' });
    }
  }

  await browser.close();
  fixtures('restore');

  console.log(
    all.length
      ? `\n${RED}${all.length} violation(s). WCAG 2.2 AA not met.${OFF}\n`
      : `\n${GREEN}No automated violations across the four flows in the gate.${OFF}\n`,
  );
  console.log(`${DIM}axe finds about a third of WCAG issues. The rest is in docs/accessibility.md.${OFF}\n`);
  process.exit(all.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${RED}${err.message}${OFF}\n`);
  process.exit(1);
});
