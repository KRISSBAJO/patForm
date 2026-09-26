import type { Blueprint, ScenarioTest } from '../blueprint/index.js';
import { visibleFields } from '../blueprint/answers.js';
import { evaluate } from './expr.js';
import type { Answers } from './expr.js';
import { Engine } from './engine.js';
import type { Pool } from './db.js';
import type { Principal } from './policy.js';

interface CastMember {
  principal: Principal;
  email: string;
}

export interface ScenarioResult {
  process: string;
  test: string;
  kind: string;
  passed: boolean;
  failures: string[];
}

/**
 * A scenario names a role; the runtime needs a person. Each internal role in
 * the blueprint gets one member for the duration of the scenario, so
 * `as: "hiring_manager"` becomes a real actor holding a real membership and
 * every assertion goes through the real policy engine.
 */
const ACTION_MAP = {
  submit: 'submit',
  view: 'view',
  edit: 'edit',
  approve: 'approve',
  export: 'report',
  operate: 'operate',
} as const;

/**
 * Runs the scenarios a blueprint carries (section 7.2) against the real
 * runtime. This is what "test mode" means in requirement BLD-05: the same
 * engine that will run the published process, driven by the process's own
 * declared cases, with a clock the scenario controls.
 */
export async function runScenarios(pool: Pool, bp: Blueprint): Promise<ScenarioResult[]> {
  const engine = new Engine(pool);
  const results: ScenarioResult[] = [];

  for (const test of bp.tests) {
    // Each scenario gets its own tenant so that duplicate detection, which is
    // scoped to a tenant, does not make one scenario interfere with the next.
    const tenantId = await engine.createTenant(`scenario:${bp.key}:${test.key}`, { scenario: true });
    const version = await engine.publish(tenantId, bp, 'scenario-runner');

    /**
     * An approval addressed to `{ field: "manager_email" }` names its approver
     * by address, and nothing in the blueprint links that field to a role
     * (G5 in docs/failure-cases.md). The scenario says who decides it, and the
     * record says what address that is — so the member is created holding the
     * address the record will actually name. Overriding the record to match
     * the cast instead would be the test bending the data to pass.
     */
    const addressFor = new Map<string, string>();
    const submitted = test.steps.find((step) => step.step === 'submit');
    const answers = (submitted?.step === 'submit' ? submitted.answers : {}) as Answers;
    for (const step of test.steps) {
      const parties = step.step === 'decide'
        ? bp.workflow.approvals.find((a) => a.key === step.approval)?.approvers ?? []
        : step.step === 'complete_task'
          ? [bp.workflow.tasks.find((task) => task.key === step.task)?.assignee].filter((party) => party !== undefined)
          : [];
      if (step.step !== 'decide' && step.step !== 'complete_task') continue;
      for (const party of parties) {
        if (!('field' in party)) continue;
        const given = answers[party.field];
        // completeAnswers fills an unspecified email field with this shape.
        addressFor.set(step.as, typeof given === 'string' && given ? given : `${party.field}@example.test`);
      }
    }

    const cast = new Map<string, CastMember>();
    for (const role of bp.roles) {
      const email = addressFor.get(role.key) ?? `${role.key}@scenario.test`;
      if (role.kind === 'respondent') {
        cast.set(role.key, { principal: { kind: 'respondent', tenantId, label: role.key }, email });
        continue;
      }
      // A member's workspace role is inferred from what their process role is
      // allowed to do, so a scenario cast behaves like a real workspace.
      const workspaceRole = role.capabilities.includes('administer')
        ? 'admin'
        : role.capabilities.includes('operate')
          ? 'operator'
          : role.capabilities.includes('approve')
            ? 'approver'
            : role.capabilities.includes('report')
              ? 'analyst'
              : 'read_only';
      const actorId = await engine.createActor(tenantId, email, role.name, workspaceRole);
      await engine.grant({ tenantId, actorId, processKey: bp.key, roleKey: role.key });
      cast.set(role.key, { principal: { kind: 'actor', tenantId, actorId }, email });
    }

    results.push(await runOne(engine, bp, version, test, cast, tenantId));
  }

  return results;
}

