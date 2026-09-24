import type { Blueprint } from '../blueprint/index.js';
import { answerText } from '../blueprint/display.js';
import type { Client, Pool } from './db.js';
import { inTransaction } from './db.js';
import { authorize, redact, require_, type Principal } from './policy.js';

/**
 * The reads behind the operator console.
 *
 * §8.2: "The default home screen should answer four questions: what arrived,
 * what requires me, what is late, and what failed. Avoid presenting a generic
 * analytics dashboard before actionable work."
 *
 * Every read here authorizes first and redacts on the way out, so the console
 * cannot become a side door around the policy engine.
 */

export interface WorkSummary {
  processKey: string;
  processName: string;
  counts: { arrived: number; needsYou: number; late: number; failed: number };
  approvals: {
    instanceId: string;
    reference: string;
    approvalKey: string;
    approvalName: string;
    state: string;
    stateName: string;
    waitingHours: number;
    dueAt: string | null;
    late: boolean;
    summary: string;
    /** How far a sequence or a quorum has got. Null when one decision settles it. */
    progress: { have: number; need: number; against?: number; of?: number } | null;
  }[];
  tasks: {
    instanceId: string;
    reference: string;
    taskKey: string;
    taskName: string;
    description?: string;
    assignee: string | null;
    dueAt: string | null;
    late: boolean;
    summary: string;
  }[];
}

/** A short human label for a record, from whatever the process collects. */
function summarise(bp: Blueprint, data: Record<string, unknown>): string {
  // Prefer a name-ish field, then any short text the respondent gave.
  const candidates = bp.data.fields.filter(
    (f) => ['short_text', 'email'].includes(f.type) && f.setBy !== 'system',
  );
  const named = candidates.find((f) => /name/.test(f.key)) ?? candidates[0];
  const value = named ? data[named.key] : undefined;
  return typeof value === 'string' && value !== '[redacted]' ? value : '(no label)';
}

function reference(instanceId: string): string {
  return instanceId.slice(0, 8).toUpperCase();
}

async function loadBlueprintFor(client: Client, tenantId: string, processKey: string): Promise<Blueprint> {
  const { rows } = await client.query<{ blueprint: Blueprint }>(
    `select blueprint from process_version
      where tenant_id = $1 and process_key = $2
      order by version desc limit 1`,
    [tenantId, processKey],
  );
  if (!rows.length) throw new Error(`no published version of "${processKey}"`);
  return rows[0]!.blueprint;
}

/** Processes this person holds any role in, or may see through their workspace role. */
export async function processesFor(pool: Pool, tenantId: string, actorId: string) {
  const { rows } = await pool.query<{
    process_key: string;
    name: string;
    version: number;
    open_records: number;
    roles: string[];
    public_id: string | null;
  }>(
    `with latest as (
       select distinct on (process_key) process_key, version, blueprint
         from process_version where tenant_id = $1
         order by process_key, version desc
     )
     select l.process_key,
            l.blueprint ->> 'name' as name,
            l.version,
            (select count(*)::int from instance i
              where i.tenant_id = $1 and i.process_key = l.process_key and i.completed_at is null) as open_records,
            coalesce((select array_agg(m.role_key) from membership m
              where m.tenant_id = $1 and m.actor_id = $2 and m.process_key = l.process_key), '{}') as roles,
            (select f.public_id from public_form f
              where f.tenant_id = $1 and f.process_key = l.process_key) as public_id
       from latest l
       order by l.process_key`,
    [tenantId, actorId],
  );
  return rows;
}

