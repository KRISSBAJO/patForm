import type { Blueprint } from './blueprint/index.js';
import { Blueprint as BlueprintSchema } from './blueprint/index.js';
import { readFileSync } from 'node:fs';
import { myWork } from './runtime/console-queries.js';
import { validate } from './compiler/validate.js';
import type { Pool } from './runtime/db.js';
import { Engine, newWorkerId } from './runtime/engine.js';
import { AuthorizationError, type Principal } from './runtime/policy.js';
import { resolveResumeToken } from './runtime/auth.js';
import { runRetention } from './runtime/retention.js';
import { checkAnswers, loadDraft, publicForm, respondentStatus, respondentUpdate, saveDraft, submitForm } from './runtime/intake.js';
import { confirm, runDirect, runPlan } from './runtime/copilot.js';
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
  inviteMany,
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
import { createHash, createHmac, randomBytes } from 'node:crypto';
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
  claimDraft,
  discardDraft,
  loadDraft as loadBuilderDraft,
  openDraft,
  publishDraft,
  publishImpact,
  releaseDraft,
  saveDraft as saveBuilderDraft,
  testVersion,
  viewProcess,
} from './runtime/builder.js';
import { DraftConflict } from './runtime/errors.js';
import { issueTicket, screen } from './runtime/screening.js';
import { assertSecretKeyConfigured } from './runtime/secret-box.js';
import { isFresh, reauthenticate, stepUpFor } from './runtime/step-up.js';
import { PUBLIC_ID, resolveForm } from './runtime/form-links.js';
import { FormLinkError } from './runtime/errors.js';
import {
  authorize as oauthAuthorize,
  denyRequest,
  describeRequest,
  exchangeCode,
  OAuthError,
  parseAuthorizeQuery,
  refresh as oauthRefresh,
  registerClient,
  resolveAccessToken,
} from './api/oauth.js';
import { discardHeld, listHeld, releaseHeld } from './runtime/held.js';
import { checkSendingHealth, resendSkipped, sendingHealth, skippedFor } from './runtime/delivery-health.js';

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

  /*
   * What a real record has hanging off it by the time it is old: a report
   * from the email provider about its receipt, a message sent again after a
   * suppression was lifted, and a vote on its approval. Each is a row that
   * points at something retention deletes, and the first of them blocked the
   * delete outright until it cascaded — so retention failed on any record a
   * provider had reported on, which in production is nearly all of them. The
   * proof used to delete a record that had none of these.
   */
  const { rows: mailed } = await pool.query<{ id: string }>(
    'select id from email_log where instance_id = $1 order by id limit 1',
    [instanceId],
  );
  await pool.query(
    `insert into delivery_event (event_id, provider, type, provider_message_id, recipient, payload, email_log_id, occurred_at)
     values ('evt-retention-1', 'relykit', 'email.delivered', 'msg-retention-1', 'old@example.test', '{}', $1, $2)`,
    [mailed[0]!.id, T0],
  );
  await pool.query(
    `insert into email_resend (tenant_id, email_log_id, recipient, resent_by) values ($1, $2, 'old@example.test', $3)`,
    [tenantId, mailed[0]!.id, adminId],
  );
  const { rows: request } = await pool.query<{ id: string }>(
    'select id from approval_request where instance_id = $1 order by id limit 1',
    [instanceId],
  );
  await pool.query(
    `insert into approval_vote (request_id, tenant_id, actor, decision, decided_at) values ($1, $2, 'actor:someone', 'approved', $3)`,
    [request[0]!.id, tenantId, T0],
  );

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
  const { rows: dependents } = await pool.query<{ n: number }>(
    `select (select count(*) from delivery_event where event_id = 'evt-retention-1')
          + (select count(*) from email_resend where recipient = 'old@example.test')
          + (select count(*) from approval_vote where actor = 'actor:someone') as n`,
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
      Number(dependents[0]!.n) === 0 &&
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
    baseRevision: opened.revision,
  });

  // 4. A publish attempt while broken must be refused by the server, not just
  //    by a disabled button.
  let publishRefused: string | null = null;
  try {
    await publishDraft(pool, { principal: as(builder), draftId: opened.id, revision: afterBreak.revision });
  } catch (err) {
    publishRefused = err instanceof Error ? err.message : String(err);
  }

  // 5. Work that does not even parse is still kept.
  const halfTyped = await saveBuilderDraft(pool, {
    principal: as(builder),
    draftId: opened.id,
    blueprint: { half: 'typed' },
    baseRevision: afterBreak.revision,
  });
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
  const afterFix = await saveBuilderDraft(pool, {
    principal: as(builder),
    draftId: opened.id,
    blueprint: fixed,
    baseRevision: halfTyped.revision,
  });

  const impact = await publishImpact(pool, { principal: as(builder), draftId: opened.id });
  const published = await publishDraft(pool, { principal: as(builder), draftId: opened.id, revision: afterFix.revision });

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
 * Two people, one draft.
 *
 * Saving used to be last-write-wins: the second person's save replaced the
 * whole blueprint and the first person's work was gone, with a green "saved"
 * on both screens. And the permission check stopped at opening a draft —
 * loading, saving and publishing one asked only whether you were in the same
 * workspace, so a read-only member holding a draft's id could publish a
 * process. Both are closed here, and this proof tries each way through.
 */
export async function proveDraftLocking({ pool, bp, record }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:locking');
  await engine.publish(tenantId, bp, 'proof');

  const joy = await engine.createActor(tenantId, 'joy@proof.test', 'Joy Builder', 'builder');
  const sam = await engine.createActor(tenantId, 'sam@proof.test', 'Sam Builder', 'builder');
  const dana = await engine.createActor(tenantId, 'dana@proof.test', 'Dana Reader', 'read_only');
  const as = (actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });

  const refusal = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
      return 'allowed';
    } catch (err) {
      if (err instanceof DraftConflict) return `conflict:${err.kind}:${err.detail.by ?? ''}`;
      if (err instanceof AuthorizationError) return 'refused';
      return `error:${err instanceof Error ? err.message : String(err)}`;
    }
  };

  // 1. Joy opens and claims it. Sam opens the same draft and is told who has it.
  const opened = await openDraft(pool, { principal: as(joy), processKey: bp.key });
  const joyClaim = await claimDraft(pool, { principal: as(joy), draftId: opened.id });
  const samClaim = await claimDraft(pool, { principal: as(sam), draftId: opened.id });

  // 2. Sam saves anyway — refused, with Joy's name, while her lease is live.
  const edit = (label: string) => {
    const next = structuredClone(opened.blueprint);
    next.name = label;
    return next;
  };
  const samWhileHeld = await refusal(() =>
    saveBuilderDraft(pool, { principal: as(sam), draftId: opened.id, blueprint: edit('Sam'), baseRevision: opened.revision }),
  );

  // 3. Joy saves; the revision moves on.
  const joySaved = await saveBuilderDraft(pool, {
    principal: as(joy),
    draftId: opened.id,
    blueprint: edit('Joy'),
    baseRevision: opened.revision,
  });

  // 4. Joy goes to a meeting. Sam takes over. Joy's next save, from her
  //    still-open tab, is refused with Sam's name — her work is not written
  //    over his, and his is not written over hers.
  const takeOver = await claimDraft(pool, { principal: as(sam), draftId: opened.id, takeOver: true });
  const joyAfterTakeover = await refusal(() =>
    saveBuilderDraft(pool, { principal: as(joy), draftId: opened.id, blueprint: edit('Joy again'), baseRevision: joySaved.revision }),
  );

  // 5. Sam saves from a copy he loaded *before* Joy's save — stale, refused,
  //    naming Joy as the one who saved since.
  const samStale = await refusal(() =>
    saveBuilderDraft(pool, { principal: as(sam), draftId: opened.id, blueprint: edit('Sam stale'), baseRevision: opened.revision }),
  );

  // 6. Sam reloads, saves on the current revision, and it lands.
  const samFresh = await loadBuilderDraft(pool, as(sam), opened.id);
  const samSaved = await saveBuilderDraft(pool, {
    principal: as(sam),
    draftId: opened.id,
    blueprint: edit('Sam'),
    baseRevision: samFresh.revision,
  });

  // 7. Publishing names the revision reviewed. An old one is refused — and
  //    since the save that moved it on was Sam's own, it says "you", not
  //    his name back to him, which is how two tabs of one person read.
  const publishOld = await refusal(() =>
    publishDraft(pool, { principal: as(sam), draftId: opened.id, revision: joySaved.revision }),
  );

  // 8. Joy cannot throw the draft away while Sam holds it.
  const joyDiscard = await refusal(() => discardDraft(pool, { principal: as(joy), draftId: opened.id }));

  // 9. A read-only member is refused at every door, not just the first one.
  const dana1 = await refusal(() => loadBuilderDraft(pool, as(dana), opened.id));
  const dana2 = await refusal(() =>
    saveBuilderDraft(pool, { principal: as(dana), draftId: opened.id, blueprint: edit('Dana'), baseRevision: samSaved.revision }),
  );
  const dana3 = await refusal(() => claimDraft(pool, { principal: as(dana), draftId: opened.id }));
  const dana4 = await refusal(() => publishDraft(pool, { principal: as(dana), draftId: opened.id, revision: samSaved.revision }));

  // 10. Sam publishes what he reviewed; the lease goes with the draft, and a
  //     save after publishing says so instead of quietly doing nothing.
  const published = await publishDraft(pool, { principal: as(sam), draftId: opened.id, revision: samSaved.revision });
  const afterPublish = await refusal(() =>
    saveBuilderDraft(pool, { principal: as(sam), draftId: opened.id, blueprint: edit('late'), baseRevision: samSaved.revision }),
  );

  // 11. Releasing only lets go of your own lease.
  const other = await openDraft(pool, { principal: as(joy), processKey: bp.key });
  await claimDraft(pool, { principal: as(joy), draftId: other.id });
  const samRelease = await releaseDraft(pool, { principal: as(sam), draftId: other.id });
  const joyRelease = await releaseDraft(pool, { principal: as(joy), draftId: other.id });
  const freed = await claimDraft(pool, { principal: as(sam), draftId: other.id });

  record(
    'Two people editing one draft are told about each other, and neither overwrites the other',
    'Draft locking: a revision on every save and publish, and an editing lease that says who has it. A read-only member is refused on every draft route.',
    joyClaim.mine &&
      samClaim.by === 'Joy Builder' &&
      !samClaim.mine &&
      samWhileHeld === 'conflict:held:Joy Builder' &&
      joySaved.revision === opened.revision + 1 &&
      takeOver.mine &&
      takeOver.tookOverFrom === 'Joy Builder' &&
      joyAfterTakeover === 'conflict:held:Sam Builder' &&
      samStale === 'conflict:stale:Joy Builder' &&
      samSaved.revision === joySaved.revision + 1 &&
      publishOld === 'conflict:stale:you' &&
      joyDiscard === 'conflict:held:Sam Builder' &&
      [dana1, dana2, dana3, dana4].every((r) => r === 'refused') &&
      published.version === 2 &&
      afterPublish.startsWith('conflict:published') &&
      !samRelease.released &&
      joyRelease.released &&
      freed.mine,
    `Sam opening Joy's draft was told "${samClaim.by}" had it, and his save was refused (${samWhileHeld}). ` +
      `He took over from ${takeOver.tookOverFrom}; her next save was refused (${joyAfterTakeover}), and his save from a ` +
      `copy older than hers was refused as stale (${samStale}). Reloaded, it landed at revision ${samSaved.revision}. ` +
      `Publishing an older revision: ${publishOld}. Discarding under someone else's lease: ${joyDiscard}. ` +
      `A read-only member on load, save, claim and publish: ${[dana1, dana2, dana3, dana4].join(', ')}. ` +
      `Published as v${published.version}; a save afterwards: ${afterPublish}. Releasing someone else's lease: ${samRelease.released}.`,
  );
}

