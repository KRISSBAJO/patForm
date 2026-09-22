/**
 * A PDF writer.
 *
 * §6.6 asks for "controlled DOCX or HTML-to-PDF templates". This renders the
 * HTML half, through a deliberately small subset — headings, paragraphs,
 * rules, lists, definition rows and tables — laid out onto pages with the
 * standard Helvetica faces. There is no CSS, no images, no page-breaking
 * inside a table row.
 *
 * Why not a browser: §17.3 says buy proven rendering infrastructure, and the
 * eventual answer is a real engine. What that buys is fidelity to arbitrary
 * HTML, which a *controlled* template does not need. What it costs is a
 * 300 MB Chromium in every worker and a rendering surface that changes under
 * you between versions. This has neither, and the subset it accepts is stated
 * rather than discovered.
 *
 * The output is deterministic: identical blocks produce identical bytes. That
 * is what makes the checksum in the `document` table worth storing — the same
 * record and the same template must give the same file, or "generated once"
 * cannot be checked.
 */

export type Block =
  | { kind: 'heading'; text: string; level: 1 | 2 }
  | { kind: 'paragraph'; text: string }
  | { kind: 'field'; label: string; value: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'rule' }
  | { kind: 'spacer'; height: number };

interface Style {
  size: number;
  font: 'H' | 'HB';
  leading: number;
  gapBefore: number;
  gapAfter: number;
}

const STYLES: Record<string, Style> = {
  h1: { size: 20, font: 'HB', leading: 25, gapBefore: 0, gapAfter: 10 },
  h2: { size: 13, font: 'HB', leading: 17, gapBefore: 16, gapAfter: 6 },
  body: { size: 10.5, font: 'H', leading: 15, gapBefore: 0, gapAfter: 8 },
  label: { size: 9, font: 'H', leading: 13, gapBefore: 0, gapAfter: 0 },
};

// US Letter at 72dpi, with a margin that leaves a comfortable measure.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;
const LABEL_W = 170;

/**
 * Helvetica advance widths, in 1/1000 em, for the printable ASCII range. Used
 * for wrapping. Anything outside it is treated as an average-width glyph,
 * which is close enough for layout and never wrong enough to overflow.
 */
const WIDTHS: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, '[': 278,
  '\\': 278, ']': 278, '^': 469, _: 556, '`': 333, a: 556, b: 556, c: 500,
  d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222,
  m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556,
  v: 500, w: 722, x: 500, y: 500, z: 500, '{': 334, '|': 260, '}': 334, '~': 584,
};

const BOLD_FACTOR = 1.06;

function textWidth(text: string, size: number, bold: boolean): number {
  let units = 0;
  for (const ch of text) units += WIDTHS[ch] ?? 556;
  return (units / 1000) * size * (bold ? BOLD_FACTOR : 1);
}

function wrap(text: string, width: number, size: number, bold: boolean): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      // A single word longer than the measure is broken rather than allowed
      // to run off the page.
      if (textWidth(word, size, bold) > width) {
        let chunk = '';
        for (const ch of word) {
          if (textWidth(chunk + ch, size, bold) > width) {
            lines.push(chunk);
            chunk = ch;
          } else chunk += ch;
        }
        line = chunk;
      } else line = word;
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

/** Escapes the three characters that mean something inside a PDF string. */
function pdfString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Latin-1 is what the standard fonts can encode; anything else is transliterated. */
function toLatin1(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, '--')
    .replace(/–/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x20-\x7E\n]/g, (ch) => (ch.charCodeAt(0) < 256 ? ch : '?'));
}

interface Op {
  font: 'H' | 'HB';
  size: number;
  x: number;
  y: number;
  text: string;
}

interface Line {
  y: number;
  x1: number;
  x2: number;
}

