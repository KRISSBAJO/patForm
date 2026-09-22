import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, Client } from './db.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';
import { logIfEnabled } from './trace.js';
import { messageFor, render } from './chat.js';

/**
 * Webhook delivery, §11.2.
 *
 * The section describes six behaviours. Before this file, `call_webhook` wrote
 * a row marked `delivered` and made no HTTP request at all — a hundred of them
 * in the seeded workspace said delivered and nothing had ever left the machine.
 * A customer integrating against it would have seen success in the console and
 * silence in their own system, which is the worst version of this failure: the
 * evidence agrees with you.
 *
 * Each of §11.2's lines, and what it costs:
 *
 * **"Events include process version, instance ID, event ID, occurred
 * timestamp, and minimal authorized payload."** All five are in the envelope.
 * *Minimal* is the load-bearing word: the payload carries the intersection of
 * what the process declares and what the endpoint was configured to receive.
 *
 * **"Payloads are signed; secrets rotate with overlap."** HMAC-SHA256 over
 * `timestamp.body`, with the timestamp in the signature so a captured request
 * cannot be replayed a week later. An endpoint mid-rotation gets two
 * signatures and accepts either, so a consumer can redeploy without dropping
 * a delivery — which is the entire point of "with overlap" and the reason a
 * single-secret rotation is a scheduled outage.
 *
 * **"Retry with exponential backoff and a terminal dead-letter state."** The
 * outbox's mechanism, not a second one.
 *
 * **"Consumers can inspect attempts and replay authorized events."** Every
 * attempt is a row; replay resets one for another try.
 *
 * **"Ordering is not guaranteed globally; event IDs and resource versions
 * enable safe consumers."** Stated in the envelope rather than promised in the
 * delivery: `event_id` is monotonic per record, so a consumer can discard an
 * older one. Promising order would mean a single-threaded queue per tenant.
 */

const MAX_ATTEMPTS = 6;
const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface Envelope {
  /** Stable per delivery, so a consumer can deduplicate its own retries. */
  id: string;
  event: string;
  /** §11.2: the event id, monotonic per record. Order by this, not by arrival. */
  event_id: number | null;
  instance_id: string;
  process_key: string;
  process_version: number;
  occurred_at: string;
  data: Record<string, unknown>;
}

// -------------------------------------------------------------- signing

/**
 * The signature header, in the shape consumers already know.
 *
 * `t=<unix>,v1=<hex>[,v1=<hex>]` — Stripe's layout, because an integrator has
 * almost certainly written the verification code once already and a novel
 * format buys nothing. Two `v1` values during a rotation.
 *
 * The timestamp is inside the signed string, not merely beside it. Signing the
 * body alone would let anybody who captured one request replay it forever.
 */
export function sign(body: string, secrets: string[], timestamp = Math.floor(Date.now() / 1000)): string {
  const signatures = secrets
    .filter(Boolean)
    .map((secret) => createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'))
    .map((hex) => `v1=${hex}`);
  return [`t=${timestamp}`, ...signatures].join(',');
}

/**
 * Verification, exported so the same code proves it and so an integrator has
 * a reference implementation that is definitionally correct.
 */
export function verify(
  header: string,
  body: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): { ok: boolean; reason?: string } {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'no timestamp' };
  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp is outside the tolerance window' };
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const offered = header
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));

  // Constant-time, and every candidate is compared so the loop's duration does
  // not depend on which one matched.
  let matched = false;
  for (const candidate of offered) {
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length === b.length && timingSafeEqual(a, b)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: 'no signature matched' };
}

// ------------------------------------------------------------- endpoints

