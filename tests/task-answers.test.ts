import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Blueprint} from '../src/blueprint/index.js';
import {collectTaskAnswers} from '../src/runtime/task-answers.js';
import {withCalculatedFields} from '../src/runtime/expr.js';

const fixture=()=>{
  const bp=Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json','utf8')));
  bp.data.fields.push({key:'defects',label:'Defects',type:'repeating_group',setBy:'respondent',classification:'internal',fields:[
    {key:'title',label:'Title',type:'short_text',setBy:'respondent',classification:'internal'},
    {key:'correction',label:'Correction',type:'long_text',setBy:'operator',classification:'internal'},
    {key:'verified',label:'Verified',type:'yes_no',setBy:'operator',classification:'internal'},
    {key:'repair_photo',label:'Repair photo',type:'file',setBy:'operator',classification:'internal'},
  ]});
  const role=bp.roles.find(r=>r.key==='it_operator')!;
  role.editableFields=[...role.editableFields??[],'correction','verified','repair_photo'];
  return bp;
};

test('task collects each row independently and leaves original evidence intact',()=>{
  const bp=fixture();
  const current={defects:[{title:'First',evidence:'original-a'},{title:'Second',evidence:'original-b'}]};
  const result=collectTaskAnswers(bp,['correction','verified'],current,{defects:[
    {correction:'Fixed first',verified:true},{correction:'Fixed second',verified:false}
  ]},['it_operator']);
  assert.deepEqual(result.merged.defects,[
    {title:'First',evidence:'original-a',correction:'Fixed first',verified:true},
    {title:'Second',evidence:'original-b',correction:'Fixed second',verified:false}
  ]);
  assert.deepEqual(current.defects,[{title:'First',evidence:'original-a'},{title:'Second',evidence:'original-b'}]);
  assert.deepEqual(result.touched,['defects']);
});

test('task rejects a flat answer when multiple rows need separate work',()=>{
  const bp=fixture();
  assert.throws(()=>collectTaskAnswers(bp,['correction'],{defects:[{title:'First'},{title:'Second'}]},{correction:'one answer'},['it_operator']),/multiple rows/);
});

test('task keeps separate uploaded evidence on each defect row',()=>{
  const bp=fixture();
  const a='receipt-file:00000000-0000-4000-8000-000000000001';
  const b='receipt-file:00000000-0000-4000-8000-000000000002';
  const current={defects:[{title:'First'},{title:'Second'}]};
  const result=collectTaskAnswers(bp,['repair_photo'],current,{defects:[{repair_photo:a},{repair_photo:b}]},['it_operator']);
  assert.deepEqual(result.merged.defects,[{title:'First',repair_photo:a},{title:'Second',repair_photo:b}]);
  assert.deepEqual(current.defects,[{title:'First'},{title:'Second'}]);
  assert.throws(()=>collectTaskAnswers(bp,['repair_photo'],current,{defects:[{repair_photo:'https://example.com/photo.jpg'},{repair_photo:b}]},['it_operator']),/Upload the actual file/);
});

test('task cannot replace a row, modify unrelated fields or act without editing authority',()=>{
  const bp=fixture();
  const current={defects:[{title:'Original'}]};
  assert.throws(()=>collectTaskAnswers(bp,['correction'],current,{defects:[{title:'Changed',correction:'Fixed'}]},['it_operator']),/does not collect/);
  assert.throws(()=>collectTaskAnswers(bp,['correction'],current,{defects:[{correction:'Fixed'}]},['hiring_manager']),/cannot edit/);
  assert.throws(()=>collectTaskAnswers(bp,['correction'],current,{defects:[]},['it_operator']),/one answer for each/);
  assert.throws(()=>collectTaskAnswers(bp,['correction'],current,{defects:[{correction:''}]},['it_operator']),/required/);
  bp.roles.find(r=>r.key==='it_operator')!.hiddenFields=[...bp.roles.find(r=>r.key==='it_operator')!.hiddenFields??[],'defects'];
  assert.throws(()=>collectTaskAnswers(bp,['correction'],current,{correction:'Fixed'},['it_operator']),/cannot edit/);
});

test('single-row task answers remain compatible with earlier scenarios',()=>{
  const bp=fixture();
  const result=collectTaskAnswers(bp,['correction'],{defects:[{title:'First'}]},{correction:'Fixed'},['it_operator']);
  assert.deepEqual(result.merged.defects,[{title:'First',correction:'Fixed'}]);
});
test('verification changes the calculated missing count used by the next rule',()=>{
  const bp=fixture();
  bp.data.fields.push({key:'missing_verification',label:'Missing verification',type:'calculated',setBy:'system',classification:'internal',
    compute:{op:'count',over:'defects',where:{op:'ne',left:{field:'verified'},right:{literal:true}}}});
  const initial=withCalculatedFields(bp.data.fields,{defects:[{title:'First'},{title:'Second'}]});
  assert.equal(initial.missing_verification,2);
  const task=collectTaskAnswers(bp,['verified'],initial,{defects:[{verified:true},{verified:true}]},['it_operator']);
  const updated=withCalculatedFields(bp.data.fields,task.merged);
  assert.equal(updated.missing_verification,0);
});
