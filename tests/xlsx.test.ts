import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { crc32, xlsx } from '../src/runtime/xlsx.js';

/**
 * The workbook writer, checked by reading its own output back.
 *
 * There is no spreadsheet library here to read with, so the test walks the
 * zip's central directory by hand, inflates each entry, checks the CRC the
 * writer stored against the bytes, and reads the cells out of the XML. If a
 * file passes this it is a well-formed zip with well-formed parts, which is
 * what Excel checks before it looks at anything else.
 */
function entries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endAt > 0, 'end of central directory');
  const count = buf.readUInt16LE(endAt + 10);
  let at = buf.readUInt32LE(endAt + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, 'central directory signature');
    const crc = buf.readUInt32LE(at + 16);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    assert.equal(buf.readUInt32LE(localAt), 0x04034b50, 'local header signature');
    const localNameLen = buf.readUInt16LE(localAt + 26);
    const dataAt = localAt + 30 + localNameLen;
    const data = inflateRawSync(buf.subarray(dataAt, dataAt + compressed));
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out.set(name, data);
    at += 46 + nameLen;
  }
  return out;
}

test('a workbook has its parts, and the cells come back as written', () => {
  const book = xlsx([
    { name: 'Leave requests', rows: [['Reference', 'Days', 'Note'], ['AB12', 2, 'a & b <c>'], ['CD34', 1.5, '01234']] },
  ]);
  assert.equal(book.subarray(0, 2).toString('latin1'), 'PK');
  const parts = entries(book);
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(parts.has(p), p);
  }
  const sheet = parts.get('xl/worksheets/sheet1.xml')!.toString('utf8');
  assert.match(sheet, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Reference<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="B2"><v>2<\/v><\/c>/, 'a number is a number');
  assert.match(sheet, /<c r="B3"><v>1.5<\/v><\/c>/);
  assert.match(sheet, /a &amp; b &lt;c&gt;/, 'text is escaped');
  assert.match(sheet, /<t xml:space="preserve">01234<\/t>/, 'a leading zero survives as text');
  assert.match(parts.get('xl/workbook.xml')!.toString('utf8'), /<sheet name="Leave requests" sheetId="1"/);
});

test('sheet names are made legal and unique', () => {
  const book = xlsx([
    { name: 'A very long process name that goes past thirty-one characters', rows: [['x']] },
    { name: 'A very long process name that goes past thirty-one characters', rows: [['y']] },
    { name: 'What: [this]/that?', rows: [['z']] },
  ]);
  const wb = entries(book).get('xl/workbook.xml')!.toString('utf8');
  const names = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(names.length, 3);
  assert.ok(names.every((n) => n.length <= 31), names.join('|'));
  assert.equal(new Set(names).size, 3, 'unique');
  assert.ok(!/[[\]:*?/\\]/.test(names[2]!), names[2]);
});

test('two exports of the same rows are byte-identical', () => {
  const rows = [['A', 'B'], ['1', 2]];
  assert.ok(xlsx([{ name: 'S', rows }]).equals(xlsx([{ name: 'S', rows }])));
});
