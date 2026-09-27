import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Blueprint} from '../src/blueprint/index.js';
import {createPool} from '../src/runtime/db.js';
import {runScenarios,type ScenarioProgress} from '../src/runtime/scenarios.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);

test('scenario runner accepts counted sequential votes but still rejects a repeated voter', {skip: !localDatabase}, async()=>{
  const bp=Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json','utf8')));
  const approval=bp.workflow.approvals.find(a=>a.key==='manager_approval')!;
  approval.mode='sequential';
  approval.approvers=[{role:'hiring_manager'},{role:'hr_approver'},{role:'hr_admin'}];
  const admin=bp.roles.find(r=>r.key==='hr_admin')!;
  if(!admin.capabilities.includes('approve'))admin.capabilities.push('approve');
  for(const t of bp.tests) for(let i=t.steps.length-1;i>=0;i--) {
    const s=t.steps[i]!;
    if(s.step==='decide' && s.approval===approval.key && s.decision==='approved')t.steps.splice(i+1,0,{...s,as:'hr_approver'},{...s,as:'hr_admin'});
  }
  const pool=createPool();
  try {
    const progress:ScenarioProgress[]=[];
    const results=await runScenarios(pool,bp,async event=>{progress.push(event);});
    assert.ok(results.every(r=>r.passed),JSON.stringify(results));
    assert.equal(progress.at(-1)!.completed,bp.tests.length);
    assert.equal(progress.at(-1)!.passed,bp.tests.length);
    assert.ok(progress.some(p=>p.status==='running' && p.step===1));
    assert.equal(progress.filter(p=>p.status==='starting').length,bp.tests.length);
    const invalid=structuredClone(bp);
    const happy=invalid.tests.find(t=>t.kind==='happy_path')!;
    invalid.tests=[happy];
    const second=happy.steps.find(s=>s.step==='decide' && s.approval===approval.key && s.as==='hr_approver')!;
    assert.ok(second.step==='decide'); second.as='hiring_manager';
    const denied=await runScenarios(pool,invalid);
    assert.equal(denied[0]!.passed,false);
    assert.ok(denied[0]!.failures.some(f=>f.includes('refused the decision')));
  } finally {await pool.end();}
});

test('a signed approval needs an authenticated typed name and explicit confirmation', {skip: !localDatabase}, async()=>{
  const bp=Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json','utf8')));
  const approval=bp.workflow.approvals.find(a=>a.key==='manager_approval')!;
  approval.signatureRequired=true;
  for(const scenario of bp.tests) for(const step of scenario.steps) if(step.step==='decide'&&step.approval===approval.key){
    step.signatureName='Pilot Manager';
    step.signatureConfirmed=true;
  }
  const pool=createPool();
  try {
    const signed=await runScenarios(pool,bp);
    assert.ok(signed.every(result=>result.passed),JSON.stringify(signed));
    const unsigned=structuredClone(bp);
    const happy=unsigned.tests.find(item=>item.kind==='happy_path')!;
    unsigned.tests=[happy];
    const decision=happy.steps.find(step=>step.step==='decide'&&step.approval===approval.key)!;
    if(decision.step==='decide')decision.signatureConfirmed=false;
    const refused=await runScenarios(pool,unsigned);
    assert.equal(refused[0]?.passed,false);
    assert.ok(refused[0]?.failures.some(failure=>failure.includes('electronic signature')));
  } finally {await pool.end();}
});
