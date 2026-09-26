/**
 * The app icons, from the brand mark: a rounded green square with a white
 * tick, the same shape the console's top bar draws. Rasterised here with a
 * few signed-distance functions and written as PNG by hand, so there is no
 * image library to install; run once and commit the files.
 *
 *   npm run icons
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/** A PNG writer for RGBA pixels: signature, IHDR, one IDAT, IEND. */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA, no interlace
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const GREEN = [0x1f, 0x5c, 0x3a];
const MINT = [0xcf, 0xe8, 0xd7];
const WHITE = [0xff, 0xff, 0xff];
const SS = 4; // supersampling per axis

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function roundedRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - hw + r;
  const dy = Math.abs(y - cy) - hh + r;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - r;
}

/** Distance to a line segment. */
function segment(x, y, ax, ay, bx, by) {
  const px = x - ax, py = y - ay, vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, (px * vx + py * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - vx * t, py - vy * t);
}

/**
 * Paints one pixel by sampling SS×SS points; each layer is a coverage
 * function returning 0..1 and a colour, painted in order.
 */
function render(size, layers, background = null) {
  const data = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          let cr = 0, cg = 0, cb = 0, ca = 0;
          if (background) { [cr, cg, cb] = background; ca = 1; }
          for (const { cover, colour } of layers) {
            const c = Math.max(0, Math.min(1, cover(x, y)));
            if (!c) continue;
            cr = colour[0] * c + cr * (1 - c);
            cg = colour[1] * c + cg * (1 - c);
            cb = colour[2] * c + cb * (1 - c);
            ca = c + ca * (1 - c);
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      data[i] = Math.round(r / n);
      data[i + 1] = Math.round(g / n);
      data[i + 2] = Math.round(b / n);
      data[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, size, data);
}

const edge = (d) => 0.5 - d; // coverage from a signed distance, one pixel of anti-aliasing

function mark(size, { maskable = false, plain = false } = {}) {
  const pad = maskable ? size * 0.1 : 0;
  const inner = size - pad * 2;
  const c = size / 2;
  const radius = plain ? 0 : inner * 0.22;
  const ringHalf = inner * 0.34;
  const ringR = inner * 0.16;
  const ringW = inner * 0.055;
  const tickW = inner * 0.075;
  const p = (fx, fy) => [pad + inner * fx, pad + inner * fy];
  const [ax, ay] = p(0.33, 0.51), [bx, by] = p(0.45, 0.63), [cx2, cy2] = p(0.68, 0.37);
  return render(size, [
    { cover: (x, y) => edge(roundedRect(x, y, c, c, inner / 2, inner / 2, radius)), colour: GREEN },
    { cover: (x, y) => edge(Math.abs(roundedRect(x, y, c, c, ringHalf, ringHalf, ringR)) - ringW / 2), colour: MINT },
    { cover: (x, y) => edge(Math.min(segment(x, y, ax, ay, bx, by), segment(x, y, bx, by, cx2, cy2)) - tickW / 2), colour: WHITE },
  ], maskable ? GREEN : null);
}

function badge(size) {
  const w = size * 0.13;
  return render(size, [
    { cover: (x, y) => edge(Math.min(segment(x, y, size * 0.22, size * 0.52, size * 0.42, size * 0.72), segment(x, y, size * 0.42, size * 0.72, size * 0.8, size * 0.3)) - w / 2), colour: WHITE },
  ]);
}

mkdirSync('web/public/icons', { recursive: true });
const out = (name, png) => {
  writeFileSync(`web/public/icons/${name}`, png);
  console.log(`  wrote web/public/icons/${name} (${png.length} bytes)`);
};
out('icon-192.png', mark(192));
out('icon-512.png', mark(512));
out('maskable-512.png', mark(512, { maskable: true }));
out('apple-touch-icon.png', mark(180, { plain: true }));
out('badge-96.png', badge(96));
