'use client';

/**
 * The respondent's form, as surfaces.
 *
 * The live form and the builder's preview render the same components from the
 * same stylesheet. That is the whole point of this file: a preview that is a
 * second implementation of the form is a preview that can be wrong, and it
 * would be wrong exactly where the two were hardest to compare — the branded
 * header, the field widths, the spacing between them.
 *
 * Nothing here decides whether an answer is acceptable. Constraint values
 * arrive already checked and become native HTML attributes; the server's
 * `validateAnswers` is what decides.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import './form-surface.css';
import { SignatureField } from './signature-field';

export interface PublicField {
  key: string;
  type: string;
  label: string;
  help?: string;
  required: boolean;
  requiredWhen?: unknown;
  choices?: { value: string; label: string }[];
  constraints?: Record<string, unknown>;
  fields?: PublicField[];
  default?: unknown;
}

export interface Section {
  key: string;
  title?: string;
  description?: string;
  visibleWhen?: unknown;
  /** Field key to width. Absent means full, which is what most answers want. */
  widths?: Record<string, string>;
  fields: PublicField[];
}

export interface Page {
  key: string;
  title: string;
  description?: string;
  sections: Section[];
}

export interface Branding {
  title?: string;
  tagline?: string;
  logoUrl?: string;
  bannerUrl?: string;
  accent?: string;
  footer?: string;
  style?: string;
  font?: string;
  size?: string;
}

export const FORM_STYLES = [
  { key: 'classic', name: 'Classic', says: 'Outlined fields, labels above. Clear and familiar.' },
  { key: 'soft', name: 'Soft', says: 'Filled fields on a tinted card, no hard lines.' },
  { key: 'minimal', name: 'Minimal', says: 'Underlines only, small labels, lots of air.' },
  { key: 'rounded', name: 'Rounded', says: 'Pill-shaped fields and buttons. Friendly.' },
  { key: 'bold', name: 'Bold', says: 'Thick borders and strong labels. Built for work.' },
] as const;

export type FormStyle = (typeof FORM_STYLES)[number]['key'];

/** Typefaces that need no download; see form-surface.css for the stacks. */
export const FORM_FONTS = [
  { key: 'default', name: 'Patform', says: 'The platform\'s own typeface.' },
  { key: 'system', name: 'System', says: 'Whatever the device uses for its own screens.' },
  { key: 'serif', name: 'Serif', says: 'Bookish. Suits formal and legal forms.' },
  { key: 'grotesque', name: 'Grotesque', says: 'Plain and neutral, Helvetica-like.' },
  { key: 'friendly', name: 'Friendly', says: 'Rounder letters, a lighter tone.' },
] as const;
export type FormFont = (typeof FORM_FONTS)[number]['key'];

/** Text size for the questions and answers; the header and page title keep theirs. */
export const FORM_SIZES = [
  { key: 'xsmall', short: 'XS', name: 'Extra small', says: 'Dense. Phones may zoom in on the fields.' },
  { key: 'small', short: 'S', name: 'Small', says: 'A little more on each screen.' },
  { key: 'regular', short: 'M', name: 'Regular', says: 'The usual size.' },
  { key: 'large', short: 'L', name: 'Large', says: 'Easier to read on a phone.' },
  { key: 'xlarge', short: 'XL', name: 'Extra large', says: 'For tired eyes and kiosks.' },
] as const;
export type FormSize = (typeof FORM_SIZES)[number]['key'];

export function formFont(branding?: Branding): FormFont {
  return (FORM_FONTS.find((f) => f.key === branding?.font)?.key ?? 'default') as FormFont;
}
export function formSize(branding?: Branding): FormSize {
  return (FORM_SIZES.find((s) => s.key === branding?.size)?.key ?? 'regular') as FormSize;
}

/** The three data attributes the stylesheet keys on, for the `.fm` root. */
export function surfaceAttributes(branding?: Branding): { 'data-style': FormStyle; 'data-font': FormFont; 'data-size': FormSize } {
  return { 'data-style': formStyle(branding), 'data-font': formFont(branding), 'data-size': formSize(branding) };
}

/** The style to render, with anything unknown falling back to the first. */
export function formStyle(branding?: Branding): FormStyle {
  return (FORM_STYLES.find((s) => s.key === branding?.style)?.key ?? 'classic') as FormStyle;
}

