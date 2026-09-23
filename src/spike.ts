import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Blueprint } from './blueprint/index.js';
import { createPool, describeTarget, resetSchema, type Pool } from './runtime/db.js';
import { Engine, newWorkerId } from './runtime/engine.js';
import { AuthorizationError, type Principal } from './runtime/policy.js';
import {
  proveBuilderRoundTrip,
  proveBuilderPages,
  proveBulkInvite,
  proveDraftLocking,
  proveScreening,
  proveSendingHealth,
  proveBulkActions,
  proveBulkLists,
  proveApprovalModes,
  proveFormLinks,
  proveOAuthConsent,
  proveSecretsAtRest,
  proveStepUp,
  proveCopilot,
  proveDeliveryOutcomes,
  proveDocumentsAndDelivery,
  proveExportThenRetain,
  proveAccountRecovery,
  proveIdentity,
  proveIntake,
  provePrivacy,
  proveRespondentScope,
  proveRetention,
  proveSecondFactor,
  proveTraceability,
  proveWebhooks,
  proveWorkerFiresTimers,
} from './spike-proofs.js';
import { runScenarios } from './runtime/scenarios.js';
import { suppressDelivery } from './runtime/email.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

const T0 = new Date('2026-09-21T09:00:00.000Z');
const hours = (n: number) => n * 3_600_000;

interface Proof {
  name: string;
  claim: string;
  passed: boolean;
  detail: string;
}

const proofs: Proof[] = [];

function record(name: string, claim: string, passed: boolean, detail: string): void {
  proofs.push({ name, claim, passed, detail });
  const mark = passed ? `${GREEN}pass${OFF}` : `${RED}FAIL${OFF}`;
  console.log(`  ${mark}  ${BOLD}${name}${OFF}`);
  console.log(`        ${DIM}${claim}${OFF}`);
  console.log(`        ${detail}`);
}

function loadBlueprints(): Blueprint[] {
  return readdirSync('processes')
    .filter((f) => f.endsWith('.blueprint.json') && !f.startsWith('_'))
    .map((f) => Blueprint.parse(JSON.parse(readFileSync(join('processes', f), 'utf8'))));
}

// --------------------------------------------------------------------------

async function proveScenarios(pool: Pool, blueprints: Blueprint[]): Promise<void> {
  const all = [];
  for (const bp of blueprints) all.push(...(await runScenarios(pool, bp)));

  const failed = all.filter((r) => !r.passed);
  for (const f of failed) {
    console.log(`        ${RED}${f.process}/${f.test}${OFF}: ${f.failures.join('; ')}`);
  }
  record(
    'Blueprint scenarios run against the real engine',
    'Every scenario each blueprint declares, executed by the runtime that would run it in production.',
    failed.length === 0,
    `${all.length - failed.length}/${all.length} scenarios passed across ${blueprints.length} processes.`,
  );
}

async function proveIdempotentEmail(pool: Pool, bp: Blueprint): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:idempotent-email');
  const version = await engine.publish(tenantId, bp, 'proof');

  const { instanceId } = await engine.submit({
    version,
    answers: completeFor(bp, { personal_email: 'once@example.test' }),
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);
  const afterFirst = (await engine.emails(instanceId)).length;

  // Replay the delivery exactly as a crashed-and-retried worker would: the
  // outbox row becomes visible again and is claimed a second time.
  await pool.query('update outbox set done_at = null, available_at = $1 where instance_id = $2', [T0, instanceId]);
  await engine.runOutbox(newWorkerId(), T0, 50);
  await pool.query('update outbox set done_at = null, available_at = $1 where instance_id = $2', [T0, instanceId]);
  await engine.runOutbox(newWorkerId(), T0, 50);

  const afterReplays = (await engine.emails(instanceId)).length;
  const { rows: runs } = await pool.query<{ attempts: number }>(
    'select attempts from action_run where instance_id = $1 order by id',
    [instanceId],
  );
  const { rows: delivery } = await pool.query<{ attempts: number }>(
    'select attempts from outbox where instance_id = $1',
    [instanceId],
  );
  const redelivered = delivery.every((d) => d.attempts >= 3);

  record(
    'Idempotent email under replay',
    'Section 6.5: a stable action key prevents duplicate emails, documents, webhooks, or charges.',
    afterFirst === afterReplays && afterFirst > 0 && redelivered,
    `${afterFirst} email(s) after first delivery, ${afterReplays} after two full replays. ` +
      `The outbox row was delivered ${delivery[0]?.attempts ?? 0} times; the action ran ` +
      `${runs.length} time(s) and every replay short-circuited on the idempotency key.`,
  );
}

