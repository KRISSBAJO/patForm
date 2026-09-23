/**
 * Delivering email.
 *
 * §6.6 asks for a delivery log that distinguishes queued, sent, delivered
 * where supported, bounced, complained and failed. Until now `email_log`
 * recorded what *would* have been sent, which is a different and much weaker
 * claim than the console was making.
 *
 * ADR-0002 named the one thing that has to be right here: these effects are
 * the only ones that leave the database, so the idempotency ledger cannot
 * protect them on its own. Every provider below is handed `action_run.id` as
 * its own idempotency key, so a retry that reaches the provider is deduplicated
 * on their side too. Without that, "actions run once" stops being true at
 * exactly the boundary where it matters most.
 */

import { smtpFromEnv } from './smtp.js';
import { assertCanSendAs } from './sending-domain.js';

export interface Attachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface OutgoingEmail {
  from: string;
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Attachment[];
  /** `action_run.id`. Carried to the provider so a retry is deduplicated there. */
  idempotencyKey: string;
  tags?: Record<string, string>;
}

export interface DeliveryResult {
  /** What the provider calls it, for reconciling a webhook later. */
  providerMessageId: string | null;
  status: 'queued' | 'sent' | 'failed';
  detail?: string;
  /**
   * Whether trying again could work.
   *
   * This decides whether the failure is thrown or recorded. A 5xx or a dropped
   * connection is thrown, so the outbox retries with backoff. A 4xx — a
   * malformed address, an unverified sending domain, a suppressed recipient —
   * will fail identically forever, so it is written down and committed
   * instead. Retrying it would bury the real problem under attempt counts.
   */
  retryable?: boolean;
  /**
   * Something the operator should know about a send that otherwise succeeded.
   *
   * The case this exists for is a partially suppressed message: the send is
   * real, some of the intended recipients were dropped, and neither `status`
   * nor `failure` has anywhere to put that. Without it the record shows a
   * reminder sent to three people when two of them were never going to get it.
   */
  warning?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(email: OutgoingEmail): Promise<DeliveryResult>;
}

/**
 * Domains that are reserved never to receive mail (RFC 2606, RFC 6761), and
 * the three example domains, which publish a null MX (RFC 7505).
 */
const RESERVED_SUFFIXES = ['.test', '.example', '.invalid', '.localhost'];
const RESERVED_EXACT = new Set(['localhost', 'example.com', 'example.net', 'example.org']);

export function isReservedAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
  if (RESERVED_EXACT.has(domain)) return true;
  for (const exact of RESERVED_EXACT) if (domain.endsWith(`.${exact}`)) return true;
  return RESERVED_SUFFIXES.some((suffix) => domain.endsWith(suffix) || domain === suffix.slice(1));
}

/**
 * Keeps addresses that cannot receive mail away from a provider that will try.
 *
 * Every seed, proof, demo and test in this repository uses `example.test`
 * addresses, deliberately, so they can never reach a person. That promise
 * held only while the provider was the console one. With a real provider
 * configured — which is how the development API runs whenever `.env` names
 * one — a test submission handed `script.two@example.test` to the real
 * sending account, which could only bounce it. Each of those is a hard
 * bounce on the account whose bounce rate decides whether it may keep
 * sending.
 *
 * So every real provider is wrapped. A reserved recipient is dropped before
 * the provider sees it, and said so: the message still goes to anybody else,
 * with a warning on the record; if nobody is left it fails, not retryably,
 * with the reason. The console provider is not wrapped, because it sends
 * nothing and the dev log should look like production would.
 */
export class ReservedDomainGuard implements EmailProvider {
  readonly name: string;

  constructor(private readonly inner: EmailProvider) {
    this.name = inner.name;
  }

  async send(email: OutgoingEmail): Promise<DeliveryResult> {
    const dropped = [...email.to, ...(email.cc ?? [])].filter(isReservedAddress);
    if (!dropped.length) return this.inner.send(email);

    const to = email.to.filter((a) => !isReservedAddress(a));
    const cc = (email.cc ?? []).filter((a) => !isReservedAddress(a));
    const note = `not sent to ${dropped.join(', ')}: a reserved domain, which cannot receive mail`;
    if (!to.length && !cc.length) {
      return { providerMessageId: null, status: 'failed', retryable: false, detail: note };
    }
    const result = await this.inner.send({ ...email, to: to.length ? to : cc, cc: to.length ? cc : [] });
    return { ...result, warning: [result.warning, note].filter(Boolean).join('; ') };
  }
}

