import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { generateStaged, missingDefinitions, sectionsFor, summarize } from '../src/ai/staged.js';
import type { Provider, GenerationRequest, ProviderResponse } from '../src/ai/provider.js';

const onboarding = () =>
  Blueprint.parse(JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json', 'utf8')));

/** A provider that answers each stage with that slice of a known-good blueprint. */
function scripted(bp: Blueprint, tamper: (stage: string, part: Record<string, unknown>) => Record<string, unknown> = (_s, p) => p): Provider & { calls: string[] } {
  const calls: string[] = [];
  const slices: Record<string, Record<string, unknown>> = {
    form: { schemaVersion: bp.schemaVersion, key: bp.key, name: bp.name, description: bp.description, intent: bp.intent, roles: bp.roles, data: bp.data, experience: bp.experience },
    workflow: { workflow: bp.workflow, communications: bp.communications },
    finish: { outputs: bp.outputs, tests: bp.tests },
  };
  return {
    name: 'scripted',
    model: 'scripted-1',
    maxOutputTokens: 32000,
    calls,
    async generate(request: GenerationRequest): Promise<ProviderResponse> {
      const stage = request.stage ?? 'whole';
      calls.push(stage);
      let part: Record<string, unknown>;
      if (stage.startsWith('repair:')) {
        // A repair returns the sections asked for, corrected to the original.
        const wanted = stage.slice('repair:'.length).split('+');
        const whole = { ...slices.form, ...slices.workflow, ...slices.finish } as Record<string, unknown>;
        part = Object.fromEntries(wanted.map((k) => [k, whole[k]]));
      } else if(stage==='form:identity') {
        part=Object.fromEntries(Object.entries(slices.form!).filter(([k])=>!['data','experience'].includes(k)));
      } else {
        const [group,key]=stage.split(':');
        const whole=tamper(group!,structuredClone(slices[group!]!));
        part={[key!]:whole[key!]};
      }
      return { text: JSON.stringify(part), parsed: part, meta: { provider: 'scripted', model: 'scripted-1', mode: 'structured', latencyMs: 1, inputTokens: 10, outputTokens: 20 } };
    },
  };
}

test('smaller sections assemble into the same blueprint, and it compiles', async () => {
  const bp = onboarding();
  const provider = scripted(bp);
  const stages: string[] = [];
  const usage: string[] = [];
  const out = await generateStaged(provider, {
    description: 'x'.repeat(3000),
    onStage: async (p) => { stages.push(p.stage); },
    onUsage: async (u) => { usage.push(`${u.stage}:${u.outcome}`); },
  });
  assert.equal(out.decision, 'publishable');
  assert.deepEqual(provider.calls, ['form:identity','form:data','form:experience','workflow:workflow','workflow:communications','finish:outputs','finish:tests']);
  assert.deepEqual(out.blueprint?.workflow.states.map((s) => s.key), bp.workflow.states.map((s) => s.key));
  assert.equal(out.blueprint?.data.fields.length, bp.data.fields.length);
  assert.ok(out.staged);
  assert.ok(stages.includes('checking'));
  assert.equal(usage.length,7);
  assert.equal(out.audit.totalOutputTokens, 140);
});

test('a compile error is repaired by asking for the failing sections only', async () => {
  const bp = onboarding();
  // The workflow stage names a state that does not exist: a cross-section error.
  const provider = scripted(bp, (stage, part) => {
    if (stage !== 'workflow') return part;
    const workflow = structuredClone(part.workflow) as Blueprint['workflow'];
    workflow.transitions[0]!.to = 'nowhere';
    return { ...part, workflow };
  });
  const notes: string[] = [];
  const out = await generateStaged(provider, { description: 'x'.repeat(3000), maxRepairs: 1, onStage: async (p) => { notes.push(p.note); } });
  assert.equal(out.decision, 'publishable');
  assert.ok(provider.calls[7]?.startsWith('repair:'), provider.calls.join(','));
  assert.ok(provider.calls.includes('repair:workflow'));
  assert.ok(!provider.calls.includes('repair:data'), 'the form was fine and is not asked for again');
  assert.equal(out.audit.repairs, 1);
  assert.ok(notes.some((n) => /^Repair 1 of 1/.test(n)));
});

test('a workflow that names approvals it never defined is asked for again before the tests are written', async () => {
  const bp = onboarding();
  let first = true;
  const provider = scripted(bp, (stage, part) => {
    if (stage !== 'workflow' || !first) return part;
    first = false;
    const workflow = structuredClone(part.workflow) as Blueprint['workflow'];
    workflow.approvals = [];
    workflow.tasks = [];
    return { ...part, workflow };
  });
  const notes: string[] = [];
  const out = await generateStaged(provider, { description: 'x'.repeat(3000), onStage: async (p) => { notes.push(p.note); } });
  assert.equal(out.decision, 'publishable');
  assert.equal(provider.calls.filter(s=>s==='workflow:workflow').length,2);
  assert.ok(provider.calls.includes('finish:tests'));
  assert.ok(notes.some((n) => /left out/.test(n)), notes.join(' | '));
  assert.equal(out.audit.repairs, 0, 'no repair round was needed');
});

test('missing definitions are found by reference, not by compiling', () => {
  const bp = onboarding();
  assert.deepEqual(missingDefinitions({ workflow: bp.workflow, communications: bp.communications }), []);
  const workflow = structuredClone(bp.workflow);
  workflow.approvals = [];
  const missing = missingDefinitions({ workflow, communications: bp.communications });
  assert.ok(missing.length > 0);
  assert.ok(missing.every((m) => /workflow\.approvals/.test(m)), missing.join('\n'));
  assert.deepEqual(missingDefinitions({}), []);
});

test('a stage that will not take shape is retried once, then given up', async () => {
  const bp = onboarding();
  const provider = scripted(bp, (stage, part) => (stage === 'finish' ? { nonsense: true } : part));
  const out = await generateStaged(provider, { description: 'x'.repeat(3000) });
  assert.equal(out.decision, 'unparseable');
  assert.deepEqual(provider.calls.slice(-2), ['finish:outputs', 'finish:outputs']);
  assert.equal(out.attempts.filter((a) => a.stage === 'finish:outputs' && !a.shapeOk).length, 2);
});

test('sections for a repair follow where the errors point', () => {
  const at = (a: string, code = 'X') => ({ code, severity: 'error' as const, at: a, message: '' });
  assert.deepEqual(sectionsFor([at('workflow.transitions[3].to')]), ['workflow', 'tests']);
  assert.deepEqual(sectionsFor([at('data.fields.x'), at('experience.pages[1]')]), ['data', 'experience', 'tests']);
  assert.deepEqual(sectionsFor([at('data.fields.trainer_email', 'REF003')]), ['data', 'experience', 'tests'], 'a field missing from every page is fixed on a page');
  assert.deepEqual(sectionsFor([{ code: 'REF005', severity: 'error', at: 'workflow.transitions[2].actions[0]', message: 'Unknown template "welcome".' }]), ['workflow', 'communications', 'tests']);
  assert.deepEqual(sectionsFor([{ code: 'TASK002', severity: 'error', at: 'workflow.tasks[0]', message: 'Task "verify" requires "result", but Trainer cannot edit it.' }]), ['roles', 'workflow', 'tests']);
  assert.deepEqual(sectionsFor([at('tests.happy', 'SCENARIO')]), ['workflow', 'tests']);
  assert.deepEqual(sectionsFor([at('outputs.exportFields')]), ['outputs']);
  assert.deepEqual(sectionsFor([{ code: 'W', severity: 'warning', at: 'data.x', message: '' }]), []);
});

test('the summary counts nested fields once each', () => {
  const bp = onboarding();
  const s = summarize(bp) as { form: { fields: number; pages: number }; workflow: { states: number }; finish: { tests: number } };
  const flat = (fs: Blueprint['data']['fields']): number => fs.reduce((n, f) => n + 1 + (f.fields ? flat(f.fields) : 0), 0);
  assert.equal(s.form.fields, flat(bp.data.fields));
  assert.equal(s.form.pages, bp.experience.pages.length);
  assert.equal(s.workflow.states, bp.workflow.states.length);
  assert.equal(s.finish.tests, bp.tests.length);
});
test('provider fallback resumes validated sections without recreating the form',async()=>{
  const bp=onboarding(); const first=scripted(bp);
  const generate=first.generate.bind(first);
  first.generate=async request=>{
    if(request.stage==='workflow:workflow') throw new Error('provider unavailable');
    return generate(request);
  };
  let checkpoint:Record<string,unknown>={};
  await assert.rejects(()=>generateStaged(first,{description:'x'.repeat(3000),onCheckpoint:async parts=>{checkpoint=parts;}}));
  assert.ok(checkpoint.data); assert.ok(checkpoint.experience);
  const second=scripted(bp);
  const out=await generateStaged(second,{description:'x'.repeat(3000),initialParts:checkpoint});
  assert.equal(out.decision,'publishable');
  assert.deepEqual(second.calls,['workflow:workflow','workflow:communications','finish:outputs','finish:tests']);
});
test('failed repair request retains assembled private candidate and validation errors',async()=>{
  const bp=onboarding(); const provider=scripted(bp, (stage,part)=>{
    if(stage!=='workflow') return part;
    const workflow=structuredClone(part.workflow) as Blueprint['workflow'];
    workflow.transitions[0]!.to='nowhere';
    return {...part,workflow};
  });
  const generate=provider.generate.bind(provider);
  provider.generate=async request=>{
    if(request.stage?.startsWith('repair:')) throw new Error('credit balance exhausted');
    return generate(request);
  };
  const out=await generateStaged(provider,{description:'x'.repeat(3000)});
  assert.equal(out.decision,'blocked');
  assert.ok(out.editable?.errors.length);
  assert.equal(out.editable?.blueprint.data.fields.length,bp.data.fields.length);
  assert.equal(out.blueprint,undefined);
});
