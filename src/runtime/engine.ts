import { createHash, randomUUID } from 'node:crypto';
import type { Blueprint, Action, Party, Transition } from '../blueprint/index.js';
import { evaluate, render, withCalculatedFields, type Answers } from './expr.js';
import { inTransaction, isUniqueViolation, type Client, type Pool } from './db.js';
import {
  authorize,
  describe as describePrincipal,
  redact,
  rejectUneditable,
  recordDenial,
  require_,
  type Principal,
} from './policy.js';

export interface InstanceRow {
  id: string;
  tenant_id: string;
  process_key: string;
  process_version_id: string;
  state: string;
  data: Answers;
  assignee: string | null;
  outcome: string | null;
  state_entered_at: Date;
  completed_at: Date | null;
}

export interface VersionRow {
  id: string;
  tenant_id: string;
  process_key: string;
  version: number;
  blueprint: Blueprint;
}

const VISIBILITY_TIMEOUT_SECONDS = 30;

/**
 * The workflow runtime. Section 10.2 in six steps:
 *
 *   1. validate and authorize            -> submit() / decide() / completeTask()
 *   2. domain change + outbox, one txn   -> applyTransition()
 *   3. relay publishes to the job system -> the outbox table is the queue
 *   4. worker claims with an idem. key   -> runOutbox() / executeAction()
 *   5. record attempt and outcome        -> action_run
 *   6. resulting event advances it       -> effects raise new events
 *
 * Every public method takes `now` rather than reading the clock, so timers are
 * deterministic under test and a scenario can jump two weeks forward without
 * waiting two weeks.
 */
export class Engine {
  constructor(private readonly pool: Pool) {}

  // ------------------------------------------------------------- publishing

