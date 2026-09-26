import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  Blueprint,
  Communications,
  DataSchema,
  Experience,
  Intent,
  Key,
  Outputs,
  Role,
  ScenarioTest,
  Workflow,
} from '../blueprint/index.js';
import { validate } from '../compiler/validate.js';
import type { Diagnostic } from '../compiler/diagnostics.js';
import { runScenarios, type ScenarioResult } from '../runtime/scenarios.js';
import type { Pool } from '../runtime/db.js';
import { PROMPT_VERSION, SYSTEM_PROMPT, repairTurn, stageTurn, type StageName } from './prompt.js';
import { extractJson, type Provider, type ProviderMeta } from './provider.js';
import { normalizeBlueprint } from './normalize.js';
import type { Attempt, Decision, GenerationOutcome, UsageRecord } from './pipeline.js';

/**
 * A blueprint in three replies instead of one.
 *
 * A page-long description becomes a blueprint of thirty thousand tokens. Asked
 * for in one reply, that is more than the fast providers can return, so the
 * request fell through to the slowest one and took twenty minutes; and one
 * compiler error meant asking for the whole thing again.
 *
 * Staged, the same blueprint is three replies of a third the size — the form,
 * then the workflow and messages that refer to it, then outputs and tests —
 * each small enough for the provider that answers in half a minute. The
 * page shows each stage as it lands. And a repair asks only for the sections
 * the errors are in, with the rest given for reference, so a fix to one
 * transition is a reply of a few hundred tokens rather than thirty thousand.
 */

const FormStage = z
  .object({
    schemaVersion: z.literal('0.1'),
    key: Key,
    name: z.string().min(1),
    description: z.string().optional(),
    intent: Intent,
    roles: z.array(Role).min(1),
    data: DataSchema,
    experience: Experience,
  })
  .strict();

const WorkflowStage = z.object({ workflow: Workflow, communications: Communications }).strict();
const FinishStage = z.object({ outputs: Outputs, tests: z.array(ScenarioTest).default([]) }).strict();

/** Each top-level section by itself, for a repair that returns only what changed. */
const SECTION: Record<string, z.ZodTypeAny> = {
  intent: Intent,
  roles: z.array(Role).min(1),
  data: DataSchema,
  experience: Experience,
  workflow: Workflow,
  communications: Communications,
  outputs: Outputs,
  tests: z.array(ScenarioTest),
};
const SECTION_ORDER = ['intent', 'roles', 'data', 'experience', 'workflow', 'communications', 'outputs', 'tests'];

export interface StageProgress {
  stage: StageName | 'repair' | 'checking';
  note: string;
  /** Counts of what exists so far, for the page that is waiting. */
  progress: Record<string, unknown>;
}

export interface StagedOptions {
  description: string;
  pack?: string;
  pool?: Pool;
  /** Repairs after assembly, each asking only for the sections with errors. */
  maxRepairs?: number;
  onStage?: (progress: StageProgress) => Promise<void>;
  onUsage?: (usage: UsageRecord) => Promise<void>;
}

class StageFailed extends Error {
  constructor(readonly stage: string, readonly issues: string[], readonly meta: ProviderMeta) {
    super(`stage ${stage} did not produce what was asked: ${issues[0] ?? 'nothing readable'}`);
  }
}

/** What has been designed so far, in numbers the page can show. */
export function summarize(parts: Partial<Blueprint>): Record<string, unknown> {
  const fields = parts.data?.fields ?? [];
  const count = (fs: typeof fields): number => fs.reduce((n, f) => n + 1 + (f.fields ? count(f.fields) : 0), 0);
  const out: Record<string, unknown> = {};
  if (parts.data) out.form = { fields: count(fields), pages: parts.experience?.pages.length ?? 0, roles: parts.roles?.length ?? 0 };
  if (parts.workflow) {
    out.workflow = {
      states: parts.workflow.states.length,
      transitions: parts.workflow.transitions.length,
      approvals: parts.workflow.approvals.length,
      tasks: parts.workflow.tasks.length,
      emails: parts.communications?.email.length ?? 0,
    };
  }
  if (parts.outputs) {
    out.finish = {
      documents: parts.outputs.documents.length,
      metrics: parts.outputs.dashboard?.metrics?.length ?? 0,
      tests: parts.tests?.length ?? 0,
    };
  }
  return out;
}

