/**
 * Compiles every pack in the catalogue.
 *
 * A template that does not compile is worse than no template: it teaches
 * somebody that the compiler is an obstacle to work around rather than a
 * check that is on their side. So this runs the real compiler over the real
 * generated blueprint, and the build fails if one stops passing.
 *
 *   npm run packs:check
 */

import { Blueprint } from '../blueprint/index.js';
import { validate } from '../compiler/validate.js';
import { CATALOGUE } from './catalogue.js';
import { buildBlueprint } from './generate.js';
import { auditPack, describeControl } from './audit.js';
import { rulesFor } from './rules.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

let failed = 0;
let warned = 0;

console.log(`\n  Compiling ${CATALOGUE.length} packs\n`);

for (const spec of CATALOGUE) {
  // A pack may compile with only an approval, yet still promise work that
  // never happens. Keep the catalogue's process-specific finish visible and
  // testable as new packs are added.
  if (!spec.task?.description || !spec.task.requiredFields?.length || !spec.completionMessage) {
    failed++;
    console.log(`  ${RED}INCOMPLETE${OFF}  ${spec.key}: follow-up task, evidence field and completion message are required`);
    continue;
  }
  const raw = buildBlueprint(spec);

  const parsed = Blueprint.safeParse(raw);
  if (!parsed.success) {
    failed++;
    console.log(`  ${RED}schema${OFF}  ${spec.key}`);
    for (const issue of parsed.error.issues.slice(0, 4)) {
      console.log(`          ${DIM}${issue.path.join('.')}: ${issue.message}${OFF}`);
    }
    continue;
  }

  const diagnostics = validate(parsed.data).items;
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');

  if (errors.length) {
    failed++;
    console.log(`  ${RED}FAIL${OFF}    ${spec.key} ${DIM}(${errors.length} error(s))${OFF}`);
    for (const d of errors.slice(0, 5)) {
      console.log(`          ${DIM}[${d.code}] ${d.at}: ${d.message}${OFF}`);
    }
  } else {
    /*
     * The compiler says the blueprint is coherent. The audit says it does
     * what its category promises — which the compiler has no opinion about,
     * because "a Health & safety process records when it happened" is a
     * property of a kind of work rather than of a blueprint.
     */
    const { findings, conflicts } = auditPack(parsed.data, spec.category);
    const missed = findings.filter((f) => !f.ok);

    if (missed.length || conflicts.length) {
      failed++;
      console.log(`  ${RED}MISSES${OFF}  ${spec.key} ${DIM}(${spec.category})${OFF}`);
      for (const m of missed) {
        console.log(`          ${DIM}does not ${describeControl(m.control)} — ${m.detail}${OFF}`);
      }
      for (const c of conflicts) console.log(`          ${DIM}${c}${OFF}`);
    } else {
      warned += warnings.length;
      console.log(
        `  ${GREEN}ok${OFF}      ${spec.key.padEnd(26)} ${DIM}${spec.category.padEnd(15)} ` +
          `${findings.length} control(s) · ${warnings.length} warning(s)${OFF}`,
      );
    }
  }
}

console.log(
  failed
    ? `\n  ${RED}${failed} of ${CATALOGUE.length} packs do not compile.${OFF}\n`
    : `\n  ${GREEN}All ${CATALOGUE.length} packs compile${OFF} ${DIM}(${warned} warning(s) across the catalogue)${OFF}\n`,
);

process.exit(failed ? 1 : 0);