  async createTenant(name: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      'insert into tenant (name) values ($1) returning id',
      [name],
    );
    return rows[0]!.id;
  }

  /** Adds a person to the workspace. */
  async createActor(tenantId: string, email: string, displayName: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      'insert into actor (tenant_id, email, display_name) values ($1, $2, $3) returning id',
      [tenantId, email, displayName],
    );
    return rows[0]!.id;
  }

  /** Grants a blueprint role to a person, in one process. */
  async grant(args: {
    tenantId: string;
    actorId: string;
    processKey: string;
    roleKey: string;
    grantedBy?: string;
  }): Promise<void> {
    await this.pool.query(
      `insert into membership (tenant_id, actor_id, process_key, role_key, granted_by)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, actor_id, process_key, role_key) do nothing`,
      [args.tenantId, args.actorId, args.processKey, args.roleKey, args.grantedBy ?? null],
    );
  }

  async deactivateActor(actorId: string): Promise<void> {
    await this.pool.query('update actor set active = false where id = $1', [actorId]);
  }

  /** Publishing never mutates an existing version; it adds the next one. */
  async publish(tenantId: string, blueprint: Blueprint, publishedBy: string): Promise<VersionRow> {
    return inTransaction(this.pool, async (client) => {
      const { rows: existing } = await client.query<{ next: number }>(
        'select coalesce(max(version), 0) + 1 as next from process_version where tenant_id = $1 and process_key = $2',
        [tenantId, blueprint.key],
      );
      const version = existing[0]!.next;
      const { rows } = await client.query<VersionRow>(
        `insert into process_version (tenant_id, process_key, version, blueprint, published_by)
         values ($1, $2, $3, $4, $5)
         returning id, tenant_id, process_key, version, blueprint`,
        [tenantId, blueprint.key, version, blueprint, publishedBy],
      );
      return rows[0]!;
    });
  }

  // -------------------------------------------------------------- submission

  /**
   * Creates a process instance from a respondent submission, or recognises it
   * as a duplicate of one that already exists.
   */
  async submit(args: {
    version: VersionRow;
    answers: Answers;
    now: Date;
    principal?: Principal;
    actor?: string;
  }): Promise<{ instanceId: string; duplicate: boolean; rejected?: string[] }> {
    const bp = args.version.blueprint;
    const principal: Principal =
      args.principal ?? { kind: 'respondent', tenantId: args.version.tenant_id, label: args.actor };
    const answers = withCalculatedFields(bp.data.fields, args.answers);

    // Requirement 6.3: a submission that does not satisfy the published form
    // never becomes an instance. The form is the gate, not the approver.
    const missing = missingRequiredFields(bp, answers);
    if (missing.length) return { instanceId: '', duplicate: false, rejected: missing };

    const transition = selectSubmissionTransition(bp, answers, args.now);
    const identityKey = identityFor(bp, answers);

    return inTransaction(this.pool, async (client) => {
      await require_(client, {
        principal,
        action: 'submit',
        tenantId: args.version.tenant_id,
        processKey: bp.key,
        blueprint: bp,
      }, this.pool);

      const { rows } = await client.query<{ id: string }>(
        `insert into instance
           (tenant_id, process_key, process_version_id, state, data, identity_key, created_at, state_entered_at)
         values ($1, $2, $3, $4, $5, $6, $7, $7)
         on conflict (tenant_id, process_key, identity_key) where identity_key is not null
         do nothing
         returning id`,
        [
          args.version.tenant_id,
          bp.key,
          args.version.id,
          initialState(bp).key,
          JSON.stringify(answers),
          identityKey,
          args.now,
        ],
      );

      if (!rows.length) {
        // Section 4.2: a repeat submission must not lose the original or
        // create a second one. It is recorded against the existing case.
        const { rows: found } = await client.query<{ id: string }>(
          `select id from instance
            where tenant_id = $1 and process_key = $2 and identity_key = $3`,
          [args.version.tenant_id, bp.key, identityKey],
        );
        const instanceId = found[0]!.id;
        await appendEvent(client, {
          tenantId: args.version.tenant_id,
          instanceId,
          type: 'duplicate_submission_ignored',
          payload: { answers },
          actor: describePrincipal(principal),
          now: args.now,
        });
        return { instanceId, duplicate: true };
      }

      const instanceId = rows[0]!.id;
      const instance = await loadInstance(client, instanceId);
      await applyTransition(client, {
        bp,
        instance,
        transition,
        eventType: 'submitted',
        payload: { answers },
        actor: describePrincipal(principal),
        now: args.now,
      });
      return { instanceId, duplicate: false };
    });
  }

  // ------------------------------------------------------------- operations

  async decide(args: {
    instanceId: string;
    approvalKey: string;
    decision: 'approved' | 'rejected' | 'changes_requested';
    principal: Principal;
    reason?: string;
    now: Date;
  }): Promise<{ applied: boolean }> {
    return inTransaction(this.pool, async (client) => {
      const instance = await loadInstance(client, args.instanceId, { lock: true });
      const bp = await loadBlueprint(client, instance.process_version_id);

      // Read the pending request before deciding: holding the approve
      // capability is not the same as being named on this one.
      const { rows: pending } = await client.query<{ approvers: string[] }>(
        `select approvers from approval_request
          where instance_id = $1 and approval_key = $2 and status = 'pending'
          order by id limit 1`,
        [args.instanceId, args.approvalKey],
      );
      if (!pending.length) return { applied: false };

      await require_(client, {
        principal: args.principal,
        action: 'approve',
        tenantId: instance.tenant_id,
        processKey: instance.process_key,
        blueprint: bp,
        instanceId: instance.id,
        namedApprovers: pending[0]!.approvers,
      }, this.pool);

      const actor = describePrincipal(args.principal);
      const { rowCount } = await client.query(
        `update approval_request
            set status = 'decided', decision = $1, decided_by = $2, decided_at = $3, reason = $4
          where instance_id = $5 and approval_key = $6 and status = 'pending'`,
        [args.decision, actor, args.now, args.reason ?? null, args.instanceId, args.approvalKey],
      );
      if (!rowCount) return { applied: false };

      const transition = bp.workflow.transitions.find(
        (t) =>
          t.from === instance.state &&
          t.trigger.on === 'approval_decided' &&
          t.trigger.approval === args.approvalKey &&
          t.trigger.decision === args.decision &&
          passesGuard(t, instance, args.now, describePrincipal(args.principal)),
      );
      if (!transition) return { applied: false };

      await applyTransition(client, {
        bp,
        instance,
        transition,
        eventType: 'approval_decided',
        payload: { approval: args.approvalKey, decision: args.decision, reason: args.reason ?? null },
        actor: describePrincipal(args.principal),
        now: args.now,
      });
      return { applied: true };
    });
  }

  async completeTask(args: {
    instanceId: string;
    taskKey: string;
    principal: Principal;
    now: Date;
  }): Promise<{ applied: boolean }> {
    return inTransaction(this.pool, async (client) => {
      const instance = await loadInstance(client, args.instanceId, { lock: true });
      const bp = await loadBlueprint(client, instance.process_version_id);

      const { rows: open } = await client.query<{ assignee: string | null }>(
        `select assignee from task
          where instance_id = $1 and task_key = $2 and status = 'open'
          order by id limit 1`,
        [args.instanceId, args.taskKey],
      );
      if (!open.length) return { applied: false };

      await require_(client, {
        principal: args.principal,
        action: 'operate',
        tenantId: instance.tenant_id,
        processKey: instance.process_key,
        blueprint: bp,
        instanceId: instance.id,
        taskAssignee: open[0]!.assignee,
      }, this.pool);

      const actor = describePrincipal(args.principal);
      const { rowCount } = await client.query(
        `update task set status = 'done', completed_at = $1, completed_by = $2
          where id = (
            select id from task
             where instance_id = $3 and task_key = $4 and status = 'open'
             order by id limit 1
          )`,
        [args.now, actor, args.instanceId, args.taskKey],
      );
      if (!rowCount) return { applied: false };

      const transition = bp.workflow.transitions.find(
        (t) =>
          t.from === instance.state &&
          t.trigger.on === 'task_completed' &&
          t.trigger.task === args.taskKey &&
          passesGuard(t, instance, args.now, actor),
      );
      if (!transition) return { applied: true };

      await applyTransition(client, {
        bp,
        instance,
        transition,
        eventType: 'task_completed',
        payload: { task: args.taskKey },
        actor,
        now: args.now,
      });
      return { applied: true };
    });
  }

  /** A respondent or operator changing answers, which may release a waiting state. */
  async updateRecord(args: {
    instanceId: string;
    patch: Answers;
    principal: Principal;
    now: Date;
  }): Promise<{ applied: boolean; refused?: string[] }> {
    return inTransaction(this.pool, async (client) => {
      const instance = await loadInstance(client, args.instanceId, { lock: true });
      const bp = await loadBlueprint(client, instance.process_version_id);

      const decision = await require_(client, {
        principal: args.principal,
        action: 'edit',
        tenantId: instance.tenant_id,
        processKey: instance.process_key,
        blueprint: bp,
        instanceId: instance.id,
      }, this.pool);

      // Holding `edit` is not permission to change every field. A role may
      // only touch what its editableFields list names (§6.4).
      if (args.principal.kind === 'actor') {
        const refused = rejectUneditable(bp, decision.roles, args.patch);
        if (refused.length) {
          await recordDenial(
            client,
            {
              principal: args.principal,
              action: 'edit',
              tenantId: instance.tenant_id,
              processKey: instance.process_key,
              blueprint: bp,
              instanceId: instance.id,
            },
            `fields not editable by ${decision.roles.join(', ')}: ${refused.join(', ')}`,
          );
          return { applied: false, refused };
        }
      }

      const actor = describePrincipal(args.principal);
      const merged = withCalculatedFields(bp.data.fields, { ...instance.data, ...args.patch });
      await client.query('update instance set data = $1 where id = $2', [
        JSON.stringify(merged),
        args.instanceId,
      ]);
      instance.data = merged;

      const transition = bp.workflow.transitions.find(
        (t) => t.from === instance.state && t.trigger.on === 'record_updated' && passesGuard(t, instance, args.now, actor),
      );
      if (!transition) {
        await appendEvent(client, {
          tenantId: instance.tenant_id,
          instanceId: instance.id,
          type: 'record_updated',
          payload: { fields: Object.keys(args.patch) },
          actor,
          now: args.now,
        });
        return { applied: false };
      }

      await applyTransition(client, {
        bp,
        instance,
        transition,
        eventType: 'record_updated',
        payload: { fields: Object.keys(args.patch) },
        actor,
        now: args.now,
      });
      return { applied: true };
    });
  }

  /** Manual transitions, e.g. an administrator withdrawing a record. */
  async fireManual(args: {
    instanceId: string;
    transitionKey: string;
    principal: Principal;
    now: Date;
  }): Promise<{ applied: boolean }> {
    return inTransaction(this.pool, async (client) => {
      const instance = await loadInstance(client, args.instanceId, { lock: true });
      const bp = await loadBlueprint(client, instance.process_version_id);
      const transition = bp.workflow.transitions.find((t) => t.key === args.transitionKey);
      if (
        !transition ||
        transition.from !== instance.state ||
        transition.trigger.on !== 'manual'
      ) {
        return { applied: false };
      }

      const decision = await require_(client, {
        principal: args.principal,
        action: 'operate',
        tenantId: instance.tenant_id,
        processKey: instance.process_key,
        blueprint: bp,
        instanceId: instance.id,
      }, this.pool);

      // The transition names which roles may fire it. Previously the caller
      // simply told us which role they were, which is not a check.
      const permitted = transition.trigger.by;
      if (args.principal.kind === 'actor' && !decision.roles.some((r) => permitted.includes(r))) {
        await recordDenial(
          client,
          {
            principal: args.principal,
            action: 'operate',
            tenantId: instance.tenant_id,
            processKey: instance.process_key,
            blueprint: bp,
            instanceId: instance.id,
          },
          `transition "${transition.key}" is restricted to ${permitted.join(', ')}`,
        );
        return { applied: false };
      }

      const actor = describePrincipal(args.principal);
      if (!passesGuard(transition, instance, args.now, actor)) return { applied: false };
      await applyTransition(client, {
        bp,
        instance,
        transition,
        eventType: 'manual_action',
        payload: { transition: args.transitionKey },
        actor,
        now: args.now,
      });
      return { applied: true };
    });
  }

  // ----------------------------------------------------------------- timers

  /** Fires every timer that is due, at most once each. */
  async fireDueTimers(now: Date, batch = 50): Promise<number> {
    const { rows: due } = await this.pool.query<{
      id: number;
      instance_id: string;
      transition_key: string;
      state_key: string;
      entered_at: Date;
    }>(
      `update timer set fired_at = $1
        where id in (
          select id from timer
           where fired_at is null and cancelled_at is null and due_at <= $1
           order by due_at, id
             for update skip locked
           limit $2
        )
        returning id, instance_id, transition_key, state_key, entered_at`,
      [now, batch],
    );

    let fired = 0;
    for (const timer of due) {
      const applied = await inTransaction(this.pool, async (client) => {
        const instance = await loadInstance(client, timer.instance_id, { lock: true });
        // A timer scheduled for a state the record has since left is stale.
        // Cancelling on exit handles the common case; this is the guard for a
        // timer that was already claimed when the record moved.
        if (instance.state !== timer.state_key) return false;
        if (instance.state_entered_at.getTime() !== timer.entered_at.getTime()) return false;

        const bp = await loadBlueprint(client, instance.process_version_id);
        const transition = bp.workflow.transitions.find((t) => t.key === timer.transition_key);
        if (!transition || !passesGuard(transition, instance, now)) return false;

        await applyTransition(client, {
          bp,
          instance,
          transition,
          eventType: 'timer_fired',
          payload: { transition: transition.key, state: timer.state_key },
          actor: 'system:timer',
          now,
        });
        return true;
      });
      if (applied) fired++;
    }
    return fired;
  }

  // ----------------------------------------------------------------- outbox

  /**
   * Claims and runs a batch of outbox rows. Safe to run in parallel: the claim
   * is a single atomic statement using FOR UPDATE SKIP LOCKED, so two workers
   * never take the same row, and a worker that dies mid-flight releases its
   * rows when the visibility timeout expires.
   */
  async runOutbox(workerId: string, now: Date, batch = 10): Promise<number> {
    const { rows: claimed } = await this.pool.query<{
      id: number;
      tenant_id: string;
      instance_id: string;
      event_id: number;
      transition_key: string;
    }>(
      `update outbox
          set claimed_by = $1, claimed_at = $2, attempts = attempts + 1,
              available_at = $2 + make_interval(secs => $4)
        where id in (
          select id from outbox
           where done_at is null and available_at <= $2
           order by id
             for update skip locked
           limit $3
        )
        returning id, tenant_id, instance_id, event_id, transition_key`,
      [workerId, now, batch, VISIBILITY_TIMEOUT_SECONDS],
    );

    let processed = 0;
    for (const row of claimed) {
      try {
        const instance = await this.loadInstanceOutsideTx(row.instance_id);
        const bp = await this.loadBlueprintOutsideTx(instance.process_version_id);
        const transition = bp.workflow.transitions.find((t) => t.key === row.transition_key);

        for (const action of transition?.actions ?? []) {
          // One transaction per action, so a permanently failing action does
          // not roll back the ones that already succeeded.
          await inTransaction(this.pool, (client) =>
            executeAction(client, {
              bp,
              instance,
              action,
              idempotencyKey: `${row.transition_key}:${action.key}:${row.event_id}`,
              now,
            }),
          );
        }

        await this.pool.query('update outbox set done_at = $1, last_error = null where id = $2', [now, row.id]);
        processed++;
      } catch (err) {
        // Section 6.5: retry transient errors with backoff, expose permanent
        // failure. The row stays visible to the operator either way.
        const message = err instanceof Error ? err.message : String(err);
        await this.pool.query(
          `update outbox
              set last_error = $1,
                  available_at = $2 + make_interval(secs => least(300, power(2, attempts)::int))
            where id = $3`,
          [message, now, row.id],
        );
      }
    }
    return processed;
  }

  /** Runs outbox and timers until neither has anything left to do. */
  async drain(now: Date, workerId = 'drain'): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const done = await this.runOutbox(workerId, now, 50);
      const fired = await this.fireDueTimers(now);
      if (!done && !fired) return;
    }
    throw new Error('drain did not settle after 100 rounds, which suggests a workflow loop');
  }

  // ------------------------------------------------------------------ reads

  async instance(id: string): Promise<InstanceRow> {
    return this.loadInstanceOutsideTx(id);
  }

  /**
   * Reads a record as a principal, with the fields their roles may not see
   * removed rather than merely hidden in the client (§6.4).
   */
  async recordFor(principal: Principal, instanceId: string): Promise<InstanceRow> {
    return inTransaction(this.pool, async (client) => {
      const instance = await loadInstance(client, instanceId);
      const bp = await loadBlueprint(client, instance.process_version_id);
      const decision = await require_(client, {
        principal,
        action: 'view',
        tenantId: instance.tenant_id,
        processKey: instance.process_key,
        blueprint: bp,
        instanceId,
      }, this.pool);
      return { ...instance, data: redact(bp, decision.roles, instance.data) };
    });
  }

  /**
   * Asks the policy engine whether something would be allowed, without doing
   * it. This is the same code path as the enforcement, so a scenario that
   * asserts on permissions is testing the real thing.
   */
  async can(args: {
    principal: Principal;
    action: Parameters<typeof require_>[1]['action'];
    tenantId: string;
    processKey: string;
    blueprint: Blueprint;
    instanceId?: string;
  }): Promise<{ allowed: boolean; reason: string }> {
    const client = await this.pool.connect();
    try {
      const { allowed, reason } = await authorize(client, args);
      return { allowed, reason };
    } finally {
      client.release();
    }
  }

  async denials(tenantId: string): Promise<{ action: string; reason: string; actor_label: string }[]> {
    const { rows } = await this.pool.query(
      'select action, reason, actor_label from access_denial where tenant_id = $1 order by id',
      [tenantId],
    );
    return rows;
  }

  async emails(instanceId: string): Promise<{ template_key: string; recipients: string[]; subject: string }[]> {
    const { rows } = await this.pool.query(
      'select template_key, recipients, subject from email_log where instance_id = $1 order by id',
      [instanceId],
    );
    return rows;
  }

  async documents(instanceId: string): Promise<{ document_key: string; checksum: string }[]> {
    const { rows } = await this.pool.query(
      'select document_key, checksum from document where instance_id = $1 order by id',
      [instanceId],
    );
    return rows;
  }

  async openTasks(instanceId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ task_key: string }>(
      "select task_key from task where instance_id = $1 and status = 'open' order by id",
      [instanceId],
    );
    return rows.map((r) => r.task_key);
  }

  async events(instanceId: string): Promise<{ seq: number; type: string; actor: string | null }[]> {
    const { rows } = await this.pool.query(
      'select seq, type, actor from event where instance_id = $1 order by seq',
      [instanceId],
    );
    return rows;
  }

  private async loadInstanceOutsideTx(id: string): Promise<InstanceRow> {
    const client = await this.pool.connect();
    try {
      return await loadInstance(client, id);
    } finally {
      client.release();
    }
  }

  private async loadBlueprintOutsideTx(versionId: string): Promise<Blueprint> {
    const client = await this.pool.connect();
    try {
      return await loadBlueprint(client, versionId);
    } finally {
      client.release();
    }
  }
}

