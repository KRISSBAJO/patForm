import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { repairBlueprint } from '../src/ai/repair.js';
import { verifiedRepair } from '../src/ai/verified-repair.js';
import { validate } from '../src/compiler/validate.js';
import { validateAnswers } from '../src/blueprint/answers.js';
import type { ScenarioResult } from '../src/runtime/scenarios.js';

const fixture = () => Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json','utf8')));
const result = (bp: Blueprint, passed = true, failures: string[] = []): ScenarioResult[] => bp.tests.map(t=>({process:bp.key,test:t.key,kind:t.kind,passed,failures}));

test('repair records an authorized operator choice for a declared guarded route',()=>{
  const bp=fixture();
  bp.data.fields.push({key:'stop_recommended',label:'Stop recommended',type:'yes_no',setBy:'operator',classification:'internal'});
  const inspector=bp.roles.find(r=>r.key==='it_operator')!;
  inspector.capabilities.push('edit');inspector.editableFields=[...inspector.editableFields??[],'stop_recommended'];
  bp.workflow.transitions.push({key:'chosen_safety_route',from:'manager_review',to:'hr_review',trigger:{on:'manual',by:['it_operator']},when:{op:'eq',left:{field:'stop_recommended'},right:{literal:true}},actions:[]});
  const testCase=bp.tests.find(t=>t.kind==='happy_path')!;
  testCase.steps.splice(1,0,{step:'manual',as:'it_operator',transition:'chosen_safety_route'});
  const fixed=repairBlueprint(bp);
  const index=fixed.blueprint.tests.find(t=>t.key===testCase.key)!.steps.findIndex(s=>s.step==='manual'&&s.transition==='chosen_safety_route');
  assert.ok(index>0);
  assert.deepEqual(fixed.blueprint.tests.find(t=>t.key===testCase.key)!.steps[index-1],{step:'edit',as:'it_operator',answers:{stop_recommended:true}});
  assert.ok(!bp.tests.find(t=>t.key===testCase.key)!.steps.some(s=>s.step==='edit'&&s.answers.stop_recommended===true));
});

test('file fixture repair targets engine failures and preserves real evidence requirements',async()=>{
  const bp=fixture();
  const photo={key:'photo',label:'Photo',type:'file' as const,setBy:'respondent' as const,classification:'internal' as const,required:true};
  bp.data.fields.push(photo,{key:'defects',label:'Defects',type:'repeating_group',setBy:'respondent',classification:'internal',fields:[{...photo,key:'defect_photo'}]});
  bp.experience.pages[0]!.sections[0]!.fields.push('photo','defects');
  const happy=bp.tests.find(t=>t.kind==='happy_path')!;
  const missing=bp.tests.find(t=>t.kind==='missing_data')!;
  for(const t of [happy,missing]) t.steps=[{step:'submit',answers:{photo:'cover.jpg',defects:[{defect_photo:['defect.jpg']}]}}];
  const before=JSON.stringify(bp); let runs=0;
  assert.equal(validate(bp).publishable,true,JSON.stringify(validate(bp).errors));
  const fixed=await verifiedRepair(bp,async candidate=>{
    runs++;
    const step=candidate.tests.find(t=>t.key===happy.key)!.steps[0]!;
    assert.ok(step.step==='submit');
    return result(candidate).map(s=>s.test===happy.key && step.answers.photo==='cover.jpg'
      ? {...s,passed:false,failures:['submission was rejected for missing fields: photo, defects[0].defect_photo']} : s);
  });
  assert.equal(runs,2);
  assert.equal(fixed.ready,true);
  const step=fixed.blueprint.tests.find(t=>t.key===happy.key)!.steps[0]!;
  assert.ok(step.step==='submit');
  assert.match(String(step.answers.photo),/^receipt-file:/);
  assert.match(String((step.answers.defects as {defect_photo:string[]}[])[0]!.defect_photo[0]),/^receipt-file:/);
  assert.deepEqual(fixed.blueprint.tests.find(t=>t.key===missing.key),missing);
  assert.deepEqual(fixed.blueprint.data.fields,bp.data.fields);
  assert.deepEqual(fixed.blueprint.tests.find(t=>t.key===happy.key)!.expect,happy.expect);
  assert.equal(JSON.stringify(bp),before);
  assert.equal(repairBlueprint(bp).changes.filter(c=>c.at.includes('.answers.photo')).length,0);
});

