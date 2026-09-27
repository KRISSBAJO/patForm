import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { repairBlueprint } from '../src/ai/repair.js';
import { verifiedRepair } from '../src/ai/verified-repair.js';
import type { ScenarioResult } from '../src/runtime/scenarios.js';

const fixture = () => Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json','utf8')));
const result = (bp: Blueprint, passed = true, failures: string[] = []): ScenarioResult[] => bp.tests.map(t=>({process:bp.key,test:t.key,kind:t.kind,passed,failures}));

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
