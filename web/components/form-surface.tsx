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

export interface PublicField {
  key: string;
  type: string;
  label: string;
  help?: string;
  required: boolean;
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
          <span className="fm__save" aria-live="polite">
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
  onChange,
}: {
  field: PublicField;
  value: unknown;
  computed?: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const id = `f-${field.key}`;
  const describedBy = [field.help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  const c = field.constraints ?? {};

  const wrap = (control: React.ReactNode, labelFor = true) => (
    <div className="fm__field" data-invalid={error ? 'true' : undefined}>
      {labelFor ? (
        <label className="fm__label" htmlFor={id}>
          {field.label}
          {field.required && <span className="fm__req" aria-hidden="true"> *</span>}
        </label>
      ) : (
        <span className="fm__label">
          {field.label}
          {field.required && <span className="fm__req" aria-hidden="true"> *</span>}
        </span>
      )}
      {field.help && (
        <p className="fm__help" id={`${id}-help`}>
          {field.help}
        </p>
      )}
      {control}
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
    required: field.required,
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
        <div className="fm__choices" role="radiogroup" aria-labelledby={id}>
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
      return <RepeatingGroup field={field} value={value} error={error} onChange={onChange} />;

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

/**
 * File input. The bytes go to local disk behind the API — there is no object
 * storage, no malware scan and no quarantine yet (§12.1), and the form says
 * nothing it cannot back up.
 */
function FileField({
  field,
  value,
  onChange,
  accept,
  describedBy,
}: {
  field: PublicField;
  value: unknown;
  onChange: (v: unknown) => void;
  accept?: string[];
  describedBy?: string;
}) {
  const names = Array.isArray(value) ? (value as string[]) : value ? [value as string] : [];
  const max = typeof field.constraints?.maxFiles === 'number' ? field.constraints.maxFiles : 1;

  return (
    <div>
      <input
        id={`f-${field.key}`}
        className="fm__file"
        type="file"
        required={field.required}
        aria-describedby={describedBy}
        multiple={max > 1}
        accept={accept?.join(',')}
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])].map((f) => f.name);
          onChange(max > 1 ? picked : (picked[0] ?? null));
        }}
      />
      {/*
        * Said out loud, because the control does not do what a file input
        * looks like it does: the browser hands over the file's name and the
        * bytes stay on the machine. A respondent who believes they have sent
        * their passport, and a reviewer who believes they have received it,
        * are both wrong and neither would find out.
        *
        * SEC013 refuses to publish a new process with one of these, so this
        * only renders for a version published before that existed.
        */}
      <p className="fm__fileWarn">
        The document itself is not sent — only its name is recorded. If somebody needs to see it, send it the way
        they asked you to.
      </p>
      {names.length > 0 && (
        <ul className="fm__files">
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RepeatingGroup({
  field,
  value,
  error,
  onChange,
}: {
  field: PublicField;
  value: unknown;
  error?: string;
  onChange: (v: unknown) => void;
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
                onChange={(v) => update(index, child.key, v)}
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