export async function myWork(
  pool: Pool,
  args: { principal: Principal; actorId: string; processKey: string },
): Promise<WorkSummary> {
  return inTransaction(pool, async (client) => {
    if (args.principal.kind !== 'actor') throw new Error('my work is for signed-in members');
    const tenantId = args.principal.tenantId;
    const bp = await loadBlueprintFor(client, tenantId, args.processKey);

    const decision = await require_(
      client,
      { principal: args.principal, action: 'view', tenantId, processKey: args.processKey, blueprint: bp },
      pool,
    );

    const { rows: actorRows } = await client.query<{ email: string }>(
      'select email from actor where id = $1',
      [args.actorId],
    );
    const email = actorRows[0]?.email ?? '';
    const addresses = [email, ...decision.roles.map((r) => `role:${r}`)];

    const stateName = (key: string) => bp.workflow.states.find((s) => s.key === key)?.name ?? key;

    // ---- what requires me: approvals this record actually names me on
    const { rows: pendingRows } = await client.query<{
      instance_id: string;
      approval_key: string;
      created_at: Date;
      due_at: Date | null;
      state: string;
      data: Record<string, unknown>;
      mode: string;
      approvers: string[];
      required: number | null;
      electorate: number | null;
      voters: string[];
      approved: number;
      against: number;
    }>(
      `select a.instance_id, a.approval_key, a.created_at, a.due_at, i.state, i.data,
              a.mode, a.approvers, a.required, a.electorate,
              (select count(*)::int from approval_vote v where v.request_id = a.id and v.decision = 'rejected') as against,
              coalesce((select array_agg(v.actor) from approval_vote v where v.request_id = a.id), '{}') as voters,
              (select count(*)::int from approval_vote v where v.request_id = a.id and v.decision = 'approved') as approved
         from approval_request a
         join instance i on i.id = a.instance_id
        where a.tenant_id = $1
          and i.process_key = $2
          and a.status = 'pending'
          and a.approvers && $3::text[]
        order by a.created_at`,
      [tenantId, args.processKey, addresses],
    );

    /*
     * Only what I can act on now. In a sequence that is the approver whose
     * turn it is; in a quorum it is anybody named who has not decided yet. A
     * queue that listed a record I cannot decide — because it is not my turn,
     * or because I already have — sends me to a button that refuses.
     */
    const me = `actor:${args.actorId}`;
    const approvalRows = pendingRows.filter((row) => {
      if (row.voters.includes(me)) return false;
      if (row.mode === 'sequential') return addresses.includes(row.approvers[row.approved] ?? '');
      return true;
    });

    const now = Date.now();
    const approvals = approvalRows.map((row) => ({
      instanceId: row.instance_id,
      reference: reference(row.instance_id),
      approvalKey: row.approval_key,
      approvalName: bp.workflow.approvals.find((a) => a.key === row.approval_key)?.name ?? row.approval_key,
      allowRequestChanges: bp.workflow.approvals.find((a) => a.key === row.approval_key)?.allowRequestChanges ?? false,
      state: row.state,
      stateName: stateName(row.state),
      waitingHours: Math.round((now - row.created_at.getTime()) / 3_600_000),
      dueAt: row.due_at?.toISOString() ?? null,
      late: Boolean(row.due_at && row.due_at.getTime() < now),
      summary: summarise(bp, redact(bp, decision.roles, row.data, decision.workspaceRole)),
      /** How far a multi-person approval has got: "1 of 2 approved". */
      progress:
        row.mode === 'majority'
          ? { have: row.approved, need: row.required ?? 1, against: row.against, of: row.electorate ?? 0 }
          : row.mode === 'quorum' || row.mode === 'sequential'
            ? { have: row.approved, need: row.mode === 'quorum' ? (row.required ?? 2) : row.approvers.length }
            : null,
    }));

    // ---- and tasks I may complete, per each task's own rule
    const { rows: taskRows } = await client.query<{
      instance_id: string;
      task_key: string;
      assignee: string | null;
      due_at: Date | null;
      data: Record<string, unknown>;
    }>(
      `select t.instance_id, t.task_key, t.assignee, t.due_at, i.data
         from task t
         join instance i on i.id = t.instance_id
        where t.tenant_id = $1 and i.process_key = $2 and t.status = 'open'
        order by t.created_at`,
      [tenantId, args.processKey],
    );

    const tasks = [];
    for (const row of taskRows) {
      const declared = bp.workflow.tasks.find((t) => t.key === row.task_key);
      const { allowed } = await authorize(client, {
        principal: args.principal,
        action: 'operate',
        tenantId,
        processKey: args.processKey,
        blueprint: bp,
        instanceId: row.instance_id,
        task: { assignee: row.assignee, completableBy: declared?.completableBy ?? 'assignee' },
      });
      if (!allowed) continue;
      tasks.push({
        instanceId: row.instance_id,
        reference: reference(row.instance_id),
        taskKey: row.task_key,
        taskName: declared?.name ?? row.task_key,
        description: declared?.description,
        requiredFields: (declared?.requiredFields ?? []).map((key) => {
          const field = bp.data.fields.find((f) => f.key === key);
          return { key, label: field?.label ?? key, type: field?.type ?? 'short_text' };
        }),
        assignee: row.assignee,
        dueAt: row.due_at?.toISOString() ?? null,
        late: Boolean(row.due_at && row.due_at.getTime() < now),
        summary: summarise(bp, redact(bp, decision.roles, row.data, decision.workspaceRole)),
      });
    }

    // ---- what arrived, what is late, what failed
    const { rows: counts } = await client.query<{ arrived: number; late: number; failed: number }>(
      `select
         (select count(*)::int from instance
           where tenant_id = $1 and process_key = $2 and created_at > now() - interval '30 days') as arrived,
         (select count(*)::int from instance i
           where i.tenant_id = $1 and i.process_key = $2 and i.completed_at is null
             and exists (
               select 1 from jsonb_array_elements($3::jsonb) s
                where s ->> 'key' = i.state
                  and (s ->> 'slaHours') is not null
                  and i.state_entered_at + make_interval(hours => (s ->> 'slaHours')::int) < now()
             )) as late,
         (select count(*)::int from outbox o
           join instance i on i.id = o.instance_id
          where o.tenant_id = $1 and i.process_key = $2
            and o.done_at is null and o.last_error is not null) as failed`,
      [tenantId, args.processKey, JSON.stringify(bp.workflow.states)],
    );

    return {
      processKey: args.processKey,
      processName: bp.name,
      counts: {
        arrived: counts[0]!.arrived,
        needsYou: approvals.length + tasks.length,
        late: counts[0]!.late,
        failed: counts[0]!.failed,
      },
      approvals,
      tasks,
    };
  });
}