async function proveConcurrentWorkers(pool: Pool, bp: Blueprint): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:concurrency');
  const version = await engine.publish(tenantId, bp, 'proof');

  const COUNT = 40;
  const ids: string[] = [];
  for (let i = 0; i < COUNT; i++) {
    const { instanceId } = await engine.submit({
      version,
      answers: completeFor(bp, { personal_email: `c${i}@example.test` }),
      now: T0,
    });
    ids.push(instanceId);
  }

  // Eight workers race for the same queue. Nothing coordinates them except
  // the claim statement.
  const WORKERS = 8;
  const workers = Array.from({ length: WORKERS }, () => newWorkerId());
  const processed = await Promise.all(workers.map((w) => engine.runOutbox(w, T0, 10)));

  // Drain anything the first pass did not reach.
  await engine.drain(T0, 'proof', tenantId);

  const { rows: dupes } = await pool.query<{ count: number }>(
    `select count(*)::int as count from (
       select action_run_id from email_log group by action_run_id having count(*) > 1
     ) d`,
  );
  const { rows: totals } = await pool.query<{ emails: number; runs: number; claims: number }>(
    `select (select count(*)::int from email_log) as emails,
            (select count(*)::int from action_run where status = 'done') as runs,
            (select count(distinct claimed_by)::int from outbox where claimed_by is not null) as claims`,
  );
  const emailsPerInstance = totals[0]!.emails / COUNT;

  record(
    'Concurrent workers never double-process',
    'FOR UPDATE SKIP LOCKED gives each outbox row to exactly one worker, with no lock waits between them.',
    dupes[0]!.count === 0 && Number.isInteger(emailsPerInstance),
    `${WORKERS} workers claimed ${processed.reduce((a, b) => a + b, 0)} rows across ${totals[0]!.claims} distinct worker ids; ` +
      `${totals[0]!.emails} emails for ${COUNT} instances (${emailsPerInstance} each), ${dupes[0]!.count} duplicated effects.`,
  );
}

async function proveCrashRecovery(pool: Pool, bp: Blueprint): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:crash');
  const version = await engine.publish(tenantId, bp, 'proof');

  const { instanceId } = await engine.submit({
    version,
    answers: completeFor(bp, { personal_email: 'crash@example.test' }),
    now: T0,
  });

  // A worker claims the row and then dies before doing anything.
  await pool.query(
    `update outbox
        set claimed_by = 'worker-that-died', claimed_at = $1, attempts = 1,
            available_at = $1::timestamptz + interval '30 seconds'
      where instance_id = $2 and done_at is null`,
    [T0, instanceId],
  );

  const tooSoon = await engine.runOutbox(newWorkerId(), new Date(T0.getTime() + 5_000), 10);
  const afterTimeout = new Date(T0.getTime() + 45_000);
  const recovered = await engine.runOutbox(newWorkerId(), afterTimeout, 10);
  await engine.drain(afterTimeout, 'proof', tenantId);

  const emails = await engine.emails(instanceId);
  const state = (await engine.instance(instanceId)).state;

  record(
    'A dead worker loses nothing and duplicates nothing',
    'A claimed row is invisible for its visibility timeout, then returns to the queue for someone else.',
    tooSoon === 0 && recovered === 1 && emails.length === 1,
    `Another worker saw ${tooSoon} rows at +5s and ${recovered} at +45s. ` +
      `The record reached "${state}" with ${emails.length} email sent, not ${emails.length + 1}.`,
  );
}

async function proveTimers(pool: Pool, bp: Blueprint): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:timers');
  const version = await engine.publish(tenantId, bp, 'proof');

  const { instanceId } = await engine.submit({
    version,
    answers: completeFor(bp, { personal_email: 'timer@example.test' }),
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);

  const early = await engine.fireDueTimers(new Date(T0.getTime() + hours(47)));
  const onTime = await engine.fireDueTimers(new Date(T0.getTime() + hours(49)));
  const again = await engine.fireDueTimers(new Date(T0.getTime() + hours(49)));
  await engine.drain(new Date(T0.getTime() + hours(49)), 'proof', tenantId);

  const reminders = (await engine.emails(instanceId)).filter((e) => e.template_key === 'approval_reminder');

  // Leaving the state must cancel its pending timers.
  const managerId = await engine.createActor(tenantId, 'manager_email@example.test', 'Priya Raman');
  await engine.grant({ tenantId, actorId: managerId, processKey: bp.key, roleKey: 'hiring_manager' });
  await engine.decide({
    instanceId,
    approvalKey: 'manager_approval',
    decision: 'approved',
    principal: { kind: 'actor', tenantId, actorId: managerId },
    now: new Date(T0.getTime() + hours(50)),
  });
  await engine.drain(new Date(T0.getTime() + hours(50)), 'proof', tenantId);
  const { rows: cancelled } = await pool.query<{ count: number }>(
    'select count(*)::int as count from timer where instance_id = $1 and cancelled_at is not null',
    [instanceId],
  );

  record(
    'Timers fire once, on time, and are cancelled on exit',
    'Section 6.5: relative deadlines and reminders, stored canonically in UTC.',
    early === 0 && onTime === 1 && again === 0 && reminders.length === 1 && cancelled[0]!.count > 0,
    `Nothing at +47h, ${onTime} firing at +49h, ${again} on a second sweep at the same instant. ` +
      `${reminders.length} reminder sent; ${cancelled[0]!.count} pending timer${cancelled[0]!.count === 1 ? '' : 's'} cancelled when the record moved on.`,
  );
}

/**
 * A clock one workspace invented must not move another workspace's work.
 *
 * The queue is shared on purpose — one worker drains every tenant, which is
 * what makes it a queue — but `now` is a parameter, and anything simulating
 * time was claiming every tenant's due work at a time that had not happened.
 * Running the scenario tests in the builder fired other workspaces' reminders
 * a fortnight early, sent those emails, and left their records with a
 * `state_entered_at` in the future. Their dashboards then reported a negative
 * stage age, which is the only reason anybody noticed.
 */
