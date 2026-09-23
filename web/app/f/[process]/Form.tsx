'use client';

/**
 * The respondent's form: loading, answering, checking, submitting.
 *
 * How a field *looks* lives in `components/form-surface`, which the builder's
 * preview renders too. What an answer *means* lives on the server. Constraint
 * values arrive from the API and become native HTML attributes, so the
 * browser enforces the same numbers the server holds; `validateAnswers` is
 * what decides. One source of truth in the blueprint, two enforcers, no
 * second copy of the rules to drift.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  FieldCell,
  FormHeader,
  accentStyle,
  type PublicForm,
  Field,
} from '../../../components/form-surface';

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

export function Form({ processKey: fromUrl }: { processKey: string }) {
  /*
   * What every request names. It starts as whatever the URL said, and becomes
   * the form's own public link as soon as the form loads — so a page opened
   * through an old `/f/<process_key>` link moves itself onto the link that
   * names one workspace's form, and the address bar says so.
   */
  const [processKey, setProcessKey] = useState(fromUrl);
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
  const trapRef = useRef<HTMLInputElement>(null);
  const [done, setDone] = useState<{ reference: string; statusUrl: string | null } | null>(null);

  const dirty = useRef(false);

  // ---- load the published form, and any draft the link carries
  useEffect(() => {
    (async () => {
      try {
        const f = await api<PublicForm>(`/api/forms/${processKey}`);
        if (f.publicId && f.publicId !== processKey) {
          window.history.replaceState(null, '', `/f/${f.publicId}${window.location.search}`);
          setProcessKey(f.publicId);
        }
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
      }>(`/api/forms/${processKey}/submit`, {
        method: 'POST',
        body: JSON.stringify({ token, answers, ticket: form?.ticket, trap: trapRef.current?.value ?? '' }),
      });

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

  const brand = form.branding;
  const saveNote = saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved — you can close this and come back' : '';

  return (
    /*
     * The accent is a hex colour the schema has already checked, and it is set
     * by overriding the token rather than by styling each control — so a
     * branded form is the same form in a different colour, not a second set of
     * styles that can fall out of step with the first.
     */
    <div className="fm" data-branded={brand ? 'true' : undefined} style={accentStyle(brand?.accent)}>
      <div className="fm__shell">
        <FormHeader
          branding={brand}
          fallbackName={form.processName}
          note={form.saveAndResume ? saveNote : undefined}
        />

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
                <div className="fm__grid">
                  {fields.map((field) => (
                    <FieldCell section={section} fieldKey={field.key} key={field.key}>
                      <Field
                        field={field}
                        value={answers[field.key]}
                        computed={computed[field.key]}
                        error={errors[field.key]}
                        onChange={(v) => set(field.key, v)}
                      />
                    </FieldCell>
                  ))}
                </div>
              </section>
            );
          })}

          {/*
            * The trap. Off-screen, out of the tab order, hidden from assistive
            * tech and from autofill as far as a page can ask — so a person
            * never reaches it, and a script that fills every input it finds
            * does. Its label says what to do for anyone who somehow lands on
            * it. Filling it holds the submission for a person to look at; it
            * never discards one.
            */}
          {form.trap && (
            <div className="fm__trap" aria-hidden="true">
              <label htmlFor={`fm-${form.trap}`}>Leave this empty</label>
              <input
                ref={trapRef}
                id={`fm-${form.trap}`}
                name={form.trap}
                type="text"
                tabIndex={-1}
                autoComplete="off"
                defaultValue=""
              />
            </div>
          )}

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

        {brand?.footer && <p className="fm__foot">{brand.footer}</p>}
      </div>
    </div>
  );
}