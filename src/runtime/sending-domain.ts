/**
 * Whether this deployment can actually send mail as who it says it is.
 *
 * "A verified sending domain" is mostly DNS, and DNS is not something this
 * repository can add for you. What it *can* do is look: the records either
 * resolve or they do not, and asking is a few milliseconds.
 *
 * The failure this exists for is quiet. `MAIL_FROM` falls back to
 * `no-reply@localhost`, so a deployment that names a provider and forgets the
 * address sends every message from a domain that does not exist. The provider
 * rejects it, or worse accepts it and every recipient's spam filter makes the
 * decision instead — and the delivery log says `queued` either way, because
 * `queued` is what the provider told us.
 *
 * Nothing here talks to a provider. Each one exposes domain verification
 * differently, or not at all, and reporting "verified" off a guessed endpoint
 * that happened to 404 would be worse than reporting nothing.
 */

import { promises as dns } from 'node:dns';

/**
 * `unknown` is not a failure.
 *
 * The first version of this caught every DNS error and returned no records,
 * so a resolver that refused the connection was indistinguishable from a
 * domain with no SPF. Running it here — where `dns.getServers()` is
 * `127.0.0.1` and nothing is listening — reported that google.com has no SPF
 * and no DMARC, which would have sent somebody to add records that already
 * exist.
 *
 * A check that cannot tell "absent" from "could not ask" must say so. It is
 * the same fault this codebase keeps finding in its own work, and it took
 * asking the checker about a domain whose answer I already knew to see it.
 */
export type Outcome = 'ok' | 'missing' | 'unknown';

export interface DomainFinding {
  check: string;
  outcome: Outcome;
  detail: string;
  /** False when this is a recommendation rather than a requirement. */
  required: boolean;
}

/** The address part of `Name <a@b>` or a bare `a@b`. */
export function addressOf(mailFrom: string): string {
  const angled = /<([^>]+)>/.exec(mailFrom);
  return (angled ? angled[1]! : mailFrom).trim();
}

export function domainOf(mailFrom: string): string | null {
  const at = addressOf(mailFrom).lastIndexOf('@');
  if (at < 1) return null;
  const domain = addressOf(mailFrom).slice(at + 1).toLowerCase();
  return domain || null;
}

/**
 * Whether an address could ever receive a reply or pass a provider's checks.
 *
 * Deliberately not a full RFC 5322 parse. The addresses this rejects are the
 * ones a misconfigured deployment actually produces — a default that was never
 * changed, a bare hostname with no dot, an empty variable — rather than the
 * exotic ones a parser exists to argue about.
 */
export function usableFrom(mailFrom: string): { ok: boolean; reason?: string } {
  const address = addressOf(mailFrom);
  const domain = domainOf(mailFrom);

  if (!address || !address.includes('@')) return { ok: false, reason: 'not an email address' };
  if (!domain) return { ok: false, reason: 'no domain after the @' };
  if (domain === 'localhost' || domain.endsWith('.localhost')) {
    return { ok: false, reason: 'localhost is not a domain anybody can deliver to' };
  }
  if (!domain.includes('.')) return { ok: false, reason: `"${domain}" has no top-level domain` };
  if (domain.endsWith('.local') || domain.endsWith('.internal') || domain.endsWith('.test')) {
    return { ok: false, reason: `"${domain}" is a reserved name that resolves nowhere public` };
  }
  return { ok: true };
}

type Lookup<T> = { state: 'found'; records: T[] } | { state: 'none' } | { state: 'unreachable'; why: string };

/*
 * `ENOTFOUND` and `ENODATA` are answers: the resolver was asked and said no.
 * Everything else — a refused connection, a timeout, a SERVFAIL — means the
 * question never got a reply, and the honest report is that we do not know.
 */
const ANSWERED_NO = new Set(['ENOTFOUND', 'ENODATA']);

