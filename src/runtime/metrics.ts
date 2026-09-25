import type { Blueprint } from '../blueprint/index.js';
import { inTransaction, type Client, type Pool } from './db.js';
import { require_, type Principal } from './policy.js';

/**
 * §13.1's nine operational metrics, and §13.2's rules about believing them.
 *
 * Everything here is computed from `event` and `instance` at read time. There
 * is no aggregate table, which is slower and satisfies §13.2's "events are
 * append-only, while derived aggregates can be rebuilt" by construction rather
 * than by a rebuild job that somebody has to remember to run. When this stops
 * being fast enough, the thing to add is a materialised view with the same
 * definitions — not a second definition.
 *
 * Two rules from §13.2 shape the output more than the arithmetic does:
 *
 * **Definitions are versioned and travel with the numbers.** A completion rate
 * means nothing without knowing what counted as eligible, and a dashboard that
 * shows 82% without saying so invites somebody to compare it against a number
 * computed differently last quarter. Every result carries the definition that
 * produced it.
 *
 * **Small cohorts are suppressed.** "100% of instances were rejected" over two
 * records identifies both of them, and a percentage over a handful of people
 * is a re-identification risk dressed as a statistic. Below the threshold the
 * count is shown and the rate is withheld, with the reason.
 */

export const METRICS_VERSION = 'metrics@1';

/** Below this, rates are withheld. §13.2's small cohort suppression. */
export const MIN_COHORT = 5;

export interface MetricDefinition {
  key: string;
  name: string;
  /** §13.2: shown beside the number, so two numbers can be compared honestly. */
  definition: string;
  unit: 'count' | 'percent' | 'hours';
}

export const DEFINITIONS: MetricDefinition[] = [
  { key: 'intake', name: 'Intake', unit: 'count', definition: 'Valid process instances created in the period. A draft that was never submitted is not an instance and is not counted.' },
  { key: 'completion_rate', name: 'Completion rate', unit: 'percent', definition: 'Instances that reached the blueprint\'s configured completion state, divided by instances created in the period that have since reached any terminal state. Still-running records are excluded from both sides rather than counted as failures.' },
  { key: 'cycle_time', name: 'Cycle time', unit: 'hours', definition: 'Hours from creation to completion, for instances completed in the period. Reported as median, 75th and 95th percentile — a mean hides the long tail that operators actually feel.' },
  { key: 'stage_aging', name: 'Stage aging', unit: 'hours', definition: 'Hours that currently-running instances have spent in their present state. Measured now, not over the period.' },
  { key: 'approval_time', name: 'Approval time', unit: 'hours', definition: 'Hours from an approval being requested to a terminal decision on it. A request still pending is not counted until it is decided.' },
  { key: 'rework_rate', name: 'Rework rate', unit: 'percent', definition: 'Instances that were returned for clarification at least once, divided by instances created in the period. Counted per instance, not per return, so one record sent back twice is one instance reworked.' },
  { key: 'automation_failure_rate', name: 'Automation failure rate', unit: 'percent', definition: 'Action runs that exhausted their retries, divided by action runs attempted. A transient failure that later succeeded is not a failure.' },
  { key: 'manual_touch_rate', name: 'Manual touch rate', unit: 'percent', definition: 'Instances where an operator did something the workflow did not do for them — a manual transition, a task completion, a record edit — divided by instances created in the period.' },
  { key: 'abandonment', name: 'Abandonment', unit: 'percent', definition: 'Saved drafts that did not become a submission within the window, divided by drafts started in the period. A draft is a respondent who began and stopped; this is the only metric about people who never became records.' },
];

export interface Measurement {
  key: string;
  name: string;
  unit: string;
  /** Null when suppressed. */
  value: number | null;
  /** For a rate: what it is out of. For a duration: how many observations. */
  of: number | null;
  /** Percentiles, for cycle time and approval time. */
  percentiles?: { p50: number; p75: number; p95: number } | null;
  /** Set when the number is withheld, saying why rather than showing a blank. */
  suppressed: string | null;
  definition: string;
}