export async function generateStaged(provider: Provider, options: StagedOptions): Promise<GenerationOutcome> {
  const startedAt = new Date();
  const maxRepairs = options.maxRepairs ?? 2;
  const attempts: Attempt[] = [];
  const parts: Record<string, unknown> = {};
  let counter = 0;

  /** One reply from the model, checked against the shape this stage asked for. */
  const call = async <T,>(stage: string, shape: z.ZodType<T>, user: string, allowRetry = true): Promise<T> => {
    const schema = zodToJsonSchema(shape as never, { $refStrategy: 'root' }) as Record<string, unknown>;
    const response = await provider.generate({
      description: options.description,
      pack: options.pack,
      system: SYSTEM_PROMPT,
      user,
      schema,
      shape,
      stage,
    });
    counter++;
    const usage = (outcome: UsageRecord['outcome']) =>
      options.onUsage?.({
        provider: provider.name,
        model: provider.model,
        stage,
        attempt: counter,
        inputTokens: response.meta.inputTokens,
        outputTokens: response.meta.outputTokens,
        costUsd: response.meta.costUsd,
        latencyMs: response.meta.latencyMs,
        outcome,
      });
    if (response.meta.refusal) {
      attempts.push({ attempt: counter, stage, meta: response.meta, shapeOk: false, shapeIssues: [response.meta.refusal], errors: [], warnings: [] });
      await usage('refused');
      throw new StageFailed(stage, [response.meta.refusal], response.meta);
    }
    const candidate = response.parsed ?? tryExtract(response.text);
    const parsed = shape.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      attempts.push({ attempt: counter, stage, meta: response.meta, shapeOk: false, shapeIssues: issues, errors: [], warnings: [] });
      await usage('shape');
      if (!allowRetry) throw new StageFailed(stage, issues, response.meta);
      // One more try, told what was wrong. Shape failures at this size are
      // usually a missing key or a wrong enum, not a design problem.
      return call(
        stage,
        shape,
        `${user}\n\nYour previous reply could not be read as the object this stage asks for:\n${issues.map((i) => `- ${i}`).join('\n')}\n\nReturn the corrected object, complete, with only the keys this stage asks for.`,
        false,
      );
    }
    attempts.push({ attempt: counter, stage, meta: response.meta, shapeOk: true, shapeIssues: [], errors: [], warnings: [] });
    await usage('ok');
    return parsed.data;
  };

  const tell = async (stage: StageProgress['stage'], note: string) =>
    options.onStage?.({ stage, note, progress: summarize(parts as Partial<Blueprint>) });

  let decision: Decision = 'unparseable';
  let blueprint: Blueprint | undefined;
  let diagnostics: Diagnostic[] = [];
  let scenarios: ScenarioResult[] | undefined;
  let reviewable: GenerationOutcome['reviewable'];
  let editable: GenerationOutcome['editable'];
  let repairs = 0;

  try {
    // ---- 1. the form
    await tell('form', 'Stage 1 of 3: the questions, pages and roles');
    Object.assign(parts, await call('form', FormStage, stageTurn('form', options.description, options.pack, parts)));
    await tell('workflow', 'Stage 2 of 3: the stages, decisions, work and messages');

    // ---- 2. the workflow and the messages it sends
    Object.assign(parts, await call('workflow', WorkflowStage, stageTurn('workflow', options.description, options.pack, parts)));

    // A model often hands back transitions that request approvals, create
    // tasks and send templates it never defined. Caught here, before the test
    // scenarios are written against a workflow that cannot run, one more
    // workflow reply is cheaper than a repair round later.
    const missing = missingDefinitions(parts);
    if (missing.length) {
      await tell('workflow', `Stage 2 of 3: defining ${missing.length} thing(s) the workflow named but left out`);
      Object.assign(parts, await call(
        'workflow',
        WorkflowStage,
        `${stageTurn('workflow', options.description, options.pack, parts)}\n\nYour previous reply named things it did not define:\n${missing.map((m) => `- ${m}`).join('\n')}\n\nReturn workflow and communications again, complete, with every approval, task and email template defined in the same reply.`,
      ));
    }
    await tell('finish', 'Stage 3 of 3: documents, dashboard and test scenarios');

    // ---- 3. outputs and tests
    Object.assign(parts, await call('finish', FinishStage, stageTurn('finish', options.description, options.pack, parts)));
    await tell('checking', 'Compiling the assembled draft');

    // ---- assemble, then repair by section
    for (let round = 0; round <= maxRepairs; round++) {
      const whole = Blueprint.safeParse(parts);
      if (!whole.success) {
        // The stages each parsed, so this is a cross-stage disagreement the
        // schema can see: repaired like a compile error.
        const issues = whole.error.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        diagnostics = issues.map((m) => ({ code: 'SHAPE', severity: 'error' as const, at: m.split(':')[0]!, message: m }));
      } else {
        const { blueprint: normalized } = normalizeBlueprint(whole.data);
        Object.assign(parts, normalized);
        const compiled = validate(normalized, options.description);
        diagnostics = [...compiled.items];
        const last = attempts[attempts.length - 1];
        if (last) {
          last.errors = compiled.errors;
          last.warnings = compiled.warnings;
        }
        if (compiled.errors.length && (!editable || compiled.errors.length < editable.errors.length)) {
          editable = { blueprint: normalized, errors: compiled.errors };
        }
        if (!compiled.errors.length) {
          blueprint = normalized;
          if (options.pool) {
            await tell('checking', 'Running the scenarios on the engine');
            scenarios = await runScenarios(options.pool, normalized);
            const failed = scenarios.filter((s) => !s.passed);
            if (failed.length) {
              diagnostics = failed.map((s): Diagnostic => ({
                code: 'SCENARIO',
                severity: 'error',
                at: `tests.${s.test}`,
                message: `The blueprint's "${s.kind}" scenario failed: ${s.failures.join('; ')}`,
                fix: 'Fix the workflow, or the scenario if its expectation is wrong.',
              }));
              if (!reviewable || failed.length < reviewable.scenarios.filter((x) => !x.passed).length) {
                reviewable = { blueprint: normalized, scenarios };
              }
              decision = 'blocked';
            } else {
              decision = 'publishable';
              break;
            }
          } else {
            decision = 'publishable';
            break;
          }
        } else {
          decision = 'blocked';
        }
      }
      if (round === maxRepairs) break;

      // Only the sections the errors point at come back; the rest is context.
      const sections = sectionsFor(diagnostics);
      repairs++;
      await tell('repair', `Repair ${round + 1} of ${maxRepairs}: ${diagnostics.filter((d) => d.severity === 'error').length} thing(s) in ${sections.join(', ')}`);
      const shape = z.object(Object.fromEntries(sections.map((s) => [s, SECTION[s]!]))).strict();
      const fixed = await call(
        `repair:${sections.join('+')}`,
        shape,
        `${stageTurn('repair', options.description, options.pack, parts, sections)}\n\n${repairTurn(diagnostics)}`,
      );
      Object.assign(parts, fixed);
    }
  } catch (err) {
    if (!(err instanceof StageFailed)) throw err;
    decision = err.issues[0] === err.meta.refusal ? 'refused' : 'unparseable';
  }

  const totals = attempts.reduce(
    (acc, a) => ({
      input: acc.input + (a.meta.inputTokens ?? 0),
      output: acc.output + (a.meta.outputTokens ?? 0),
      cost: a.meta.costUsd === undefined ? acc.cost : (acc.cost ?? 0) + a.meta.costUsd,
    }),
    { input: 0, output: 0, cost: undefined as number | undefined },
  );

  return {
    decision,
    blueprint: decision === 'publishable' ? blueprint : undefined,
    reviewable: decision === 'publishable' ? undefined : reviewable,
    editable: decision === 'publishable' || reviewable ? undefined : editable,
    attempts,
    diagnostics,
    scenarios,
    staged: true,
    audit: {
      promptVersion: PROMPT_VERSION,
      provider: provider.name,
      model: provider.model,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      repairs,
      totalInputTokens: totals.input,
      totalOutputTokens: totals.output,
      totalCostUsd: totals.cost,
    },
  };
}