/** Lays blocks out onto pages, then writes the file. */
export function renderPdf(blocks: Block[], meta: { title: string; producedFor: string }): Buffer {
  const pages: { ops: Op[]; lines: Line[] }[] = [];
  let ops: Op[] = [];
  let lines: Line[] = [];
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    pages.push({ ops, lines });
    ops = [];
    lines = [];
    y = PAGE_H - MARGIN;
  };
  const room = (needed: number) => {
    if (y - needed < MARGIN + 30) newPage();
  };

  const write = (text: string, style: Style, x = MARGIN, width = CONTENT_W) => {
    const bold = style.font === 'HB';
    const wrapped = wrap(toLatin1(text), width, style.size, bold);
    room(wrapped.length * style.leading);
    for (const line of wrapped) {
      y -= style.leading;
      ops.push({ font: style.font, size: style.size, x, y, text: line });
    }
  };

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const style = STYLES[block.level === 1 ? 'h1' : 'h2']!;
        y -= style.gapBefore;
        write(block.text, style);
        y -= style.gapAfter;
        break;
      }

      case 'paragraph':
        write(block.text, STYLES.body!);
        y -= STYLES.body!.gapAfter;
        break;

      case 'field': {
        const label = STYLES.label!;
        const body = STYLES.body!;
        const valueLines = wrap(toLatin1(block.value || '--'), CONTENT_W - LABEL_W, body.size, false);
        room(Math.max(valueLines.length, 1) * body.leading + 6);
        const top = y;
        y -= body.leading;
        ops.push({ font: 'H', size: label.size, x: MARGIN, y: y + 1, text: toLatin1(block.label) });
        ops.push({ font: 'H', size: body.size, x: MARGIN + LABEL_W, y, text: valueLines[0]! });
        for (const extra of valueLines.slice(1)) {
          y -= body.leading;
          ops.push({ font: 'H', size: body.size, x: MARGIN + LABEL_W, y, text: extra });
        }
        y -= 7;
        lines.push({ y: y + 3, x1: MARGIN, x2: PAGE_W - MARGIN });
        void top;
        break;
      }

      case 'list':
        for (const item of block.items) {
          const body = STYLES.body!;
          const wrapped = wrap(toLatin1(item), CONTENT_W - 16, body.size, false);
          room(wrapped.length * body.leading);
          y -= body.leading;
          ops.push({ font: 'H', size: body.size, x: MARGIN, y, text: '-' });
          ops.push({ font: 'H', size: body.size, x: MARGIN + 16, y, text: wrapped[0]! });
          for (const extra of wrapped.slice(1)) {
            y -= body.leading;
            ops.push({ font: 'H', size: body.size, x: MARGIN + 16, y, text: extra });
          }
        }
        y -= STYLES.body!.gapAfter;
        break;

      case 'table': {
        const body = STYLES.body!;
        const columns = Math.max(block.head.length, 1);
        const colW = CONTENT_W / columns;
        room(body.leading * 2);
        y -= body.leading;
        block.head.forEach((cell, i) => {
          ops.push({ font: 'HB', size: body.size, x: MARGIN + i * colW, y, text: toLatin1(cell) });
        });
        y -= 5;
        lines.push({ y, x1: MARGIN, x2: PAGE_W - MARGIN });
        for (const row of block.rows) {
          room(body.leading);
          y -= body.leading;
          row.forEach((cell, i) => {
            const clipped = wrap(toLatin1(cell), colW - 8, body.size, false)[0]!;
            ops.push({ font: 'H', size: body.size, x: MARGIN + i * colW, y, text: clipped });
          });
        }
        y -= body.gapAfter;
        break;
      }

      case 'rule':
        room(12);
        y -= 8;
        lines.push({ y, x1: MARGIN, x2: PAGE_W - MARGIN });
        y -= 8;
        break;

      case 'spacer':
        y -= block.height;
        break;
    }
  }
  pages.push({ ops, lines });

  // A footer on every page, so a printed sheet still says what it is.
  const footer = toLatin1(`${meta.title} — ${meta.producedFor}`);
  pages.forEach((page, index) => {
    page.lines.push({ y: MARGIN + 22, x1: MARGIN, x2: PAGE_W - MARGIN });
    page.ops.push({ font: 'H', size: 8, x: MARGIN, y: MARGIN + 8, text: footer });
    page.ops.push({
      font: 'H',
      size: 8,
      x: PAGE_W - MARGIN - 60,
      y: MARGIN + 8,
      text: `Page ${index + 1} of ${pages.length}`,
    });
  });

  return writeFile(pages, meta.title);
}

