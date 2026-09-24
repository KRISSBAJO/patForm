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

export type ProviderName = 'deepseek' | 'anthropic' | 'openai';

/**
 * Picks a provider by name. Adding a third one is a case here and a file
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
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) available.push('anthropic');
  if (process.env.OPENAI_API_KEY) available.push('openai');
  return available;
}

/** The generated JSON Schema, which providers use to constrain output. */
export function blueprintSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync('schema/blueprint-0.1.json', 'utf8'));
}
