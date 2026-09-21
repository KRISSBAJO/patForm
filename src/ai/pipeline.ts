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
  /** §7.4 gates validity "after one repair attempt", so one is the default. */
  maxRepairs?: number;
  /** When given, a clean blueprint also has to pass its own scenarios. */
  pool?: Pool;
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
export async function generateBlueprint(
  provider: Provider,
  schema: Record<string, unknown>,
  options: GenerateOptions,
): Promise<GenerationOutcome> {
  const startedAt = new Date();
  const maxRepairs = options.maxRepairs ?? 1;
  const attempts: Attempt[] = [];

  const baseUser = userTurn(options.description, options.pack);
  let user = baseUser;
  let blueprint: Blueprint | undefined;
  let diagnostics: Diagnostic[] = [];
  let decision: Decision = 'unparseable';

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
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
      user = `${baseUser}\n\nYour previous reply could not be read as a blueprint:\n\n${response.text.slice(0, 2000)}\n\n${repairTurn(diagnostics)}`;
      continue;
    }

    // ------------------------------------------------------------ gate two
    const compiled = validate(parsed.data);
    diagnostics = compiled.items;
    attempts.push({
      attempt,
      meta: response.meta,
      shapeOk: true,
      shapeIssues: [],
      errors: compiled.errors,
      warnings: compiled.warnings,
    });

    if (compiled.publishable) {
      blueprint = parsed.data;
      decision = 'publishable';
      break;
    }

    decision = 'blocked';
    user = `${baseUser}\n\nYou returned this blueprint:\n\n${JSON.stringify(parsed.data)}\n\n${repairTurn(diagnostics)}`;
  }

  // -------------------------------------------------------------- gate three
  let scenarios: ScenarioResult[] | undefined;
  if (blueprint && options.pool) {
    scenarios = await runScenarios(options.pool, blueprint);
    if (scenarios.some((s) => !s.passed)) {
      decision = 'blocked';
      diagnostics = [
        ...diagnostics,
        ...scenarios
          .filter((s) => !s.passed)
          .map((s) => ({
            code: 'SCENARIO',
            severity: 'error' as const,
            at: `tests.${s.test}`,
            message: `The blueprint's own "${s.kind}" scenario failed: ${s.failures.join('; ')}`,
            fix: 'The process does not do what its tests say it does. Fix the workflow, or the test if the test is wrong.',
          })),
      ];
    }
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