// --------------------------------------------------------------- internals

async function loadInstance(client: Client, id: string, opts: { lock?: boolean } = {}): Promise<InstanceRow> {
  const { rows } = await client.query<InstanceRow>(
    `select id, tenant_id, process_key, process_version_id, state, data, assignee, outcome,
            state_entered_at, completed_at
       from instance where id = $1 ${opts.lock ? 'for update' : ''}`,
    [id],
  );
  if (!rows.length) throw new Error(`instance ${id} not found`);
  return rows[0]!;
}

async function loadBlueprint(client: Client, versionId: string): Promise<Blueprint> {
  const { rows } = await client.query<{ blueprint: Blueprint }>(
    'select blueprint from process_version where id = $1',
    [versionId],
  );
  if (!rows.length) throw new Error(`process version ${versionId} not found`);
  return rows[0]!.blueprint;
}

async function appendEvent(
  client: Client,
  args: { tenantId: string; instanceId: string; type: string; payload: unknown; actor: string; now: Date },
): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    `insert into event (tenant_id, instance_id, seq, type, payload, actor, occurred_at)
     values ($1, $2, (select coalesce(max(seq), 0) + 1 from event where instance_id = $2), $3, $4, $5, $6)
     returning id`,
    [args.tenantId, args.instanceId, args.type, JSON.stringify(args.payload), args.actor, args.now],
  );
  return rows[0]!.id;
}

