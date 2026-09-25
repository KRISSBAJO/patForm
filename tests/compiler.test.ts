import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Blueprint } from '../src/blueprint/index.js';
import { validate } from '../src/compiler/validate.js';

const DIR = 'processes';

function load(file: string) {
  const parsed = Blueprint.safeParse(JSON.parse(readFileSync(join(DIR, file), 'utf8')));
  assert.ok(parsed.success, `${file} does not match the blueprint schema: ${JSON.stringify(parsed.error?.issues?.slice(0, 3), null, 2)}`);
  return parsed.data;
}

const realProcesses = readdirSync(DIR).filter((f) => f.endsWith('.blueprint.json') && !f.startsWith('_'));

test('there are three hand-compiled reference processes', () => {
  assert.equal(realProcesses.length, 3);
});

for (const file of realProcesses) {
  test(`${file} compiles clean`, () => {
    const diagnostics = validate(load(file));
    const report = diagnostics.items.map((d) => `${d.severity} ${d.code} at ${d.at}: ${d.message}`).join('\n');
    assert.equal(diagnostics.errors.length, 0, `expected no errors:\n${report}`);
    assert.equal(diagnostics.warnings.length, 0, `expected no warnings:\n${report}`);
  });

  test(`${file} declares every scenario kind`, () => {
    const bp = load(file);
    const kinds = new Set(bp.tests.map((t) => t.kind));
    for (const kind of ['happy_path', 'rejection', 'missing_data', 'timeout', 'duplicate', 'permission']) {
      assert.ok(kinds.has(kind as never), `${file} has no ${kind} scenario`);
    }
  });
}

test('a process without a rejected outcome does not need an invented rejection scenario', () => {
  const bp = load(realProcesses[0]!);
  bp.workflow.states = bp.workflow.states.map((state) => state.outcome === 'rejected' ? { ...state, outcome: 'cancelled' as const } : state);
  bp.tests = bp.tests.filter((scenario) => scenario.kind !== 'rejection');
  assert.equal(validate(bp).errors.some((diagnostic) => diagnostic.code === 'TEST001' && diagnostic.message.includes('rejection')), false);
});

test('a reviewed assumption clears only its own builder warning', () => {
  const bp = load(realProcesses[0]!);
  bp.intent.assumptions = [
    { statement: 'The process owner reviews new submissions', affects: 'workflow.approvals' },
    { statement: 'The request is kept for one year', affects: 'intent.retentionDays' },
  ];
  assert.equal(validate(bp).items.filter((d) => d.code === 'BLD001').length, 2);
  bp.intent.assumptions[0]!.confirmed = true;
  const warnings = validate(bp).items.filter((d) => d.code === 'BLD001');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.at, 'intent.assumptions[1]');
});

/**
 * The broken example is the compiler's own regression suite. If a rule stops
 * firing, the corresponding assertion here fails rather than the fault reaching
 * a published process.
 */
test('the broken example produces every rule it is designed to trigger', () => {
  const diagnostics = validate(load('_broken-example.blueprint.json'));
  const codes = new Set(diagnostics.items.map((d) => d.code));

  const expected = [
    'BLOCK001', // blocking task nothing waits for
    'BLOCK002', // trigger waits for a task nothing creates
    'FLOW001', // two initial states
    'FLOW003', // unreachable states
    'FLOW004', // transition leaving a terminal state
    'FLOW005', // non-terminal dead end
    'FLOW007', // unconditional self-loop
    'FLOW008', // terminal state with no outcome
    'OPS001', // duplicate action key, which would collapse an idempotency key
    'OPS002', // orphaned approval, template, document
    'OPS005', // no completion-rate metric
    'OPS007', // no duplicate identity
    'REF002', // unknown field, from three different directions
    'REF003', // required field on no page
    'REF005', // transition into an unknown state
    'REF006', // action referencing an unknown template
    'REF007', // trigger referencing an unknown task
    'REF012', // unknown owner role and completion state
    'REF013', // metric on an unknown state, undeclared webhook event
    'SEC001', // field above the sensitivity ceiling
    'SEC002', // restricted value in an email body
    'SEC003', // restricted value in a webhook payload
    'SEC004', // restricted value in an export
    'SEC005', // approvals with no role able to approve
    'SEC006', // respondent granted operator rights
    'SEC007', // restricted field with no collection reason
    'SEC008', // role may edit what it cannot see
    'TEST001', // missing scenario kinds
    'TYPE001', // ordered comparison on text
    'TYPE002', // comparison against a value the choice field cannot hold
    'TYPE003', // choice field with no choices
    'TYPE005', // calculated field cycle
  ];

  const missing = expected.filter((code) => !codes.has(code));
  assert.deepEqual(missing, [], `these rules no longer fire: ${missing.join(', ')}`);
  assert.equal(diagnostics.publishable, false);
});

