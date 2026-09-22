/**
 * What happened to a message after we handed it over.
 *
 * §6.6 asks for a delivery log that distinguishes queued, sent, delivered
 * where supported, bounced, complained and failed. Until now it reached `sent`
 * and stopped, because everything past that is something the provider learns
 * minutes or hours later — a remote mail server refusing the address, or
 * somebody pressing the spam button — and tells us about over a webhook.
 *
 * Three properties this has to get right:
 *
 *   1. **Redelivery changes nothing.** The provider retries until it gets a
 *      2xx, so the same event arrives more than once as a matter of course.
 *      `delivery_event.event_id` is unique and the insert is the guard.
 *   2. **Status never moves backwards.** A delivery notification for one
 *      recipient arriving after a bounce for another must not make the
 *      message look fine. The ranking below is the same one RelyKit uses, so
 *      the two systems agree about what a message's state is.
 *   3. **A hard bounce stops future mail.** A log entry nobody reads is not
 *      handling a bounce. Suppression is enforced in the send path, which is
 *      the only part of this that changes what the system does.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Client, Pool } from './db.js';
import { inTransaction } from './db.js';
import { logIfEnabled } from './trace.js';

/**
 * A message's state is the worst thing that happened to any of its recipients,
 * and a later event never lowers it.
 *
 * `skipped` sits at the bottom because a skipped message was never handed to a
 * provider and so has no provider id for an event to match on; it is here for
 * completeness rather than because anything can reach it.
 */
const RANK: Record<string, number> = {
  skipped: 0,
  queued: 1,
  sent: 2,
  delivered: 3,
  failed: 4,
  bounced: 5,
  complained: 6,
};

/** What each provider event type implies about the message, if anything. */
const STATUS_FOR: Record<string, string | null> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.rejected': 'failed',
  'email.failed': 'failed',
  'email.suppressed': 'skipped',
  // Real events that say nothing about whether it arrived.
  'email.delayed': null,
  'email.opened': null,
  'email.clicked': null,
};

export class SignatureRefused extends Error {}

// ------------------------------------------------------------- signatures

/**
 * RelyKit signs with the Standard Webhooks scheme: `webhook-id`,
 * `webhook-timestamp` in unix seconds, and `webhook-signature` holding
 * `v1,<base64 HMAC-SHA256 of id.timestamp.body>`.
 *
 * Note this is not the scheme Patform uses for its *outbound* webhooks, which
 * is Stripe's. Different directions, different counterparties; making them
 * match would mean changing one of the two to something its counterpart does
 * not speak.
 *
 * The timestamp is inside the signed string, so a captured request cannot be
 * replayed tomorrow — and it is checked separately, because a signature that
 * is valid forever is a signature that only proves who wrote the request, not
 * when.
 */
export function verifyRelyKit(args: {
  secret: string;
  id: string;
  timestamp: string;
  body: string;
  signature: string;
  toleranceSeconds?: number;
  now?: number;
}): { ok: boolean; reason?: string } {
  const tolerance = args.toleranceSeconds ?? 300;
  const now = args.now ?? Date.now();

  if (!args.id || !args.timestamp || !args.signature) {
    return { ok: false, reason: 'the signature headers are incomplete' };
  }
  const sent = Number(args.timestamp);
  if (!Number.isFinite(sent)) return { ok: false, reason: 'the timestamp is not a number' };
  if (Math.abs(now / 1000 - sent) > tolerance) return { ok: false, reason: 'outside the timestamp tolerance' };

  const expected = createHmac('sha256', args.secret)
    .update(`${args.id}.${args.timestamp}.${args.body}`)
    .digest('base64');

  /*
   * The header may carry several space-separated versions during a rotation,
   * and any one of them matching is a pass. Compared with timingSafeEqual,
   * which needs equal lengths — a mismatched length is a mismatch, and
   * returning early on it leaks nothing a length check would not.
   */
  for (const part of args.signature.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true };
  }
  return { ok: false, reason: 'no signature matched' };
}

// ---------------------------------------------------------------- ingest