/** The top-level sections a set of diagnostics points at, in blueprint order. */
/**
 * What a workflow stage referred to without defining: approvals requested,
 * tasks created or waited on, templates sent. Plain reference checks, so they
 * run on the stage's own output before anything is built on it.
 */
export function missingDefinitions(parts: Record<string, unknown>): string[] {
  const wf = parts.workflow as Partial<Blueprint['workflow']> | undefined;
  const comms = parts.communications as Partial<Blueprint['communications']> | undefined;
  if (!wf) return [];
  const approvals = new Set((wf.approvals ?? []).map((a) => a.key));
  const tasks = new Set((wf.tasks ?? []).map((t) => t.key));
  const templates = new Set((comms?.email ?? []).map((e) => e.key));
  const out = new Set<string>();
  for (const t of wf.transitions ?? []) {
    for (const a of t.actions ?? []) {
      if (a.do === 'request_approval' && !approvals.has(a.approval)) out.add(`approval "${a.approval}" is requested by transition "${t.key}" but is not in workflow.approvals`);
      if (a.do === 'create_task' && !tasks.has(a.task)) out.add(`task "${a.task}" is created by transition "${t.key}" but is not in workflow.tasks`);
      if (a.do === 'send_email' && !templates.has(a.template)) out.add(`email template "${a.template}" is sent by transition "${t.key}" but is not in communications.email`);
    }
    const on = t.trigger;
    if (on?.on === 'approval_decided' && !approvals.has(on.approval)) out.add(`approval "${on.approval}" decides transition "${t.key}" but is not in workflow.approvals`);
    if (on?.on === 'task_completed' && !tasks.has(on.task)) out.add(`task "${on.task}" completes transition "${t.key}" but is not in workflow.tasks`);
    if (on?.on === 'tasks_completed') for (const k of on.tasks) if (!tasks.has(k)) out.add(`task "${k}" completes transition "${t.key}" but is not in workflow.tasks`);
  }
  return [...out];
}

