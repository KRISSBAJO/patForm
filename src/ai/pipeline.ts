import { Blueprint } from '../blueprint/index.js';
import { validate } from '../compiler/validate.js';
import type { Diagnostic } from '../compiler/diagnostics.js';
import { runScenarios, type ScenarioResult } from '../runtime/scenarios.js';
import type { Pool } from '../runtime/db.js';
import { PROMPT_VERSION, SYSTEM_PROMPT, repairTurn, userTurn } from './prompt.js';
import { extractJson, type Provider, type ProviderMeta } from './provider.js';

export type Decision =
  | 'publishable' // compiled clean, and scenarios passed if they were run
  | 'blocked' // compiled, but with errors a human must resolve
  | 'unparseable' // never produced something shaped like a blueprint
  | 'refused'; // the provider declined to answer

export interface Attempt {
  attempt: number;
  meta: ProviderMeta;
  shapeOk: boolean;
  /** Zod issues, when the output was not a blueprint at all. */
  shapeIssues: string[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

export interface GenerationOutcome {
  decision: Decision;
  blueprint?: Blueprint;
  /** A compiling draft whose sample scenarios still need human repair. Never publish directly. */
  reviewable?: { blueprint: Blueprint; scenarios: ScenarioResult[] };
  /** A shape-valid private draft with compiler errors. It can be edited but never published as-is. */
  editable?: { blueprint: Blueprint; errors: Diagnostic[] };
  attempts: Attempt[];
  diagnostics: Diagnostic[];
  scenarios?: ScenarioResult[];
  /** §7.3: model, prompt template version, execution result, and errors. */
  audit: {
    promptVersion: string;
    provider: string;
    model: string;
    startedAt: string;
    durationMs: number;
    repairs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd?: number;
  };
}

export interface GenerateOptions {
  description: string;
  pack?: string;
  /** Existing draft to revise, rather than a process to invent from scratch. */
  sourceBlueprint?: Blueprint;
  /** §7.4 gates validity "after one repair attempt", so one is the default. */
  maxRepairs?: number;
  /** When given, a clean blueprint also has to pass its own scenarios. */
  pool?: Pool;
  /** Optional durable status callback for a queued draft. */
  onProgress?: (stage: 'generating' | 'checking') => Promise<void>;
}

/**
 * Turns a description into a blueprint, or refuses.
 *
 * This is the boundary §7.1 draws — "AI proposes; deterministic services
 * validate, authorize, execute, and audit" — as a runnable function. Three
 * gates, in order, and nothing skips ahead:
 *
 *   shape    does Zod recognise this as a blueprint at all?
 *   compile  would the runtime execute it safely? (BLD-04)
 *   run      do the blueprint's own scenarios pass? (BLD-05)
 *
 * A model that fails a gate gets the diagnostics back once. A model that fails
 * twice does not get to publish, and the caller is told exactly why.
 */
/**
 * BLD-02 as a gate.
 *
 * Every generated process makes assumptions — the description never covers
 * retention, or who approves what above which amount, or what happens when
 * somebody does not reply. Declaring none is not confidence; it is the model
 * not having been asked hard enough.
 */
function undeclaredAssumptions(bp: Blueprint): Diagnostic[] {
  const assumptions = bp.intent.assumptions ?? [];
  if (assumptions.length) return [];
  return [
    {
      code: 'BLD003',
      severity: 'error',
      at: 'intent.assumptions',
      message: 'This blueprint declares no assumptions, which is not credible for a generated process.',
      fix:
        'List what you decided that the description did not specify — retention, approval thresholds, what happens ' +
        'when nobody replies, which fields are required — each with what it affects. Put anything you could not ' +
        'decide in intent.openDecisions.',
    },
  ];
}

export async function generateBlueprint(
  provider: Provider,
  schema: Record<string, unknown>,
  options: GenerateOptions,
): Promise<GenerationOutcome> {
  const startedAt = new Date();
  const maxRepairs = options.maxRepairs ?? 1;
  const attempts: Attempt[] = [];

  const baseUser = userTurn(options.description, options.pack, options.sourceBlueprint);
  let user = baseUser;
  let blueprint: Blueprint | undefined;
  let diagnostics: Diagnostic[] = [];
  let decision: Decision = 'unparseable';
  let scenarios: ScenarioResult[] | undefined;
  let reviewable: GenerationOutcome['reviewable'];
  let editable: GenerationOutcome['editable'];

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    await options.onProgress?.('generating');
    const response = await provider.generate({
      description: options.description,
      pack: options.pack,
      system: SYSTEM_PROMPT,
      user,
      schema,
      repair: attempt > 1 ? { attempt, diagnostics } : undefined,
    });

    if (response.meta.refusal) {
      attempts.push({ attempt, meta: response.meta, shapeOk: false, shapeIssues: [response.meta.refusal], errors: [], warnings: [] });
      decision = 'refused';
      break;
    }

    // ------------------------------------------------------------ gate one
    await options.onProgress?.('checking');
    const candidate = response.parsed ?? tryExtract(response.text);
    const parsed = Blueprint.safeParse(candidate);

    if (!parsed.success) {
      const shapeIssues = parsed.error.issues
        .slice(0, 12)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      attempts.push({ attempt, meta: response.meta, shapeOk: false, shapeIssues, errors: [], warnings: [] });
      decision = 'unparseable';

      // Shape failures are repaired as pseudo-diagnostics so the same repair
      // path handles "this is not a blueprint" and "this blueprint is wrong".
      diagnostics = shapeIssues.map((message) => ({
        code: 'SHAPE',
        severity: 'error' as const,
        at: message.split(':')[0]!,
        message: message.split(': ').slice(1).join(': ') || message,
      }));
      // Shape errors often occur near the end of a large blueprint. Showing
      // only its first 2,000 characters makes the repair turn guess the rest
      // from scratch, which commonly repeats the same invalid structure.
      user = `${baseUser}\n\nYour previous reply could not be read as a blueprint:\n\n${response.text}\n\n${repairTurn(diagnostics)}`;
      continue;
    }

    // ------------------------------------------------------------ gate two
    const compiled = validate(parsed.data);
    diagnostics = [...compiled.items, ...undeclaredAssumptions(parsed.data)];
    const candidateErrors = diagnostics.filter((item) => item.severity === 'error');
    if (candidateErrors.length && (!editable || candidateErrors.length < editable.errors.length)) {
      editable = { blueprint: parsed.data, errors: candidateErrors };
    }
    attempts.push({
      attempt,
      meta: response.meta,
      shapeOk: true,
      shapeIssues: [],
      errors: compiled.errors,
      warnings: compiled.warnings,
    });

    /*
     * A blueprint that declares no assumptions is not finished being
     * generated.
     *
     * BLD-02 asks for assumptions and missing decisions, and adding the
     * fields plus a line in the prompt did not produce them: the first run
     * against "something for handling requests from staff, manager signs off"
     * came back with a complete process and both arrays empty. A model asked
     * for something optional at the end of a long instruction will skip it.
     *
     * So it is a gate rather than a request, repaired through the same loop as
     * a compiler error. A *hand-written* blueprint legitimately declares none —
     * a person decided everything deliberately — which is why this lives here
     * and not in the compiler.
     */
    const undeclared = undeclaredAssumptions(parsed.data);
    if (compiled.publishable && !undeclared.length) {
      blueprint = parsed.data;
      // A failed scenario is repairable too. Previously this gate ran only
      // after the final model turn, so its diagnostics could never reach the
      // one repair turn promised by the pipeline.
      if (options.pool) {
        scenarios = await runScenarios(options.pool, parsed.data);
        const scenarioErrors = scenarios.filter((s) => !s.passed).map((s): Diagnostic => ({
          code: 'SCENARIO', severity: 'error', at: `tests.${s.test}`,
          message: `The blueprint's "${s.kind}" scenario failed: ${s.failures.join('; ')}`,
          fix: 'Fix the workflow, or the scenario if its expectation is wrong.',
        }));
        diagnostics = [...diagnostics, ...scenarioErrors];
        if (scenarioErrors.length) {
          if (!reviewable || scenarioErrors.length < reviewable.scenarios.filter((item) => !item.passed).length) {
            reviewable = { blueprint: parsed.data, scenarios };
          }
          decision = 'blocked';
          user = `${baseUser}\n\nYou returned this blueprint:\n\n${JSON.stringify(parsed.data)}\n\n${repairTurn(diagnostics)}`;
          continue;
        }
      }
      decision = 'publishable';
      break;
    }
    if (compiled.publishable) {
      // It compiles; it is only under-declared. Keep it, so a second refusal
      // to answer still hands back a working process rather than nothing.
      blueprint = parsed.data;
    }

    decision = 'blocked';
    user = `${baseUser}\n\nYou returned this blueprint:\n\n${JSON.stringify(parsed.data)}\n\n${repairTurn(diagnostics)}`;
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
    audit: {
      promptVersion: PROMPT_VERSION,
      provider: provider.name,
      model: provider.model,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      repairs: Math.max(0, attempts.length - 1),
      totalInputTokens: totals.input,
      totalOutputTokens: totals.output,
      totalCostUsd: totals.cost,
    },
  };
}

function tryExtract(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return undefined;
  }
}
