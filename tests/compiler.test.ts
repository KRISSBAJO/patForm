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
