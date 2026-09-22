import { inTransaction, type Client, type Pool } from './db.js';
import { require_, type Principal } from './policy.js';
import type { Blueprint } from '../blueprint/index.js';

/**
 * The trace, and the support view built on it.
 *
 * Two gates meet here. §20.2 observability wants *"every workflow action
 * [to have] traceable request, event, job, attempt, and result identifiers"*,
 * and §20.2 supportability wants *"support [to] diagnose a failed instance
 * without direct database modification"*.
 *
 * The second is the harder one, and it is a statement about what support is
 * given rather than what they are forbidden. Somebody handed a psql prompt
 * will use it, because the alternative is telling a customer "I can't see".
 * The way to stop that is to make the read they need easier than the query
 * they would write — and then there is no reason to hand out the prompt.
 *
 * So the trace answers the three questions a failed instance actually
 * produces: what happened, in what order, and which step failed and why. It
 * reads across five tables that nobody should have to join by hand, and it
 * returns identifiers rather than answers: a diagnosis needs to know *that*
 * an email was attempted four times, not what it said.
 */

export interface TraceStep {
  /** The originating request, which is the same across everything one call caused. */
  requestId: string;
  eventId: number;
  seq: number;
  type: string;
  actor: string | null;
  occurredAt: string;
  /** The outbox row, if the event scheduled work. */
  job: {
    id: number;
    transitionKey: string;
    attempts: number;
    claimedBy: string | null;
    doneAt: string | null;
    availableAt: string;
    lastError: string | null;
  } | null;
  /** One per action the job ran, each with its own attempts and outcome. */
  actions: {
    id: number;
    idempotencyKey: string;
    action: string;
    status: string;
    attempts: number;
    performedBy: string | null;
    completedAt: string | null;
    lastError: string | null;
    /** What the action produced, by kind and identifier. Never contents. */
    result: string | null;
  }[];
}

export interface InstanceTrace {
  instanceId: string;
  reference: string;
  processKey: string;
  state: string;
  stateName: string;
  outcome: string | null;
  createdAt: string;
  completedAt: string | null;
  /** The one-line answer to "what is wrong with this record". */
  diagnosis: string;
  steps: TraceStep[];
  /** Work that is still waiting, and why it has not run. */
  stuck: { jobId: number; transitionKey: string; attempts: number; availableAt: string; lastError: string | null }[];
}

