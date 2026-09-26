import { deflateRawSync } from 'node:zlib';

/**
 * A spreadsheet file, written by hand.
 *
 * An .xlsx is a zip of a dozen small XML files. The libraries that write one
 * pull in a great deal to cover charts, styles and formulas that an export of
 * answers never uses. This writes exactly what a workbook of plain sheets
 * needs and nothing else: text cells inline (no shared-strings table),
 * numbers as numbers, one sheet per table, sheet names made legal. Excel,
 * Numbers, LibreOffice and Google Sheets all open it.
 *
 * Why bother when a CSV opens in Excel too: a CSV has one sheet, guesses at
 * encodings and types, and turns "01234" into 1234 and a reference that
 * looks like a date into a date. A workbook keeps text as text, holds every
 * process of a workspace in one file, and is what people mean by "in Excel".
 */
export type Cell = string | number | null | undefined;

export interface Sheet {
  name: string;
  rows: Cell[][];
}

export function xlsx(sheets: Sheet[]): Buffer {
  const named = uniqueNames(sheets.map((s) => s.name));
  const files: { path: string; data: Buffer }[] = [];
  const put = (path: string, text: string) => files.push({ path, data: Buffer.from(text, 'utf8') });

  put(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
  );
  put(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  );
  put(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${named.map((name, i) => `<sheet name="${esc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n')}
</sheets>
</workbook>`,
  );
  put(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  // One bold font for the header row; everything else default.
  put(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`,
  );
  sheets.forEach((sheet, i) => put(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet.rows)));

  return zip(files);
}

function sheetXml(rows: Cell[][]): string {
  const widths = columnWidths(rows);
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  if (rows.length) out.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
  if (widths.length) {
    out.push('<cols>');
    widths.forEach((w, i) => out.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`));
    out.push('</cols>');
  }
  out.push('<sheetData>');
  rows.forEach((row, r) => {
    out.push(`<row r="${r + 1}">`);
    row.forEach((cell, c) => {
      if (cell === null || cell === undefined || cell === '') return;
      const ref = `${col(c)}${r + 1}`;
      const style = r === 0 ? ' s="1"' : '';
      if (typeof cell === 'number' && Number.isFinite(cell)) {
        out.push(`<c r="${ref}"${style}><v>${cell}</v></c>`);
      } else {
        out.push(`<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(String(cell))}</t></is></c>`);
      }
    });
    out.push('</row>');
  });
  out.push('</sheetData>');
  out.push('</worksheet>');
  return out.join('');
}

/** A1, B1 … Z1, AA1. */
function col(index: number): string {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function columnWidths(rows: Cell[][]): number[] {
  const widths: number[] = [];
  for (const row of rows.slice(0, 200)) {
    row.forEach((cell, i) => {
      const len = cell === null || cell === undefined ? 0 : String(cell).length;
      widths[i] = Math.max(widths[i] ?? 0, Math.min(60, len + 2));
    });
  }
  return widths.map((w) => Math.max(8, w));
}

/** Sheet names: at most 31 characters, none of []:*?/\ and unique. */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    let base = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
    const key = base.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n > 0) base = `${base.slice(0, 31 - String(n + 1).length - 1)} ${n + 1}`;
    return base;
  });
}

function esc(s: string): string {
  // Control characters other than tab, newline and return are not legal in
  // XML 1.0 at all, escaped or not; they are dropped.
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A plain zip: deflated entries, a central directory, no extras. */
export function zip(files: { path: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // A fixed timestamp, so two exports of the same data are byte-identical.
  const dosTime = 0;
  const dosDate = (1 << 5) | 1; // 1980-01-01

  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8');
    const deflated = deflateRawSync(f.data, { level: 6 });
    const crc = crc32(f.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by
    dir.writeUInt16LE(20, 6); // needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(dosTime, 12);
    dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(f.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuf, end]);
}