export interface Dashboard {
  processKey: string;
  processName: string;
  /** §13.2: which versions the numbers span. */
  versions: number[];
  from: string;
  to: string;
  metricsVersion: string;
  minCohort: number;
  metrics: Measurement[];
  /** The blueprint's own declared metrics, and whether they are computable. */
  declared: { key: string; name: string; computed: boolean }[];
  /**
   * Where the open records are sitting, right now.
   *
   * Nine numbers say how the process is doing and none of them says *where*
   * the work is. This is the one an operator acts on: a state holding eleven
   * records, the oldest of them six days in, is a queue with a name.
   *
   * A count, not a rate — and of records this caller may already open one by
   * one in the console, so it discloses nothing the record list does not.
   */
  standing: {
    state: string;
    name: string;
    count: number;
    oldestHours: number;
    slaHours: number | null;
    /** Whether the oldest record in this state is past the state's own limit. */
    overdue: boolean;
  }[];
  /**
   * Arrivals and completions per bucket, over the period.
   *
   * Counts rather than rates, deliberately. A rate over a small bucket is the
   * disclosure `MIN_COHORT` exists to stop — "67% of this Tuesday's three
   * applications were rejected" describes three people. A count of how many
   * arrived says nothing about any of them, and it is what answers the
   * question a trend is asked: is this getting worse.
   */
  series: { bucket: string; label: string; arrived: number; finished: number }[];
  /** How wide each bucket is, so the chart can say so rather than imply it. */
  bucketDays: number;
}

/** A bucket's label, at the resolution the bucket actually has. */
function labelFor(bucket: Date, bucketDays: number): string {
  const day = bucket.getUTCDate();
  const month = bucket.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  if (bucketDays >= 30) return `${month} ${bucket.getUTCFullYear()}`;
  return `${day} ${month}`;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[index]! * 10) / 10;
}

/**
 * A rate, or the reason there isn't one.
 *
 * The cohort check is on the denominator, because that is the population being
 * described. Three completions out of four hundred is a fine statistic; three
 * out of four is a sentence about four identifiable people.
 */
function rate(numerator: number, denominator: number, definition: MetricDefinition): Measurement {
  const base = { key: definition.key, name: definition.name, unit: definition.unit, definition: definition.definition };
  if (denominator === 0) {
    return { ...base, value: null, of: 0, suppressed: 'nothing to measure in this period', percentiles: null };
  }
  if (denominator < MIN_COHORT) {
    return {
      ...base,
      value: null,
      of: denominator,
      suppressed: `only ${denominator} ${denominator === 1 ? 'record' : 'records'} — a percentage over fewer than ${MIN_COHORT} identifies them`,
      percentiles: null,
    };
  }
  return {
    ...base,
    value: Math.round((numerator / denominator) * 1000) / 10,
    of: denominator,
    suppressed: null,
    percentiles: null,
  };
}