function reference(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Everything that happened to one record, joined the way a person reads it.
 *
 * `view` rather than `administer`: this is a diagnosis, not an export, and an
 * operator who can open the record should be able to see why it is stuck
 * without escalating. Redaction is not needed because nothing here carries an
 * answer — the closest it comes is an email template key and a recipient
 * count.
 */
export async function traceForInstance(
  pool: Pool,
  args: { principal: Principal; instanceId: string },
): Promise<InstanceTrace> {
  return inTransaction(pool, async (client) => {
    const { rows: instances } = await client.query<{
      id: string;
      tenant_id: string;
      process_key: string;
      process_version_id: string;
      state: string;
      outcome: string | null;
      created_at: Date;
      completed_at: Date | null;
    }>(
      `select id, tenant_id, process_key, process_version_id, state, outcome, created_at, completed_at
         from instance where id = $1`,
      [args.instanceId],
    );
    const instance = instances[0];
    if (!instance) throw new Error('no such record');

    const { rows: versions } = await client.query<{ blueprint: Blueprint }>(
      'select blueprint from process_version where id = $1',
      [instance.process_version_id],
    );
    const bp = versions[0]!.blueprint;

    await require_(
      client,
      {
        principal: args.principal,
        action: 'view',
        tenantId: instance.tenant_id,
        processKey: instance.process_key,
        blueprint: bp,
        instanceId: instance.id,
      },
      pool,
    );

    const steps = await stepsFor(client, instance.id);

    const { rows: stuck } = await client.query<{
      id: number;
      transition_key: string;
      attempts: number;
      available_at: Date;
      last_error: string | null;
    }>(
      `select id, transition_key, attempts, available_at, last_error
         from outbox where instance_id = $1 and done_at is null order by id`,
      [instance.id],
    );

    const state = bp.workflow.states.find((s) => s.key === instance.state);

    return {
      instanceId: instance.id,
      reference: reference(instance.id),
      processKey: instance.process_key,
      state: instance.state,
      stateName: state?.name ?? instance.state,
      outcome: instance.outcome,
      createdAt: instance.created_at.toISOString(),
      completedAt: iso(instance.completed_at),
      diagnosis: diagnose(instance, state, steps, stuck),
      steps,
      stuck: stuck.map((s) => ({
        jobId: s.id,
        transitionKey: s.transition_key,
        attempts: s.attempts,
        availableAt: s.available_at.toISOString(),
        lastError: s.last_error,
      })),
    };
  });
}

async function stepsFor(client: Client, instanceId: string): Promise<TraceStep[]> {
  const { rows: events } = await client.query<{
    id: number;
    seq: number;
    type: string;
    actor: string | null;
    request_id: string;
    occurred_at: Date;
  }>(
    'select id, seq, type, actor, request_id, occurred_at from event where instance_id = $1 order by seq',
    [instanceId],
  );

  const { rows: jobs } = await client.query<{
    id: number;
    event_id: number;
    transition_key: string;
    attempts: number;
    claimed_by: string | null;
    done_at: Date | null;
    available_at: Date;
    last_error: string | null;
  }>(
    `select id, event_id, transition_key, attempts, claimed_by, done_at, available_at, last_error
       from outbox where instance_id = $1`,
    [instanceId],
  );
  const jobByEvent = new Map(jobs.map((j) => [j.event_id, j]));

  const { rows: runs } = await client.query<{
    id: number;
    idempotency_key: string;
    action_do: string;
    status: string;
    attempts: number;
    performed_by: string | null;
    completed_at: Date | null;
    last_error: string | null;
    result: unknown;
  }>(
    `select id, idempotency_key, action_do, status, attempts, performed_by, completed_at, last_error, result
       from action_run where instance_id = $1 order by id`,
    [instanceId],
  );

  /*
   * An action run is tied to its event through the idempotency key, which is
   * `transitionKey:actionKey:eventId` — the key was built that way for
   * correctness (ADR-0002), and it turns out to carry the correlation for free.
   * Parsing it here rather than adding an `event_id` column keeps one source of
   * truth for what an action belongs to.
   */
  const runsByEvent = new Map<number, typeof runs>();
  for (const run of runs) {
    const eventId = Number(run.idempotency_key.split(':').pop());
    if (!Number.isFinite(eventId)) continue;
    const list = runsByEvent.get(eventId) ?? [];
    list.push(run);
    runsByEvent.set(eventId, list);
  }

  return events.map((event) => {
    const job = jobByEvent.get(event.id);
    return {
      requestId: event.request_id,
      eventId: event.id,
      seq: event.seq,
      type: event.type,
      actor: event.actor,
      occurredAt: event.occurred_at.toISOString(),
      job: job
        ? {
            id: job.id,
            transitionKey: job.transition_key,
            attempts: job.attempts,
            claimedBy: job.claimed_by,
            doneAt: iso(job.done_at),
            availableAt: job.available_at.toISOString(),
            lastError: job.last_error,
          }
        : null,
      actions: (runsByEvent.get(event.id) ?? []).map((run) => ({
        id: run.id,
        idempotencyKey: run.idempotency_key,
        action: run.action_do,
        status: run.status,
        attempts: run.attempts,
        performedBy: run.performed_by,
        completedAt: iso(run.completed_at),
        lastError: run.last_error,
        result: describeResult(run.result),
      })),
    };
  });
}

/** What an action produced, as a kind and an identifier. Never the contents. */
function describeResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const parts = Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return parts.join(' ').slice(0, 200) || null;
}