test('repair updates expired sample dates only in scenarios the engine rejected',()=>{
  const bp=fixture();
  bp.data.fields.push({key:'needed_by',label:'Needed by',type:'date',required:true,setBy:'respondent',classification:'internal',constraints:{minDaysFromToday:1}});
  bp.experience.pages[0]!.sections[0]!.fields.push('needed_by');
  const happy=bp.tests.find(t=>t.kind==='happy_path')!;
  const duplicate=bp.tests.find(t=>t.kind==='duplicate')!;
  const missing=bp.tests.find(t=>t.kind==='missing_data')!;
  for(const testCase of [happy,duplicate,missing]) for(const step of testCase.steps) if(step.step==='submit') step.answers.needed_by='2026-07-01';
  const before=JSON.stringify(bp);
  const failures=[happy,duplicate].map(testCase=>({process:bp.key,test:testCase.key,kind:testCase.kind,passed:false,failures:['submission was rejected for missing fields: needed_by']}));
  const repaired=repairBlueprint(bp,failures).blueprint;
  for(const testCase of [happy,duplicate]) for(const step of repaired.tests.find(t=>t.key===testCase.key)!.steps) if(step.step==='submit') {
    assert.equal(step.answers.needed_by,'2026-10-01');
    assert.ok(!validateAnswers(repaired,step.answers,{now:new Date('2026-09-21T09:00:00Z')}).some(error=>error.field==='needed_by'));
    assert.ok(!validateAnswers(repaired,{...step.answers,needed_by:'2026-09-22'},{now:new Date('2026-09-21T09:00:00Z')}).some(error=>error.field==='needed_by'), 'scenario validation uses its simulated date');
  }
  assert.equal((repaired.tests.find(t=>t.key===missing.key)!.steps[0] as {answers:Record<string,unknown>}).answers.needed_by,'2026-07-01');
  assert.equal(JSON.stringify(bp),before);
  assert.equal(repairBlueprint(repaired,failures).changes.filter(change=>change.at.includes('needed_by')).length,0);
});

test('repair removes an empty duplicate while preserving actions and the input',()=>{
  const bp = fixture();
  const original = bp.workflow.transitions.find(t=>t.trigger.on==='submission')!;
  bp.workflow.transitions.push({...structuredClone(original),key:'accidental_duplicate',actions:[]});
  const before = JSON.stringify(bp);
  const fixed = repairBlueprint(bp);
  assert.equal(fixed.blueprint.workflow.transitions.filter(t=>t.from===original.from && t.to===original.to && t.trigger.on==='submission').length,1);
  assert.deepEqual(fixed.blueprint.workflow.transitions.find(t=>t.key===original.key)!.actions,original.actions);
  assert.equal(JSON.stringify(bp),before);
  assert.equal(repairBlueprint(fixed.blueprint).changes.length,0);
});

test('repair preserves competing destinations and rules named by manual tests',()=>{
  const bp = fixture();
  const original = bp.workflow.transitions[0]!;
  bp.workflow.transitions.push({...structuredClone(original),key:'different_destination',to:bp.intent.completionState});
  bp.workflow.transitions.push({...structuredClone(original),key:'manual_reference',actions:[]});
  bp.tests[0]!.steps.push({step:'manual',transition:'manual_reference',as:bp.roles[0]!.key});
  const fixed = repairBlueprint(bp).blueprint;
  assert.ok(fixed.workflow.transitions.some(t=>t.key==='different_destination'));
  assert.ok(fixed.workflow.transitions.some(t=>t.key==='manual_reference'));
});

