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
    case 'sum':
    case 'count': {
      const rows = answers[calc.over];
      if (!Array.isArray(rows)) return 0;
      if (calc.op === 'count') return rows.length;
      const of = calc.of;
      if (!of) return 0;
      return rows.reduce<number>((total, row) => {
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
