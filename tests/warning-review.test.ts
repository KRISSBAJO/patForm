import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { reviewWarnings } from '../src/ai/warning-review.js';
import { verifiedRepair } from '../src/ai/verified-repair.js';
import { repairBlueprint } from '../src/ai/repair.js';
const fixture=()=>Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json','utf8')));
test('child fields use a real group input instead of a scalar',()=>{
  const bp=fixture();bp.data.fields.push({key:'risk_group',label:'Risk assessment',type:'short_text',classification:'internal',setBy:'operator',fields:[{key:'risk_note',label:'Risk note',type:'short_text',classification:'internal'}]});
  const fixed=repairBlueprint(bp);
  assert.equal(fixed.blueprint.data.fields.at(-1)!.type,'repeating_group');
  assert.equal(fixed.blueprint.data.fields.at(-1)!.fields![0]!.key,'risk_note');
  assert.equal(bp.data.fields.at(-1)!.type,'short_text');
});

test('missing collection requires an explicit staff choice before granting access',()=>{
  const bp=fixture();const role=bp.roles.find(r=>r.kind==='internal')!;
  bp.data.fields.push({key:'staff_notes',label:'Investigation notes',type:'long_text',classification:'confidential'});
  const before=JSON.stringify(bp.roles);
  let review=reviewWarnings(bp);
  assert.ok(review.decisions.some(d=>d.key==='review:collect:staff_notes'));
  assert.equal(JSON.stringify(bp.roles),before);
  review=reviewWarnings(bp,{'review:collect:staff_notes':'staff:made_up'});
  assert.ok(review.decisions.some(d=>d.key==='review:collect:staff_notes'));
  reviewWarnings(bp,{'review:collect:staff_notes':`staff:${role.key}`});
  assert.equal(bp.data.fields.at(-1)!.setBy,'operator');
  assert.ok(role.editableFields!.includes('staff_notes'));
});
test('sensitive visibility narrows read and edit authority, exports exclude only selected classifications',()=>{
  const bp=fixture();const internal=bp.roles.filter(r=>r.kind==='internal');
  bp.data.fields.push({key:'injury',label:'Basic injury detail',type:'long_text',classification:'restricted',setBy:'operator',collectionReason:'Safety review'});
  bp.intent.sensitivityCeiling='restricted';
  internal.forEach(r=>r.editableFields=[...(r.editableFields??[]),'injury']);
  bp.outputs.exportFields.push('injury');
  const review=reviewWarnings(bp,{'review:privacy:injury':internal[0]!.key,'review:exports':'exclude'});
  assert.ok(review.changes.length>=2);
  internal.slice(1).forEach(r=>{assert.ok(r.hiddenFields!.includes('injury'));assert.ok(!r.editableFields!.includes('injury'));});
  assert.ok(!bp.outputs.exportFields.includes('injury'));
});
test('review never pretends a deferred business decision changed the workflow',()=>{
  const bp=fixture();bp.intent.openDecisions=[{question:'Who closes a critical incident?',provisionally:'Executive sponsor',importance:'blocking'}];
  const workflow=JSON.stringify(bp.workflow);
  const review=reviewWarnings(bp,{'review:decision:0':'defer'});
  assert.equal(bp.intent.openDecisions.length,1);
  assert.equal(JSON.stringify(bp.workflow),workflow);
  assert.ok(review.accepted.some(d=>d.code==='BLD002'));
});
test('verified repair does not save while warning choices are unanswered, and retests chosen changes',async()=>{
  const bp=fixture();bp.intent.assumptions=[{statement:'Allow anonymous reports for this pilot',affects:'intake'}];
  const run=async(b:Blueprint)=>b.tests.map(t=>({process:b.key,test:t.key,kind:t.kind,passed:true,failures:[]}));
  const pending=await verifiedRepair(bp,run,{reviewWarnings:true});
  assert.equal(pending.ready,false);
  assert.equal(pending.scenarios.length,0,'unanswered choices do not start a redundant full test run');
  assert.ok(pending.decisions.some(d=>d.key==='review:assumptions'));
  const answers=Object.fromEntries(pending.decisions.map(d=>[d.key,d.roles[0]!.key]));
  const done=await verifiedRepair(bp,run,{reviewWarnings:true,staff:answers});
  assert.equal(done.ready,true);
  assert.equal(done.blueprint.intent.assumptions[0]!.confirmed,true);
  assert.equal(bp.intent.assumptions[0]!.confirmed,undefined);
});
test('retention has a bounded days input and actually updates the retention policy',()=>{
  const bp=fixture();bp.intent.openDecisions=[{question:'How long should completed requests be retained?',provisionally:'No retention set',importance:'review'}];
  assert.equal(reviewWarnings(bp).decisions.find(d=>d.key==='review:decision:0')!.kind,'days');
  const invalid=reviewWarnings(bp,{'review:decision:0':'-1'});
  assert.ok(invalid.decisions.some(d=>d.key==='review:decision:0'));
  assert.notEqual(bp.intent.retentionDays,-1);
  reviewWarnings(bp,{'review:decision:0':'365'});
  assert.equal(bp.intent.retentionDays,365);
  assert.equal(bp.intent.openDecisions.length,0);
});
test('review-order alternatives and custom behavior require a reviewed proposal, not automatic save',async()=>{
  const bp=fixture();bp.intent.openDecisions=[{question:'Should procurement happen before or after finance?',provisionally:'Procurement first',importance:'review'}];
  const pending=reviewWarnings(bp);
  const decision=pending.decisions.find(d=>d.key==='review:decision:0')!;
  assert.ok(decision.roles.some(r=>r.name==='Finance before Procurement'));
  const requested=reviewWarnings(bp,{'review:decision:0':decision.roles.find(r=>r.name==='Finance before Procurement')!.key});
  assert.match(requested.requests[0]!,/finance review is before procurement/);
  const result=await verifiedRepair(bp,async b=>b.tests.map(t=>({process:b.key,test:t.key,kind:t.kind,passed:true,failures:[]})),{reviewWarnings:true,staff:{'review:decision:0':'custom:Use two parallel specialist reviews instead.'}});
  assert.equal(result.ready,false);
  assert.equal(result.requests.length,1);
});
test('duplicate fixtures fill omitted required identity values without weakening assertions',()=>{
  const bp=fixture();bp.data.fields.push({key:'start_date',label:'Start date',type:'date',classification:'internal',required:true});
  bp.experience.pages[0]!.sections[0]!.fields.push('start_date');
  bp.data.identity=['start_date'];
  const duplicate=bp.tests.find(t=>t.kind==='duplicate')!;
  duplicate.steps.filter(s=>s.step==='submit').forEach(s=>delete s.answers.start_date);
  duplicate.expect.instanceCount=1;
  const fixed=repairBlueprint(bp).blueprint;
  const samples=fixed.tests.find(t=>t.key===duplicate.key)!.steps.filter(s=>s.step==='submit');
  assert.equal(samples[0]!.answers.start_date,'2026-10-01');
  assert.equal(samples[1]!.answers.start_date,'2026-10-01');
  assert.equal(fixed.tests.find(t=>t.key===duplicate.key)!.expect.instanceCount,1);
  assert.deepEqual(fixed.data.identity,['start_date']);
});
test('approver review lists only existing approval roles and updates routing without grants',()=>{
  const bp=fixture();const approval=bp.workflow.approvals[0]!;
  bp.intent.openDecisions=[{question:`Who should be the approver for ${approval.name}?`,provisionally:'Current role',importance:'review'}];
  const before=JSON.stringify(bp.roles);
  const question=reviewWarnings(bp).decisions.find(d=>d.key==='review:decision:0')!;
  assert.ok(question.roles.length>0);
  assert.ok(question.roles.every(r=>bp.roles.find(role=>role.key===r.key)!.capabilities.includes('approve')));
  const choice=question.roles[0]!.key;
  reviewWarnings(bp,{'review:decision:0':choice});
  assert.deepEqual(approval.approvers,[{role:choice}]);
  assert.equal(JSON.stringify(bp.roles),before);
  assert.equal(bp.intent.openDecisions.length,0);
});