export interface ProviderEvent {
  id: string;
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    recipient?: string;
    bounce_type?: string;
    diagnostic_code?: string;
    feedback_type?: string;
    reason?: string;
    [key: string]: unknown;
  };
}

export interface Ingested {
  eventId: string;
  type: string;
  duplicate: boolean;
  matched: 'process' | 'platform' | null;
  statusBefore?: string;
  statusAfter?: string;
  suppressed?: string;
}

/**
 * Records one provider notification and applies what it implies.
 *
 * All in one transaction. The insert into `delivery_event` is what makes the
 * whole thing idempotent, so it has to commit with the status change and the
 * suppression rather than before them — otherwise a crash between the two
 * leaves an event marked handled that was not.
 */
export async function ingest(
  pool: Pool,
  args: { provider: string; event: ProviderEvent; eventId: string },
): Promise<Ingested> {
  const { event } = args;
  const messageId = event.data?.email_id ?? null;
  const recipient = event.data?.recipient?.trim().toLowerCase() ?? null;
  const occurredAt = event.created_at ?? new Date().toISOString();

  return inTransaction(pool, async (client) => {
    // Claims the event. A second copy of the same notification loses here and
    // does nothing else, which is the whole idempotency story.
    const { rows: claimed } = await client.query<{ id: string }>(
      `insert into delivery_event
         (event_id, provider, type, provider_message_id, recipient, payload, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (event_id) do nothing
       returning id`,
      [args.eventId, args.provider, event.type, messageId, recipient, JSON.stringify(event), occurredAt],
    );
    if (!claimed[0]) {
      return { eventId: args.eventId, type: event.type, duplicate: true, matched: null };
    }

    const result: Ingested = {
      eventId: args.eventId,
      type: event.type,
      duplicate: false,
      matched: null,
    };

    // ---- find the message, in either log
    let log: { table: 'email_log' | 'platform_email'; id: string; status: string } | null = null;
    if (messageId) {
      const { rows: process_ } = await client.query<{ id: string; status: string }>(
        'select id, status from email_log where provider_message_id = $1 for update',
        [messageId],
      );
      if (process_[0]) log = { table: 'email_log', id: process_[0].id, status: process_[0].status };
      else {
        const { rows: platform } = await client.query<{ id: string; status: string }>(
          'select id, status from platform_email where provider_message_id = $1 for update',
          [messageId],
        );
        if (platform[0]) log = { table: 'platform_email', id: platform[0].id, status: platform[0].status };
      }
    }

    if (log) {
      result.matched = log.table === 'email_log' ? 'process' : 'platform';
      result.statusBefore = log.status;

      await client.query(
        `update delivery_event set ${log.table === 'email_log' ? 'email_log_id' : 'platform_email_id'} = $1
          where id = $2`,
        [log.id, claimed[0].id],
      );

      const implied = STATUS_FOR[event.type] ?? null;
      const before = RANK[log.status] ?? 0;
      const after = implied ? (RANK[implied] ?? 0) : -1;
      if (implied && after > before) {
        await client.query(
          `update ${log.table} set status = $1, failure = coalesce($2, failure) where id = $3`,
          [implied, describe(event), log.id],
        );
        result.statusAfter = implied;
      } else {
        result.statusAfter = log.status;
      }
    }

    // ---- suppression, which is the part with teeth
    const suppress = suppressionFor(event);
    if (suppress && recipient) {
      await client.query(
        `insert into suppressed_recipient (email, reason, detail, event_id)
         values ($1, $2, $3, $4)
         on conflict (email) do update
           set reason = excluded.reason, detail = excluded.detail,
               event_id = excluded.event_id, created_at = now(),
               -- A fresh bounce overrules an earlier reinstatement. Somebody
               -- decided the address worked; the mail server disagreed again.
               lifted_at = null, lifted_by = null`,
        [recipient, suppress, describe(event), args.eventId],
      );
      result.suppressed = recipient;
    }

    logIfEnabled('info', 'delivery.event', {
      type: event.type,
      matched: result.matched,
      status: result.statusAfter ?? null,
      suppressed: Boolean(result.suppressed),
    });

    return result;
  });
}

