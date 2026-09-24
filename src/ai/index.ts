import { readFileSync } from 'node:fs';
import type { Provider } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { DeepSeekProvider } from './deepseek.js';

export * from './provider.js';
export * from './pipeline.js';
export * from './prompt.js';
export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider } from './openai.js';
export { DeepSeekProvider } from './deepseek.js';

export type ProviderName = 'deepseek' | 'openai' | 'anthropic';

/**
 * Picks a provider by name. Adding another is a case here and a file
 * beside it; nothing in the pipeline changes.
 */
export function providerFor(name: ProviderName, model?: string): Provider {
  switch (name) {
    case 'deepseek':
      return new DeepSeekProvider({ model });
    case 'anthropic':
      return new AnthropicProvider({ model });
    case 'openai':
      return new OpenAIProvider({ model });
  }
}

export function availableProviders(): ProviderName[] {
  const available: ProviderName[] = [];
  if (process.env.DEEPSEEK_API_KEY) available.push('deepseek');
  if (process.env.OPENAI_API_KEY) available.push('openai');
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) available.push('anthropic');
  return available;
}

/** Retry a failed request with the next configured provider. A refusal is a
 * completed model response, so the caller handles it without falling through. */
export function withProviderFallback(providers: Provider[]): Provider {
  if (!providers.length) throw new Error('no AI provider is configured');
  let selected = 0;
  return {
    get name() { return providers[selected]!.name; },
    get model() { return providers[selected]!.model; },
    async generate(request) {
      let lastError: unknown;
      for (let index = selected; index < providers.length; index++) {
        try {
          const response = await providers[index]!.generate(request);
          selected = index;
          return response;
        } catch (error) {
          lastError = error;
          selected = Math.min(index + 1, providers.length - 1);
        }
      }
      throw lastError;
    },
  };
}

/** Explicit provider choices stay explicit; the default uses the priority list. */
export function preferredProvider(explicit?: ProviderName): Provider {
  if (explicit) return providerFor(explicit);
  return withProviderFallback(availableProviders().map((name) => providerFor(name)));
}

/** The generated JSON Schema, which providers use to constrain output. */
export function blueprintSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync('schema/blueprint-0.1.json', 'utf8'));
}
