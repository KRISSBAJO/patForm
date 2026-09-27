import type { Blueprint } from '../blueprint/index.js';
import { flattenFields } from '../blueprint/data.js';
import { validate } from '../compiler/validate.js';
import type { Diagnostic } from '../compiler/diagnostics.js';
import type { RepairDecision } from './repair.js';
import type { Normalization } from './normalize.js';

/** Choices are derived from this source revision, never from client-supplied patches. */
export function reviewWarnings(bp:Blueprint, answers:Record<string,string> = {}) {
  const decisions:RepairDecision[] = [];
  const changes:Normalization[] = [];
  const accepted:Diagnostic[] = [];
  const internal = bp.roles.filter(r=>r.kind==='internal').sort((a,b)=>a.name.localeCompare(b.name));
  const warnings = validate(bp).warnings;
  const handled = new Set<Diagnostic>();
  const choose = (decision:RepairDecision, apply:(value:string)=>void) => {
    const value = answers[decision.key];
    const allowed = decision.kind==='roles'
      ? !!value && value.split('|').every(key=>decision.roles.some(r=>r.key===key)) && new Set(value.split('|')).size===value.split('|').length
      : decision.roles.some(r=>r.key===value);
    if (allowed) apply(value!); else decisions.push(decision);
  };
  for (const warning of validate(bp).errors.filter(w=>w.code==='AIQ003')) {
    const field=bp.data.fields.find(f=>warning.message.includes(`"${f.label}"`));
    if(!field?.choices?.length) continue;
    choose({key:`review:answer:${field.key}`,kind:'choice',group:'Complete the quiz answer key',prompt:`Which answer is correct: ${field.label}`,detail:'Repair will use the selected option for automatic scoring. It will not guess from a test submission.',roles:field.choices.map((c,i)=>({key:String(i),name:c.label}))},value=>{
      field.correctValue=field.choices![Number(value)]!.value;
      changes.push({at:`data.fields.${field.key}.correctValue`,change:`Set the answer key for ${field.label} to the selected option.`});
    });
  }
  for (const warning of warnings.filter(w=>w.code==='REF003')) {
    const field = bp.data.fields.find(f=>warning.message.includes(`"${f.key}"`));
    if (!field) continue;
    handled.add(warning);
    const options = [{key:'intake',name:'Participant, on the form'},...internal.map(r=>({key:`staff:${r.key}`,name:`Staff: ${r.name}`}))];
    choose({key:`review:collect:${field.key}`,group:'Collect missing information',kind:'choice',prompt:`Who fills in ${field.label}?`,
      detail:'Choosing staff makes this a staff answer and gives that role editing access to this field. Choosing participant adds it to the last form page.',roles:options},value=>{
      if (value==='intake') bp.experience.pages.at(-1)!.sections.push({key:`collect_${field.key}`,title:field.label,fields:[field.key]});
      else {
        field.setBy='operator';
        const role=internal.find(r=>`staff:${r.key}`===value)!;
        if (!role.capabilities.includes('edit')) role.capabilities.push('edit');
        role.editableFields=[...new Set([...(role.editableFields??[]),field.key])];
        role.hiddenFields=role.hiddenFields?.filter(key=>key!==field.key);
      }
      changes.push({at:`data.fields.${field.key}`,change:`${field.label}: ${options.find(o=>o.key===value)!.name} will provide this answer.`});
    });
  }
  for (const warning of warnings.filter(w=>w.code==='SEC010')) {
    const field=flattenFields(bp.data.fields).find(({field})=>warning.message.includes(`"${field.key}"`))?.field;
    if (!field) continue;
    handled.add(warning);
    choose({key:`review:privacy:${field.key}`,kind:'roles',group:'Protect sensitive answers',prompt:`Who may see ${field.label}?`,detail:'Only the selected internal roles will see this answer. Other internal roles also lose editing access to it.',roles:internal.map(r=>({key:r.key,name:r.name}))},value=>{
      const allowed=new Set(value.split('|'));
      for (const role of internal) {
        role.hiddenFields=allowed.has(role.key) ? role.hiddenFields?.filter(k=>k!==field.key) : [...new Set([...(role.hiddenFields??[]),field.key])];
        if (!allowed.has(role.key)) role.editableFields=role.editableFields?.filter(k=>k!==field.key);
      }
      changes.push({at:`roles`,change:`${field.label} is visible only to ${internal.filter(r=>allowed.has(r.key)).map(r=>r.name).join(', ')}.`});
    });
  }
  const exports=warnings.filter(w=>w.code==='SEC004');
  if(exports.length) {
    exports.forEach(w=>handled.add(w));
    const sensitive=flattenFields(bp.data.fields).map(f=>f.field).filter(f=>bp.outputs.exportFields.includes(f.key)&&['confidential','restricted'].includes(f.classification));
    choose({key:'review:exports',kind:'choice',group:'Standard exports',prompt:'Include sensitive answers in standard exports?',detail:sensitive.map(f=>f.label).join(', '),roles:[{key:'exclude',name:'Exclude these answers (recommended)'},{key:'keep',name:'Keep them; I approve this disclosure'}]},value=>{
      if(value==='exclude') bp.outputs.exportFields=bp.outputs.exportFields.filter(k=>!sensitive.some(f=>f.key===k));
      else accepted.push(...exports);
      changes.push({at:'outputs.exportFields',change:value==='exclude'?'Removed sensitive answers from standard exports.':'Editor explicitly approved sensitive answers in standard exports.'});
    });
  }
  const assumptions=warnings.filter(w=>w.code==='BLD001');
  if(assumptions.length) {
    assumptions.forEach(w=>handled.add(w));
    choose({key:'review:assumptions',kind:'choice',group:'Confirm the proposed behavior',prompt:'Does this behavior match your pilot?',detail:bp.intent.assumptions.filter(a=>!a.confirmed).map(a=>a.statement).join('\n\n'),roles:[{key:'confirm',name:'Yes, use this behavior'}]},()=>{
      bp.intent.assumptions.forEach(a=>a.confirmed=true);
      changes.push({at:'intent.assumptions',change:'Editor confirmed the listed assumptions. No workflow behavior was changed.'});
    });
  }
  for(const [index,decision] of bp.intent.openDecisions.entries()) {
    const warning=warnings.find(w=>w.code==='BLD002'&&w.at===`intent.openDecisions[${index}]`);
    if(warning) handled.add(warning);
    choose({key:`review:decision:${index}`,kind:'choice',group:'Your business decisions',prompt:decision.question,detail:`AI proposal: ${decision.provisionally}. This decision needs a workflow change to implement a different behavior. You can defer it for this pilot; the warning remains visible.`,roles:[{key:'defer',name:'Keep the draft as it is; defer this decision'}]},()=>{
      if(warning) accepted.push(warning);
      changes.push({at:`intent.openDecisions[${index}]`,change:`Editor deferred: ${decision.question}. The draft behavior is unchanged and the warning remains.`});
    });
  }
  // Unsupported warnings remain visible. An explicit acknowledgement is not a fix.
  for(const warning of warnings.filter(w=>!handled.has(w))) {
    choose({key:`review:warning:${warning.code}:${warning.at}`,kind:'choice',group:'Review remaining recommendations',prompt:warning.message,detail:warning.fix??'This recommendation cannot be repaired safely without changing your process.',roles:[{key:'accept',name:'Keep this setting; I accept the recommendation'}]},()=>accepted.push(warning));
  }
  return {decisions,changes,accepted};
}