/**
 * The heart of step 2: the state change, the event, the outbox row, and the
 * timer bookkeeping all commit together or not at all.
 */
async function applyTransition(
  client: Client,
  args: {
    bp: Blueprint;
    instance: InstanceRow;
    transition: Transition;
    eventType: string;
    payload: unknown;
    actor: string;
    now: Date;
  },
): Promise<void> {
  const { bp, instance, transition, now } = args;
  const target = bp.workflow.states.find((s) => s.key === transition.to);
  if (!target) throw new Error(`transition ${transition.key} targets unknown state ${transition.to}`);

  const eventId = await appendEvent(client, {
    tenantId: instance.tenant_id,
    instanceId: instance.id,
    type: args.eventType,
    payload: { ...(args.payload as object), transition: transition.key, from: instance.state, to: transition.to },
    actor: args.actor,
    now,
  });

  await client.query(
    `update instance
        set state = $1,
            state_entered_at = $2,
            outcome = $3,
            completed_at = case when $4 then $2 else completed_at end
      where id = $5`,
    [transition.to, now, target.outcome ?? null, target.type === 'terminal', instance.id],
  );

  // Timers belong to an occupancy of a state, not to the state itself, so
  // leaving cancels and entering schedules. Re-entering the same state on a
  // self-loop therefore restarts the clock, which is what a reminder wants.
  await client.query(
    `update timer set cancelled_at = $1
      where instance_id = $2 and fired_at is null and cancelled_at is null and entered_at = $3`,
    [now, instance.id, instance.state_entered_at],
  );

  if (target.type !== 'terminal') {
    for (const candidate of bp.workflow.transitions) {
      if (candidate.from !== transition.to) continue;
      if (candidate.trigger.on !== 'timer') continue;
      const dueAt = new Date(now.getTime() + candidate.trigger.afterHoursInState * 3_600_000);
      await client.query(
        `insert into timer (tenant_id, instance_id, transition_key, state_key, entered_at, due_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (instance_id, transition_key, entered_at) do nothing`,
        [instance.tenant_id, instance.id, candidate.key, transition.to, now, dueAt],
      );
    }
  }

  await client.query(
    `insert into outbox (tenant_id, instance_id, event_id, transition_key, created_at, available_at)
     values ($1, $2, $3, $4, $5, $5)`,
    [instance.tenant_id, instance.id, eventId, transition.key, now],
  );

  instance.state = transition.to;
  instance.state_entered_at = now;
}

