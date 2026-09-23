import type { Blueprint } from '../blueprint/index.js';
import { inTransaction, type Pool } from './db.js';
import { require_, type Principal } from './policy.js';
import { queueReceiptDeletions } from './receipt-files.js';

/**
 * §9.2 and §12.1's data lifecycle: "Configurable retention, deletion jobs,
 * export, backup expiry."
 *
 * ADR-0004 recorded this as the open end of making history append-only: the
 * triggers that stop a support engineer rewriting a decision also stop
 * legitimate deletion, so a retention promise could not be kept. Deleting
 * nothing is the safe failure, but it is still a failure — a customer told
 * "we keep this for seven years" is owed the deletion at year seven.
 *
 * So there is exactly one door, and it is deliberately awkward:
 *
 *   - the caller must hold `administer`, and the refusal is audited like any
 *     other;
 *   - the retention period comes from the published blueprint, not from an
 *     argument, so nobody deletes faster than the process promised;
 *   - a `retention_run` row is written BEFORE the delete, in the same
 *     transaction, so the record of what was removed outlives the data;
 *   - the trigger bypass is a transaction-local setting, so it cannot leak to
 *     any other statement on any other connection.
 *
 * `preview: true` runs the whole thing and rolls back, which is the only
 * honest way to answer "what would this delete?".
 */

export interface RetentionResult {
  processKey: string;
  retentionDays: number;
  instances: number;
  events: number;
  oldest: string | null;
  newest: string | null;
  preview: boolean;
}

class Rollback extends Error {}

export async function runRetention(
  pool: Pool,
  args: { principal: Principal; tenantId: string; processKey: string; preview?: boolean; now?: Date },
): Promise<RetentionResult> {
  const preview = args.preview ?? false;
  const now = args.now ?? new Date();

  const run = async () =>
    inTransaction(pool, async (client) => {
      const { rows: versions } = await client.query<{ blueprint: Blueprint }>(
        `select blueprint from process_version
          where tenant_id = $1 and process_key = $2 order by version desc limit 1`,
        [args.tenantId, args.processKey],
      );
      if (!versions.length) throw new Error(`no published version of "${args.processKey}"`);
      const bp = versions[0]!.blueprint;

      await require_(
        client,
        {
          principal: args.principal,
          action: 'administer',
          tenantId: args.tenantId,
          processKey: args.processKey,
          blueprint: bp,
        },
        pool,
      );

      const retentionDays = bp.intent.retentionDays;
      if (!retentionDays) {
        throw new Error(
          `"${args.processKey}" declares no retention period, so nothing may be deleted under it`,
        );
      }

      // Only finished records. A record still running is not old, however long
      // ago it started.
      const { rows: doomed } = await client.query<{ id: string; completed_at: Date }>(
        `select id, completed_at from instance
          where tenant_id = $1 and process_key = $2
            and completed_at is not null
            and completed_at < $3::timestamptz - make_interval(days => $4)
          order by completed_at`,
        [args.tenantId, args.processKey, now, retentionDays],
      );

      const ids = doomed.map((d) => d.id);
      const result: RetentionResult = {
        processKey: args.processKey,
        retentionDays,
        instances: ids.length,
        events: 0,
        oldest: doomed[0]?.completed_at.toISOString() ?? null,
        newest: doomed.at(-1)?.completed_at.toISOString() ?? null,
        preview,
      };

      if (!ids.length) {
        if (preview) throw new Rollback();
        return result;
      }

      const { rows: eventCount } = await client.query<{ count: number }>(
        'select count(*)::int as count from event where instance_id = any($1::uuid[])',
        [ids],
      );
      result.events = eventCount[0]!.count;

      // The account of the deletion is written first and is not itself
      // deletable by this procedure.
      await client.query(
        `insert into retention_run
           (tenant_id, process_key, retention_days, instances_deleted, events_deleted,
            oldest_removed, newest_removed, run_by, ran_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          args.tenantId,
          args.processKey,
          retentionDays,
          result.instances,
          result.events,
          result.oldest,
          result.newest,
          preview ? `${describe(args.principal)} (preview)` : describe(args.principal),
          now,
        ],
      );

      // Transaction-local: it reverts at commit or rollback and is invisible
      // to every other connection.
      await client.query("set local patform.retention_run = 'on'");

      // Children first; `event` is the one the trigger guards.
      await client.query('delete from email_log where instance_id = any($1::uuid[])', [ids]);
      await client.query('delete from webhook_delivery where instance_id = any($1::uuid[])', [ids]);
      await client.query('delete from document where instance_id = any($1::uuid[])', [ids]);
      await client.query('delete from task where instance_id = any($1::uuid[])', [ids]);
      await client.query('delete from approval_request where instance_id = any($1::uuid[])', [ids]);
      await client.query('delete from timer where instance_id = any($1::uuid[])', [ids]);
      await client.query('delete from resume_token where instance_id = any($1::uuid[])', [ids]);
      await client.query('delete from outbox where instance_id = any($1::uuid[])', [ids]);
      await client.query('delete from action_run where instance_id = any($1::uuid[])', [ids]);
      await queueReceiptDeletions(client, ids);
      await client.query('delete from event where instance_id = any($1::uuid[])', [ids]);
      await client.query('delete from instance where id = any($1::uuid[])', [ids]);

      if (preview) throw new Rollback();
      return result;
    });

  try {
    return await run();
  } catch (err) {
    if (err instanceof Rollback) {
      // The preview did the work and threw it away. Re-derive the counts
      // cheaply for the answer.
      return previewCounts(pool, args, now);
    }
    throw err;
  }
}

async function previewCounts(
  pool: Pool,
  args: { tenantId: string; processKey: string },
  now: Date,
): Promise<RetentionResult> {
  const { rows: versions } = await pool.query<{ blueprint: Blueprint }>(
    `select blueprint from process_version where tenant_id = $1 and process_key = $2
      order by version desc limit 1`,
    [args.tenantId, args.processKey],
  );
  const retentionDays = versions[0]!.blueprint.intent.retentionDays ?? 0;
  const { rows } = await pool.query<{
    instances: number;
    events: number;
    oldest: Date | null;
    newest: Date | null;
  }>(
    `with doomed as (
       select id, completed_at from instance
        where tenant_id = $1 and process_key = $2 and completed_at is not null
          and completed_at < $3::timestamptz - make_interval(days => $4)
     )
     select (select count(*)::int from doomed) as instances,
            (select count(*)::int from event where instance_id in (select id from doomed)) as events,
            (select min(completed_at) from doomed) as oldest,
            (select max(completed_at) from doomed) as newest`,
    [args.tenantId, args.processKey, now, retentionDays],
  );
  return {
    processKey: args.processKey,
    retentionDays,
    instances: rows[0]!.instances,
    events: rows[0]!.events,
    oldest: rows[0]!.oldest?.toISOString() ?? null,
    newest: rows[0]!.newest?.toISOString() ?? null,
    preview: true,
  };
}

/** Expired sessions and resume tokens are not evidence; the worker clears them. */
export async function sweepExpiredTokens(pool: Pool): Promise<number> {
  const sessions = await pool.query('delete from session where expires_at < now() - interval \'30 days\'');
  const resumes = await pool.query('delete from resume_token where expires_at < now() - interval \'30 days\'');
  return (sessions.rowCount ?? 0) + (resumes.rowCount ?? 0);
}

function describe(principal: Principal): string {
  return principal.kind === 'actor' ? `actor:${principal.actorId}` : `${principal.kind}`;
}
