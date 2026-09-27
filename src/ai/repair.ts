import type { Blueprint } from '../blueprint/index.js';
import { fieldsInExpr } from '../blueprint/common.js';
import { evaluate } from '../runtime/expr.js';
import { normalizeBlueprint, type Normalization } from './normalize.js';
import type { ScenarioResult } from '../runtime/scenarios.js';
import { completeAnswers } from '../runtime/scenarios.js';

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};

/** Repairs mechanics and test fixtures. Never changes authorities, outcomes or existing answers. */
export interface RepairOptions { staff?: Record<string,string>; reviewWarnings?: boolean }
export interface RepairDecision { key:string; prompt:string; roles:{key:string;name:string}[]; kind?:'choice'|'roles'|'days'; detail?:string; group?:string; allowCustom?:boolean }
export function repairBlueprint(input: Blueprint, failures: ScenarioResult[] = [], options: RepairOptions = {}) {
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

  for (const test of bp.tests.filter(t=>t.kind==='duplicate' && t.expect.instanceCount===1)) {
    const submits=test.steps.filter(step=>step.step==='submit');
    if(submits.length!==2 || !bp.data.identity?.length) continue;
    const completed=completeAnswers(bp,submits[0]!.answers);
    // A duplicate fixture must repeat the declared identity. Preserve the policy,
    // first submission, and every assertion rather than weakening the expectation.
    for(const key of bp.data.identity) {
      const first=submits[0]!.answers[key]??completed[key];
      if(first===undefined || first==='' || first===null) continue;
      if(submits[0]!.answers[key]===undefined) {
        submits[0]!.answers[key]=structuredClone(first);
        changes.push({at:`tests.${test.key}.answers.${key}`,change:`Added the scenario runner's sample ${key} to the duplicate fixture's first submission.`});
      }
      if(canonical(submits[1]!.answers[key])===canonical(first)) continue;
      submits[1]!.answers[key]=structuredClone(first);
      changes.push({at:`tests.${test.key}.answers.${key}`,change:`Repeated ${key} in the duplicate test so it tests the existing duplicate policy. Expected record count remains one.`});
    }
  }

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

  const decisions = repairStaffFixtures(bp, changes, options);

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
  return {blueprint:bp,changes,decisions};
}

