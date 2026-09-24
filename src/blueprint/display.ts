import type { Field } from './data.js';
import { isSignature, signatureWords } from './signature.js';

/**
 * One answer as a person reads it, from the field that asked for it.
 *
 * Stored values are what they are — a choice's key, an ISO date, a number, a
 * signature object — and that is right for the record. Shown raw they read as
 * `receiving_the_money`, `2026-10-07`, `3000`, and a screen of base64. This is
 * the one place that turns them into words, so every screen that lists
 * answers says the same thing.
 */
export function answerText(field: Pick<Field, 'type' | 'choices' | 'constraints'>, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (isSignature(value)) return signatureWords(value);

  const choice = (v: unknown) => field.choices?.find((c) => c.value === v)?.label ?? String(v);

  switch (field.type) {
    case 'single_choice':
    case 'dropdown':
      return choice(value);
    case 'multi_choice':
    case 'matrix':
      return Array.isArray(value) ? value.map(choice).join(', ') || '—' : choice(value);
    case 'yes_no':
    case 'signature_ack':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    case 'currency': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return String(value);
      const code = typeof field.constraints?.currencyCode === 'string' ? field.constraints.currencyCode : undefined;
      try {
        return code
          ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(n)
          : new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
      } catch {
        return String(n);
      }
    }
    case 'number':
      return typeof value === 'number' ? new Intl.NumberFormat('en-GB').format(value) : String(value);
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return String(value);
      const d = new Date(`${value}T00:00:00Z`);
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    }
    case 'repeating_group': {
      const n = Array.isArray(value) ? value.length : 0;
      return n === 1 ? '1 row' : `${n} rows`;
    }
    case 'file':
      return Array.isArray(value) ? `${value.length} documents uploaded` : 'Document uploaded';
    default:
      if (Array.isArray(value)) return value.map(String).join(', ');
      if (typeof value === 'object') return '(not shown)';
      return String(value);
  }
}
