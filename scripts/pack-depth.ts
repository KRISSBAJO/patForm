/**
 * How deep each template goes, measured rather than felt.
 *
 * A template with six required questions, no help text, no validation and
 * no sections compiles and passes its category audit, and is still the
 * generic shape somebody will delete and start again. This counts what the
 * audit does not: help on the questions, constraints that catch a wrong
 * answer, sections of the form's own, questions and sections that appear
 * only when relevant, and the richer question types (a signed agreement, an
 * itemised list, a worked-out total).
 *
 *   npm run packs:depth            the catalogue, thinnest first
 *   npm run packs:depth -- leave   only keys containing "leave"
 */
import { CATALOGUE } from '../src/packs/catalogue.js';
import { buildBlueprint, type PackSpec } from '../src/packs/generate.js';

interface Shape {
  data: { fields: { key: string; type: string; requiredWhen?: unknown; constraints?: unknown; setBy?: string }[] };
  experience: { pages: { sections: { visibleWhen?: unknown }[] }[] };
  tests: unknown[];
}

const RICH = new Set(['signature', 'repeating_group', 'calculated', 'file', 'rating', 'matrix', 'address']);

function measure(spec: PackSpec) {
  const bp = buildBlueprint(spec) as Shape;
  const asked = spec.fields.filter((f) => f.setBy !== 'operator' && f.type !== 'calculated');
  const help = asked.filter((f) => f.help).length;
  // From the built blueprint, not the spec: the generator adds shape checks
  // to reference fields, and what the form enforces is what counts.
  const constrained = bp.data.fields.filter((f) => f.setBy !== 'operator' && f.type !== 'calculated' && f.constraints).length;
  const groups = new Set(asked.map((f) => f.group).filter(Boolean)).size;
  const rich = spec.fields.filter((f) => RICH.has(f.type)).length;
  const conditional =
    bp.data.fields.filter((f) => f.requiredWhen).length +
    bp.experience.pages.flatMap((p) => p.sections).filter((s) => s.visibleWhen).length;
  const depth = asked.length + help * 1.5 + constrained * 2 + groups * 2 + rich * 4 + conditional * 3;
  return { key: spec.key, category: spec.category, asked: asked.length, help, constrained, groups, conditional, rich, tests: bp.tests.length, depth: Math.round(depth) };
}

const filter = process.argv[2]?.toLowerCase();
const rows = CATALOGUE.filter((s) => !filter || s.key.includes(filter)).map(measure).sort((a, b) => a.depth - b.depth);
const pct = (n: number) => `${Math.round((n / rows.length) * 100)}%`;

console.log(`${rows.length} template(s)`);
console.log(`  no help text on any question:        ${pct(rows.filter((r) => r.help === 0).length)}`);
console.log(`  no validation on any question:       ${pct(rows.filter((r) => r.constrained === 0).length)}`);
console.log(`  no sections of their own:            ${pct(rows.filter((r) => r.groups === 0).length)}`);
console.log(`  nothing conditional:                 ${pct(rows.filter((r) => r.conditional === 0).length)}`);
console.log(`  no list, total, signature or rating: ${pct(rows.filter((r) => r.rich === 0).length)}`);
console.log('');
console.log('  depth  key                              category         asked help constr groups cond rich');
for (const r of rows) {
  console.log(`  ${String(r.depth).padStart(5)}  ${r.key.padEnd(32)} ${r.category.padEnd(16)} ${String(r.asked).padStart(5)} ${String(r.help).padStart(4)} ${String(r.constrained).padStart(6)} ${String(r.groups).padStart(6)} ${String(r.conditional).padStart(4)} ${String(r.rich).padStart(4)}`);
}