function missingFixture() {
  const bp = fixture();
  bp.data.fields.push({key:'sample_route',label:'Sample route',type:'single_choice',setBy:'respondent',classification:'internal',choices:[{value:'standard',label:'Standard'},{value:'urgent',label:'Urgent'}]});
  const submitRule = bp.workflow.transitions.find(t=>t.trigger.on==='submission')!;
  submitRule.when = {op:'eq',left:{field:'sample_route'},right:{literal:'standard'}};
  submitRule.actions.push({do:'create_task',task:'issue_equipment'});
  const t = bp.tests.find(t=>t.kind==='happy_path')!;
  t.steps = [t.steps.find(s=>s.step==='submit')!,{step:'complete_task',task:'issue_equipment',as:'it_operator'}];
  return bp;
}

test('missing scenario answers follow a unique declared task route',()=>{
  const bp = missingFixture();
  const repaired = repairBlueprint(bp).blueprint;
  const submit = repaired.tests.find(t=>t.kind==='happy_path')!.steps[0]!;
  assert.ok(submit.step==='submit');
  assert.equal(submit.answers.sample_route,'standard');
  for(const t of repaired.tests.filter(t=>['missing_data','permission','duplicate'].includes(t.kind))) {
    assert.deepEqual(t.steps,bp.tests.find(old=>old.key===t.key)!.steps);
  }
});

test('repair does not fabricate operator inputs or replace explicit answers',()=>{
  const bp = missingFixture();
  bp.data.fields.find(f=>f.key==='sample_route')!.setBy='operator';
  assert.ok(!repairBlueprint(bp).changes.some(c=>c.at.endsWith('sample_route')));
  bp.data.fields.find(f=>f.key==='sample_route')!.setBy='respondent';
  const submit=bp.tests.find(t=>t.kind==='happy_path')!.steps[0]!;
  assert.ok(submit.step==='submit'); submit.answers.sample_route='urgent';
  const repaired=repairBlueprint(bp).blueprint.tests.find(t=>t.kind==='happy_path')!.steps[0]!;
  assert.ok(repaired.step==='submit'); assert.equal(repaired.answers.sample_route,'urgent');
});

test('baseline email repair adds only engine-proven submission expectations',()=>{
  const bp = fixture();
  const t=bp.tests.find(t=>t.kind==='happy_path')!;
  t.expect.emails=['welcome_packet'];
  const failure:ScenarioResult={process:bp.key,test:t.key,kind:t.kind,passed:false,failures:['unexpected email "submission_receipt" was produced','unexpected email "unknown_email" was produced','expected email "welcome_packet" was not produced']};
  const repaired=repairBlueprint(bp,[failure]);
  assert.deepEqual(repaired.blueprint.tests.find(s=>s.key===t.key)!.expect.emails,['welcome_packet','submission_receipt']);
  assert.deepEqual(t.expect.emails,['welcome_packet']);
});

test('verified repair reruns after fixing expectations and returns the tested version',async()=>{
  const bp=fixture(); const happy=bp.tests.find(t=>t.kind==='happy_path')!;
  happy.expect.emails=happy.expect.emails!.filter(k=>k!=='submission_receipt');
  let runs=0;
  const repaired=await verifiedRepair(bp,async candidate=>{
    runs++;
    return result(candidate).map(s=>s.test===happy.key && !candidate.tests.find(t=>t.key===happy.key)!.expect.emails!.includes('submission_receipt') ? {...s,passed:false,failures:['unexpected email "submission_receipt" was produced']} : s);
  });
  assert.equal(runs,2); assert.equal(repaired.ready,true);
  assert.ok(repaired.changes.some(c=>c.change.includes('submission_receipt')));
});

test('unrepairable errors and failures never become a successful repair',async()=>{
  const bp=fixture(); bp.workflow.states.push({key:'unreachable',name:'Unreachable',type:'active'});
  let runs=0;
  const invalid=await verifiedRepair(bp,async candidate=>{runs++;return result(candidate);});
  assert.equal(runs,0); assert.equal(invalid.ready,false); assert.ok(invalid.questions.length);
  const failed=await verifiedRepair(fixture(),async candidate=>result(candidate,false,['expected task was not created']));
  assert.equal(failed.ready,false);
});

