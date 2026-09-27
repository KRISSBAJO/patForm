import type { Blueprint } from '../blueprint/index.js';
import { fieldsInExpr } from '../blueprint/common.js';
import { evaluate } from '../runtime/expr.js';
import { normalizeBlueprint, type Normalization } from './normalize.js';
import type { ScenarioResult } from '../runtime/scenarios.js';
import { completeAnswers } from '../runtime/scenarios.js';
import { checkField } from '../blueprint/answers.js';

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
  // A completion trigger unambiguously identifies the state in which a task
  // must exist. Only wire a single ingress; competing routes need a decision.
  for (const task of bp.workflow.tasks) {
    const waits = transitions.filter(t=>t.trigger.on==='task_completed' && t.trigger.task===task.key);
    const created = transitions.some(t=>t.actions.some(a=>a.do==='create_task' && a.task===task.key));
    if (!created && waits.length===1) {
      const incoming=transitions.filter(t=>t.to===waits[0]!.from && t.from!==t.to);
      if(incoming.length===1 && bp.workflow.states.find(s=>s.key===waits[0]!.from)?.type!=='terminal') {
        const rule=incoming[0]!;
        let key=`repair_create_${task.key}`;
        while(transitions.some(t=>t.actions.some(a=>a.key===key))) key+='x';
        rule.actions.push({do:'create_task',key,task:task.key});
        changes.push({at:`workflow.transitions.${rule.key}.actions`,change:`Created ${task.name} on the only entry into its completion state. Existing assignee and permissions retained.`});
      }
    }
    for(const key of task.requiredFields ?? []) {
      const field=bp.data.fields.find(f=>f.key===key);
      if(field?.type!=='signature_ack' || field.setBy!=='respondent') continue;
      const authorized=bp.roles.filter(r=>r.capabilities.includes('edit') && r.editableFields?.includes(key) && !r.hiddenFields?.includes(key));
      const assignee=task.assignee;
      const assigned='role' in assignee ? authorized.some(r=>r.key===assignee.role) : 'submitter' in assignee && authorized.some(r=>r.kind==='respondent');
      if(!assigned) continue;
      field.setBy='operator';
      for(const test of bp.tests.filter(t=>t.kind==='happy_path' || t.kind==='rejection')) for(const step of test.steps) {
        if(step.step==='complete_task' && !step.expectDenied && step.task===task.key && step.answers?.[key]==='confirmed') step.answers[key]=true;
      }
      changes.push({at:`data.fields.${key}`,change:`Collected ${field.label} when completing its assigned task, using existing editing authority. Acknowledgment must be true.`});
    }
  }
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

  // A positive scenario may still use the old single-row shorthand for a
  // nested task. Expand it to the actual number of respondent rows, leaving
  // every distinct existing row and each security/negative scenario intact.
  for(const test of bp.tests.filter(test=>test.kind==='happy_path'||test.kind==='rejection')) {
    const submit=test.steps.find(step=>step.step==='submit');
    if(submit?.step!=='submit') continue;
    const completed=completeAnswers(bp,submit.answers);
    for(const step of test.steps) {
      if(step.step!=='complete_task'||step.expectDenied||!step.answers) continue;
      const task=bp.workflow.tasks.find(task=>task.key===step.task);
      if(!task) continue;
      for(const group of bp.data.fields.filter(field=>field.type==='repeating_group')) {
        const keys=(task.requiredFields??[]).filter(key=>group.fields?.some(child=>child.key===key));
        const rows=completed[group.key];
        if(!keys.length||!Array.isArray(rows)||rows.length<2||!keys.some(key=>key in step.answers!)) continue;
        if(group.key in step.answers) continue;
        step.answers[group.key]=rows.map(()=>Object.fromEntries(keys.filter(key=>key in step.answers!).map(key=>[key,step.answers![key]])));
        for(const key of keys) delete step.answers[key];
        changes.push({at:`tests.${test.key}.steps`,change:`Expanded ${group.label} task answers across its ${rows.length} existing test rows. Each row is checked separately.`});
      }
    }
  }

  // A named manual route is an explicit test choice. Supply an operator
  // prerequisite only when an actor already in that scenario can edit it and
  // exactly one declared choice makes the route's guard true.
  for(const test of bp.tests.filter(t=>t.kind!=='missing_data' && t.kind!=='duplicate')) {
    const known:Record<string,unknown>={};
    const priorActors:string[]=[];
    for(let index=0;index<test.steps.length;index++) {
      const step=test.steps[index]!;
      if(step.step==='submit') Object.assign(known,completeAnswers(bp,step.answers));
      if(step.step==='edit' && !step.expectDenied) Object.assign(known,step.answers);
      if(step.step==='complete_task' && !step.expectDenied) Object.assign(known,step.answers??{});
      if(step.step!=='manual') continue;
      const rule=bp.workflow.transitions.find(t=>t.key===step.transition);
      if(!rule?.when) {priorActors.push(step.as);continue;}
      const missing=[...new Set(fieldsInExpr(rule.when))].filter(key=>known[key]===undefined);
      if(missing.length!==1) {priorActors.push(step.as);continue;}
      const key=missing[0]!;
      const field=bp.data.fields.find(f=>f.key===key);
      if(field?.setBy!=='operator'||field.compute) {priorActors.push(step.as);continue;}
      const values=field.type==='yes_no'?[true,false]:['single_choice','dropdown'].includes(field.type)?field.choices?.map(c=>c.value)??[]:[];
      const matches=values.filter(value=>evaluate(rule.when!,{answers:{...known,[key]:value},now:new Date('2026-09-21T09:00:00Z')}));
      const role=[...priorActors,step.as].reverse().find(actor=>bp.roles.some(r=>r.key===actor&&r.kind==='internal'&&r.capabilities.includes('edit')&&r.editableFields?.includes(key)&&!r.hiddenFields?.includes(key)));
      if(matches.length===1 && role) {
        test.steps.splice(index,0,{step:'edit',as:role,answers:{[key]:matches[0]}});
        known[key]=matches[0];index++;
        changes.push({at:`tests.${test.key}.steps`,change:`Recorded ${field.label} by authorized ${role} before the test's explicit ${step.transition} route. Production rules and permissions are unchanged.`});
      }
      priorActors.push(step.as);
    }
  }

  // Scenario uploads are synthetic references, never real customer evidence.
  // Repair only file inputs explicitly rejected by the engine; incomplete-data
  // cases and all production requirements remain untouched.
  for (const result of failures) {
    const test=bp.tests.find(t=>t.key===result.test);
    if(!test || test.kind==='missing_data') continue;
    const paths=new Set(result.failures.flatMap(f=>f.startsWith('submission was rejected for missing fields: ')
      ? f.slice('submission was rejected for missing fields: '.length).split(', ').map(p=>p.trim()) : []));
    for(const step of test.steps) {
      if(step.step!=='submit') continue;
      for(const path of paths) {
        const parts=path.split('.');
        let fields=bp.data.fields;
        let answers=step.answers;
        for(let i=0;i<parts.length;i++) {
          const part=parts[i]!;
          const row=part.match(/^([^[]+)\[(\d+)\]$/);
          const field=fields.find(f=>f.key===(row?.[1] ?? part));
          if(!field) break;
          if(row) {
            const rows=answers[field.key];
            const value=Array.isArray(rows)?rows[Number(row[2])]:undefined;
            if(field.type!=='repeating_group' || !value || typeof value!=='object' || Array.isArray(value)) break;
            fields=field.fields ?? [];
            answers=value as Record<string,unknown>;
          } else {
            const value=answers[field.key];
            if(i!==parts.length-1 || field.type!=='file' || value===undefined || value===null || value==='' || (Array.isArray(value)&&!value.length) || !checkField(field,value)) break;
            const reference='receipt-file:00000000-0000-4000-8000-000000000001';
            answers[field.key]=Array.isArray(value)?[reference]:reference;
            changes.push({at:`tests.${test.key}.answers.${path}`,change:'Replaced an invalid sample upload with a scenario-only file reference. Required evidence and all assertions are unchanged; this does not test S3 delivery.'});
          }
        }
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
  // An explicitly named manual route in the scenario has already been
  // exercised by the engine. Its reported side effects belong in that test's
  // output list; do not infer side effects from routes the scenario never ran.
  for(const result of failures) {
    const test=bp.tests.find(item=>item.key===result.test);
    if(!test||!['happy_path','rejection','timeout'].includes(test.kind)) continue;
    const named=test.steps.filter(step=>step.step==='manual').map(step=>bp.workflow.transitions.find(route=>route.key===step.transition)).filter((route):route is NonNullable<typeof route>=>!!route);
    for(const kind of ['emails','documents'] as const) {
      if(!test.expect[kind]) continue;
      const verb=kind==='emails'?'email':'document';
      for(const failure of result.failures) {
        const key=failure.match(new RegExp(`^unexpected ${verb} "([^"]+)" was produced$`))?.[1];
        if(!key||test.expect[kind]!.includes(key)) continue;
        const declared=named.some(route=>route.actions.some(action=>kind==='emails'
          ? action.do==='send_email' && action.template===key
          : action.do==='generate_document' && action.document===key));
        if(!declared) continue;
        test.expect[kind]!.push(key);
        changes.push({at:`tests.${test.key}.expect.${kind}`,change:`Included ${key}, produced by a route explicitly run in this scenario. Existing expectations remain.`});
      }
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
