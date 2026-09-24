import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableProviders, providerFor, withProviderFallback } from '../src/ai/index.js';
import type { Provider } from '../src/ai/provider.js';

test('DeepSeek is an explicit provider and takes priority when configured', () => {
  const old = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-only-key';
  try {
    assert.equal(availableProviders()[0], 'deepseek');
    const provider = providerFor('deepseek');
    assert.equal(provider.name, 'deepseek');
    assert.equal(provider.model, process.env.DEEPSEEK_MODEL || 'deepseek-flash');
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = old;
  }
});

test('the configured preference is DeepSeek, OpenAI, then Anthropic', () => {
  const before = {
    deepseek: process.env.DEEPSEEK_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
  };
  process.env.DEEPSEEK_API_KEY = 'test-only-key';
  process.env.OPENAI_API_KEY = 'test-only-key';
  process.env.ANTHROPIC_API_KEY = 'test-only-key';
  try {
    assert.deepEqual(availableProviders(), ['deepseek', 'openai', 'anthropic']);
  } finally {
    for (const [key, value] of Object.entries({
      DEEPSEEK_API_KEY: before.deepseek,
      OPENAI_API_KEY: before.openai,
      ANTHROPIC_API_KEY: before.anthropic,
      ANTHROPIC_AUTH_TOKEN: before.token,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a request error falls through in order and stays with the successful provider', async () => {
  const called: string[] = [];
  const failing = (name: string): Provider => ({
    name, model: `${name}-model`,
    async generate() { called.push(name); throw new Error(`${name} failed`); },
  });
  const working: Provider = {
    name: 'anthropic', model: 'anthropic-model',
    async generate() {
      called.push('anthropic');
      return { text: '{}', meta: { provider: 'anthropic', model: 'anthropic-model', mode: 'text', latencyMs: 1 } };
    },
  };
  const provider = withProviderFallback([failing('deepseek'), failing('openai'), working]);
  const request = { description: '', system: '', user: '', schema: {} };
  assert.equal((await provider.generate(request)).meta.provider, 'anthropic');
  assert.equal(provider.name, 'anthropic');
  await provider.generate(request);
  assert.deepEqual(called, ['deepseek', 'openai', 'anthropic', 'anthropic']);
});

test('a model refusal is returned without sending the request to another provider', async () => {
  let fallbackCalled = false;
  const primary: Provider = {
    name: 'deepseek', model: 'deepseek-flash',
    async generate() {
      return { text: '', meta: { provider: 'deepseek', model: 'deepseek-flash', mode: 'text', latencyMs: 1, refusal: 'declined' } };
    },
  };
  const fallback: Provider = {
    name: 'openai', model: 'test',
    async generate() { fallbackCalled = true; throw new Error('should not run'); },
  };
  const result = await withProviderFallback([primary, fallback]).generate({ description: '', system: '', user: '', schema: {} });
  assert.equal(result.meta.refusal, 'declined');
  assert.equal(fallbackCalled, false);
});