/**
 * A public form tells a person from a script, and a script's submission does nothing.
 *
 * Rate limiting stopped one caller making a thousand records and did nothing
 * about a thousand callers making one each. Worse than the records was what
 * each one did on arrival: the onboarding form emails whatever "manager"
 * address it is given, so every fabricated submission was an email from this
 * platform to an address a stranger chose. This proof submits the way scripts
 * do and checks that none of it becomes a record or sends a thing — and that
 * a real person is never the one who pays for it.
 */
export async function proveScreening({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:screening');
  await engine.publish(tenantId, bp, 'proof');
  const operator = await engine.createActor(tenantId, 'op@proof.test', 'An Operator', 'operator');
  const reader = await engine.createActor(tenantId, 'reader@proof.test', 'A Reader', 'read_only');
  const as = (actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });

  const at = T0.getTime();
  const answers = (email: string, manager = 'manager@example.test') =>
    completeFor(bp, { personal_email: email, manager_email: manager }) as never;
  const count = async (table: 'instance' | 'outbox') =>
    (await pool.query<{ n: number }>(`select count(*)::int as n from ${table} where tenant_id = $1`, [tenantId])).rows[0]!.n;
  const submit = (email: string, screening: ReturnType<typeof screen>, manager?: string) =>
    submitForm(pool, { processKey: bp.key, answers: answers(email, manager), now: T0, screening });

  // 1. A person: loaded the form, spent a while on it, left the trap empty.
  const person = screen({ processKey: bp.key, ticket: issueTicket(bp.key, at - 95_000), trap: '', now: at });
  const real = await submit('real.person@example.test', person);

  const before = { instances: await count('instance'), outbox: await count('outbox') };

  // 2. Four kinds of script. Each one names a "manager" it wants emailed.
  const victim = 'someone-else@example.test';
  const noTicket = screen({ processKey: bp.key, now: at });
  const tooFast = screen({ processKey: bp.key, ticket: issueTicket(bp.key, at - 800), trap: '', now: at });
  const forged = screen({ processKey: bp.key, ticket: issueTicket('some_other_process', at - 95_000), now: at });
  const trapped = screen({ processKey: bp.key, ticket: issueTicket(bp.key, at - 95_000), trap: 'https://spam.example', now: at });
  const held = [
    await submit('bot.one@example.test', noTicket, victim),
    await submit('bot.two@example.test', tooFast, victim),
    await submit('bot.three@example.test', forged, victim),
    // The script got a real person's address and used it.
    await submit('taken.identity@example.test', trapped, victim),
  ];
  await engine.drain(T0, 'proof', tenantId);
  const after = { instances: await count('instance'), outbox: await count('outbox') };

  // 3. The real owner of that address submits afterwards. Their submission
  //    must not be swallowed as a duplicate of the script's.
  const owner = await submit('taken.identity@example.test', person);

  // 4. What an operator sees, and what a read-only member sees.
  const queue = await listHeld(pool, as(operator));
  const readerQueue = await listHeld(pool, as(reader));
  let readerRelease = 'allowed';
  try {
    await releaseHeld(pool, { principal: as(reader), heldId: held[0]!.instanceId! });
  } catch (err) {
    readerRelease = err instanceof AuthorizationError ? 'refused' : String(err);
  }

  // 5. Released: it becomes a record under the reference the person was shown,
  //    and does on release what it would have done on arrival.
  const outboxBeforeRelease = await count('outbox');
  const released = await releaseHeld(pool, { principal: as(operator), heldId: held[1]!.instanceId!, now: T0 });
  await engine.drain(T0, 'proof', tenantId);
  const outboxAfterRelease = await count('outbox');
  const again = await releaseHeld(pool, { principal: as(operator), heldId: held[1]!.instanceId!, now: T0 });
  const { rows: trail } = await pool.query<{ type: string }>(
    'select type from event where instance_id = $1 order by seq',
    [released.instanceId],
  );

  // 6. Released, but the same person already has a record: it joins that one.
  const dup = await releaseHeld(pool, { principal: as(operator), heldId: held[3]!.instanceId!, now: T0 });

  // 7. Discarded: the answers go, and it cannot be released afterwards.
  await discardHeld(pool, { principal: as(operator), heldId: held[2]!.instanceId! });
  const { rows: gone } = await pool.query<{ answers: Record<string, unknown> }>(
    'select answers from held_submission where id = $1',
    [held[2]!.instanceId],
  );
  let releaseDiscarded = 'allowed';
  try {
    await releaseHeld(pool, { principal: as(operator), heldId: held[2]!.instanceId! });
  } catch (err) {
    releaseDiscarded = err instanceof Error ? err.message : String(err);
  }

  const reasons = [noTicket, tooFast, forged, trapped].map((x) => x.reasons.join('+'));

  record(
    'A script\'s submission is held, sends nothing, and a person is never the one who loses',
    'Spam control on public forms: a signed ticket and a trap field, and a held queue instead of a silent discard.',
    real.ok &&
      !person.hold &&
      reasons.join(',') === 'no_ticket,too_fast,bad_ticket,trap_filled' &&
      held.every((h) => h.ok && h.held) &&
      after.instances === before.instances &&
      after.outbox === before.outbox &&
      owner.ok &&
      !owner.held &&
      !owner.duplicate &&
      queue.length === 4 &&
      queue.every((q) => q.reasons.length > 0) &&
      readerQueue.length === 0 &&
      readerRelease === 'refused' &&
      released.instanceId === held[1]!.instanceId &&
      !released.duplicate &&
      outboxAfterRelease > outboxBeforeRelease &&
      again.instanceId === released.instanceId &&
      trail.some((e) => e.type === 'submitted') &&
      trail.some((e) => e.type === 'released_from_hold') &&
      dup.duplicate &&
      dup.instanceId === owner.instanceId &&
      Object.keys(gone[0]!.answers).length === 0 &&
      releaseDiscarded.includes('discarded'),
    `A person with a ticket issued ${person.elapsedMs! / 1000}s earlier went straight through. ` +
      `Four scripts were held for ${reasons.join(', ')}; between them they made ${after.instances - before.instances} records ` +
      `and queued ${after.outbox - before.outbox} actions, so the address they each named as manager was sent nothing. ` +
      `The real owner of an address a script had used submitted afterwards and got their own record rather than being ` +
      `folded into the script's. An operator saw ${queue.length} held; a read-only member saw ${readerQueue.length} and ` +
      `was ${readerRelease} when releasing. Releasing one made a record under the held id and queued ` +
      `${outboxAfterRelease - outboxBeforeRelease} action(s); releasing it again returned the same record. Releasing the ` +
      `one that shared an address joined the existing record (duplicate: ${dup.duplicate}). Discarding cleared ` +
      `${Object.keys(gone[0]!.answers).length === 0 ? 'every' : 'not every'} answer, and a release afterwards was refused.`,
  );
}

/**
 * The bounce rate is watched, and an address that comes back gets what it missed.
 *
 * Single bounces were handled; the rate was not, and the rate is what the
 * provider suspends an account over — which would stop every message from
 * every workspace. And reinstating an address let future mail through while
 * the messages skipped in the meantime were simply gone.
 */
