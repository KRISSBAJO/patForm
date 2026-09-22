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
  await engine.drain(new Date());

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
  await engine.drain(new Date());

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
  await engine.drain(T0);

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
  await engine.drain(T0);
  await engine.decide({
    instanceId,
    approvalKey: 'hr_approval',
    decision: 'approved',
    principal: { kind: 'actor', tenantId, actorId: hr },
    now: T0,
  });
  await engine.drain(T0);

  // The packet is generated at HR approval; the welcome email that attaches
  // it only goes out when provisioning finishes, so the process has to reach
  // the end for the attachment to be exercised at all.
  const it = await engine.createActor(tenantId, 'it@example.test', 'IT', 'operator');
  await engine.grant({ tenantId, actorId: it, processKey: bp.key, roleKey: 'it_operator' });
  const itPrincipal: Principal = { kind: 'actor', tenantId, actorId: it };
  await engine.completeTask({ instanceId, taskKey: 'issue_equipment', principal: itPrincipal, now: T0 });
  await engine.drain(T0);
  await engine.completeTask({ instanceId, taskKey: 'create_accounts', principal: itPrincipal, now: T0 });
  await engine.drain(T0);

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
  await engine.drain(T0);
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
  await engine.drain(T0);
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
  await engine.drain(T0);

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
  await engine.drain(T0);

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
  await engine.drain(T0);
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
  await engine.drain(later, 'copilot');
  const emailsAfter = await countEmails(pool, tenantId);

  // 8. Confirming again sends nothing: the same idempotency key, and the same
  //    mechanism the workflow's own actions use.
  await pool.query("update copilot_run set status = 'previewed' where id = $1", [runId]);
  const second = await confirm(pool, { principal: as(admin), runId, digest: preview.digest, now: later });
  await engine.drain(later, 'copilot');
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
  await engine.drain(T0);
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
  await engine.drain(T0);
  await engine.decide({
    instanceId,
    approvalKey: 'hr_approval',
    decision: 'approved',
    principal: as(hrApprover),
    reason: 'Right to work verified.',
    now: T0,
  });
  await engine.drain(T0);
  // book_orientation is assigned to hr_admin, not IT. The policy engine is
  // what said so.
  for (const [taskKey, who] of [
    ['issue_equipment', itOperator],
    ['create_accounts', itOperator],
    ['book_orientation', admin],
  ] as const) {
    await engine.completeTask({ instanceId, taskKey, principal: as(who), now: T0 });
    await engine.drain(T0);
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
  await engine.drain(T0, 'proof-worker');

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
  await engine.drain(T0);

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
    await engine.drain(T0);
  }
  for (const [taskKey, who] of [
    ['issue_equipment', operator],
    ['create_accounts', operator],
    ['book_orientation', admin],
  ] as const) {
    await engine.completeTask({ instanceId: finished.instanceId, taskKey, principal: as(who), now: T0 });
    await engine.drain(T0);
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