/**
 * The sentence support reads first.
 *
 * A trace is only useful if somebody can act on it, and a list of forty events
 * is not an answer to "why has this been sitting for three days". The order
 * here is the order of usefulness: a permanent failure outranks a retry,
 * a retry outranks a wait, and a record doing exactly what it should say so
 * plainly rather than being described in a way that sounds like a problem.
 */
/*
 * "1 time(s)" is a programmer writing for a compiler. This line is read by
 * somebody explaining to an applicant why their form has not moved, and
 * sometimes by an auditor.
 */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function diagnose(
  instance: { completed_at: Date | null; outcome: string | null; state: string },
  state: { name: string; type: string; slaHours?: number } | undefined,
  steps: TraceStep[],
  stuck: { attempts: number; last_error: string | null; transition_key: string }[],
): string {
  const exhausted = stuck.filter((s) => s.attempts >= 5);
  if (exhausted.length) {
    return `Stopped: "${exhausted[0]!.transition_key}" has failed ${exhausted[0]!.attempts} times and is no longer being retried — ${exhausted[0]!.last_error ?? 'no reason recorded'}. It is safe to replay once the cause is fixed.`;
  }

  const retrying = stuck.filter((s) => s.last_error);
  if (retrying.length) {
    return `Retrying: "${retrying[0]!.transition_key}" has failed ${plural(retrying[0]!.attempts, 'time')} and will be attempted again — ${retrying[0]!.last_error}.`;
  }

  if (stuck.length) {
    return `Queued: ${plural(stuck.length, 'job')} scheduled and not yet run. If this does not clear, no worker is running.`;
  }

  const failedActions = steps.flatMap((s) => s.actions).filter((a) => a.status !== 'done');
  if (failedActions.length) {
    return `An action did not complete: ${failedActions[0]!.action} (${failedActions[0]!.idempotencyKey}) is "${failedActions[0]!.status}".`;
  }

  if (instance.completed_at) {
    return `Finished as "${instance.outcome ?? 'unknown'}". Every job ran and every action completed.`;
  }

  return `Waiting in "${state?.name ?? instance.state}". Nothing is queued and nothing has failed, so it is waiting on a person or a timer — not on the runtime.`;
}

/**
 * Everything one request caused, across every record it touched.
 *
 * The other direction from `traceForInstance`, and the one a support call
 * actually starts with: a customer quotes the id from an error message and
 * wants to know what happened. A submission can touch one record; a confirmed
 * bulk reminder touches fifty, and seeing them together is the point.
 */
export async function traceByRequest(
  pool: Pool,
  args: { principal: Principal; requestId: string },
): Promise<{ requestId: string; records: { instanceId: string; reference: string; steps: TraceStep[] }[] }> {
  if (args.principal.kind !== 'actor') throw new Error('tracing is for signed-in members');
  const tenantId = args.principal.tenantId;

  // Tenant-scoped by the query, not by a check afterwards: a request id from
  // another workspace resolves to nothing rather than to a refusal, because
  // confirming that an id exists elsewhere is itself a disclosure.
  const { rows } = await pool.query<{ instance_id: string }>(
    `select distinct instance_id from (
       select instance_id from event    where tenant_id = $1 and request_id = $2
       union all
       select instance_id from outbox   where tenant_id = $1 and request_id = $2
       union all
       select instance_id from action_run where tenant_id = $1 and request_id = $2
     ) t`,
    [tenantId, args.requestId],
  );

  const records = [];
  for (const row of rows) {
    const trace = await traceForInstance(pool, { principal: args.principal, instanceId: row.instance_id });
    records.push({
      instanceId: trace.instanceId,
      reference: trace.reference,
      // Only the steps this request caused. The rest of the record's history
      // belongs to other requests and is noise here.
      steps: trace.steps.filter((s) => s.requestId === args.requestId),
    });
  }

  return { requestId: args.requestId, records };
}