async function proveTenantClock(pool: Pool, bp: Blueprint): Promise<void> {
  const engine = new Engine(pool);

  const mine = await engine.createTenant('proof:clock:mine');
  const theirs = await engine.createTenant('proof:clock:theirs');
  const mineVersion = await engine.publish(mine, bp, 'proof');
  const theirsVersion = await engine.publish(theirs, bp, 'proof');

  const a = await engine.submit({
    version: mineVersion,
    answers: completeFor(bp, { personal_email: 'mine@example.test' }),
    now: T0,
  });
  const b = await engine.submit({
    version: theirsVersion,
    answers: completeFor(bp, { personal_email: 'theirs@example.test' }),
    now: T0,
  });
  await engine.drain(T0, 'proof', mine);
  await engine.drain(T0, 'proof', theirs);

  // My workspace runs a scenario that jumps a fortnight to prove a reminder
  // fires. Theirs is doing nothing at all.
  const fortnight = new Date(T0.getTime() + hours(24 * 14));
  await engine.drain(fortnight, 'scenario', mine);

  const minesReminders = (await engine.emails(a.instanceId)).filter((e) => e.template_key === 'approval_reminder');
  const theirsReminders = (await engine.emails(b.instanceId)).filter((e) => e.template_key === 'approval_reminder');

  const theirRecord = await engine.instance(b.instanceId);
  const theirStateIsInTheFuture = theirRecord.state_entered_at.getTime() > Date.now();

  // And the guard itself: a fabricated clock with no tenant is refused rather
  // than quietly applied to everybody.
  let refused = false;
  try {
    await engine.drain(fortnight, 'unscoped');
  } catch {
    refused = true;
  }

  record(
    'A simulated clock moves only the tenant that invented it',
    'Section 9: the outbox is shared across tenants; a fabricated clock is not.',
    minesReminders.length > 0 && theirsReminders.length === 0 && !theirStateIsInTheFuture && refused,
    `Advancing my workspace fourteen days sent ${minesReminders.length} reminder${minesReminders.length === 1 ? '' : 's'} here and ` +
      `${theirsReminders.length} next door. Their record's state clock is ${theirStateIsInTheFuture ? 'in the future' : 'still in the past'}. ` +
      `An unscoped fabricated clock was ${refused ? 'refused' : 'ACCEPTED'}.`,
  );
}

/**
 * Work that happens in parallel, modelled as parallel.
 *
 * Onboarding issues equipment and creates accounts at the same time. The only
 * trigger used to be `task_completed` for one named task, so the blueprint
 * chained them — finishing equipment created the accounts task — which meant
 * the accounts task did not exist until equipment was done. IT could not do
 * them in the other order, or at the same time, which is how they are
 * actually done.
 *
 * A join fires when the last of the tasks it names is finished. This proves
 * the three things that makes it worth having: both tasks exist from the
 * start, neither one alone releases the record, and either order works.
 */
