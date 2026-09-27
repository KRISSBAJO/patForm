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
  const requests:string[]=[];
  const internal = bp.roles.filter(r=>r.kind==='internal').sort((a,b)=>a.name.localeCompare(b.name));
  const warnings = validate(bp).warnings;
  const handled = new Set<Diagnostic>();
  const choose = (decision:RepairDecision, apply:(value:string)=>void) => {
    const value = answers[decision.key];
    if(decision.allowCustom && value?.startsWith('custom:') && value.slice(7).trim().length>=10 && value.length<=2000) {
      requests.push(`${decision.prompt}\nRequested behavior: ${value.slice(7).trim()}`);
      return;
    }
    const allowed = decision.kind==='roles'
      ? !!value && value.split('|').every(key=>decision.roles.some(r=>r.key===key)) && new Set(value.split('|')).size===value.split('|').length
      : decision.kind==='days' ? !!value && /^\d+$/.test(value) && Number(value)>=1 && Number(value)<=36500
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
    choose({key:'review:assumptions',kind:'choice',allowCustom:true,group:'Confirm the proposed behavior',prompt:'Does this behavior match your pilot?',detail:bp.intent.assumptions.filter(a=>!a.confirmed).map(a=>a.statement).join('\n\n'),roles:[{key:'confirm',name:'Yes, use this behavior'}]},()=>{
      bp.intent.assumptions.forEach(a=>a.confirmed=true);
      changes.push({at:'intent.assumptions',change:'Editor confirmed the listed assumptions. No workflow behavior was changed.'});
    });
  }
  const resolved=new Set<number>();
  for(const [index,decision] of bp.intent.openDecisions.entries()) {
    const warning=warnings.find(w=>w.code==='BLD002'&&w.at===`intent.openDecisions[${index}]`);
    if(warning) handled.add(warning);
    const key=`review:decision:${index}`;
    if(/\bretain|\bretention/i.test(decision.question)) {
      choose({key,kind:'days',group:'Retention',prompt:decision.question,detail:'Enter how many days completed records and their stored attachments should be kept. The existing retention job will delete them after this period. Your private draft is reviewed and tested before saving.',roles:[]},value=>{
        bp.intent.retentionDays=Number(value);resolved.add(index);
        changes.push({at:'intent.retentionDays',change:`Set retention to ${value} days after completion.`});
      });continue;
    }
    const approval=bp.workflow.approvals.find(a=>decision.question.toLowerCase().includes(a.name.toLowerCase()) || /executive.*approver/i.test(decision.question)&&/executive/i.test(a.name));
    if(approval&& /who|which.*approver/i.test(decision.question)) {
      const eligible=internal.filter(r=>r.capabilities.includes('approve'));
      choose({key,kind:'choice',allowCustom:true,group:'Choose the approver',prompt:decision.question,detail:`Select an existing authorized role for ${approval.name}. This changes its routing, without granting new permissions. Assign the named person to that role in People.`,roles:eligible.map(r=>({key:r.key,name:r.name}))},value=>{
        const previous=approval.approvers.flatMap(p=>'role' in p?[p.role]:[]);
        approval.approvers=[{role:value}];resolved.add(index);
        for(const test of bp.tests.filter(t=>t.kind!=='permission')) for(const step of test.steps) {
          if(step.step==='decide' && step.approval===approval.key && previous.includes(step.as)) step.as=value;
        }
        changes.push({at:`workflow.approvals.${approval.key}`,change:`${approval.name} now routes to ${eligible.find(r=>r.key===value)!.name}.`});
      });continue;
    }
    const customOptions=/procurement/i.test(decision.question)&&/finance/i.test(decision.question)&&/before.*after|after.*before/i.test(decision.question) ? [{key:`custom:${decision.question} Set the review order so procurement review is before finance review whenever both are required. Preserve other conditional reviews and adjust tests to exercise this order.`,name:'Procurement before Finance'},{key:`custom:${decision.question} Set the review order so finance review is before procurement review whenever both are required. Preserve other conditional reviews and adjust tests to exercise this order.`,name:'Finance before Procurement'}] : [];
    choose({key,kind:'choice',allowCustom:true,group:'Your business decisions',prompt:decision.question,detail:`AI proposal: ${decision.provisionally}. Choosing a different behavior generates a proposal for review; it is not saved automatically.`,roles:[...customOptions,{key:'defer',name:'Decide later (leave this warning visible)'}]},()=>{
      if(warning) accepted.push(warning);
      changes.push({at:`intent.openDecisions[${index}]`,change:`Editor deferred: ${decision.question}. The draft behavior is unchanged and the warning remains.`});
    });
  }
  bp.intent.openDecisions=bp.intent.openDecisions.filter((_,index)=>!resolved.has(index));
  // Unsupported warnings remain visible. An explicit acknowledgement is not a fix.
  for(const warning of warnings.filter(w=>!handled.has(w))) {
    choose({key:`review:warning:${warning.code}:${warning.at}`,kind:'choice',allowCustom:true,group:'Review remaining recommendations',prompt:warning.message,detail:warning.fix??'Describe the behavior you want; Repair will generate a proposal for review.',roles:[{key:'accept',name:'Keep this setting; I accept the recommendation'}]},()=>accepted.push(warning));
  }
  return {decisions,changes,accepted,requests};
}