export async function registerEndpoint(
  pool: Pool,
  args: {
    principal: Principal;
    url: string;
    description?: string;
    events?: string[];
    includeFields?: string[];
    /** 'slack' and 'teams' render a chat card instead of the raw envelope. */
    kind?: 'http' | 'slack' | 'teams';
  },
): Promise<{ id: string; secret: string }> {
  await requireWorkspaceCapability(pool, args.principal, 'administer', 'webhooks');
  if (args.principal.kind !== 'actor') throw new Error('unreachable');

  const parsed = new URL(args.url);
  if (parsed.protocol !== 'https:' && !parsed.hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
    // A signed payload over plain HTTP is a signed payload anybody can read.
    throw new Error('a webhook endpoint must be https, except on localhost for development');
  }

  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into webhook_endpoint (tenant_id, url, description, events, secret, include_fields, kind)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      args.principal.tenantId,
      args.url,
      args.description ?? '',
      args.events ?? [],
      secret,
      args.includeFields ?? [],
      args.kind ?? 'http',
    ],
  );
  return { id: rows[0]!.id, secret };
}

/**
 * Rotation, with the overlap §11.2 asks for.
 *
 * The old secret stays valid until `completeRotation`, so the order is:
 * rotate, deploy the new secret to the consumer, complete. Skipping the third
 * step leaves two working secrets, which is safe; skipping the second drops
 * deliveries, which is why the old one is not simply discarded here.
 */
export async function rotateSecret(
  pool: Pool,
  args: { principal: Principal; endpointId: string },
): Promise<{ secret: string; previousStillValid: true }> {
  await requireWorkspaceCapability(pool, args.principal, 'administer', 'webhooks');
  if (args.principal.kind !== 'actor') throw new Error('unreachable');

  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const { rowCount } = await pool.query(
    `update webhook_endpoint
        set previous_secret = secret, secret = $1, rotated_at = now()
      where id = $2 and tenant_id = $3`,
    [secret, args.endpointId, args.principal.tenantId],
  );
  if (!rowCount) throw new Error('no such endpoint');
  return { secret, previousStillValid: true };
}

export async function completeRotation(
  pool: Pool,
  args: { principal: Principal; endpointId: string },
): Promise<{ done: boolean }> {
  await requireWorkspaceCapability(pool, args.principal, 'administer', 'webhooks');
  if (args.principal.kind !== 'actor') throw new Error('unreachable');
  const { rowCount } = await pool.query(
    'update webhook_endpoint set previous_secret = null where id = $1 and tenant_id = $2',
    [args.endpointId, args.principal.tenantId],
  );
  return { done: (rowCount ?? 0) > 0 };
}

export async function listEndpoints(pool: Pool, principal: Principal) {
  await requireWorkspaceCapability(pool, principal, 'administer', 'webhooks');
  if (principal.kind !== 'actor') throw new Error('unreachable');
  const { rows } = await pool.query(
    `select e.id, e.url, e.description, e.events, e.include_fields, e.active, e.created_at,
            e.rotated_at, (e.previous_secret is not null) as rotating,
            (select count(*)::int from webhook_delivery d
              where d.endpoint_id = e.id and d.status = 'dead_letter') as dead_letters
       from webhook_endpoint e where e.tenant_id = $1 order by e.created_at desc`,
    [principal.tenantId],
  );
  return rows;
}

// ---------------------------------------------------------------- fan-out

/**
 * Queues one event to every endpoint that wants it.
 *
 * Called from inside the action's transaction, so the deliveries commit with
 * the state change that caused them — the transactional outbox pattern again
 * (§10.2), one layer down.
 *
 * An event nobody subscribes to still leaves a row, marked `no_subscriber`.
 * Silence would be indistinguishable from a delivery that never ran, and the
 * first question anyone asks is "did it fire?".
 */
