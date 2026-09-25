import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Blueprint } from '../blueprint/index.js';
import { costOf, extractJson, type GenerationRequest, type Provider, type ProviderResponse, type Rates } from './provider.js';

/** Published rates, dollars per million tokens. */
const RATES: Record<string, Rates> = {
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-sonnet-5': { inputPerMillion: 2, outputPerMillion: 10 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
};

/**
 * Claude, through the Anthropic SDK.
 *
 * Two ways to get a blueprint back, tried in order:
 *
 *   1. Structured output — the schema constrains generation, so shape errors
 *      mostly cannot happen. The blueprint schema is deeply recursive (fields
 *      nest fields, expressions nest expressions), which not every structured
 *      output implementation accepts.
 *   2. Plain JSON in the response text.
 *
 * Either way the result is untrusted until the compiler says otherwise
 * (§7.3: "Model output is treated as untrusted input and validated against
 * strict schemas"). Structured output is a way to waste fewer tokens, not a
 * substitute for the gate.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private structuredOutputWorks = true;
  /** Why structured output was abandoned, surfaced once so it is not invisible. */
  structuredOutputError?: string;

  constructor(opts: { model?: string; apiKey?: string } = {}) {
    // Zero-arg construction resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
    // or a signed-in CLI profile. The key is never read into this process.
    this.client = opts.apiKey
      ? new Anthropic({ apiKey: opts.apiKey, timeout: 600_000, maxRetries: 0 })
      : new Anthropic({ timeout: 600_000, maxRetries: 0 });
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';
  }

  async generate(request: GenerationRequest): Promise<ProviderResponse> {
    const started = Date.now();
    // Bound the whole fallback, including a structured-output retry. A stream
    // can keep delivering chunks without hitting the SDK's per-request timeout.
    // Ten minutes. A page-long description becomes a 25,000-token blueprint,
    // and at two minutes every such request was aborted before it finished —
    // the strongest model configured could never answer the largest requests.
    const signal = AbortSignal.timeout(600_000);

    if (this.structuredOutputWorks) {
      try {
        return await this.structured(request, started, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        // Anything that would fail the freeform path too is a real failure.
        if (isFatal(err)) throw err;
        // Otherwise the schema was the problem, not the request: the blueprint
        // schema is recursive and written against zod v3, and the structured
        // output helper accepts neither universally. Stop trying it this run
        // and say so, rather than failing a generation over packaging.
        this.structuredOutputWorks = false;
        this.structuredOutputError = err instanceof Error ? err.message : String(err);
      }
    }

    return this.freeform(request, started, signal);
  }

  private async structured(request: GenerationRequest, started: number, signal: AbortSignal): Promise<ProviderResponse> {
    const response = await this.client.messages.parse({
      model: this.model,
      // Thinking counts against this. At 32,000 a page-long blueprint was cut
      // off mid-object twice out of three, and read as no blueprint at all.
      max_tokens: 64000,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: request.user }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: zodOutputFormat(Blueprint as never),
      },
    }, { signal });

    return this.wrap(response, started, 'structured', response.parsed_output ?? undefined);
  }

  private async freeform(request: GenerationRequest, started: number, signal: AbortSignal): Promise<ProviderResponse> {
    // Streamed because a full blueprint runs long, and a non-streaming request
    // at this max_tokens risks an HTTP timeout.
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 64000,
      system: [
        { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
        {
          type: 'text',
          text: `The blueprint must validate against this JSON Schema:\n\n${JSON.stringify(request.schema)}`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: request.user }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    }, { signal });

    const response = await stream.finalMessage();
    return this.wrap(response, started, 'text');
  }

  private wrap(
    response: Anthropic.Message,
    started: number,
    mode: 'structured' | 'text',
    parsed?: unknown,
  ): ProviderResponse {
    // §7.3 again: check why generation stopped before reading what it produced.
    if (response.stop_reason === 'refusal') {
      return {
        text: '',
        meta: {
          provider: this.name,
          model: this.model,
          mode,
          latencyMs: Date.now() - started,
          refusal: response.stop_details?.explanation ?? 'declined',
        },
      };
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const usage = response.usage;
    const inputTokens =
      usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);

    return {
      text,
      parsed: parsed ?? (text ? safeExtract(text) : undefined),
      meta: {
        provider: this.name,
        model: this.model,
        mode,
        latencyMs: Date.now() - started,
        inputTokens,
        outputTokens: usage.output_tokens,
        costUsd: costOf(RATES[this.model], inputTokens, usage.output_tokens),
      },
    };
  }
}

function safeExtract(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return undefined;
  }
}

/**
 * Errors the freeform path would hit as well. Everything else is treated as a
 * problem with constraining the output, and falls back.
 */
function isFatal(err: unknown): boolean {
  return (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.APIConnectionError ||
    (err instanceof Anthropic.APIError && err.status !== undefined && err.status >= 500)
  );
}
