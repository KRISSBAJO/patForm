import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Blueprint } from '../blueprint/index.js';
import { extractJson, type Provider } from './provider.js';
import { validate } from '../compiler/validate.js';

const Patch = z.object({ changes:z.array(z.object({path:z.string(),value:z.unknown()}).strict()).min(1).max(30) }).strict();

/** Repair may propose routing changes, never rewrite authorities or delete content. */
export function applyTargetedRevision(source:Blueprint, input:unknown):Blueprint {
  const patches=Patch.parse(input);
  const next=structuredClone(source);
  for(const patch of patches.changes) {
    const parts=patch.path.split('/').slice(1);
    if(parts.some(p=>['__proto__','prototype','constructor'].includes(p))) throw new Error('Unsafe repair path');
    const allowed=/^\/intent\/(openDecisions|assumptions|retentionDays)$/.test(patch.path)
      || /^\/workflow\/transitions\/\d+\/(when|to)$/.test(patch.path)
      || /^\/tests\/\d+\/(steps|expect)$/.test(patch.path)
      || /^\/data\/fields\/\d+\/(required|requiredChoices)$/.test(patch.path)
      || /^\/data\/fields\/\d+\/fields\/\d+\/requiredWhen$/.test(patch.path);
    if(!allowed) throw new Error(`Repair cannot change ${patch.path}. Use the explicit editor for access, documents or other structural changes.`);
    if(parts[0]==='data') {
      const index=Number(parts[2]);
      const original=source.data.fields[index];
      if(!original || original.type!=='repeating_group' || original.setBy==='operator'||original.setBy==='system')
        throw new Error('Repair can only strengthen a respondent checklist');
      if(parts[3]==='required') {
        if(patch.value!==true) throw new Error('Repair cannot make a required checklist optional');
      } else if(parts[3]==='requiredChoices') {
        const choice=original.fields?.find(field=>field.key===(patch.value as {field?:unknown})?.field);
        const values=(patch.value as {values?:unknown})?.values;
        if(!choice || !['single_choice','dropdown'].includes(choice.type) || !Array.isArray(values) || !values.length ||
          !values.every(value=>typeof value==='string' && choice.choices?.some(option=>option.value===value)) ||
          original.requiredChoices?.field && original.requiredChoices.field!==choice.key ||
          original.requiredChoices?.values.some(value=>!values.includes(value)))
          throw new Error('Repair can only add declared mandatory checklist choices');
      } else {
        const child=original.fields?.[Number(parts[4])];
        if(!child || child.type!=='file' || child.setBy==='operator'||child.setBy==='system' || child.requiredWhen || child.required)
          throw new Error('Repair can only require previously optional respondent evidence');
      }
    }
    let parent:Record<string,unknown>=next as unknown as Record<string,unknown>;
    for(const part of parts.slice(0,-1)) {
      if(!Object.hasOwn(parent,part) || !parent[part] || typeof parent[part]!=='object') throw new Error('Repair path does not exist');
      parent=parent[part] as Record<string,unknown>;
    }
    parent[parts.at(-1)!]=structuredClone(patch.value);
  }
  const parsed=Blueprint.parse(next);
  if(validate(parsed).errors.length) throw new Error('Repair produced invalid blueprint checks');
  for(const test of source.tests) {
    const updated=parsed.tests.find(t=>t.key===test.key)!;
    if(test.kind==='permission' && JSON.stringify(updated)!==JSON.stringify(test)) throw new Error('Repair cannot weaken permission tests');
    if(test.kind==='duplicate' && JSON.stringify(updated)!==JSON.stringify(test)) throw new Error('Repair cannot rewrite duplicate tests');
    const denied=test.steps.filter(s=>'expectDenied' in s && s.expectDenied);
    if(denied.some(s=>!updated.steps.some(n=>JSON.stringify(n)===JSON.stringify(s)))) throw new Error('Repair cannot remove denial assertions');
    if(test.expect.instanceCount!==updated.expect.instanceCount) throw new Error('Repair cannot change record-count assertions');
    for(const kind of ['emails','documents'] as const) {
      if(test.expect[kind]?.some(k=>!updated.expect[kind]?.includes(k))) throw new Error('Repair cannot remove expected outputs');
    }
  }
  return parsed;
}

export async function proposeTargetedRevision(provider:Provider, source:Blueprint, description:string):Promise<Blueprint> {
  const system='Return a small set of replacements, not a blueprint. Every change has EXACTLY two keys: path and value. Example: {"changes":[{"path":"/intent/retentionDays","value":365}]}. Implement only explicit business choices. Allowed paths: /intent/openDecisions, /intent/assumptions, /intent/retentionDays, /workflow/transitions/INDEX/when or /to, /tests/INDEX/steps or /expect. For mandatory handover checklist items only, /data/fields/INDEX/required may be set true, /data/fields/INDEX/requiredChoices may add declared choice values, and /data/fields/INDEX/fields/INDEX/requiredWhen may require respondent file evidence based on a row answer. Replace the entire allowed leaf. Preserve approval requirements, security tests, duplicate policy and expected outputs. Never modify roles, documents, email recipients or task authorities. Never change permission or duplicate test scenarios. Manual test steps use step="manual", transition=<existing key>, as=<role>. Leave a decision unresolved if these paths cannot implement it.';
  let feedback='';
  for(let attempt=0;attempt<2;attempt++) {
    const response=await provider.generate({description,stage:'targeted-repair',shape:Patch,system,
      user:JSON.stringify({request:description,source:repairSourceView(source)})+feedback,schema:zodToJsonSchema(Patch) as Record<string,unknown>});
    if(response.meta.refusal) throw new Error(response.meta.refusal);
    try { return applyTargetedRevision(source,response.parsed??extractJson(response.text)); }
    catch(error) {
      if(attempt===1) throw error;
      const issues=error instanceof z.ZodError ? error.issues.slice(0,12).map(i=>`${i.path.join('.')}: ${i.message}`).join('\n')
        : error instanceof Error ? error.message : 'Invalid patch';
      feedback=`\n\nThe proposed patch was rejected. Correct these errors and return a new complete changes object for the SAME original source. Nothing from your previous patch was applied:\n${issues}`;
    }
  }
  throw new Error('Targeted repair could not produce a valid patch');
}

/** Only the indexed leaves and the context needed to choose safe patches. */
function repairSourceView(source:Blueprint) {
  return {
    key:source.key,name:source.name,intent:source.intent,
    fields:source.data.fields.map((field,index)=>({index,key:field.key,type:field.type,setBy:field.setBy,required:field.required,
      requiredChoices:field.requiredChoices,children:field.fields?.map((child,index)=>({index,key:child.key,type:child.type,setBy:child.setBy,
        required:child.required,requiredWhen:child.requiredWhen,choices:child.choices})),choices:field.choices})),
    transitions:source.workflow.transitions.map((route,index)=>({index,key:route.key,from:route.from,to:route.to,trigger:route.trigger,when:route.when,actions:route.actions})),
    tasks:source.workflow.tasks.map(task=>({key:task.key,requiredFields:task.requiredFields,assignee:task.assignee})),
    roles:source.roles.map(role=>({key:role.key,capabilities:role.capabilities,editableFields:role.editableFields})),
    tests:source.tests.map((scenario,index)=>({index,key:scenario.key,kind:scenario.kind,steps:scenario.steps,expect:scenario.expect})),
  };
}
