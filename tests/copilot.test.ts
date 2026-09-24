import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Blueprint } from '../src/blueprint/index.js';
import { compileAction, compileQuery } from '../src/copilot/compile.js';
import { ActionPlan, Proposal, QueryPlan } from '../src/copilot/plan.js';
import { visibleFields } from '../src/runtime/policy.js';

/**
 * The plan language is the boundary a model sits behind, so these tests are
 * mostly about what it *refuses*. A query compiler that only gets tested on
 * plans somebody meant is not tested at all — the interesting inputs are the
 * ones a confused or steered model would produce.
 */

const bp = Blueprint.parse(
  JSON.parse(readFileSync(join('processes', 'employee-onboarding.blueprint.json'), 'utf8')),
);
const TENANT = '00000000-0000-0000-0000-000000000001';
const NOW = new Date('2026-09-21T09:00:00.000Z');

const compile = (plan: unknown) => compileQuery(bp, QueryPlan.parse(plan), TENANT, NOW);
const errors = (plan: unknown) => compile(plan).diagnostics.filter((d) => d.severity === 'error');

test('the plan schema rejects anything that is not a plan', () => {
  // Free text where a structure belongs is the shape of every attempt to get
  // SQL through, so it must fail at the schema rather than the compiler.
  assert.equal(QueryPlan.safeParse({ processKey: bp.key, sql: 'select 1' }).success, false);
  assert.equal(QueryPlan.safeParse({ processKey: bp.key, filters: [{ kind: 'raw', sql: 'x' }] }).success, false);
  assert.equal(QueryPlan.safeParse({ processKey: bp.key, limit: 10_000 }).success, false);
  assert.equal(QueryPlan.safeParse({ processKey: bp.key, orderBy: { by: 'data' } }).success, false);
});

test('every value reaches Postgres as a parameter, never as text in the statement', () => {
  const nasty = "'; drop table instance; --";
  const { sql, params } = compile({
    processKey: bp.key,
    filters: [{ kind: 'answer', field: 'department', op: 'eq', value: nasty }],
    limit: 5,
  });
  assert.ok(!sql.includes(nasty), 'the value must not appear in the statement');
  assert.ok(params.includes(nasty), 'the value must appear in the parameters');
  assert.ok(!sql.includes('drop table'));
});

test('a field key cannot become part of the statement', () => {
  // Keys are resolved against the blueprint and then used only as parameters
  // to `data ->> $n`, so even a key that passes the Key regex is not spliced.
  const { sql, params } = compile({
    processKey: bp.key,
    filters: [{ kind: 'answer', field: 'department', op: 'eq', value: 'operations' }],
    limit: 5,
  });
  assert.ok(!sql.includes('department'));
  assert.ok(params.includes('department'));
});

test('a plan naming something the blueprint does not have is refused', () => {
  assert.equal(errors({ processKey: bp.key, filters: [{ kind: 'state', is: ['nope'] }] })[0]?.code, 'QRY002');
  assert.equal(
    errors({ processKey: bp.key, filters: [{ kind: 'has_open_task', task: 'nope' }] })[0]?.code,
    'QRY002',
  );
  assert.equal(
    errors({ processKey: bp.key, filters: [{ kind: 'has_pending_approval', approval: 'nope' }] })[0]?.code,
    'QRY002',
  );
  assert.equal(
    errors({ processKey: bp.key, filters: [{ kind: 'answer', field: 'nope', op: 'eq', value: 'x' }] })[0]?.code,
    'QRY001',
  );
  assert.equal(errors({ processKey: bp.key, select: ['nope'] })[0]?.code, 'QRY001');
});

test('a restricted answer cannot be used as a filter', () => {
  // Otherwise "does national_id start with QQ" reads restricted data one
  // yes/no at a time and never displays it, so redaction never gets a turn.
  const restricted = bp.data.fields.filter((f) => f.classification === 'restricted');
  assert.ok(restricted.length, 'the fixture must contain a restricted field');

  for (const field of restricted) {
    const found = errors({
      processKey: bp.key,
      filters: [{ kind: 'answer', field: field.key, op: 'is_not_empty' }],
    });
    assert.equal(found[0]?.code, 'QRY004', `${field.key} should not be filterable`);
  }

  // A confidential field is still filterable; the ceiling is restricted only.
  const confidential = bp.data.fields.find((f) => f.classification === 'confidential');
  assert.ok(confidential);
  assert.deepEqual(
    errors({ processKey: bp.key, filters: [{ kind: 'answer', field: confidential.key, op: 'is_not_empty' }] }),
    [],
  );
});

test('a reader without a process role cannot use confidential answers to filter or select records', () => {
  const confidential = bp.data.fields.find((f) => f.classification === 'confidential');
  assert.ok(confidential);
  const allowed = new Set(visibleFields(bp, [], 'read_only'));
  const byAnswer = compileQuery(bp, QueryPlan.parse({
    processKey: bp.key,
    filters: [{ kind: 'answer', field: confidential.key, op: 'is_not_empty' }],
  }), TENANT, NOW, allowed);
  assert.equal(byAnswer.ok, false);
  assert.equal(byAnswer.diagnostics[0]?.code, 'QRY004');

  const selected = compileQuery(bp, QueryPlan.parse({
    processKey: bp.key,
    select: [confidential.key],
  }), TENANT, NOW, allowed);
  assert.equal(selected.ok, false);
  assert.equal(selected.diagnostics[0]?.code, 'QRY004');
});

