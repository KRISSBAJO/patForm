import type { Blueprint } from '../blueprint/index.js';
import { fieldsInExpr } from '../blueprint/common.js';
import { evaluate } from '../runtime/expr.js';
import { normalizeBlueprint, type Normalization } from './normalize.js';
import type { ScenarioResult } from '../runtime/scenarios.js';

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};

/** Repairs mechanics and test fixtures. Never changes authorities, outcomes or existing answers. */
export function repairBlueprint(input: Blueprint, failures: ScenarioResult[] = []) {
  const normalized = normalizeBlueprint(input);
  const bp = normalized.blueprint;
  const changes: Normalization[] = [...normalized.changes];
  const transitions = bp.workflow.transitions;
  const referenced = new Set(bp.tests.flatMap(test => test.steps.flatMap(step => step.step === 'manual' ? [step.transition] : [])));
  const removed = new Set<string>();
  for (const rule of transitions) {
    if (removed.has(rule.key) || referenced.has(rule.key)) continue;
    const equivalent = transitions.find(other => other.key !== rule.key && !removed.has(other.key)
      && other.from === rule.from && other.to === rule.to
      && canonical(other.trigger) === canonical(rule.trigger) && canonical(other.when) === canonical(rule.when)
      && (rule.actions.length === 0 || canonical(other.actions) === canonical(rule.actions)));
    if (!equivalent) continue;
    removed.add(rule.key);
    changes.push({at:`workflow.transitions.${rule.key}`,change:`Removed duplicate route ${rule.key}; ${equivalent.key} retains its behavior and actions.`});
  }
  bp.workflow.transitions = transitions.filter(rule => !removed.has(rule.key));

  const initial = bp.workflow.states.find(state => state.type === 'initial')?.key;
  for (const test of bp.tests) {
    // Deliberately incomplete, denied or duplicated cases must keep their input.
    if (!['happy_path','rejection'].includes(test.kind)) continue;
    const submit = test.steps.find(step => step.step === 'submit');
    const nextTask = test.steps.find(step => step.step === 'complete_task' && !step.expectDenied);
    if (submit?.step !== 'submit' || nextTask?.step !== 'complete_task' || !initial) continue;
    const routes: typeof transitions[] = [];
    const walk = (state: string, path: typeof transitions, visited: Set<string>) => {
      if (path.length > 8 || routes.length > 8) return;
      for (const rule of bp.workflow.transitions.filter(t => t.from === state && (path.length ? t.trigger.on === 'record_updated' : t.trigger.on === 'submission'))) {
        if (visited.has(rule.to)) continue;
        const next = [...path,rule];
        if (rule.actions.some(action => action.do === 'create_task' && action.task === nextTask.task)) routes.push(next);
        else walk(rule.to,next,new Set([...visited,rule.to]));
      }
    };
    walk(initial,[],new Set([initial]));
    const candidates: Record<string,unknown>[] = [];
    for (const path of routes) {
      const keys = [...new Set(path.flatMap(rule => rule.when ? fieldsInExpr(rule.when) : []))];
      const missing = keys.filter(key => submit.answers[key] === undefined || submit.answers[key] === '');
      if (!missing.length) continue;
      let answers: Record<string,unknown>[] = [{...submit.answers}];
      for (const key of missing) {
        const field = bp.data.fields.find(f => f.key === key);
        // Sample data may be chosen from declared choices; operator/system values require an actual edit step.
        const values = !field || field.compute || field.setBy === 'operator' || field.setBy === 'system' ? []
          : field.type === 'yes_no' ? [false,true] : ['dropdown','single_choice'].includes(field.type) ? field.choices?.map(choice => choice.value) ?? [] : [];
        answers = answers.flatMap(answer => values.map(value => ({...answer,[key]:value}))).slice(0,64);
      }
      const match = answers.find(answer => path.every(rule => !rule.when || evaluate(rule.when,{answers:answer,now:new Date('2026-09-21T09:00:00Z')})));
      if (match) candidates.push(match);
    }
    // Multiple distinct routes are a business choice. Several sample values on one route are simply fixtures.
    if (candidates.length === 1) {
      for (const [key,value] of Object.entries(candidates[0]!)) {
        if (submit.answers[key] !== undefined && submit.answers[key] !== '') continue;
        submit.answers[key] = value;
        changes.push({at:`tests.${test.key}.answers.${key}`,change:`Added sample answer ${key}=${String(value)} to exercise this test's declared task path. Production routing is unchanged.`});
      }
    }
  }

  // Only restore baseline emails proven to be sent by an unconditional submission rule,
  // and only after the real engine reported them as unexpected. Never erase failed expectations.
  for (const result of failures) {
    const test = bp.tests.find(test => test.key === result.test);
    if (!test || !['happy_path','timeout','rejection'].includes(test.kind) || !test.expect.emails) continue;
    const submissions = bp.workflow.transitions.filter(t => t.from === initial && t.trigger.on === 'submission');
    if (submissions.length !== 1 || submissions[0]!.when) continue;
    const baseline = submissions[0]!.actions.flatMap(a => a.do === 'send_email' ? [a.template] : []);
    for (const failure of result.failures) {
      const email = failure.match(/^unexpected email "([^"]+)" was produced$/)?.[1];
      if (!email || !baseline.includes(email) || test.expect.emails.includes(email)) continue;
      test.expect.emails.push(email);
      changes.push({at:`tests.${test.key}.expect.emails`,change:`Included ${email}, the submission email confirmed by the engine. All other assertions remain.`});
    }
  }
  return {blueprint:bp,changes};
}