export async function dashboard(
  pool: Pool,
  args: { principal: Principal; processKey: string; days?: number; now?: Date },
): Promise<Dashboard> {
  const days = args.days ?? 30;
  const now = args.now ?? new Date();
  const from = new Date(now.getTime() - days * 86_400_000);

  return inTransaction(pool, async (client) => {
    if (args.principal.kind === 'system') throw new Error('system principals do not read dashboards');
    const tenantId = args.principal.tenantId;

    const { rows: versions } = await client.query<{ blueprint: Blueprint; version: number }>(
      `select blueprint, version from process_version
        where tenant_id = $1 and process_key = $2 order by version desc`,
      [tenantId, args.processKey],
    );
    if (!versions[0]) throw new Error(`no published version of "${args.processKey}"`);
    const bp = versions[0].blueprint;

    // `report`, not `view`. A dashboard is an aggregate over everybody's
    // records, which is a different thing from being able to open one.
    await require_(
      client,
      { principal: args.principal, action: 'report', tenantId, processKey: args.processKey, blueprint: bp },
      pool,
    );

    const scope = [tenantId, args.processKey, from, now];
    const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = scope): Promise<T> => {
      const { rows } = await client.query<T>(sql, params);
      return rows[0]!;
    };

    const terminal = new Set(bp.workflow.states.filter((s) => s.type === 'terminal').map((s) => s.key));
    const completionState = bp.intent.completionState;

    // ---- intake
    const intake = await one<{ n: number }>(
      `select count(*)::int as n from instance
        where tenant_id = $1 and process_key = $2 and created_at >= $3 and created_at <= $4`,
    );

    // ---- completion rate: of those created in the period that have finished
    const settled = await one<{ finished: number; succeeded: number }>(
      `select count(*) filter (where state = any($5::text[]))::int as finished,
              count(*) filter (where state = $6)::int as succeeded
         from instance
        where tenant_id = $1 and process_key = $2 and created_at >= $3 and created_at <= $4`,
      [...scope, [...terminal], completionState],
    );

    // ---- cycle time, over completions in the period
    const { rows: cycles } = await client.query<{ hours: number }>(
      `select extract(epoch from (completed_at - created_at)) / 3600 as hours
         from instance
        where tenant_id = $1 and process_key = $2 and completed_at >= $3 and completed_at <= $4
        order by 1`,
      scope,
    );

    // ---- stage aging, measured now
    const { rows: aging } = await client.query<{ hours: number }>(
      `select extract(epoch from ($3::timestamptz - state_entered_at)) / 3600 as hours
         from instance
        where tenant_id = $1 and process_key = $2 and completed_at is null
        order by 1`,
      [tenantId, args.processKey, now],
    );

    // ---- approval time, request to terminal decision
    const { rows: approvals } = await client.query<{ hours: number }>(
      `select extract(epoch from (a.decided_at - a.created_at)) / 3600 as hours
         from approval_request a join instance i on i.id = a.instance_id
        where a.tenant_id = $1 and i.process_key = $2
          and a.decided_at >= $3 and a.decided_at <= $4
        order by 1`,
      scope,
    );

    /*
     * Rework, manual touch and abandonment all come from the event log rather
     * than from a column, because none of them is a property of a record — they
     * are things that happened to it. Adding a `was_reworked` flag would be
     * faster and would need backfilling every time the definition moved.
     */
    const rework = await one<{ n: number }>(
      `select count(distinct e.instance_id)::int as n
         from event e join instance i on i.id = e.instance_id
        where e.tenant_id = $1 and i.process_key = $2
          and i.created_at >= $3 and i.created_at <= $4
          and e.type = 'approval_decided' and e.payload ->> 'decision' = 'changes_requested'`,
    );

    const manual = await one<{ n: number }>(
      `select count(distinct e.instance_id)::int as n
         from event e join instance i on i.id = e.instance_id
        where e.tenant_id = $1 and i.process_key = $2
          and i.created_at >= $3 and i.created_at <= $4
          and (e.type in ('task_completed', 'record_updated', 'manual_action')
               or (e.type = 'approval_decided' and e.actor not like 'system:%'))`,
    );

    const automation = await one<{ attempted: number; failed: number }>(
      `select count(*)::int as attempted,
              count(*) filter (where o.attempts >= 5 and o.done_at is null)::int as failed
         from outbox o join instance i on i.id = o.instance_id
        where o.tenant_id = $1 and i.process_key = $2 and o.created_at >= $3 and o.created_at <= $4`,
    );

    /*
     * A draft belongs to a process version, not to a process key, so this
     * joins rather than filtering on a column that does not exist. The window
     * is a week: a form somebody saved yesterday is not abandoned, it is
     * unfinished, and counting it would make the metric a measure of how
     * recently the report was run.
     *
     * `$4::timestamptz` is load-bearing. Without the cast Postgres resolves the
     * parameter against the interval on the right and decides it is one —
     * exactly the fault ADR-0008 recorded in the outbox backoff, met again
     * here because nothing stops it recurring. Any parameter next to an
     * `interval` needs its type stated.
     */
    const drafts = await one<{ started: number; abandoned: number }>(
      `select count(*)::int as started,
              count(*) filter (
                where d.submitted_instance_id is null and d.updated_at < $4::timestamptz - interval '7 days'
              )::int as abandoned
         from draft d join process_version pv on pv.id = d.process_version_id
        where d.tenant_id = $1 and pv.process_key = $2 and d.created_at >= $3 and d.created_at <= $4`,
    );

    const duration = (key: string, raw: number[]): Measurement => {
      const d = DEFINITIONS.find((x) => x.key === key)!;
      const base = { key: d.key, name: d.name, unit: d.unit, definition: d.definition };

      /*
       * A duration cannot be negative, and one that is means the data is
       * wrong rather than the process slow.
       *
       * This dashboard reported a stage age of −301.9h. The cause was a bug
       * elsewhere — a simulated clock draining another tenant's timers, since
       * fixed — but the reporting is a separate fault: the number was averaged
       * in and shown as a percentile, stating something impossible with the
       * same confidence as everything beside it. A measure that can print an
       * impossibility is a measure nobody checks the rest of.
       *
       * Dropped and counted, not clamped to zero: clamping would quietly fold
       * a broken row into the distribution as "no time at all", which is a
       * second wrong answer with no trace.
       */
      const values = raw.filter((v) => Number.isFinite(v) && v >= 0);
      const impossible = raw.length - values.length;
      if (impossible > 0) {
        return {
          ...base,
          value: null,
          of: raw.length,
          percentiles: null,
          suppressed: `${impossible} of ${raw.length} ${impossible === 1 ? 'record is' : 'records are'} dated in the future — this cannot be measured until that is fixed`,
        };
      }

      if (!values.length) {
        return { ...base, value: null, of: 0, percentiles: null, suppressed: 'nothing to measure in this period' };
      }
      // A duration over a small cohort is not the same disclosure risk as a
      // percentage — it does not say what happened to whom — but a median over
      // two records is still a description of two records.
      if (values.length < MIN_COHORT) {
        return {
          ...base,
          value: null,
          of: values.length,
          percentiles: null,
          suppressed: `only ${values.length} ${values.length === 1 ? 'observation' : 'observations'} — fewer than ${MIN_COHORT}`,
        };
      }
      const sorted = [...values].sort((a, b) => a - b);
      return {
        ...base,
        value: percentile(sorted, 50),
        of: values.length,
        percentiles: { p50: percentile(sorted, 50), p75: percentile(sorted, 75), p95: percentile(sorted, 95) },
        suppressed: null,
      };
    };

    const byKey = (key: string) => DEFINITIONS.find((d) => d.key === key)!;

    const metrics: Measurement[] = [
      {
        ...byKey('intake'),
        unit: 'count',
        value: intake.n,
        of: null,
        suppressed: null,
        percentiles: null,
        definition: byKey('intake').definition,
      },
      rate(settled.succeeded, settled.finished, byKey('completion_rate')),
      duration('cycle_time', cycles.map((c) => Number(c.hours))),
      duration('stage_aging', aging.map((a) => Number(a.hours))),
      duration('approval_time', approvals.map((a) => Number(a.hours))),
      rate(rework.n, intake.n, byKey('rework_rate')),
      rate(automation.failed, automation.attempted, byKey('automation_failure_rate')),
      rate(manual.n, intake.n, byKey('manual_touch_rate')),
      rate(drafts.abandoned, drafts.started, byKey('abandonment')),
    ];

    /*
     * The blueprint declares its own dashboard metrics (§6 outputs). Saying
     * which of them this computes is more useful than silently showing nine
     * standard ones: a builder who asked for "time to first approval" should
     * see that it is not here rather than assume one of these is it.
     */
    const computable = new Set(DEFINITIONS.map((d) => d.key));
    // `kind` is the §13.1 metric it asks for; `key` is the builder's own name
    // for it on their dashboard. The question is whether the kind is computed.
    const declared = bp.outputs.dashboard.metrics.map((m) => ({
      key: m.key,
      name: m.name,
      computed: computable.has(m.kind),
    }));

    /*
     * Where the work is sitting. Read from the blueprint's states rather than
     * from whatever states happen to hold records, so a queue that has just
     * emptied still appears at zero — an empty step is information, and a step
     * that vanishes when it clears makes the shape of the process change
     * under the reader.
     */
    const { rows: standingRows } = await client.query<{
      state: string;
      count: number;
      oldest_hours: number;
    }>(
      `select i.state,
              count(*)::int as count,
              max(extract(epoch from ($3::timestamptz - i.state_entered_at)) / 3600) as oldest_hours
         from instance i
        where i.tenant_id = $1 and i.process_key = $2 and i.completed_at is null
        group by i.state`,
      [tenantId, args.processKey, now],
    );
    const standingByState = new Map(standingRows.map((r) => [r.state, r]));

    const standing = bp.workflow.states
      .filter((st) => st.type !== 'terminal')
      .map((st) => {
        const row = standingByState.get(st.key);
        const sla = typeof st.slaHours === 'number' ? st.slaHours : null;
        const oldest = row ? Math.max(0, Math.round(Number(row.oldest_hours) * 10) / 10) : 0;
        return {
          state: st.key,
          name: st.name,
          count: row?.count ?? 0,
          oldestHours: oldest,
          slaHours: sla,
          // Whether the *oldest* is past the limit. How many are late is a
          // question the work list already answers, per record, with a button
          // beside it — this page's job is to point at the queue.
          overdue: sla !== null && oldest > sla,
        };
      });

    /*
     * The trend. Bucket width follows the period so a chart never draws three
     * hundred and sixty-five columns nobody can read, and the width is
     * returned rather than inferred, because "per week" and "per day" are
     * different claims about the same shape.
     */
    const bucketDays = days <= 14 ? 1 : days <= 120 ? 7 : 30;
    const { rows: seriesRows } = await client.query<{ bucket: Date; arrived: number; finished: number }>(
      /*
       * `$3` is already the start of the window. Subtracting the window
       * length from it again drew two months of columns under a heading that
       * said thirty days — the chart and the footnote beneath it describing
       * different periods.
       */
      `with buckets as (
         select generate_series(
           date_trunc('day', $3::timestamptz),
           date_trunc('day', $4::timestamptz),
           make_interval(days => $5)
         ) as bucket
       )
       select b.bucket,
              (select count(*)::int from instance i
                where i.tenant_id = $1 and i.process_key = $2
                  and i.created_at >= greatest(b.bucket, $3::timestamptz)
                  and i.created_at < least(b.bucket + make_interval(days => $5), $4::timestamptz)) as arrived,
              (select count(*)::int from instance i
                where i.tenant_id = $1 and i.process_key = $2
                  and i.completed_at >= greatest(b.bucket, $3::timestamptz)
                  and i.completed_at < least(b.bucket + make_interval(days => $5), $4::timestamptz)) as finished
         from buckets b
        order by b.bucket`,
      [tenantId, args.processKey, from, now, bucketDays],
    );

    const series = seriesRows.map((r) => ({
      bucket: r.bucket.toISOString(),
      label: labelFor(r.bucket, bucketDays),
      arrived: r.arrived,
      finished: r.finished,
    }));

    return {
      processKey: args.processKey,
      processName: bp.name,
      versions: versions.map((v) => v.version).sort((a, b) => a - b),
      from: from.toISOString(),
      to: now.toISOString(),
      metricsVersion: METRICS_VERSION,
      minCohort: MIN_COHORT,
      metrics,
      declared,
      standing,
      series,
      bucketDays,
    };
  });
}
