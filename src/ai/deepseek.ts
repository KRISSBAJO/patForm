import OpenAI from 'openai';
import { costOf, extractJson, type GenerationRequest, type Provider, type ProviderResponse, type Rates } from './provider.js';

/** DeepSeek's documented OpenAI-compatible Chat Completions endpoint. */
export class DeepSeekProvider implements Provider {
  readonly name = 'deepseek';
  readonly model: string;
  private readonly client: OpenAI;
  private readonly rates: Rates | undefined;

  constructor(opts: { model?: string; apiKey?: string } = {}) {
    const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not configured');
    this.client = new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com', timeout: 120_000, maxRetries: 0 });
    this.model = opts.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
    const raw = process.env.DEEPSEEK_RATES;
    const [input, output] = raw?.split(':').map(Number) ?? [];
    this.rates = Number.isFinite(input) && Number.isFinite(output)
      ? { inputPerMillion: input!, outputPerMillion: output! } : undefined;
  }

  async generate(request: GenerationRequest): Promise<ProviderResponse> {
    const started = Date.now();
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: `${request.system}\n\nReturn one JSON object. It must match this JSON schema:\n${JSON.stringify(request.schema)}` },
        { role: 'user', content: request.user },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 16000,
    });
    const choice = completion.choices[0];
    const content = choice?.message.content ?? '';
    if (choice?.finish_reason === 'length') throw new Error('DeepSeek response reached its output limit');
    if (!content.trim()) throw new Error('DeepSeek returned no JSON content');
    let parsed: unknown;
    try { parsed = extractJson(content); }
    catch { throw new Error('DeepSeek returned invalid JSON'); }
    const inputTokens = completion.usage?.prompt_tokens;
    const outputTokens = completion.usage?.completion_tokens;
    return {
      text: content,
      parsed,
      meta: {
        provider: this.name,
        model: this.model,
        mode: 'structured',
        latencyMs: Date.now() - started,
        inputTokens,
        outputTokens,
        costUsd: costOf(this.rates, inputTokens, outputTokens),
      },
    };
  }
}