export interface PublicForm {
  processKey: string;
  /** The link this form is reached by, `/f/<publicId>`. */
  publicId?: string;
  processName: string;
  version: number;
  showProgress: boolean;
  saveAndResume: boolean;
  confirmation: { message: string; showStatusLink: boolean };
  branding?: Branding;
  pages: Page[];
  /** Signed when the form was served; sent back on submit. See runtime/screening.ts. */
  ticket?: string;
  /** The name of the input no person should ever fill in. */
  trap?: string;
}

const n = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/*
 * Two small helpers for the branded header and the grid. They are here rather
 * than inline because both have a default that matters: an absent accent must
 * leave the token alone, and an unknown width must mean full.
 */

/** Override the accent token for this form only. The schema has checked the hex. */
export function accentStyle(accent?: string): CSSProperties | undefined {
  if (!accent) return undefined;
  return { ['--green' as string]: accent, ['--green-deep' as string]: accent } as CSSProperties;
}

const WIDTHS = new Set(['full', 'half', 'third']);

export function widthOf(section: Section, key: string): string {
  const w = section.widths?.[key];
  return w && WIDTHS.has(w) ? w : 'full';
}


/**
 * The header a respondent sees first.
 *
 * A form arriving by link has no surrounding site to say who sent it, so this
 * is the entire answer to "is this really from my church". All of it is
 * optional: with no branding it is the process's name, which is what every
 * form looked like before.
 */
