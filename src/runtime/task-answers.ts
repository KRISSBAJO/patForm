import type { Blueprint, Field } from '../blueprint/index.js';
import { checkField, type Answers } from '../blueprint/answers.js';
import { InvalidInput } from './errors.js';
import { editableFields } from './policy.js';

/** Collect a task's answers without replacing unrelated answers in a repeating row. */
export function collectTaskAnswers(bp: Blueprint, requiredFields: string[], current: Answers, supplied: Answers, roleKeys: string[]) {
  const allowed=editableFields(bp,roleKeys);
  const canEdit=(key:string,group?:string)=>allowed.has(key) && roleKeys.some(roleKey=>{
    const role=bp.roles.find(r=>r.key===roleKey);
    return role && !role.hiddenFields?.includes(key) && (!group||!role.hiddenFields?.includes(group));
  });
  const fields=new Map(bp.data.fields.map(field=>[field.key,field]));
  const nested=new Map<string,{group:Field;field:Field}>();
  for(const group of bp.data.fields.filter(f=>f.type==='repeating_group')) {
    for(const child of group.fields??[]) nested.set(child.key,{group,field:child});
  }
  const acceptedGroups=new Set(requiredFields.map(key=>nested.get(key)?.group.key).filter((key):key is string=>!!key));
  for(const key of Object.keys(supplied)) {
    if(!requiredFields.includes(key) && !acceptedGroups.has(key)) throw new InvalidInput(`this task does not collect ${key}`);
  }
  const merged:Answers={...current};
  const touched=new Set<string>();
  for(const key of requiredFields) {
    const field=fields.get(key);
    if(field) {
      if(key in supplied) {
        if(!canEdit(key)) throw new InvalidInput(`you cannot edit ${key}`);
        merged[key]=supplied[key]; touched.add(key);
      }
      const problem=checkField({...field,required:true},merged[key]);
      if(problem) throw new InvalidInput(problem);
      continue;
    }
    const child=nested.get(key);
    if(!child) throw new InvalidInput(`task requirement ${key} is not a field`);
    const groupKey=child.group.key;
    const original=current[groupKey];
    if(!Array.isArray(original)||!original.length || original.some(row=>!row||typeof row!=='object'||Array.isArray(row)))
      throw new InvalidInput(`${child.group.label} needs at least one row before this task can be completed`);
    const sourceRows=original as Answers[];
    const patch=supplied[groupKey];
    if(patch!==undefined && (!Array.isArray(patch)||patch.length!==sourceRows.length))
      throw new InvalidInput(`${child.group.label} needs one answer for each existing row`);
    if(key in supplied && sourceRows.length!==1)
      throw new InvalidInput(`${child.group.label} has multiple rows; answer ${child.field.label} for each row`);
    if(key in supplied && patch!==undefined)
      throw new InvalidInput(`answer ${child.field.label} either in its row or as a single-row answer`);
    if((key in supplied || patch!==undefined) && !canEdit(key,groupKey))
      throw new InvalidInput(`you cannot edit ${key}`);
    if(merged[groupKey]===current[groupKey]) merged[groupKey]=sourceRows.map(row=>({...row}));
    const next=merged[groupKey] as Answers[];
    for(let index=0;index<next.length;index++) {
      const changes=patch?.[index];
      if(changes!==undefined && (!changes || typeof changes!=='object'||Array.isArray(changes)))
        throw new InvalidInput(`invalid answer for ${child.group.label} row ${index+1}`);
      if(changes && Object.keys(changes).some(name=>!requiredFields.includes(name)||nested.get(name)?.group.key!==groupKey))
        throw new InvalidInput(`this task does not collect one of the answers in ${child.group.label}`);
      const value=key in supplied ? supplied[key] : changes?.[key];
      if(value!==undefined) {next[index]![key]=value;touched.add(groupKey);}
      const problem=checkField({...child.field,required:true},next[index]![key]);
      if(problem) throw new InvalidInput(`${child.group.label} row ${index+1}: ${problem}`);
    }
  }
  return {merged,touched:[...touched],previous:Object.fromEntries([...touched].map(key=>[key,current[key]??null]))};
}
