import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Blueprint } from '../blueprint/index.js';
import { extractJson, type Provider } from './provider.js';

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
      || /^\/tests\/\d+\/(steps|expect)$/.test(patch.path);
    if(!allowed) throw new Error(`Repair cannot change ${patch.path}. Use the explicit editor for access, documents or other structural changes.`);
    let parent:Record<string,unknown>=next as unknown as Record<string,unknown>;
    for(const part of parts.slice(0,-1)) {
      if(!Object.hasOwn(parent,part) || !parent[part] || typeof parent[part]!=='object') throw new Error('Repair path does not exist');
      parent=parent[part] as Record<string,unknown>;
    }
    parent[parts.at(-1)!]=structuredClone(patch.value);
  }
  const parsed=Blueprint.parse(next);
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
  const system='Return a small set of replacements, not a blueprint. Every change has EXACTLY two keys: path and value. Example: {"changes":[{"path":"/intent/retentionDays","value":365}]}. Do not put expect, operation, reason or other keys on a change. Implement only the explicit business choices. Allowed paths: /intent/openDecisions, /intent/assumptions, /intent/retentionDays, /workflow/transitions/INDEX/when or /to, /tests/INDEX/steps or /expect. Replace the entire allowed leaf; nested paths such as /intent/openDecisions/0/provisionally are forbidden. Preserve approval requirements, security tests, duplicate policy and expected outputs. Never modify roles, documents, fields, email recipients or task authorities. Never change permission or duplicate test scenarios. Scenario steps use the source format: manual steps have step="manual", transition=<existing transition key>, as=<role>; permission steps have step="permission", action=submit|view|edit|approve|export|operate, NOT a transition key. Leave a decision unresolved if these paths cannot implement it.';
  let feedback='';
  for(let attempt=0;attempt<2;attempt++) {
    const response=await provider.generate({description,stage:'targeted-repair',shape:Patch,system,
      user:JSON.stringify({request:description,source})+feedback,schema:zodToJsonSchema(Patch) as Record<string,unknown>});
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