export function FormHeader({
  branding,
  fallbackName,
  note,
}: {
  branding?: Branding;
  fallbackName: string;
  note?: string;
}) {
  return (
    <header className="fm__head" data-banner={branding?.bannerUrl ? 'true' : undefined}>
      {branding?.bannerUrl && (
        <div className="fm__banner">
          {/* Decorative: the name beneath it says the same thing in text. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={branding.bannerUrl} alt="" />
        </div>
      )}
      <div className="fm__brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {branding?.logoUrl && <img className="fm__logo" src={branding.logoUrl} alt="" />}
        <div className="fm__brandText">
          <span className="fm__process">{branding?.title ?? fallbackName}</span>
          {branding?.tagline && <span className="fm__tagline">{branding.tagline}</span>}
        </div>
        {note !== undefined && (
          <span className="fm__save">
            {note}
          </span>
        )}
      </div>
    </header>
  );
}

/**
 * One cell of the six-column grid.
 *
 * Widths are a hint about a desktop, not a layout. The grid is the same six
 * columns whatever they say, and the stylesheet collapses every cell to the
 * full width below 560px — so a form designed on a large screen cannot
 * produce a two-inch postcode field on a phone.
 */
export function FieldCell({
  section,
  fieldKey,
  children,
}: {
  section: Section;
  fieldKey: string;
  children: ReactNode;
}) {
  return (
    <div className="fm__cell" data-width={widthOf(section, fieldKey)}>
      {children}
    </div>
  );
}

/** One field. Constraint values become native attributes; nothing is decided here. */
export function Field({
  field,
  value,
  computed,
  error,
  nestedErrors,
  onChange,
  onFileUpload,
}: {
  field: PublicField;
  value: unknown;
  computed?: unknown;
  error?: string;
  nestedErrors?: Record<string, string>;
  onChange: (value: unknown) => void;
  onFileUpload?: (fieldKey: string, file: File) => Promise<string>;
}) {
  const id = `f-${field.key}`;
  const describedBy = [field.help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  const c = field.constraints ?? {};

  // A control that is several inputs (a set of choices, a signature, a list of
  // rows) has no single element a label can point at. Its wrapper becomes a
  // named group instead, so a screen reader says the question before the
  // first of its parts, the way a fieldset and legend would.
  const wrap = (control: React.ReactNode, labelFor = true) => (
    <div
      className="fm__field"
      data-invalid={error ? 'true' : undefined}
      role={labelFor ? undefined : 'group'}
      aria-labelledby={labelFor ? undefined : `${id}-label`}
    >
      {labelFor ? (
        <label className="fm__label" htmlFor={id}>
          {field.label}
          {field.required && <span className="fm__req" aria-hidden="true"> *</span>}
        </label>
      ) : (
        <span className="fm__label" id={`${id}-label`}>
          {field.label}
          {field.required && <span className="fm__req" aria-hidden="true"> *</span>}
        </span>
      )}
      {control}
      {field.help && (
        <p className="fm__help fm__help--after" id={`${id}-help`}>
          {field.help}
        </p>
      )}
      {error && (
        <p className="fm__error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );

  const common = {
    id,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': error ? true : undefined,
    'aria-required': field.required || undefined,
    className: `fm__input ${error ? 'fm__input--bad' : ''}`,
  };

  switch (field.type) {
    case 'long_text':
      return wrap(
        <textarea
          {...common}
          rows={4}
          minLength={n(c.minLength)}
          maxLength={n(c.maxLength)}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />,
      );

    case 'number':
    case 'currency':
      return wrap(
        <input
          {...common}
          type="number"
          step="any"
          min={n(c.min)}
          max={n(c.max)}
          value={(value as number | string) ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />,
      );

    case 'date':
      return wrap(
        <input {...common} type="date" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />,
      );

    case 'time':
      return wrap(
        <input {...common} type="time" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />,
      );

    case 'email':
      return wrap(
        <input
          {...common}
          type="email"
          autoComplete="email"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />,
      );

    case 'phone':
      return wrap(
        <input
          {...common}
          type="tel"
          autoComplete="tel"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />,
      );

    case 'url':
      return wrap(
        <input {...common} type="url" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />,
      );

    case 'dropdown':
      return wrap(
        <select {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Choose…</option>
          {field.choices?.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>,
      );

    case 'single_choice':
      return wrap(
        <div className="fm__choices" role="radiogroup" aria-labelledby={`${id}-label`} aria-required={field.required || undefined}>
          {field.choices?.map((choice) => (
            <label className="fm__choice" key={choice.value}>
              <input
                type="radio"
                name={field.key}
                value={choice.value}
                checked={value === choice.value}
                onChange={() => onChange(choice.value)}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </div>,
        false,
      );

    case 'multi_choice': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return wrap(
        <div className="fm__choices">
          {field.choices?.map((choice) => (
            <label className="fm__choice" key={choice.value}>
              <input
                type="checkbox"
                checked={selected.includes(choice.value)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, choice.value]
                      : selected.filter((v) => v !== choice.value),
                  )
                }
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </div>,
        false,
      );
    }

    case 'yes_no':
      return wrap(
        <div className="fm__choices">
          {[
            { v: true, label: 'Yes' },
            { v: false, label: 'No' },
          ].map((o) => (
            <label className="fm__choice" key={String(o.v)}>
              <input type="radio" name={field.key} checked={value === o.v} onChange={() => onChange(o.v)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>,
        false,
      );

    // Typed and adopted, or drawn. The name is part of it either way.
    case 'signature':
      return wrap(
        <SignatureField
          id={id}
          value={value}
          onChange={onChange}
          describedBy={describedBy || undefined}
          invalid={Boolean(error)}
        />,
        false,
      );

    case 'signature_ack':
      return (
        <div className="fm__field" data-invalid={error ? 'true' : undefined}>
          <label className="fm__ack">
            <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
            <span>
              {field.label}
              {field.required && <span className="fm__req" aria-hidden="true"> *</span>}
            </span>
          </label>
          {error && (
            <p className="fm__error" role="alert">
              {error}
            </p>
          )}
        </div>
      );

    /*
      * A file input is one control with one id, so its label belongs to it.
      * This passed `labelFor = false` — the style the choice groups need,
      * where there is no single control to point at — and the result was a
      * visible label that named nothing and an input a screen reader read as
      * unlabelled. Every form in the catalogue with an attachment had it.
      */
    case 'file':
      return wrap(
        <FileField
          field={field}
          value={value}
          onChange={onChange}
          accept={(c.accept as string[]) ?? undefined}
          describedBy={describedBy || undefined}
          onFileUpload={onFileUpload}
        />,
      );

    case 'calculated':
      return (
        <div className="fm__field">
          <span className="fm__label">{field.label}</span>
          <output className="fm__computed">{computed === undefined || computed === null ? '—' : String(computed)}</output>
        </div>
      );

    case 'repeating_group':
      return <RepeatingGroup field={field} value={value} computed={computed} error={error} nestedErrors={nestedErrors} onChange={onChange} onFileUpload={onFileUpload} />;

    case 'address':
      return wrap(
        <textarea
          {...common}
          rows={3}
          autoComplete="street-address"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />,
      );

    default:
      return wrap(
        <input
          {...common}
          type="text"
          minLength={n(c.minLength)}
          maxLength={n(c.maxLength)}
          pattern={s(c.pattern)}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />,
      );
  }
}

function FileField({
  field,
  value,
  onChange,
  accept,
  describedBy,
  onFileUpload,
}: {
  field: PublicField;
  value: unknown;
  onChange: (v: unknown) => void;
  accept?: string[];
  describedBy?: string;
  onFileUpload?: (fieldKey: string, file: File) => Promise<string>;
}) {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const files = Array.isArray(value) ? (value as string[]) : value ? [value as string] : [];
  const max = typeof field.constraints?.maxFiles === 'number' ? field.constraints.maxFiles : 1;

  return (
    <div>
      <input
        id={`f-${field.key}`}
        className="fm__file"
        type="file"
        disabled={!onFileUpload || uploading}
        aria-describedby={describedBy}
        multiple={max > 1}
        accept={accept?.join(',')}
        onChange={async (e) => {
          const picked = [...(e.target.files ?? [])];
          if (!picked.length || !onFileUpload) return;
          setUploading(true);
          setMessage('Uploading and checking the file…');
          try {
            const uploaded = await Promise.all(picked.map((file) => onFileUpload(field.key, file)));
            onChange(max > 1 ? [...files, ...uploaded].slice(0, max) : uploaded[0]);
            setMessage('Uploaded. A security scan must finish before submission.');
          } catch (error) {
            setMessage(error instanceof Error ? error.message : 'Upload failed. Try again.');
          } finally {
            setUploading(false);
            e.target.value = '';
          }
        }}
      />
      {!onFileUpload && <p className="fm__fileWarn">Uploads are unavailable in preview.</p>}
      {message && <p className="fm__help" role="status">{message}</p>}
      {files.length > 0 && (
        <ul className="fm__files">
          {files.map((reference, index) => (
            <li key={`${reference}-${index}`}>
              File {index + 1} uploaded{' '}
              <button type="button" onClick={() => onChange(max > 1 ? files.filter((_, i) => i !== index) : null)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RepeatingGroup({
  field,
  value,
  computed,
  error,
  nestedErrors,
  onChange,
  onFileUpload,
}: {
  field: PublicField;
  value: unknown;
  computed?: unknown;
  error?: string;
  nestedErrors?: Record<string, string>;
  onChange: (v: unknown) => void;
  onFileUpload?: (fieldKey: string, file: File) => Promise<string>;
}) {
  const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

  const update = (index: number, key: string, v: unknown) => {
    const next = rows.map((row, i) => (i === index ? { ...row, [key]: v } : row));
    onChange(next);
  };

  return (
    <div className="fm__field" data-invalid={error ? 'true' : undefined}>
      <span className="fm__label">
        {field.label}
        {field.required && <span className="fm__req" aria-hidden="true"> *</span>}
      </span>
      {field.help && <p className="fm__help">{field.help}</p>}

      {rows.map((row, index) => (
        <div className="fm__row" key={index}>
          <div className="fm__rowFields">
            {field.fields?.map((child) => (
              <Field
                key={child.key}
                field={child}
                value={row[child.key]}
                computed={Array.isArray(computed) ? (computed[index] as Record<string, unknown> | undefined)?.[child.key] : undefined}
                error={nestedErrors?.[`${field.key}[${index}].${child.key}`]}
                onChange={(v) => update(index, child.key, v)}
                onFileUpload={onFileUpload}
              />
            ))}
          </div>
          <button
            type="button"
            className="fm__remove"
            aria-label={`Remove item ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}

      <button type="button" className="fm__btn" onClick={() => onChange([...rows, {}])}>
        Add {field.label.toLowerCase().replace(/s$/, '')}
      </button>

      {error && (
        <p className="fm__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