export function sectionsFor(diagnostics: Diagnostic[]): string[] {
  const hit = new Set<string>();
  for (const d of diagnostics) {
    if (d.severity !== 'error') continue;
    const head = d.at.split(/[.[]/)[0] ?? '';
    if (d.code === 'SCENARIO') {
      hit.add('tests');
      hit.add('workflow');
    } else if (SECTION[head]) {
      hit.add(head);
    } else {
      hit.add('workflow');
    }
  }
  // Fields and pages are designed together: a required field missing from
  // every page is fixed on a page, and a page naming an unknown field is fixed
  // in the fields. Asking for one without the other cannot settle either.
  if (hit.has('data') || hit.has('experience')) { hit.add('data'); hit.add('experience'); }
  // "Role X cannot edit field Y" is fixed in the role's permissions, which
  // live in the form section, however the error is addressed.
  if (diagnostics.some((d) => d.severity === 'error' && /cannot edit|editable/i.test(d.message))) hit.add('roles');
  // A transition that sends an unknown template is fixed by defining it.
  if (diagnostics.some((d) => d.severity === 'error' && /template/i.test(d.message))) hit.add('communications');
  // A test names fields, states and templates, so a change to any of those
  // usually wants the tests looked at too.
  if (['data', 'workflow', 'communications'].some((s) => hit.has(s))) hit.add('tests');
  return SECTION_ORDER.filter((s) => hit.has(s));
}

function tryExtract(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return undefined;
  }
}