test('comparisons are type-checked against the field, as in the blueprint', () => {
  // full_name is text: an ordered comparison against it is meaningless.
  assert.equal(
    errors({ processKey: bp.key, filters: [{ kind: 'answer', field: 'full_name', op: 'gt', value: 5 }] })[0]?.code,
    'QRY005',
  );
  // start_date is a date: comparing it to a boolean is not a date comparison.
  assert.equal(
    errors({ processKey: bp.key, filters: [{ kind: 'answer', field: 'start_date', op: 'gt', value: true }] })[0]
      ?.code,
    'QRY006',
  );
  // equipment_needs is a list: `contains` is the only sensible test.
  assert.deepEqual(
    errors({
      processKey: bp.key,
      filters: [{ kind: 'answer', field: 'equipment_needs', op: 'contains', value: 'laptop' }],
    }),
    [],
  );
  assert.equal(
    errors({ processKey: bp.key, filters: [{ kind: 'answer', field: 'equipment_needs', op: 'gt', value: 1 }] })[0]
      ?.code,
    'QRY005',
  );
});

test('"overdue" compiles to the SLA the blueprint declares, not to a guess', () => {
  const withSla = bp.workflow.states.filter((s) => s.slaHours);
  assert.ok(withSla.length, 'the fixture must declare at least one SLA');

  const { sql, params } = compile({ processKey: bp.key, filters: [{ kind: 'overdue', is: true }] });
  for (const state of withSla) assert.ok(params.includes(state.key), `${state.key} should be in the deadline list`);
  // A state with no SLA can never be overdue, so it must not appear.
  for (const state of bp.workflow.states.filter((s) => !s.slaHours)) {
    assert.ok(!params.includes(state.key), `${state.key} has no SLA and should not be treated as late`);
  }
  assert.ok(sql.includes('completed_at is null'), 'a finished record is not overdue');
});

test('a process with no SLA warns rather than silently matching everything', () => {
  const noSla = structuredClone(bp);
  for (const state of noSla.workflow.states) delete state.slaHours;
  const compiled = compileQuery(noSla, QueryPlan.parse({ processKey: bp.key, filters: [{ kind: 'overdue', is: true }] }), TENANT, NOW);
  assert.ok(compiled.diagnostics.some((d) => d.code === 'QRY003' && d.severity === 'warning'));
  assert.ok(compiled.ok, 'a warning must not block the query');
  assert.ok(compiled.sql.includes('false'), 'nothing can be overdue, so nothing matches');
});

test('the limit is capped by the compiler, not by the plan', () => {
  assert.ok(compile({ processKey: bp.key, limit: 200 }).sql.includes('limit 200'));
  // The schema stops anything higher; the compiler clamps as well, so a plan
  // that reached it another way still cannot ask for more.
  assert.equal(QueryPlan.safeParse({ processKey: bp.key, limit: 201 }).success, false);
});

test('an action can only name a template the blueprint already has', () => {
  const real = bp.communications.email[0]!.key;
  assert.deepEqual(compileAction(bp, ActionPlan.parse({ kind: 'send_reminder', template: real })), []);

  const invented = compileAction(bp, ActionPlan.parse({ kind: 'send_reminder', template: 'invented' }));
  assert.equal(invented[0]?.code, 'ACT002');

  // An action cannot carry a message body at all: the template decides the
  // wording and the recipients.
  assert.equal(
    ActionPlan.safeParse({ kind: 'send_reminder', template: real, body: 'anything' }).success,
    false,
  );
  assert.equal(
    ActionPlan.safeParse({ kind: 'send_reminder', template: real, to: 'someone@example.com' }).success,
    false,
  );
});

test('a bulk reassignment names a real task and somebody who could do it', () => {
  const codes = (action: unknown) => compileAction(bp, ActionPlan.parse(action)).map((d) => d.code);
  assert.deepEqual(codes({ kind: 'assign', task: 'issue_equipment', to: 'ini@example.test' }), []);
  assert.deepEqual(codes({ kind: 'assign', task: 'issue_equipment', to: 'role:it_operator' }), []);
  assert.deepEqual(codes({ kind: 'assign', task: 'no_such_task', to: 'ini@example.test' }), ['ACT004']);
  assert.deepEqual(codes({ kind: 'assign', task: 'issue_equipment', to: 'x' }), ['ACT005'], 'not an address');
  // A respondent role, and a role that cannot operate, could never complete the task.
  assert.deepEqual(codes({ kind: 'assign', task: 'issue_equipment', to: 'role:new_hire' }), ['ACT005']);
  assert.deepEqual(codes({ kind: 'assign', task: 'issue_equipment', to: 'role:hr_approver' }), ['ACT005']);
});

test(`a bulk move follows the process's own manual steps, or does not compile`, () => {
  const codes = (to: string) => compileAction(bp, ActionPlan.parse({ kind: 'change_state', to })).map((d) => d.code);
  assert.deepEqual(codes('withdrawn'), [], 'HR can withdraw a record by hand');
  assert.deepEqual(codes('provisioning'), ['ACT007'], 'nothing moves a record into provisioning by hand');
  assert.deepEqual(codes('nowhere'), ['ACT006']);
});

test('a proposal is only a proposal when it has a reading the operator can check', () => {
  const real = bp.communications.email[0]!.key;
  assert.equal(
    Proposal.safeParse({ query: { processKey: bp.key }, action: { kind: 'send_reminder', template: real } })
      .success,
    false,
    'a plan with no stated reading cannot be confirmed by a person',
  );
  assert.equal(
    Proposal.safeParse({ reading: 'Everything still open.', query: { processKey: bp.key } }).success,
    true,
  );
});
