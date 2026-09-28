import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DeepSeekProvider} from '../src/ai/deepseek.js';
import {extractJson, type GenerationRequest} from '../src/ai/provider.js';

const request:GenerationRequest={description:'test',system:'Return JSON',user:'Generate fields',schema:{type:'object'},stage:'form:data'};
test('invalid JSON retry includes safe syntax feedback and repeats only the current section',async()=>{
  const calls:any[]=[];
  const client:any={chat:{completions:{create:async(body:any)=>{
    calls.push(body);
    return {choices:[{finish_reason:'stop',message:{content:calls.length===1 ? '{"secret":"private-value", "fields": [}' : '{"data":{"fields":[]}}'}}],usage:{prompt_tokens:10,completion_tokens:10}};
  }}}};
  const provider=new DeepSeekProvider({apiKey:'test',client});
  const response=await provider.generate(request);
  assert.deepEqual(response.parsed,{data:{fields:[]}});
  assert.equal(calls.length,2);
  const feedback=calls[1].messages[1].content;
  assert.match(feedback,/invalid JSON in form:data/);
  assert.match(feedback,/JSON syntax error/);
  assert.ok(!feedback.includes('private-value'));
  assert.equal(calls[1].response_format.type,'json_object');
});
test('empty JSON response is retried once with a complete response instruction',async()=>{
  const calls:any[]=[];
  const client:any={chat:{completions:{create:async(body:any)=>{
    calls.push(body);
    return {choices:[{finish_reason:'stop',message:{content:calls.length===1?'':'{"data":{"fields":[]}}'}}]};
  }}}};
  const provider=new DeepSeekProvider({apiKey:'test',client});
  const response=await provider.generate({...request,schema:{type:'object',properties:{data:{type:'object'}}}});
  assert.deepEqual(response.parsed,{data:{fields:[]}});
  assert.equal(calls.length,2);
  assert.match(calls[0].messages[0].content,/top-level keys: "data"/);
  assert.match(calls[1].messages[1].content,/Do not return an empty answer/);
});
test('repeated malformed JSON fails after one retry with stage and safe location',async()=>{
  let count=0;
  const client:any={chat:{completions:{create:async()=>{count++;return {choices:[{finish_reason:'stop',message:{content:'{"private-value": [}'}}]};}}}};
  const provider=new DeepSeekProvider({apiKey:'test',client});
  await assert.rejects(()=>provider.generate(request),error=>{
    assert.match((error as Error).message,/form:data/);
    assert.ok(!(error as Error).message.includes('private-value'));
    return true;
  });
  assert.equal(count,2);
});
test('extractJson accepts fences and reports syntax without customer content',()=>{
  assert.deepEqual(extractJson('```json\n{"ok":true}\n```'),{ok:true});
  assert.throws(()=>extractJson('{"customer-secret": [}'),error=>{
    assert.match((error as Error).message,/JSON syntax error/);
    assert.ok(!(error as Error).message.includes('customer-secret'));
    return true;
  });
});