export async function listRecords(
  pool: Pool,
  args: { principal: Principal; processKey: string; state?: string; limit: number },
) {
  return inTransaction(pool, async (client) => {
    if (args.principal.kind === 'system') throw new Error('system principals do not browse');
    const tenantId = args.principal.tenantId;
    const bp = await loadBlueprintFor(client, tenantId, args.processKey);
    const decision = await require_(
      client,
      { principal: args.principal, action: 'view', tenantId, processKey: args.processKey, blueprint: bp },
      pool,
    );

    const { rows } = await client.query<{
      id: string;
      state: string;
      data: Record<string, unknown>;
      outcome: string | null;
      created_at: Date;
      state_entered_at: Date;
      completed_at: Date | null;
    }>(
      `select id, state, data, outcome, created_at, state_entered_at, completed_at
         from instance
        where tenant_id = $1 and process_key = $2
          and ($3::text is null or state = $3)
        order by state_entered_at desc
        limit $4`,
      [tenantId, args.processKey, args.state ?? null, Math.min(args.limit, 200)],
    );

    const now = Date.now();
    return rows.map((row) => {
      const state = bp.workflow.states.find((s) => s.key === row.state);
      const sla = state?.slaHours;
      return {
        id: row.id,
        reference: reference(row.id),
        summary: summarise(bp, redact(bp, decision.roles, row.data, decision.workspaceRole)),
        state: row.state,
        stateName: state?.name ?? row.state,
        outcome: row.outcome,
        hoursInState: Math.round((now - row.state_entered_at.getTime()) / 3_600_000),
        late: Boolean(sla && row.state_entered_at.getTime() + sla * 3_600_000 < now),
        createdAt: row.created_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
      };
    });
  });
}

/** §8.2's record view: current state, owner, next action, timeline, decisions. */
/** `role:hr_admin` is an assignment. "the hr_admin role" is a sentence. */
function named(party: string | null | undefined): string {
  if (!party) return 'nobody';
  if (party.startsWith('role:')) return `the ${party.slice(5)} role`;
  if (party.startsWith('user:')) return party.slice(5);
  if (party.startsWith('actor:')) return party.slice(6);
  return party;
}