test('a blueprint with errors is never publishable, warnings alone never block', () => {
  const bp = load('expense-approval.blueprint.json');
  assert.equal(validate(bp).publishable, true);

  // Removing the identity fields should warn without blocking publication.
  const warnOnly = structuredClone(bp);
  delete warnOnly.data.identity;
  const d1 = validate(warnOnly);
  assert.ok(d1.warnings.some((w) => w.code === 'OPS007'));
  assert.equal(d1.publishable, true);

  // Pointing the completion state at a rejection is an error and must block.
  const broken = structuredClone(bp);
  broken.intent.completionState = 'rejected';
  const d2 = validate(broken);
  assert.ok(d2.errors.some((e) => e.code === 'FLOW006'));
  assert.equal(d2.publishable, false);
});

test('an email to the submitter may quote their own confidential answers; one to a third party may not', () => {
  const bp = load('employee-onboarding.blueprint.json');
  assert.equal(validate(bp).warnings.filter((w) => w.code === 'SEC002').length, 0);

  const leaked = structuredClone(bp);
  const template = leaked.communications.email.find((e) => e.key === 'hr_reminder')!;
  template.body += ' The candidate is {{full_name}}.';
  const d = validate(leaked);
  assert.ok(
    d.warnings.some((w) => w.code === 'SEC002'),
    'sending a confidential field to a role other than the data subject should warn',
  );
});

test('model output that is not a blueprint is rejected before the compiler sees it', () => {
  // Section 7.3: model output is treated as untrusted input. These are the
  // shapes a generator actually produces when it goes wrong.
  const notABlueprint = [
    {},
    { schemaVersion: '0.1' },
    { schemaVersion: '0.2', key: 'x' },
    { ...JSON.parse(readFileSync(join(DIR, 'expense-approval.blueprint.json'), 'utf8')), surpriseField: true },
  ];
  for (const candidate of notABlueprint) {
    assert.equal(Blueprint.safeParse(candidate).success, false);
  }
});

test('expressions cannot smuggle in executable code', () => {
  const bp = structuredClone(load('expense-approval.blueprint.json'));
  const transition = bp.workflow.transitions.find((t) => t.key === 'submit_small')!;
  // A generator that emits a code string instead of a typed comparison must
  // fail at the schema, not be evaluated by the runtime.
  (transition as unknown as { when: unknown }).when = { op: 'eval', code: 'process.exit(1)' };
  assert.equal(Blueprint.safeParse(bp).success, false);
});

/**
 * SEC009 exists because a role that cannot approve is a different failure from
 * a role that does not exist, and only the second one was being caught.
 *
 * The runtime refuses `approve` for a role without the capability, so an
 * approval naming one waits forever. Nothing in the blueprint looks wrong when
 * you read it: the role is real, the approval is wired up, the transition
 * fires. It is the kind of fault that is only visible from the policy engine's
 * side, which is why the compiler has to carry it.
 */
test('an approver who cannot approve is an error, not a runtime surprise', () => {
  const bp = load('employee-onboarding.blueprint.json');
  assert.equal(validate(bp).errors.filter((e) => e.code === 'SEC009').length, 0);

  // hr_admin holds administer, operate and edit — everything except approve.
  const unclearable = structuredClone(bp);
  const admin = unclearable.roles.find((r) => r.key === 'hr_admin')!;
  assert.ok(!admin.capabilities.includes('approve'), 'the fixture must not already grant approve');
  unclearable.workflow.approvals[0]!.approvers.push({ role: 'hr_admin' });

  const d = validate(unclearable);
  assert.ok(
    d.errors.some((e) => e.code === 'SEC009' && e.message.includes('hr_admin')),
    'naming a role without the approve capability must be an error',
  );
  assert.equal(d.publishable, false);

  // Granting the capability resolves it, which is what the fix line suggests.
  const granted = structuredClone(unclearable);
  granted.roles.find((r) => r.key === 'hr_admin')!.capabilities.push('approve');
  assert.equal(validate(granted).errors.filter((e) => e.code === 'SEC009').length, 0);
});

test('a respondent role may never be named as an approver', () => {
  const bp = load('employee-onboarding.blueprint.json');
  const selfApproving = structuredClone(bp);
  const newHire = selfApproving.roles.find((r) => r.kind === 'respondent')!;
  // Even with the capability granted, authorize() refuses `approve` for a
  // respondent principal before it looks at any role, so this can never work.
  newHire.capabilities.push('approve');
  selfApproving.workflow.approvals[0]!.approvers = [{ role: newHire.key }];

  const d = validate(selfApproving);
  assert.ok(
    d.errors.some((e) => e.code === 'SEC009' && e.message.includes('respondent')),
    'a respondent approving their own submission must be an error',
  );
});

