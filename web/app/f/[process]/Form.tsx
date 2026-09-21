'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import './form.css';

/**
 * The respondent's form.
 *
 * This component knows how to *render* a field and nothing about whether an
 * answer is acceptable. Constraint values arrive from the API and become
 * native HTML attributes, so the browser enforces the same numbers the server
 * holds; `validateAnswers` on the server is what decides. One source of truth
 * in the blueprint, two enforcers, no second copy of the rules to drift.
 */

interface PublicField {
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

interface Section {
  key: string;
  title?: string;
  description?: string;
  visibleWhen?: unknown;
  fields: PublicField[];
}

interface Page {
  key: string;
  title: string;
  description?: string;
  sections: Section[];
}

interface PublicForm {
  processKey: string;
  processName: string;
  version: number;
  showProgress: boolean;
  saveAndResume: boolean;
  confirmation: { message: string; showStatusLink: boolean };
  pages: Page[];
}

type Answers = Record<string, unknown>;
type Errors = Record<string, string>;

interface CheckResult {
  errors: { field: string; message: string }[];
  visible: string[];
  computed: Answers;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

const n = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function Form({ processKey }: { processKey: string }) {
  const [form, setForm] = useState<PublicForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Errors>({});
  const [visible, setVisible] = useState<Set<string> | null>(null);
  const [computed, setComputed] = useState<Answers>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [token, setToken] = useState<string | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ reference: string; statusUrl: string | null } | null>(null);

  const dirty = useRef(false);