export async function recordDetail(pool: Pool, principal: Principal, instanceId: string) {
  return inTransaction(pool, async (client) => {
    const { rows: instances } = await client.query<{
      id: string;
      tenant_id: string;
      process_key: string;
      process_version_id: string;
      state: string;
      data: Record<string, unknown>;
      assignee: string | null;
      outcome: string | null;
      created_at: Date;
      state_entered_at: Date;
      completed_at: Date | null;
    }>('select * from instance where id = $1', [instanceId]);
    const instance = instances[0];
    if (!instance) throw new Error('no such record');

    const { rows: versions } = await client.query<{ blueprint: Blueprint; version: number }>(
      'select blueprint, version from process_version where id = $1',
      [instance.process_version_id],
    );
    const bp = versions[0]!.blueprint;

    const decision = await require_(
      client,
      {
        principal,
        action: 'view',
        tenantId: instance.tenant_id,
        processKey: instance.process_key,
        blueprint: bp,
        instanceId,
      },
      pool,
    );

    const visible = redact(bp, decision.roles, instance.data, decision.workspaceRole);
    const state = bp.workflow.states.find((s) => s.key === instance.state);

    const [events, approvals, tasks, emails, documents] = await Promise.all([
      client.query('select seq, type, payload, actor, occurred_at from event where instance_id = $1 order by seq desc', [instanceId]),
      client.query('select approval_key, approvers, status, decision, decided_by, decided_at, reason, due_at from approval_request where instance_id = $1 order by id', [instanceId]),
      client.query('select task_key, assignee, status, due_at, completed_at, completed_by from task where instance_id = $1 order by id', [instanceId]),
      client.query('select template_key, recipients, subject, status, sent_at from email_log where instance_id = $1 order by id', [instanceId]),
      client.query('select document_key, filename, checksum, created_at from document where instance_id = $1 order by id', [instanceId]),
    ]);

    /*
     * What the record is waiting for, in words — and "in words" has to include
     * who. An assignee is stored as `role:hr_admin`, which is the correct
     * assignment and not a sentence. This is the only place the sentence is
     * built, so it is the right place to open it out: the console, the export
     * and the API all read the same string.
     */
    const pending = approvals.rows.find((a) => a.status === 'pending');
    const openTask = tasks.rows.find((t) => t.status === 'open');
    const nextAction = pending
      ? `${bp.workflow.approvals.find((a) => a.key === pending.approval_key)?.name ?? pending.approval_key} — with ${pending.approvers.map(named).join(', ')}`
      : openTask
        ? `${bp.workflow.tasks.find((t) => t.key === openTask.task_key)?.name ?? openTask.task_key} — assigned to ${named(openTask.assignee)}`
        : instance.completed_at
          ? 'Finished'
          : 'Waiting on a timer';

    return {
      id: instance.id,
      // The console needs the id as well as the reference: the reference is
      // for people, the id is what the export endpoint takes.
      instanceId: instance.id,
      reference: reference(instance.id),
      processKey: instance.process_key,
      processName: bp.name,
      version: versions[0]!.version,
      state: instance.state,
      stateName: state?.name ?? instance.state,
      stateType: state?.type ?? 'active',
      publicLabel: state?.publicLabel ?? null,
      outcome: instance.outcome,
      assignee: instance.assignee,
      nextAction,
      createdAt: instance.created_at.toISOString(),
      completedAt: instance.completed_at?.toISOString() ?? null,
      // Field labels come from the version that governs this record, not the
      // latest one, so an old record reads the way it was decided.
      fields: bp.data.fields
        .filter((f) => f.type !== 'content')
        .map((f) => {
          const value = visible[f.key] ?? null;
          const hidden = value === '[redacted]';
          // The answer in words, and a repeating group as a small table, so
          // the page shows "Receiving the money" and "£3,000.00" rather than
          // the stored key and number.
          const rows = f.type === 'repeating_group' && Array.isArray(value) ? (value as Record<string, unknown>[]) : null;
          return {
            key: f.key,
            label: f.label,
            classification: f.classification,
            value,
            text: hidden || value === null ? null : answerText(f, value),
            ...(rows && f.fields
              ? {
                  table: {
                    columns: f.fields.map((c) => c.label),
                    rows: rows.map((r) => f.fields!.map((c) => answerText(c, r?.[c.key]))),
                    references: rows.map((r) => f.fields!.map((c) => c.type === 'file' ? r?.[c.key] ?? null : null)),
                  },
                }
              : {}),
          };
        }),
      events: events.rows,
      approvals: approvals.rows,
      tasks: tasks.rows,
      emails: emails.rows,
      documents: documents.rows,
      viewerRoles: decision.roles,
    };
  });
}