/*
 * Parallel work, and the checks that make naming a join safe.
 *
 * The join names the tasks it waits for rather than inferring "all blocking
 * tasks in this state", because an inferred set is whatever `create_task`
 * actions happened to run. Naming them costs one thing — you can add a fifth
 * task and forget to join it — so the compiler has to catch exactly that.
 */

function onboarding() {
  return JSON.parse(readFileSync(join(DIR, 'employee-onboarding.blueprint.json'), 'utf8'));
}

/*
 * Parse before validating. Zod applies the schema's defaults — `attachments`
 * is the one that bites — and the compiler reads a parsed blueprint
 * everywhere it runs for real. Validating raw JSON tests a shape the compiler
 * never sees.
 */
function codesFrom(raw: unknown): string[] {
  const parsed = Blueprint.safeParse(raw);
  const r = validate(parsed.success ? parsed.data : (raw as never));
  return [...r.errors, ...r.warnings].map((d) => d.code);
}

function codesFor(mutate: (b: Record<string, never>) => void): string[] {
  const b = onboarding();
  mutate(b);
  return codesFrom(b);
}

function expense() {
  return JSON.parse(readFileSync(join(DIR, 'expense-approval.blueprint.json'), 'utf8'));
}

test('the reference process fans out rather than chaining', () => {
  const bp = load('employee-onboarding.blueprint.json');

  // Equipment and accounts are created together, not one by the other.
  const created = bp.workflow.transitions
    .filter((t) => t.to === 'provisioning')
    .flatMap((t) => t.actions.filter((a) => a.do === 'create_task').map((a) => a.task));
  assert.ok(created.includes('issue_equipment'), 'equipment is created on arrival');
  assert.ok(created.includes('create_accounts'), 'accounts are created on arrival, not by finishing equipment');

  // And one transition waits for both.
  const join = bp.workflow.transitions.find((t) => t.trigger.on === 'tasks_completed');
  assert.ok(join, 'provisioning leaves on a join');
  assert.deepEqual([...join.trigger.tasks].sort(), ['create_accounts', 'issue_equipment']);
});

test('a blocking task left out of the join is an error', () => {
  // The whole cost of naming the set. Without this check, adding a fourth
  // piece of provisioning work and forgetting the join completes the record
  // with that work still open — invisibly.
  const codes = codesFor((b) => {
    b.workflow.tasks.find((t) => t.key === 'book_orientation').blocking = true;
  });
  assert.ok(codes.includes('BLOCK003'), `expected BLOCK003, got ${codes.join(', ') || 'nothing'}`);
});

test('a join naming a task nothing creates is an error', () => {
  const codes = codesFor((b) => {
    b.workflow.transitions.find((t) => t.trigger.on === 'tasks_completed').trigger.tasks = [
      'issue_equipment',
      'ghost_task',
    ];
  });
  assert.ok(codes.includes('REF007'), `expected REF007, got ${codes.join(', ') || 'nothing'}`);
});

test('a join naming the same task twice is an error', () => {
  // Two of the same key is a join of one wearing a disguise.
  const codes = codesFor((b) => {
    b.workflow.transitions.find((t) => t.trigger.on === 'tasks_completed').trigger.tasks = [
      'issue_equipment',
      'issue_equipment',
    ];
  });
  assert.ok(codes.includes('BLOCK005'), `expected BLOCK005, got ${codes.join(', ') || 'nothing'}`);
});

test('a joined task counts as awaited, so it is not also reported as orphaned', () => {
  // BLOCK001 asks whether anything waits for a blocking task. A task waited
  // for as part of a set is waited for; counting only `task_completed` would
  // have reported the fan-out as a missing control.
  const diagnostics = validate(load('employee-onboarding.blueprint.json'));
  assert.equal(diagnostics.items.filter((d) => d.code === 'BLOCK001').length, 0);
});

/*
 * Separation of duties, and the thing it rests on.
 *
 * The control bars "the submitter". It is only as good as the runtime's
 * answer to who that is — which used to be the first field of type email, a
 * positional guess. A fraud control that guesses bars the wrong person.
 */

test('a process that bars the submitter must say which field holds their address', () => {
  const codes = codesFor((b) => {
    delete b.data.submitterField;
  });
  assert.ok(codes.includes('SEC010') === false, 'onboarding does not bar anybody, so it needs no submitter field');

  const claim = expense();
  delete claim.data.submitterField;
  const barred = codesFrom(claim);
  assert.ok(barred.includes('SEC010'), `expected SEC010, got ${barred.join(', ') || 'nothing'}`);
});