async function lookup<T>(run: () => Promise<T[]>): Promise<Lookup<T>> {
  try {
    const records = await run();
    return records.length ? { state: 'found', records } : { state: 'none' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (ANSWERED_NO.has(code)) return { state: 'none' };
    return { state: 'unreachable', why: code };
  }
}

async function txt(name: string): Promise<Lookup<string>> {
  return lookup(async () => (await dns.resolveTxt(name)).map((chunks) => chunks.join('')));
}

/**
 * Looks up what a receiving server will look up.
 *
 * SPF and DMARC are published at known names, so they can be checked exactly.
 * DKIM cannot: the record lives at `<selector>._domainkey.<domain>` and the
 * selector is chosen by the provider, so there is no name to ask for without
 * knowing which provider and which key. Said out loud rather than skipped,
 * because a report that lists two of the three reads as though three passed.
 */
export async function checkSendingDomain(mailFrom: string): Promise<DomainFinding[]> {
  const out: DomainFinding[] = [];
  const usable = usableFrom(mailFrom);

  out.push({
    check: 'MAIL_FROM is an address that could deliver',
    outcome: usable.ok ? 'ok' : 'missing',
    detail: usable.ok ? addressOf(mailFrom) : `${addressOf(mailFrom) || '(empty)'} — ${usable.reason}`,
    required: true,
  });
  if (!usable.ok) return out;

  const domain = domainOf(mailFrom)!;

  const [mx, spf, dmarc] = await Promise.all([
    lookup(() => dns.resolveMx(domain)),
    txt(domain),
    txt(`_dmarc.${domain}`),
  ]);

  if (mx.state === 'unreachable') {
    return [
      ...out,
      {
        check: 'DNS',
        outcome: 'unknown',
        detail:
          `could not reach a resolver (${mx.why}) — nothing below could be checked. ` +
          `This machine's resolvers are ${dns.getServers().join(', ') || 'none'}.`,
        required: true,
      },
    ];
  }

  out.push({
    check: `${domain} resolves`,
    outcome: mx.state === 'found' ? 'ok' : 'missing',
    detail:
      mx.state === 'found'
        ? `${mx.records.length} MX ${mx.records.length === 1 ? 'record' : 'records'}`
        : 'no MX records — the domain may not exist, or may not receive mail',
    required: false,
  });

  const record = (l: Lookup<string>, prefix: string) =>
    l.state === 'found' ? l.records.find((r) => r.toLowerCase().startsWith(prefix)) : undefined;

  const spfRecord = record(spf, 'v=spf1');
  out.push({
    check: 'SPF authorises somebody to send as this domain',
    outcome: spf.state === 'unreachable' ? 'unknown' : spfRecord ? 'ok' : 'missing',
    detail:
      spf.state === 'unreachable'
        ? `could not ask (${spf.why})`
        : (spfRecord ?? 'no v=spf1 TXT record at the domain'),
    required: true,
  });

  const dmarcRecord = record(dmarc, 'v=dmarc1');
  out.push({
    check: 'DMARC says what to do when a message fails',
    outcome: dmarc.state === 'unreachable' ? 'unknown' : dmarcRecord ? 'ok' : 'missing',
    detail:
      dmarc.state === 'unreachable'
        ? `could not ask (${dmarc.why})`
        : (dmarcRecord ?? `no v=DMARC1 TXT record at _dmarc.${domain}`),
    required: true,
  });

  out.push({
    check: 'DKIM',
    outcome: 'unknown',
    detail:
      `not checkable from here — the record is at <selector>._domainkey.${domain} ` +
      'and the selector comes from the provider. Verify it in the provider console.',
    required: false,
  });

  return out;
}

/**
 * Refuses to start with a provider that will send from nowhere.
 *
 * The same two-switch reasoning the provider selection already uses: a
 * deployment that believes it is sending and is not is worse than one that
 * will not start. The console provider is exempt because it sends nothing and
 * is the ordinary way to run this locally.
 */
export function assertCanSendAs(providerName: string, mailFrom: string): void {
  if (providerName === 'console') return;
  const usable = usableFrom(mailFrom);
  if (usable.ok) return;
  throw new Error(
    `EMAIL_PROVIDER=${providerName} sends real mail, and MAIL_FROM is "${addressOf(mailFrom) || '(unset)'}" — ${usable.reason}. ` +
      'Set MAIL_FROM to an address on a domain you have verified with the provider.',
  );
}
