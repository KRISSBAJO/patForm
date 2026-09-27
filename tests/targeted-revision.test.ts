import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { applyTargetedRevision, proposeTargetedRevision } from '../src/ai/targeted-revision.js';
import { repairBlueprint } from '../src/ai/repair.js';

const fixture=()=>Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json','utf8')));
test('targeted repair changes only requested leaves and preserves source',()=>{
  const bp=fixture(); const before=JSON.stringify(bp);
  const next=applyTargetedRevision(bp,{changes:[{path:'/intent/retentionDays',value:365}]});
  assert.equal(next.intent.retentionDays,365);
  assert.deepEqual(next.roles,bp.roles); assert.deepEqual(next.documents,bp.documents);
  assert.equal(JSON.stringify(bp),before);
});
test('targeted repair rejects authority, content and unsafe paths',()=>{
  const bp=fixture();
  for(const path of ['/roles/0/editableFields','/documents','/data/fields','/workflow/tasks','/workflow/transitions/999/to','/intent/__proto__'])
    assert.throws(()=>applyTargetedRevision(bp,{changes:[{path,value:[]}]}));
});
test('targeted repair preserves security and output assertions',()=>{
  const bp=fixture();
  const protectedIndex=bp.tests.findIndex(t=>t.kind==='permission');
  assert.ok(protectedIndex>=0);
  assert.throws(()=>applyTargetedRevision(bp,{changes:[{path:`/tests/${protectedIndex}/steps`,value:[]}]}));
  const outputIndex=bp.tests.findIndex(t=>t.expect.documents?.length || t.expect.emails?.length);
  assert.ok(outputIndex>=0);
  assert.throws(()=>applyTargetedRevision(bp,{changes:[{path:`/tests/${outputIndex}/expect`,value:{...bp.tests[outputIndex]!.expect,documents:[],emails:[]}}]}));
});
test('provider repair requests a bounded patch instead of another blueprint',async()=>{
  const bp=fixture();
  const next=await proposeTargetedRevision({name:'fake',model:'test',maxOutputTokens:1000,generate:async request=>{
    assert.equal(request.stage,'targeted-repair');
    assert.ok(request.shape);
    return {parsed:{changes:[{path:'/intent/retentionDays',value:730}]},text:'',meta:{provider:'fake',model:'test',mode:'structured',latencyMs:1}};
  }},bp,'Retain for two years');
  assert.equal(next.intent.retentionDays,730);
});
test('targeted repair retries malformed patches with validation feedback before fallback',async()=>{
  const bp=fixture(); let calls=0;
  const next=await proposeTargetedRevision({name:'fake',model:'test',generate:async request=>{
    calls++;
    if(calls===2) {
      assert.match(request.user,/proposed patch was rejected/);
      assert.match(request.user,/Unrecognized key/);
    }
    return {text:'',parsed:{changes:[calls===1 ? {path:'/intent/retentionDays',value:365,expect:'unsupported'} : {path:'/intent/retentionDays',value:365}]},meta:{provider:'fake',model:'test',mode:'structured',latencyMs:1}};
  }},bp,'Retain for one year');
  assert.equal(calls,2); assert.equal(next.intent.retentionDays,365);
});
test('repair wires a task on a unique entry and is idempotent',()=>{
  const bp=fixture();
  bp.workflow.states.push({key:'unique_task_stage',name:'Task stage',type:'active'});
  const entry={...structuredClone(bp.workflow.transitions[0]!),key:'unique_entry',to:'unique_task_stage'};
  bp.workflow.transitions.push(entry);
  bp.workflow.tasks.push({key:'missing_task',name:'Missing task',assignee:{role:'it_operator'},blocking:true,requiredFields:[],completableBy:'assignee'});
  bp.workflow.transitions.push({key:'missing_completion',from:entry.to,to:bp.intent.completionState,trigger:{on:'task_completed',task:'missing_task'},actions:[]});
  const next=repairBlueprint(bp).blueprint;
  assert.ok(next.workflow.transitions.find(t=>t.key===entry.key)!.actions.some(a=>a.do==='create_task' && a.task==='missing_task'));
  assert.deepEqual(next.roles,bp.roles);
  assert.equal(repairBlueprint(next).changes.length,0);
});
test('repair leaves ambiguous task entries for a decision',()=>{
  const bp=fixture(); const entry=bp.workflow.transitions[0]!;
  bp.workflow.transitions.push({...structuredClone(entry),key:'alternate',when:{op:'eq',left:{literal:1},right:{literal:2}}});
  bp.workflow.tasks.push({key:'missing_task',name:'Missing task',assignee:{role:'it_operator'},blocking:true,requiredFields:[],completableBy:'assignee'});
  bp.workflow.transitions.push({key:'missing_completion',from:entry.to,to:bp.intent.completionState,trigger:{on:'task_completed',task:'missing_task'},actions:[]});
  assert.ok(!repairBlueprint(bp).blueprint.workflow.transitions.some(t=>t.actions.some(a=>a.do==='create_task' && a.task==='missing_task')));
});
test('task acknowledgment uses existing authority without weakening denied tests',()=>{
  const bp=fixture();
  bp.data.fields.push({key:'receipt_ack',label:'Confirm receipt',type:'signature_ack',classification:'internal',setBy:'respondent'});
  bp.roles.find(r=>r.key==='it_operator')!.editableFields=['receipt_ack'];
  if(!bp.roles.find(r=>r.key==='it_operator')!.capabilities.includes('edit')) bp.roles.find(r=>r.key==='it_operator')!.capabilities.push('edit');
  const task=bp.workflow.tasks.find(t=>t.key==='issue_equipment')!;
  task.requiredFields=['receipt_ack'];
  const happy=bp.tests.find(t=>t.kind==='happy_path')!;
  happy.steps.push({step:'complete_task',task:task.key,as:'it_operator',answers:{receipt_ack:'confirmed'}});
  const denied=bp.tests.find(t=>t.kind==='permission')!;
  denied.steps.push({step:'complete_task',task:task.key,as:'it_operator',answers:{receipt_ack:'confirmed'},expectDenied:true});
  const next=repairBlueprint(bp).blueprint;
  assert.equal(next.data.fields.find(f=>f.key==='receipt_ack')!.setBy,'operator');
  const step=next.tests.find(t=>t.key===happy.key)!.steps.at(-1)!;
  assert.ok(step.step==='complete_task'); assert.equal(step.answers!.receipt_ack,true);
  assert.deepEqual(next.tests.find(t=>t.key===denied.key),denied);
  assert.deepEqual(next.roles,bp.roles);
  bp.roles.find(r=>r.key==='it_operator')!.editableFields=bp.roles.find(r=>r.key==='it_operator')!.editableFields!.filter(k=>k!=='receipt_ack');
  assert.equal(repairBlueprint(bp).blueprint.data.fields.find(f=>f.key==='receipt_ack')!.setBy,'respondent');
});