test('the submitter field has to be an address the respondent gives', () => {
  const notAField = codesFor((b) => {
    b.data.submitterField = 'no_such_field';
  });
  assert.ok(notAField.includes('REF014'), `expected REF014, got ${notAField.join(', ')}`);

  const notAnEmail = codesFor((b) => {
    b.data.submitterField = 'full_name';
  });
  assert.ok(notAnEmail.includes('REF014'), 'a name is not an address');
});

test('an approval addressed only to the submitter and barred from them is an error', () => {
  // It would route correctly, sit in a waiting state, and refuse every person
  // who tried — including the only one it names.
  const claim = expense();
  const manager = claim.workflow.approvals.find((a) => a.key === 'manager_approval');
  manager.approvers = [{ field: claim.data.submitterField }];
  const codes = codesFrom(claim);
  assert.ok(codes.includes('SEC011'), `expected SEC011, got ${codes.join(', ') || 'nothing'}`);
});

test('the expense claim bars the claimant from approving it', () => {
  // The control is on the shipped process, not merely available to it. This
  // is the process where the claimant types their own approver's address.
  const bp = load('expense-approval.blueprint.json');
  const manager = bp.workflow.approvals.find((a) => a.key === 'manager_approval');
  assert.ok(manager?.notTheSubmitter, 'the manager approval bars the submitter');
  assert.equal(bp.data.submitterField, 'employee_email');
});

test('file fields allow supported uploads and refuse unsupported formats', () => {
  const allowed = codesFor((b) => {
    b.data.fields.push({
      key: 'some_upload',
      type: 'file',
      label: 'Send us the document',
      required: true,
      classification: 'confidential',
      collectionReason: 'Because we said so.',
    });
  });
  assert.ok(!allowed.includes('SEC013'));
  const unsupported = codesFor((b) => {
    b.data.fields.push({ key: 'some_upload', type: 'file', label: 'Document', required: false,
      classification: 'confidential', collectionReason: 'For review',
      constraints: { accept: ['application/zip'], maxSizeMb: 10 } });
  });
  assert.ok(unsupported.includes('SEC013'));
});

test('a decision reason may appear only in a rejection or changes email to the submitter', () => {
  const bp = structuredClone(load('expense-approval.blueprint.json'));
  const rejected = bp.communications.email.find((e) => e.key === 'claim_rejected')!;
  rejected.body += '\nReason: {{decision_reason}}';
  assert.equal(validate(bp).errors.length, 0);

  rejected.to = [{ user: 'manager@example.test' }];
  assert.ok(validate(bp).errors.some((e) => e.code === 'SEC014'));

  rejected.to = [{ submitter: true }];
  const approved = bp.communications.email.find((e) => e.key === 'claim_approved')!;
  approved.body += '\nReason: {{ decision_reason }}';
  assert.ok(validate(bp).errors.some((e) => e.code === 'SEC014'));
});

test('a task scenario cannot supply answers its actor lacks permission to edit', () => {
  const raw = structuredClone(load('employee-onboarding.blueprint.json'));
  raw.data.fields.push({ key: 'equipment_note', type: 'short_text', label: 'Equipment note', required: false,
    classification: 'internal', setBy: 'operator' });
  const task = raw.workflow.tasks.find((item) => item.key === 'issue_equipment')!;
  task.assignee = { field: 'manager_email' };
  task.requiredFields = ['equipment_note'];
  const scenario = raw.tests.find((item) => item.kind === 'happy_path')!;
  const step = scenario.steps.find((item) => item.step === 'complete_task' && item.task === 'issue_equipment')!;
  if (step.step !== 'complete_task') throw new Error('expected task step');
  step.answers = { equipment_note: 'Issued' };
  const errors = validate(raw).errors;
  assert.ok(errors.some((item) => item.code === 'TEST004' && item.message.includes('it_operator')));
});

test('the two processes that asked for a document now ask where it is', () => {
  // docs/failure-cases.md D1: record that a check happened and where to verify
  // it, rather than storing the evidence. That was already the pattern here —
  // the church process used it for safeguarding — and it is now the only one.
  for (const file of ['employee-onboarding.blueprint.json', 'expense-approval.blueprint.json']) {
    const bp = load(file);
    assert.equal(
      bp.data.fields.filter((f) => f.type === 'file').length,
      0,
      `${file} still asks for an upload it cannot receive`,
    );
  }

  const onboarding = load('employee-onboarding.blueprint.json');
  const ref = onboarding.data.fields.find((f) => f.key === 'right_to_work_reference');
  assert.ok(ref, 'the right-to-work check is recorded by reference');
  assert.ok(ref!.collectionReason, 'and says why it is collected');
});
