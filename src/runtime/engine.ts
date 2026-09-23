import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { issueResumeToken } from './auth.js';
import { currentRequestId, currentTrace, logIfEnabled, newRequestId, withTrace } from './trace.js';
import { queueWebhook } from './webhooks.js';
import { blockedRecipients } from './delivery.js';
import { htmlToBlocks, renderPdf, type Block } from './pdf.js';
import {
  ConsoleProvider,
  emailProviderFromEnv,
  mailFrom,
  type Attachment,
  type EmailProvider,
} from './email.js';
import type { Blueprint, Action, Party, Transition } from '../blueprint/index.js';
import { evaluate, render, withCalculatedFields, type Answers } from './expr.js';
import { inTransaction, isUniqueViolation, type Client, type Pool } from './db.js';
import {
  automationHealth,
  listRecords,
  myWork,
  processesFor,
  recordDetail,
  replayAction,
} from './console-queries.js';
import {
  authorize,
  describe as describePrincipal,
  redact,
  rejectUneditable,
  recordDenial,
  require_,
  type Principal,
  type WorkspaceRole,
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

/** Document templates use {{UPPER_SNAKE}}, keyed on the mapping, not field keys. */
const PLACEHOLDER = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

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
  private readonly email: EmailProvider;

  constructor(
    private readonly pool: Pool,
    email?: EmailProvider,
  ) {
    // This used to claim it defaulted to console so a local database could
    // never deliver real mail. It does not: naming a provider in the
    // environment is enough, which is how `npm run spike` came to fire
    // forty live sends at a transactional API. The Engine has no way to tell
    // a proof run from a real one, so the guard lives in the harness —
    // suppressDelivery() in email.ts — and this says what it actually does.
    this.email = email ?? (process.env.EMAIL_PROVIDER ? emailProviderFromEnv() : new ConsoleProvider());
  }

  // ------------------------------------------------------------- publishing

  async createTenant(name: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      'insert into tenant (name) values ($1) returning id',
      [name],
    );
    return rows[0]!.id;
  }

  /** Adds a person to the workspace. */
  async createActor(
    tenantId: string,
    email: string,
    displayName: string,
    workspaceRole: WorkspaceRole = 'read_only',
  ): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into actor (tenant_id, email, display_name, workspace_role)
       values ($1, $2, $3, $4) returning id`,
      [tenantId, email, displayName, workspaceRole],
    );
    return rows[0]!.id;
  }

  async setWorkspaceRole(actorId: string, workspaceRole: WorkspaceRole): Promise<void> {
    await this.pool.query('update actor set workspace_role = $1 where id = $2', [workspaceRole, actorId]);
  }

  async actor(actorId: string): Promise<{
    id: string;
    tenant_id: string;
    email: string;
    display_name: string;
    workspace_role: WorkspaceRole;
    active: boolean;
    email_verified_at: string | null;
    workspace_name: string;
  } | null> {
    const { rows } = await this.pool.query(
      `select a.id, a.tenant_id, a.email, a.display_name, a.workspace_role, a.active,
              a.email_verified_at, t.name as workspace_name
         from actor a join tenant t on t.id = a.tenant_id
        where a.id = $1`,
      [actorId],
    );
    return rows[0] ?? null;
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
    /**
     * The id the record must have. Only releasing a held submission sets it:
     * the person was shown a reference when they submitted, and the record
     * that eventually exists should answer to it.
     */
    id?: string;
  }): Promise<{ instanceId: string; duplicate: boolean; rejected?: string[]; resumeToken?: string }> {
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
           (id, tenant_id, process_key, process_version_id, state, data, identity_key, created_at, state_entered_at)
         values (coalesce($8::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, $6, $7, $7)
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
          args.id ?? null,
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

      // §6.3's resume link, issued in the same transaction as the record so a
      // submission can never exist without a way for its author to return to
      // it — and so a respondent principal is scoped to exactly one instance.
      const resumeToken = args.version.blueprint.experience.saveAndResume
        ? await issueResumeToken(client, { tenantId: args.version.tenant_id, instanceId })
        : undefined;

      return { instanceId, duplicate: false, resumeToken };
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
      const declared = bp.workflow.approvals.find((a) => a.key === args.approvalKey);

      await require_(client, {
        principal: args.principal,
        action: 'approve',
        tenantId: instance.tenant_id,
        processKey: instance.process_key,
        blueprint: bp,
        instanceId: instance.id,
        namedApprovers: pending[0]!.approvers,
        // Only when the approval asks for it. `submitterOf` returns nothing
        // when the blueprint never said which field holds the address, and a
        // bar on nobody bars nobody — the compiler refuses that combination
        // at publish, so a published version cannot reach this with the
        // control silently off.
        barredApprover: declared?.notTheSubmitter ? submitterOf(bp, instance) : null,
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

      const declared = bp.workflow.tasks.find((t) => t.key === args.taskKey);
      await require_(client, {
        principal: args.principal,
        action: 'operate',
        tenantId: instance.tenant_id,
        processKey: instance.process_key,
        blueprint: bp,
        instanceId: instance.id,
        task: {
          assignee: open[0]!.assignee,
          completableBy: declared?.completableBy ?? 'assignee',
        },
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

      /*
       * One task, or the last of several.
       *
       * A `tasks_completed` transition is a join: it fires when every task it
       * names is done, and the completion that gets there last is the one that
       * fires it. The instance row is locked above, so two people finishing
       * two tasks at the same moment serialise here — the first sees the
       * other still open and does nothing, the second sees both done and
       * moves the record. Without that lock both would read "still open" and
       * the record would sit in a state with no work left in it.
       */
      const single = bp.workflow.transitions.find(
        (t) =>
          t.from === instance.state &&
          t.trigger.on === 'task_completed' &&
          t.trigger.task === args.taskKey &&
          passesGuard(t, instance, args.now, actor),
      );

      let transition = single;
      let payload: Record<string, unknown> = { task: args.taskKey };

      if (!transition) {
        const joins = bp.workflow.transitions.filter(
          (t) =>
            t.from === instance.state &&
            t.trigger.on === 'tasks_completed' &&
            t.trigger.tasks.includes(args.taskKey) &&
            passesGuard(t, instance, args.now, actor),
        );

        for (const join of joins) {
          const keys = (join.trigger as { tasks: string[] }).tasks;
          /*
           * Every named task must have a *completed* row. A task that was
           * never created does not satisfy the join, so the record waits.
           *
           * That is the safe reading of the two available wrong answers. A
           * record waiting is visible — it sits in the state, the queue shows
           * it, the state's own SLA fires. A record completing with work
           * outstanding is invisible and wrong. BLOCK002 makes the
           * never-created case a build error, so this should not be reachable
           * from a published blueprint; it is here for the one that slips
           * through a hand-edited draft.
           */
          const { rows: done } = await client.query<{ task_key: string }>(
            `select distinct task_key from task
              where instance_id = $1 and task_key = any($2::text[]) and status = 'done'`,
            [args.instanceId, keys],
          );
          if (done.length !== keys.length) continue;

          transition = join;
          payload = { tasks: keys, last: args.taskKey };
          break;
        }
      }

      if (!transition) return { applied: true };

      await applyTransition(client, {
        bp,
        instance,
        transition,
        eventType: 'task_completed',
        payload,
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
    /**
     * `saved` says the answers were written; `advanced` says the record also
     * moved. They are different questions and were one boolean, so a
     * respondent whose clarification was stored in a state with nowhere to go
     * was told nothing had happened.
     */
  }): Promise<{ saved: boolean; advanced: boolean; refused?: string[] }> {
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
      // only touch what its editableFields list names (§6.4) — and that is as
      // true of a respondent answering a clarification as of a member.
      if (args.principal.kind !== 'system') {
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
          return { saved: false, advanced: false, refused };
        }
      }

      const actor = describePrincipal(args.principal);
      const merged = withCalculatedFields(bp.data.fields, { ...instance.data, ...args.patch });
      await client.query('update instance set data = $1 where id = $2', [
        JSON.stringify(merged),
        args.instanceId,
      ]);
      instance.data = merged;

      /*
       * A deadline hung off a date is only as current as that date.
       *
       * This is the cost of date-relative timers, and the reason the original
       * note called it a runtime question rather than a schema one. Move a
       * start date forward a week and every deadline that hangs off it has
       * moved; a scheduled row still holding the old one sends a reminder on
       * a day nobody chose, or expires a record that is not late.
       *
       * Rescheduled against the *current* occupancy, so a timer that has
       * already fired stays fired. If the transition below moves the record,
       * leaving the state cancels these and entering the next one schedules
       * its own — which is the ordinary path and needs nothing here.
       */
      await scheduleTimers(client, {
        bp,
        instance,
        stateKey: instance.state,
        enteredAt: instance.state_entered_at,
        data: merged,
      });

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
        return { saved: true, advanced: false };
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
      return { saved: true, advanced: true };
    });
  }

  /** Manual transitions, e.g. an administrator withdrawing a record. */
  /**
   * Performs one action against one record, once, on somebody's explicit say-so.
   *
   * The workflow's own actions come off the outbox; this is the door for an
   * action a person asked for — today the copilot's confirmed reminders. It
   * goes through the same `executeAction` the worker uses rather than a
   * parallel send path, so the idempotency key, the effect tables' unique
   * constraints and the delivery log all behave identically. A second copilot
   * plan carrying the same key sends nothing and says so.
   *
   * It appends an event before acting. A reminder that arrives with no trace
   * on the record is indistinguishable from one the process sent itself, and
   * §6.4 requires a bulk action to leave a result report — which starts with
   * the record knowing it happened.
   */
  async runActionOnce(args: {
    principal: Principal;
    instanceId: string;
    action: Action;
    idempotencyKey: string;
    reason: string;
    now: Date;
  }): Promise<{ performed: boolean; recipients: string[]; reason?: string }> {
    return inTransaction(this.pool, async (client) => {
      const instance = await loadInstance(client, args.instanceId, { lock: true });
      const bp = await loadBlueprint(client, instance.process_version_id);

      await require_(
        client,
        {
          principal: args.principal,
          action: 'operate',
          tenantId: instance.tenant_id,
          processKey: instance.process_key,
          blueprint: bp,
          instanceId: instance.id,
        },
        this.pool,
      );

      // Bound to a local: narrowing on a property of a parameter object does
      // not survive the awaits below.
      const action = args.action;
      if (action.do !== 'send_email') {
        throw new Error(`runActionOnce performs send_email; "${action.do}" is not wired`);
      }
      const template = bp.communications.email.find((t) => t.key === action.template);
      if (!template) return { performed: false, recipients: [], reason: 'no such template' };

      const { addresses: recipients, unreachable } = await resolveRecipients(
        client,
        [...template.to, ...template.cc],
        instance,
        bp,
      );
      if (!recipients.length) {
        return {
          performed: false,
          recipients: [],
          reason: unreachable.length ? `nobody holds ${unreachable.join(', ')}` : 'nobody to send to',
        };
      }

      // Did this key already run? executeAction would short-circuit anyway,
      // but the caller needs to hear "already sent" rather than "sent".
      const { rows: prior } = await client.query<{ status: string }>(
        'select status from action_run where instance_id = $1 and idempotency_key = $2',
        [instance.id, args.idempotencyKey],
      );
      if (prior[0]?.status === 'done') {
        return { performed: false, recipients, reason: 'already sent under this plan' };
      }

      await appendEvent(client, {
        tenantId: instance.tenant_id,
        instanceId: instance.id,
        type: 'manual_action',
        payload: { action: action.do, template: action.template, reason: args.reason },
        actor: describePrincipal(args.principal),
        now: args.now,
      });

      await executeAction(client, {
        bp,
        instance,
        action,
        idempotencyKey: args.idempotencyKey,
        now: args.now,
        email: this.email,
        audit: this.pool,
      });

      return { performed: true, recipients };
    });
  }

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
  async fireDueTimers(now: Date, batch = 50, tenantId?: string): Promise<number> {
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
             and ($3::uuid is null or tenant_id = $3)
           order by due_at, id
             for update skip locked
           limit $2
        )
        returning id, instance_id, transition_key, state_key, entered_at`,
      [now, batch, tenantId ?? null],
    );

    let fired = 0;
    for (const timer of due) {
      /*
       * A timer is its own cause, so it gets its own request id.
       *
       * Nothing outside asked for this: a deadline passed. Giving each firing
       * a fresh id rather than leaving it 'unattributed' means the reminder it
       * sends can be traced back to the deadline that sent it, which is the
       * question somebody asks when a customer says "why did I get this".
       */
      const applied = await withTrace(
        { requestId: newRequestId(), source: 'timer' },
        () => inTransaction(this.pool, async (client) => {
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
        }),
      );
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
  /**
   * How far a caller's clock may be from the real one before it has to say
   * which tenant it is pretending for. A minute covers an ordinary request
   * that took a while; a fortnight does not.
   */
  private static readonly CLOCK_TOLERANCE = 60_000;

  async runOutbox(workerId: string, now: Date, batch = 10, tenantId?: string): Promise<number> {
    const { rows: claimed } = await this.pool.query<{
      id: number;
      tenant_id: string;
      instance_id: string;
      event_id: number;
      transition_key: string;
      request_id: string;
    }>(
      `update outbox
          set claimed_by = $1, claimed_at = $2, attempts = attempts + 1,
              available_at = $2 + make_interval(secs => $4)
        where id in (
          select id from outbox
           where done_at is null and available_at <= $2
             and ($5::uuid is null or tenant_id = $5)
           order by id
             for update skip locked
           limit $3
        )
        returning id, tenant_id, instance_id, event_id, transition_key, request_id`,
      [workerId, now, batch, VISIBILITY_TIMEOUT_SECONDS, tenantId ?? null],
    );

    let processed = 0;
    for (const row of claimed) {
      /*
       * The worker picks the request back up.
       *
       * This is the one place the chain would otherwise break: the job runs
       * minutes later in a different process, with no memory of what caused
       * it. Re-entering the originating request's context here means every
       * event, action_run and log line the job produces carries the same
       * request id as the submission that started it — which is what makes
       * "show me everything that request caused" answerable at all.
       */
      await withTrace(
        { requestId: row.request_id, source: `worker:${workerId}`, tenantId: row.tenant_id },
        async () => {
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
              email: this.email,
              audit: this.pool,
              eventId: row.event_id,
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
                  -- The cast matters: $2 appears only here, so without it
                  -- Postgres resolves the parameter against the interval on
                  -- the right and decides it is one. This path had never run,
                  -- because until email could fail nothing ever threw.
                  available_at = $2::timestamptz + make_interval(secs => least(300, power(2, attempts)::int))
            where id = $3`,
          [message, now, row.id],
        );
        logIfEnabled('error', 'outbox.failed', {
          jobId: row.id,
          eventId: row.event_id,
          instanceId: row.instance_id,
          transition: row.transition_key,
          error: message,
        });
      }
        },
      );
    }
    return processed;
  }

  /** Runs outbox and timers until neither has anything left to do. */
  async drain(now: Date, workerId = 'drain', tenantId?: string): Promise<void> {
    /*
     * A clock that is not the real one must name the tenant it belongs to.
     *
     * The queue is deliberately shared: one worker drains every tenant, which
     * is what makes it a queue. But `now` is a parameter, and a caller
     * simulating time — a scenario proving a reminder fires after fourteen
     * days, a seed writing a fortnight of history — was claiming *every*
     * tenant's due work at that made-up time. So running the scenario tests
     * in the builder fired other workspaces' timers two weeks early, sent
     * their reminder emails, and left their records with a `state_entered_at`
     * in the future. Their dashboards then reported a negative stage age,
     * which is how this was found.
     *
     * Refused rather than scoped automatically: a caller that has invented a
     * clock knows which tenant it invented it for, and guessing on their
     * behalf would hide the next one of these.
     */
    const drift = Math.abs(now.getTime() - Date.now());
    if (!tenantId && drift > Engine.CLOCK_TOLERANCE) {
      throw new Error(
        `drain was given a clock ${Math.round(drift / 60_000)} minutes from now with no tenant. ` +
          'A simulated clock must name its tenant, or it drains every tenant at a time that has not happened.',
      );
    }

    for (let i = 0; i < 100; i++) {
      const done = await this.runOutbox(workerId, now, 50, tenantId);
      const fired = await this.fireDueTimers(now, 50, tenantId);
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

  // ----------------------------------------------------- console reads

  processesFor(tenantId: string, actorId: string) {
    return processesFor(this.pool, tenantId, actorId);
  }

  myWork(args: { principal: Principal; actorId: string; processKey: string }) {
    return myWork(this.pool, args);
  }

  listRecords(args: { principal: Principal; processKey: string; state?: string; limit: number }) {
    return listRecords(this.pool, args);
  }

  recordDetail(principal: Principal, instanceId: string) {
    return recordDetail(this.pool, principal, instanceId);
  }

  automationHealth(args: { principal: Principal; processKey: string }) {
    return automationHealth(this.pool, args);
  }

  replayAction(args: { principal: Principal; outboxId: number; now: Date }) {
    return replayAction(this.pool, args);
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

export async function appendEvent(
  client: Client,
  args: { tenantId: string; instanceId: string; type: string; payload: unknown; actor: string; now: Date },
): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    `insert into event (tenant_id, instance_id, seq, type, payload, actor, request_id, occurred_at)
     values ($1, $2, (select coalesce(max(seq), 0) + 1 from event where instance_id = $2), $3, $4, $5, $6, $7)
     returning id`,
    [
      args.tenantId,
      args.instanceId,
      args.type,
      JSON.stringify(args.payload),
      args.actor,
      currentRequestId(),
      args.now,
    ],
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
    await scheduleTimers(client, {
      bp,
      instance,
      stateKey: transition.to,
      enteredAt: now,
      data: instance.data,
    });
  }

  await client.query(
    `insert into outbox (tenant_id, instance_id, event_id, transition_key, created_at, available_at, request_id)
     values ($1, $2, $3, $4, $5, $5, $6)`,
    [instance.tenant_id, instance.id, eventId, transition.key, now, currentRequestId()],
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
  args: {
    bp: Blueprint;
    instance: InstanceRow;
    action: Action;
    idempotencyKey: string;
    now: Date;
    email: EmailProvider;
    audit: Pool;
    /** The event that scheduled this. Travels into the webhook envelope so a
        consumer can order and deduplicate (§11.2). */
    eventId?: number;
  },
): Promise<void> {
  const { bp, instance, action, now } = args;

  const { rows: claim } = await client.query<{ id: number }>(
    `insert into action_run (tenant_id, instance_id, idempotency_key, action_do, created_at, request_id, performed_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (instance_id, idempotency_key) do nothing
     returning id`,
    [
      instance.tenant_id,
      instance.id,
      args.idempotencyKey,
      action.do,
      now,
      // The request that caused the work, and the worker that performed it. A
      // retry keeps the first and replaces the second.
      currentRequestId(),
      currentTrace()?.source ?? 'unknown',
    ],
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
    await performEffect(client, {
      bp,
      instance,
      action,
      runId,
      now,
      email: args.email,
      audit: args.audit,
      eventId: args.eventId,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  await client.query("update action_run set status = 'done', completed_at = $1 where id = $2", [now, runId]);
}

async function performEffect(
  client: Client,
  args: {
    bp: Blueprint;
    instance: InstanceRow;
    action: Action;
    runId: number;
    now: Date;
    email: EmailProvider;
    audit: Pool;
    eventId?: number;
  },
): Promise<void> {
  const { bp, instance, action, runId, now } = args;
  const answers = instance.data;

  switch (action.do) {
    case 'send_email': {
      const template = bp.communications.email.find((t) => t.key === action.template)!;
      if (template.skipWhen && evaluate(template.skipWhen, { answers, now })) return;
      const { addresses: recipients, unreachable } = await resolveRecipients(
        client,
        [...template.to, ...template.cc],
        instance,
        bp,
      );
      /*
       * Addresses the provider has already told us not to write to.
       *
       * This is the part of bounce handling that changes what the system
       * does. Recording a hard bounce and then mailing the same dead address
       * on the next transition is not handling it — it is keeping a diary
       * about it, while the sending domain's reputation pays for every
       * repeat.
       */
      const blocked = await blockedRecipients(client, recipients);
      const deliverable = blocked.size
        ? recipients.filter((address) => !blocked.has(address.trim().toLowerCase()))
        : recipients;
      const dropped = [...blocked.entries()].map(([email, reason]) => `${email} (${reason})`);

      if (!deliverable.length) {
        // Nothing to send, but something to say. A template addressed to a
        // role nobody holds, or to nobody we are still allowed to write to,
        // used to leave no trace at all.
        if (unreachable.length || dropped.length) {
          await client.query(
            `insert into email_log
               (tenant_id, instance_id, action_run_id, template_key, recipients, subject, body, provider, status, failure, sent_at)
             values ($1, $2, $3, $4, $5, $6, '', 'none', 'skipped', $7, $8)`,
            [
              instance.tenant_id,
              instance.id,
              runId,
              template.key,
              [],
              render(template.subject, answers),
              [
                unreachable.length ? `nobody holds ${unreachable.join(', ')} in this process` : null,
                dropped.length ? `suppressed: ${dropped.join(', ')}` : null,
              ]
                .filter(Boolean)
                .join('; '),
              now,
            ],
          );
        }
        return;
      }

      const subject = render(template.subject, answers);
      const body = render(template.body, answers);

      // Documents the template attaches, as bytes. They were generated by an
      // earlier action on this record and are read back rather than rebuilt,
      // so the recipient gets the exact file the audit trail checksummed.
      const attachments: Attachment[] = [];
      if (template.attachments.length) {
        const { rows: files } = await client.query<{ filename: string; content: Buffer | null }>(
          `select filename, content from document
            where instance_id = $1 and document_key = any($2::text[]) and content is not null
            order by id`,
          [instance.id, template.attachments],
        );
        for (const file of files) {
          if (file.content) {
            attachments.push({ filename: file.filename, content: file.content, contentType: 'application/pdf' });
          }
        }
      }

      // Written BEFORE the send, so a provider call that never returns still
      // leaves a record that it was attempted.
      //
      // It stays on this transaction's connection, unlike the refusal audit in
      // policy.ts, because it has a foreign key to action_run — whose row was
      // inserted moments ago and is not visible to any other connection yet.
      // What keeps a permanent failure on the record instead is that it is no
      // longer thrown; see below.
      const { rows: logged } = await client.query<{ id: number }>(
        `insert into email_log
           (tenant_id, instance_id, action_run_id, template_key, recipients, subject, body, status, provider, sent_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9)
         returning id`,
        [instance.tenant_id, instance.id, runId, template.key, deliverable, subject, body, args.email.name, now],
      );

      const delivery = await args.email.send({
        from: mailFrom(bp.communications.fromName),
        to: deliverable,
        subject,
        text: body,
        attachments,
        // ADR-0002 reaching past the database: the provider deduplicates on
        // the same key the ledger uses.
        idempotencyKey: String(runId),
        tags: { process: instance.process_key, template: template.key },
      });

      await client.query(
        `update email_log set status = $1, provider_message_id = $2, failure = $3 where id = $4`,
        [
          delivery.status,
          delivery.providerMessageId,
          // `failure` carries the reason a send failed, and also a warning
          // about a send that partly did not happen — a recipient the
          // provider dropped is not a failure of the message, but it is
          // something the record must show.
          delivery.status === 'failed'
            ? (delivery.detail ?? 'send failed')
            : [dropped.length ? `suppressed: ${dropped.join(', ')}` : null, delivery.warning ?? null]
                .filter(Boolean)
                .join('; ') || null,
          logged[0]!.id,
        ],
      );

      // A failure that could succeed on a retry is thrown, so the outbox backs
      // off and tries again. One that cannot — a malformed address, an
      // unverified domain, a suppressed recipient — is committed as failed and
      // left for an operator. Throwing it would roll back the record of it and
      // then repeat the same rejection every five minutes forever.
      if (delivery.status === 'failed' && delivery.retryable) {
        throw new Error(`email provider refused "${template.key}": ${delivery.detail ?? 'unknown'}`);
      }
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
      const filename = render(doc.filename, answers);
      const pdf = renderDocument(doc, mapped, filename);

      // Over the bytes, not over the inputs. "The same record produced the
      // same file" is the claim worth being able to check.
      const checksum = createHash('sha256').update(pdf).digest('hex');

      await client.query(
        `insert into document
           (tenant_id, instance_id, action_run_id, document_key, template_ref, process_version_id,
            checksum, filename, content, byte_size, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          instance.tenant_id,
          instance.id,
          runId,
          doc.key,
          doc.templateRef,
          instance.process_version_id,
          checksum,
          filename,
          pdf,
          pdf.byteLength,
          'system:document',
          now,
        ],
      );
      return;
    }

    case 'call_webhook': {
      /*
       * Queued, not delivered.
       *
       * This used to insert a row with status 'delivered' and make no request
       * at all — a hundred of them in the seeded workspace said delivered and
       * nothing had ever left the machine. The fan-out below writes one
       * pending row per subscribed endpoint, inside this transaction so the
       * deliveries commit with the state change that caused them, and the
       * worker sends them.
       */
      const declared = Object.fromEntries(action.includeFields.map((f) => [f, answers[f] ?? null]));
      const { rows: versionRow } = await client.query<{ version: number }>(
        'select version from process_version where id = $1',
        [instance.process_version_id],
      );
      await queueWebhook(client, {
        tenantId: instance.tenant_id,
        instanceId: instance.id,
        actionRunId: runId,
        eventName: action.event,
        eventId: args.eventId ?? null,
        processKey: instance.process_key,
        processVersion: versionRow[0]?.version ?? 0,
        declared,
        occurredAt: now,
      });
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

/**
 * Renders one document. The template is read from disk and its placeholders
 * filled from the mapping; a template that is missing, or in a format the
 * renderer does not produce, falls back to the mapping laid out plainly —
 * a worse document, but never a missing one.
 */
function renderDocument(
  doc: Blueprint['outputs']['documents'][number],
  mapped: Record<string, unknown>,
  filename: string,
): Buffer {
  const show = (value: unknown): string => {
    if (value === null || value === undefined || value === '') return '-';
    if (Array.isArray(value)) {
      return value
        .map((v) => (v && typeof v === 'object' ? Object.values(v).join(' / ') : String(v)))
        .join(', ');
    }
    return String(value);
  };

  let blocks: Block[] | null = null;

  if (doc.source === 'html') {
    try {
      const template = readFileSync(doc.templateRef, 'utf8');
      const filled = template.replace(PLACEHOLDER, (_m, key: string) => show(mapped[key]));
      blocks = htmlToBlocks(filled);
    } catch {
      blocks = null;
    }
  }

  if (!blocks?.length) {
    // Named for what it is. DOCX rendering is not built, and a template that
    // cannot be read should say so on the page rather than produce a document
    // that silently omits half its content.
    blocks = [
      { kind: 'heading', text: doc.name, level: 1 },
      {
        kind: 'paragraph',
        text:
          doc.source === 'docx'
            ? 'This process asks for a DOCX template. DOCX rendering is not built, so the recorded values are laid out plainly below.'
            : `The template "${doc.templateRef}" could not be read, so the recorded values are laid out plainly below.`,
      },
      { kind: 'rule' },
      ...Object.entries(mapped).map(
        ([label, value]): Block => ({
          kind: 'field',
          label: label.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()),
          value: show(value),
        }),
      ),
    ];
  }

  return renderPdf(blocks, { title: doc.name, producedFor: filename });
}

/** Turns a declared party into concrete addresses. Never a free-form string. */
/**
 * Who a party is.
 *
 * A role resolves to the marker `role:hr_approver` rather than to a list of
 * people, and that is right for a task or an approval: the policy engine reads
 * the marker as "anyone currently holding this role", which is what
 * `completableBy: 'assignee'` promises and what stops a task becoming
 * uncompletable the moment one person leaves.
 *
 * It is wrong for an email, which needs an address. See resolveRecipients.
 */
/**
 * The submitter's own address, as the blueprint declares it.
 *
 * `data.submitterField` names the field. Before it existed the runtime took
 * the first field of type email, which is a positional guess — right in every
 * process we happened to write, and wrong the moment somebody puts the
 * manager's address above the claimant's. Published versions from before the
 * field existed still fall back to the guess, because they are immutable and
 * changing what they mean retroactively is worse than the guess.
 */
function submitterOf(bp: Blueprint, instance: InstanceRow): string | null {
  const key = bp.data.submitterField ?? bp.data.fields.find((f) => f.type === 'email')?.key;
  if (!key) return null;
  const value = instance.data[key];
  return typeof value === 'string' && value ? value : null;
}

/**
 * When a timer leaving this state is due.
 *
 * `null` means it cannot be scheduled yet — a date-relative timer whose date
 * has not been filled in. Returning null rather than guessing is the point:
 * a deadline computed from a missing date is a deadline on the wrong day, and
 * the record would be chased or expired against it.
 */
function dueAtFor(
  trigger: { afterHoursInState?: number; relativeTo?: string; offsetHours?: number },
  enteredAt: Date,
  data: Answers,
): Date | null {
  if (typeof trigger.afterHoursInState === 'number') {
    return new Date(enteredAt.getTime() + trigger.afterHoursInState * 3_600_000);
  }
  if (!trigger.relativeTo) return null;

  const value = data[trigger.relativeTo];
  if (typeof value !== 'string' || !value) return null;

  /*
   * A `date` field is a calendar day with no time on it, so it is read as
   * midnight UTC. Saying so matters: "three days before the start date" then
   * means three days before the start of that day everywhere, rather than
   * drifting by the reader's timezone.
   */
  const base = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + (trigger.offsetHours ?? 0) * 3_600_000);
}

/**
 * Schedules every timer leaving a state, for one occupancy of it.
 *
 * Called on entering a state, and again whenever the record's answers change
 * — because a timer hung off a date field is only as current as that date.
 * Somebody moving a start date forward a week has moved every deadline that
 * hangs off it, and a scheduled row that still holds the old date is a
 * reminder that goes out on a day nobody chose.
 *
 * Idempotent: a timer that already fired is left alone, one already scheduled
 * is moved, and one that cannot be computed yet is simply not there.
 */
async function scheduleTimers(
  client: Client,
  args: { bp: Blueprint; instance: InstanceRow; stateKey: string; enteredAt: Date; data: Answers },
): Promise<void> {
  const { bp, instance, stateKey, enteredAt, data } = args;

  for (const candidate of bp.workflow.transitions) {
    if (candidate.from !== stateKey) continue;
    if (candidate.trigger.on !== 'timer') continue;

    const dueAt = dueAtFor(candidate.trigger, enteredAt, data);
    if (!dueAt) continue;

    /*
     * A date-based timer fires once per record; a duration-based one fires
     * once per occupancy.
     *
     * The difference is what each measures. "Forty-eight hours after arriving"
     * is about how long you have been here, so coming back restarts it — that
     * is what makes a nudge a nudge. "Three days before the start date" is a
     * day in the calendar, and the calendar does not move because the record
     * came back.
     *
     * Without this a date-based timer on a self-loop is an infinite loop: it
     * fires, re-enters the state, reschedules to the same moment which is now
     * in the past, and fires again. The drain would give up after a hundred
     * rounds and call it a workflow loop, which is true but not the useful
     * thing to be told.
     */
    if (candidate.trigger.relativeTo) {
      const { rows: already } = await client.query(
        `select 1 from timer
          where instance_id = $1 and transition_key = $2 and fired_at is not null
          limit 1`,
        [instance.id, candidate.key],
      );
      if (already.length) continue;
    }

    await client.query(
      `insert into timer (tenant_id, instance_id, transition_key, state_key, entered_at, due_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (instance_id, transition_key, entered_at)
         -- Only a timer that has neither fired nor been cancelled moves. A
         -- fired one is history, and history does not get a new due date.
         do update set due_at = excluded.due_at
         where timer.fired_at is null and timer.cancelled_at is null`,
      [instance.tenant_id, instance.id, candidate.key, stateKey, enteredAt, dueAt],
    );
  }
}

function resolveParty(party: Party, instance: InstanceRow, bp: Blueprint): string[] {
  if ('user' in party) return [party.user];
  if ('field' in party) {
    const value = instance.data[party.field];
    return typeof value === 'string' && value ? [value] : [];
  }
  if ('submitter' in party) {
    const address = submitterOf(bp, instance);
    return address ? [address] : [];
  }
  if ('assignee' in party) return instance.assignee ? [instance.assignee] : [];
  return [`role:${party.role}`];
}

/**
 * Who an email actually reaches.
 *
 * This exists because for a long time it did not, and the gap was invisible:
 * `resolveParty` handed back `role:hr_approver`, that string was written into
 * `email_log.recipients` where it reads as a delivered reminder, and one line
 * later it was filtered out of the provider's `to` list. Every role-addressed
 * message was therefore logged as sent and given to the provider with nobody
 * on it. The seeded workspace had been showing a delivered HR reminder that
 * reached no one.
 *
 * The comment that justified it said the spike had no directory and left
 * fan-out to a notification service. `membership` and `actor` are a directory,
 * and the notification service was never built.
 *
 * A role nobody holds resolves to nothing, and the caller records that rather
 * than logging a send. That is a real state — somebody deactivated the only
 * HR approver — and it should be visible on the record, not smoothed over.
 */
async function resolveRecipients(
  client: Client,
  parties: Party[],
  instance: InstanceRow,
  bp: Blueprint,
): Promise<{ addresses: string[]; unreachable: string[] }> {
  const addresses: string[] = [];
  const unreachable: string[] = [];

  for (const party of parties) {
    if (!('role' in party)) {
      for (const who of resolveParty(party, instance, bp)) {
        if (!addresses.includes(who)) addresses.push(who);
      }
      continue;
    }
    const { rows } = await client.query<{ email: string }>(
      `select a.email from membership m
         join actor a on a.id = m.actor_id
        where m.tenant_id = $1 and m.process_key = $2 and m.role_key = $3 and a.active
        order by a.email`,
      [instance.tenant_id, instance.process_key, party.role],
    );
    if (!rows.length) unreachable.push(`role:${party.role}`);
    for (const row of rows) if (!addresses.includes(row.email)) addresses.push(row.email);
  }

  return { addresses, unreachable };
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

/**
 * The duplicate key for a record.
 *
 * Exported because the CSV importer needs the same value, and the first
 * version of that computed its own — joining the raw answers with a null byte,
 * which Postgres text cannot store, so it crashed. Had it not crashed it would
 * have been worse: a different string from this one, so no import would ever
 * have detected a duplicate and nobody would have known why.
 *
 * One implementation, like `validateAnswers`. A second way of deciding whether
 * two records are the same person is a second answer.
 */
export function identityFor(bp: Blueprint, answers: Answers): string | null {
  if (!bp.data.identity?.length) return null;
  const parts = bp.data.identity.map((key) => JSON.stringify(answers[key] ?? null));
  return createHash('sha256').update(parts.join(' ')).digest('hex');
}

export function newWorkerId(): string {
  return `worker-${randomUUID().slice(0, 8)}`;
}
