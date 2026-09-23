import type { Blueprint } from '../blueprint/index.js';
import { inTransaction, type Pool } from './db.js';
import { blockedRecipients } from './delivery.js';
import { appendEvent } from './engine.js';
import { mailFrom, type Attachment, type EmailProvider } from './email.js';
import { render } from './expr.js';
import { sendPlatformMail } from './platform-mail.js';
import { logIfEnabled } from './trace.js';

/**
 * The two halves of bounce handling that were missing.
 *
 * Individual bounces were already handled: a hard bounce or a complaint
 * suppresses the address, and nothing is sent to it again. What nobody
 * watched was the *rate* — and the rate is what a provider suspends an
 * account over. RelyKit sends through Amazon SES, which puts an account under
 * review at a 5% bounce rate or a 0.1% complaint rate and can pause sending
 * at 10% and 0.5%. A suspension stops every message from every workspace on
 * this deployment, including the password resets.
 *
 * The other half is what happens after somebody decides a suppressed address
 * works after all. Lifting it let future mail through; the messages skipped
 * while it was blocked were simply gone.
 */

/*
 * Below the provider's review thresholds on purpose. `watch` is the point to
 * look; `act` is where the provider starts looking back.
 */
export const THRESHOLDS = {
  bounce: { watch: 0.02, act: 0.05 },
  complaint: { watch: 0.0005, act: 0.001 },
} as const;

/** The provider judges over a representative period, not the last hour. */
export const WINDOW_DAYS = 7;

/*
 * Two bounces out of ten messages is 20%, and it is also two typos. A rate
 * needs a volume under it before it is a rate — unless the problems are
 * numerous enough on their own to be worth somebody's attention.
 */
const MIN_SENT = 50;
const MIN_PROBLEMS = 5;

export type HealthLevel = 'ok' | 'watch' | 'act' | 'too_few';

export interface SendingHealth {
  windowDays: number;
  sent: number;
  bounced: number;
  complained: number;
  bounceRate: number;
  complaintRate: number;
  level: HealthLevel;
  thresholds: typeof THRESHOLDS;
}

function levelFor(sent: number, bounced: number, complained: number): HealthLevel {
  if (sent < MIN_SENT && bounced + complained < MIN_PROBLEMS) return 'too_few';
  const b = sent ? bounced / sent : 0;
  const c = sent ? complained / sent : 0;
  if (b >= THRESHOLDS.bounce.act || c >= THRESHOLDS.complaint.act) return 'act';
  if (b >= THRESHOLDS.bounce.watch || c >= THRESHOLDS.complaint.watch) return 'watch';
  return 'ok';
}

/**
 * Hard bounces and complaints against messages the provider accepted.
 *
 * Soft bounces are not counted: a full mailbox is not the sender's fault and
 * the provider does not count it either. Both logs are counted — process mail
 * and the platform's own invitations and resets — because they leave through
 * the same account and the provider sees one number. `tenantId` narrows it to
 * one workspace's share, which is what a workspace admin can do something
 * about; without it, it is the whole deployment, which is what the provider
 * judges.
 */
export async function sendingHealth(
  pool: Pool,
  args: { tenantId?: string; now?: Date } = {},
): Promise<SendingHealth> {
  const since = new Date((args.now ?? new Date()).getTime() - WINDOW_DAYS * 86_400_000);
  const tenant = args.tenantId ?? null;
  const { rows } = await pool.query<{ sent: number; bounced: number; complained: number }>(
    `with sent as (
       select 'p' || id as k from email_log
        where sent_at > $1 and status not in ('failed', 'skipped')
          and ($2::uuid is null or tenant_id = $2)
       union all
       select 'x' || id from platform_email
        where sent_at > $1 and status not in ('failed', 'skipped')
          and ($2::uuid is null or tenant_id = $2)
     ),
     problems as (
       select d.type, coalesce('p' || d.email_log_id, 'x' || d.platform_email_id) as k
         from delivery_event d
         left join email_log e on e.id = d.email_log_id
         left join platform_email pe on pe.id = d.platform_email_id
        where coalesce(e.sent_at, pe.sent_at) > $1
          and ($2::uuid is null or coalesce(e.tenant_id, pe.tenant_id) = $2)
          and (
            (d.type = 'email.bounced' and d.payload -> 'data' ->> 'bounce_type' = 'hard')
            or d.type = 'email.complained'
          )
     )
     select (select count(*)::int from sent) as sent,
            (select count(distinct k)::int from problems where type = 'email.bounced') as bounced,
            (select count(distinct k)::int from problems where type = 'email.complained') as complained`,
    [since, tenant],
  );
  const { sent, bounced, complained } = rows[0]!;
  return {
    windowDays: WINDOW_DAYS,
    sent,
    bounced,
    complained,
    bounceRate: sent ? bounced / sent : 0,
    complaintRate: sent ? complained / sent : 0,
    level: levelFor(sent, bounced, complained),
    thresholds: THRESHOLDS,
  };
}

