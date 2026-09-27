import type { Blueprint } from '../blueprint/index.js';
import type { Answers } from '../blueprint/answers.js';

/** Assign stable references to each existing row of a repeated record. */
export function generatedReferences(bp:Blueprint, data:Answers, fieldKey:string, prefix:string, instanceId:string) {
  const group=bp.data.fields.find(field=>field.type==='repeating_group' && field.fields?.some(child=>child.key===fieldKey));
  const base=`${prefix}${instanceId.toUpperCase()}`;
  if(!group) {
    const reference=typeof data[fieldKey]==='string' && data[fieldKey] ? data[fieldKey] as string : base;
    return {data:{...data,[fieldKey]:reference},references:[reference]};
  }
  const original=data[group.key];
  if(!Array.isArray(original)) return {data,references:[]};
  const references:string[]=[];
  const rows=original.map((raw,index)=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw)) return raw;
    const row=raw as Answers;
    const reference=typeof row[fieldKey]==='string' && row[fieldKey] ? row[fieldKey] as string : `${base}-${String(index+1).padStart(3,'0')}`;
    references.push(reference);
    return {...row,[fieldKey]:reference};
  });
  return {data:{...data,[group.key]:rows},references};
}