/** Only a permanent failure stops future mail. A soft bounce is a full mailbox. */
function suppressionFor(event: ProviderEvent): 'hard_bounce' | 'complaint' | null {
  if (event.type === 'email.complained') return 'complaint';
  if (event.type === 'email.bounced' && event.data?.bounce_type === 'hard') return 'hard_bounce';
  return null;
}

/** The one line an operator reads to find out what went wrong. */
function describe(event: ProviderEvent): string | null {
  const d = event.data ?? {};
  if (event.type === 'email.bounced') {
    return `${d.bounce_type ?? 'bounce'}: ${d.diagnostic_code ?? 'no diagnostic given'}`.slice(0, 500);
  }
  if (event.type === 'email.complained') {
    return `complaint: ${d.feedback_type ?? 'no feedback type given'}`.slice(0, 500);
  }
  if (event.type === 'email.rejected' || event.type === 'email.failed') {
    return `${event.type}: ${d.reason ?? 'no reason given'}`.slice(0, 500);
  }
  return null;
}

// ------------------------------------------------------------ suppression

/**
 * The addresses in this list that a send is about to write to.
 *
 * Takes the whole list and returns the blocked subset rather than answering
 * one address at a time, because the caller needs to know *which* recipients
 * were dropped in order to say so — and because a per-address check inside a
 * loop is a query per recipient.
 */
export async function blockedRecipients(db: Pool | Client, addresses: string[]): Promise<Map<string, string>> {
  if (!addresses.length) return new Map();
  const { rows } = await db.query<{ email: string; reason: string }>(
    `select email, reason from suppressed_recipient
      where lifted_at is null and email = any($1::text[])`,
    [addresses.map((a) => a.trim().toLowerCase())],
  );
  return new Map(rows.map((r) => [r.email, r.reason]));
}

/**
 * What a tenant is allowed to see.
 *
 * The list itself is deployment-wide — a hard bounce is a fact about the
 * mailbox, not about who wrote to it — but showing one tenant every address
 * another tenant has burned would be a contact list with extra steps. So a
 * tenant sees the suppressions for addresses it has actually mailed.
 */
export async function suppressionsFor(pool: Pool, tenantId: string) {
  const { rows } = await pool.query(
    `select s.email, s.reason, s.detail, s.created_at, s.lifted_at
       from suppressed_recipient s
      where exists (
              select 1 from email_log e
               where e.tenant_id = $1 and s.email = any(e.recipients))
         or exists (
              select 1 from platform_email p
               where p.tenant_id = $1 and lower(p.recipient) = s.email)
      order by s.lifted_at nulls first, s.created_at desc`,
    [tenantId],
  );
  return rows;
}

/**
 * Lets an address through again.
 *
 * Kept as a row with `lifted_at` rather than deleted, because "this bounced in
 * March and somebody reinstated it in April" is exactly the history the
 * operator wants the second time it bounces.
 */
export async function lift(
  pool: Pool,
  args: { email: string; actorId: string },
): Promise<{ lifted: boolean }> {
  const { rowCount } = await pool.query(
    `update suppressed_recipient set lifted_at = now(), lifted_by = $2
      where email = lower($1) and lifted_at is null`,
    [args.email.trim(), args.actorId],
  );
  return { lifted: (rowCount ?? 0) > 0 };
}

/** An operator blocking an address by hand — a request to stop, usually. */
export async function suppressByHand(
  pool: Pool,
  args: { email: string; detail: string },
): Promise<void> {
  await pool.query(
    `insert into suppressed_recipient (email, reason, detail) values (lower($1), 'manual', $2)
     on conflict (email) do update
       set reason = 'manual', detail = excluded.detail, lifted_at = null, lifted_by = null`,
    [args.email.trim(), args.detail],
  );
}

/** The timeline for one message, newest last. */
export async function eventsFor(pool: Pool, providerMessageId: string) {
  const { rows } = await pool.query(
    `select event_id, type, recipient, payload, occurred_at, received_at
       from delivery_event where provider_message_id = $1 order by occurred_at, id`,
    [providerMessageId],
  );
  return rows;
}