/**
 * The default. Records the message and delivers nothing.
 *
 * It exists so a local database and the test suite never send real mail to a
 * real person by accident — the failure mode of a "helpful" default that does
 * send is somebody's actual inbox.
 */
export class ConsoleProvider implements EmailProvider {
  readonly name = 'console';

  async send(email: OutgoingEmail): Promise<DeliveryResult> {
    const attachments = email.attachments?.length
      ? ` +${email.attachments.length} attachment(s): ${email.attachments.map((a) => a.filename).join(', ')}`
      : '';
    console.log(`  [email:console] ${email.to.join(', ')} — "${email.subject}"${attachments}`);
    return { providerMessageId: null, status: 'queued', detail: 'not delivered: console provider' };
  }
}

/**
 * RelyKit — LogaXP's own transactional email API, SES underneath.
 *
 * The same reasoning as Renviq in ADR-0001: it is a standard product with a
 * plain HTTP surface, so using it costs no architectural freedom, and the
 * escalation path for a production incident is a colleague.
 */
export class RelyKitProvider implements EmailProvider {
  readonly name = 'relykit';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env.RELYKIT_URL ?? 'https://api.relykit.com',
  ) {}

  async send(email: OutgoingEmail): Promise<DeliveryResult> {
    const body: Record<string, unknown> = {
      from: email.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      tags: email.tags,
    };
    if (email.html) body.html = email.html;
    if (email.cc?.length) body.cc = email.cc;
    if (email.replyTo) body.reply_to = [email.replyTo];
    if (email.attachments?.length) {
      body.attachments = email.attachments.map((a) => ({
        filename: a.filename,
        content: a.content.toString('base64'),
        content_type: a.contentType,
      }));
    }

    const res = await fetch(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        // The whole point of ADR-0002 reaching past the database.
        'Idempotency-Key': email.idempotencyKey,
      },
      body: JSON.stringify(body),
    });

    const payload = (await res.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
      message?: string;
      name?: string;
      last_error?: string;
      suppressed?: { email: string; reason: string }[];
      to?: string[];
    };

    if (!res.ok) {
      // RelyKit's errors are { name, message, status_code }. 422 is a
      // validation failure and 401 a bad key: both fail identically forever,
      // so they are recorded rather than retried.
      return {
        providerMessageId: null,
        status: 'failed',
        detail: `${res.status} ${payload.name ?? ''} ${payload.message ?? ''}`.trim(),
        retryable: res.status >= 500 || res.status === 429,
      };
    }

    /*
     * A 201 does not mean somebody will receive this.
     *
     * RelyKit removes suppressed recipients before queueing, and when none are
     * left it records the message as `cancelled` with a reason rather than
     * failing the request — which is the right call on their side: the sender
     * gets an id and can see what happened instead of wondering why nothing
     * arrived.
     *
     * It is only right if the caller reads it. Mapping anything that is not
     * `sent` to `queued` would put a delivery in our log that will never
     * happen, which is precisely the fault ADR-0010 found in role-addressed
     * mail, arriving again through a different door. Suppression is permanent
     * until somebody removes the address, so it is not retryable.
     */
    if (payload.status === 'cancelled') {
      return {
        providerMessageId: payload.id ?? null,
        status: 'failed',
        detail: payload.last_error ?? 'every recipient is on the suppression list',
        retryable: false,
      };
    }

    // Some recipients dropped, others kept. The send is real, and the log
    // should still say who was left out — otherwise the record shows a
    // reminder sent to three people when two of them were skipped.
    const dropped = payload.suppressed ?? [];
    return {
      providerMessageId: payload.id ?? null,
      status: payload.status === 'sent' || payload.status === 'delivered' ? 'sent' : 'queued',
      detail: payload.status,
      warning: dropped.length
        ? `dropped as suppressed: ${dropped.map((d) => `${d.email} (${d.reason})`).join(', ')}`
        : undefined,
    };
  }
}

/**
 * Resend.
 *
 * Same shape as RelyKit — that is the point of the interface. Swapping one for
 * the other is a line in `.env`, and everything above this file, including the
 * idempotency guarantee, is unchanged.
 */