const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;

/**
 * The worker's check. Raises an alert when the rate crosses a threshold,
 * clears it when it recovers, and otherwise stays quiet.
 *
 * Quiet matters as much as loud. An alert that fired every minute while the
 * rate stayed high would be muted by lunchtime, and then it would be muted on
 * the day it mattered. So each crossing notifies once, a rise from `watch` to
 * `act` notifies again, and recovery says so.
 *
 * Notifying is a log line at `warn` or `error` — for whatever reads the logs
 * — and an email to `OPS_ALERT_EMAIL` when it is set. Not to workspace
 * owners: the account is the deployment's, and a customer cannot fix another
 * customer's bounces.
 */
export async function checkSendingHealth(
  pool: Pool,
  now = new Date(),
): Promise<{ change: 'raised' | 'escalated' | 'cleared' | null; health: SendingHealth; alertId?: string }> {
  const health = await sendingHealth(pool, { now });
  const alarming = health.level === 'watch' || health.level === 'act';

  const outcome = await inTransaction(pool, async (tx) => {
    // Transaction-scoped, so it behaves the same through a pooler: two
    // workers checking at once take turns rather than both raising.
    await tx.query(`select pg_advisory_xact_lock(hashtext('delivery_alert'))`);
    const { rows: open } = await tx.query<{ id: string; level: 'watch' | 'act' }>(
      'select id, level from delivery_alert where cleared_at is null',
    );
    const current = open[0];

    if (alarming && (!current || (current.level === 'watch' && health.level === 'act'))) {
      if (current) await tx.query('update delivery_alert set cleared_at = $1 where id = $2', [now, current.id]);
      const { rows } = await tx.query<{ id: string }>(
        `insert into delivery_alert (level, sent, bounced, complained, raised_at)
         values ($1, $2, $3, $4, $5) returning id`,
        [health.level, health.sent, health.bounced, health.complained, now],
      );
      return { change: current ? ('escalated' as const) : ('raised' as const), alertId: rows[0]!.id };
    }
    if (!alarming && current) {
      await tx.query('update delivery_alert set cleared_at = $1 where id = $2', [now, current.id]);
      return { change: 'cleared' as const, alertId: current.id };
    }
    return { change: null };
  });

  if (!outcome.change) return { change: null, health };

  const summary =
    `${health.bounced} hard bounce(s) and ${health.complained} complaint(s) in ${health.sent} message(s) ` +
    `over ${WINDOW_DAYS} days: bounce rate ${pct(health.bounceRate)}, complaint rate ${pct(health.complaintRate, 2)}.`;
  logIfEnabled(outcome.change === 'cleared' ? 'info' : health.level === 'act' ? 'error' : 'warn', 'delivery.health', {
    change: outcome.change,
    level: health.level,
    sent: health.sent,
    bounced: health.bounced,
    complained: health.complained,
  });

  const to = process.env.OPS_ALERT_EMAIL;
  if (to) {
    const worst = outcome.change === 'cleared' ? [] : await worstSources(pool, now);
    const subject =
      outcome.change === 'cleared'
        ? 'Sending has recovered'
        : health.level === 'act'
          ? 'Act now: bounce or complaint rate is at the provider’s review threshold'
          : 'Watch: bounce or complaint rate is rising';
    const text = [
      summary,
      '',
      outcome.change === 'cleared'
        ? 'Both rates are back under the watch thresholds.'
        : `The provider reviews an account at ${pct(THRESHOLDS.bounce.act, 0)} bounces or ${pct(THRESHOLDS.complaint.act)} complaints, ` +
          'and a paused account stops every message from every workspace, including password resets.',
      ...(worst.length
        ? ['', 'Where the problems came from:', ...worst.map((w) => `  ${w.count} × ${w.what} — ${w.workspace}`)]
        : []),
    ].join('\n');
    await sendPlatformMail(pool, {
      kind: 'delivery_alert',
      to,
      subject,
      text,
      idempotencyKey: `delivery-alert-${outcome.alertId}-${outcome.change}`,
    });
  }

  return { change: outcome.change, health, alertId: outcome.alertId };
}

