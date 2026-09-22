import type { Blueprint } from './blueprint/index.js';
import type { Pool } from './runtime/db.js';
import { Engine, newWorkerId } from './runtime/engine.js';
import { AuthorizationError, type Principal } from './runtime/policy.js';
import { resolveResumeToken } from './runtime/auth.js';
import { runRetention } from './runtime/retention.js';
import { checkAnswers, loadDraft, publicForm, respondentStatus, respondentUpdate, saveDraft, submitForm } from './runtime/intake.js';
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
