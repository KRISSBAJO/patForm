import type { Blueprint } from './blueprint/index.js';
import type { Pool } from './runtime/db.js';
import { Engine, newWorkerId } from './runtime/engine.js';
import { AuthorizationError, type Principal } from './runtime/policy.js';
import { resolveResumeToken } from './runtime/auth.js';
import { runRetention } from './runtime/retention.js';
import { checkAnswers, loadDraft, publicForm, respondentStatus, respondentUpdate, saveDraft, submitForm } from './runtime/intake.js';
import { confirm, runPlan } from './runtime/copilot.js';
import { traceByRequest, traceForInstance } from './runtime/support.js';
import { dataMap, eraseSubject, findSubject } from './runtime/privacy.js';
import { withTrace } from './runtime/trace.js';
import {
  acceptInvitation,
  actorForIdentity,
  changeRole,
  createWorkspace,
  grantableRoles,
  invite,
  linkIdentity,
  readInvitation,
  setMemberActive,
} from './runtime/workspace.js';
import {
  requestPasswordReset,
  resetPassword,
  sendVerification,
  verifyEmail,
} from './runtime/account.js';
import { createHmac } from 'node:crypto';
import {
  blockedRecipients,
  ingest,
  lift,
  suppressionsFor,
  verifyRelyKit,
} from './runtime/delivery.js';

/** The Standard Webhooks headers RelyKit sends, built the way RelyKit builds them. */
function signStandardWebhook(secret: string, id: string, nowMs: number, body: string) {
  const timestamp = String(Math.floor(nowMs / 1000));
  const mac = createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { id, timestamp, signature: `v1,${mac}` };
}
import { needsSecondFactor, resolveSession, signIn, startSession } from './runtime/auth.js';
import {
  answerChallenge,
  beginEnrolment,
  codeFor,
  confirmEnrolment,
  disable as disableMfa,
  stepFor,
} from './runtime/mfa.js';
import { createServer } from 'node:http';
import {
  deliverBatch,
  listDeliveries,
  registerEndpoint,
  replayDelivery,
  rotateSecret,
  verify,
} from './runtime/webhooks.js';
import { ActionPlan, QueryPlan } from './copilot/plan.js';
import { bundleToCsv, exportRecord } from './runtime/export.js';
import {
  loadDraft as loadBuilderDraft,
  openDraft,
  publishDraft,
  publishImpact,
  saveDraft as saveBuilderDraft,
} from './runtime/builder.js';

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
  await engine.drain(T0, 'proof', tenantId);

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
  await engine.drain(T0, 'proof', tenantId);

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
  await engine.drain(T0, 'proof', tenantId);

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


