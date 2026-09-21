import OpenAI from 'openai';
import { costOf, extractJson, type GenerationRequest, type Provider, type ProviderResponse, type Rates } from './provider.js';

/**
 * Rates in dollars per million tokens, from OPENAI_RATES if you set it
 * (`input:output`, e.g. "0.15:0.60"). Left undefined otherwise: an invented
 * price is worse than a blank in a cost report.
 */
function ratesFromEnv(): Rates | undefined {
  const raw = process.env.OPENAI_RATES;
  if (!raw) return undefined;
  const [input, output] = raw.split(':').map(Number);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  return { inputPerMillion: input!, outputPerMillion: output! };
}

/**
 * OpenAI, through the OpenAI SDK.
 *
 * This exists because §19 names vendor dependency as a standing risk and
 * §17.3 says to use a provider abstraction. A second provider is the only
 * honest way to know the abstraction actually holds: the first time you need
 * it is a bad time to discover the interface leaked.
 *
 * `json_schema` response format is requested with `strict: false`. Strict mode
 * forbids most of what the blueprint schema needs — optional properties,
 * unions, and recursion — so the schema is a strong hint here rather than a
 * guarantee. The compiler is the guarantee.
 */
export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  readonly model: string;
  private readonly client: OpenAI;
  private readonly rates = ratesFromEnv();
  private schemaFormatWorks = true;

  constructor(opts: { model?: string; apiKey?: string } = {}) {
    this.client = opts.apiKey ? new OpenAI({ apiKey: opts.apiKey }) : new OpenAI();
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  }

  async generate(request: GenerationRequest): Promise<ProviderResponse> {
    const started = Date.now();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: request.system },
      {
        role: 'system',
        content: `The blueprint must validate against this JSON Schema:\n\n${JSON.stringify(request.schema)}`,
      },
      { role: 'user', content: request.user },
    ];

    let completion: OpenAI.Chat.ChatCompletion;
    let mode: 'structured' | 'text' = 'structured';

    try {
      if (!this.schemaFormatWorks) throw new SkipSchema();
      completion = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_completion_tokens: 16000,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'process_blueprint',
            strict: false,
            schema: request.schema,
          },
        },
      });
    } catch (err) {
      if (!(err instanceof SkipSchema) && !isSchemaRejection(err)) throw err;
      this.schemaFormatWorks = false;
      mode = 'text';
      completion = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_completion_tokens: 16000,
        response_format: { type: 'json_object' },
      });
    }

    const choice = completion.choices[0];
    const text = choice?.message.content ?? '';

    if (choice?.message.refusal) {
      return {
        text: '',
        meta: {
          provider: this.name,
          model: this.model,
          mode,
          latencyMs: Date.now() - started,
          refusal: choice.message.refusal,
        },
      };
    }

    const inputTokens = completion.usage?.prompt_tokens;
    const outputTokens = completion.usage?.completion_tokens;

    return {
      text,
      parsed: text ? safeExtract(text) : undefined,
      meta: {
        provider: this.name,
        model: this.model,
        mode,
        latencyMs: Date.now() - started,
        inputTokens,
        outputTokens,
        costUsd: costOf(this.rates, inputTokens, outputTokens),
      },
    };
  }
}

class SkipSchema extends Error {}

function safeExtract(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return undefined;
  }
}

function isSchemaRejection(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status !== 400) return false;
  const message = String(err.message).toLowerCase();
  return message.includes('schema') || message.includes('response_format') || message.includes('json_schema');
}
