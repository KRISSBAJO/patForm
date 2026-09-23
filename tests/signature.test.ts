import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SIGNATURE_IMAGE, signatureProblem, signatureWords } from '../src/blueprint/signature.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('a typed signature needs a name and one of the styles', () => {
  assert.equal(signatureProblem({ method: 'typed', name: 'Ada Nwosu', style: 'flowing' }), null);
  assert.match(signatureProblem({ method: 'typed', name: 'Ada Nwosu', style: 'gothic' })!, /styles/);
  assert.match(signatureProblem({ method: 'typed', name: ' ', style: 'flowing' })!, /full name/);
});

test('a drawn signature is a PNG and nothing else', () => {
  assert.equal(signatureProblem({ method: 'drawn', name: 'Ada Nwosu', image: PNG }), null);
  // Anything that is not a PNG data URL is refused, because the value is
  // shown in an <img> on every record that holds it.
  for (const image of [
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'javascript:alert(1)',
    'https://example.com/sig.png',
    'data:image/png;base64,not base64!',
  ]) {
    assert.ok(signatureProblem({ method: 'drawn', name: 'Ada Nwosu', image }), image);
  }
});

test('a drawn signature has a size limit', () => {
  const huge = `data:image/png;base64,${'A'.repeat(MAX_SIGNATURE_IMAGE)}`;
  assert.match(signatureProblem({ method: 'drawn', name: 'Ada Nwosu', image: huge })!, /too large/);
});

test('anything that is not a signature is refused', () => {
  for (const value of [true, 'Ada Nwosu', null, {}, { method: 'stamped', name: 'Ada Nwosu' }]) {
    assert.ok(signatureProblem(value), JSON.stringify(value));
  }
});

test('in words, a signature says who and how, never the image', () => {
  const words = signatureWords({ method: 'drawn', name: 'Ada Nwosu', image: PNG });
  assert.equal(words, 'Signed by Ada Nwosu (drawn)');
  assert.ok(!words.includes('base64'));
});