  // ---- load the published form, and any draft the link carries
  useEffect(() => {
    (async () => {
      try {
        const f = await api<PublicForm>(`/api/forms/${processKey}`);
        setForm(f);

        const resume = new URLSearchParams(window.location.search).get('resume');
        if (resume) {
          const draft = await api<{ answers: Answers; page: number; submittedInstanceId: string | null }>(
            `/api/forms/${processKey}/draft?token=${encodeURIComponent(resume)}`,
          );
          if (draft.submittedInstanceId) {
            setDone({ reference: draft.submittedInstanceId.slice(0, 8).toUpperCase(), statusUrl: null });
          } else {
            setToken(resume);
            setAnswers(draft.answers);
            setPageIndex(draft.page);
          }
        } else {
          // Defaults come from the blueprint, so an unanswered form is not
          // blank where the process said otherwise.
          const defaults: Answers = {};
          for (const page of f.pages)
            for (const section of page.sections)
              for (const field of section.fields)
                if (field.default !== undefined) defaults[field.key] = field.default;
          setAnswers(defaults);
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [processKey]);

  // ---- conditional visibility and calculated totals, decided server-side
  const recheck = useCallback(
    async (next: Answers) => {
      try {
        const result = await api<CheckResult>(`/api/forms/${processKey}/check`, {
          method: 'POST',
          body: JSON.stringify({ answers: next }),
        });
        setVisible(new Set(result.visible));
        setComputed(result.computed);
      } catch {
        // A failed check must not block typing; the server checks again on
        // submit and nothing can get past that.
      }
    },
    [processKey],
  );

  useEffect(() => {
    if (form) void recheck(answers);
    // Only on load: typing triggers its own debounce below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  // ---- §6.3 autosave: quiet, debounced, and never losing a keystroke
  useEffect(() => {
    if (!form?.saveAndResume || !dirty.current) return;
    const id = setTimeout(async () => {
      setSaving('saving');
      try {
        const saved = await api<{ token: string }>(`/api/forms/${processKey}/draft`, {
          method: 'POST',
          body: JSON.stringify({ token, answers, page: pageIndex }),
        });
        if (!token) {
          setToken(saved.token);
          // Put the resume link in the address bar so closing the tab is not
          // the same as losing the work.
          const url = new URL(window.location.href);
          url.searchParams.set('resume', saved.token);
          window.history.replaceState({}, '', url);
        }
        setSaving('saved');
      } catch {
        setSaving('idle');
      }
    }, 900);
    return () => clearTimeout(id);
  }, [answers, pageIndex, token, form, processKey]);

  const set = (key: string, value: unknown) => {
    dirty.current = true;
    setAnswers((prev) => {
      const next = { ...prev, [key]: value };
      void recheck(next);
      return next;
    });
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const validatePage = async (): Promise<boolean> => {
    const result = await api<CheckResult>(`/api/forms/${processKey}/check`, {
      method: 'POST',
      body: JSON.stringify({ answers, pageIndex }),
    });
    const map: Errors = {};
    for (const e of result.errors) map[e.field] = e.message;
    setErrors(map);
    if (result.errors.length) {
      document.querySelector('[data-invalid="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return result.errors.length === 0;
  };

  const next = async () => {
    if (!(await validatePage())) return;
    setPageIndex((i) => Math.min(i + 1, (form?.pages.length ?? 1) - 1));
    window.scrollTo({ top: 0 });
  };

  const submit = async () => {
    if (!(await validatePage())) return;
    setSubmitting(true);
    try {
      const result = await api<{
        ok: boolean;
        errors?: { field: string; message: string }[];
        instanceId?: string;
        resumeToken?: string;
      }>(`/api/forms/${processKey}/submit`, { method: 'POST', body: JSON.stringify({ token, answers }) });

      if (!result.ok) {
        const map: Errors = {};
        for (const e of result.errors ?? []) map[e.field] = e.message;
        setErrors(map);
        // An error from a page behind this one would otherwise be invisible.
        setPageIndex(0);
        return;
      }
      setDone({
        reference: result.instanceId!.slice(0, 8).toUpperCase(),
        statusUrl: result.resumeToken ? `/f/status?resume=${encodeURIComponent(result.resumeToken)}` : null,
      });
    } catch (err) {
      setErrors({ _: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  if (loadError) {
    return (
      <div className="fm">
        <div className="fm__card">
          <h1 className="fm__title">This form is not available</h1>
          <p className="fm__lede">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!form) return <div className="fm__boot">Loading…</div>;

  if (done) {
    return (
      <div className="fm">
        <div className="fm__card fm__card--done">
          <div className="fm__tick" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 26 26" fill="none">
              <path d="M5 13.5L10.5 19L21 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 className="fm__title">Thank you</h1>
          <p className="fm__lede">{form.confirmation.message}</p>
          <p className="fm__ref">
            Your reference is <strong>{done.reference}</strong>
          </p>
          {form.confirmation.showStatusLink && done.statusUrl && (
            <a className="fm__btn fm__btn--primary" href={done.statusUrl} style={{ marginTop: 20 }}>
              Check its progress
            </a>
          )}
        </div>
      </div>
    );
  }

  const page = form.pages[pageIndex]!;
  const last = pageIndex === form.pages.length - 1;
  const shown = (key: string) => !visible || visible.has(key);

  return (
    <div className="fm">
      <div className="fm__shell">
        <header className="fm__head">
          <span className="fm__process">{form.processName}</span>
          {form.saveAndResume && (
            <span className="fm__save" aria-live="polite">
              {saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved — you can close this and come back' : ''}
            </span>
          )}
        </header>

        {form.showProgress && (
          <div className="fm__progress">
            <div className="fm__progressBar">
              <span style={{ width: `${((pageIndex + 1) / form.pages.length) * 100}%` }} />
            </div>
            <span className="fm__progressText">
              Step {pageIndex + 1} of {form.pages.length}
            </span>
          </div>
        )}

        <div className="fm__card">
          <h1 className="fm__title">{page.title}</h1>
          {page.description && <p className="fm__lede">{page.description}</p>}

          {errors._ && <p className="fm__formError">{errors._}</p>}

          {page.sections.map((section) => {
            const fields = section.fields.filter((f) => shown(f.key));
            if (!fields.length) return null;
            return (
              <section className="fm__section" key={section.key}>
                {section.title && <h2 className="fm__sectionTitle">{section.title}</h2>}
                {section.description && <p className="fm__sectionLede">{section.description}</p>}
                {fields.map((field) => (
                  <Field
                    key={field.key}
                    field={field}
                    value={answers[field.key]}
                    computed={computed[field.key]}
                    error={errors[field.key]}
                    onChange={(v) => set(field.key, v)}
                  />
                ))}
              </section>
            );
          })}

          <div className="fm__actions">
            {pageIndex > 0 && (
              <button
                type="button"
                className="fm__btn"
                onClick={() => {
                  setPageIndex((i) => i - 1);
                  window.scrollTo({ top: 0 });
                }}
              >
                Back
              </button>
            )}
            <span style={{ flexGrow: 1 }} />
            {last ? (
              <button type="button" className="fm__btn fm__btn--primary" onClick={() => void submit()} disabled={submitting}>
                {submitting ? 'Submitting…' : 'Submit'}
              </button>
            ) : (
              <button type="button" className="fm__btn fm__btn--primary" onClick={() => void next()}>
                Continue
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One field. Constraint values become native attributes; nothing is decided here. */
function Field({
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

    case 'file':
      return wrap(
        <FileField field={field} value={value} onChange={onChange} accept={(c.accept as string[]) ?? undefined} />,
        false,
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
}: {
  field: PublicField;
  value: unknown;
  onChange: (v: unknown) => void;
  accept?: string[];
}) {
  const names = Array.isArray(value) ? (value as string[]) : value ? [value as string] : [];
  const max = typeof field.constraints?.maxFiles === 'number' ? field.constraints.maxFiles : 1;

  return (
    <div>
      <input
        id={`f-${field.key}`}
        className="fm__file"
        type="file"
        multiple={max > 1}
        accept={accept?.join(',')}
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])].map((f) => f.name);
          onChange(max > 1 ? picked : (picked[0] ?? null));
        }}
      />
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
