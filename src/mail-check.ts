/**
 * Can this deployment send mail as who it says it is?
 *
 *   npm run mail:check
 *
 * Reads the environment, resolves the DNS a receiving server would resolve,
 * and says what is missing. It sends nothing and needs no credentials beyond
 * what is already set — so it is safe to run against production before
 * anybody's first real message.
 */

import { emailProviderFromEnv, mailFrom } from './runtime/email.js';
import { checkSendingDomain, domainOf } from './runtime/sending-domain.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

async function main(): Promise<void> {
  let providerName: string;
  try {
    providerName = emailProviderFromEnv().name;
  } catch (err) {
    console.error(`\n  ${RED}${err instanceof Error ? err.message : String(err)}${OFF}\n`);
    process.exit(1);
    return;
  }

  const from = mailFrom('Patform');
  console.log(`\n  ${BOLD}Sending domain${OFF}`);
  console.log(`  provider   ${providerName}`);
  console.log(`  from       ${from}\n`);

  if (providerName === 'console') {
    console.log(
      `  ${YELLOW}EMAIL_PROVIDER is not set, so nothing leaves this machine.${OFF}\n` +
        `  ${DIM}Every message is written to the log and the delivery status is "queued".${OFF}\n` +
        `  ${DIM}The checks below still run, so the DNS can be fixed before it matters.${OFF}\n`,
    );
  }

  const findings = await checkSendingDomain(from);
  let blocking = 0;
  let unknown = 0;

  for (const f of findings) {
    /*
     * Three marks, not two. "Could not ask" is not "missing", and a tool that
     * conflates them sends somebody to add a record that is already there.
     */
    const mark =
      f.outcome === 'ok'
        ? `${GREEN}ok  ${OFF}`
        : f.outcome === 'unknown'
          ? `${YELLOW}? ${OFF}  `
          : f.required
            ? `${RED}FAIL${OFF}`
            : `${YELLOW}note${OFF}`;
    if (f.outcome === 'missing' && f.required) blocking++;
    if (f.outcome === 'unknown' && f.required) unknown++;
    console.log(`  ${mark}  ${BOLD}${f.check}${OFF}`);
    console.log(`        ${DIM}${f.detail}${OFF}`);
  }

  const domain = domainOf(from);
  if (blocking && domain) {
    /*
     * The records themselves, with the domain filled in. A check that says
     * "SPF is missing" and leaves somebody to search for the syntax has done
     * the easy half.
     *
     * `include:` is deliberately left as a placeholder: every provider has its
     * own, and printing one that happens to be wrong is worse than printing a
     * blank. The provider's console gives you the exact line.
     */
    console.log(`\n  ${BOLD}What to add at ${domain}${OFF}\n`);
    console.log(`  ${DIM}TXT  ${domain}`);
    console.log(`       v=spf1 include:<your provider's sending hosts> -all${OFF}`);
    console.log(`  ${DIM}TXT  _dmarc.${domain}`);
    console.log(`       v=DMARC1; p=none; rua=mailto:dmarc@${domain}${OFF}`);
    console.log(
      `  ${DIM}TXT  <selector>._domainkey.${domain}` +
        `\n       the DKIM key from the provider console${OFF}`,
    );
    console.log(
      `\n  ${DIM}Start DMARC at p=none so nothing is rejected while you watch the reports,` +
        `\n  then tighten to quarantine and reject once they are clean.${OFF}`,
    );
  }

  if (blocking) {
    console.log(
      `\n  ${RED}${blocking} ${blocking === 1 ? 'record a receiving server needs is' : 'records a receiving server needs are'} missing.${OFF}\n`,
    );
    process.exit(1);
  }

  /*
   * Not a pass. Exit 2, so a pipeline can tell "this is wrong" from "I could
   * not find out" — and so this cannot be read as a green light by anything
   * that only checks for zero.
   */
  if (unknown) {
    console.log(
      `\n  ${YELLOW}Could not check.${OFF} ` +
        `${DIM}Run this where DNS resolves. The answer here is not "no records", it is "no answer".${OFF}\n`,
    );
    process.exit(2);
  }

  console.log(
    `\n  ${GREEN}The domain is set up to send.${OFF} ` +
      `${DIM}DKIM still has to be confirmed in the provider console.${OFF}\n`,
  );
}

void main();