async function runOne(
  engine: Engine,
  bp: Blueprint,
  version: Awaited<ReturnType<Engine['publish']>>,
  test: ScenarioTest,
  cast: Map<string, CastMember>,
  /** The scenario's own tenant. Every drain here runs on an invented clock. */
  tenantId: string,
): Promise<ScenarioResult> {
  const failures: string[] = [];
  let now = new Date('2026-09-21T09:00:00.000Z');
  let instanceId: string | null = null;

  const fail = (message: string) => failures.push(message);

  try {
    for (const step of test.steps) {
      switch (step.step) {
        case 'submit': {
          // Scenarios name only the answers that matter to them. Everything
          // else the form requires is filled with a valid placeholder, except
          // in a missing_data scenario, where the gap is the point.
          const answers =
            test.kind === 'missing_data'
              ? (step.answers as Answers)
              : completeAnswers(bp, step.answers as Answers);

          const result = await engine.submit({ version, answers, now });
          if (result.rejected) {
            if (test.kind !== 'missing_data') {
              fail(`submission was rejected for missing fields: ${result.rejected.join(', ')}`);
            }
            break;
          }
          instanceId = result.instanceId;
          await engine.drain(now, `scenario:${test.key}`, tenantId);
          break;
        }

        case 'decide': {
          if (!instanceId) {
            fail('decide step ran before a submission created an instance');
            break;
          }
          const member = cast.get(step.as);
          if (!member) {
            fail(`scenario names role "${step.as}", which the blueprint does not define`);
            break;
          }
          const principal = member.principal;
          try {
            const { applied } = await engine.decide({
              instanceId,
              approvalKey: step.approval,
              decision: step.decision,
              principal,
              reason: step.reason,
              now,
            });
            if (!applied) fail(`decision "${step.decision}" on "${step.approval}" did not apply`);
          } catch (err) {
            fail(`"${step.as}" was refused the decision: ${err instanceof Error ? err.message : String(err)}`);
          }
          await engine.drain(now, `scenario:${test.key}`, tenantId);
          break;
        }

        case 'complete_task': {
          if (!instanceId) {
            fail('complete_task step ran before a submission created an instance');
            break;
          }
          const member = cast.get(step.as);
          if (!member) {
            fail(`scenario names role "${step.as}", which the blueprint does not define`);
            break;
          }
          const principal = member.principal;
          let applied = false;
          let denied: unknown;
          try {
            const result = await engine.completeTask({
              instanceId, taskKey: step.task, principal, now,
              answers: step.answers as Answers | undefined,
            });
            applied = result.applied;
          } catch (err) {
            denied = err;
          }
          if (step.expectDenied && !denied) fail(`task "${step.task}" completed without the required answers`);
          if (!step.expectDenied && denied) fail(`"${step.as}" was refused the task: ${denied instanceof Error ? denied.message : String(denied)}`);
          if (!step.expectDenied && !applied) fail(`task "${step.task}" was not open and could not be completed`);
          await engine.drain(now, `scenario:${test.key}`, tenantId);
          break;
        }

        case 'advance_hours': {
          /*
           * The whole reason the tenant has to be named. This moves the clock
           * days or weeks to prove a timer fires, and without the scope it
           * claimed every tenant's due work at a time that has not happened.
           */
          now = new Date(now.getTime() + step.hours * 3_600_000);
          await engine.drain(now, `scenario:${test.key}`, tenantId);
          break;
        }

        case 'manual': {
          if (!instanceId) { fail('manual step ran before submission'); break; }
          const member = cast.get(step.as);
          if (!member) { fail(`scenario names unknown role "${step.as}"`); break; }
          try {
            const result = await engine.fireManual({ instanceId, transitionKey: step.transition, principal: member.principal, now });
            if (!result.applied) fail(`manual step "${step.transition}" did not apply: ${result.reason ?? 'unknown reason'}`);
          } catch (err) { fail(`manual step "${step.transition}" failed: ${err instanceof Error ? err.message : String(err)}`); }
          await engine.drain(now, `scenario:${test.key}`, tenantId);
          break;
        }

        case 'attempt': {
          const member = cast.get(step.as);
          if (!member) {
            fail(`scenario names role "${step.as}", which the blueprint does not define`);
            break;
          }
          // The same call the engine makes before it mutates anything.
          const { allowed, reason } = await engine.can({
            principal: member.principal,
            action: ACTION_MAP[step.action],
            tenantId: version.tenant_id,
            processKey: bp.key,
            blueprint: bp,
            instanceId: instanceId ?? undefined,
          });
          if (step.expectDenied && allowed) {
            fail(`"${step.as}" was allowed to ${step.action} but the scenario expects a refusal`);
          }
          if (!step.expectDenied && !allowed) {
            fail(`"${step.as}" was refused ${step.action} (${reason}) but the scenario expects it to be allowed`);
          }
          break;
        }
      }
    }

    // ---------------------------------------------------------- expectations

    if (test.expect.state !== undefined) {
      const actual = instanceId ? (await engine.instance(instanceId)).state : initialStateKey(bp);
      if (actual !== test.expect.state) fail(`expected state "${test.expect.state}", found "${actual}"`);
    }

    if (test.expect.instanceCount !== undefined) {
      const actual = await countInstances(engine, version.tenant_id, bp.key);
      if (actual !== test.expect.instanceCount) {
        fail(`expected ${test.expect.instanceCount} instance(s), found ${actual}`);
      }
    }

    if (test.expect.emails !== undefined) {
      const sent = instanceId ? (await engine.emails(instanceId)).map((e) => e.template_key) : [];
      compareSets('email', test.expect.emails, sent, fail);
    }

    if (test.expect.documents !== undefined) {
      const made = instanceId ? (await engine.documents(instanceId)).map((d) => d.document_key) : [];
      compareSets('document', test.expect.documents, made, fail);
    }

    if (test.expect.openTasks !== undefined) {
      const open = instanceId ? await engine.openTasks(instanceId) : [];
      compareSets('open task', test.expect.openTasks, open, fail);
    }
  } catch (err) {
    fail(`threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { process: bp.key, test: test.key, kind: test.kind, passed: failures.length === 0, failures };
}

function compareSets(label: string, expected: string[], actual: string[], fail: (m: string) => void): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const key of expectedSet) {
    if (!actualSet.has(key)) fail(`expected ${label} "${key}" but it was not produced`);
  }
  for (const key of actualSet) {
    if (!expectedSet.has(key)) fail(`unexpected ${label} "${key}" was produced`);
  }
}

async function countInstances(engine: Engine, tenantId: string, processKey: string): Promise<number> {
  const { rows } = await (engine as unknown as { pool: Pool }).pool.query<{ count: number }>(
    'select count(*)::int as count from instance where tenant_id = $1 and process_key = $2',
    [tenantId, processKey],
  );
  return rows[0]!.count;
}

function initialStateKey(bp: Blueprint): string {
  return bp.workflow.states.find((s) => s.type === 'initial')!.key;
}

/** Produces a value that satisfies a field's type, for answers a scenario does not care about. */
function completeAnswers(bp: Blueprint, given: Answers): Answers {
  const answers: Answers = { ...given };
  const now = new Date('2026-10-01');
  // Only what the form shows, the way a respondent would fill it: a required
  // question in a section that never appears is not asked, and a placeholder
  // in a hidden question could reveal a section and require more. Filling
  // can itself reveal a section, so it goes round until nothing changes.
  for (let round = 0; round < 6; round++) {
    const visible = visibleFields(bp, answers, now);
    let changed = false;
    for (const field of bp.data.fields) {
      if (!visible.has(field.key)) continue;
      if (field.setBy === 'operator' || field.setBy === 'system') continue;
      if (field.key in answers && answers[field.key] !== undefined) continue;
      const required = field.required || (field.requiredWhen && evaluate(field.requiredWhen, { answers, now }));
      if (!required) continue;
      answers[field.key] = placeholderFor(field);
      changed = true;
    }
    if (!changed) break;
  }
  for (const field of bp.data.fields) {
    if (field.type !== 'repeating_group' || !Array.isArray(answers[field.key])) continue;
    answers[field.key] = (answers[field.key] as Answers[]).map((row) => {
      const completed = { ...row };
      for (const child of field.fields ?? []) {
        if (completed[child.key] !== undefined) continue;
        if (child.required || (child.requiredWhen && evaluate(child.requiredWhen, { answers: { ...answers, ...completed }, now: new Date('2026-10-01') }))) {
          completed[child.key] = placeholderFor(child);
        }
      }
      return completed;
    });
  }
  return answers;
}

function placeholderFor(field: Blueprint['data']['fields'][number]): unknown {
  switch (field.type) {
    case 'email':
      return `${field.key}@example.test`;
    case 'number':
    case 'currency':
    case 'rating':
      return field.constraints?.min ?? 1;
    case 'date':
      return '2026-10-01';
    case 'time':
      return '09:00';
    case 'yes_no':
    case 'signature_ack':
      return true;
    case 'signature':
      return { method: 'typed', name: 'Sam Trent', style: 'flowing' };
    case 'single_choice':
    case 'dropdown':
      return field.choices?.[0]?.value ?? 'unknown';
    case 'multi_choice':
    case 'matrix':
      return field.choices?.length ? [field.choices[0]!.value] : [];
    case 'file':
      return 'receipt-file:00000000-0000-4000-8000-000000000001';
    case 'repeating_group':
      return [
        Object.fromEntries((field.fields ?? []).map((child) => [child.key, placeholderFor(child)])),
      ];
    case 'phone':
      return '+44 7700 900000';
    default:
      return `placeholder ${field.key}`;
  }
}
