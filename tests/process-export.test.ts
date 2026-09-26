import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportCell } from '../src/runtime/export.js';

/**
 * A spreadsheet of a whole process: what goes in a cell.
 *
 * The on-screen text is for reading; a cell is for sorting and summing. So a
 * choice becomes its label, a number stays a number, a date stays ISO, and a
 * list of rows becomes JSON rather than "3 rows".
 */
const choice = { type: 'dropdown' as const, choices: [{ value: 'annual', label: 'Annual leave' }, { value: 'sick', label: 'Sick leave' }] };

test('choices export as their labels, several joined with a semicolon', () => {
  assert.equal(exportCell(choice, 'annual'), 'Annual leave');
  assert.equal(exportCell({ ...choice, type: 'multi_choice' }, ['annual', 'sick']), 'Annual leave; Sick leave');
  assert.equal(exportCell(choice, 'other'), 'other');
});

test('numbers stay numbers so a column can be summed', () => {
  assert.equal(exportCell({ type: 'currency' }, 1234.5), 1234.5);
  assert.equal(exportCell({ type: 'number' }, '42'), 42);
  assert.equal(exportCell({ type: 'rating' }, 4), 4);
});

test('yes/no, dates, files and lists come out as a spreadsheet wants them', () => {
  assert.equal(exportCell({ type: 'yes_no' }, true), 'Yes');
  assert.equal(exportCell({ type: 'yes_no' }, false), 'No');
  assert.equal(exportCell({ type: 'date' }, '2026-09-26'), '2026-09-26');
  assert.equal(exportCell({ type: 'file' }, [{ id: 'a' }, { id: 'b' }]), '2 files');
  assert.equal(exportCell({ type: 'repeating_group' }, [{ item: 'Taxi', amount: 12 }]), '[{"item":"Taxi","amount":12}]');
  assert.equal(exportCell({ type: 'short_text' }, null), '');
});

test('a hidden child of a list row is dropped, not written as "[redacted]"', () => {
  const cell = exportCell({ type: 'repeating_group' }, [{ item: 'Taxi', account: '[redacted]' }]);
  assert.equal(cell, '[{"item":"Taxi"}]');
});