/**
 * Runs one action exactly once per occurrence. The idempotency key includes the
 * event id, so a timer that fires a second time genuinely sends a second
 * reminder, while a retry of the same firing does not.
 */
async function executeAction(
  client: Client,
  args: { bp: Blueprint; instance: InstanceRow; action: Action; idempotencyKey: string; now: Date },
): Promise<void> {
  const { bp, instance, action, now } = args;

  const { rows: claim } = await client.query<{ id: number }>(
    `insert into action_run (tenant_id, instance_id, idempotency_key, action_do, created_at)
     values ($1, $2, $3, $4, $5)
     on conflict (instance_id, idempotency_key) do nothing
     returning id`,
    [instance.tenant_id, instance.id, args.idempotencyKey, action.do, now],
  );

  let runId: number;
  if (claim.length) {
    runId = claim[0]!.id;
  } else {
    const { rows } = await client.query<{ id: number; status: string }>(
      'select id, status from action_run where instance_id = $1 and idempotency_key = $2',
      [instance.id, args.idempotencyKey],
    );
    const existing = rows[0]!;
    if (existing.status === 'done') return; // already performed, nothing to do
    runId = existing.id;
    await client.query('update action_run set attempts = attempts + 1 where id = $1', [runId]);
  }

  // Each effect table has a unique constraint on action_run_id. Even if two
  // workers reach this line for the same action, exactly one row is written
  // and the other sees a unique violation, which is success, not failure.
  try {
    await performEffect(client, { bp, instance, action, runId, now });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  await client.query("update action_run set status = 'done', completed_at = $1 where id = $2", [now, runId]);
}

async function performEffect(
  client: Client,
  args: { bp: Blueprint; instance: InstanceRow; action: Action; runId: number; now: Date },
): Promise<void> {
  const { bp, instance, action, runId, now } = args;
  const answers = instance.data;

  switch (action.do) {
    case 'send_email': {
      const template = bp.communications.email.find((t) => t.key === action.template)!;
      if (template.skipWhen && evaluate(template.skipWhen, { answers, now })) return;
      const recipients = [...template.to, ...template.cc].flatMap((p) => resolveParty(p, instance, bp));
      if (!recipients.length) return;
      await client.query(
        `insert into email_log (tenant_id, instance_id, action_run_id, template_key, recipients, subject, body, sent_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          instance.tenant_id,
          instance.id,
          runId,
          template.key,
          recipients,
          render(template.subject, answers),
          render(template.body, answers),
          now,
        ],
      );
      return;
    }

    case 'create_task': {
      const task = bp.workflow.tasks.find((t) => t.key === action.task)!;
      await client.query(
        `insert into task (tenant_id, instance_id, action_run_id, task_key, assignee, blocking, due_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          instance.tenant_id,
          instance.id,
          runId,
          task.key,
          resolveParty(task.assignee, instance, bp)[0] ?? null,
          task.blocking,
          task.dueInHours ? new Date(now.getTime() + task.dueInHours * 3_600_000) : null,
          now,
        ],
      );
      return;
    }

    case 'request_approval': {
      const approval = bp.workflow.approvals.find((a) => a.key === action.approval)!;
      const approvers = approval.approvers.flatMap((p) => resolveParty(p, instance, bp));
      await client.query(
        `insert into approval_request
           (tenant_id, instance_id, action_run_id, approval_key, approvers, mode, due_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          instance.tenant_id,
          instance.id,
          runId,
          approval.key,
          approvers,
          approval.mode,
          approval.dueInHours ? new Date(now.getTime() + approval.dueInHours * 3_600_000) : null,
          now,
        ],
      );
      return;
    }

    case 'generate_document': {
      const doc = bp.outputs.documents.find((d) => d.key === action.document)!;
      // Section 6.6: the checksum is over the mapped values and the template,
      // so an identical record and template always produce an identical file
      // and a changed one is visibly different.
      const mapped = Object.fromEntries(
        Object.entries(doc.mapping).map(([placeholder, field]) => [placeholder, answers[field] ?? null]),
      );
      const checksum = createHash('sha256')
        .update(JSON.stringify({ template: doc.templateRef, version: instance.process_version_id, mapped }))
        .digest('hex');
      await client.query(
        `insert into document
           (tenant_id, instance_id, action_run_id, document_key, template_ref, process_version_id,
            checksum, filename, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          instance.tenant_id,
          instance.id,
          runId,
          doc.key,
          doc.templateRef,
          instance.process_version_id,
          checksum,
          render(doc.filename, answers),
          'system:document',
          now,
        ],
      );
      return;
    }

    case 'call_webhook': {
      const payload = Object.fromEntries(action.includeFields.map((f) => [f, answers[f] ?? null]));
      await client.query(
        `insert into webhook_delivery (tenant_id, instance_id, action_run_id, event_name, payload, delivered_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [instance.tenant_id, instance.id, runId, action.event, JSON.stringify(payload), now],
      );
      return;
    }

    case 'assign': {
      const who = resolveParty(action.to, instance, bp)[0] ?? null;
      await client.query('update instance set assignee = $1 where id = $2', [who, instance.id]);
      instance.assignee = who;
      return;
    }

    case 'set_state':
    case 'wait':
      return;
  }
}

/** Turns a declared party into concrete addresses. Never a free-form string. */
function resolveParty(party: Party, instance: InstanceRow, bp: Blueprint): string[] {
  if ('user' in party) return [party.user];
  if ('field' in party) {
    const value = instance.data[party.field];
    return typeof value === 'string' && value ? [value] : [];
  }
  if ('submitter' in party) {
    const submitterField = bp.data.fields.find((f) => f.type === 'email');
    const value = submitterField ? instance.data[submitterField.key] : undefined;
    return typeof value === 'string' && value ? [value] : [];
  }
  if ('assignee' in party) return instance.assignee ? [instance.assignee] : [];
  // A role resolves to its members. The spike has no directory, so it addresses
  // the role itself and leaves fan-out to the notification service.
  return [`role:${party.role}`];
}

function passesGuard(transition: Transition, instance: InstanceRow, now: Date, actor?: string): boolean {
  if (!transition.when) return true;
  return evaluate(transition.when, {
    answers: instance.data,
    now,
    actor,
    currentState: instance.state,
  });
}

function initialState(bp: Blueprint) {
  const state = bp.workflow.states.find((s) => s.type === 'initial');
  if (!state) throw new Error(`${bp.key} has no initial state`);
  return state;
}

function selectSubmissionTransition(bp: Blueprint, answers: Answers, now: Date): Transition {
  const start = initialState(bp).key;
  const candidates = bp.workflow.transitions.filter(
    (t) =>
      t.from === start &&
      t.trigger.on === 'submission' &&
      (!t.when || evaluate(t.when, { answers, now, currentState: start })),
  );
  if (!candidates.length) {
    throw new Error(`no submission transition in ${bp.key} matches this submission`);
  }
  if (candidates.length > 1) {
    // Guards that overlap mean the outcome depends on declaration order, which
    // is exactly the kind of quiet non-determinism this design exists to avoid.
    throw new Error(
      `submission matches ${candidates.length} transitions in ${bp.key} (${candidates
        .map((c) => c.key)
        .join(', ')}); their conditions overlap`,
    );
  }
  return candidates[0]!;
}

function missingRequiredFields(bp: Blueprint, answers: Answers): string[] {
  const missing: string[] = [];
  for (const field of bp.data.fields) {
    if (!field.required) continue;
    if (field.type === 'hidden' || field.type === 'calculated' || field.type === 'content') continue;
    const value = answers[field.key];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) {
      missing.push(field.key);
    }
  }
  return missing;
}

function identityFor(bp: Blueprint, answers: Answers): string | null {
  if (!bp.data.identity?.length) return null;
  const parts = bp.data.identity.map((key) => JSON.stringify(answers[key] ?? null));
  return createHash('sha256').update(parts.join(' ')).digest('hex');
}

export function newWorkerId(): string {
  return `worker-${randomUUID().slice(0, 8)}`;
}