function staffFixture() {
  const bp=missingFixture();
  const f=bp.data.fields.find(f=>f.key==='sample_route')!;
  f.setBy='operator';
  // Move the operator condition after submission, as in incident triage.
  const submit=bp.workflow.transitions.find(t=>t.trigger.on==='submission')!;
  delete submit.when;
  submit.actions=submit.actions.filter(a=>a.do!=='create_task');
  bp.workflow.transitions.unshift({key:'triage_fixture',from:submit.to,to:'provisioning',trigger:{on:'record_updated'},when:{op:'eq',left:{field:f.key},right:{literal:'standard'}},actions:[{do:'create_task',task:'issue_equipment'}]});
  const editor=bp.roles.find(r=>r.key==='hiring_manager')!;
  editor.capabilities.push('edit');editor.editableFields=[...(editor.editableFields ?? []),f.key];
  return bp;
}

test('repair adds an authorized staff fixture step without exposing operator fields on submission',()=>{
  const bp=staffFixture();
  const fixed=repairBlueprint(bp);
  const t=fixed.blueprint.tests.find(t=>t.kind==='happy_path')!;
  assert.deepEqual(t.steps[1],{step:'edit',as:'hiring_manager',answers:{sample_route:'standard'}});
  assert.deepEqual(fixed.blueprint.roles,bp.roles);
  assert.deepEqual(fixed.blueprint.workflow,bp.workflow);
  assert.equal(repairBlueprint(fixed.blueprint).changes.length,0);
});

test('ambiguous staff authority produces a picker and a valid choice continues repair',()=>{
  const bp=staffFixture();
  const second=bp.roles.find(r=>r.key==='hr_approver')!;
  second.capabilities.push('edit');second.editableFields=[...(second.editableFields ?? []),'sample_route'];
  const pending=repairBlueprint(bp);
  assert.equal(pending.decisions.length,1);
  const decision=pending.decisions[0]!;
  assert.deepEqual(decision.roles.map(r=>r.key).sort(),['hiring_manager','hr_approver']);
  const fixed=repairBlueprint(bp,[],{staff:{[decision.key]:'hr_approver'}});
  assert.equal(fixed.decisions.length,0);
  assert.equal((fixed.blueprint.tests.find(t=>t.kind==='happy_path')!.steps[1] as {as:string}).as,'hr_approver');
  assert.equal(repairBlueprint(bp,[],{staff:{[decision.key]:'it_operator'}}).decisions.length,1,'a choice cannot grant editing permission');
});

