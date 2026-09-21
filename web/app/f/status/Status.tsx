'use client';

import { useCallback, useEffect, useState } from 'react';
import '../[process]/form.css';

/**
 * §6.3's respondent status page, and §20.1 step 6: when an approver asks for
 * changes, the respondent updates only the fields their role may edit.
 *
 * The list of editable fields comes from the blueprint's respondent role, and
 * the policy engine refuses anything outside it — this page is the first thing
 * that exercises that control rather than merely proving it.
 */

interface EditableField {
  key: string;
  type: string;
  label: string;
  help?: string;
  required: boolean;
  choices?: { value: string; label: string }[];
  value: unknown;
}

interface StatusResponse {
  reference: string;
  processName: string;
  status: string;
  finished: boolean;
  outcome: string | null;
  changesRequested: string | null;
  editableFields: EditableField[];
}

export function Status() {
  const [token, setToken] = useState<string | null>(null);
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [patch, setPatch] = useState<Record<string, unknown>>({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const load = useCallback(async (t: string) => {
    try {
      const res = await fetch(`/api/status?resume=${encodeURIComponent(t)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'that link has expired');
      setData(body as StatusResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('resume');
    if (!t) return setError('This link is missing its code.');
    setToken(t);
    void load(t);
  }, [load]);

  const send = async () => {
    if (!token) return;
    setSending(true);
    try {
      const res = await fetch(`/api/status/update?resume=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patch }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.reason ?? body.error ?? 'that did not go through');
      if (body.refused?.length) {
        throw new Error(`You cannot change: ${body.refused.join(', ')}`);
      }
      setSent(true);
      setPatch({});
      await load(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  if (error && !data) {
    return (
      <div className="fm">
        <div className="fm__shell">
          <div className="fm__card" style={{ marginTop: 72 }}>
            <h1 className="fm__title">We cannot open this</h1>
            <p className="fm__lede">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return <div className="fm__boot">Loading…</div>;

  const tone = data.finished ? 'fm__status--done' : data.changesRequested ? 'fm__status--waiting' : '';

  return (
    <div className="fm">
      <div className="fm__shell">
        <header className="fm__head">
          <span className="fm__process">{data.processName}</span>
          <span className="fm__save">Reference {data.reference}</span>
        </header>

        <div className="fm__card">
          <h1 className="fm__title">Where this has got to</h1>
          <span className={`fm__status ${tone}`}>{data.status}</span>

          {data.changesRequested && (
            <div className="fm__notice">
              <div className="fm__noticeTitle">We need something from you</div>
              <p className="fm__noticeBody">{data.changesRequested}</p>
            </div>
          )}

          {sent && !data.changesRequested && (
            <p className="fm__lede" style={{ color: 'var(--green-deep)' }}>
              Thank you — your update has gone back for review.
            </p>
          )}

          {error && <p className="fm__formError">{error}</p>}

          {!data.finished && data.editableFields.length > 0 && (
            <>
              <section className="fm__section">
                <h2 className="fm__sectionTitle">What you can still change</h2>
                <p className="fm__sectionLede">
                  Everything else is locked while the process is under way.
                </p>

                {data.editableFields.map((field) => (
                  <div className="fm__field" key={field.key}>
                    <label className="fm__label" htmlFor={`s-${field.key}`}>
                      {field.label}
                    </label>
                    {field.help && <p className="fm__help">{field.help}</p>}
                    {field.type === 'long_text' ? (
                      <textarea
                        id={`s-${field.key}`}
                        className="fm__input"
                        rows={3}
                        value={String(patch[field.key] ?? field.value ?? '')}
                        onChange={(e) => setPatch((p) => ({ ...p, [field.key]: e.target.value }))}
                      />
                    ) : field.type === 'yes_no' ? (
                      <div className="fm__choices">
                        {[
                          { v: true, label: 'Yes' },
                          { v: false, label: 'No' },
                        ].map((o) => (
                          <label className="fm__choice" key={String(o.v)}>
                            <input
                              type="radio"
                              name={field.key}
                              checked={(patch[field.key] ?? field.value) === o.v}
                              onChange={() => setPatch((p) => ({ ...p, [field.key]: o.v }))}
                            />
                            <span>{o.label}</span>
                          </label>
                        ))}
                      </div>
                    ) : field.type === 'multi_choice' ? (
                      <div className="fm__choices">
                        {field.choices?.map((choice) => {
                          const current = (patch[field.key] ?? field.value ?? []) as string[];
                          return (
                            <label className="fm__choice" key={choice.value}>
                              <input
                                type="checkbox"
                                checked={current.includes(choice.value)}
                                onChange={(e) =>
                                  setPatch((p) => ({
                                    ...p,
                                    [field.key]: e.target.checked
                                      ? [...current, choice.value]
                                      : current.filter((v) => v !== choice.value),
                                  }))
                                }
                              />
                              <span>{choice.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <input
                        id={`s-${field.key}`}
                        className="fm__input"
                        type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'date' ? 'date' : 'text'}
                        value={String(patch[field.key] ?? field.value ?? '')}
                        onChange={(e) => setPatch((p) => ({ ...p, [field.key]: e.target.value }))}
                      />
                    )}
                  </div>
                ))}
              </section>

              <div className="fm__actions">
                <span style={{ flexGrow: 1 }} />
                <button
                  type="button"
                  className="fm__btn fm__btn--primary"
                  disabled={sending || Object.keys(patch).length === 0}
                  onClick={() => void send()}
                >
                  {sending ? 'Sending…' : 'Send these updates'}
                </button>
              </div>
            </>
          )}

          {data.finished && (
            <p className="fm__lede">
              This is finished. Nothing more is needed from you.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
