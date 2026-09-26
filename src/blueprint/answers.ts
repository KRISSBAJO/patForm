import type { Blueprint, Field } from './index.js';
import { signatureProblem } from './signature.js';
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
/**
 * What a check may look at besides its own answer.
 *
 * `notBefore` and `atMost` compare with another field's answer, so the
 * validator that has the whole form passes it in. A caller with one value
 * and no form gets the single-field checks and nothing else.
 */
export interface Others {
  answers: Answers;
  labelOf: (key: string) => string;
}

export function checkField(field: Field, value: unknown, others?: Others): string | null {
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
      if (c?.atMost && others) {
        const other = Number(others.answers[c.atMost]);
        if (Number.isFinite(other) && n > other) {
          return `${field.label} cannot be more than ${others.labelOf(c.atMost).toLowerCase()}.`;
        }
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
      if (c?.notBefore && others) {
        const other = others.answers[c.notBefore];
        if (typeof other === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(other) && value < other) {
          return `${field.label} cannot be before ${others.labelOf(c.notBefore).toLowerCase()}.`;
        }
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

    case 'signature': {
      const problem = signatureProblem(value);
      if (problem) return custom ?? problem;
      break;
    }

    case 'file': {
      const files = Array.isArray(value) ? value : [value];
      if (c?.maxFiles && files.length > c.maxFiles) {
        return custom ?? `Attach at most ${c.maxFiles} file${c.maxFiles === 1 ? '' : 's'}.`;
      }
      if (files.some((file) => typeof file !== 'string' || !/^receipt-file:[0-9a-f-]{36}$/.test(file))) {
        return custom ?? 'Upload the actual file before submitting.';
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
/**
 * What a submission is missing: every required answer, and every answer
 * required by a condition that holds, among the fields the form is showing.
 *
 * The page-by-page check and the final submission used to disagree here:
 * the page check knew a hidden section's questions were not asked, the
 * engine's own check did not, so a required question inside a section that
 * never appeared blocked the whole form. One function now, used by both.
 */
export function missingRequiredFields(bp: Blueprint, answers: Answers, now = new Date()): string[] {
  const visible = visibleFields(bp, answers, now);
  const missing: string[] = [];
  const blank = (value: unknown) => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
  for (const field of bp.data.fields) {
    if (field.type === 'hidden' || field.type === 'calculated' || field.type === 'content') continue;
    if (!visible.has(field.key)) continue;
    const value = answers[field.key];
    if ((field.required || (field.requiredWhen && evaluate(field.requiredWhen, { answers, now }))) && blank(value)) {
      missing.push(field.key);
    }
    if (field.type === 'file' && !blank(value) && checkField(field, value)) missing.push(field.key);
    if (field.type === 'repeating_group' && Array.isArray(value)) {
      for (const [index, row] of value.entries()) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const item = row as Answers;
        for (const child of field.fields ?? []) {
          if ((child.required || (child.requiredWhen && evaluate(child.requiredWhen, { answers: { ...answers, ...item }, now }))) && blank(item[child.key])) {
            missing.push(`${field.key}[${index}].${child.key}`);
          }
          if (child.type === 'file' && !blank(item[child.key]) && checkField(child, item[child.key])) missing.push(`${field.key}[${index}].${child.key}`);
        }
      }
    }
  }
  return missing;
}

export function validateAnswers(
  bp: Blueprint,
  answers: Answers,
  opts: { scope?: string[]; now?: Date } = {},
): FieldError[] {
  const now = opts.now ?? new Date();
  const visible = visibleFields(bp, answers, now);
  const errors: FieldError[] = [];
  const labels = new Map<string, string>();
  for (const field of bp.data.fields) {
    labels.set(field.key, field.label);
    for (const child of field.fields ?? []) labels.set(child.key, child.label);
  }
  const labelOf = (key: string) => labels.get(key) ?? key;

  for (const field of bp.data.fields) {
    // Never asked, never entered, or worked out by the runtime.
    if (field.type === 'content' || field.type === 'calculated' || field.type === 'hidden') continue;
    if (field.setBy === 'operator' || field.setBy === 'system') continue;
    if (!visible.has(field.key)) continue;
    if (opts.scope && !opts.scope.includes(field.key)) continue;

    const required = Boolean(field.required || (field.requiredWhen && evaluate(field.requiredWhen, { answers, now })));
    const message = checkField({ ...field, required }, answers[field.key], { answers, labelOf });
    if (message) errors.push({ field: field.key, message });

    // Rows inside a repeating group are checked against the group's own fields.
    if (field.type === 'repeating_group' && Array.isArray(answers[field.key])) {
      const rows = answers[field.key] as Record<string, unknown>[];
      for (const [index, row] of rows.entries()) {
        for (const child of field.fields ?? []) {
          const rowAnswers = { ...answers, ...row };
          const required = Boolean(child.required || (child.requiredWhen && evaluate(child.requiredWhen, { answers: rowAnswers, now })));
          const childMessage = checkField({ ...child, required }, row?.[child.key], { answers: rowAnswers, labelOf });
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