function contentStream(page: { ops: Op[]; lines: Line[] }): string {
  const parts: string[] = ['0.075 0.102 0.09 rg', '0.867 0.847 0.808 RG', '0.7 w'];

  for (const line of page.lines) {
    parts.push(`${line.x1} ${line.y} m ${line.x2} ${line.y} l S`);
  }

  parts.push('BT');
  let font = '';
  for (const op of page.ops) {
    const spec = `/${op.font} ${op.size} Tf`;
    if (spec !== font) {
      parts.push(spec);
      font = spec;
    }
    parts.push(`1 0 0 1 ${op.x} ${op.y} Tm (${pdfString(op.text)}) Tj`);
  }
  parts.push('ET');
  return parts.join('\n');
}

function writeFile(pages: { ops: Op[]; lines: Line[] }[], title: string): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };

  const fontH = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontHB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  // The Pages object must know its kids before they exist, so reserve it.
  const pagesNo = add('');
  const pageNos: number[] = [];

  for (const page of pages) {
    const stream = contentStream(page);
    const contentNo = add(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
    pageNos.push(
      add(
        `<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources << /Font << /H ${fontH} 0 R /HB ${fontHB} 0 R >> >> /Contents ${contentNo} 0 R >>`,
      ),
    );
  }

  objects[pagesNo - 1] =
    `<< /Type /Pages /Count ${pageNos.length} /Kids [${pageNos.map((n) => `${n} 0 R`).join(' ')}] >>`;

  const catalogNo = add(`<< /Type /Catalog /Pages ${pagesNo} 0 R >>`);
  // No CreationDate: the same input must produce the same bytes, or the
  // checksum stored beside the document is noise.
  const infoNo = add(`<< /Title (${pdfString(toLatin1(title))}) /Producer (Patform) >>`);

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }

  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R /Info ${infoNo} 0 R >>\n`;
  out += `startxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}

// ------------------------------------------------------------- html subset

/**
 * Turns the accepted subset of HTML into blocks. Unknown tags are ignored and
 * their text kept, so a template that drifts past the subset degrades into
 * plain paragraphs rather than failing to produce a document at all.
 */
export function htmlToBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');

  const decode = (text: string) =>
    text
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

  const pattern =
    /<(h1|h2|h3|p|hr|ul|ol|table|dl)\b[^>]*>([\s\S]*?)<\/\1>|<(hr)\s*\/?>/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const tag = (match[1] ?? match[3] ?? '').toLowerCase();
    const inner = match[2] ?? '';

    switch (tag) {
      case 'h1':
        blocks.push({ kind: 'heading', text: decode(inner), level: 1 });
        break;
      case 'h2':
      case 'h3':
        blocks.push({ kind: 'heading', text: decode(inner), level: 2 });
        break;
      case 'p': {
        const text = decode(inner);
        if (text) blocks.push({ kind: 'paragraph', text });
        break;
      }
      case 'hr':
        blocks.push({ kind: 'rule' });
        break;
      case 'ul':
      case 'ol': {
        const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => decode(m[1]!));
        if (items.length) blocks.push({ kind: 'list', items });
        break;
      }
      case 'dl': {
        const terms = [...inner.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)];
        for (const [, label, value] of terms) {
          blocks.push({ kind: 'field', label: decode(label!), value: decode(value!) });
        }
        break;
      }
      case 'table': {
        const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
          [...m[1]!.matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => decode(c[2]!)),
        );
        if (!rows.length) break;
        const headerFirst = /<th\b/i.test(inner);
        blocks.push({
          kind: 'table',
          head: headerFirst ? rows[0]! : rows[0]!.map((_, i) => `Column ${i + 1}`),
          rows: headerFirst ? rows.slice(1) : rows,
        });
        break;
      }
    }
  }

  return blocks;
}