async function proveParallelTasks(pool: Pool, bp: Blueprint): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:parallel');
  const version = await engine.publish(tenantId, bp, 'proof');

  const managerId = await engine.createActor(tenantId, 'manager_email@example.test', 'Priya Raman');
  await engine.grant({ tenantId, actorId: managerId, processKey: bp.key, roleKey: 'hiring_manager' });
  const hrId = await engine.createActor(tenantId, 'hr@example.test', 'Sam Boateng');
  await engine.grant({ tenantId, actorId: hrId, processKey: bp.key, roleKey: 'hr_approver' });
  const itId = await engine.createActor(tenantId, 'it@example.test', 'Ini Etim');
  await engine.grant({ tenantId, actorId: itId, processKey: bp.key, roleKey: 'it_operator' });
  const it: Principal = { kind: 'actor', tenantId, actorId: itId };

  /** Submit and get both approvals out of the way, leaving the record in provisioning. */
  const intoProvisioning = async (email: string): Promise<string> => {
    const { instanceId } = await engine.submit({
      version,
      answers: completeFor(bp, { personal_email: email }),
      now: T0,
    });
    await engine.drain(T0, 'proof', tenantId);
    for (const [approvalKey, actorId] of [
      ['manager_approval', managerId],
      ['hr_approval', hrId],
    ] as const) {
      await engine.decide({
        instanceId,
        approvalKey,
        decision: 'approved',
        principal: { kind: 'actor', tenantId, actorId },
        now: T0,
      });
      await engine.drain(T0, 'proof', tenantId);
    }
    return instanceId;
  };

  const openTasks = async (instanceId: string): Promise<string[]> => {
    const { rows } = await pool.query<{ task_key: string }>(
      `select task_key from task where instance_id = $1 and status = 'open' order by task_key`,
      [instanceId],
    );
    return rows.map((r) => r.task_key);
  };
  const stateOf = async (instanceId: string): Promise<string> => (await engine.instance(instanceId)).state;

  // ---- 1. Both exist at once, rather than one appearing when the other ends.
  const a = await intoProvisioning('parallel.a@example.test');
  const bothOpen = await openTasks(a);

  // ---- 2. Equipment first. One task done is not the job done.
  await engine.completeTask({ instanceId: a, taskKey: 'issue_equipment', principal: it, now: T0 });
  await engine.drain(T0, 'proof', tenantId);
  const afterFirstTask = await stateOf(a);

  await engine.completeTask({ instanceId: a, taskKey: 'create_accounts', principal: it, now: T0 });
  await engine.drain(T0, 'proof', tenantId);
  const afterBoth = await stateOf(a);

  // ---- 3. The other order, which the chain made impossible.
  const b = await intoProvisioning('parallel.b@example.test');
  await engine.completeTask({ instanceId: b, taskKey: 'create_accounts', principal: it, now: T0 });
  await engine.drain(T0, 'proof', tenantId);
  const reverseAfterFirst = await stateOf(b);
  await engine.completeTask({ instanceId: b, taskKey: 'issue_equipment', principal: it, now: T0 });
  await engine.drain(T0, 'proof', tenantId);
  const reverseAfterBoth = await stateOf(b);

  // ---- 4. The join fired once, not once per task.
  const { rows: completions } = await pool.query<{ count: number }>(
    `select count(*)::int as count from event
      where instance_id = $1 and type = 'task_completed' and payload ? 'tasks'`,
    [b],
  );

  const fannedOut = bothOpen.includes('issue_equipment') && bothOpen.includes('create_accounts');

  record(
    'Parallel work finishes in either order, and only when all of it is done',
    'docs/failure-cases.md G1: a fan-out modelled as a chain is slower than the real process and breaks if the work is done in the other order.',
    fannedOut &&
      afterFirstTask === 'provisioning' &&
      afterBoth === 'complete' &&
      reverseAfterFirst === 'provisioning' &&
      reverseAfterBoth === 'complete' &&
      completions[0]!.count === 1,
    `Both tasks were open together (${bothOpen.join(', ')}). Equipment first left the record in ` +
      `"${afterFirstTask}"; accounts then took it to "${afterBoth}". Accounts first left it in ` +
      `"${reverseAfterFirst}"; equipment then took it to "${reverseAfterBoth}". The join fired ` +
      `${completions[0]!.count} time, on the completion that arrived last.`,
  );
}

/**
 * A claimant cannot approve their own claim.
 *
 * Expense approval addresses the manager approval to `{ field: manager_email }`
 * — an address the claimant types. Nothing stopped them typing their own, and
 * the blueprint had no way to describe the control that would. It is the most
 * likely fraud in the whole process.
 *
 * Proved against the real claim, not a contrived one: the record is submitted
 * with the claimant's own address in the manager field, which is exactly what
 * somebody defrauding this would do.
 */
