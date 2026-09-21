import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { Blueprint } from './blueprint/index.js';
import { validate } from './compiler/validate.js';
import type { Diagnostic } from './compiler/diagnostics.js';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

function print(diag: Diagnostic): void {
  const colour = diag.severity === 'error' ? RED : YELLOW;
  console.log(`  ${colour}${diag.severity.padEnd(7)}${OFF} ${BOLD}${diag.code}${OFF}  ${diag.message}`);
  console.log(`          ${DIM}at ${diag.at}${OFF}`);
  if (diag.fix) console.log(`          ${DIM}${diag.fix}${OFF}`);
}

const patterns = process.argv.slice(2);
if (!patterns.length) {
  console.error('usage: compile <blueprint.json ...>');
  process.exit(2);
}

const files = patterns.flatMap((p) => (p.includes('*') ? globSync(p) : [p])).sort();
if (!files.length) {
  console.error('no blueprint files matched');
  process.exit(2);
}

let failed = 0;

for (const file of files) {
  console.log(`\n${BOLD}${file}${OFF}`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.log(`  ${RED}error  ${OFF} JSON001  ${(err as Error).message}`);
    failed++;
    continue;
  }

  // Step one: does it even have the shape of a blueprint? This is the same
  // gate an AI-proposed blueprint passes through (section 7.3: model output is
  // treated as untrusted input and validated against strict schemas).
  const parsed = Blueprint.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      print({
        code: 'SHAPE',
        severity: 'error',
        message: issue.message,
        at: issue.path.join('.') || '(root)',
      });
    }
    console.log(`  ${RED}not compilable${OFF}`);
    failed++;
    continue;
  }

  // Step two: is it a process the runtime can execute safely?
  const diagnostics = validate(parsed.data);
  diagnostics.items
    .slice()
    .sort((a, b) => (a.severity === b.severity ? a.code.localeCompare(b.code) : a.severity === 'error' ? -1 : 1))
    .forEach(print);

  const { errors, warnings, publishable } = diagnostics;
  const summary = `${errors.length} error(s), ${warnings.length} warning(s)`;
  if (publishable) {
    console.log(`  ${GREEN}publishable${OFF} ${DIM}- ${summary}${OFF}`);
  } else {
    console.log(`  ${RED}blocked${OFF} ${DIM}- ${summary}${OFF}`);
    failed++;
  }
}

console.log('');
process.exit(failed ? 1 : 0);