/** The templates, and workspaces, that produced the most hard bounces and complaints. */
async function worstSources(pool: Pool, now: Date) {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const { rows } = await pool.query<{ what: string; workspace: string; count: number }>(
    `select coalesce(e.template_key, pe.kind) as what, coalesce(t.name, '(no workspace)') as workspace, count(*)::int as count
       from delivery_event d
       left join email_log e on e.id = d.email_log_id
       left join platform_email pe on pe.id = d.platform_email_id
       left join tenant t on t.id = coalesce(e.tenant_id, pe.tenant_id)
      where coalesce(e.sent_at, pe.sent_at) > $1
        and ((d.type = 'email.bounced' and d.payload -> 'data' ->> 'bounce_type' = 'hard') or d.type = 'email.complained')
      group by 1, 2 order by 3 desc limit 5`,
    [since],
  );
  return rows;
}

// ------------------------------------------------------------ after a lift

export interface SkippedMessage {
  logId: string;
  reference: string;
  processName: string;
  template: string;
  subject: string;
  skippedAt: string;
  /** Whether the record has finished — a reminder about a finished record is usually stale. */
  recordFinished: boolean;
  resentAt: string | null;
}

/** Every message this workspace did not send to an address because it was suppressed. */
export async function skippedFor(pool: Pool, args: { tenantId: string; email: string }): Promise<SkippedMessage[]> {
  const email = args.email.trim().toLowerCase();
  const { rows } = await pool.query<{
    id: string;
    instance_id: string;
    template_key: string;
    subject: string;
    sent_at: Date;
    completed_at: Date | null;
    blueprint: Blueprint;
    resent_at: Date | null;
  }>(
    `select e.id, e.instance_id, e.template_key, e.subject, e.sent_at, i.completed_at, pv.blueprint,
            (select r.resent_at from email_resend r where r.email_log_id = e.id and r.recipient = $2) as resent_at
       from email_log e
       join instance i on i.id = e.instance_id
       join process_version pv on pv.id = i.process_version_id
      where e.tenant_id = $1 and $2 = any(e.suppressed)
      order by e.sent_at desc
      limit 100`,
    [args.tenantId, email],
  );
  return rows.map((r) => ({
    logId: String(r.id),
    reference: r.instance_id.slice(0, 8).toUpperCase(),
    processName: r.blueprint.name,
    template: r.blueprint.communications.email.find((t) => t.key === r.template_key)?.name ?? r.template_key,
    subject: r.subject,
    skippedAt: r.sent_at.toISOString(),
    recordFinished: r.completed_at !== null,
    resentAt: r.resent_at?.toISOString() ?? null,
  }));
}

export interface ResendOutcome {
  logId: string;
  sent: boolean;
  reason?: string;
}

/**
 * Sends chosen skipped messages to an address that has been reinstated.
 *
 * Chosen, never automatic. A message skipped two weeks ago was true two
 * weeks ago: "your approval is waiting" may be about an approval that has
 * since been given. So it is rendered from the record as it is *now*, and the
 * person choosing is shown whether the record has finished.
 *
 * Each resend is its own effect, with its own ledger row keyed to the
 * original message and the address, and sent under that key — so pressing it
 * twice, or two people pressing it at once, sends once. A provider failure
 * rolls the whole resend back and it can simply be tried again.
 */
