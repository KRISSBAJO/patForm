import type { Blueprint } from '../blueprint/index.js';
import { flattenFields, type Field } from '../blueprint/data.js';
import type { Calc, Expr } from '../blueprint/common.js';

/**
 * Mechanical repairs to a generated blueprint, made before the compiler sees it.
 *
 * A model writes `{"literal": "yes"}` against a yes/no field, `"In Person"`
 * against a choice whose value is `in_person`, and `check_out - check_in`
 * over two times. Each is unambiguous about what was meant, each is a compile
 * error, and each used to cost a repair turn — a minute and a few thousand
 * tokens — that often came back with the same slip somewhere else. The repair
 * turn is for design mistakes. These are spelling.
 *
 * Every change is recorded, so the audit says what was corrected on the
 * model's behalf and a person reading the draft is not surprised by it.
 */

export interface Normalization {
  at: string;
  change: string;
}

const YES = new Set(['yes', 'y', 'true', '1', 'on']);
const NO = new Set(['no', 'n', 'false', '0', 'off']);

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function normalizeBlueprint(input: Blueprint): { blueprint: Blueprint; changes: Normalization[] } {
  const bp = structuredClone(input);
  const changes: Normalization[] = [];
  const fields = new Map<string, Field>();
  for (const { field } of flattenFields(bp.data.fields)) fields.set(field.key, field);

  const literalFor = (field: Field, raw: unknown, at: string): unknown => {
    if (typeof raw !== 'string') return raw;
    if (field.type === 'yes_no' || field.type === 'signature_ack') {
      const word = raw.trim().toLowerCase();
      if (YES.has(word)) return note(at, `"${raw}" read as true for the yes/no field ${field.key}`, true);
      if (NO.has(word)) return note(at, `"${raw}" read as false for the yes/no field ${field.key}`, false);
      return raw;
    }
    if (field.choices?.length && !field.choices.some((c) => c.value === raw)) {
      const wanted = slug(raw);
      const match = field.choices.find((c) => slug(c.value) === wanted || slug(c.label) === wanted);
      if (match) return note(at, `"${raw}" read as the choice ${match.value} of ${field.key}`, match.value);
    }
    return raw;
  };

  function note<T>(at: string, change: string, value: T): T {
    changes.push({ at, change });
    return value;
  }

  const fixExpr = (e: Expr | undefined, at: string): void => {
    if (!e) return;
    switch (e.op) {
      case 'and':
      case 'or':
        e.operands.forEach((x, i) => fixExpr(x, `${at}.operands[${i}]`));
        return;
      case 'not':
        fixExpr(e.operand, `${at}.operand`);
        return;
      case 'any':
      case 'all':
        fixExpr(e.where, `${at}.where`);
        return;
      case 'is_empty':
      case 'is_present':
        return;
      default: {
        const left = e.left;
        if (!('field' in left)) return;
        const field = fields.get(left.field);
        if (!field) return;
        if (e.op === 'in' || e.op === 'not_in') {
          e.right = e.right.map((r) => ('literal' in r ? { literal: literalFor(field, r.literal, at) as never } : r));
          return;
        }
        if ('literal' in e.right) e.right = { literal: literalFor(field, e.right.literal, at) as never };
      }
    }
  };

  // Everywhere a condition can live.
  bp.workflow.transitions.forEach((t, i) => fixExpr(t.when, `workflow.transitions[${i}].when`));
  bp.experience.pages.forEach((p, pi) => {
    fixExpr(p.visibleWhen, `experience.pages[${pi}].visibleWhen`);
    (p.sections ?? []).forEach((s, si) => fixExpr(s.visibleWhen, `experience.pages[${pi}].sections[${si}].visibleWhen`));
  });
  bp.communications.email.forEach((t, i) => fixExpr(t.skipWhen, `communications.email[${i}].skipWhen`));

  for (const { path, field } of flattenFields(bp.data.fields)) {
    const at = `data.fields.${path}`;
    fixExpr((field as { requiredWhen?: Expr }).requiredWhen, `${at}.requiredWhen`);
    if (field.type !== 'calculated' || !field.compute) continue;
    const calc = field.compute as Calc;
    if ('op' in calc && (calc.op === 'sum' || calc.op === 'count') && calc.where) fixExpr(calc.where, `${at}.compute.where`);
    /*
     * "check_out_time minus check_in_time" is a duration, and the only way a
     * model has to say so with arithmetic. Turned into the calculation that
     * exists for it: hours between two times, days between two dates.
     */
    field.compute = spansIn(calc, `${at}.compute`);
  }

  /** Rewrites every "time minus time" in a calculation as a duration, at any depth. */
  function spansIn(calc: Calc, at: string): Calc {
    if (!('op' in calc)) return calc;
    if (calc.op !== 'add' && calc.op !== 'subtract' && calc.op !== 'multiply' && calc.op !== 'divide') return calc;
    if (calc.op === 'subtract' && calc.operands.length === 2) {
      const [to, from] = calc.operands;
      if (to && from && 'field' in to && 'field' in from) {
        const a = fields.get(to.field)?.type;
        const b = fields.get(from.field)?.type;
        if (a && a === b && (a === 'time' || a === 'date')) {
          note(at, `${to.field} minus ${from.field} read as the ${a === 'time' ? 'hours' : 'days'} between them`, null);
          return { op: 'duration', from: from.field, to: to.field, unit: a === 'time' ? 'hours' : 'days' };
        }
      }
    }
    return { ...calc, operands: calc.operands.map((o, i) => spansIn(o, `${at}.operands[${i}]`)) };
  }

  /*
   * A reference the runtime generates cannot also be typed by the respondent.
   * Models ask for both — "training ID" is on the list of things to collect,
   * and a unique reference is the obvious thing to generate — and the compiler
   * refused it every time. The generated one wins: the field becomes
   * system-set and leaves the form, which is what the action meant.
   */
  const generated = new Set<string>();
  for (const t of bp.workflow.transitions) {
    for (const a of t.actions) if (a.do === 'set_reference') generated.add(a.field);
  }
  for (const key of generated) {
    const field = fields.get(key);
    if (!field || field.type !== 'short_text' || field.setBy === 'system') continue;
    field.setBy = 'system';
    field.required = false;
    for (const page of bp.experience.pages) {
      for (const section of page.sections ?? []) {
        if (section.fields.includes(key)) {
          section.fields = section.fields.filter((k) => k !== key);
          if (section.widths) delete section.widths[key];
        }
      }
    }
    note(`data.fields.${key}`, `${key} is generated by the runtime, so it is system-set and no longer asked on the form`, null);
  }

  return { blueprint: bp, changes };
}
