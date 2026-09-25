import { evaluate, type Answers, type Calc, type Field } from '../blueprint/index.js';

// Re-exported so the engine keeps importing evaluation from one place.
export { evaluate, type Answers, type EvalContext } from '../blueprint/index.js';

/**
 * Computes a calculated field. Kept separate from `evaluate` so a boolean can
 * never appear where a number is expected.
 */
export function calculate(calc: Calc, answers: Answers): number {
  if ('literal' in calc) return calc.literal;
  if ('field' in calc) return toNumber(answers[calc.field]);

  switch (calc.op) {
    case 'duration':
      return duration(answers[calc.from], answers[calc.to], calc.unit);
    case 'sum':
    case 'count': {
      const rows = answers[calc.over];
      if (!Array.isArray(rows)) return 0;
      const included = calc.where ? rows.filter((row) => row && typeof row === 'object' &&
        evaluate(calc.where!, { answers: { ...answers, ...(row as Answers) }, now: new Date() })) : rows;
      if (calc.op === 'count') return included.length;
      const of = calc.of;
      if (!of) return 0;
      return included.reduce<number>((total, row) => {
        const cell = row && typeof row === 'object' ? (row as Record<string, unknown>)[of] : undefined;
        return total + toNumber(cell);
      }, 0);
    }
    default: {
      const values: number[] = calc.operands.map((o) => calculate(o, answers));
      switch (calc.op) {
        case 'add':
          return values.reduce((a, b) => a + b, 0);
        case 'subtract':
          return values.slice(1).reduce((a, b) => a - b, values[0] ?? 0);
        case 'multiply':
          return values.reduce((a, b) => a * b, 1);
        case 'divide':
          return values.slice(1).reduce((a, b) => (b === 0 ? a : a / b), values[0] ?? 0);
      }
    }
  }
}

/**
 * Minutes, hours or days between two answers. Two times ("HH:MM") are a span
 * within a day, crossing midnight when the end is earlier; two dates
 * ("YYYY-MM-DD") are whole days apart. Anything unreadable is 0, the same
 * answer arithmetic gives a blank.
 */
function duration(from: unknown, to: unknown, unit: 'minutes' | 'hours' | 'days'): number {
  const minutesOf = (v: unknown): number | null => {
    if (typeof v !== 'string') return null;
    const time = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
    if (time) return Number(time[1]) * 60 + Number(time[2]);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? Date.parse(`${v.trim()}T00:00:00Z`) : NaN;
    return Number.isNaN(date) ? null : date / 60_000;
  };
  const a = minutesOf(from);
  const b = minutesOf(to);
  if (a === null || b === null) return 0;
  const bothTimes = typeof from === 'string' && from.includes(':');
  let minutes = b - a;
  if (bothTimes && minutes < 0) minutes += 24 * 60;
  const scale = unit === 'minutes' ? 1 : unit === 'hours' ? 60 : 24 * 60;
  return Math.round((minutes / scale) * 100) / 100;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/** Fills in every calculated field so conditions can read them like any other. */
export function withCalculatedFields(fields: Field[], answers: Answers): Answers {
  const out: Answers = { ...answers };
  for (const field of fields) {
    if (field.type === 'repeating_group' && Array.isArray(out[field.key])) {
      out[field.key] = (out[field.key] as Answers[]).map((row) => withCalculatedFields(field.fields ?? [], row));
    }
  }
  // Two passes so a calculated field may depend on another one. The compiler
  // has already rejected cycles, so this terminates with the right answer.
  for (let pass = 0; pass < 2; pass++) {
    for (const field of fields) {
      if (field.type === 'calculated' && field.compute) {
        out[field.key] = calculate(field.compute, out);
      }
    }
  }
  return out;
}

/** Substitutes {{field_key}} placeholders. Nothing else is interpreted. */
export function render(template: string, answers: Answers): string {
  return template.replace(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g, (_match, key: string) => {
    const value = answers[key];
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
    return String(value);
  });
}
