import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No browser pop-ups in the product.
 *
 * `confirm()` rendered "localhost:3210 says" over the builder with OK and
 * Cancel — the browser's words and styling, a button labelled "OK" for
 * throwing a draft away, and no way to say what would be lost. Questions are
 * asked with `useConfirm` from web/components/confirm-dialog.tsx.
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.next')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

test('the web app never uses the browser’s confirm, alert or prompt', () => {
  const offenders: string[] = [];
  for (const file of [...walk('web/app'), ...walk('web/components')]) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/(^|[^.\w])(window\.)?(confirm|alert|prompt)\(/.test(code) && !/^\s*\*/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(offenders, [], 'use useConfirm from web/components/confirm-dialog.tsx');
});
