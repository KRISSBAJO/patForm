import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Blueprint} from '../src/blueprint/index.js';
import {missingRequiredFields,validateAnswers} from '../src/blueprint/answers.js';
import {validate} from '../src/compiler/validate.js';
import {completeAnswers} from '../src/runtime/scenarios.js';

const fixture=()=>{
  const bp=Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json','utf8')));
  bp.data.fields.push({key:'handover',label:'Handover records',type:'repeating_group',setBy:'respondent',classification:'internal',required:true,
    requiredChoices:{field:'kind',values:['certificate','warranty']},fields:[
      {key:'kind',label:'Kind',type:'single_choice',setBy:'respondent',classification:'internal',required:true,
        choices:[{label:'Certificate',value:'certificate'},{label:'Warranty',value:'warranty'}]},
      {key:'evidence',label:'Evidence',type:'file',setBy:'respondent',classification:'internal',required:true}
    ]});
  bp.experience.pages[0]!.sections[0]!.fields.push('handover');
  return bp;
};
test('a required checklist cannot pass with one of its mandatory document kinds missing',()=>{
  const bp=fixture();
  assert.ok(!validate(bp).errors.length);
  assert.ok(missingRequiredFields(bp,{}).includes('handover.certificate'));
  assert.ok(validateAnswers(bp,{}).some(e=>e.message.includes('certificate')));
  const answers={handover:[{kind:'certificate',evidence:'receipt-file:00000000-0000-4000-8000-000000000001'}]};
  assert.ok(missingRequiredFields(bp,answers).includes('handover.warranty'));
  assert.ok(validateAnswers(bp,answers).some(e=>e.message.includes('warranty')));
  answers.handover.push({kind:'warranty',evidence:'receipt-file:00000000-0000-4000-8000-000000000001'});
  assert.ok(!missingRequiredFields(bp,answers).some(k=>k.startsWith('handover.')));
});
test('required checklist values must belong to its declared choice field',()=>{
  const bp=fixture();
  bp.data.fields.find(f=>f.key==='handover')!.requiredChoices!.values=['unlisted'];
  assert.ok(validate(bp).errors.some(e=>e.code==='TYPE010'));
});
test('respondents cannot mark their own handover row verified',()=>{
  const bp=fixture();
  bp.data.fields.find(f=>f.key==='handover')!.fields!.push({key:'verified',label:'Verified',type:'yes_no',setBy:'operator',classification:'internal'});
  const answers={handover:[{kind:'certificate',evidence:'receipt-file:00000000-0000-4000-8000-000000000001',verified:true}]};
  assert.ok(validateAnswers(bp,answers).some(e=>e.field==='handover[0].verified'));
});
test('positive scenario samples include each required document row and its evidence',()=>{
  const bp=fixture();
  const sample=completeAnswers(bp,{});
  const rows=sample.handover as Record<string,unknown>[];
  assert.deepEqual(rows.map(row=>row.kind),['certificate','warranty']);
  assert.ok(rows.every(row=>typeof row.evidence==='string'));
  assert.deepEqual(validateAnswers(bp,sample),[]);
});
