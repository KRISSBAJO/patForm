import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Blueprint} from '../src/blueprint/index.js';
import {generatedReferences} from '../src/runtime/references.js';

const bp=Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json','utf8')));

test('a repeated defect gets its own stable reference without replacing evidence',()=>{
  const source=structuredClone(bp);
  source.data.fields.push({key:'defects',label:'Defects',type:'repeating_group',classification:'internal',fields:[
    {key:'defect_id',label:'Defect ID',type:'short_text',setBy:'system',classification:'internal'},
    {key:'image',label:'Image',type:'file',classification:'internal'},
  ]});
  const answers={defects:[{image:'one'},{image:'two'}]};
  const first=generatedReferences(source,answers,'defect_id','DEF-','1234');
  assert.deepEqual((first.data.defects as typeof answers.defects).map(row=>row.image),['one','two']);
  assert.deepEqual(first.references,['DEF-1234-001','DEF-1234-002']);
  assert.deepEqual(generatedReferences(source,first.data,'defect_id','DEF-','1234').data,first.data);
  assert.deepEqual(answers,{defects:[{image:'one'},{image:'two'}]});
});

test('a top-level generated record reference stays compatible',()=>{
  assert.equal(generatedReferences(bp,{},'record_ref','REQ-','abcd').references[0],'REQ-ABCD');
});