async function proveSeparationOfDuties(pool: Pool, bp: Blueprint): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:separation');
  const version = await engine.publish(tenantId, bp, 'proof');

  const claimantEmail = 'claimant@example.test';
  const honestManager = 'real.manager@example.test';

  const claimantId = await engine.createActor(tenantId, claimantEmail, 'A Claimant');
  await engine.grant({ tenantId, actorId: claimantId, processKey: bp.key, roleKey: 'line_manager' });
  const managerId = await engine.createActor(tenantId, honestManager, 'A Manager');
  await engine.grant({ tenantId, actorId: managerId, processKey: bp.key, roleKey: 'line_manager' });

  const asClaimant: Principal = { kind: 'actor', tenantId, actorId: claimantId };
  const asManager: Principal = { kind: 'actor', tenantId, actorId: managerId };

  // 1. The fraud: the claimant names themselves as their own approver.
  /*
   * Over the threshold on purpose. A claim of a hundred pounds or less is
   * approved on submission, so there is no decision for anybody to be barred
   * from — proving the control against one of those would prove nothing.
   */
  const claim = [{ line_description: 'Hotel', line_amount: 450 }];
  const own = await engine.submit({
    version,
    answers: completeFor(bp, {
      employee_email: claimantEmail,
      manager_email: claimantEmail,
      line_items: claim,
    }),
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);

  const reachedReview = (await engine.instance(own.instanceId)).state;

  let refusal = '';
  try {
    await engine.decide({
      instanceId: own.instanceId,
      approvalKey: 'manager_approval',
      decision: 'approved',
      principal: asClaimant,
      reason: 'Looks fine to me.',
      now: T0,
    });
  } catch (err) {
    refusal = err instanceof AuthorizationError ? err.reason : String(err);
  }
  const stillWaiting = (await engine.instance(own.instanceId)).state;

  /*
   * 2. And the control is not simply "nobody may approve". A different person
   *    holding the same role, named the same way, decides it normally — which
   *    is the half of this that a blunt refusal would break.
   */
  /*
   * A different date, because the two claims would otherwise be the same
   * claim. `data.identity` is employee, date and cost centre, so submitting
   * the second with the first's date returns the first record — and the
   * "somebody else can approve" half would have been run against the record
   * that names the claimant, and refused for the wrong reason.
   */
  const honest = await engine.submit({
    version,
    answers: completeFor(bp, {
      employee_email: claimantEmail,
      manager_email: honestManager,
      expense_date: '2026-01-03',
      line_items: claim,
    }),
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);
  await engine.decide({
    instanceId: honest.instanceId,
    approvalKey: 'manager_approval',
    decision: 'approved',
    principal: asManager,
    reason: 'Checked against the rota.',
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);
  const movedOn = (await engine.instance(honest.instanceId)).state;

  record(
    'The person who submitted a record cannot approve it',
    'docs/failure-cases.md G5: the claimant types the approver address, so nothing stopped them typing their own.',
    reachedReview === 'manager_review' &&
      refusal === 'the person who submitted a record may not approve it' &&
      stillWaiting === 'manager_review' &&
      movedOn !== 'manager_review',
    `A £450 claim reached "${reachedReview}", so there was a real decision to make. Approving their own ` +
      `claim was refused — "${refusal || 'NOT REFUSED'}" — and the record stayed in "${stillWaiting}". ` +
      `The same approval, named the same way, was decided by somebody else and the record moved to "${movedOn}".`,
  );
}

/**
 * A deadline hung off a date, not off when somebody got round to it.
 *
 * The only clock was `afterHoursInState`, so "chase the equipment three days
 * before the start date" was inexpressible: a hire approved in March and one
 * approved the day before they start got the same schedule. Onboarding wanted
 * exactly this and could not say it.
 *
 * Three things need proving, and the third is the one that would have shipped
 * broken: the deadline lands on the date rather than on the arrival, editing
 * the date moves it, and a date timer on a self-loop does not fire forever.
 */
async function proveDateRelativeTimers(pool: Pool, bp: Blueprint): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:date-timers');
  const version = await engine.publish(tenantId, bp, 'proof');

  const managerId = await engine.createActor(tenantId, 'manager_email@example.test', 'A Manager');
  await engine.grant({ tenantId, actorId: managerId, processKey: bp.key, roleKey: 'hiring_manager' });
  const hrId = await engine.createActor(tenantId, 'hr@example.test', 'An Approver');
  await engine.grant({ tenantId, actorId: hrId, processKey: bp.key, roleKey: 'hr_approver' });
  const itId = await engine.createActor(tenantId, 'it@example.test', 'IT');
  await engine.grant({ tenantId, actorId: itId, processKey: bp.key, roleKey: 'it_operator' });
  // Approving and editing are different capabilities on purpose, so moving a
  // start date needs somebody who may edit rather than the approver.
  const adminId = await engine.createActor(tenantId, 'admin@example.test', 'HR Admin');
  await engine.grant({ tenantId, actorId: adminId, processKey: bp.key, roleKey: 'hr_admin' });

  /** Approve both gates so the record reaches provisioning, where the chase lives. */
  const intoProvisioning = async (email: string, startDate: string): Promise<string> => {
    const { instanceId } = await engine.submit({
      version,
      answers: completeFor(bp, { personal_email: email, start_date: startDate }),
      now: T0,
    });
    await engine.drain(T0, 'proof', tenantId);
    for (const [approvalKey, actorId] of [
      ['manager_approval', managerId],
      ['hr_approval', hrId],
    ] as const) {
      await engine.decide({
        instanceId,
        approvalKey,
        decision: 'approved',
        principal: { kind: 'actor', tenantId, actorId },
        now: T0,
      });
      await engine.drain(T0, 'proof', tenantId);
    }
    return instanceId;
  };

  const chaseDue = async (instanceId: string): Promise<Date | null> => {
    const { rows } = await pool.query<{ due_at: Date }>(
      `select due_at from timer
        where instance_id = $1 and transition_key = 'chase_before_start'
          and fired_at is null and cancelled_at is null
        order by id desc limit 1`,
      [instanceId],
    );
    return rows[0]?.due_at ?? null;
  };

  // ---- 1. The deadline is three days before the start date, whenever the
  //         record happened to arrive.
  const farOff = await intoProvisioning('kit.far@example.test', '2027-03-01');
  const soon = await intoProvisioning('kit.soon@example.test', '2026-10-05');

  const farDue = await chaseDue(farOff);
  const soonDue = await chaseDue(soon);
  const expected = (date: string) => new Date(new Date(`${date}T00:00:00.000Z`).getTime() - 72 * 3_600_000);

  const landsOnTheDate =
    farDue?.getTime() === expected('2027-03-01').getTime() &&
    soonDue?.getTime() === expected('2026-10-05').getTime();

  // Two records that arrived at the same instant have different deadlines,
  // which is the whole point and is impossible with afterHoursInState.
  const differByDate = farDue !== null && soonDue !== null && farDue.getTime() !== soonDue.getTime();

  // ---- 2. Moving the date moves the deadline.
  /*
   * Assert the edit landed, not just that it was attempted.
   *
   * The first version of this did not, and passed while changing nothing:
   * `hr_admin` held the `edit` capability and listed no `editableFields`, so
   * the runtime refused every field and returned `refused` rather than
   * throwing. A proof about rescheduling that never reschedules anything is
   * worse than no proof. SEC012 now warns about the blueprint side of it.
   */
  const edit = await engine.updateRecord({
    instanceId: soon,
    patch: { start_date: '2026-11-16' },
    principal: { kind: 'actor', tenantId, actorId: adminId },
    now: T0,
  });
  const afterEdit = await chaseDue(soon);
  const followedTheEdit = edit.saved && afterEdit?.getTime() === expected('2026-11-16').getTime();

  // ---- 3. The self-loop does not become a loop.
  //
  // The chase returns the record to provisioning. A duration timer would
  // restart, which is what a nudge wants; a date timer rescheduled to the
  // same moment would already be overdue and fire again immediately, forever.
  const afterTheDate = new Date(expected('2026-11-16').getTime() + 3_600_000);
  await engine.drain(afterTheDate, 'proof', tenantId);
  await engine.drain(afterTheDate, 'proof', tenantId);

  const { rows: fired } = await pool.query<{ count: number }>(
    `select count(*)::int as count from timer
      where instance_id = $1 and transition_key = 'chase_before_start' and fired_at is not null`,
    [soon],
  );
  const { rows: chases } = await pool.query<{ count: number }>(
    `select count(*)::int as count from email_log
      where instance_id = $1 and template_key = 'kit_chase'`,
    [soon],
  );

  record(
    'A deadline can hang off a date in the record, and moves when that date does',
    'docs/failure-cases.md G4: the only clock was time-in-state, so a hire approved in March and one approved the day before they start got the same schedule.',
    landsOnTheDate &&
      differByDate &&
      followedTheEdit &&
      fired[0]!.count === 1 &&
      chases[0]!.count === 1,
    `Two records entered provisioning at the same instant with start dates five months apart and got ` +
      `deadlines ${farDue?.toISOString().slice(0, 10)} and ${soonDue?.toISOString().slice(0, 10)} — three days ` +
      `before each. The start date was ${edit.saved ? 'moved' : 'REFUSED'} to 16 November and the deadline ` +
      `followed to ${afterEdit?.toISOString().slice(0, 10)}. Draining twice past the date fired it ` +
      `${fired[0]!.count} time and sent ${chases[0]!.count} chase, rather than looping on its own self-transition.`,
  );
}

async function proveDuplicateSubmission(pool: Pool, bp: Blueprint): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:duplicates');
  const version = await engine.publish(tenantId, bp, 'proof');
  const answers = completeFor(bp, { personal_email: 'twice@example.test' });

  // Two submissions arriving at the same moment, as a double-clicked button or
  // a retried request would.
  const [first, second] = await Promise.all([
    engine.submit({ version, answers, now: T0 }),
    engine.submit({ version, answers, now: T0 }),
  ]);
  await engine.drain(T0, 'proof', tenantId);

  const { rows } = await pool.query<{ count: number }>(
    'select count(*)::int as count from instance where tenant_id = $1',
    [tenantId],
  );
  const emails = await engine.emails(first.instanceId);
  const events = await engine.events(first.instanceId);

  record(
    'A double submission makes one case',
    'Section 4.2: duplicates are handled without losing the original audit trail.',
    rows[0]!.count === 1 &&
      first.instanceId === second.instanceId &&
      emails.length === 1 &&
      events.some((e) => e.type === 'duplicate_submission_ignored'),
    `${rows[0]!.count} instance from 2 concurrent submissions, ${emails.length} receipt sent. ` +
      `The second attempt is still on the record as "${events.find((e) => e.type === 'duplicate_submission_ignored')?.type}".`,
  );
}

