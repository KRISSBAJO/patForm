import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableProviders, providerFor } from '../src/ai/index.js';

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