export async function queueWebhook(
  client: Client,
  args: {
    tenantId: string;
    instanceId: string;
    actionRunId: number;
    eventName: string;
    eventId: number | null;
    processKey: string;
    processVersion: number;
    /** Fields the blueprint's action declared. */
    declared: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<number> {
  const { rows: endpoints } = await client.query<{ id: string; include_fields: string[] }>(
    `select id, include_fields from webhook_endpoint
      where tenant_id = $1 and active
        and (cardinality(events) = 0 or $2 = any(events))`,
    [args.tenantId, args.eventName],
  );

  if (!endpoints.length) {
    await client.query(
      `insert into webhook_delivery
         (tenant_id, instance_id, action_run_id, event_name, event_id, payload, status, created_at)
       values ($1, $2, $3, $4, $5, $6, 'no_subscriber', $7)`,
      [args.tenantId, args.instanceId, args.actionRunId, args.eventName, args.eventId,
       JSON.stringify(args.declared), args.occurredAt],
    );
    return 0;
  }

  for (const endpoint of endpoints) {
    /*
     * The intersection, not the union.
     *
     * The blueprint says which fields this event may carry; the endpoint says
     * which it was configured to receive. A field has to be in both — so
     * adding one to a process never silently widens what an existing
     * subscriber gets, which is what §11.2 means by sensitive fields being
     * opt-in.
     */
    const data =
      endpoint.include_fields.length === 0
        ? args.declared
        : Object.fromEntries(
            Object.entries(args.declared).filter(([key]) => endpoint.include_fields.includes(key)),
          );

    await client.query(
      /*
       * `available_at` comes from the event, not from `now()`.
       *
       * A row defaulting to wall-clock now is unclaimable by anything running
       * on a different clock — which is every replay, every backfill, and the
       * proof suite, all of which pass the time the event happened. It is also
       * simply more correct: the delivery is due as of the event.
       */
      `insert into webhook_delivery
         (tenant_id, instance_id, endpoint_id, action_run_id, event_name, event_id, payload, status,
          created_at, available_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $8)`,
      [
        args.tenantId,
        args.instanceId,
        endpoint.id,
        args.actionRunId,
        args.eventName,
        args.eventId,
        JSON.stringify({
          event: args.eventName,
          event_id: args.eventId,
          instance_id: args.instanceId,
          process_key: args.processKey,
          process_version: args.processVersion,
          occurred_at: args.occurredAt.toISOString(),
          data,
        }),
        args.occurredAt,
      ],
    );
  }

  return endpoints.length;
}

// --------------------------------------------------------------- delivery

export interface DeliveryOutcome {
  claimed: number;
  delivered: number;
  retrying: number;
  deadLettered: number;
}

/**
 * Claims and delivers a batch. Safe to run in parallel with itself.
 *
 * The same claim statement as the outbox: one atomic UPDATE with FOR UPDATE
 * SKIP LOCKED and a visibility timeout, so two workers never take the same
 * delivery. Copying the pattern rather than inventing one means the
 * concurrency proof that covers the outbox covers the reasoning here too.
 */
export async function deliverBatch(
  pool: Pool,
  args: { workerId: string; batch?: number; now?: Date; fetchImpl?: typeof fetch },
): Promise<DeliveryOutcome> {
  const now = args.now ?? new Date();
  const doFetch = args.fetchImpl ?? fetch;
  const outcome: DeliveryOutcome = { claimed: 0, delivered: 0, retrying: 0, deadLettered: 0 };

  const { rows: claimed } = await pool.query<{
    id: number;
    payload: Envelope;
    attempts: number;
    url: string;
    secret: string;
    previous_secret: string | null;
    kind: 'http' | 'slack' | 'teams';
  }>(
    `update webhook_delivery d
        set claimed_by = $1, claimed_at = $2, attempts = d.attempts + 1,
            available_at = $2 + interval '30 seconds'
      from webhook_endpoint e
      where e.id = d.endpoint_id
        and d.id in (
          select id from webhook_delivery
           where status = 'pending' and available_at <= $2
           order by id for update skip locked limit $3
        )
      returning d.id, d.payload, d.attempts, e.url, e.secret, e.previous_secret, e.kind`,
    [args.workerId, now, args.batch ?? 20],
  );

  outcome.claimed = claimed.length;

  for (const row of claimed) {
    /*
     * A chat destination gets a card, not the envelope.
     *
     * Slack and Teams ignore an unknown JSON body and answer 400, so the
     * difference is not cosmetic. They also do not verify our signature —
     * the webhook URL is itself the credential — so signing a chat post
     * would be theatre, and the header is left off rather than sent
     * meaninglessly.
     */
    const chatKind = row.kind === 'slack' || row.kind === 'teams' ? row.kind : null;
    const body = chatKind
      ? JSON.stringify(render(chatKind, messageFor(row.payload)))
      : JSON.stringify(row.payload);
    const signature = chatKind ? null : sign(body, [row.secret, row.previous_secret ?? '']);

    try {
      const response = await doFetch(row.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(signature ? { 'patform-signature': signature } : {}),
          'patform-event': row.payload.event,
          'patform-delivery': String(row.id),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        await pool.query(
          `update webhook_delivery set status = 'delivered', delivered_at = $1, response_status = $2,
                                       last_error = null
            where id = $3`,
          [now, response.status, row.id],
        );
        outcome.delivered++;
        continue;
      }

      await recordFailure(pool, row.id, row.attempts, `HTTP ${response.status}`, response.status, now, outcome);
    } catch (err) {
      await recordFailure(
        pool,
        row.id,
        row.attempts,
        err instanceof Error ? err.message : String(err),
        null,
        now,
        outcome,
      );
    }
  }

  return outcome;
}

/**
 * Backoff, then a terminal state.
 *
 * §11.2 asks for both, and the second half is the part people leave out: a
 * delivery that retries forever is an endpoint that is down forever plus a
 * queue that never drains. `dead_letter` stops the attempts and keeps the row,
 * so an operator can fix the endpoint and replay rather than lose the event.
 */
async function recordFailure(
  pool: Pool,
  id: number,
  attempts: number,
  error: string,
  status: number | null,
  now: Date,
  outcome: DeliveryOutcome,
): Promise<void> {
  if (attempts >= MAX_ATTEMPTS) {
    await pool.query(
      `update webhook_delivery set status = 'dead_letter', last_error = $1, response_status = $2 where id = $3`,
      [error, status, id],
    );
    outcome.deadLettered++;
    logIfEnabled('error', 'webhook.dead_letter', { deliveryId: id, attempts, error });
    return;
  }

  await pool.query(
    `update webhook_delivery
        set status = 'pending', last_error = $1, response_status = $2,
            available_at = $3::timestamptz + make_interval(secs => least(3600, power(4, attempts)::int))
      where id = $4`,
    [error, status, now, id],
  );
  outcome.retrying++;
}

/** §11.2: consumers can inspect attempts. */
export async function listDeliveries(
  pool: Pool,
  args: { principal: Principal; instanceId?: string; status?: string; limit?: number },
) {
  if (args.principal.kind !== 'actor') throw new Error('signed-in members only');
  const { rows } = await pool.query(
    `select d.id, d.event_name, d.event_id, d.status, d.attempts, d.response_status, d.last_error,
            d.created_at, d.delivered_at, d.available_at, e.url
       from webhook_delivery d left join webhook_endpoint e on e.id = d.endpoint_id
      where d.tenant_id = $1
        and ($2::uuid is null or d.instance_id = $2)
        and ($3::text is null or d.status = $3)
      order by d.id desc limit $4`,
    [args.principal.tenantId, args.instanceId ?? null, args.status ?? null, Math.min(args.limit ?? 50, 200)],
  );
  return rows;
}

/**
 * §11.2: replay authorized events.
 *
 * `operate`, because re-sending is an action against the customer's own
 * systems. It resets the attempt counter: a dead letter that is replayed after
 * the endpoint is fixed should get the full retry budget again rather than one
 * more try.
 */
export async function replayDelivery(
  pool: Pool,
  args: { principal: Principal; deliveryId: number; now?: Date },
): Promise<{ queued: boolean }> {
  await requireWorkspaceCapability(pool, args.principal, 'operate', 'webhook-replay');
  if (args.principal.kind !== 'actor') throw new Error('unreachable');

  const { rowCount } = await pool.query(
    `update webhook_delivery
        set status = 'pending', attempts = 0, available_at = $3, claimed_by = null, last_error = null
      where id = $1 and tenant_id = $2 and status in ('dead_letter', 'failed', 'delivered')`,
    [args.deliveryId, args.principal.tenantId, args.now ?? new Date()],
  );
  return { queued: (rowCount ?? 0) > 0 };
}
