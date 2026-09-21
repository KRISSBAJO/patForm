import type { Blueprint } from './blueprint/index.js';
import type { Pool } from './runtime/db.js';
import { Engine, newWorkerId } from './runtime/engine.js';
import { AuthorizationError, type Principal } from './runtime/policy.js';
import { resolveResumeToken } from './runtime/auth.js';
import { runRetention } from './runtime/retention.js';

/**
 * Proofs for the gaps closed after the first spike: respondent scoping, a
 * worker that actually fires deadlines, and retention that can delete against
 * an append-only history.
 */

export type Record_ = (name: string, claim: string, passed: boolean, detail: string) => void;

export interface ProofCtx {
  pool: Pool;
  bp: Blueprint;
  T0: Date;
  record: Record_;
  completeFor: (bp: Blueprint, overrides: Record<string, unknown>) => Record<string, unknown>;
}

const hours = (n: number) => n * 3_600_000;

export async function proveRespondentScope({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:respondent');
  const version = await engine.publish(tenantId, bp, 'proof');

  const mine = await engine.submit({ version, answers: completeFor(bp, { personal_email: 'mine@example.test' }), now: T0 });
  const theirs = await engine.submit({ version, answers: completeFor(bp, { personal_email: 'theirs@example.test' }), now: T0 });
  await engine.drain(T0);

  const scope = await resolveResumeToken(pool, mine.resumeToken!);
  const holder: Principal = { kind: 'respondent', tenantId, instanceId: scope!.instanceId };
  const unscoped: Principal = { kind: 'respondent', tenantId };

  const tryRead = async (principal: Principal, instanceId: string) => {
    try {
      await engine.recordFor(principal, instanceId);
      return null;
    } catch (err) {
      return err instanceof AuthorizationError ? err.reason : `unexpected: ${String(err)}`;
    }
  };

  const ownRecord = await tryRead(holder, mine.instanceId);
  const otherRecord = await tryRead(holder, theirs.instanceId);
  const noToken = await tryRead(unscoped, mine.instanceId);

  let approveRefused: string | null = null;
  try {
    await engine.decide({
      instanceId: mine.instanceId,
      approvalKey: 'manager_approval',
      decision: 'approved',
      principal: holder,
      now: T0,
    });
  } catch (err) {
    approveRefused = err instanceof AuthorizationError ? err.reason : null;
  }

  await pool.query('update resume_token set revoked_at = now()');
  const afterRevoke = await resolveResumeToken(pool, mine.resumeToken!);

  record(
    'A resume link opens one record and no others',
    'Section 12.3: broken object authorization in public resume and file links.',
    ownRecord === null &&
      otherRecord !== null &&
      noToken !== null &&
      approveRefused !== null &&
      afterRevoke === null &&
      Boolean(mine.resumeToken) &&
      mine.resumeToken !== theirs.resumeToken,
    `The holder read their own record and was refused somebody else's ("${otherRecord}"). ` +
      `A respondent with no token was refused even their own ("${noToken}"), and approving was refused ("${approveRefused}"). ` +
      `Revoking the link made it resolve to nothing. Before this, "a respondent may view" meant any record in the tenant.`,
  );
}

export async function proveWorkerFiresTimers({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:worker');
  const version = await engine.publish(tenantId, bp, 'proof');

  const { instanceId } = await engine.submit({
    version,
    answers: completeFor(bp, { personal_email: 'timer@example.test' }),
    now: T0,
  });
  await engine.drain(T0);

  // Nobody opens the console and nobody calls the API. This is the loop
  // src/worker.ts runs; before it existed, the reminder below never went out.
  const later = new Date(T0.getTime() + hours(49));
  const workerId = newWorkerId();
  let rounds = 0;
  for (let i = 0; i < 20; i++) {
    const delivered = await engine.runOutbox(workerId, later, 25);
    const fired = await engine.fireDueTimers(later, 25);
    rounds++;
    if (!delivered && !fired) break;
  }

  const reminders = (await engine.emails(instanceId)).filter((e) => e.template_key === 'approval_reminder');
  const { rows: unfired } = await pool.query<{ count: number }>(
    `select count(*)::int as count from timer
      where instance_id = $1 and fired_at is null and cancelled_at is null and due_at <= $2`,
    [instanceId, later],
  );

  record(
    'A worker fires deadlines with nobody watching',
    'Section 10.1: queue-backed workers. A deadline that needs an operator to open a page is not a deadline.',
    reminders.length === 1 && unfired[0]!.count === 0,
    `Forty-nine hours passed with no request of any kind. The loop settled in ${rounds} round(s), sent ` +
      `${reminders.length} reminder and left ${unfired[0]!.count} due timers unfired.`,
  );
}

export async function proveRetention({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:retention');
  const version = await engine.publish(tenantId, bp, 'proof');

  const adminId = await engine.createActor(tenantId, 'admin@example.test', 'Admin', 'admin');
  await engine.grant({ tenantId, actorId: adminId, processKey: bp.key, roleKey: 'hr_admin' });
  const admin: Principal = { kind: 'actor', tenantId, actorId: adminId };

  const operatorId = await engine.createActor(tenantId, 'op@example.test', 'Operator', 'operator');
  await engine.grant({ tenantId, actorId: operatorId, processKey: bp.key, roleKey: 'it_operator' });
  const operator: Principal = { kind: 'actor', tenantId, actorId: operatorId };

  const { instanceId } = await engine.submit({
    version,
    answers: completeFor(bp, { personal_email: 'old@example.test' }),
    now: T0,
  });
  // A second, current record. It must survive the run, and it is what gives
  // the append-only check something to refuse afterwards — a delete that
  // matches no rows never reaches the trigger, so without this the last
  // assertion would pass by finding an empty table.
  const keep = await engine.submit({
    version,
    answers: completeFor(bp, { personal_email: 'recent@example.test' }),
    now: T0,
  });
  await engine.drain(T0);

  // Finished long enough ago to be past the blueprint's retention period.
  const ancient = new Date(T0.getTime() - 4000 * 86_400_000);
  await pool.query(
    `update instance set completed_at = $1, state = 'complete', outcome = 'success' where id = $2`,
    [ancient, instanceId],
  );

  const { rows: before } = await pool.query<{ count: number }>(
    'select count(*)::int as count from event where instance_id = $1',
    [instanceId],
  );

  let refused: string | null = null;
  try {
    await runRetention(pool, { principal: operator, tenantId, processKey: bp.key, preview: false, now: T0 });
  } catch (err) {
    refused = err instanceof AuthorizationError ? err.reason : `unexpected: ${String(err)}`;
  }

  const preview = await runRetention(pool, { principal: admin, tenantId, processKey: bp.key, preview: true, now: T0 });
  const { rows: afterPreview } = await pool.query<{ count: number }>(
    'select count(*)::int as count from instance where id = $1',
    [instanceId],
  );

  const done = await runRetention(pool, { principal: admin, tenantId, processKey: bp.key, preview: false, now: T0 });
  const { rows: afterRun } = await pool.query<{ count: number }>(
    'select count(*)::int as count from instance where id = $1',
    [instanceId],
  );
  const { rows: runs } = await pool.query<{ instances_deleted: number }>(
    `select instances_deleted from retention_run
      where tenant_id = $1 and run_by not like '%preview%' order by id desc limit 1`,
    [tenantId],
  );

  const { rows: survivor } = await pool.query<{ count: number }>(
    'select count(*)::int as count from instance where id = $1',
    [keep.instanceId],
  );

  // And the door closed behind it: a delete aimed at a record that is NOT
  // past retention is refused by the trigger, exactly as before.
  let stillAppendOnly = false;
  try {
    await pool.query('delete from event where instance_id = $1', [keep.instanceId]);
  } catch {
    stillAppendOnly = true;
  }

  record(
    'Retention deletes, only for an administrator, and says what it removed',
    'Sections 9.2 and 12.1: configurable retention and deletion jobs, against an append-only history.',
    refused !== null &&
      preview.instances === 1 &&
      afterPreview[0]!.count === 1 &&
      done.instances === 1 &&
      afterRun[0]!.count === 0 &&
      runs[0]?.instances_deleted === 1 &&
      survivor[0]!.count === 1 &&
      stillAppendOnly,
    `An operator was refused ("${refused}"). The preview reported ${preview.instances} instance and ` +
      `${preview.events} events and deleted nothing. The real run removed ${done.instances} instance and ` +
      `${before[0]!.count} events, leaving a retention_run row naming what went. The record still inside its ` +
      `retention period survived, and deleting its history outside the procedure is still refused.`,
  );
}