/** §8.2's automation health: runs, retries, failures, suppressed duplicates. */
export async function automationHealth(
  pool: Pool,
  args: { principal: Principal; processKey: string },
) {
  return inTransaction(pool, async (client) => {
    if (args.principal.kind === 'system') throw new Error('system principals do not browse');
    const tenantId = args.principal.tenantId;
    const bp = await loadBlueprintFor(client, tenantId, args.processKey);
    await require_(
      client,
      { principal: args.principal, action: 'report', tenantId, processKey: args.processKey, blueprint: bp },
      pool,
    );

    const { rows: totals } = await client.query<{
      runs: number;
      retried: number;
      suppressed: number;
      failing: number;
    }>(
      `select
         (select count(*)::int from action_run r join instance i on i.id = r.instance_id
           where r.tenant_id = $1 and i.process_key = $2) as runs,
         (select count(*)::int from action_run r join instance i on i.id = r.instance_id
           where r.tenant_id = $1 and i.process_key = $2 and r.attempts > 1) as retried,
         (select coalesce(sum(r.attempts - 1), 0)::int from action_run r join instance i on i.id = r.instance_id
           where r.tenant_id = $1 and i.process_key = $2 and r.status = 'done' and r.attempts > 1) as suppressed,
         (select count(*)::int from outbox o join instance i on i.id = o.instance_id
           where o.tenant_id = $1 and i.process_key = $2 and o.done_at is null and o.last_error is not null)
         + (select count(*)::int from email_log e join instance i on i.id = e.instance_id
             where e.tenant_id = $1 and i.process_key = $2 and e.status = 'failed') as failing`,
      [tenantId, args.processKey],
    );

    const { rows: failures } = await client.query<{
      id: number;
      instance_id: string;
      transition_key: string;
      attempts: number;
      last_error: string;
      available_at: Date;
    }>(
      `select o.id, o.instance_id, o.transition_key, o.attempts, o.last_error, o.available_at
         from outbox o join instance i on i.id = o.instance_id
        where o.tenant_id = $1 and i.process_key = $2
          and o.done_at is null and o.last_error is not null
        union all
        -- A send the provider refused outright never reaches the outbox's
        -- error column, because retrying it would fail the same way forever.
        select -e.id, e.instance_id, 'email:' || e.template_key, 1, e.failure, e.sent_at
          from email_log e join instance i on i.id = e.instance_id
         where e.tenant_id = $1 and i.process_key = $2 and e.status = 'failed'
        order by 1 desc limit 20`,
      [tenantId, args.processKey],
    );

    return {
      totals: totals[0]!,
      failures: failures.map((f) => ({
        outboxId: f.id,
        instanceId: f.instance_id,
        reference: reference(f.instance_id),
        transitionKey: f.transition_key,
        attempts: f.attempts,
        lastError: f.last_error,
        retryAt: f.available_at.toISOString(),
      })),
    };
  });
}

/**
 * §8.2: "expose permanent failure and authorized replay." Replay makes the row
 * visible again; it does not re-execute the effect, because the idempotency
 * ledger already decides that.
 */
export async function replayAction(
  pool: Pool,
  args: { principal: Principal; outboxId: number; now: Date },
) {
  return inTransaction(pool, async (client) => {
    if (args.principal.kind === 'system') throw new Error('system principals do not replay');
    const { rows } = await client.query<{ tenant_id: string; process_key: string; instance_id: string }>(
      `select o.tenant_id, i.process_key, o.instance_id
         from outbox o join instance i on i.id = o.instance_id
        where o.id = $1`,
      [args.outboxId],
    );
    const row = rows[0];
    if (!row) throw new Error('no such action');

    const bp = await loadBlueprintFor(client, row.tenant_id, row.process_key);
    await require_(
      client,
      {
        principal: args.principal,
        action: 'operate',
        tenantId: row.tenant_id,
        processKey: row.process_key,
        blueprint: bp,
        instanceId: row.instance_id,
      },
      pool,
    );

    await client.query(
      `update outbox set available_at = $1, last_error = null, claimed_by = null, claimed_at = null
        where id = $2 and done_at is null`,
      [args.now, args.outboxId],
    );
    return { queued: true };
  });
}