export async function proveIntake({ pool, bp, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:intake');
  await engine.publish(tenantId, bp, 'proof');

  // 1. The public form carries no internals. A stranger reaching this must not
  //    learn the workflow, the roles, or which fields are classified how.
  const form = await publicForm(pool, bp.key);
  const serialized = JSON.stringify(form);
  const leaksNothing =
    !serialized.includes('classification') &&
    !serialized.includes('"workflow"') &&
    !serialized.includes('"roles"') &&
    !serialized.includes('national_id') === false; // the field is asked for; its class is not published

  // 2. Conditional visibility is decided from the answers, not guessed.
  const withoutHelp = await checkAnswers(pool, { processKey: bp.key, answers: { equipment_needs: ['laptop'] } });
  const withHelp = await checkAnswers(pool, { processKey: bp.key, answers: { equipment_needs: ['accessibility'] } });
  const conditional =
    !withoutHelp.visible.includes('accessibility_notes') && withHelp.visible.includes('accessibility_notes');

  // 3. A draft is kept, resumable, and is NOT a record.
  const draft = await saveDraft(pool, {
    processKey: bp.key,
    answers: { full_name: 'Half Finished' },
    page: 0,
  });
  const reopened = await loadDraft(pool, draft.token);
  const { rows: instancesDuringDraft } = await pool.query<{ count: number }>(
    'select count(*)::int as count from instance where tenant_id = $1',
    [tenantId],
  );

  // 4. An incomplete submission is refused by the server.
  const refused = await submitForm(pool, { processKey: bp.key, token: draft.token, answers: { full_name: 'Half Finished' } });

  // 5. A complete one starts a process and hands back a resume link.
  const submitted = await submitForm(pool, {
    processKey: bp.key,
    token: draft.token,
    answers: completeFor(bp, { personal_email: 'intake@example.test', full_name: 'Ada Nwosu' }),
  });
  await engine.drain(new Date(), 'proof', tenantId);

  // 6. The draft is spent: the same link cannot start a second record.
  const spent = await loadDraft(pool, draft.token);

  // 7. §20.1 step 6 in full: the manager asks for changes, and only then does
  //    the respondent amend what their role names.
  const managerId = await engine.createActor(tenantId, 'manager_email@example.test', 'Manager', 'approver');
  await engine.grant({ tenantId, actorId: managerId, processKey: bp.key, roleKey: 'hiring_manager' });
  await engine.decide({
    instanceId: submitted.instanceId!,
    approvalKey: 'manager_approval',
    decision: 'changes_requested',
    principal: { kind: 'actor', tenantId, actorId: managerId },
    reason: 'Your phone number has a digit missing.',
    now: new Date(),
  });
  await engine.drain(new Date(), 'proof', tenantId);

  const status = await respondentStatus(pool, submitted.resumeToken!);
  const permitted = await respondentUpdate(pool, {
    resumeToken: submitted.resumeToken!,
    patch: { phone: '+44 7700 900111' },
  });
  const forbidden = await respondentUpdate(pool, {
    resumeToken: submitted.resumeToken!,
    patch: { bank_account: 'tampered' },
  });
  const { rows: after } = await pool.query<{ phone: string; bank: string }>(
    "select data->>'phone' as phone, data->>'bank_account' as bank from instance where id = $1",
    [submitted.instanceId!],
  );

  record(
    'A form can be filled in, saved, submitted, and amended when asked',
    'Section 21 P0: value cannot exist without trustworthy intake. Section 20.1 steps 4 and 6.',
    leaksNothing &&
      conditional &&
      reopened?.answers.full_name === 'Half Finished' &&
      instancesDuringDraft[0]!.count === 0 &&
      refused.ok === false &&
      (refused.errors?.length ?? 0) > 0 &&
      submitted.ok === true &&
      Boolean(submitted.resumeToken) &&
      Boolean(spent?.submittedInstanceId) &&
      status !== null &&
      status.changesRequested !== null &&
      permitted.saved === true &&
      permitted.advanced === true &&
      forbidden.saved === false &&
      forbidden.refused?.[0] === 'bank_account' &&
      after[0]!.phone === '+44 7700 900111' &&
      after[0]!.bank !== 'tampered',
    `The published form served no classifications, roles or workflow. A hidden section appeared only once ` +
      `its condition was met. A half-finished draft reopened with its answers and created ${instancesDuringDraft[0]!.count} ` +
      `records, because a draft is not a case. An incomplete submission was refused with ${refused.errors?.length} ` +
      `named fields; a complete one started a process and returned a resume link, and the draft could not be used ` +
      `again. Asked for changes ("${status?.changesRequested}"), the respondent updated their phone number and ` +
      `was refused their bank account ` +
      `("${forbidden.refused?.join(', ')}") — which the blueprint declares and nothing until now enforced.`,
  );
}

export async function proveDocumentsAndDelivery({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  // A provider that counts calls and can be told to fail, so both the happy
  // path and a permanent rejection are exercised.
  const sent: { to: string[]; subject: string; idempotencyKey: string; attachments: number }[] = [];
  let refuseNext = false;

  const provider = {
    name: 'test',
    async send(email: {
      to: string[];
      subject: string;
      idempotencyKey: string;
      attachments?: { filename: string; content: Buffer }[];
    }) {
      if (refuseNext) return { providerMessageId: null, status: 'failed' as const, detail: '550 rejected' };
      sent.push({
        to: email.to,
        subject: email.subject,
        idempotencyKey: email.idempotencyKey,
        attachments: email.attachments?.length ?? 0,
      });
      return { providerMessageId: `test-${sent.length}`, status: 'sent' as const };
    },
  };

  const engine = new Engine(pool, provider);
  const tenantId = await engine.createTenant('proof:documents');
  const version = await engine.publish(tenantId, bp, 'proof');

  const { instanceId } = await engine.submit({
    version,
    // equipment_needs is optional, so completeFor leaves it out — and the
    // transition that creates the accounts task is guarded on it. Without it
    // the process stops at provisioning and the welcome email never fires.
    answers: completeFor(bp, {
      personal_email: 'packet@example.test',
      full_name: 'Remi Adeyinka',
      equipment_needs: ['laptop'],
    }),
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);

  const manager = await engine.createActor(tenantId, 'manager_email@example.test', 'Manager', 'approver');
  await engine.grant({ tenantId, actorId: manager, processKey: bp.key, roleKey: 'hiring_manager' });
  const hr = await engine.createActor(tenantId, 'hr@example.test', 'HR', 'approver');
  await engine.grant({ tenantId, actorId: hr, processKey: bp.key, roleKey: 'hr_approver' });

  await engine.decide({
    instanceId,
    approvalKey: 'manager_approval',
    decision: 'approved',
    principal: { kind: 'actor', tenantId, actorId: manager },
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);
  await engine.decide({
    instanceId,
    approvalKey: 'hr_approval',
    decision: 'approved',
    principal: { kind: 'actor', tenantId, actorId: hr },
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);

  // The packet is generated at HR approval; the welcome email that attaches
  // it only goes out when provisioning finishes, so the process has to reach
  // the end for the attachment to be exercised at all.
  const it = await engine.createActor(tenantId, 'it@example.test', 'IT', 'operator');
  await engine.grant({ tenantId, actorId: it, processKey: bp.key, roleKey: 'it_operator' });
  const itPrincipal: Principal = { kind: 'actor', tenantId, actorId: it };
  await engine.completeTask({ instanceId, taskKey: 'issue_equipment', principal: itPrincipal, now: T0 });
  await engine.drain(T0, 'proof', tenantId);
  await engine.completeTask({ instanceId, taskKey: 'create_accounts', principal: itPrincipal, now: T0 });
  await engine.drain(T0, 'proof', tenantId);

  const { rows: docs } = await pool.query<{
    filename: string;
    checksum: string;
    byte_size: number;
    content: Buffer;
  }>('select filename, checksum, byte_size, content from document where instance_id = $1', [instanceId]);

  const doc = docs[0];
  const isPdf = doc ? doc.content.subarray(0, 8).toString() === '%PDF-1.4' : false;
  const text = doc ? doc.content.toString('latin1') : '';
  // The packet's mapping never included payroll fields, so they must not be in
  // the bytes either — this is the check that a template cannot quietly widen.
  const leaksPayroll = /QQ123456|12-34-56|87654321/.test(text);
  const hasName = text.includes('Remi Adeyinka');

  // Replay the whole delivery. The ledger short-circuits, so no second file
  // and no second send — and the provider would have deduplicated anyway on
  // the key it was handed.
  await pool.query('update outbox set done_at = null, available_at = $1 where instance_id = $2', [T0, instanceId]);
  await engine.drain(T0, 'proof', tenantId);
  const { rows: afterReplay } = await pool.query<{ count: number }>(
    'select count(*)::int as count from document where instance_id = $1',
    [instanceId],
  );

  const welcome = sent.filter((e) => e.subject.startsWith('You are all set'));
  const keysAreUnique = new Set(sent.map((e) => e.idempotencyKey)).size === sent.length;

  // A permanent provider rejection must surface rather than log green.
  refuseNext = true;
  const { instanceId: doomed } = await engine.submit({
    version,
    answers: completeFor(bp, { personal_email: 'refused@example.test' }),
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);
  const { rows: failures } = await pool.query<{ status: string; failure: string | null }>(
    "select status, failure from email_log where instance_id = $1 and status = 'failed'",
    [doomed],
  );
  refuseNext = false;

  record(
    'Documents are real files, and email actually leaves',
    'Section 6.6: generated output stored with its checksum; a delivery log that distinguishes sent from failed.',
    isPdf &&
      hasName &&
      !leaksPayroll &&
      docs.length === 1 &&
      afterReplay[0]!.count === 1 &&
      welcome.length === 1 &&
      welcome[0]!.attachments === 1 &&
      keysAreUnique &&
      failures.length === 1 &&
      Boolean(failures[0]!.failure),
    `The packet is a ${doc?.byte_size}-byte PDF checksummed over its own bytes, carrying the employee's name and ` +
      `none of their payroll or identification data — the mapping never named those, and the renderer cannot widen it. ` +
      `Replaying every action produced ${afterReplay[0]!.count} document and ${welcome.length} welcome email, with ` +
      `the packet attached. Each send carried a distinct idempotency key, which is the same key the ledger uses, so a ` +
      `retry that reaches the provider is deduplicated there too. A permanent rejection was recorded as failed with ` +
      `its reason ("${failures[0]?.failure}") rather than logged as delivered.`,
  );
}

/**
 * The builder's round trip: open, break, be told, fix, publish.
 *
 * This proof exists because the first version of `openDraft` read the draft
 * back through the pool from inside the transaction that had just inserted it
 * — a second connection, which cannot see an uncommitted row. It compiled, it
 * type-checked, and it failed on the first click. The same shape as the
 * refusal audit and the delivery log, approached from the opposite side: there
 * the write had to escape the transaction, here the read had to wait for it.
 *
 * It also pins the gate itself. `publishDraft` re-validates rather than
 * trusting whatever the browser last said was publishable, and a publish
 * endpoint that believes the client is not a gate at all.
 */
export async function proveBuilderRoundTrip({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:builder');
  const version = await engine.publish(tenantId, bp, 'proof');

  const builder = await engine.createActor(tenantId, 'builder@proof.test', 'A Builder', 'builder');
  const operator = await engine.createActor(tenantId, 'operator@proof.test', 'An Operator', 'operator');
  const as = (actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });

  // A record left running, so the impact summary has something to count.
  const { instanceId } = await engine.submit({
    version,
    answers: completeFor(bp, { personal_email: 'inflight@example.test' }),
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);

  // 1. Opening returns the draft it just created, in the same call.
  const opened = await openDraft(pool, { principal: as(builder), processKey: bp.key });
  const reopened = await openDraft(pool, { principal: as(builder), processKey: bp.key });

  // 2. An operator may run the process but may not rewrite it.
  let operatorRefused: string | null = null;
  try {
    await openDraft(pool, { principal: as(operator), processKey: bp.key });
  } catch (err) {
    operatorRefused = err instanceof AuthorizationError ? err.reason : `unexpected: ${String(err)}`;
  }

  // 3. Break it the way a person would, by naming an approver who cannot approve.
  const broken = structuredClone(opened.blueprint);
  broken.workflow.approvals[0]!.approvers.push({ role: 'hr_admin' });
  const afterBreak = await saveBuilderDraft(pool, {
    principal: as(builder),
    draftId: opened.id,
    blueprint: broken,
  });

  // 4. A publish attempt while broken must be refused by the server, not just
  //    by a disabled button.
  let publishRefused: string | null = null;
  try {
    await publishDraft(pool, { principal: as(builder), draftId: opened.id });
  } catch (err) {
    publishRefused = err instanceof Error ? err.message : String(err);
  }

  // 5. Work that does not even parse is still kept.
  await saveBuilderDraft(pool, { principal: as(builder), draftId: opened.id, blueprint: { half: 'typed' } });
  const survived = await loadBuilderDraft(pool, as(builder), opened.id);

  // 6. Fix it, and change something that shows up in the impact summary.
  const fixed = structuredClone(opened.blueprint);
  fixed.workflow.approvals[0]!.mode = 'sequential';
  fixed.workflow.approvals[0]!.approvers.push({ role: 'hr_approver' });
  fixed.data.fields.push({
    key: 'proof_note',
    type: 'short_text',
    label: 'A note added by the proof',
    classification: 'internal',
    setBy: 'operator',
  });
  const afterFix = await saveBuilderDraft(pool, { principal: as(builder), draftId: opened.id, blueprint: fixed });

  const impact = await publishImpact(pool, { principal: as(builder), draftId: opened.id });
  const published = await publishDraft(pool, { principal: as(builder), draftId: opened.id });

  // 7. The running record stays on the version it started under (§9.2).
  const { rows: stillOnV1 } = await pool.query<{ version: number }>(
    `select pv.version from instance i
       join process_version pv on pv.id = i.process_version_id
      where i.id = $1`,
    [instanceId],
  );

  record(
    'A draft opens, refuses to publish while broken, and says what a publish would change',
    'BLD-03, BLD-04, BLD-07 and §9.2: the compiler is the gate, and versioning is opt-in per record.',
    opened.id === reopened.id &&
      operatorRefused !== null &&
      afterBreak.diagnostics.some((d) => d.code === 'SEC009') &&
      afterBreak.publishable === false &&
      publishRefused !== null &&
      survived.publishable === false &&
      survived.diagnostics.some((d) => d.code === 'SHAPE') &&
      afterFix.publishable === true &&
      impact.inFlight === 1 &&
      impact.fields.added.includes('proof_note') &&
      published.version === 2 &&
      stillOnV1[0]?.version === 1,
    `Opening twice returned one draft, not two. An operator was refused ("${operatorRefused}"). ` +
      `Naming a role without the approve capability produced ${afterBreak.diagnostics.filter((d) => d.code === 'SEC009').length} SEC009 error(s), ` +
      `and publishing anyway was refused server-side ("${publishRefused?.slice(0, 80)}"). ` +
      `A draft saved as ${JSON.stringify({ half: 'typed' })} was kept and reopened as ${survived.diagnostics.length} shape diagnostic(s) rather than throwing. ` +
      `After the fix the impact summary counted ${impact.inFlight} record still running and named "proof_note" as added; ` +
      `version ${published.version} published and the running record stayed on v${stillOnV1[0]?.version}.`,
  );
}

/**
 * §20.1 step 9: ask which records are overdue, then send a confirmed reminder
 * to authorized targets.
 *
 * The plan is written here rather than produced by a model, on purpose. What
 * needs proving is the part that must hold whatever the model emits: that the
 * compiler refuses a plan naming things the blueprint does not have, that
 * "overdue" means the SLA the process declares, that every target is
 * authorized individually, that the confirmation is bound to the exact set
 * previewed, and that confirming twice sends once.
 *
 * A proof that asked a model would be testing the model. This tests the
 * boundary the model sits behind, which is what has to hold when it is wrong.
 */
export async function proveCopilot({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:copilot');
  const version = await engine.publish(tenantId, bp, 'proof');

  const admin = await engine.createActor(tenantId, 'admin@proof.test', 'An Admin', 'admin');
  const operator = await engine.createActor(tenantId, 'ops@proof.test', 'An Operator', 'operator');
  const hr = await engine.createActor(tenantId, 'hr@proof.test', 'An HR Approver', 'approver');
  await engine.grant({ tenantId, actorId: admin, processKey: bp.key, roleKey: 'hr_admin' });
  await engine.grant({ tenantId, actorId: operator, processKey: bp.key, roleKey: 'it_operator' });
  // hr_reminder is addressed to this role. Nobody holding it is a real state
  // the runtime now reports rather than a send with an empty recipient list.
  await engine.grant({ tenantId, actorId: hr, processKey: bp.key, roleKey: 'hr_approver' });

  // A neighbouring workspace running the same process, to show what the
  // stranger's identical question returns.
  const otherTenant = await engine.createTenant('proof:copilot:elsewhere');
  const otherVersion = await engine.publish(otherTenant, bp, 'proof');
  const stranger = await engine.createActor(otherTenant, 'stranger@proof.test', 'Elsewhere', 'admin');
  const as = (actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });

  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { instanceId } = await engine.submit({
      version,
      answers: completeFor(bp, { personal_email: `late${i}@example.test` }),
      now: T0,
    });
    ids.push(instanceId);
  }
  // These three were submitted into `version`, which belongs to `tenantId`.
  await engine.drain(T0, 'proof', tenantId);

  const later = new Date(T0.getTime() + hours(72));

  const overduePlan = {
    processKey: bp.key,
    filters: [{ kind: 'overdue' as const, is: true }],
    limit: 50,
    select: ['full_name', 'personal_email'],
  };

  // 1. The question, as an operator would get it.
  const answered = await runPlan(pool, { principal: as(admin), plan: QueryPlan.parse(overduePlan), now: later });

  // 2. A plan naming something the blueprint does not have is refused by the
  //    compiler, not handed to Postgres to see what happens.
  const invented = await runPlan(pool, {
    principal: as(admin),
    plan: QueryPlan.parse({
      processKey: bp.key,
      filters: [{ kind: 'state', is: ['state_that_does_not_exist'] }],
      limit: 10,
    }),
    now: later,
  });

  // 3. Filtering on a restricted answer is refused: it reads restricted data
  //    one yes/no at a time without ever displaying it, so redaction on the
  //    way out does not help.
  const probing = await runPlan(pool, {
    principal: as(admin),
    plan: QueryPlan.parse({
      processKey: bp.key,
      filters: [{ kind: 'answer', field: 'national_id', op: 'contains', value: 'QQ' }],
      limit: 10,
    }),
    now: later,
  });

  // 4. The same question, asked by an admin of a different workspace running
  //    the same process. The scope is not checked against the plan — the plan
  //    cannot express a tenant at all, because `runPlan` takes it from the
  //    principal. Cross-tenant reading is unreachable rather than refused,
  //    which is the stronger of the two.
  const { instanceId: theirs } = await engine.submit({
    version: otherVersion,
    answers: completeFor(bp, { personal_email: 'theirs@example.test' }),
    now: T0,
  });
  await engine.drain(T0, 'proof', otherTenant);
  const strangerSees = await runPlan(pool, {
    principal: { kind: 'actor', tenantId: otherTenant, actorId: stranger },
    plan: QueryPlan.parse(overduePlan),
    now: later,
  });
  const leaked = strangerSees.rows.filter((r) => ids.includes(r.instanceId));

  // 5. The action, previewed. Every target authorized individually.
  const action = ActionPlan.parse({ kind: 'send_reminder', template: 'hr_reminder' });
  const previewed = await runPlan(pool, {
    principal: as(admin),
    plan: QueryPlan.parse(overduePlan),
    action,
    now: later,
  });
  const preview = previewed.preview!;

  const { rows: runRows } = await pool.query<{ id: string }>(
    `insert into copilot_run
       (tenant_id, actor_id, process_key, question, reading, plan, action_plan, targets, plan_digest, status,
        provider, model, prompt_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'previewed','proof','none','proof')
     returning id`,
    [
      tenantId,
      admin,
      bp.key,
      'which records are overdue, remind them',
      'Records past the SLA on the state they are in.',
      JSON.stringify(overduePlan),
      JSON.stringify(action),
      JSON.stringify([
        ...preview.eligible.map((e) => ({ ...e, decision: 'eligible' })),
        ...preview.refused.map((r) => ({ ...r, decision: 'refused' })),
        ...preview.skipped.map((s) => ({ ...s, decision: 'skipped' })),
      ]),
      preview.digest,
    ],
  );
  const runId = runRows[0]!.id;

  // 6. A confirmation carrying the wrong digest is refused. §7.4's
  //    action-precision gate: what runs is what was confirmed, or nothing.
  let staleRefused: string | null = null;
  try {
    await confirm(pool, { principal: as(admin), runId, digest: 'a-digest-from-a-different-plan', now: later });
  } catch (err) {
    staleRefused = err instanceof Error ? err.message : String(err);
  }

  // 7. One person's preview is not another person's permission.
  let borrowedRefused: string | null = null;
  try {
    await confirm(pool, { principal: as(operator), runId, digest: preview.digest, now: later });
  } catch (err) {
    borrowedRefused = err instanceof Error ? err.message : String(err);
  }

  const emailsBefore = await countEmails(pool, tenantId);
  const report = await confirm(pool, { principal: as(admin), runId, digest: preview.digest, now: later });
  await engine.drain(later, 'copilot', tenantId);
  const emailsAfter = await countEmails(pool, tenantId);

  // 8. Confirming again sends nothing: the same idempotency key, and the same
  //    mechanism the workflow's own actions use.
  await pool.query("update copilot_run set status = 'previewed' where id = $1", [runId]);
  const second = await confirm(pool, { principal: as(admin), runId, digest: preview.digest, now: later });
  await engine.drain(later, 'copilot', tenantId);
  const emailsAfterReplay = await countEmails(pool, tenantId);

  // 9. The reminder is on the record's own history, not only in a log.
  const { rows: events } = await pool.query<{ count: number }>(
    `select count(*)::int as count from event
      where instance_id = any($1::uuid[]) and type = 'manual_action'`,
    [preview.eligible.map((e) => e.instanceId)],
  );

  record(
    'The operator asks what is overdue and sends a reminder that matches what they confirmed',
    'Section 20.1 step 9, and 7.1: a permission-filtered query service with no raw model database access.',
    answered.ok &&
      answered.rows.length === 3 &&
      answered.rows.every((r) => r.overdue) &&
      !invented.ok &&
      invented.diagnostics.some((d) => d.code === 'QRY002') &&
      !probing.ok &&
      probing.diagnostics.some((d) => d.code === 'QRY004') &&
      leaked.length === 0 &&
      strangerSees.rows.some((r) => r.instanceId === theirs) &&
      staleRefused !== null &&
      borrowedRefused !== null &&
      preview.eligible.length > 0 &&
      report.sent.length === preview.eligible.length &&
      emailsAfter === emailsBefore + preview.eligible.length &&
      second.sent.length === 0 &&
      emailsAfterReplay === emailsAfter &&
      events[0]!.count === preview.eligible.length,
    `"Which records are overdue" matched ${answered.rows.length} of ${ids.length}, every one past the SLA its state declares. ` +
      `A plan naming a state that does not exist was refused by the compiler (${invented.diagnostics[0]?.code}), and so was filtering on a restricted answer (${probing.diagnostics[0]?.code}) — ` +
      `which would have read restricted data one yes/no at a time without ever displaying it. ` +
      `An admin of another workspace asked the identical question and saw ${strangerSees.rows.length} of their own records and ${leaked.length} of these — the plan cannot name a tenant, so the scope comes from who is asking. ` +
      `The preview authorized ${preview.eligible.length} target(s) one at a time; a stale digest was refused ("${staleRefused?.slice(0, 55)}"), ` +
      `and so was spending somebody else's preview ("${borrowedRefused?.slice(0, 55)}"). ` +
      `The confirmed run sent ${report.sent.length}, a replay sent ${second.sent.length}, and every reminder is on its record's own history.`,
  );
}

/**
 * Only the copilot's own sends.
 *
 * Counting every email in the tenant looked right and was not: draining the
 * outbox after the confirmation also flushes the workflow's own reminders,
 * which these records were overdue for by construction. The idempotency key
 * is what distinguishes them, and it is the same key the replay check relies
 * on — so this counts exactly the thing the claim is about.
 */
async function countEmails(pool: Pool, tenantId: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `select count(*)::int as count
       from email_log e join action_run r on r.id = e.action_run_id
      where e.tenant_id = $1 and r.idempotency_key like 'copilot:%'`,
    [tenantId],
  );
  return rows[0]!.count;
}

/**
 * §20.1 step 11: export the record and its audit history, then apply the
 * configured retention action.
 *
 * The order in that sentence is the requirement. Retention deletes the record
 * and its events, so an export taken afterwards would be of nothing — which
 * means the export has to carry everything retention is about to destroy, and
 * has to be verifiable afterwards without the system that produced it.
 */
export async function proveExportThenRetain({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:export');
  const version = await engine.publish(tenantId, bp, 'proof');

  const admin = await engine.createActor(tenantId, 'admin@proof.test', 'An Admin', 'admin');
  const manager = await engine.createActor(tenantId, 'mgr@proof.test', 'A Manager', 'approver');
  await engine.grant({ tenantId, actorId: admin, processKey: bp.key, roleKey: 'hr_admin' });
  await engine.grant({ tenantId, actorId: manager, processKey: bp.key, roleKey: 'hiring_manager' });

  // An administrator who is also a hiring manager on this process. Ordinary in
  // a small workspace, and the case that decides whether redaction survives an
  // export: they may take the file, and the file must still not carry the
  // payroll fields their process role hides.
  const both = await engine.createActor(tenantId, 'both@proof.test', 'Admin and Manager', 'admin');
  await engine.grant({ tenantId, actorId: both, processKey: bp.key, roleKey: 'hiring_manager' });

  const hrApprover = await engine.createActor(tenantId, 'hr@proof.test', 'An HR Approver', 'approver');
  await engine.grant({ tenantId, actorId: hrApprover, processKey: bp.key, roleKey: 'hr_approver' });
  const itOperator = await engine.createActor(tenantId, 'it@proof.test', 'An IT Operator', 'operator');
  await engine.grant({ tenantId, actorId: itOperator, processKey: bp.key, roleKey: 'it_operator' });
  const as = (actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });

  const { instanceId } = await engine.submit({
    version,
    // equipment_needs matters: the transition off `issue_equipment` is guarded
    // on it, and without it the task completes while the record stays put.
    answers: completeFor(bp, {
      personal_email: 'exported@example.test',
      manager_email: 'mgr@proof.test',
      equipment_needs: ['laptop', 'monitor'],
    }),
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);
  // Run it to the end. Step 11 follows steps 7 and 8, so the record being
  // exported is a finished one — which is also the only kind retention will
  // touch, and the reason an unfinished record deleted nothing on the first
  // attempt at this proof.
  await engine.decide({
    instanceId,
    approvalKey: 'manager_approval',
    decision: 'approved',
    principal: as(manager),
    reason: 'Confirmed headcount.',
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);
  await engine.decide({
    instanceId,
    approvalKey: 'hr_approval',
    decision: 'approved',
    principal: as(hrApprover),
    reason: 'Right to work verified.',
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);
  // book_orientation is assigned to hr_admin, not IT. The policy engine is
  // what said so.
  for (const [taskKey, who] of [
    ['issue_equipment', itOperator],
    ['create_accounts', itOperator],
    ['book_orientation', admin],
  ] as const) {
    await engine.completeTask({ instanceId, taskKey, principal: as(who), now: T0 });
    await engine.drain(T0, 'proof', tenantId);
  }

  const bundle = await exportRecord(pool, { principal: as(admin), instanceId, now: T0 });

  const restricted = await exportRecord(pool, { principal: as(both), instanceId, now: T0 });

  // An approver holds no `administer` anywhere, so they cannot export at all.
  // Reading a record on screen and taking the whole file with every decision
  // and message on it are different acts, and §20.1 step 11 says administrator.
  let approverRefused: string | null = null;
  try {
    await exportRecord(pool, { principal: as(manager), instanceId, now: T0 });
  } catch (err) {
    approverRefused = err instanceof AuthorizationError ? err.reason : `unexpected: ${String(err)}`;
  }

  // Taking a copy of somebody's data is itself an auditable act.
  const { rows: exportEvents } = await pool.query<{ count: number }>(
    `select count(*)::int as count from event where instance_id = $1 and type = 'record_exported'`,
    [instanceId],
  );

  // A second export of an unchanged record hashes the same, so the file can be
  // checked against the system later.
  const again = await exportRecord(pool, { principal: as(admin), instanceId, now: new Date(T0.getTime() + 1000) });

  const csv = bundleToCsv(bundle);

  // Only then, the retention action the process configures.
  const retained = await runRetention(pool, {
    principal: as(admin),
    tenantId,
    processKey: bp.key,
    preview: false,
    now: new Date(T0.getTime() + hours(24 * 4000)),
  });

  const { rows: after } = await pool.query<{ count: number }>(
    'select count(*)::int as count from instance where id = $1',
    [instanceId],
  );

  record(
    'An administrator exports the record with its history, and only then is it deleted',
    'Section 20.1 step 11, and 6.4: corrections append history; destructive overwriting of audit evidence is prohibited.',
    bundle.record.instanceId === instanceId &&
      ['submitted', 'approval_decided', 'task_completed'].every((t) => bundle.history.some((e) => e.type === t)) &&
      bundle.record.completedAt !== null &&
      bundle.approvals.some((a) => a.decision === 'approved' && a.reason === 'Confirmed headcount.') &&
      bundle.messages.length >= 1 &&
      bundle.withheld.length === 0 &&
      restricted.withheld.length === 3 &&
      approverRefused !== null &&
      !JSON.stringify(restricted.record.answers).includes('[redacted]') &&
      exportEvents[0]!.count >= 1 &&
      again.checksum === bundle.checksum &&
      csv.includes('Audit history') &&
      retained.instances === 1 &&
      after[0]!.count === 0,
    `The bundle carried ${bundle.history.length} history entries for a finished record — submission, both decisions with the reasons given, and every task completion — ` +
      `plus ${bundle.approvals.length} approval(s), ` +
      `${bundle.messages.length} message(s) and ${bundle.documents.length} document(s). ` +
      `An approver could not export at all ("${approverRefused}"). An administrator holding no process role saw every field; ` +
      `one who is also a hiring manager had ${restricted.withheld.length} withheld (${restricted.withheld.join(', ')}) — named in the bundle rather than quietly absent, and not left in the answers as the literal string "[redacted]". ` +
      `The export is itself on the record's history, and a second export of an unchanged record produced the same checksum (${bundle.checksum.slice(0, 12)}), so a file can be verified later. ` +
      `Retention then deleted ${retained.instances} instance and ${retained.events} event(s) — in that order, because afterwards there is nothing left to export.`,
  );
}

/**
 * §20.2 observability: "every workflow action has traceable request, event,
 * job, attempt, and result identifiers".
 *
 * Five identifiers, and the one that matters is the first. The other four were
 * already there; without a request id they were four separate facts that
 * happened to be about the same thing, and putting them together meant
 * matching on timestamps.
 *
 * The hard part is not stamping an id. It is that the job runs later, in
 * another process, after the request has gone — so this proof drains the
 * outbox as a worker would, from a context that knows nothing about the
 * submission, and requires the link to survive anyway.
 */
export async function proveTraceability({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:trace');
  const version = await engine.publish(tenantId, bp, 'proof');

  const admin = await engine.createActor(tenantId, 'admin@proof.test', 'An Admin', 'admin');
  await engine.grant({ tenantId, actorId: admin, processKey: bp.key, roleKey: 'hr_admin' });
  const as = (actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });

  // One request, as an API call would open it.
  const requestId = 'proof-request-0001';
  const { instanceId } = await withTrace({ requestId, source: 'proof' }, () =>
    engine.submit({
      version,
      answers: completeFor(bp, { personal_email: 'traced@example.test' }),
      now: T0,
    }),
  );

  // The work happens outside that context, the way a worker does: a separate
  // process, minutes later, with no memory of the request.
  await engine.drain(T0, 'proof-worker', tenantId);

  const one = async (sql: string, params: unknown[] = []): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(sql, params);
    return rows[0]!.count;
  };

  const events = await one('select count(*)::int as count from event where instance_id = $1 and request_id = $2', [
    instanceId,
    requestId,
  ]);
  const jobs = await one('select count(*)::int as count from outbox where instance_id = $1 and request_id = $2', [
    instanceId,
    requestId,
  ]);
  const runs = await one('select count(*)::int as count from action_run where instance_id = $1 and request_id = $2', [
    instanceId,
    requestId,
  ]);
  const orphans = await one(
    `select count(*)::int as count from action_run where instance_id = $1 and request_id = 'unattributed'`,
    [instanceId],
  );

  // A timer is its own cause, so it must carry an id of its own rather than
  // inheriting one or being left unattributed.
  await engine.fireDueTimers(new Date(T0.getTime() + hours(49)));
  const { rows: timerEvents } = await pool.query<{ request_id: string }>(
    "select request_id from event where instance_id = $1 and type = 'timer_fired'",
    [instanceId],
  );

  // The support view, which is what makes the ids worth having.
  const trace = await traceForInstance(pool, { principal: as(admin), instanceId });
  const withJob = trace.steps.filter((s) => s.job);
  const withActions = trace.steps.filter((s) => s.actions.length);
  const everyRunHasAttempts = trace.steps.every((s) => s.actions.every((a) => a.attempts >= 1));

  const byRequest = await traceByRequest(pool, { principal: as(admin), requestId });

  // Another workspace asking about this id sees nothing — confirming that an
  // id exists elsewhere would itself be a disclosure.
  const otherTenant = await engine.createTenant('proof:trace:elsewhere');
  const stranger = await engine.createActor(otherTenant, 'stranger@proof.test', 'Elsewhere', 'admin');
  const strangerSees = await traceByRequest(pool, {
    principal: { kind: 'actor', tenantId: otherTenant, actorId: stranger },
    requestId,
  });

  record(
    'Every action traces back to the request that caused it, across the worker boundary',
    'Section 20.2 observability: traceable request, event, job, attempt and result identifiers.',
    events >= 1 &&
      jobs >= 1 &&
      runs >= 3 &&
      orphans === 0 &&
      timerEvents.length >= 1 &&
      timerEvents.every((e) => e.request_id !== 'unattributed') &&
      withJob.length >= 1 &&
      withActions.length >= 1 &&
      everyRunHasAttempts &&
      byRequest.records.length === 1 &&
      strangerSees.records.length === 0 &&
      trace.diagnosis.length > 0,
    `One submission produced ${events} event(s), ${jobs} job(s) and ${runs} action run(s), every one carrying "${requestId}" ` +
      `and ${orphans} unattributed. The actions ran in a later drain that knew nothing about the submission — the link ` +
      `survived because the request id is stamped on the outbox row and read back when the job runs. ` +
      `A timer firing got an id of its own (${timerEvents[0]?.request_id.slice(0, 16)}…) rather than inheriting one, because a deadline is its own cause. ` +
      `The support view joined them into ${trace.steps.length} step(s) with every attempt count present, and answered in a sentence: "${trace.diagnosis.slice(0, 80)}". ` +
      `Asking by request id found ${byRequest.records.length} record; an admin of another workspace asking the same id found ${strangerSees.records.length}.`,
  );
}

/**
 * §20.2's privacy gate, the half that is code: the data map and the deletion
 * workflow.
 *
 * Retention deletes by age. A privacy request deletes by person, and the
 * difference is not scheduling — it is that a person can appear in somebody
 * else's record. The hiring manager named on a new hire's form is a data
 * subject in a record that is not theirs, and an erasure that deleted every
 * record their address appears in would destroy other people's data to satisfy
 * one request.
 */
export async function provePrivacy({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:privacy');
  const version = await engine.publish(tenantId, bp, 'proof');

  const admin = await engine.createActor(tenantId, 'admin@proof.test', 'An Admin', 'admin');
  const manager = await engine.createActor(tenantId, 'mgr@proof.test', 'A Manager', 'approver');
  const operator = await engine.createActor(tenantId, 'ops@proof.test', 'An Operator', 'operator');
  await engine.grant({ tenantId, actorId: admin, processKey: bp.key, roleKey: 'hr_admin' });
  await engine.grant({ tenantId, actorId: manager, processKey: bp.key, roleKey: 'hiring_manager' });
  await engine.grant({ tenantId, actorId: operator, processKey: bp.key, roleKey: 'it_operator' });
  const as = (actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });

  // Two records, both naming the same manager. One will be finished, one will
  // still be running.
  const finished = await engine.submit({
    version,
    answers: completeFor(bp, {
      personal_email: 'leaving@example.test',
      manager_email: 'mgr@proof.test',
      equipment_needs: ['laptop'],
    }),
    now: T0,
  });
  const running = await engine.submit({
    version,
    answers: completeFor(bp, { personal_email: 'staying@example.test', manager_email: 'mgr@proof.test' }),
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);

  // Drive the first to completion.
  const hr = await engine.createActor(tenantId, 'hr@proof.test', 'HR', 'approver');
  await engine.grant({ tenantId, actorId: hr, processKey: bp.key, roleKey: 'hr_approver' });
  for (const [key, who] of [
    ['manager_approval', manager],
    ['hr_approval', hr],
  ] as const) {
    await engine.decide({
      instanceId: finished.instanceId,
      approvalKey: key,
      decision: 'approved',
      principal: as(who),
      reason: 'Fine.',
      now: T0,
    });
    await engine.drain(T0, 'proof', tenantId);
  }
  for (const [taskKey, who] of [
    ['issue_equipment', operator],
    ['create_accounts', operator],
    ['book_orientation', admin],
  ] as const) {
    await engine.completeTask({ instanceId: finished.instanceId, taskKey, principal: as(who), now: T0 });
    await engine.drain(T0, 'proof', tenantId);
  }

  // ---- the data map, derived rather than written
  const maps = await dataMap(pool, as(admin));
  const map = maps.find((m) => m.processKey === bp.key)!;
  const restricted = map.fields.filter((f) => f.classification === 'restricted');
  const everyRestrictedIsJustified = restricted.every((f) => f.collectionReason);
  const everyRestrictedIsNarrowed = restricted.every((f) => f.hiddenFrom.length > 0);
  const bankAccount = map.fields.find((f) => f.key === 'bank_account')!;
  const startDate = map.fields.find((f) => f.key === 'start_date')!;

  // An operator may read a data map; erasing needs `administer`.
  let mapRefused: string | null = null;
  try {
    await dataMap(pool, { kind: 'actor', tenantId, actorId: (await engine.createActor(tenantId, 'nobody@proof.test', 'Nobody', 'read_only')) });
  } catch (err) {
    mapRefused = err instanceof AuthorizationError ? err.reason : `unexpected: ${String(err)}`;
  }

  // ---- who is where
  const managerAppearances = await findSubject(pool, { principal: as(admin), email: 'mgr@proof.test' });
  const subjectAppearances = await findSubject(pool, { principal: as(admin), email: 'leaving@example.test' });
  const stayingAppearances = await findSubject(pool, { principal: as(admin), email: 'staying@example.test' });

  // ---- an operator may not erase
  let eraseRefused: string | null = null;
  try {
    await eraseSubject(pool, { principal: as(operator), email: 'leaving@example.test', reason: 'test' });
  } catch (err) {
    eraseRefused = err instanceof AuthorizationError ? err.reason : `unexpected: ${String(err)}`;
  }

  // ---- preview changes nothing
  const preview = await eraseSubject(pool, { principal: as(admin), email: 'leaving@example.test', reason: 'preview' });
  const { rows: afterPreview } = await pool.query<{ count: number }>(
    'select count(*)::int as count from instance where id = $1',
    [finished.instanceId],
  );

  // ---- erasing the manager redacts, and deletes nothing
  const managerErasure = await eraseSubject(pool, {
    principal: as(admin),
    email: 'mgr@proof.test',
    preview: false,
    reason: 'PRV-manager',
  });
  const { rows: bothSurvive } = await pool.query<{ count: number }>(
    'select count(*)::int as count from instance where id = any($1::uuid[])',
    [[finished.instanceId, running.instanceId]],
  );
  const { rows: redactedValue } = await pool.query<{ v: string | null }>(
    "select data ->> 'manager_email' as v from instance where id = $1",
    [running.instanceId],
  );

  // ---- erasing the subject of the finished record deletes it
  const subjectErasure = await eraseSubject(pool, {
    principal: as(admin),
    email: 'leaving@example.test',
    preview: false,
    reason: 'PRV-subject',
  });
  const { rows: gone } = await pool.query<{ count: number }>(
    'select count(*)::int as count from instance where id = $1',
    [finished.instanceId],
  );
  const { rows: eventsGone } = await pool.query<{ count: number }>(
    'select count(*)::int as count from event where instance_id = $1',
    [finished.instanceId],
  );

  // ---- the account of it outlives the data
  const { rows: audit } = await pool.query<{
    subject_email: string;
    reason: string;
    instances_deleted: number;
    events_deleted: number;
    run_by: string;
  }>('select subject_email, reason, instances_deleted, events_deleted, run_by from erasure_run where tenant_id = $1 order by id', [
    tenantId,
  ]);
  const subjectAudit = audit.find((a) => a.reason === 'PRV-subject');

  record(
    'A privacy request erases one person without destroying anybody else',
    'Section 20.2 privacy: data map, deletion workflow. Section 12.1: privacy request workflow.',
    map.fields.length > 10 &&
      everyRestrictedIsJustified &&
      everyRestrictedIsNarrowed &&
      bankAccount.hiddenFrom.length > 0 &&
      startDate.leaves.some((l) => l.includes('webhook')) &&
      mapRefused !== null &&
      managerAppearances.length === 2 &&
      managerAppearances.every((a) => a.role === 'mentioned') &&
      subjectAppearances.some((a) => a.role === 'subject') &&
      stayingAppearances.every((a) => a.blocked !== null) &&
      eraseRefused !== null &&
      preview.deleted.instances === 1 &&
      afterPreview[0]!.count === 1 &&
      managerErasure.deleted.instances === 0 &&
      managerErasure.redacted.fields === 2 &&
      bothSurvive[0]!.count === 2 &&
      redactedValue[0]!.v === '[erased]' &&
      subjectErasure.deleted.instances === 1 &&
      gone[0]!.count === 0 &&
      eventsGone[0]!.count === 0 &&
      subjectAudit?.events_deleted === subjectErasure.deleted.events &&
      subjectAudit.events_deleted > 0,
    `The data map is derived from the published version: ${map.fields.length} fields, every restricted one carrying a reason and hidden from somebody, ` +
      `and it traces where a value goes — start_date reaches ${startDate.leaves.length} destinations including a webhook that leaves the platform. ` +
      `A read_only member was refused it ("${mapRefused}"). ` +
      `The manager appears in ${managerAppearances.length} records and is the subject of none, so erasing them redacted ${managerErasure.redacted.fields} field(s) and deleted ${managerErasure.deleted.instances} records — both records survived and the address now reads "${redactedValue[0]!.v}", so the audit still shows a manager was asked. ` +
      `A subject whose record is still running was left alone. An operator was refused ("${eraseRefused}"). ` +
      `The preview reported ${preview.deleted.instances} deletion and performed none. ` +
      `Erasing the finished record's subject removed it and all ${subjectErasure.deleted.events} of its events, and the erasure_run row records the same number — the account is written before the deletion and had to be counted first, or it would say zero.`,
  );
}

/**
 * §11.2's six promises, against a real HTTP server.
 *
 * This proof exists because the previous implementation satisfied none of them
 * and said it satisfied all of them: `call_webhook` wrote a row with status
 * `delivered` and made no request. A hundred of those sat in the seeded
 * workspace. The console showed success; the customer's system showed nothing.
 *
 * So the receiver here is a real `node:http` server that verifies the
 * signature itself. Anything less — a mock, a recorded call — would prove that
 * the code calls fetch, which was never the question.
 */
export async function proveWebhooks({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:webhooks');
  const version = await engine.publish(tenantId, bp, 'proof');
  const admin = await engine.createActor(tenantId, 'admin@proof.test', 'An Admin', 'admin');
  await engine.grant({ tenantId, actorId: admin, processKey: bp.key, roleKey: 'hr_admin' });
  const as = (actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });

  // A real server. It verifies the signature the way an integrator would.
  const received: { valid: boolean; signatures: number; envelope: Record<string, unknown> }[] = [];
  let refuse = false;
  let secretForVerifying = '';

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (refuse) {
        res.writeHead(500).end();
        return;
      }
      const header = String(req.headers['patform-signature'] ?? '');
      const outcome = verify(header, body, secretForVerifying);
      received.push({
        valid: outcome.ok,
        signatures: (header.match(/v1=/g) ?? []).length,
        envelope: JSON.parse(body),
      });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const endpoint = await registerEndpoint(pool, {
      principal: as(admin),
      url: `http://127.0.0.1:${port}/hook`,
      description: 'proof',
    });
    secretForVerifying = endpoint.secret;

    // An https URL is required outside localhost: a signed payload over plain
    // http is a signed payload anybody can read.
    let plainHttpRefused: string | null = null;
    try {
      await registerEndpoint(pool, { principal: as(admin), url: 'http://example.com/hook' });
    } catch (err) {
      plainHttpRefused = err instanceof Error ? err.message : String(err);
    }

    // ---- one record, which fires onboarding.started
    const first = await engine.submit({
      version,
      answers: completeFor(bp, { personal_email: 'hook@example.test' }),
      now: T0,
    });
    await engine.drain(T0, 'proof', tenantId);
    await deliverBatch(pool, { workerId: 'proof', now: T0 });

    const delivered = received[0];

    // ---- rotation, with the overlap §11.2 asks for
    await rotateSecret(pool, { principal: as(admin), endpointId: endpoint.id });
    const second = await engine.submit({
      version,
      answers: completeFor(bp, { personal_email: 'rotate@example.test' }),
      now: T0,
    });
    await engine.drain(T0, 'proof', tenantId);
    await deliverBatch(pool, { workerId: 'proof', now: T0 });
    // The receiver is still verifying with the OLD secret, which is the whole
    // point: a consumer redeploys at its own pace and drops nothing.
    const duringRotation = received[1];

    // ---- failure, backoff, and a terminal state
    refuse = true;
    const third = await engine.submit({
      version,
      answers: completeFor(bp, { personal_email: 'deadletter@example.test' }),
      now: T0,
    });
    await engine.drain(T0, 'proof', tenantId);

    let attempts = 0;
    let deadLettered = 0;
    // Six attempts, each made available immediately so the proof does not wait
    // out the real backoff. The backoff itself is a column, checked below.
    for (let i = 0; i < 7; i++) {
      const outcome = await deliverBatch(pool, { workerId: 'proof', now: new Date(T0.getTime() + i * 1000) });
      attempts += outcome.claimed;
      deadLettered += outcome.deadLettered;
      // Aligned to the proof's clock, not to wall time. The backoff itself is
      // real; this only skips the waiting, and using now() here would push the
      // row past the simulated clock so nothing would ever be claimed again.
      await pool.query(
        `update webhook_delivery set available_at = $2
          where instance_id = $1 and status = 'pending'`,
        [third.instanceId, new Date(T0.getTime() - 60_000)],
      );
    }

    const { rows: dead } = await pool.query<{ status: string; attempts: number; last_error: string }>(
      'select status, attempts, last_error from webhook_delivery where instance_id = $1',
      [third.instanceId],
    );

    // ---- inspect, then replay
    const inspected = await listDeliveries(pool, { principal: as(admin), instanceId: third.instanceId });
    refuse = false;
    const replayed = await replayDelivery(pool, {
      principal: as(admin),
      deliveryId: Number((inspected[0] as { id: number }).id),
      now: new Date(T0.getTime() - 1000),
    });
    await deliverBatch(pool, { workerId: 'proof', now: T0 });
    const { rows: afterReplay } = await pool.query<{ status: string; attempts: number }>(
      'select status, attempts from webhook_delivery where instance_id = $1',
      [third.instanceId],
    );

    /*
     * An event nobody subscribes to still leaves a trace.
     *
     * Tested by switching the endpoint off rather than by looking for a row
     * that happens to exist: the first version counted `no_subscriber` rows
     * across the whole table, and this proof registers an endpoint before it
     * sends anything, so there were never going to be any. A check that can
     * only pass by accident is not a check.
     */
    await pool.query('update webhook_endpoint set active = false where tenant_id = $1', [tenantId]);
    const orphan = await engine.submit({
      version,
      answers: completeFor(bp, { personal_email: 'nobody-listening@example.test' }),
      now: T0,
    });
    await engine.drain(T0, 'proof', tenantId);
    const { rows: unsubscribed } = await pool.query<{ count: number }>(
      `select count(*)::int as count from webhook_delivery
        where instance_id = $1 and status = 'no_subscriber'`,
      [orphan.instanceId],
    );

    const envelope = (delivered?.envelope ?? {}) as Record<string, unknown>;
    const hasAllFive =
      typeof envelope.event === 'string' &&
      envelope.event_id !== undefined &&
      envelope.instance_id === first.instanceId &&
      typeof envelope.process_version === 'number' &&
      typeof envelope.occurred_at === 'string';

    record(
      'A webhook actually leaves, is signed, survives a rotation, dies in a dead letter, and replays',
      'Section 11.2, against a real HTTP server that verifies the signature itself.',
      received.length >= 2 &&
        delivered?.valid === true &&
        hasAllFive &&
        plainHttpRefused !== null &&
        duringRotation?.valid === true &&
        duringRotation.signatures === 2 &&
        dead[0]?.status === 'dead_letter' &&
        dead[0].attempts === 6 &&
        deadLettered === 1 &&
        inspected.length >= 1 &&
        replayed.queued &&
        afterReplay[0]?.status === 'delivered' &&
        unsubscribed[0]!.count >= 1,
      `A real server received ${received.length} request(s) and verified every signature itself. The envelope carried the event, ` +
        `event id, instance id, process version and occurred-at that §11.2 names — before this, call_webhook wrote a row saying ` +
        `"delivered" and made no request at all. ` +
        `Registering a plain-http endpoint off localhost was refused ("${plainHttpRefused}"). ` +
        `After rotating the secret the next delivery carried ${duringRotation?.signatures} signatures and the receiver, still using the ` +
        `old one, accepted it — which is what "rotate with overlap" is for. ` +
        `Against a failing endpoint the delivery retried to ${dead[0]?.attempts} attempts and stopped in a dead letter rather than ` +
        `retrying forever; it was inspectable, and replaying it once the endpoint recovered delivered it. ` +
        `An event with no subscriber left a "no_subscriber" row, because silence is indistinguishable from never having fired.`,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * §6.1's IAM-01, IAM-04 and IAM-05.
 *
 * *"Users can create or join a tenant workspace"*, *"owners can invite,
 * deactivate, and revoke sessions"*, and an identity model that accommodates
 * SSO and SCIM. Three of the four `Must` rows that were not met, and the ones
 * that stood between this and a pilot with more than one person in it.
 *
 * The interesting assertions are the refusals. A workspace anybody can join,
 * an invitation that can be spent twice, a `builder` who can invite an owner,
 * or a last owner who can deactivate themselves are each a way to lose a
 * workspace — and none of them fails loudly at the time.
 */
export async function proveIdentity({ pool, record }: ProofCtx): Promise<void> {
  // ---- IAM-01: a workspace from nothing
  const created = await createWorkspace(pool, {
    workspaceName: 'Proof Trading',
    ownerEmail: 'owner@proof-identity.test',
    ownerName: 'An Owner',
    password: 'a-long-enough-password',
  });
  const owner: Principal = { kind: 'actor', tenantId: created.tenantId, actorId: created.actorId };

  let shortPassword: string | null = null;
  try {
    await createWorkspace(pool, {
      workspaceName: 'Too Easy',
      ownerEmail: 'weak@proof-identity.test',
      ownerName: 'W',
      password: 'short',
    });
  } catch (err) {
    shortPassword = err instanceof Error ? err.message : String(err);
  }

  // ---- the invitation gate: an unverified owner cannot invite anybody,
  //      because the invitation would arrive under their name.
  let unverifiedInvite: string | null = null;
  try {
    await invite(pool, { principal: owner, email: 'early@proof-identity.test', workspaceRole: 'analyst' });
  } catch (err) {
    unverifiedInvite = err instanceof Error ? err.message : String(err);
  }

  const verification = await sendVerification(pool, { actorId: created.actorId });
  await verifyEmail(pool, verification.token!);

  // ---- IAM-01: and joining one
  const invitation = await invite(pool, {
    principal: owner,
    email: 'builder@proof-identity.test',
    workspaceRole: 'builder',
  });
  const preview = await readInvitation(pool, invitation.token);
  const joined = await acceptInvitation(pool, {
    token: invitation.token,
    displayName: 'A Builder',
    password: 'builder-long-password',
  });
  const builder: Principal = { kind: 'actor', tenantId: joined.tenantId, actorId: joined.actorId };

  // Single use. A link that works twice is a link that works for whoever
  // forwarded the email.
  let replayed: string | null = null;
  try {
    await acceptInvitation(pool, {
      token: invitation.token,
      displayName: 'Somebody Else',
      password: 'another-long-password',
    });
  } catch (err) {
    replayed = err instanceof Error ? err.message : String(err);
  }

  // ---- escalation: a builder holds `administer`, so the capability check
  //      alone would let them invite an owner and then accept it themselves.
  let escalation: string | null = null;
  try {
    await invite(pool, { principal: builder, email: 'sneaky@proof-identity.test', workspaceRole: 'owner' });
  } catch (err) {
    escalation = err instanceof Error ? err.message : String(err);
  }
  const builderMayGrant = grantableRoles('builder');

  // ---- IAM-04: deactivate, and the sessions go with it
  const signedIn = await signIn(pool, {
    email: 'builder@proof-identity.test',
    password: 'builder-long-password',
  });
  // Narrowed rather than cast: if this account ever grows a second factor,
  // this line fails instead of the proof quietly asserting on the wrong thing.
  if (!signedIn || needsSecondFactor(signedIn)) throw new Error('expected a session, not a challenge');
  const session = signedIn;
  const liveBefore = await resolveSession(pool, session!.token);
  const deactivated = await setMemberActive(pool, { principal: owner, actorId: joined.actorId, active: false });
  const liveAfter = await resolveSession(pool, session!.token);

  // ---- the last owner cannot be removed, by either route
  let selfDeactivate: string | null = null;
  try {
    await setMemberActive(pool, { principal: owner, actorId: created.actorId, active: false });
  } catch (err) {
    selfDeactivate = err instanceof Error ? err.message : String(err);
  }
  let demote: string | null = null;
  try {
    await changeRole(pool, { principal: owner, actorId: created.actorId, workspaceRole: 'admin' });
  } catch (err) {
    demote = err instanceof Error ? err.message : String(err);
  }

  // ---- IAM-05: an external identity, matched on subject rather than email
  await linkIdentity(pool, {
    actorId: created.actorId,
    provider: 'oidc:example',
    subject: 'sub-0001',
    emailAtLink: 'owner@proof-identity.test',
  });
  const bySubject = await actorForIdentity(pool, { provider: 'oidc:example', subject: 'sub-0001' });

  // The address changes — a marriage, a domain migration — and the identity
  // still resolves, because it was never what we matched on.
  await pool.query('update actor set email = $1 where id = $2', [
    'renamed@proof-identity.test',
    created.actorId,
  ]);
  const afterRename = await actorForIdentity(pool, { provider: 'oidc:example', subject: 'sub-0001' });

  // The same subject from a different provider is a different person.
  const otherProvider = await actorForIdentity(pool, { provider: 'oidc:other', subject: 'sub-0001' });

  const { rows: provisioning } = await pool.query<{ provisioned_by: string; email_verified_at: Date | null }>(
    'select provisioned_by, email_verified_at from actor where id = $1',
    [joined.actorId],
  );

  record(
    'A workspace can be created and joined, and nobody can grant more than they hold',
    'Section 6.1: IAM-01, IAM-04 and IAM-05 — three of the four Must rows that were not met.',
    Boolean(created.tenantId) &&
      shortPassword !== null &&
      preview.workspaceName === 'Proof Trading' &&
      preview.workspaceRole === 'builder' &&
      joined.tenantId === created.tenantId &&
      replayed !== null &&
      escalation !== null &&
      !builderMayGrant.includes('owner') &&
      builderMayGrant.includes('analyst') &&
      liveBefore !== null &&
      liveAfter === null &&
      deactivated.sessionsRevoked === 1 &&
      selfDeactivate !== null &&
      demote !== null &&
      bySubject?.actorId === created.actorId &&
      afterRename?.actorId === created.actorId &&
      otherProvider === null &&
      provisioning[0]?.provisioned_by === 'invite' &&
      unverifiedInvite !== null &&
      provisioning[0]?.email_verified_at !== null,
    `A workspace was created from nothing and its owner signed in; a five-character password was refused ("${shortPassword?.slice(0, 40)}"). ` +
      `Before confirming their own address they could not invite anybody ("${unverifiedInvite?.slice(0, 48)}…"), because the invitation goes out under their name. ` +
      `The invitation showed the invitee the workspace name, their role and who asked — and nothing else — then created their account; ` +
      `the same link a second time was refused ("${replayed}"). ` +
      `A builder holds "administer", so the capability check alone would have let them invite an owner and accept it themselves; ` +
      `they may grant ${builderMayGrant.join(', ')} and were refused ("${escalation?.slice(0, 50)}"). ` +
      `Deactivating them revoked ${deactivated.sessionsRevoked} live session and their token stopped resolving immediately. ` +
      `The only owner could neither deactivate nor demote themselves, because a workspace with no owner has nobody who can invite one. ` +
      `Accepting the invitation marked the new member's address verified, because following a link that was emailed to it is the proof a verification link asks for. ` +
      `An external identity resolved by subject, and still resolved after the email address changed — matching on the address is how one person ends up with two accounts.`,
  );
}

/**
 * §12.1's last two authentication rows: verified email and password reset.
 *
 * The assertions worth having here are all refusals, and most of them are
 * about what the system declines to *tell* you. A reset endpoint that answers
 * differently for a member and a stranger is an account-enumeration oracle;
 * one that leaves old sessions alive turns a compromise into a formality; one
 * that stores the token it emailed turns a database dump into a set of keys.
 */
export async function proveAccountRecovery({ pool, record }: ProofCtx): Promise<void> {
  const created = await createWorkspace(pool, {
    workspaceName: 'Proof Recovery',
    ownerEmail: 'owner@proof-recovery.test',
    ownerName: 'An Owner',
    password: 'the-first-password',
  });

  // ---- verification: single use, and bound to the address it was sent to
  const first = await sendVerification(pool, { actorId: created.actorId });
  const verified = await verifyEmail(pool, first.token!);

  let replayedVerify: string | null = null;
  try {
    await verifyEmail(pool, first.token!);
  } catch (err) {
    replayedVerify = err instanceof Error ? err.message : String(err);
  }

  // A link issued for one address must not verify a different one. Otherwise:
  // request the link, change the address, follow the link, and an address
  // nobody proved anything about is marked verified.
  await pool.query('update actor set email_verified_at = null where id = $1', [created.actorId]);
  const forOldAddress = await sendVerification(pool, { actorId: created.actorId });
  await pool.query('update actor set email = $1 where id = $2', [
    'moved@proof-recovery.test',
    created.actorId,
  ]);
  let crossAddress: string | null = null;
  try {
    await verifyEmail(pool, forOldAddress.token!);
  } catch (err) {
    crossAddress = err instanceof Error ? err.message : String(err);
  }

  // ---- reset: the same answer for an address that exists and one that does not
  const known = await requestPasswordReset(pool, { email: 'moved@proof-recovery.test' });
  const unknown = await requestPasswordReset(pool, { email: 'nobody@proof-recovery.test' });
  const sameShape =
    JSON.stringify(Object.keys(known).filter((k) => k !== 'token')) ===
    JSON.stringify(Object.keys(unknown).filter((k) => k !== 'token'));

  // Nothing was sent to the stranger, which is the part the caller cannot see
  // and the part that matters.
  const { rows: mailed } = await pool.query<{ count: number }>(
    `select count(*)::int as count from platform_email
      where recipient = 'nobody@proof-recovery.test'`,
  );

  // ---- a live session, so the revocation has something to revoke
  const beforeSignIn = await signIn(pool, {
    email: 'moved@proof-recovery.test',
    password: 'the-first-password',
  });
  if (!beforeSignIn || needsSecondFactor(beforeSignIn)) throw new Error('expected a session, not a challenge');
  const before = beforeSignIn;
  const liveBefore = await resolveSession(pool, before!.token);

  const reset = await resetPassword(pool, { token: known.token!, password: 'the-second-password' });
  const liveAfter = await resolveSession(pool, before!.token);

  const oldPassword = await signIn(pool, {
    email: 'moved@proof-recovery.test',
    password: 'the-first-password',
  });
  const newPassword = await signIn(pool, {
    email: 'moved@proof-recovery.test',
    password: 'the-second-password',
  });

  let replayedReset: string | null = null;
  try {
    await resetPassword(pool, { token: known.token!, password: 'a-third-password-x' });
  } catch (err) {
    replayedReset = err instanceof Error ? err.message : String(err);
  }

  // ---- a deactivated account cannot be reset back into existence
  const other = await createWorkspace(pool, {
    workspaceName: 'Proof Recovery Two',
    ownerEmail: 'gone@proof-recovery.test',
    ownerName: 'Departed',
    password: 'a-fourth-password',
  });
  await pool.query('update actor set active = false where id = $1', [other.actorId]);
  const deactivated = await requestPasswordReset(pool, { email: 'gone@proof-recovery.test' });

  // ---- the token is the credential, so only its hash is stored
  const { rows: stored } = await pool.query<{ count: number }>(
    `select count(*)::int as count from auth_token
      where token_hash = $1 or token_hash = $2`,
    [known.token!, first.token!],
  );

  record(
    'Account recovery proves control of an address and cannot be used to find out who has one',
    'Section 12.1: verified email and password reset — the last two authentication rows.',
    verified.email === 'owner@proof-recovery.test' &&
      replayedVerify !== null &&
      crossAddress !== null &&
      sameShape &&
      mailed[0]!.count === 0 &&
      liveBefore !== null &&
      liveAfter === null &&
      reset.sessionsRevoked === 1 &&
      oldPassword === null &&
      newPassword !== null &&
      replayedReset !== null &&
      deactivated.token === undefined &&
      stored[0]!.count === 0,
    `A verification link confirmed the address and was refused the second time ("${replayedVerify}"). ` +
      `A link issued for one address did not verify a different one after the address changed ("${crossAddress?.slice(0, 44)}…") — ` +
      `without that check, requesting a link and then editing your address verifies an address you never proved. ` +
      `A reset request for an address with an account and one without returned the same shape, and ${mailed[0]!.count} messages went to the stranger. ` +
      `Spending the link revoked ${reset.sessionsRevoked} live session, the old password stopped working, the new one worked, and the link was refused a second time. ` +
      `A deactivated member got no link at all — a reset would be the way back in for somebody an owner deliberately removed. ` +
      `Searching auth_token for either plaintext token found ${stored[0]!.count} rows: only the SHA-256 is stored, so a dump of that table is not a set of keys.`,
  );
}

/**
 * §6.6's delivery log, past `sent`.
 *
 * Everything after `sent` is something the provider learns later and tells us
 * about over a webhook, and the schema said so in a comment for months: *"not
 * wired yet"*. The interesting assertions are the three ways this goes wrong
 * quietly — a forged notification accepted, a redelivery counted twice, and a
 * bounce recorded but not acted on, which is keeping a diary rather than
 * handling it.
 */
export async function proveDeliveryOutcomes({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const SECRET = 'whsec_proof_delivery';
  const sent: { to: string[]; subject: string }[] = [];
  const provider = {
    name: 'test',
    async send(email: { to: string[]; subject: string }) {
      sent.push({ to: email.to, subject: email.subject });
      return { providerMessageId: `msg-${sent.length}`, status: 'sent' as const };
    },
  };

  const engine = new Engine(pool, provider);
  const tenantId = await engine.createTenant('proof:delivery');
  const version = await engine.publish(tenantId, bp, 'proof');

  const { instanceId } = await engine.submit({
    version,
    answers: completeFor(bp, { personal_email: 'bouncer@proof-delivery.test', full_name: 'Bo Unser' }),
    now: T0,
  });
  await engine.drain(T0, 'proof', tenantId);

  const { rows: firstLog } = await pool.query<{ id: string; provider_message_id: string; status: string }>(
    `select id, provider_message_id, status from email_log
      where instance_id = $1 and status = 'sent' order by id limit 1`,
    [instanceId],
  );
  const message = firstLog[0]!;

  // ---- the signature is the credential, so forging one must not work
  const event = (type: string, data: Record<string, unknown>, id: string) =>
    JSON.stringify({ id, type, created_at: T0.toISOString(), data });

  const bounceBody = event(
    'email.bounced',
    {
      email_id: message.provider_message_id,
      recipient: 'bouncer@proof-delivery.test',
      bounce_type: 'hard',
      diagnostic_code: '550 5.1.1 user unknown',
    },
    'evt-bounce-1',
  );
  const nowMs = Date.now();
  const signed = signStandardWebhook(SECRET, 'evt-bounce-1', nowMs, bounceBody);

  const good = verifyRelyKit({ ...signed, secret: SECRET, body: bounceBody, now: nowMs });
  const wrongSecret = verifyRelyKit({ ...signed, secret: 'whsec_other', body: bounceBody, now: nowMs });
  const changedBody = verifyRelyKit({ ...signed, secret: SECRET, body: bounceBody + ' ', now: nowMs });
  // The timestamp is inside the signed string AND checked separately, so a
  // captured request cannot be replayed tomorrow.
  const replayedLater = verifyRelyKit({ ...signed, secret: SECRET, body: bounceBody, now: nowMs + 3_600_000 });

  // ---- the hard bounce: status, and the part with teeth
  const bounce = await ingest(pool, {
    provider: 'relykit',
    event: JSON.parse(bounceBody),
    eventId: 'evt-bounce-1',
  });

  // ---- redelivery. The provider retries until it gets a 2xx, so this is
  //      ordinary traffic rather than an attack.
  const redelivered = await ingest(pool, {
    provider: 'relykit',
    event: JSON.parse(bounceBody),
    eventId: 'evt-bounce-1',
  });
  const { rows: afterReplay } = await pool.query<{ count: number }>(
    `select count(*)::int as count from delivery_event where event_id = 'evt-bounce-1'`,
  );

  // ---- a delivery notification arriving after the bounce must not tidy it up
  const late = await ingest(pool, {
    provider: 'relykit',
    event: JSON.parse(
      event(
        'email.delivered',
        { email_id: message.provider_message_id, recipient: 'someone-else@proof-delivery.test' },
        'evt-late-1',
      ),
    ),
    eventId: 'evt-late-1',
  });

  // ---- a soft bounce is a full mailbox, not a dead one
  await ingest(pool, {
    provider: 'relykit',
    event: JSON.parse(
      event(
        'email.bounced',
        { email_id: message.provider_message_id, recipient: 'soft@proof-delivery.test', bounce_type: 'soft' },
        'evt-soft-1',
      ),
    ),
    eventId: 'evt-soft-1',
  });
  const softSuppressed = await blockedRecipients(pool, ['soft@proof-delivery.test']);

  // ---- an event about a message this deployment never sent
  const foreign = await ingest(pool, {
    provider: 'relykit',
    event: JSON.parse(event('email.delivered', { email_id: 'not-ours', recipient: 'x@example.test' }, 'evt-foreign-1')),
    eventId: 'evt-foreign-1',
  });

  // ---- and now the only assertion that is about behaviour rather than
  //      bookkeeping: does the next send actually stop?
  const before = sent.length;
  const second = await engine.submit({
    version,
    // A different start_date, because identity is (personal_email,
    // start_date) and the same pair would be recognised as a duplicate — no
    // instance, no actions, and a vacuous proof that nothing was sent.
    answers: completeFor(bp, {
      personal_email: 'bouncer@proof-delivery.test',
      full_name: 'Bo Unser',
      start_date: '2027-02-01',
    }),
    now: new Date(T0.getTime() + hours(1)),
  });
  await engine.drain(new Date(T0.getTime() + hours(1)), 'proof', tenantId);
  const afterBlocked = sent.length;

  const { rows: skipped } = await pool.query<{ status: string; failure: string; recipients: string[] }>(
    `select status, failure, recipients from email_log
      where instance_id = $1 and status = 'skipped' order by id limit 1`,
    [second.instanceId],
  );

  // ---- lifting it, and a fresh bounce overruling the lift
  const operator = await engine.createActor(tenantId, 'ops@proof-delivery.test', 'Ops', 'admin');
  const lifted = await lift(pool, { email: 'bouncer@proof-delivery.test', actorId: operator });
  const afterLift = await blockedRecipients(pool, ['bouncer@proof-delivery.test']);
  await ingest(pool, {
    provider: 'relykit',
    event: JSON.parse(
      event(
        'email.bounced',
        { email_id: message.provider_message_id, recipient: 'bouncer@proof-delivery.test', bounce_type: 'hard' },
        'evt-bounce-2',
      ),
    ),
    eventId: 'evt-bounce-2',
  });
  const afterSecondBounce = await blockedRecipients(pool, ['bouncer@proof-delivery.test']);

  // ---- one tenant must not be able to read another's contacts from the list
  const otherTenant = await engine.createTenant('proof:delivery:other');
  const theirs = await suppressionsFor(pool, otherTenant);
  const ours = await suppressionsFor(pool, tenantId);

  const { rows: finalStatus } = await pool.query<{ status: string; failure: string }>(
    'select status, failure from email_log where id = $1',
    [message.id],
  );

  record(
    'A bounce changes what the system does next, and a forged one changes nothing',
    'Section 6.6: the delivery log past `sent` — delivered, bounced, complained, and the suppression that follows.',
    good.ok &&
      !wrongSecret.ok &&
      !changedBody.ok &&
      !replayedLater.ok &&
      bounce.statusAfter === 'bounced' &&
      bounce.suppressed === 'bouncer@proof-delivery.test' &&
      redelivered.duplicate &&
      afterReplay[0]!.count === 1 &&
      late.statusAfter === 'bounced' &&
      softSuppressed.size === 0 &&
      foreign.matched === null &&
      !foreign.duplicate &&
      afterBlocked === before &&
      skipped[0]?.failure?.includes('suppressed') === true &&
      lifted.lifted &&
      afterLift.size === 0 &&
      afterSecondBounce.size === 1 &&
      theirs.length === 0 &&
      ours.length > 0 &&
      finalStatus[0]!.status === 'bounced',
    `A signed notification verified; the same bytes with a different secret, one extra space, and an hour of age were each refused. ` +
      `A hard bounce moved the message to "${bounce.statusAfter}" and suppressed the address. ` +
      `The provider retries until it gets a 2xx, so the identical event was delivered again and was a no-op — ${afterReplay[0]!.count} row, not two. ` +
      `A delivery notification arriving afterwards left the message "${late.statusAfter}": a message's state is the worst thing that happened to any recipient, and a later event never lowers it. ` +
      `A soft bounce suppressed nobody, because a full mailbox is not a dead one. ` +
      `An event for a message we never sent was recorded and matched nothing, rather than returning an error the provider would retry forever. ` +
      `Then the test that matters: the same address was mailed again by a second record and ${afterBlocked - before} messages left — the send was logged "${skipped[0]?.status}" reading "${skipped[0]?.failure}". ` +
      `An operator lifted it and a fresh hard bounce put it straight back, because the mail server gets the last word. ` +
      `A tenant that had never written to that address saw ${theirs.length} suppressions while the tenant that had saw ${ours.length}.`,
  );
}

/**
 * §12.1's last authentication row: the MFA option.
 *
 * Every assertion here is a refusal, because a second factor is defined
 * entirely by what it stops. The five that separate a real one from the
 * appearance of one: the password alone stops working, enrolment needs proof
 * the authenticator has the secret, a code cannot be spent twice, guesses are
 * capped, and turning it off needs the password rather than the phone.
 */
export async function proveSecondFactor({ pool, record }: ProofCtx): Promise<void> {
  const created = await createWorkspace(pool, {
    workspaceName: 'Proof Two Step',
    ownerEmail: 'owner@proof-mfa.test',
    ownerName: 'An Owner',
    password: 'the-account-password',
  });
  const actorId = created.actorId;
  const T = Date.UTC(2026, 8, 22, 12, 0, 0);

  // ---- before enrolment, a password is a session
  const plain = await signIn(pool, { email: 'owner@proof-mfa.test', password: 'the-account-password' });
  const plainWorked = plain !== null && !needsSecondFactor(plain);

  // ---- enrolment does not switch on when the secret is generated
  const started = await beginEnrolment(pool, { actorId });
  const midEnrolment = await signIn(pool, {
    email: 'owner@proof-mfa.test',
    password: 'the-account-password',
  });
  const stillPlain = midEnrolment !== null && !needsSecondFactor(midEnrolment);

  let wrongCode: string | null = null;
  try {
    await confirmEnrolment(pool, { actorId, code: '000000', nowMs: T });
  } catch (err) {
    wrongCode = err instanceof Error ? err.message : String(err);
  }

  // ---- and it does when a real code proves the authenticator has the secret
  const { recoveryCodes } = await confirmEnrolment(pool, {
    actorId,
    code: codeFor(started.secret, stepFor(T)),
    nowMs: T,
  });

  // ---- now the password alone produces nothing that works
  const challenged = await signIn(pool, {
    email: 'owner@proof-mfa.test',
    password: 'the-account-password',
  });
  const gotChallenge = challenged !== null && needsSecondFactor(challenged);
  const challengeToken = gotChallenge ? (challenged as { challengeToken: string }).challengeToken : '';

  // A challenge token is not a session. Nothing about it resolves.
  const challengeAsSession = await resolveSession(pool, challengeToken);

  // ---- the wrong code, five times, and the challenge is spent
  const burn = await signIn(pool, { email: 'owner@proof-mfa.test', password: 'the-account-password' });
  const burnToken = (burn as { challengeToken: string }).challengeToken;
  const refusals: string[] = [];
  for (let i = 0; i < 6; i++) {
    try {
      await answerChallenge(pool, { token: burnToken, code: '123456', nowMs: T });
    } catch (err) {
      refusals.push(err instanceof Error ? err.message : String(err));
    }
  }
  const cappedAt = refusals.findIndex((r) => r.includes('too many'));

  /*
   * ---- the code that CONFIRMED enrolment cannot then sign in.
   *
   * It was found by writing this proof: enrolling and signing in at the same
   * step is refused, because confirming spends that step like any other use.
   * Worth asserting rather than stepping around — anybody who can see the
   * enrolment code can otherwise use it once more.
   */
  const step = stepFor(T);
  let enrolmentCodeReused: string | null = null;
  try {
    await answerChallenge(pool, { token: challengeToken, code: codeFor(started.secret, step), nowMs: T });
  } catch (err) {
    enrolmentCodeReused = err instanceof Error ? err.message : String(err);
  }

  // ---- the right code, from the next window
  const answered = await answerChallenge(pool, {
    token: challengeToken,
    code: codeFor(started.secret, step + 1),
    nowMs: T + 30_000,
  });
  const session = await startSession(pool, { actorId: answered.actorId });
  const sessionWorks = session !== null && (await resolveSession(pool, session.token)) !== null;

  // ---- the SAME code again, inside its own thirty seconds
  const second = await signIn(pool, { email: 'owner@proof-mfa.test', password: 'the-account-password' });
  const secondToken = (second as { challengeToken: string }).challengeToken;
  let replayed: string | null = null;
  try {
    await answerChallenge(pool, {
      token: secondToken,
      code: codeFor(started.secret, step + 1),
      nowMs: T + 30_000,
    });
  } catch (err) {
    replayed = err instanceof Error ? err.message : String(err);
  }

  // The next step's code works, so the replay guard blocks reuse rather than
  // locking the account out of its own authenticator.
  const nextStep = await answerChallenge(pool, {
    token: secondToken,
    code: codeFor(started.secret, step + 2),
    nowMs: T + 60_000,
  });

  // ---- a phone thirty seconds out still works
  const drifting = await signIn(pool, { email: 'owner@proof-mfa.test', password: 'the-account-password' });
  const driftToken = (drifting as { challengeToken: string }).challengeToken;
  const drifted = await answerChallenge(pool, {
    token: driftToken,
    code: codeFor(started.secret, step + 3),
    nowMs: T + 120_000,
  });

  // ---- a recovery code, once
  const recovery = await signIn(pool, { email: 'owner@proof-mfa.test', password: 'the-account-password' });
  const recoveryToken = (recovery as { challengeToken: string }).challengeToken;
  const used = await answerChallenge(pool, { token: recoveryToken, code: recoveryCodes[0]!, nowMs: T + 150_000 });

  const again = await signIn(pool, { email: 'owner@proof-mfa.test', password: 'the-account-password' });
  const againToken = (again as { challengeToken: string }).challengeToken;
  let spentRecovery: string | null = null;
  try {
    await answerChallenge(pool, { token: againToken, code: recoveryCodes[0]!, nowMs: T + 180_000 });
  } catch (err) {
    spentRecovery = err instanceof Error ? err.message : String(err);
  }

  // ---- only hashes are stored, for either credential
  const { rows: stored } = await pool.query<{ count: number }>(
    `select count(*)::int as count from mfa_recovery_code where code_hash = $1`,
    [recoveryCodes[1]!],
  );

  // ---- turning it off needs the password, not the phone
  let withCode: string | null = null;
  try {
    await disableMfa(pool, { actorId, password: codeFor(started.secret, stepFor(T)) });
  } catch (err) {
    withCode = err instanceof Error ? err.message : String(err);
  }
  await disableMfa(pool, { actorId, password: 'the-account-password' });
  const afterDisable = await signIn(pool, {
    email: 'owner@proof-mfa.test',
    password: 'the-account-password',
  });
  const plainAgain = afterDisable !== null && !needsSecondFactor(afterDisable);

  record(
    'A second factor makes the password stop being enough, and cannot be replayed or guessed',
    'Section 12.1: the MFA option — the last unmet row in authentication.',
    plainWorked &&
      stillPlain &&
      wrongCode !== null &&
      recoveryCodes.length === 10 &&
      gotChallenge &&
      challengeAsSession === null &&
      cappedAt === 5 &&
      enrolmentCodeReused !== null &&
      sessionWorks &&
      replayed !== null &&
      !nextStep.usedRecoveryCode &&
      !drifted.usedRecoveryCode &&
      used.usedRecoveryCode &&
      used.recoveryCodesLeft === 9 &&
      spentRecovery !== null &&
      stored[0]!.count === 0 &&
      withCode !== null &&
      plainAgain,
    `Before enrolment the password produced a session. Generating a secret did NOT turn the factor on — the password still worked — ` +
      `and a wrong code was refused ("${wrongCode}"); an enrolment that switches on when the secret is created locks out everybody whose scan silently failed. ` +
      `A real code confirmed it and returned ${recoveryCodes.length} recovery codes. ` +
      `From then on the password returned a challenge instead of a session, and the challenge token resolved to nothing — it is not a session with a flag on it. ` +
      `Five wrong guesses were refused individually and the sixth was refused for exhausting the attempts; six digits is a million possibilities and unlimited guesses would make that number decorative. ` +
      `The code that confirmed enrolment could not then sign in ("${enrolmentCodeReused}") — confirming spends that window like any other use. ` +
      `The next window's code signed in. That SAME code a moment later was refused ("${replayed}") while the next one worked — a code read over a shoulder is otherwise good for another thirty seconds. ` +
      `A phone two minutes fast still signed in, because rejecting clock drift is how a second factor becomes a support queue. ` +
      `A recovery code worked once and left ${used.recoveryCodesLeft}; the same one again was refused. Searching for a plaintext recovery code found ${stored[0]!.count} rows. ` +
      `Turning it off with a valid authenticator code was refused ("${withCode}") — somebody holding the phone but not the password is exactly who must not remove the factor — and the password turned it off.`,
  );
}
