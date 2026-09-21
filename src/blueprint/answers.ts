import type { Blueprint, Field } from './index.js';
import { evaluate, type Expr } from './common.js';


/**
 * Validating what a respondent typed.
 *
 * This is the only implementation of these rules. The browser does not get a
 * copy of them: the form API serves each field's *constraint values*, the
 * renderer turns those into native HTML attributes (`required`, `minlength`,
 * `pattern`, `min`, `accept`), and this function is what actually decides.
 * One source of truth in the blueprint, two enforcers, no duplicated logic to
 * drift apart — which is the failure mode when a client "also" validates.
 */

export type Answers = Record<string, unknown>;

export interface FieldError {
  field: string;
  message: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/;

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Which fields the respondent can actually see, given what they have answered
 * so far. A required field inside a hidden section is not missing — it is not
 * being asked.
 */
export function visibleFields(bp: Blueprint, answers: Answers, now = new Date()): Set<string> {
  const visible = new Set<string>();
  const shown = (when?: Expr) => !when || evaluate(when, { answers, now });

  for (const page of bp.experience.pages) {
    if (!shown(page.visibleWhen)) continue;
    for (const section of page.sections) {
      if (!shown(section.visibleWhen)) continue;
      for (const key of section.fields) visible.add(key);
    }
  }
  return visible;
}

/** Validates one field's value. Returns null when it is acceptable. */
export function checkField(field: Field, value: unknown): string | null {
  if (isBlank(value)) {
    return field.required ? `${field.label} is required.` : null;
  }

  const c = field.constraints;
  const custom = c?.message;

  switch (field.type) {
    case 'email':
      if (typeof value !== 'string' || !EMAIL.test(value)) return custom ?? 'Enter a valid email address.';
      break;

    case 'url':
      if (typeof value !== 'string' || !URL_RE.test(value)) return custom ?? 'Enter a full web address, starting http.';
      break;

    case 'number':
    case 'currency':
    case 'rating': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return custom ?? `${field.label} must be a number.`;
      if (c?.min !== undefined && n < c.min) return custom ?? `${field.label} must be at least ${c.min}.`;
      if (c?.max !== undefined && n > c.max) return custom ?? `${field.label} must be at most ${c.max}.`;
      if (field.type === 'rating' && c?.scale && (n < 1 || n > c.scale)) {
        return custom ?? `Choose between 1 and ${c.scale}.`;
      }
      break;
    }

    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return custom ?? 'Enter a date.';
      }
      const days = Math.round((Date.parse(`${value}T00:00:00Z`) - startOfToday()) / 86_400_000);
      if (c?.minDaysFromToday !== undefined && days < c.minDaysFromToday) {
        return custom ?? `${field.label} is too far in the past.`;
      }
      if (c?.maxDaysFromToday !== undefined && days > c.maxDaysFromToday) {
        return custom ?? `${field.label} is too far in the future.`;
      }
      break;
    }

    case 'single_choice':
    case 'dropdown': {
      const allowed = (field.choices ?? []).map((choice) => choice.value);
      if (typeof value !== 'string' || !allowed.includes(value)) return custom ?? 'Choose one of the options.';
      break;
    }

    case 'multi_choice':
    case 'matrix': {
      if (!Array.isArray(value)) return custom ?? 'Choose from the options.';
      const allowed = new Set((field.choices ?? []).map((choice) => choice.value));
      if (value.some((v) => typeof v !== 'string' || !allowed.has(v))) {
        return custom ?? 'One of those is not an option.';
      }
      break;
    }

    case 'yes_no':
    case 'signature_ack':
      if (typeof value !== 'boolean') return custom ?? 'Answer yes or no.';
      if (field.type === 'signature_ack' && field.required && value !== true) {
        return custom ?? `${field.label} must be accepted.`;
      }
      break;

    case 'file': {
      const files = Array.isArray(value) ? value : [value];
      if (c?.maxFiles && files.length > c.maxFiles) {
        return custom ?? `Attach at most ${c.maxFiles} file${c.maxFiles === 1 ? '' : 's'}.`;
      }
      break;
    }

    case 'repeating_group': {
      if (!Array.isArray(value) || !value.length) return custom ?? `Add at least one ${field.label.toLowerCase()}.`;
      break;
    }

    default: {
      if (typeof value !== 'string') return custom ?? `${field.label} must be text.`;
      if (c?.minLength !== undefined && value.length < c.minLength) {
        return custom ?? `${field.label} must be at least ${c.minLength} characters.`;
      }
      if (c?.maxLength !== undefined && value.length > c.maxLength) {
        return custom ?? `${field.label} must be at most ${c.maxLength} characters.`;
      }
      if (c?.pattern && !new RegExp(c.pattern).test(value)) {
        return custom ?? `${field.label} is not in the expected format.`;
      }
    }
  }

  return null;
}

/**
 * Validates a whole submission. `scope` limits it to one page, so advancing
 * through a form checks what has been answered rather than what has not.
 */
export function validateAnswers(
  bp: Blueprint,
  answers: Answers,
  opts: { scope?: string[]; now?: Date } = {},
): FieldError[] {
  const now = opts.now ?? new Date();
  const visible = visibleFields(bp, answers, now);
  const errors: FieldError[] = [];

  for (const field of bp.data.fields) {
    // Never asked, never entered, or worked out by the runtime.
    if (field.type === 'content' || field.type === 'calculated' || field.type === 'hidden') continue;
    if (field.setBy === 'operator' || field.setBy === 'system') continue;
    if (!visible.has(field.key)) continue;
    if (opts.scope && !opts.scope.includes(field.key)) continue;

    const message = checkField(field, answers[field.key]);
    if (message) errors.push({ field: field.key, message });

    // Rows inside a repeating group are checked against the group's own fields.
    if (field.type === 'repeating_group' && Array.isArray(answers[field.key])) {
      const rows = answers[field.key] as Record<string, unknown>[];
      for (const [index, row] of rows.entries()) {
        for (const child of field.fields ?? []) {
          const childMessage = checkField(child, row?.[child.key]);
          if (childMessage) {
            errors.push({ field: `${field.key}[${index}].${child.key}`, message: childMessage });
          }
        }
      }
    }
  }

  return errors;
}

function startOfToday(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
