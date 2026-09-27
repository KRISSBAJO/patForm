import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Blueprint} from '../src/blueprint/index.js';
import {collectTaskAnswers} from '../src/runtime/task-answers.js';

const fixture=()=>{
  const bp=Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json','utf8')));
  bp.data.fields.push({key:'defects',label:'Defects',type:'repeating_group',setBy:'respondent',classification:'internal',fields:[
    {key:'title',label:'Title',type:'short_text',setBy:'respondent',classification:'internal'},
    {key:'correction',label:'Correction',type:'long_text',setBy:'operator',classification:'internal'},
    {key:'verified',label:'Verified',type:'yes_no',setBy:'operator',classification:'internal'},
  ]});
  const role=bp.roles.find(r=>r.key==='it_operator')!;
  role.editableFields=[...role.editableFields??[],'correction','verified'];
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