async function proveVersionImmutability(pool: Pool, bp: Blueprint): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:versions');
  const v1 = await engine.publish(tenantId, bp, 'proof');

  const { instanceId } = await engine.submit({
    version: v1,
    answers: completeFor(bp, { personal_email: 'v1@example.test' }),
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);

  // Publish a changed version while the first record is in flight.
  const changed: Blueprint = structuredClone(bp);
  changed.workflow.states.find((s) => s.key === 'manager_review')!.slaHours = 12;
  const v2 = await engine.publish(tenantId, changed, 'proof');

  let editRejected = false;
  try {
    await pool.query('update process_version set blueprint = $1 where id = $2', [{}, v1.id]);
  } catch {
    editRejected = true;
  }

  let eventEditRejected = false;
  try {
    await pool.query("update event set type = 'tampered' where instance_id = $1", [instanceId]);
  } catch {
    eventEditRejected = true;
  }

  const instance = await engine.instance(instanceId);
  const stillOnV1 = instance.process_version_id === v1.id;

  record(
    'A published version cannot be edited, and a live record keeps the version it started under',
    'Section 9.2: published versions are immutable; every instance records the version that governs it.',
    editRejected && eventEditRejected && stillOnV1 && v2.version === v1.version + 1,
    `Editing v${v1.version} was refused by the database, not by convention. Editing its event history was refused too. ` +
      `v${v2.version} is live, and the in-flight record still runs under v${v1.version}.`,
  );
}