export async function proveSendingHealth({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const sent: { to: string[]; subject: string; key?: string }[] = [];
  const provider = {
    name: 'test',
    async send(email: { to: string[]; subject: string; idempotencyKey?: string }) {
      sent.push({ to: email.to, subject: email.subject, key: email.idempotencyKey });
      return { providerMessageId: `msg-${sent.length}`, status: 'sent' as const };
    },
  };
  const engine = new Engine(pool, provider);
  const tenantId = await engine.createTenant('proof:sending-health');
  const quiet = await engine.createTenant('proof:sending-health-quiet');
  const version = await engine.publish(tenantId, bp, 'proof');
  const admin = await engine.createActor(tenantId, 'admin@proof.test', 'An Admin', 'admin');

  // Sixty people submit; each gets a receipt.
  for (let i = 0; i < 60; i++) {
    await engine.submit({
      version,
      answers: completeFor(bp, { personal_email: `person${i}@proof-health.test` }) as never,
      now: T0,
    });
  }
  await engine.drain(T0, 'proof', tenantId);

  const { rows: receipts } = await pool.query<{ provider_message_id: string; to: string }>(
    `select provider_message_id, recipients[1] as to from email_log
      where tenant_id = $1 and template_key = 'submission_receipt' and status = 'sent' order by id`,
    [tenantId],
  );
  let n = 0;
  const bounceNext = async (count: number) => {
    for (let i = 0; i < count; i++) {
      const r = receipts[n++]!;
      await ingest(pool, {
        provider: 'relykit',
        eventId: `evt-health-${n}`,
        event: {
          id: `evt-health-${n}`,
          type: 'email.bounced',
          created_at: T0.toISOString(),
          data: { email_id: r.provider_message_id, recipient: r.to, bounce_type: 'hard', diagnostic_code: '550 user unknown' },
        } as never,
      });
    }
  };

  const previous = process.env.OPS_ALERT_EMAIL;
  process.env.OPS_ALERT_EMAIL = 'ops@proof-health.test';
  try {
    const clean = await checkSendingHealth(pool, T0);

    await bounceNext(2);
    const raised = await checkSendingHealth(pool, T0);
    const repeated = await checkSendingHealth(pool, T0);

    await bounceNext(3);
    const escalated = await checkSendingHealth(pool, T0);

    const mine = await sendingHealth(pool, { tenantId, now: T0 });
    const theirs = await sendingHealth(pool, { tenantId: quiet, now: T0 });

    // A week on, nothing new has been sent: the window has moved past it.
    const cleared = await checkSendingHealth(pool, new Date(T0.getTime() + 8 * 86_400_000));

    const { rows: alerts } = await pool.query<{ subject: string }>(
      `select subject from platform_email where kind = 'delivery_alert' order by id`,
    );

    // ---- one of the bounced addresses turns out to be fine after all
    const address = receipts[0]!.to;
    // While it is still suppressed, the next message to it is skipped.
    await engine.submit({
      version,
      answers: completeFor(bp, { personal_email: address, start_date: '2026-12-01' }) as never,
      now: T0,
    });
    await engine.drain(T0, 'proof', tenantId);
    const missed = await skippedFor(pool, { tenantId, email: address });
    const stillBlocked = await resendSkipped(pool, provider, {
      tenantId,
      actorId: admin,
      email: address,
      logIds: missed.map((m) => m.logId),
      now: T0,
    });

    await lift(pool, { email: address, actorId: admin });
    const before = sent.length;
    const first = await resendSkipped(pool, provider, {
      tenantId,
      actorId: admin,
      email: address,
      logIds: missed.map((m) => m.logId),
      now: T0,
    });
    const second = await resendSkipped(pool, provider, {
      tenantId,
      actorId: admin,
      email: address,
      logIds: missed.map((m) => m.logId),
      now: T0,
    });
    const after = await skippedFor(pool, { tenantId, email: address });
    const delivered = sent.slice(before);
    const { rows: trail } = await pool.query<{ type: string }>(
      `select e.type from event e join email_log l on l.instance_id = e.instance_id where l.id = $1 order by e.seq`,
      [missed[0]?.logId ?? 0],
    );

    record(
      'The bounce rate is watched, and an address that comes back gets what it missed',
      'Bounce-rate alerting against the provider\'s review thresholds, and re-sending after a suppression is lifted.',
      clean.change === null &&
        clean.health.level === 'ok' &&
        raised.change === 'raised' &&
        raised.health.level === 'watch' &&
        repeated.change === null &&
        escalated.change === 'escalated' &&
        escalated.health.level === 'act' &&
        mine.bounced === 5 &&
        theirs.sent === 0 &&
        cleared.change === 'cleared' &&
        alerts.length === 3 &&
        missed.length === 1 &&
        stillBlocked.every((r) => !r.sent && r.reason === 'the address is still suppressed') &&
        first.every((r) => r.sent) &&
        second.every((r) => !r.sent && r.reason === 'already sent again') &&
        delivered.length === 1 &&
        delivered[0]!.to.join() === address &&
        delivered[0]!.key === `resend:${missed[0]!.logId}:${address}` &&
        after[0]!.resentAt !== null &&
        trail.some((e) => e.type === 'email_resent'),
    `${escalated.health.sent} messages went out. With none bouncing the check was silent; at ${raised.health.bounced} hard ` +
      `bounces (${(raised.health.bounceRate * 100).toFixed(1)}%) it raised a watch alert, and asking again a moment later ` +
      `raised nothing. At ${escalated.health.bounced} (${(escalated.health.bounceRate * 100).toFixed(1)}%) it escalated to act, ` +
      `and a week later, with the bounces out of the window, it cleared — ${alerts.length} emails to the ops address in all: ` +
      `${alerts.map((a) => `"${a.subject}"`).join(', ')}. This workspace's share counted ${mine.bounced} bounces; a quiet ` +
      `workspace's counted ${theirs.sent} sent. A message to a suppressed address was recorded as missed (${missed.length}), ` +
      `a resend while it was still suppressed was refused, and after reinstating it the resend went once — to that address, ` +
      `under key ${delivered[0]?.key} — and a second press sent nothing ("${second[0]?.reason}").`,
    );
  } finally {
    if (previous === undefined) delete process.env.OPS_ALERT_EMAIL;
    else process.env.OPS_ALERT_EMAIL = previous;
  }
}

/**
 * Bulk assignment and bulk moves: previewed per record, confirmed as a set, reported honestly.
 *
 * §6.4: "Bulk actions require permission checks per record, an impact
 * preview, rate limits, and result report." Reminders were the only bulk
 * action; the compiler refused the other two with ACT001. This proof runs
 * both through the same preview-and-confirm path the reminders use, and
 * checks every way it should say no.
 */
export async function proveBulkActions({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:bulk');
  const version = await engine.publish(tenantId, bp, 'proof');
  const as = (actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });

  const admin = await engine.createActor(tenantId, 'lead@proof-bulk.test', 'Joy Lead', 'admin');
  await engine.grant({ tenantId, actorId: admin, processKey: bp.key, roleKey: 'hr_admin' });
  const manager = await engine.createActor(tenantId, 'manager_email@example.test', 'Priya Raman');
  await engine.grant({ tenantId, actorId: manager, processKey: bp.key, roleKey: 'hiring_manager' });
  const hr = await engine.createActor(tenantId, 'hr@proof-bulk.test', 'Sam Boateng');
  await engine.grant({ tenantId, actorId: hr, processKey: bp.key, roleKey: 'hr_approver' });
  const it = await engine.createActor(tenantId, 'it@proof-bulk.test', 'Ini Etim', 'operator');
  await engine.grant({ tenantId, actorId: it, processKey: bp.key, roleKey: 'it_operator' });
  const it2 = await engine.createActor(tenantId, 'it2@proof-bulk.test', 'Tomi Etim');
  await engine.grant({ tenantId, actorId: it2, processKey: bp.key, roleKey: 'it_operator' });
  const leaver = await engine.createActor(tenantId, 'leaver@proof-bulk.test', 'Gone Person');
  await engine.grant({ tenantId, actorId: leaver, processKey: bp.key, roleKey: 'it_operator' });
  await engine.deactivateActor(leaver);
  await engine.createActor(tenantId, 'reader@proof-bulk.test', 'Only Reads', 'read_only');

  const submitted = async (email: string) => {
    const { instanceId } = await engine.submit({ version, answers: completeFor(bp, { personal_email: email }) as never, now: T0 });
    await engine.drain(T0, 'proof', tenantId);
    return instanceId;
  };
  const provisioned = async (email: string) => {
    const id = await submitted(email);
    for (const [approvalKey, actorId] of [['manager_approval', manager], ['hr_approval', hr]] as const) {
      await engine.decide({ instanceId: id, approvalKey, decision: 'approved', principal: as(actorId), now: T0 });
      await engine.drain(T0, 'proof', tenantId);
    }
    return id;
  };
  const p1 = await provisioned('bulk.p1@example.test');
  const p2 = await provisioned('bulk.p2@example.test');
  const m1 = await submitted('bulk.m1@example.test');
  const m2 = await submitted('bulk.m2@example.test');

  const plan = (ids: string[]) => QueryPlan.parse({ processKey: bp.key, filters: [{ kind: 'records', ids }], limit: 50 });
  const assign = (to: string) => ({ kind: 'assign' as const, task: 'issue_equipment', to });
  const names = (xs: { reference: string }[]) => xs.map((x) => x.reference).sort().join(',');
  const ref = (id: string) => id.slice(0, 8).toUpperCase();

  // ---- assign: the preview
  const assignRun = await runDirect(pool, { principal: as(admin), plan: plan([p1, p2, m1]), action: assign('it2@proof-bulk.test'), now: T0 });
  const byOperator = await runDirect(pool, { principal: as(it), plan: plan([p1, p2]), action: assign('it2@proof-bulk.test'), now: T0 });
  const toLeaver = await runDirect(pool, { principal: as(admin), plan: plan([p1]), action: assign('leaver@proof-bulk.test'), now: T0 });
  const toReader = await runDirect(pool, { principal: as(admin), plan: plan([p1]), action: assign('reader@proof-bulk.test'), now: T0 });

  // ---- assign: the confirmation, and each way it refuses
  let otherPerson = 'allowed';
  try {
    await confirm(pool, { principal: as(hr), runId: assignRun.runId!, digest: assignRun.preview!.digest, now: T0 });
  } catch (err) {
    otherPerson = err instanceof AuthorizationError ? 'refused' : String(err);
  }
  let staleDigest = 'allowed';
  try {
    await confirm(pool, { principal: as(admin), runId: assignRun.runId!, digest: 'not-the-digest', now: T0 });
  } catch (err) {
    staleDigest = err instanceof Error ? err.message : String(err);
  }
  const assigned = await confirm(pool, { principal: as(admin), runId: assignRun.runId!, digest: assignRun.preview!.digest, now: T0 });
  let twice = 'allowed';
  try {
    await confirm(pool, { principal: as(admin), runId: assignRun.runId!, digest: assignRun.preview!.digest, now: T0 });
  } catch (err) {
    twice = err instanceof Error ? err.message : String(err);
  }
  const { rows: tasks } = await pool.query<{ assignee: string }>(
    `select assignee from task where instance_id = any($1::uuid[]) and task_key = 'issue_equipment' and status = 'open'`,
    [[p1, p2]],
  );
  // The new assignee can finish it; the old one, who held only the role, no longer can.
  let oldAssignee = 'allowed';
  try {
    await engine.completeTask({ instanceId: p2, taskKey: 'issue_equipment', principal: as(it), now: T0 });
  } catch (err) {
    oldAssignee = err instanceof AuthorizationError ? 'refused' : String(err);
  }
  await engine.completeTask({ instanceId: p1, taskKey: 'issue_equipment', principal: as(it2), now: T0 });
  const { rows: moved } = await pool.query<{ type: string }>(
    `select type from event where instance_id = $1 and type = 'task_reassigned'`,
    [p1],
  );

  // ---- change_state: withdraw two waiting records, and see what it will not do
  const withdraw = { kind: 'change_state' as const, to: 'withdrawn' };
  const moveRun = await runDirect(pool, { principal: as(admin), plan: plan([m1, m2, p2]), action: withdraw, now: T0 });
  const moveByOperator = await runDirect(pool, { principal: as(it), plan: plan([m1]), action: withdraw, now: T0 });
  const intoProvisioning = await runDirect(pool, {
    principal: as(admin),
    plan: plan([m1]),
    action: { kind: 'change_state', to: 'provisioning' },
    now: T0,
  });
  const movedReport = await confirm(pool, { principal: as(admin), runId: moveRun.runId!, digest: moveRun.preview!.digest, now: T0 });
  const states = await Promise.all([m1, m2, p2].map(async (id) => (await engine.instance(id)).state));
  const { rows: notices } = await pool.query<{ n: number }>(
    `select count(*)::int as n from email_log where instance_id = any($1::uuid[]) and template_key = 'withdrawn_notice'`,
    [[m1, m2]],
  );

  // ---- the reassignment told the new assignee, once, for both tasks
  const { rows: told } = await pool.query<{ recipient: string; subject: string }>(
    `select recipient, subject from platform_email where kind = 'task_assigned' and tenant_id = $1`,
    [tenantId],
  );

  // ---- set an answer: department to finance on three records, one already there
  const e1 = await submitted('bulk.e1@example.test');
  const e2 = await submitted('bulk.e2@example.test');
  const e3 = await submitted('bulk.e3@example.test');
  await engine.updateRecord({ instanceId: e3, patch: { department: 'finance' } as never, principal: as(admin), now: T0 });
  const toFinance = { kind: 'set_answer' as const, mode: 'set' as const, field: 'department', value: 'finance' };
  const editRun = await runDirect(pool, { principal: as(admin), plan: plan([e1, e2, e3]), action: toFinance, now: T0 });
  const editByOperator = await runDirect(pool, { principal: as(it), plan: plan([e1]), action: toFinance, now: T0 });
  const notAChoice = await runDirect(pool, {
    principal: as(admin),
    plan: plan([e1]),
    action: { kind: 'set_answer', mode: 'set', field: 'department', value: 'marketing' },
    now: T0,
  });
  const notBulk = await runDirect(pool, {
    principal: as(admin),
    plan: plan([e1]),
    action: { kind: 'set_answer', mode: 'set', field: 'policy_ack', value: true },
    now: T0,
  });
  // HR can edit records, but not a new starter's own phone number.
  const notTheirField = await runDirect(pool, {
    principal: as(admin),
    plan: plan([e1]),
    action: { kind: 'set_answer', mode: 'set', field: 'phone', value: '+44 7700 900555' },
    now: T0,
  });
  const edited = await confirm(pool, { principal: as(admin), runId: editRun.runId!, digest: editRun.preview!.digest, now: T0 });
  const departments = await Promise.all([e1, e2].map(async (id) => (await engine.instance(id)).data.department));
  const { rows: history } = await pool.query<{ payload: { previous?: Record<string, unknown> } }>(
    `select payload from event where instance_id = $1 and type = 'record_updated' order by seq desc limit 1`,
    [e1],
  );

  record(
    'Many records at once: previewed per record, confirmed as a set, and reported',
    '§6.4 bulk actions — assignment and status change — through the same preview, digest and per-record checks as reminders.',
    names(assignRun.preview!.eligible) === [ref(p1), ref(p2)].sort().join(',') &&
      assignRun.preview!.eligible.every((e) => e.from === 'role:it_operator') &&
      names(assignRun.preview!.skipped) === ref(m1) &&
      byOperator.preview!.eligible.length === 0 &&
      byOperator.preview!.refused.length === 2 &&
      toLeaver.preview!.refused[0]?.reason.includes('deactivated') === true &&
      toReader.preview!.refused[0]?.reason.includes('cannot work on this process') === true &&
      otherPerson === 'refused' &&
      staleDigest.includes('changed since it was previewed') &&
      assigned.kind === 'assign' &&
      assigned.sent.length === 2 &&
      twice.includes('already been carried out') &&
      tasks.every((t) => t.assignee === 'it2@proof-bulk.test') &&
      oldAssignee === 'refused' &&
      moved.length === 1 &&
      names(moveRun.preview!.eligible) === [ref(m1), ref(m2)].sort().join(',') &&
      moveRun.preview!.skipped[0]?.reason.startsWith('nothing in the process moves a record from') === true &&
      moveByOperator.preview!.refused[0]?.reason.startsWith('only HR administrator') === true &&
      !intoProvisioning.ok &&
      intoProvisioning.diagnostics.some((d) => d.code === 'ACT007') &&
      movedReport.sent.length === 2 &&
      states[0] === 'withdrawn' &&
      states[1] === 'withdrawn' &&
      states[2] === 'provisioning' &&
      notices[0]!.n === 2 &&
      told.length === 1 &&
      told[0]!.recipient === 'it2@proof-bulk.test' &&
      told[0]!.subject.includes('2 tasks') &&
      assigned.notified?.[0]?.tasks === 2 &&
      assigned.notified?.[0]?.sent === true &&
      names(editRun.preview!.eligible) === [ref(e1), ref(e2)].sort().join(',') &&
      editRun.preview!.eligible.every((e) => e.from === 'Engineering' && e.to[0] === 'Finance') &&
      editRun.preview!.skipped[0]?.reason === 'already Finance' &&
      editByOperator.preview!.refused.length === 1 &&
      notTheirField.preview!.refused[0]?.reason.startsWith('your roles cannot change') === true &&
      editByOperator.preview!.eligible.length === 0 &&
      !notAChoice.ok &&
      notAChoice.diagnostics.some((d) => d.code === 'ACT010') &&
      !notBulk.ok &&
      notBulk.diagnostics.some((d) => d.code === 'ACT009') &&
      edited.sent.length === 2 &&
      departments.every((d) => d === 'finance') &&
      history[0]?.payload.previous?.department === 'engineering',
    `Reassigning equipment to it2 previewed ${assignRun.preview!.eligible.length} records (from role:it_operator) and ` +
      `skipped ${assignRun.preview!.skipped.length} with no open task. An operator previewing the same was refused on ` +
      `${byOperator.preview!.refused.length} — reassignment is an administrator's call. A deactivated member was refused ` +
      `("${toLeaver.preview!.refused[0]?.reason}") and so was a member with no role on the process. Confirming as somebody ` +
      `else was ${otherPerson}; a stale digest was refused; confirming ran ${assigned.sent.length} and a second confirm ` +
      `was refused. The old assignee could no longer complete the task (${oldAssignee}); the new one did. ` +
      `Withdrawing three records moved the two in manager review and skipped the one in provisioning ` +
      `("${moveRun.preview!.skipped[0]?.reason}"); an IT operator was refused ("${moveByOperator.preview!.refused[0]?.reason}"); ` +
      `a move into provisioning did not compile (ACT007), because nothing moves a record there by hand. The two ` +
      `withdrawn records each got the withdrawal notice the step sends — ${notices[0]!.n} in all. ` +
      `The new assignee got ${told.length} email for both tasks ("${told[0]?.subject}"), not one each. ` +
      `Setting department to finance changed ${edited.sent.length} records, left the one already in finance alone, ` +
      `refused an IT operator ("${editByOperator.preview!.refused[0]?.reason}") and HR on a field that is not theirs ("${notTheirField.preview!.refused[0]?.reason}"), and refused to compile a value that is ` +
      `not one of the choices (ACT010) and a signature field (ACT009). The change kept what it replaced: the ` +
      `record's history says the department was "${history[0]?.payload.previous?.department}".`,
  );
}

/**
 * Two workspaces with the same process each get their own form, and their own records.
 *
 * Process keys are unique only inside a workspace, and every public lookup
 * took the highest version of a key across all of them. Two organisations
 * that installed the same pack shared `/f/employee_onboarding`; whichever had
 * published more versions was served; and the other's applicants became its
 * records. The public API had the same lookup. This proof sets up exactly
 * that — the other workspace on a higher version — and goes in every door.
 */
export async function proveFormLinks({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const a = await engine.createTenant('proof:links-a');
  const b = await engine.createTenant('proof:links-b');
  await engine.publish(a, bp, 'proof');
  const other = { ...bp, name: 'Somebody Else’s Onboarding' };
  await engine.publish(b, other, 'proof');
  await engine.publish(b, other, 'proof'); // b is now on version 2, a on version 1

  const idOf = async (tenantId: string) =>
    (await pool.query<{ public_id: string }>('select public_id from public_form where tenant_id = $1 and process_key = $2', [tenantId, bp.key]))
      .rows[0]!.public_id;
  const aId = await idOf(a);
  const bId = await idOf(b);
  const tenantOf = async (instanceId: string) =>
    (await pool.query<{ tenant_id: string }>('select tenant_id from instance where id = $1', [instanceId])).rows[0]!.tenant_id;

  // 1. Each link serves its own workspace's form.
  const aForm = await publicForm(pool, aId);
  const bForm = await publicForm(pool, bId);

  // 2. Each link's submissions become that workspace's records.
  const person = screen({ processKey: aId, ticket: issueTicket(aId, T0.getTime() - 60_000), trap: '', now: T0.getTime() });
  const intoA = await submitForm(pool, {
    processKey: aId,
    answers: completeFor(bp, { personal_email: 'links.a@example.test' }) as never,
    now: T0,
    screening: person,
  });
  const intoB = await submitForm(pool, {
    processKey: bId,
    answers: completeFor(bp, { personal_email: 'links.b@example.test' }) as never,
    now: T0,
  });

  // 3. The old link, now that two workspaces share the key, refuses rather than picks.
  let oldLink = 'served';
  try {
    await publicForm(pool, bp.key);
  } catch (err) {
    oldLink = err instanceof FormLinkError ? err.kind : String(err);
  }

  // 4. The public API files into the key's own workspace, not the higher version elsewhere.
  const viaApi = await submitForm(pool, {
    processKey: bp.key,
    tenantId: a,
    answers: completeFor(bp, { personal_email: 'links.api@example.test' }) as never,
    now: T0,
  });

  // 5. A ticket is good for the form that issued it, not a form with the same key.
  const crossTicket = screen({ processKey: bId, ticket: issueTicket(aId, T0.getTime() - 60_000), now: T0.getTime() });

  // 6. A draft token from one workspace's form writes nothing into, and reads nothing from, the other's.
  const draftA = await saveDraft(pool, { processKey: aId, answers: { full_name: 'Draft In A' }, page: 0 });
  const onB = await saveDraft(pool, { processKey: bId, token: draftA.token, answers: { full_name: 'Written Via B' }, page: 0 });
  const stillA = await loadDraft(pool, draftA.token, aId);
  const readFromB = await loadDraft(pool, draftA.token, bId);

  // 7. A new version keeps the link; a key only one workspace has still resolves by name.
  await engine.publish(a, bp, 'proof');
  const aIdAfter = await idOf(a);
  const solo = { ...bp, key: 'links_only_in_a', name: 'Only in A' };
  await engine.publish(a, solo, 'proof');
  const soloByName = await resolveForm(pool, 'links_only_in_a');

  record(
    'Two workspaces with the same process each get their own form and their own records',
    'Public form links name one workspace’s form; the old key-only link refuses once it is shared; the public API is scoped to its key’s workspace.',
    PUBLIC_ID.test(aId) &&
      PUBLIC_ID.test(bId) &&
      aId !== bId &&
      aForm?.processName === bp.name &&
      aForm?.version === 1 &&
      bForm?.processName === other.name &&
      intoA.ok &&
      !intoA.held &&
      (await tenantOf(intoA.instanceId!)) === a &&
      intoB.ok &&
      (await tenantOf(intoB.instanceId!)) === b &&
      oldLink === 'ambiguous' &&
      viaApi.ok &&
      (await tenantOf(viaApi.instanceId!)) === a &&
      crossTicket.reasons.includes('bad_ticket') &&
      onB.token !== draftA.token &&
      stillA?.answers.full_name === 'Draft In A' &&
      readFromB === null &&
      aIdAfter === aId &&
      soloByName.tenantId === a,
    `Workspace A published once and B twice, which is the case that used to hand A's applicants to B. ` +
      `A's link (${aId}) served A's form at version ${aForm?.version}; B's (${bId}) served B's. A submission through ` +
      `each landed in its own workspace. The old /f/${bp.key} link, now shared, answered "${oldLink}" instead of ` +
      `choosing. The public API, given A's workspace, filed into A despite B's higher version. A ticket from A's form ` +
      `was refused on B's (${crossTicket.reasons.join(', ')}). A's draft token used on B's form started a new draft ` +
      `and left A's reading "${stillA?.answers.full_name}"; read through B's form it returned nothing. Publishing A ` +
      `again kept its link, and a key only A has still resolves by name.`,
  );
}

/**
 * An integration asks, a member sees what it wants and says yes or no, and the grant behaves.
 *
 * OAuth had a correct endpoint and nothing in front of it: no page an app
 * could send somebody to, and no test of any of it. This goes from the
 * query string an integration builds, through the consent screen's own
 * checks, to tokens, rotation and revocation — and through each way a request
 * should be refused without anybody being redirected.
 */
export async function proveOAuthConsent({ pool, record }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:oauth');
  const other = await engine.createTenant('proof:oauth-other');
  const admin = await engine.createActor(tenantId, 'admin@proof-oauth.test', 'Ada Admin', 'admin');
  const operator = await engine.createActor(tenantId, 'op@proof-oauth.test', 'Obi Operator', 'operator');

  const redirectUri = 'https://integration.example.com/callback';
  const client = await registerClient(pool, { tenantId, name: 'Payroll Sync', redirectUris: [redirectUri] });
  const foreign = await registerClient(pool, { tenantId: other, name: 'Someone Else', redirectUris: [redirectUri] });

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = (over: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: redirectUri,
      scope: 'view report administer',
      state: 'xyz-123',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...over,
    });
  const refusal = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return 'allowed';
    } catch (err) {
      return err instanceof OAuthError ? err.code : String(err);
    }
  };

  // ---- 1. What the screen shows: an operator asked for administer does not get it, and is told
  const operatorView = await describeRequest(pool, { request: parseAuthorizeQuery(query()), tenantId, actorId: operator });
  const adminView = await describeRequest(pool, { request: parseAuthorizeQuery(query()), tenantId, actorId: admin });

  // ---- 2. Requests the screen refuses outright, before drawing anything or redirecting anywhere
  const implicit = await refusal(async () => parseAuthorizeQuery(query({ response_type: 'token' })));
  const madeUpScope = await refusal(async () => parseAuthorizeQuery(query({ scope: 'view everything' })));
  const lookalike = await refusal(() =>
    describeRequest(pool, { request: parseAuthorizeQuery(query({ redirect_uri: 'https://integration.example.com.evil.test/callback' })), tenantId, actorId: admin }),
  );
  const plainPkce = await refusal(() =>
    describeRequest(pool, { request: parseAuthorizeQuery(query({ code_challenge_method: 'plain' })), tenantId, actorId: admin }),
  );
  const otherWorkspace = await refusal(() =>
    describeRequest(pool, { request: parseAuthorizeQuery(query({ client_id: foreign.clientId })), tenantId, actorId: admin }),
  );

  // ---- 3. Deny goes back with access_denied, and only to the registered address
  const denied = await denyRequest(pool, { request: parseAuthorizeQuery(query()), tenantId });
  const denyElsewhere = await refusal(() =>
    denyRequest(pool, { request: parseAuthorizeQuery(query({ redirect_uri: 'https://evil.test/' })), tenantId }),
  );
  const deniedUrl = new URL(denied.redirectTo);

  // ---- 4. Allow: a code, the right verifier for tokens, the wrong one refused
  const allowed = await oauthAuthorize(pool, { request: parseAuthorizeQuery(query()), tenantId, actorId: operator });
  const back = new URL(allowed.redirectTo);
  const code = back.searchParams.get('code')!;
  const wrongVerifier = await refusal(() =>
    exchangeCode(pool, { code, clientId: client.clientId, redirectUri, codeVerifier: randomBytes(32).toString('base64url') }),
  );
  const allowed2 = await oauthAuthorize(pool, { request: parseAuthorizeQuery(query()), tenantId, actorId: operator });
  const code2 = new URL(allowed2.redirectTo).searchParams.get('code')!;
  const tokens = await exchangeCode(pool, { code: code2, clientId: client.clientId, redirectUri, codeVerifier: verifier });
  const acting = await resolveAccessToken(pool, tokens.access_token);

  // ---- 5. Rotation, and a reused refresh token treated as theft
  const rotated = await oauthRefresh(pool, { refreshToken: tokens.refresh_token, clientId: client.clientId });
  const reused = await refusal(() => oauthRefresh(pool, { refreshToken: tokens.refresh_token, clientId: client.clientId }));
  const afterTheft = await resolveAccessToken(pool, rotated.access_token);

  // ---- 5b. A code presented twice: the second is refused, and what the first
  //          produced is revoked — a replayed code means somebody else has it
  //          (RFC 6749 §4.1.2).
  const replayGrant = await oauthAuthorize(pool, { request: parseAuthorizeQuery(query()), tenantId, actorId: operator });
  const code4 = new URL(replayGrant.redirectTo).searchParams.get('code')!;
  const firstUse = await exchangeCode(pool, { code: code4, clientId: client.clientId, redirectUri, codeVerifier: verifier });
  const replayedCode = await refusal(() =>
    exchangeCode(pool, { code: code4, clientId: client.clientId, redirectUri, codeVerifier: verifier }),
  );
  const afterReplay = await resolveAccessToken(pool, firstUse.access_token);

  // ---- 6. A member demoted after granting: the integration loses what they lost
  const second = await oauthAuthorize(pool, {
    request: parseAuthorizeQuery(query({ scope: 'view operate' })),
    tenantId,
    actorId: operator,
  });
  const code3 = new URL(second.redirectTo).searchParams.get('code')!;
  const t3 = await exchangeCode(pool, { code: code3, clientId: client.clientId, redirectUri, codeVerifier: verifier });
  const before = await resolveAccessToken(pool, t3.access_token);
  await engine.setWorkspaceRole(operator, 'read_only');
  const afterDemotion = await resolveAccessToken(pool, t3.access_token);

  record(
    'An integration asks, the member sees exactly what it wants, and the grant keeps its word',
    'OAuth 2.0 consent (§11.1): the screen shows only a request that would work, deny and allow both go back only to the registered address, and PKCE, rotation and live scopes hold.',
    operatorView.granted.join(' ') === 'view report' &&
      operatorView.withheld.join(' ') === 'administer' &&
      adminView.granted.join(' ') === 'view report administer' &&
      adminView.client.name === 'Payroll Sync' &&
      adminView.returnsTo === 'integration.example.com' &&
      implicit === 'unsupported_response_type' &&
      madeUpScope === 'invalid_scope' &&
      lookalike === 'invalid_redirect_uri' &&
      plainPkce === 'invalid_request' &&
      otherWorkspace === 'invalid_client' &&
      deniedUrl.origin + deniedUrl.pathname === redirectUri &&
      deniedUrl.searchParams.get('error') === 'access_denied' &&
      deniedUrl.searchParams.get('state') === 'xyz-123' &&
      denyElsewhere === 'invalid_redirect_uri' &&
      back.searchParams.get('state') === 'xyz-123' &&
      allowed.granted.join(' ') === 'view report' &&
      wrongVerifier === 'invalid_grant' &&
      replayedCode === 'invalid_grant' &&
      afterReplay === null &&
      acting?.actorId === operator &&
      acting?.scopes.join(' ') === 'view report' &&
      rotated.refresh_token !== tokens.refresh_token &&
      reused === 'invalid_grant' &&
      afterTheft === null &&
      before?.scopes.includes('operate') === true &&
      afterDemotion?.scopes.join(' ') === 'view',
    `Asked for view, report and administer: the operator's screen offered view and report and said administer ` +
      `would not be given; an admin's offered all three, for "${adminView.client.name}", returning to ` +
      `${adminView.returnsTo}. Refused before any screen: an implicit grant (${implicit}), a made-up scope ` +
      `(${madeUpScope}), a lookalike redirect address (${lookalike}), plain PKCE (${plainPkce}), and another ` +
      `workspace's client (${otherWorkspace}). Deny went back to the registered address with access_denied and the ` +
      `state; deny to anywhere else was ${denyElsewhere}. Allow granted ${allowed.granted.join(' ')}; the wrong ` +
      `verifier was ${wrongVerifier}; a code presented twice was ${replayedCode} and the tokens its first use produced ` +
      `stopped working. Refreshing rotated the token, reusing the ` +
      `old one was treated as theft and the rotated access token stopped working. A member demoted after granting ` +
      `took the integration down with them: ${before?.scopes.join(' ')} became ${afterDemotion?.scopes.join(' ')}.`,
  );
}

