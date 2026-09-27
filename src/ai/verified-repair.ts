import type { Blueprint } from '../blueprint/index.js';
import { validate } from '../compiler/validate.js';
import type { ScenarioResult } from '../runtime/scenarios.js';
import { repairBlueprint, type RepairOptions } from './repair.js';
import { reviewWarnings } from './warning-review.js';

/** Bounded, verified repair. The caller may save only a result marked ready. */
export async function verifiedRepair(input: Blueprint, run: (bp: Blueprint) => Promise<ScenarioResult[]>, options:RepairOptions = {}) {
  let repair = repairBlueprint(input,[],options);
  const changes = [...repair.changes];
  const review = options.reviewWarnings ? reviewWarnings(repair.blueprint,options.staff) : {decisions:[],changes:[],accepted:[]};
  changes.push(...review.changes);
  let scenarios: ScenarioResult[] = [];
  let diagnostics = validate(repair.blueprint);
  for (let round = 0; round < 3 && diagnostics.publishable; round++) {
    scenarios = await run(repair.blueprint);
    if (scenarios.every(s => s.passed)) break;
    const next = repairBlueprint(repair.blueprint,scenarios.filter(s => !s.passed),options);
    if (!next.changes.length || round === 2) break;
    repair = next;
    changes.push(...next.changes);
    diagnostics = validate(repair.blueprint);
  }
  const questions = diagnostics.errors.map(d => d.code === 'FLOW003'
    ? 'How should a record enter the status that has no entry path?'
    : d.code === 'FLOW004' ? 'Should this return happen before final closure? Finished records cannot reopen.'
    : d.code === 'FLOW011' ? 'Which submission route should be used? The routes differ, so Repair cannot choose for you.'
    : d.message);
  return {blueprint:repair.blueprint,changes,diagnostics:diagnostics.items,scenarios,
    ready:!repair.decisions.length && !review.decisions.length && diagnostics.publishable && repair.blueprint.tests.length > 0 && scenarios.length === repair.blueprint.tests.length && scenarios.every(s=>s.passed),
    acceptedWarnings:review.accepted, decisions:[...repair.decisions,...review.decisions], questions:[...new Set(questions)]};
}