/** Fill gaps in positive scenario fixtures using existing staff authority, never production routing. */
function repairStaffFixtures(bp: Blueprint, changes: Normalization[], options:RepairOptions): RepairDecision[] {
  const decisions:RepairDecision[]=[];
  const initial = bp.workflow.states.find(s=>s.type === 'initial')?.key;
  if (!initial) return decisions;
  for (const test of bp.tests.filter(t=>['happy_path','rejection'].includes(t.kind))) {
    const submitIndex = test.steps.findIndex(s=>s.step === 'submit');
    const submit = test.steps[submitIndex];
    const taskIndex = test.steps.findIndex(s=>s.step === 'complete_task' && !s.expectDenied);
    const task = test.steps[taskIndex];
    if (submit?.step === 'submit' && task?.step === 'complete_task' && taskIndex > submitIndex) {
      const known = {...submit.answers};
      for (const step of test.steps.slice(submitIndex+1,taskIndex)) {
        if (step.step === 'edit' && !step.expectDenied) Object.assign(known,step.answers);
      }
      const routes: Blueprint['workflow']['transitions'][] = [];
      const walk = (state:string, path:Blueprint['workflow']['transitions'], visited:Set<string>) => {
        if (path.length >= 8 || routes.length > 8) return;
        for (const rule of bp.workflow.transitions.filter(t=>t.from===state && t.trigger.on===(path.length ? 'record_updated' : 'submission'))) {
          if (visited.has(rule.to)) continue;
          const next=[...path,rule];
          if (rule.actions.some(a=>a.do==='create_task' && a.task===task.task)) routes.push(next);
          else walk(rule.to,next,new Set([...visited,rule.to]));
        }
      };
      walk(initial,[],new Set([initial]));
      const candidates: {as:string;answers:Record<string,unknown>}[] = [];
      for (const path of routes) {
        // Expected messages disambiguate the declared standard versus critical test path.
        if (test.expect.emails && path.some(r=>r.actions.some(a=>a.do==='send_email' && !test.expect.emails!.includes(a.template)))) continue;
        const keys=[...new Set(path.flatMap(r=>r.when ? fieldsInExpr(r.when) : []))].filter(key=> {
          const f=bp.data.fields.find(f=>f.key===key);
          return f?.setBy==='operator' && !f.compute && (known[key]===undefined || known[key]==='');
        });
        if (!keys.length) continue;
        const roles=bp.roles.filter(r=>r.kind==='internal' && r.capabilities.includes('edit') && keys.every(key=>r.editableFields?.includes(key) && !r.hiddenFields?.includes(key)));
        if (!roles.length) continue;
        let samples:Record<string,unknown>[]=[{}];
        for (const key of keys) {
          const f=bp.data.fields.find(f=>f.key===key)!;
          const values=f.type==='yes_no' ? [false,true] : ['dropdown','single_choice'].includes(f.type) ? f.choices?.map(c=>c.value) ?? [] : [];
          samples=samples.flatMap(a=>values.map(value=>({...a,[key]:value}))).slice(0,64);
        }
        const answer=samples.find(a=>path.every(r=>!r.when || evaluate(r.when,{answers:{...known,...a},now:new Date('2026-09-21T09:00:00Z')})));
        if (answer) {
          const key=`${test.key}:${keys.sort().join(',')}`;
          const picked=roles.find(r=>r.key===options.staff?.[key]);
          if (roles.length===1 || picked) candidates.push({as:(picked ?? roles[0])!.key,answers:answer});
          else decisions.push({key,prompt:`Pick staff to update ${keys.map(k=>bp.data.fields.find(f=>f.key===k)?.label ?? k).join(', ')} in “${test.name}”.`,roles:roles.map(r=>({key:r.key,name:r.name}))});
        }
      }
      if (candidates.length===1) {
        const candidate=candidates[0]!;
        for (const key of Object.keys(candidate.answers)) delete submit.answers[key];
        test.steps.splice(submitIndex+1,0,{step:'edit',...candidate});
        changes.push({at:`tests.${test.key}.steps`,change:`Added a staff update by ${candidate.as} for ${Object.keys(candidate.answers).join(', ')} before the task path. Only sample test data changed.`});
      }
    }
    // An approval condition may also require a separately recorded decision.
    // Exercise that existing condition as the test's already-authorized approver.
    const known:Record<string,unknown>={};
    for (let i=0;i<test.steps.length;i++) {
      const step=test.steps[i]!;
      if (step.step==='submit' || (step.step==='edit' && !step.expectDenied) || (step.step==='complete_task' && !step.expectDenied)) Object.assign(known,step.answers ?? {});
      if (step.step!=='decide') continue;
      const field=bp.data.fields.find(f=>f.key==='approval_decision' && f.setBy==='operator' && !f.compute);
      if (!field || (known[field.key]!==undefined && known[field.key]!=='')) continue;
      const rules=bp.workflow.transitions.filter(t=>t.trigger.on==='approval_decided' && t.trigger.approval===step.approval && t.trigger.decision===step.decision);
      if (rules.length!==1) continue;
      const when=rules[0]!.when;
      if (!when || when.op!=='eq' || !('field' in when.left) || when.left.field!==field.key || !('literal' in when.right) || when.right.literal!==step.decision) continue;
      const role=bp.roles.find(r=>r.key===step.as && r.kind==='internal' && r.capabilities.includes('edit') && r.editableFields?.includes(field.key) && !r.hiddenFields?.includes(field.key));
      if (!role || !field.choices?.some(c=>c.value===step.decision)) continue;
      test.steps.splice(i,0,{step:'edit',as:role.key,answers:{[field.key]:step.decision}});
      known[field.key]=step.decision;
      i++;
      changes.push({at:`tests.${test.key}.steps`,change:`Added the test's recorded ${step.decision} decision by ${role.key} before approval. Production conditions and permissions are unchanged.`});
    }
  }
  return decisions.filter((d,i)=>decisions.findIndex(other=>other.key===d.key)===i);
}