test('staff test edit is schema supported and compiler rejects an unauthorized writer',()=>{
  const bp=fixture();
  bp.tests[0]!.steps.splice(1,0,{step:'edit',as:'new_hire',answers:{full_name:'Changed'}});
  assert.equal(Blueprint.safeParse(bp).success,true);
  assert.ok(validate(bp).items.some(d=>d.code==='TEST004'));
});
test('repair expands a positive test task answer across mandatory checklist rows',()=>{
  const bp=fixture();
  bp.data.fields.push({key:'handover_rows',label:'Handover rows',type:'repeating_group',classification:'internal',setBy:'respondent',required:true,
    requiredChoices:{field:'kind',values:['certificate','warranty']},fields:[
      {key:'kind',label:'Kind',type:'single_choice',classification:'internal',setBy:'respondent',choices:[{value:'certificate',label:'Certificate'},{value:'warranty',label:'Warranty'}]},
      {key:'verified',label:'Verified',type:'yes_no',classification:'internal',setBy:'operator'},
    ]});
  bp.experience.pages[0]!.sections[0]!.fields.push('handover_rows');
  bp.workflow.tasks.find(task=>task.key==='issue_equipment')!.requiredFields=['verified'];
  const happy=bp.tests.find(test=>test.kind==='happy_path')!;
  happy.steps.push({step:'complete_task',task:'issue_equipment',as:'it_operator',answers:{verified:true}});
  const fixed=repairBlueprint(bp).blueprint.tests.find(test=>test.key===happy.key)!;
  const completion=fixed.steps.at(-1)!;
  assert.equal(completion.step,'complete_task');
  assert.deepEqual(completion.answers,{handover_rows:[{verified:true},{verified:true}]});
  assert.deepEqual(bp.tests.find(test=>test.key===happy.key)!.steps.at(-1),{step:'complete_task',task:'issue_equipment',as:'it_operator',answers:{verified:true}});
  const permission=bp.tests.find(test=>test.kind==='permission')!;
  permission.steps.push({step:'complete_task',task:'issue_equipment',as:'it_operator',answers:{verified:true}});
  permission.steps.push({step:'permission',action:'approve',as:'it_operator',expectDenied:true});
  const checked=repairBlueprint(bp).blueprint.tests.find(test=>test.key===permission.key)!;
  assert.deepEqual(checked.steps.at(-2),{step:'complete_task',task:'issue_equipment',as:'it_operator',answers:{handover_rows:[{verified:true},{verified:true}]}});
  assert.deepEqual(checked.steps.at(-1),permission.steps.at(-1));
});
test('repair expects only engine-proven outputs from a route named by the test',()=>{
  const bp=fixture();
  const happy=bp.tests.find(test=>test.kind==='happy_path')!;
  const route=bp.workflow.transitions.find(route=>route.trigger.on==='manual')!;
  route.actions.push({do:'send_email',key:'manual_notice',template:'submission_receipt'});
  happy.steps.push({step:'manual',as:'it_operator',transition:route.key});
  happy.expect.emails=['welcome_packet'];
  const result:ScenarioResult={process:bp.key,test:happy.key,kind:happy.kind,passed:false,failures:[
    'unexpected email "submission_receipt" was produced','unexpected email "unrelated" was produced',
  ]};
  const repaired=repairBlueprint(bp,[result]).blueprint.tests.find(test=>test.key===happy.key)!;
  assert.deepEqual(repaired.expect.emails,['welcome_packet','submission_receipt']);
});
test('repair expects an engine-proven email caused by an explicit task completion',()=>{
  const bp=fixture();
  const happy=bp.tests.find(test=>test.kind==='happy_path')!;
  const route=bp.workflow.transitions[0]!;
  bp.workflow.transitions.push({key:'after_equipment',from:route.from,to:route.to,
    trigger:{on:'task_completed',task:'issue_equipment'},actions:[{do:'send_email',key:'reinspect_notice',template:'submission_receipt'}]});
  happy.expect.emails=['welcome_packet'];
  const result:ScenarioResult={process:bp.key,test:happy.key,kind:happy.kind,passed:false,failures:[
    'unexpected email "submission_receipt" was produced','unexpected email "unrelated" was produced',
  ]};
  const repaired=repairBlueprint(bp,[result]).blueprint.tests.find(test=>test.key===happy.key)!;
  assert.deepEqual(repaired.expect.emails,['welcome_packet','submission_receipt']);
});

test('approval fixture records its declared decision through existing staff edit authority',()=>{
  const bp=fixture();
  bp.data.fields.push({key:'approval_decision',label:'Recorded decision',type:'dropdown',classification:'internal',setBy:'operator',choices:[{value:'approved',label:'Approved'},{value:'rejected',label:'Rejected'}]});
  const rule=bp.workflow.transitions.find(t=>t.trigger.on==='approval_decided' && t.trigger.approval==='manager_approval' && t.trigger.decision==='approved')!;
  rule.when={op:'eq',left:{field:'approval_decision'},right:{literal:'approved'}};
  const role=bp.roles.find(r=>r.key==='hiring_manager')!;
  role.capabilities.push('edit');role.editableFields=[...(role.editableFields??[]),'approval_decision'];
  const fixed=repairBlueprint(bp);
  assert.deepEqual(fixed.blueprint.tests.find(t=>t.kind==='happy_path')!.steps[1],{step:'edit',as:'hiring_manager',answers:{approval_decision:'approved'}});
  assert.deepEqual(fixed.blueprint.workflow,bp.workflow);
  assert.equal(repairBlueprint(fixed.blueprint).changes.length,0);
});


