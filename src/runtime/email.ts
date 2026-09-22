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
}

export interface EmailProvider {
  readonly name: string;
  send(email: OutgoingEmail): Promise<DeliveryResult>;
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
    };

    if (!res.ok) {
      return {
        providerMessageId: null,
        status: 'failed',
        detail: `${res.status} ${payload.name ?? ''} ${payload.message ?? ''}`.trim(),
        retryable: res.status >= 500 || res.status === 429,
      };
    }

    return {
      providerMessageId: payload.id ?? null,
      status: payload.status === 'sent' || payload.status === 'delivered' ? 'sent' : 'queued',
      detail: payload.status,
    };
  }
}

/**
 * Picks a provider from the environment.
 *
 * Nothing sends unless a key is configured AND `EMAIL_PROVIDER` names it. Two
 * switches rather than one, because a key left in a `.env` from a week ago
 * should not quietly turn a test run into real mail.
 */
export function emailProviderFromEnv(): EmailProvider {
  const named = process.env.EMAIL_PROVIDER;
  const key = process.env.RELYKIT_API_KEY;

  if (named === 'relykit') {
    if (!key) throw new Error('EMAIL_PROVIDER=relykit but RELYKIT_API_KEY is not set');
    return new RelyKitProvider(key);
  }
  return new ConsoleProvider();
}