async function measurePerformance(pool: Pool, bp: Blueprint): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:performance');
  const version = await engine.publish(tenantId, bp, 'proof');

  const N = 100;
  const ackTimes: number[] = [];
  const startTimes: number[] = [];

  for (let i = 0; i < N; i++) {
    const answers = completeFor(bp, { personal_email: `p${i}@example.test` });
    const t0 = performance.now();
    const { instanceId } = await engine.submit({ version, answers, now: T0 });
    ackTimes.push(performance.now() - t0);

    const t1 = performance.now();
    await engine.runOutbox(newWorkerId(), T0, 1);
    startTimes.push(performance.now() - t1);
    void instanceId;
  }

  const p95 = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;
  const ackP95 = p95(ackTimes);
  const startP95 = p95(startTimes);

  // Section 10.4 beta targets: acknowledgment p95 under 1.5s, workflow start
  // p95 under 30s. Those are end-to-end over a network; this is the database
  // portion only, which is the part the architecture controls.
  record(
    'Submission and workflow start are far inside the section 10.4 budget',
    'Beta targets: acknowledgment p95 under 1.5s, workflow start p95 under 30s.',
    ackP95 < 1500 && startP95 < 30_000,
    `Over ${N} submissions: acknowledgment p95 ${ackP95.toFixed(1)}ms (budget 1500ms), ` +
      `first action p95 ${startP95.toFixed(1)}ms (budget 30000ms). Database round trips only, local container.`,
  );
}

async function proveAuthorization(pool: Pool, bp: Blueprint): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:authorization');
  const other = await engine.createTenant('proof:another-tenant');
  const version = await engine.publish(tenantId, bp, 'proof');

  const { instanceId } = await engine.submit({
    version,
    answers: completeFor(bp, { personal_email: 'auth@example.test' }),
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);

  // The person the record actually names as approver.
  const namedId = await engine.createActor(tenantId, 'manager_email@example.test', 'Named Manager');
  await engine.grant({ tenantId, actorId: namedId, processKey: bp.key, roleKey: 'hiring_manager' });

  // Someone with the same role and capability, who this record does not name.
  const otherManagerId = await engine.createActor(tenantId, 'someone.else@example.test', 'Other Manager');
  await engine.grant({ tenantId, actorId: otherManagerId, processKey: bp.key, roleKey: 'hiring_manager' });

  // An operator with no approve capability at all.
  const itId = await engine.createActor(tenantId, 'it@example.test', 'IT Operator');
  await engine.grant({ tenantId, actorId: itId, processKey: bp.key, roleKey: 'it_operator' });

  // A manager in a different workspace entirely.
  const foreignId = await engine.createActor(other, 'manager_email@example.test', 'Foreign Manager');
  await engine.grant({ tenantId: other, actorId: foreignId, processKey: bp.key, roleKey: 'hiring_manager' });

  const refused = async (principal: Parameters<Engine['decide']>[0]['principal']) => {
    try {
      await engine.decide({ instanceId, approvalKey: 'manager_approval', decision: 'approved', principal, now: T0 });
      return null;
    } catch (err) {
      return err instanceof AuthorizationError ? err.reason : `unexpected: ${String(err)}`;
    }
  };

  const crossTenant = await refused({ kind: 'actor', tenantId: other, actorId: foreignId });
  const wrongCapability = await refused({ kind: 'actor', tenantId, actorId: itId });
  const notNamed = await refused({ kind: 'actor', tenantId, actorId: otherManagerId });
  const respondent = await refused({ kind: 'respondent', tenantId });

  // Field-level reads: the hiring manager may open the record but not the
  // payroll fields the blueprint hides from them.
  const asManager = await engine.recordFor({ kind: 'actor', tenantId, actorId: namedId }, instanceId);
  const hiddenRedacted = asManager.data.national_id === '[redacted]' && asManager.data.bank_account === '[redacted]';
  const visibleKept = typeof asManager.data.job_title === 'string' && asManager.data.job_title !== '[redacted]';

  // Field-level writes: `edit` is not permission to change everything.
  const newHireId = await engine.createActor(tenantId, 'hire@example.test', 'New Hire');
  await engine.grant({ tenantId, actorId: newHireId, processKey: bp.key, roleKey: 'hr_admin' });
  const edit = await engine.updateRecord({
    instanceId,
    patch: { national_id: 'TAMPERED' },
    principal: { kind: 'actor', tenantId, actorId: newHireId },
    now: T0,
  });

  // And the one the record does name is allowed through.
  const allowed = await engine.decide({
    instanceId,
    approvalKey: 'manager_approval',
    decision: 'approved',
    principal: { kind: 'actor', tenantId, actorId: namedId },
    now: T0,
  });

  const denials = await engine.denials(tenantId);

  record(
    'Authorization is enforced by the runtime, not by the caller',
    'Section 6.1 IAM-03: every authorization check is enforced server-side. Section 12.1: deny by default.',
    crossTenant !== null &&
      wrongCapability !== null &&
      notNamed !== null &&
      respondent !== null &&
      hiddenRedacted &&
      visibleKept &&
      edit.saved === false &&
      allowed.applied === true &&
      denials.length >= 4,
    `Refused: a manager from another tenant ("${crossTenant}"), an operator without the capability ` +
      `("${wrongCapability}"), a manager the request does not name ("${notNamed}"), and a respondent ("${respondent}"). ` +
      `Payroll fields came back redacted to the hiring manager while the job title did not. ` +
      `An edit outside the role's editable fields was refused. The named approver was allowed. ` +
      `${denials.length} refusals are on the audit record.`,
  );
}