export async function resendSkipped(
  pool: Pool,
  provider: EmailProvider,
  args: { tenantId: string; actorId: string; email: string; logIds: string[]; now?: Date },
): Promise<ResendOutcome[]> {
  const email = args.email.trim().toLowerCase();
  const now = args.now ?? new Date();

  if ((await blockedRecipients(pool, [email])).size) {
    return args.logIds.map((logId) => ({ logId, sent: false, reason: 'the address is still suppressed' }));
  }

  const out: ResendOutcome[] = [];
  for (const logId of args.logIds) {
    try {
      const result = await inTransaction(pool, async (tx): Promise<ResendOutcome> => {
        const { rows } = await tx.query<{
          instance_id: string;
          template_key: string;
          data: Record<string, unknown>;
          blueprint: Blueprint;
        }>(
          `select e.instance_id, e.template_key, i.data, pv.blueprint
             from email_log e
             join instance i on i.id = e.instance_id
             join process_version pv on pv.id = i.process_version_id
            where e.id = $1 and e.tenant_id = $2 and $3 = any(e.suppressed)`,
          [logId, args.tenantId, email],
        );
        const row = rows[0];
        if (!row) return { logId, sent: false, reason: 'not a message this address missed' };

        const claimed = await tx.query(
          `insert into email_resend (tenant_id, email_log_id, recipient, resent_by, resent_at)
           values ($1, $2, $3, $4, $5)
           on conflict (email_log_id, recipient) do nothing`,
          [args.tenantId, logId, email, args.actorId, now],
        );
        if (!claimed.rowCount) return { logId, sent: false, reason: 'already sent again' };

        const template = row.blueprint.communications.email.find((t) => t.key === row.template_key);
        if (!template) throw new Error(`the process no longer has a message called "${row.template_key}"`);

        const key = `resend:${logId}:${email}`;
        const { rows: run } = await tx.query<{ id: string }>(
          `insert into action_run (tenant_id, instance_id, idempotency_key, action_do, created_at)
           values ($1, $2, $3, 'send_email', $4) returning id`,
          [args.tenantId, row.instance_id, key, now],
        );

        const subject = render(template.subject, row.data as never);
        const body = render(template.body, row.data as never);
        const attachments: Attachment[] = [];
        if (template.attachments.length) {
          const { rows: files } = await tx.query<{ filename: string; content: Buffer | null }>(
            `select filename, content from document
              where instance_id = $1 and document_key = any($2::text[]) and content is not null order by id`,
            [row.instance_id, template.attachments],
          );
          for (const f of files) {
            if (f.content) attachments.push({ filename: f.filename, content: f.content, contentType: 'application/pdf' });
          }
        }

        const { rows: logged } = await tx.query<{ id: string }>(
          `insert into email_log
             (tenant_id, instance_id, action_run_id, template_key, recipients, subject, body, status, provider, sent_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9) returning id`,
          [args.tenantId, row.instance_id, run[0]!.id, template.key, [email], subject, body, provider.name, now],
        );

        const delivery = await provider.send({
          from: mailFrom(row.blueprint.communications.fromName),
          to: [email],
          subject,
          text: body,
          attachments,
          idempotencyKey: key,
          tags: { process: row.blueprint.key, template: template.key, resend: 'true' },
        });
        // Any failure undoes the whole resend, claim included. Recording it as
        // "sent again" would be untrue, and would stop anybody trying again
        // once whatever refused it is fixed.
        if (delivery.status === 'failed') {
          throw new Error(delivery.detail ?? 'the provider refused it');
        }

        await tx.query('update email_log set status = $1, provider_message_id = $2, failure = $3 where id = $4', [
          delivery.status,
          delivery.providerMessageId,
          delivery.warning ?? null,
          logged[0]!.id,
        ]);
        await tx.query("update action_run set status = 'done', completed_at = $1 where id = $2", [now, run[0]!.id]);
        await tx.query('update email_resend set resent_log_id = $1 where email_log_id = $2 and recipient = $3', [
          logged[0]!.id,
          logId,
          email,
        ]);
        await appendEvent(tx, {
          tenantId: args.tenantId,
          instanceId: row.instance_id,
          type: 'email_resent',
          payload: { template: template.key, to: email, skippedLogId: logId, status: delivery.status },
          actor: `actor:${args.actorId}`,
          now,
        });
        return { logId, sent: true };
      });
      out.push(result);
    } catch (err) {
      out.push({ logId, sent: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
