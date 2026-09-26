import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layoutPages } from '../src/blueprint/layout.js';
import { Experience } from '../src/blueprint/experience.js';

const pages = () => [
  {
    key: 'about',
    title: 'About you',
    description: 'Who is asking.',
    sections: [
      { key: 's1', title: 'Name', fields: ['first', 'last', 'email'] },
      { key: 's2', fields: ['phone'] },
    ],
  },
  {
    key: 'claim',
    title: 'Your claim',
    visibleWhen: { op: 'is_present', left: { field: 'email' } },
    sections: [{ key: 's3', title: 'Items', description: 'One line each.', fields: ['items', 'total', 'notes', 'receipt', 'date'] }],
  },
];

test('as designed, the pages are returned as they are', () => {
  const input = pages();
  assert.equal(layoutPages(input), input);
  assert.equal(layoutPages(input, { mode: 'pages' }), input);
  assert.deepEqual(layoutPages([], { mode: 'single' }), []);
});

test('one page keeps the first heading and turns later page titles into section titles', () => {
  const out = layoutPages(pages(), { mode: 'single' });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.key, 'all');
  assert.equal(out[0]!.title, 'About you');
  assert.equal(out[0]!.visibleWhen, undefined);
  assert.deepEqual(out[0]!.sections.map((s) => s.title), ['Name', undefined, 'Your claim · Items']);
  // The second page's condition travels with its section.
  assert.deepEqual(out[0]!.sections[2]!.visibleWhen, { op: 'is_present', left: { field: 'email' } });
  assert.equal(out[0]!.sections.flatMap((s) => s.fields).length, 9);
});

test('steps cut the questions where the count says and carry a section on', () => {
  const out = layoutPages(pages(), { mode: 'steps', perStep: 3 });
  assert.deepEqual(out.map((p) => p.key), ['step_1', 'step_2', 'step_3']);
  assert.deepEqual(out.map((p) => p.sections.flatMap((s) => s.fields)), [
    ['first', 'last', 'email'],
    ['phone', 'items', 'total'],
    ['notes', 'receipt', 'date'],
  ]);
  // A step takes the title of the page it opened on.
  assert.deepEqual(out.map((p) => p.title), ['About you', 'About you', 'Your claim']);
  // The description belongs to the first step only.
  assert.deepEqual(out.map((p) => p.description), ['Who is asking.', undefined, undefined]);
  // The cut section keeps its heading on its first part and not on the rest.
  const parts = out.flatMap((p) => p.sections).filter((s) => s.key.startsWith('s3'));
  assert.deepEqual(parts.map((s) => [s.key, s.title]), [['s3', 'Items'], ['s3_2', undefined]]);
  // Every part of a conditional page's section keeps the condition.
  assert.ok(parts.every((s) => s.visibleWhen !== undefined));
  // The total is never lost or doubled.
  assert.equal(out.flatMap((p) => p.sections).flatMap((s) => s.fields).length, 9);
});

test('a step size larger than the form gives one step', () => {
  const out = layoutPages(pages(), { mode: 'steps', perStep: 20 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.sections.length, 3);
});

test('the server and the web app run the same layout code', () => {
  const a = readFileSync('src/blueprint/layout.ts', 'utf8').replace(/\r\n/g, '\n');
  const b = readFileSync('web/components/form-layout.ts', 'utf8').replace(/\r\n/g, '\n');
  assert.equal(a, b, 'src/blueprint/layout.ts and web/components/form-layout.ts must be identical');
});

test('the schema takes a typeface, a size and a layout, and refuses nonsense', () => {
  const base = { pages: pages(), confirmation: { message: 'Thank you.' } };
  const ok = Experience.parse({ ...base, branding: { font: 'serif', size: 'large', style: 'soft' }, layout: { mode: 'steps', perStep: 5 } });
  assert.equal(ok.layout?.perStep, 5);
  assert.equal(ok.branding?.font, 'serif');
  assert.ok(!Experience.safeParse({ ...base, layout: { mode: 'steps', perStep: 0 } }).success);
  assert.ok(!Experience.safeParse({ ...base, layout: { mode: 'steps', perStep: 21 } }).success);
  assert.ok(!Experience.safeParse({ ...base, branding: { font: 'comic' } }).success);
  assert.ok(!Experience.safeParse({ ...base, branding: { size: 'huge' } }).success);
});