export class ResendProvider implements EmailProvider {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env.RESEND_URL ?? 'https://api.resend.com',
  ) {}

  async send(email: OutgoingEmail): Promise<DeliveryResult> {
    const body: Record<string, unknown> = {
      from: email.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
    };
    if (email.html) body.html = email.html;
    if (email.cc?.length) body.cc = email.cc;
    if (email.replyTo) body.reply_to = email.replyTo;
    if (email.tags) {
      body.tags = Object.entries(email.tags).map(([name, value]) => ({ name, value }));
    }
    if (email.attachments?.length) {
      body.attachments = email.attachments.map((a) => ({
        filename: a.filename,
        content: a.content.toString('base64'),
        content_type: a.contentType,
      }));
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'Idempotency-Key': email.idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Never reached the provider, so trying again is the right answer.
      return {
        providerMessageId: null,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }

    const payload = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
      error?: { message?: string };
    };

    if (!res.ok) {
      return {
        providerMessageId: null,
        status: 'failed',
        detail: `${res.status} ${payload.name ?? ''} ${payload.error?.message ?? payload.message ?? ''}`.trim(),
        retryable: res.status >= 500 || res.status === 429,
      };
    }

    return { providerMessageId: payload.id ?? null, status: 'queued' };
  }
}

/**
 * The address messages are sent from.
 *
 * `MAIL_FROM` is the name in the deployment's environment; `EMAIL_FROM` is
 * accepted because it was the name here first, and silently ignoring one of
 * them would mean mail going out from `no-reply@localhost`.
 */
export function mailFrom(displayName: string): string {
  const address = process.env.MAIL_FROM ?? process.env.EMAIL_FROM ?? 'no-reply@localhost';
  return address.includes('<') ? address : `${displayName} <${address}>`;
}

/**
 * Picks a provider from the environment.
 *
 * Nothing leaves the machine unless `EMAIL_PROVIDER` names a provider AND that
 * provider's credentials are present. Two switches rather than one, because a
 * key left in a `.env` from last week should not quietly turn a test run into
 * real mail in somebody's inbox.
 *
 * A named provider whose credentials are missing throws rather than falling
 * back to the console: a deployment that believes it is sending and is not is
 * worse than one that will not start.
 */
export function emailProviderFromEnv(): EmailProvider {
  const provider = pickProvider();
  /*
   * And a third switch, for the thing the other two do not cover: a provider
   * that will really send, from an address that can never arrive. `MAIL_FROM`
   * falls back to `no-reply@localhost`, so a deployment that configures a
   * provider and forgets the address sends every message from a domain that
   * does not exist — rejected by the provider, or accepted and left to the
   * recipient's spam filter, and `queued` in our log either way.
   */
  assertCanSendAs(provider.name, mailFrom('Patform'));
  return provider.name === 'console' ? provider : new ReservedDomainGuard(provider);
}

function pickProvider(): EmailProvider {
  switch (process.env.EMAIL_PROVIDER) {
    case 'relykit': {
      const key = process.env.RELYKIT_API_KEY;
      if (!key) throw new Error('EMAIL_PROVIDER=relykit but RELYKIT_API_KEY is not set');
      return new RelyKitProvider(key);
    }
    case 'resend': {
      const key = process.env.RESEND_API_KEY;
      if (!key) throw new Error('EMAIL_PROVIDER=resend but RESEND_API_KEY is not set');
      return new ResendProvider(key);
    }
    case 'smtp':
      return smtpFromEnv();
    case 'console':
    case undefined:
    case '':
      return new ConsoleProvider();
    default:
      throw new Error(
        `EMAIL_PROVIDER="${process.env.EMAIL_PROVIDER}" is not one of: relykit, resend, smtp, console`,
      );
  }
}

/**
 * Turns delivery off for this process, whatever the environment says.
 *
 * A test harness that reads the same `.env` as the server will send real mail
 * the moment somebody configures a provider — and they will, because that is
 * the point of configuring one. The guard belongs in the harness rather than
 * in the Engine, because the Engine cannot tell whether it is running a proof
 * or running the business.
 *
 * Called at the top of a harness, before anything constructs an Engine.
 */
export function suppressDelivery(reason: string): void {
  const named = process.env.EMAIL_PROVIDER;
  delete process.env.EMAIL_PROVIDER;
  if (named && named !== 'console') {
    console.log(`\n  \x1b[33mEMAIL_PROVIDER=${named} ignored: ${reason}.\x1b[0m`);
  }
}
