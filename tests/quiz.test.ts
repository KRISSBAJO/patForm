import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Field } from '../src/blueprint/index.js';
import { scoreQuiz } from '../src/runtime/quiz.js';

const question = (key: string, correctValue: string): Field => ({
  key, label: key, type: 'single_choice', classification: 'public', required: true,
  choices: [{ value: 'a', label: 'First' }, { value: 'b', label: 'Second' }], correctValue,
});

test('quiz result counts correct answers and reveals only missed answer labels', () => {
  assert.deepEqual(scoreQuiz([question('one', 'a'), question('two', 'b')], { one: 'a', two: 'a' }), {
    correct: 1, total: 2, percentage: 50,
    missed: [{ question: 'two', correctAnswer: 'Second' }],
  });
});

test('forms without answer keys do not get a quiz result', () => {
  const ordinary = { ...question('one', 'a'), correctValue: undefined };
  assert.equal(scoreQuiz([ordinary], { one: 'a' }), undefined);
});