function completeFor(bp: Blueprint, overrides: Record<string, unknown>): Record<string, unknown> {
  const answers: Record<string, unknown> = { ...overrides };
  for (const field of bp.data.fields) {
    if (!field.required || field.key in answers) continue;
    switch (field.type) {
      case 'email':
        answers[field.key] = `${field.key}@example.test`;
        break;
      case 'date':
        answers[field.key] = '2026-11-02';
        break;
      case 'yes_no':
      case 'signature_ack':
        answers[field.key] = true;
        break;
      case 'single_choice':
      case 'dropdown':
        answers[field.key] = field.choices?.[0]?.value ?? 'unknown';
        break;
      case 'multi_choice':
        answers[field.key] = field.choices?.length ? [field.choices[0]!.value] : [];
        break;
      case 'file':
        answers[field.key] = `${field.key}.pdf`;
        break;
      case 'number':
      case 'currency':
      case 'rating':
        answers[field.key] = 1;
        break;
      default:
        answers[field.key] = `placeholder ${field.key}`;
    }
  }
  return answers;
}

// --------------------------------------------------------------------------

async function main(): Promise<void> {
  suppressDelivery('the proof suite must not deliver to real inboxes');
  /*
   * Its own database when one is named. Every proof starts by dropping the
   * schema, so running it against the database the app is using signs every
   * member out and empties the workspace — which is exactly what happened to
   * somebody trying to sign in while it ran.
   */
  const target = process.env.PROOF_DATABASE_URL || undefined;
  const pool = createPool(16, target);
  console.log(`\n${BOLD}Runtime spike${OFF} ${DIM}- ${describeTarget(target)}${OFF}`);

  const { rows: server } = await pool.query<{ version: string }>('select version()');
  console.log(`${DIM}${server[0]!.version.split(',')[0]}${OFF}\n`);

  const blueprints = loadBlueprints();
  const onboarding = blueprints.find((b) => b.key === 'employee_onboarding')!;
  // Separation of duties is proved against expense approval, because that is
  // the process where the claimant supplies their own approver's address.
  const expense = blueprints.find((b) => b.key === 'expense_approval')!;
  const ctx = { pool, bp: onboarding, T0, record, completeFor };

  const steps: [string, () => Promise<void>][] = [
    ['scenarios', () => proveScenarios(pool, blueprints)],
    ['authorization', () => proveAuthorization(pool, onboarding)],
    ['intake', () => proveIntake(ctx)],
    ['documents and delivery', () => proveDocumentsAndDelivery(ctx)],
    ['respondent scope', () => proveRespondentScope(ctx)],
    ['builder round trip', () => proveBuilderRoundTrip(ctx)],
    ['draft locking', () => proveDraftLocking(ctx)],
    ['builder pages', () => proveBuilderPages(ctx)],
    ['bulk invite', () => proveBulkInvite(ctx)],
    ['spam screening', () => proveScreening(ctx)],
    ['sending health', () => proveSendingHealth(ctx)],
    ['bulk actions', () => proveBulkActions(ctx)],
    ['bulk lists', () => proveBulkLists(ctx)],
    ['approval modes', () => proveApprovalModes(ctx)],
    ['form links', () => proveFormLinks(ctx)],
    ['oauth consent', () => proveOAuthConsent(ctx)],
    ['secrets at rest', () => proveSecretsAtRest(ctx)],
    ['step-up', () => proveStepUp(ctx)],
    ['copilot', () => proveCopilot(ctx)],
    ['traceability', () => proveTraceability(ctx)],
    ['export then retain', () => proveExportThenRetain(ctx)],
    ['identity', () => proveIdentity(ctx)],
    ['account recovery', () => proveAccountRecovery(ctx)],
    ['second factor', () => proveSecondFactor(ctx)],
    ['delivery outcomes', () => proveDeliveryOutcomes(ctx)],
    ['privacy', () => provePrivacy(ctx)],
    ['webhooks', () => proveWebhooks(ctx)],
    ['worker', () => proveWorkerFiresTimers(ctx)],
    ['retention', () => proveRetention(ctx)],
    ['idempotent email', () => proveIdempotentEmail(pool, onboarding)],
    ['concurrency', () => proveConcurrentWorkers(pool, onboarding)],
    ['crash recovery', () => proveCrashRecovery(pool, onboarding)],
    ['timers', () => proveTimers(pool, onboarding)],
    ['tenant clock', () => proveTenantClock(pool, onboarding)],
    ['parallel tasks', () => proveParallelTasks(pool, onboarding)],
    ['separation of duties', () => proveSeparationOfDuties(pool, expense)],
    ['date-relative timers', () => proveDateRelativeTimers(pool, onboarding)],
    ['duplicates', () => proveDuplicateSubmission(pool, onboarding)],
    ['versioning', () => proveVersionImmutability(pool, onboarding)],
    ['performance', () => measurePerformance(pool, onboarding)],
  ];

  for (const [, run] of steps) {
    await resetSchema(pool);
    await run();
    console.log('');
  }

  const failed = proofs.filter((p) => !p.passed);
  console.log(
    failed.length
      ? `${RED}${failed.length} of ${proofs.length} proofs failed${OFF}\n`
      : `${GREEN}all ${proofs.length} proofs passed${OFF}\n`,
  );

  mkdirSync('docs', { recursive: true });
  writeFileSync(
    'docs/spike-results.json',
    JSON.stringify({ ranAt: new Date().toISOString(), postgres: server[0]!.version, proofs }, null, 2) + '\n',
  );

  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