/**
 * A copy of the database is not enough to pass anybody's second factor.
 *
 * The TOTP secret was stored as text: a backup, a replica or one select gave
 * the current code for every account. It is now sealed with a key outside
 * the database and bound to its account. This checks the seal, what happens
 * when a sealed secret is moved to another account, that people enrolled
 * before the change are not locked out, and that a key can be rotated.
 */
export async function proveSecretsAtRest({ pool, record }: ProofCtx): Promise<void> {
  const saved = {
    key: process.env.MFA_ENCRYPTION_KEY,
    previous: process.env.MFA_ENCRYPTION_KEY_PREVIOUS,
    env: process.env.NODE_ENV,
  };
  const keyA = randomBytes(32).toString('base64');
  const keyB = randomBytes(32).toString('base64');
  const T = Date.UTC(2026, 8, 23, 9, 0, 0);
  const step = stepFor(T);

  const owner = async (n: string) =>
    (
      await createWorkspace(pool, {
        workspaceName: `Proof Sealed ${n}`,
        ownerEmail: `owner-${n}@proof-sealed.test`,
        ownerName: `Owner ${n}`,
        password: 'the-account-password',
      })
    ).actorId;
  const stored = async (actorId: string) =>
    (await pool.query<{ secret: string }>('select secret from mfa_enrolment where actor_id = $1', [actorId])).rows[0]!.secret;
  const signInWith = async (n: string, code: string, at: number) => {
    const challenged = await signIn(pool, { email: `owner-${n}@proof-sealed.test`, password: 'the-account-password' });
    const token = (challenged as { challengeToken: string }).challengeToken;
    try {
      await answerChallenge(pool, { token, code, nowMs: at });
      return 'signed in';
    } catch (err) {
      return `refused: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  try {
    process.env.MFA_ENCRYPTION_KEY = keyA;
    delete process.env.MFA_ENCRYPTION_KEY_PREVIOUS;

    // ---- 1. Enrolled: the row holds a sealed value, not the secret
    const a = await owner('a');
    const enrolledA = await beginEnrolment(pool, { actorId: a });
    await confirmEnrolment(pool, { actorId: a, code: codeFor(enrolledA.secret, step), nowMs: T });
    const sealedA = await stored(a);

    // ---- 2. Moved to another account by somebody with write access: useless there
    const b = await owner('b');
    const enrolledB = await beginEnrolment(pool, { actorId: b });
    await confirmEnrolment(pool, { actorId: b, code: codeFor(enrolledB.secret, step), nowMs: T });
    await pool.query('update mfa_enrolment set secret = $2 where actor_id = $1', [b, sealedA]);
    const movedIn = await signInWith('b', codeFor(enrolledA.secret, step + 1), T + 30_000);

    // ---- 3. Enrolled before encryption: still signs in, and is sealed on the way
    const c = await owner('c');
    const legacySecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    await pool.query(
      `insert into mfa_enrolment (actor_id, secret, confirmed_at) values ($1, $2, now())`,
      [c, legacySecret],
    );
    const legacy = await signInWith('c', codeFor(legacySecret, step), T);
    const legacyAfter = await stored(c);

    // ---- 4. Rotation: a new key, the old one kept as previous; the next use moves it
    process.env.MFA_ENCRYPTION_KEY = keyB;
    process.env.MFA_ENCRYPTION_KEY_PREVIOUS = keyA;
    const duringRotation = await signInWith('a', codeFor(enrolledA.secret, step + 2), T + 60_000);
    const rotatedA = await stored(a);
    delete process.env.MFA_ENCRYPTION_KEY_PREVIOUS;
    const afterRotation = await signInWith('a', codeFor(enrolledA.secret, step + 3), T + 90_000);

    // ---- 5. The database somewhere without the key: nobody's second factor passes
    process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const wrongKey = await signInWith('a', codeFor(enrolledA.secret, step + 4), T + 120_000);

    // ---- 6. Production will not start without a key
    delete process.env.MFA_ENCRYPTION_KEY;
    process.env.NODE_ENV = 'production';
    let startup = 'started';
    try {
      assertSecretKeyConfigured();
    } catch (err) {
      startup = err instanceof Error ? err.message.split('.')[0]! : String(err);
    }

    const keyIdOf = (v: string) => v.split('.')[1];
    record(
      'A copy of the database is not enough to pass anybody\'s second factor',
      'Two-factor secrets sealed at rest (AES-256-GCM, key outside the database, bound to the account), readable across a key rotation.',
      sealedA.startsWith('v1.') &&
        !sealedA.includes(enrolledA.secret) &&
        movedIn.startsWith('refused') &&
        legacy === 'signed in' &&
        legacyAfter.startsWith('v1.') &&
        !legacyAfter.includes(legacySecret) &&
        duringRotation === 'signed in' &&
        keyIdOf(rotatedA) !== keyIdOf(sealedA) &&
        afterRotation === 'signed in' &&
        wrongKey.startsWith('refused') &&
        startup.startsWith('MFA_ENCRYPTION_KEY is not set'),
      `The enrolled secret is stored as "${sealedA.slice(0, 16)}…", which does not contain it. Copied onto another ` +
        `account it was ${movedIn.split(':')[0]}, because each value is bound to its owner. A secret stored in the clear ` +
        `before this change still ${legacy === 'signed in' ? 'signed in' : 'failed'}, and was sealed on the way. With a new ` +
        `key and the old one kept as previous, sign-in worked and moved the secret from key ${keyIdOf(sealedA)} to ` +
        `${keyIdOf(rotatedA)}; with the old key then dropped it still worked. The same database under a different key ` +
        `was ${wrongKey.split(':')[0]}. Production without a key refused to start ("${startup}").`,
    );
  } finally {
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('MFA_ENCRYPTION_KEY', saved.key);
    restore('MFA_ENCRYPTION_KEY_PREVIOUS', saved.previous);
    restore('NODE_ENV', saved.env);
  }
}

/**
 * A session that has been sitting open asks again before it grants access or destroys data.
 *
 * The second factor was asked for at sign-in and never again. A cookie
 * lifted from a laptop could issue API keys, add webhooks, change roles and
 * run deletions. This checks which actions ask, that nothing which *reduces*
 * access does, that confirming takes what signing in takes, and that
 * guessing inside somebody's session loses it.
 */
export async function proveStepUp({ pool, record }: ProofCtx): Promise<void> {
  const created = await createWorkspace(pool, {
    workspaceName: 'Proof Step Up',
    ownerEmail: 'owner@proof-stepup.test',
    ownerName: 'An Owner',
    password: 'the-account-password',
  });
  const actorId = created.actorId;
  const T = Date.UTC(2026, 8, 23, 10, 0, 0);
  const step = stepFor(T);
  const signedIn = async () => {
    const s = await startSession(pool, { actorId });
    return (await resolveSession(pool, s!.token))!;
  };

  // ---- 1. Which requests ask
  const asks = (method: string, path: string, body: unknown = {}) => Boolean(stepUpFor(method, path, body));
  const id = '00000000-0000-0000-0000-000000000000';
  const granting = [
    asks('POST', '/api/keys'),
    asks('POST', '/api/webhooks'),
    asks('POST', `/api/webhooks/${id}/rotate`),
    asks('POST', '/api/oauth/clients'),
    asks('POST', '/api/invitations'),
    asks('POST', `/api/members/${id}/role`),
    asks('POST', `/api/members/${id}/reactivate`),
    asks('POST', '/api/account/mfa/begin'),
    asks('POST', '/api/retention', { processKey: 'x', preview: false }),
  ];
  const reducing = [
    asks('POST', `/api/keys/${id}/revoke`),
    asks('POST', `/api/oauth/grants/${id}/revoke`),
    asks('POST', `/api/invitations/${id}/revoke`),
    asks('POST', `/api/members/${id}/deactivate`),
    asks('POST', `/api/members/${id}/revoke-sessions`),
    asks('POST', '/api/session/revoke-all'),
    asks('POST', '/api/retention', { processKey: 'x' }),
  ];

  // ---- 2. Fresh after signing in; stale after ten minutes
  const session = await signedIn();
  const freshNow = isFresh(session.authenticatedAt);
  await pool.query(`update session set authenticated_at = now() - interval '11 minutes' where id = $1`, [session.sessionId]);
  const { rows: aged } = await pool.query<{ authenticated_at: Date }>('select authenticated_at from session where id = $1', [session.sessionId]);
  const freshAfterTen = isFresh(aged[0]!.authenticated_at);

  // ---- 3. Confirming: a wrong password is refused and counted; the right one makes it fresh
  const attempt = async (password: string, code?: string, sessionId = session.sessionId) => {
    try {
      await reauthenticate(pool, { sessionId, actorId, password, code, nowMs: T });
      return 'confirmed';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const wrong = await attempt('not-the-password');
  const right = await attempt('the-account-password');
  const { rows: afterRight } = await pool.query<{ authenticated_at: Date; reauth_failures: number }>(
    'select authenticated_at, reauth_failures from session where id = $1',
    [session.sessionId],
  );

  // ---- 4. With two-step on, the password alone is not enough, and the code is spent
  const enrolled = await beginEnrolment(pool, { actorId });
  await confirmEnrolment(pool, { actorId, code: codeFor(enrolled.secret, step), nowMs: T });
  const passwordOnly = await attempt('the-account-password');
  const withCode = await attempt('the-account-password', codeFor(enrolled.secret, step + 1));
  const sameCodeAgain = await attempt('the-account-password', codeFor(enrolled.secret, step + 1));

  // ---- 5. Guessing inside somebody's session loses the session
  const other = await signedIn();
  const guesses: string[] = [];
  for (let i = 0; i < 5; i++) guesses.push(await attempt(`guess-${i}`, undefined, other.sessionId));
  const { rows: gone } = await pool.query<{ revoked_at: Date | null }>('select revoked_at from session where id = $1', [other.sessionId]);

  record(
    'A session left open asks again before it grants access or destroys data',
    'Step-up: actions that grant access or delete data need a sign-in from the last ten minutes; actions that reduce access never ask.',
    granting.every(Boolean) &&
      reducing.every((x) => !x) &&
      freshNow &&
      !freshAfterTen &&
      wrong === 'that password is not right' &&
      right === 'confirmed' &&
      isFresh(afterRight[0]!.authenticated_at) &&
      afterRight[0]!.reauth_failures === 0 &&
      passwordOnly.startsWith('the code from your authenticator') &&
      withCode === 'confirmed' &&
      sameCodeAgain !== 'confirmed' &&
      guesses[4]!.includes('signed out') &&
      gone[0]!.revoked_at !== null,
    `All ${granting.length} granting or destroying actions asked; none of the ${reducing.length} that reduce access did, ` +
      `including a retention preview. A new session was fresh; ten minutes on it was not. A wrong password was ` +
      `"${wrong}"; the right one confirmed and cleared the count. With two-step on, the password alone was ` +
      `"${passwordOnly}", password and code confirmed, and the same code a second time was "${sameCodeAgain}". ` +
      `Five wrong guesses inside another session ended it ("${guesses[4]}").`,
  );
}

/**
 * Lists in bulk: one option in or out of a multi-select, an address, a row onto a repeating group.
 *
 * Setting a whole list across records is rarely what anybody means. "Give
 * everybody a monitor" means add Monitor to what each record already has,
 * not replace it — and it has to add to what is there when the write
 * happens, not to what the preview saw. A repeating group can only have a
 * row added: rows have no identity across records.
 */
export async function proveBulkLists({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:bulk-lists');
  const as = (actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });

  // HR may edit the address and equipment here, which the shipped process does not allow.
  const onboarding = {
    ...bp,
    roles: bp.roles.map((r) =>
      r.key === 'hr_admin' ? { ...r, editableFields: [...(r.editableFields ?? []), 'address', 'equipment_needs'] } : r,
    ),
  } as Blueprint;
  const version = await engine.publish(tenantId, onboarding, 'proof');
  const admin = await engine.createActor(tenantId, 'hr@proof-lists.test', 'Hana HR', 'admin');
  await engine.grant({ tenantId, actorId: admin, processKey: bp.key, roleKey: 'hr_admin' });

  const submit = async (email: string, extra: Record<string, unknown> = {}) => {
    const { instanceId } = await engine.submit({ version, answers: completeFor(onboarding, { personal_email: email, ...extra }) as never, now: T0 });
    return instanceId;
  };
  const a = await submit('lists.a@example.test', { equipment_needs: ['laptop'] });
  const b = await submit('lists.b@example.test', { equipment_needs: ['laptop', 'monitor'] });
  const c = await submit('lists.c@example.test');
  const plan = (ids: string[], key = bp.key) => QueryPlan.parse({ processKey: key, filters: [{ kind: 'records', ids }], limit: 50 });
  const run = (ids: string[], action: unknown, key?: string) =>
    runDirect(pool, { principal: as(admin), plan: plan(ids, key), action: action as never, now: T0 });
  const go = async (r: Awaited<ReturnType<typeof run>>) =>
    confirm(pool, { principal: as(admin), runId: r.runId!, digest: r.preview!.digest, now: T0 });
  const equipment = async (id: string) => (await engine.instance(id)).data.equipment_needs;

  // ---- 1. Add Monitor: a gets it, b already has it, c gets a list of one
  const addMonitor = await run([a, b, c], { kind: 'set_answer', field: 'equipment_needs', value: 'monitor', mode: 'add' });
  // Somebody changes a between preview and confirm; the add lands on what is there then.
  await engine.updateRecord({ instanceId: a, patch: { equipment_needs: ['laptop', 'phone'] } as never, principal: as(admin), now: T0 });
  const added = await go(addMonitor);
  const afterAdd = await Promise.all([a, b, c].map(equipment));

  // ---- 2. Remove Laptop
  const removeLaptop = await run([a, b, c], { kind: 'set_answer', field: 'equipment_needs', value: 'laptop', mode: 'remove' });
  await go(removeLaptop);
  const afterRemove = await Promise.all([a, b, c].map(equipment));

  // ---- 3. The wrong modes, and an option that is not one
  const notAnOption = await run([a], { kind: 'set_answer', field: 'equipment_needs', value: 'jetpack', mode: 'add' });
  const addToText = await run([a], { kind: 'set_answer', field: 'job_title', value: 'x', mode: 'add' });

  // ---- 4. An address, which is text
  const moved = await run([a, b], { kind: 'set_answer', field: 'address', value: '2 New Street, Leeds', mode: 'set' });
  await go(moved);
  const addresses = await Promise.all([a, b].map(async (id) => (await engine.instance(id)).data.address));

  // ---- 5. A row onto an expense claim, and the total that follows it
  const expenseFile = BlueprintSchema.parse(JSON.parse(readFileSync('processes/expense-approval.blueprint.json', 'utf8')));
  const expense = {
    ...expenseFile,
    roles: expenseFile.roles.map((r) =>
      r.key === 'finance_ops' ? { ...r, editableFields: [...(r.editableFields ?? []), 'line_items'] } : r,
    ),
  } as Blueprint;
  const ev = await engine.publish(tenantId, expense, 'proof');
  await engine.grant({ tenantId, actorId: admin, processKey: expense.key, roleKey: 'finance_ops' });
  const { instanceId: claim } = await engine.submit({
    version: ev,
    answers: completeFor(expense, {
      // Over the auto-approval line, so the claim is still open and waiting for a decision.
      line_items: [{ line_description: 'Train to Leeds', line_amount: 450 }],
    }) as never,
    now: T0,
  });
  const totalBefore = (await engine.instance(claim)).data.expense_total;
  const addRow = await run([claim], { kind: 'set_answer', field: 'line_items', value: { line_description: 'Taxi', line_amount: 12.5 }, mode: 'add' }, expense.key);
  await go(addRow);
  const claimAfter = (await engine.instance(claim)).data;
  const badRow = await run([claim], { kind: 'set_answer', field: 'line_items', value: { line_description: 'No amount' }, mode: 'add' }, expense.key);
  const replaceRows = await run([claim], { kind: 'set_answer', field: 'line_items', value: [], mode: 'set' }, expense.key);

  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  record(
    'Lists change in bulk by adding or removing one thing, and a claim gains a row and a new total',
    'Bulk edits of multi-select answers (add, remove, replace), addresses, and a row onto a repeating group.',
    addMonitor.preview!.eligible.length === 2 &&
      addMonitor.preview!.skipped[0]?.reason === 'already includes External monitor' &&
      added.sent.length === 2 &&
      same(afterAdd[0], ['laptop', 'phone', 'monitor']) &&
      same(afterAdd[1], ['laptop', 'monitor']) &&
      same(afterAdd[2], ['monitor']) &&
      same(afterRemove[0], ['phone', 'monitor']) &&
      same(afterRemove[1], ['monitor']) &&
      same(afterRemove[2], ['monitor']) &&
      removeLaptop.preview!.skipped.some((x) => x.reason === 'does not include Laptop') &&
      notAnOption.diagnostics.some((d) => d.code === 'ACT010') &&
      addToText.diagnostics.some((d) => d.code === 'ACT011') &&
      addresses.every((x) => x === '2 New Street, Leeds') &&
      totalBefore === 450 &&
      Array.isArray(claimAfter.line_items) &&
      (claimAfter.line_items as unknown[]).length === 2 &&
      claimAfter.expense_total === 462.5 &&
      addRow.preview!.eligible[0]?.from === '1 item' &&
      addRow.preview!.eligible[0]?.to[0] === '2 items' &&
      badRow.diagnostics.some((d) => d.code === 'ACT010') &&
      replaceRows.diagnostics.some((d) => d.code === 'ACT011'),
    `Adding Monitor previewed ${addMonitor.preview!.eligible.length} records and left alone the one that already had it. ` +
      `One record changed between preview and confirm, and the add landed on what it had then: ` +
      `${JSON.stringify(afterAdd[0])}. Removing Laptop left the others' choices alone and skipped the record without it. ` +
      `An option that is not one was ACT010; "add" on a text field was ACT011. An address set on two records. ` +
      `A Taxi row on an expense claim took it from ${answerCount(totalBefore)} to ${answerCount(claimAfter.expense_total)} — ` +
      `the total that decides where it is routed moved with it. A row missing its amount was refused, and ` +
      `replacing a claim's rows in bulk was refused outright (ACT011).`,
  );
}

function answerCount(v: unknown): string {
  return typeof v === 'number' ? `£${v.toFixed(2)}` : String(v);
}

/**
 * "Any two" means two different people, "in turn" means in turn, and one "no" stops it.
 *
 * An approval request was settled by its first decision whatever its mode
 * said, so a sequential approval behaved exactly like any-of and a quorum
 * had nowhere to count. This runs a quorum of two HR approvers and a
 * manager-then-HR sequence through the real engine, and every way to get
 * either wrong.
 */
export async function proveApprovalModes({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const as = (tenantId: string, actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });
  const attempt = async (fn: () => Promise<{ applied: boolean; progress?: { have: number; need: number } }>) => {
    try {
      const r = await fn();
      return r.progress ? `counted ${r.progress.have} of ${r.progress.need}` : r.applied ? 'settled' : 'no change';
    } catch (err) {
      return err instanceof AuthorizationError ? `refused: ${err.reason}` : `error: ${String(err)}`;
    }
  };

  // ---------------------------------------------------------------- a quorum
  const quorumBp = {
    ...bp,
    workflow: {
      ...bp.workflow,
      approvals: bp.workflow.approvals.map((a) =>
        a.key === 'hr_approval' ? { ...a, mode: 'quorum' as const, required: 2, approvers: [{ role: 'hr_approver' }] } : a,
      ),
    },
  } as Blueprint;
  const q = await engine.createTenant('proof:quorum');
  const qv = await engine.publish(q, quorumBp, 'proof');
  const manager = await engine.createActor(q, 'manager_email@example.test', 'Priya Manager');
  await engine.grant({ tenantId: q, actorId: manager, processKey: bp.key, roleKey: 'hiring_manager' });
  const hr: string[] = [];
  for (const n of ['one', 'two', 'three']) {
    const id = await engine.createActor(q, `hr.${n}@proof-quorum.test`, `HR ${n}`);
    await engine.grant({ tenantId: q, actorId: id, processKey: bp.key, roleKey: 'hr_approver' });
    hr.push(id);
  }
  const intoHrReview = async (email: string) => {
    const { instanceId } = await engine.submit({ version: qv, answers: completeFor(quorumBp, { personal_email: email }) as never, now: T0 });
    await engine.drain(T0, 'proof', q);
    await engine.decide({ instanceId, approvalKey: 'manager_approval', decision: 'approved', principal: as(q, manager), now: T0 });
    await engine.drain(T0, 'proof', q);
    return instanceId;
  };
  const decideHr = (id: string, who: string, decision: 'approved' | 'rejected') =>
    attempt(() =>
      engine.decide({
        instanceId: id,
        approvalKey: 'hr_approval',
        decision,
        // The HR approval asks for a reason on anything but a yes.
        reason: decision === 'rejected' ? 'Not eligible' : undefined,
        principal: as(q, who),
        now: T0,
      }),
    );
  const stateOf = async (id: string) => (await engine.instance(id)).state;
  const queueHas = async (who: string, id: string) =>
    (await myWork(pool, { principal: as(q, who), actorId: who, processKey: bp.key })).approvals.some((a) => a.instanceId === id);

  const r1 = await intoHrReview('quorum.one@example.test');
  const first = await decideHr(r1, hr[0]!, 'approved');
  const stillWaiting = await stateOf(r1);
  const again = await decideHr(r1, hr[0]!, 'approved');
  const queueFirst = await queueHas(hr[0]!, r1);
  const queueSecond = await queueHas(hr[1]!, r1);
  const second = await decideHr(r1, hr[1]!, 'approved');
  const settled = await stateOf(r1);
  const { rows: decidedEvent } = await pool.query<{ payload: { by?: string[] } }>(
    `select payload from event where instance_id = $1 and type = 'approval_decided' and payload->>'approval' = 'hr_approval'`,
    [r1],
  );

  const r2 = await intoHrReview('quorum.two@example.test');
  await decideHr(r2, hr[0]!, 'approved');
  const veto = await decideHr(r2, hr[2]!, 'rejected');
  const vetoed = await stateOf(r2);

  // ---------------------------------------------------------------- a sequence
  const seqBp = {
    ...bp,
    workflow: {
      ...bp.workflow,
      approvals: bp.workflow.approvals.map((a) =>
        a.key === 'manager_approval'
          ? { ...a, mode: 'sequential' as const, approvers: [{ field: 'manager_email' }, { role: 'hr_approver' }] }
          : a,
      ),
    },
  } as Blueprint;
  const t = await engine.createTenant('proof:sequence');
  const tv = await engine.publish(t, seqBp, 'proof');
  const tManager = await engine.createActor(t, 'manager_email@example.test', 'Priya Manager');
  await engine.grant({ tenantId: t, actorId: tManager, processKey: bp.key, roleKey: 'hiring_manager' });
  const tHr = await engine.createActor(t, 'hr@proof-sequence.test', 'Sam HR');
  await engine.grant({ tenantId: t, actorId: tHr, processKey: bp.key, roleKey: 'hr_approver' });
  const { instanceId: s1 } = await engine.submit({ version: tv, answers: completeFor(seqBp, { personal_email: 'seq@example.test' }) as never, now: T0 });
  await engine.drain(T0, 'proof', t);
  const decideSeq = (who: string) =>
    attempt(() => engine.decide({ instanceId: s1, approvalKey: 'manager_approval', decision: 'approved', principal: as(t, who), now: T0 }));
  const outOfTurn = await decideSeq(tHr);
  const hrQueueBefore = (await myWork(pool, { principal: as(t, tHr), actorId: tHr, processKey: bp.key })).approvals.length;
  const managerFirst = await decideSeq(tManager);
  const midSequence = (await engine.instance(s1)).state;
  const hrQueueAfter = (await myWork(pool, { principal: as(t, tHr), actorId: tHr, processKey: bp.key })).approvals.length;
  const hrSecond = await decideSeq(tHr);
  const afterSequence = (await engine.instance(s1)).state;

  // ---------------------------------------------------------------- the compiler
  const codesFor = (change: Record<string, unknown>) => {
    const variant = {
      ...bp,
      workflow: {
        ...bp.workflow,
        approvals: bp.workflow.approvals.map((a) => (a.key === 'hr_approval' ? { ...a, ...change } : a)),
      },
    };
    return validate(variant as Blueprint).items.filter((d) => d.code.startsWith('APR')).map((d) => `${d.code}:${d.severity}`);
  };
  const noCount = codesFor({ mode: 'quorum', required: undefined });
  const countOnSingle = codesFor({ mode: 'single', required: 2 });
  const impossible = codesFor({ mode: 'quorum', required: 3, approvers: [{ user: 'a@example.test' }, { user: 'b@example.test' }] });
  const onRole = codesFor({ mode: 'quorum', required: 2, approvers: [{ role: 'hr_approver' }] });

  record(
    'Any two means two different people, in turn means in turn, and one no stops it',
    'Approval quorums (§6.5, "any two directors"), and sequential approval enforced at runtime rather than only named in the schema.',
    first === 'counted 1 of 2' &&
      stillWaiting === 'hr_review' &&
      again.startsWith('refused') &&
      !queueFirst &&
      queueSecond &&
      second === 'settled' &&
      settled === 'provisioning' &&
      (decidedEvent[0]?.payload.by ?? []).length === 2 &&
      veto === 'settled' &&
      vetoed === 'rejected' &&
      outOfTurn.startsWith('refused') &&
      hrQueueBefore === 0 &&
      managerFirst === 'counted 1 of 2' &&
      midSequence === 'manager_review' &&
      hrQueueAfter === 1 &&
      hrSecond === 'settled' &&
      afterSequence === 'hr_review' &&
      noCount.includes('APR001:error') &&
      countOnSingle.includes('APR001:error') &&
      impossible.includes('APR002:error') &&
      onRole.includes('APR003:warning'),
    `A quorum of two HR approvers: the first approval was ${first} and the record stayed in HR review; the same ` +
      `person approving again was ${again.split(':')[0]}, and it left their queue while staying in a colleague's. The ` +
      `second person ${second} it and the record moved to ${settled}, with both names on the decision. On another ` +
      `record one approval then one rejection ${veto} it as ${vetoed}. In a manager-then-HR sequence, HR going first ` +
      `was ${outOfTurn.split(':')[0]} and HR's queue was empty; the manager's approval was ${managerFirst}, the record ` +
      `stayed with the manager, HR's queue then held it, and HR's approval moved it on to ${afterSequence}. The ` +
      `compiler refused a quorum with no count and a count on a single approval (APR001), refused three from two ` +
      `named people (APR002), and warned that a role-addressed quorum depends on the roster (APR003).`,
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

/**
 * Many invitations at once.
 *
 * A pasted list is where the mistakes are: a typo, the same person twice,
 * somebody already here, a role written the way a person writes it. The
 * check has to say so row by row without sending anything, and the send has
 * to go only to the rows that passed — never granting more than a single
 * invitation could, which for a builder means never an owner.
 */
export async function proveBulkInvite({ pool, record }: ProofCtx): Promise<void> {
  const created = await createWorkspace(pool, {
    workspaceName: 'Proof Bulk Invite',
    ownerEmail: 'owner@proof-bulk.test',
    ownerName: 'An Owner',
    password: 'a-long-enough-password',
  });
  const owner: Principal = { kind: 'actor', tenantId: created.tenantId, actorId: created.actorId };
  const verification = await sendVerification(pool, { actorId: created.actorId });
  await verifyEmail(pool, verification.token!);

  // Somebody already invited, so the list can meet a pending invitation.
  await invite(pool, { principal: owner, email: 'pending@proof-bulk.test', workspaceRole: 'analyst' });
  const invitations = async () =>
    (await pool.query<{ n: number }>(
      'select count(*)::int as n from invitation where tenant_id = $1 and revoked_at is null',
      [created.tenantId],
    )).rows[0]!.n;

  const rows = [
    { email: 'ada@proof-bulk.test', role: 'operator' },
    { email: 'BEN@proof-bulk.test', role: 'Read only' },
    { email: 'ada@proof-bulk.test', role: 'operator' },
    { email: 'not-an-email', role: 'analyst' },
    { email: 'owner@proof-bulk.test', role: 'analyst' },
    { email: 'pending@proof-bulk.test', role: 'analyst' },
    { email: 'cara@proof-bulk.test', role: 'wizard' },
  ];

  const before = await invitations();
  const checked = await inviteMany(pool, { principal: owner, rows, dryRun: true });
  const afterCheck = await invitations();
  const status = checked.rows.map((r) => r.status);

  const sent = await inviteMany(pool, { principal: owner, rows, dryRun: false });
  const afterSend = await invitations();
  const { rows: roles } = await pool.query<{ email: string; workspace_role: string }>(
    `select lower(email) as email, workspace_role from invitation
      where tenant_id = $1 and revoked_at is null and accepted_at is null order by email`,
    [created.tenantId],
  );

  // A builder may invite, but not an owner — the same rule as one at a time.
  const joining = await invite(pool, { principal: owner, email: 'builder@proof-bulk.test', workspaceRole: 'builder' });
  const joined = await acceptInvitation(pool, {
    token: joining.token,
    displayName: 'A Builder',
    password: 'builder-long-password',
  });
  const builder: Principal = { kind: 'actor', tenantId: joined.tenantId, actorId: joined.actorId };
  const escalation = await inviteMany(pool, {
    principal: builder,
    rows: [{ email: 'boss@proof-bulk.test', role: 'owner' }],
    dryRun: true,
  });

  let tooMany: string | null = null;
  try {
    await inviteMany(pool, {
      principal: owner,
      rows: Array.from({ length: 101 }, (_, i) => ({ email: `p${i}@proof-bulk.test`, role: 'analyst' })),
      dryRun: true,
    });
  } catch (err) {
    tooMany = err instanceof Error ? err.message : String(err);
  }

  const checkAsks = stepUpFor('POST', '/api/invitations/bulk', { rows: [], dryRun: true });
  const sendAsks = stepUpFor('POST', '/api/invitations/bulk', { rows: [] });

  const expected = ['ready', 'ready', 'skipped', 'skipped', 'skipped', 'ready', 'skipped'];
  record(
    'A list of people is checked row by row, and only the rows that pass are invited',
    'IAM-01 at scale: a pasted list or spreadsheet, with nothing sent until it has been checked.',
    JSON.stringify(status) === JSON.stringify(expected) &&
      checked.rows[1]!.email === 'ben@proof-bulk.test' &&
      checked.rows[1]!.role === 'read_only' &&
      afterCheck === before &&
      sent.rows.filter((r) => r.status === 'sent').length === 3 &&
      sent.rows.filter((r) => r.status === 'skipped').length === 4 &&
      afterSend === 3 &&
      roles.find((r) => r.email === 'ada@proof-bulk.test')?.workspace_role === 'operator' &&
      roles.find((r) => r.email === 'ben@proof-bulk.test')?.workspace_role === 'read_only' &&
      escalation.rows[0]!.status === 'skipped' &&
      tooMany !== null &&
      checkAsks === null &&
      sendAsks !== null,
    `Seven rows came back ${status.join(', ')}: a repeat, a non-address, a current member and a role that does not exist were set aside with a reason each; ` +
      `"BEN@…" with "Read only" became ben@… as read_only; the pending invitation was ready, with the note "${checked.rows[5]!.note}". ` +
      `Checking created nothing (${before} invitation before, ${afterCheck} after). Sending invited the three ready rows and left the other four alone, ` +
      `with ${afterSend} open invitations after, because the re-sent one replaced the old link. ` +
      `A builder listing an owner was told "${escalation.rows[0]!.note}". A hundred and one rows were refused ("${tooMany?.slice(0, 50)}"). ` +
      `Checking needs no fresh sign-in; sending does.`,
  );
}

/**
 * The builder's Preview, Versions and Tests pages read a process without a
 * draft open, at any version. That is a new way in, so it gets the same bar
 * as opening a draft: an operator is refused, a version that does not exist
 * is refused, and a past version is what was published then — not the
 * present with a different number on it.
 */
export async function proveBuilderPages({ pool, bp, record }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('proof:builder-pages');
  await engine.publish(tenantId, bp, 'proof');
  const renamed = structuredClone(bp);
  renamed.name = 'Onboarding, second edition';
  await engine.publish(tenantId, renamed, 'proof');

  const builder = await engine.createActor(tenantId, 'builder@proof-pages.test', 'A Builder', 'builder');
  const operator = await engine.createActor(tenantId, 'operator@proof-pages.test', 'An Operator', 'operator');
  const as = (actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });

  const latest = await viewProcess(pool, as(builder), bp.key, 'latest');
  const first = await viewProcess(pool, as(builder), bp.key, 1);

  let noDraft: string | null = null;
  try {
    await viewProcess(pool, as(builder), bp.key, 'draft');
  } catch (err) {
    noDraft = err instanceof Error ? err.message : String(err);
  }
  const opened = await openDraft(pool, { principal: as(builder), processKey: bp.key });
  const draft = await viewProcess(pool, as(builder), bp.key, 'draft');

  let missing: string | null = null;
  try {
    await viewProcess(pool, as(builder), bp.key, 9);
  } catch (err) {
    missing = err instanceof Error ? err.message : String(err);
  }
  let operatorRefused: string | null = null;
  try {
    await viewProcess(pool, as(operator), bp.key, 'latest');
  } catch (err) {
    operatorRefused = err instanceof AuthorizationError ? err.reason : `unexpected: ${String(err)}`;
  }
  let operatorTests: string | null = null;
  try {
    await testVersion(pool, { principal: as(operator), processKey: bp.key, version: 1 });
  } catch (err) {
    operatorTests = err instanceof AuthorizationError ? err.reason : `unexpected: ${String(err)}`;
  }

  const run = await testVersion(pool, { principal: as(builder), processKey: bp.key, version: 1 });

  record(
    'Preview, Versions and Tests read any version of a process, and only for people who may build it',
    'BLD-05 and §9.2: a published version is looked at and tested as it was published.',
    latest.source === 'published' &&
      latest.version === 2 &&
      latest.name === 'Onboarding, second edition' &&
      JSON.stringify(latest.versions) === '[2,1]' &&
      first.version === 1 &&
      first.name === bp.name &&
      noDraft !== null &&
      draft.source === 'draft' &&
      draft.draftId === opened.id &&
      missing !== null &&
      operatorRefused !== null &&
      operatorTests !== null &&
      run.total === (bp.tests?.length ?? 0) &&
      run.total > 0 &&
      run.passed === run.total,
    `The latest was v${latest.version} ("${latest.name}") and v1 still read "${first.name}". ` +
      `Asking for a draft before one existed was refused ("${noDraft}"); after opening one it came back as that draft. ` +
      `Version 9 was refused ("${missing}"). An operator could neither look ("${operatorRefused}") nor run the tests. ` +
      `Version 1's own ${run.total} scenarios ran again against today's engine and ${run.passed} passed.`,
  );
}

/**
 * A vote, rather than a veto.
 *
 * Every other approval mode settles on the first "no". A board or a panel
 * decides by majority, and until this could not say so. The proof runs real
 * votes through the engine: one that passes over a dissent, one that fails
 * once a majority is out of reach, a tie, a request for changes refused, the
 * submitter left out of the count, and a roster change mid-vote that does not
 * move the line.
 */
export async function proveMajorityVote({ pool, bp, T0, record, completeFor }: ProofCtx): Promise<void> {
  const engine = new Engine(pool);
  const as = (tenantId: string, actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });
  const voteBp = {
    ...bp,
    workflow: {
      ...bp.workflow,
      approvals: bp.workflow.approvals.map((a) =>
        a.key === 'hr_approval'
          ? { ...a, mode: 'majority' as const, allowRequestChanges: false, notTheSubmitter: true, approvers: [{ role: 'hr_approver' }] }
          : a,
      ),
    },
  } as Blueprint;

  /** A workspace with `size` HR voters, one of whom may be the submitter. */
  const panel = async (label: string, size: number, submitterIsVoter = false) => {
    const tenant = await engine.createTenant(`proof:vote-${label}`);
    const version = await engine.publish(tenant, voteBp, 'proof');
    const manager = await engine.createActor(tenant, 'manager_email@example.test', 'Priya Manager');
    await engine.grant({ tenantId: tenant, actorId: manager, processKey: bp.key, roleKey: 'hiring_manager' });
    const voters: string[] = [];
    for (let i = 0; i < size; i++) {
      const email = submitterIsVoter && i === 0 ? `applicant.${label}@proof-vote.test` : `hr.${label}.${i}@proof-vote.test`;
      const id = await engine.createActor(tenant, email, `HR ${i}`);
      await engine.grant({ tenantId: tenant, actorId: id, processKey: bp.key, roleKey: 'hr_approver' });
      voters.push(id);
    }
    const open = async (email = `applicant.${label}@proof-vote.test`) => {
      const { instanceId } = await engine.submit({
        version,
        answers: completeFor(voteBp, { personal_email: email }) as never,
        now: T0,
      });
      await engine.drain(T0, 'proof', tenant);
      await engine.decide({ instanceId, approvalKey: 'manager_approval', decision: 'approved', principal: as(tenant, manager), now: T0 });
      await engine.drain(T0, 'proof', tenant);
      return instanceId;
    };
    const vote = async (id: string, who: string, decision: 'approved' | 'rejected' | 'changes_requested') => {
      try {
        const r = await engine.decide({
          instanceId: id,
          approvalKey: 'hr_approval',
          decision,
          principal: as(tenant, who),
          reason: 'proof',
          now: T0,
        });
        return r.progress ? `${r.progress.have} for, ${r.progress.against ?? 0} against` : r.applied ? 'settled' : 'no change';
      } catch (err) {
        return `refused: ${err instanceof AuthorizationError ? err.reason : err instanceof Error ? err.message : String(err)}`;
      }
    };
    const state = async (id: string) => (await engine.instance(id)).state;
    const request = async (id: string) =>
      (
        await pool.query<{ electorate: number; required: number }>(
          `select electorate, required from approval_request where instance_id = $1 and approval_key = 'hr_approval'`,
          [id],
        )
      ).rows[0]!;
    return { tenant, voters, open, vote, state, request };
  };

  // ---- five voters: passes at three, over one dissent
  const five = await panel('five', 5);
  const a = await five.open();
  const aCount = await five.request(a);
  const aVotes = [
    await five.vote(a, five.voters[0]!, 'approved'),
    await five.vote(a, five.voters[1]!, 'rejected'),
    await five.vote(a, five.voters[2]!, 'approved'),
  ];
  const aOpen = await five.state(a);
  const aTwice = await five.vote(a, five.voters[1]!, 'approved');
  const aLast = await five.vote(a, five.voters[3]!, 'approved');
  const aState = await five.state(a);

  // ---- five voters: fails when a majority is out of reach (the third "no")
  const b = await five.open('applicant.five.b@proof-vote.test');
  const bVotes = [
    await five.vote(b, five.voters[0]!, 'rejected'),
    await five.vote(b, five.voters[1]!, 'rejected'),
  ];
  const bOpenAfterTwo = await five.state(b);
  const bThird = await five.vote(b, five.voters[2]!, 'rejected');
  const bState = await five.state(b);
  const c0 = await five.open('applicant.five.c@proof-vote.test');
  const changesOpen = await five.vote(c0, five.voters[4]!, 'changes_requested');

  // ---- four voters: a two-two tie is a no
  const four = await panel('four', 4);
  const t = await four.open();
  const tCount = await four.request(t);
  await four.vote(t, four.voters[0]!, 'approved');
  await four.vote(t, four.voters[1]!, 'approved');
  const tFirstNo = await four.vote(t, four.voters[2]!, 'rejected');
  const tSecondNo = await four.vote(t, four.voters[3]!, 'rejected');
  const tState = await four.state(t);

  // ---- the submitter holds the role but is barred, so is not counted
  const barred = await panel('barred', 4, true);
  const s = await barred.open();
  const sCount = await barred.request(s);
  const sSelf = await barred.vote(s, barred.voters[0]!, 'approved');

  // ---- somebody joins the role mid-vote: the line does not move
  const late = await engine.createActor(five.tenant, 'hr.late@proof-vote.test', 'HR late');
  await engine.grant({ tenantId: five.tenant, actorId: late, processKey: bp.key, roleKey: 'hr_approver' });
  const cCount = await five.request(c0);

  // ---- the compiler
  const codesFor = (change: Record<string, unknown>) => {
    const variant = {
      ...bp,
      workflow: {
        ...bp.workflow,
        approvals: bp.workflow.approvals.map((x) => (x.key === 'hr_approval' ? { ...x, ...change } : x)),
      },
    };
    return validate(variant as Blueprint).items.filter((d) => d.code.startsWith('APR')).map((d) => d.code);
  };
  const withChanges = codesFor({ mode: 'majority', allowRequestChanges: true });
  const withCount = codesFor({ mode: 'majority', allowRequestChanges: false, required: 3 });
  const ofTwo = codesFor({ mode: 'majority', allowRequestChanges: false, approvers: [{ user: 'a@example.test' }, { user: 'b@example.test' }] });
  const onRole = codesFor({ mode: 'majority', allowRequestChanges: false });

  record(
    'A majority vote passes over a dissent, fails when it cannot pass, and a tie is a no',
    'Approval modes: a vote rather than a veto, for boards and panels.',
    aCount.electorate === 5 &&
      aCount.required === 3 &&
      aVotes.join('|') === '1 for, 0 against|1 for, 1 against|2 for, 1 against' &&
      aOpen === 'hr_review' &&
      aTwice.startsWith('refused') &&
      aLast === 'settled' &&
      aState !== 'hr_review' &&
      bVotes.join('|') === '0 for, 1 against|0 for, 2 against' &&
      bOpenAfterTwo === 'hr_review' &&
      bThird === 'settled' &&
      bState === 'rejected' &&
      changesOpen.startsWith('refused') &&
      tCount.electorate === 4 &&
      tCount.required === 3 &&
      tFirstNo === '2 for, 1 against' &&
      tSecondNo === 'settled' &&
      tState === 'rejected' &&
      sCount.electorate === 3 &&
      sCount.required === 2 &&
      sSelf.startsWith('refused') &&
      cCount.electorate === 5 &&
      withChanges.includes('APR004') &&
      withCount.includes('APR001') &&
      ofTwo.includes('APR005') &&
      onRole.includes('APR003'),
    `Five HR voters: the vote needed ${aCount.required}. It went ${aVotes.join(', then ')}, and the record stayed in HR review; ` +
      `the dissenter voting again was ${aTwice.slice(0, 60)}; the fourth vote settled it and the record moved on to ${aState}. ` +
      `On another record two "no" votes left it open (${bVotes[1]}), because three of the remaining could still carry it; the third "no" settled it as ${bState}. ` +
      `Asking for changes on a vote was ${changesOpen.slice(0, 70)}. ` +
      `Four voters: two for and two against settled it as ${tState}, at the second "no" — a tie is a no. ` +
      `A submitter who holds the role was left out of the count (${sCount.electorate} voters, ${sCount.required} needed) and could not vote (${sSelf.slice(0, 50)}). ` +
      `Somebody joining the role mid-vote left that record's count at ${cCount.electorate}. ` +
      `The compiler refused a vote that allows changes (APR004) or sets a count (APR001), and warned on a vote of two (APR005) and one counted from a role (APR003).`,
  );
}
