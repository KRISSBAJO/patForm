import type { Diagnostic } from '../compiler/diagnostics.js';

/**
 * The provider boundary required by §17.3 ("use provider abstraction") and
 * §19 ("vendor dependency: AI or messaging changes price or policy →
 * provider interfaces, exportability, budgets, graceful degradation").
 *
 * Nothing above this line knows which model produced a blueprint, and nothing
 * below it knows what a blueprint means. Each provider lives in its own file
 * and uses its own vendor SDK — there is no compatibility shim in between,
 * because a shim would quietly hide the behaviour differences that matter.
 */

export interface GenerationRequest {
  /** What the customer typed, verbatim. Untrusted. */
  description: string;
  /** A process pack to bias the proposal, if one was chosen. */
  pack?: string;
  /** The system prompt, from the versioned registry. */
  system: string;
  /** The user turn, from the versioned registry. */
  user: string;
  /** JSON Schema for a blueprint, for providers that can constrain output. */
  schema: Record<string, unknown>;
  /** Set on a repair attempt so the provider can label the call. */
  repair?: { attempt: number; diagnostics: Diagnostic[] };
}

export interface ProviderResponse {
  /** Raw model output. Treated as untrusted input by everything downstream. */
  text: string;
  /** Present only when the provider returned already-parsed structured output. */
  parsed?: unknown;
  meta: ProviderMeta;
}

export interface ProviderMeta {
  provider: string;
  model: string;
  /** "structured" when the provider constrained the shape, "text" otherwise. */
  mode: 'structured' | 'text';
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Undefined when this provider's rates are not configured. */
  costUsd?: number;
  /** Set when the provider declined rather than failed. */
  refusal?: string;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  generate(request: GenerationRequest): Promise<ProviderResponse>;
}

/** Rates in dollars per million tokens. Only fill in what you can verify. */
export interface Rates {
  inputPerMillion: number;
  outputPerMillion: number;
}

export function costOf(
  rates: Rates | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | undefined {
  if (!rates || inputTokens === undefined || outputTokens === undefined) return undefined;
  return (inputTokens * rates.inputPerMillion + outputTokens * rates.outputPerMillion) / 1_000_000;
}

/**
 * Extracts a JSON object from model output that may be wrapped in prose or a
 * fenced code block. This is deliberately forgiving about *packaging* and not
 * at all forgiving about *content* — whatever comes out still has to survive
 * the Zod parse and the compiler.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenced ? fenced[1]! : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost balanced braces, which handles a model that
    // wrote a sentence before or after the object.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error('model output did not contain parseable JSON');
  }
}
