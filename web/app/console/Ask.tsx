'use client';

import { useState } from 'react';
import { AskHistory } from './Trail';

/**
 * §20.1 step 9, on screen.
 *
 * Three things have to be visible here or the feature is a liability: what the
 * system understood, exactly which records it will touch, and who each message
 * reaches. The confirm button is deliberately the last thing, after all of it,
 * and it carries the digest the preview returned — so pressing it runs what is
 * on screen or nothing at all.
 *
 * The plan is shown too, folded away. Most operators will never open it; the
 * one who does is usually the one about to email forty people, and they should
 * be able to see that "overdue" meant the SLA and not something the model
 * invented.
 */

interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  at: string;
  fix?: string;
}

interface MatchedRecord {
  instanceId: string;
  reference: string;
  stateName: string;
  hoursInState: number;
  overdue: boolean;
  answers: Record<string, unknown>;
}

interface ActionPreview {
  kind: string;
  summary: string;
  digest: string;
  eligible: { instanceId: string; reference: string; to: string[] }[];
  refused: { instanceId: string; reference: string; reason: string }[];
  skipped: { instanceId: string; reference: string; reason: string }[];
}

interface AskResult {
  runId: string;
  reading: string;
  plan: unknown;
  action: { kind: string; template?: string } | null;
  diagnostics: Diagnostic[];
  ok: boolean;
  rows: MatchedRecord[];
  preview: ActionPreview | null;
  audit: { provider: string; model: string; promptVersion: string; latencyMs: number };
}

interface Report {
  kind?: string;
  attempted: number;
  sent: { reference: string; to: string[] }[];
  skipped: { reference: string; reason: string }[];
  failed: { reference: string; reason: string }[];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

const SUGGESTIONS = [
  'Which records are overdue?',
  'What is still waiting on HR?',
  'Anything where a message failed to send?',
  'Remind everyone whose approval is overdue',
];

export function Ask({ processKey, onOpenRecord }: { processKey: string; onOpenRecord: (id: string) => void }) {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AskResult | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPlan, setShowPlan] = useState(false);

  const startForm = () => {
    if (question.trim()) sessionStorage.setItem('patform:new-process-description', question.trim());
    window.location.href = '/builder?new=describe';
  };

  /**
   * Runs a plan from the history directly, without asking a model again.
   *
   * The plan is the thing that was approved, so re-running it re-runs exactly
   * what somebody looked at. Asking the model the same question again could
   * produce a different plan — which is the whole reason the plan, and not the
   * question, is what gets confirmed.
   */
  const rerun = async (plan: unknown) => {
    setBusy('ask');
    setError(null);
    setReport(null);
    try {
      const ran = await call<AskResult>('/api/copilot/run', {
        method: 'POST',
        body: JSON.stringify({ plan }),
      });
      setResult(ran);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const submit = async (text: string) => {
    if (!text.trim()) return;
    setBusy('ask');
    setError(null);
    setReport(null);
    setResult(null);
    try {
      setResult(await call<AskResult>('/api/copilot/ask', {
        method: 'POST',
        body: JSON.stringify({ processKey, question: text }),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const confirmPlan = async () => {
    if (!result?.preview) return;
    setBusy('confirm');
    setError(null);
    try {
      setReport(
        await call<Report>('/api/copilot/confirm', {
          method: 'POST',
          body: JSON.stringify({ runId: result.runId, digest: result.preview.digest }),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const errors = result?.diagnostics.filter((d) => d.severity === 'error') ?? [];

  return (
    <div className="cs__panel">
      <div className="cs__panelHead">
        <h2 className="cs__tab">Ask</h2>
        <span className="cs__sort">answered from your records, never from the model&rsquo;s memory</span>
      </div>

      <div style={{ padding: '14px 18px' }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(question);
          }}
          className="ask__form"
        >
          <label className="ask__label" htmlFor="ask-question">
            Ask about these records
          </label>
          <input
            id="ask-question"
            className="ask__input"
            value={question}
            placeholder="Which records are overdue?"
            onChange={(e) => setQuestion(e.target.value)}
            disabled={busy !== null}
          />
          <button type="submit" className="cs__btn cs__btn--primary" disabled={busy !== null || !question.trim()}>
            {busy === 'ask' ? 'Thinking…' : 'Ask'}
          </button>
        </form>
        <div className="ask__builderHandoff">
          <span>Need a new form or approval process? AI can draft it in the Builder.</span>
          <button type="button" className="cs__btn" onClick={startForm}>Build a form with AI</button>
        </div>

        {/*
          * §7.3 asks for a record of model, prompt version, plan, human
          * approval and result for every question. It was written from the
          * first day and had no reader until now — an AI audit log nobody can
          * open is a compliance claim rather than a control.
          */}
        {!result && !error && (
          <div className="ask__history">
            <h3 className="ask__historyTitle">What has been asked here</h3>
            <AskHistory
              onRerun={(run) => {
                setQuestion(run.question);
                void rerun(run.plan);
              }}
            />
          </div>
        )}

        {!result && !error && (
          <div className="ask__suggestions">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                className="ask__suggestion"
                onClick={() => {
                  setQuestion(s);
                  void submit(s);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {error && (
          <p className="ask__error" role="alert">
            {error}
          </p>
        )}

        {result && (
          <>
            {/* 4.1.3: the answer arrives without focus moving, and the
                reading is the part a person must check before confirming. */}
            <p className="ask__reading" role="status" aria-live="polite">
              {result.reading}
            </p>

            {errors.length > 0 && (
              <div className="ask__diagnostics" role="alert">
                <strong>That question could not be answered as asked.</strong>
                {errors.map((d, i) => (
                  <p key={i}>
                    <code>{d.code}</code> {d.message}
                    {d.fix && <em> {d.fix}</em>}
                  </p>
                ))}
              </div>
            )}

            {result.ok && (
              <>
                <div className="ask__count">
                  {result.rows.length} {result.rows.length === 1 ? 'record' : 'records'}
                </div>

                <table className="ask__table">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>State</th>
                      <th>In state</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r) => (
                      <tr key={r.instanceId}>
                        <td>
                          <button className="ask__ref" onClick={() => onOpenRecord(r.instanceId)}>
                            <code>{r.reference}</code>
                            <span className="ask__srOnly"> — open this record</span>
                          </button>
                        </td>
                        <td>
                          {r.stateName}
                          {r.overdue && <span className="ask__late">late</span>}
                        </td>
                        <td>{r.hoursInState}h</td>
                        <td className="ask__answers">
                          {Object.entries(r.answers)
                            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
                            .join(' · ') || '—'}
                        </td>
                      </tr>
                    ))}
                    {!result.rows.length && (
                      <tr>
                        <td colSpan={4} className="ask__empty">
                          Nothing matched. That is an answer, not an error.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                <button className="ask__planToggle" onClick={() => setShowPlan(!showPlan)}>
                  {showPlan ? 'Hide' : 'Show'} the plan this ran
                </button>
                {showPlan && (
                  <>
                    <pre className="ask__plan">{JSON.stringify(result.plan, null, 2)}</pre>
                    <p className="ask__audit">
                      {result.audit.provider} · {result.audit.model} · {result.audit.promptVersion} ·{' '}
                      {(result.audit.latencyMs / 1000).toFixed(1)}s. The model wrote this plan, not the query —
                      it has no database access.
                    </p>
                  </>
                )}
              </>
            )}

            {result.preview && !report && <Preview preview={result.preview} busy={busy === 'confirm'} onConfirm={confirmPlan} />}
            {report && <Result report={report} />}
          </>
        )}
      </div>
    </div>
  );
}

function Preview({ preview, busy, onConfirm }: { preview: ActionPreview; busy: boolean; onConfirm: () => void }) {
  return (
    <div className="ask__preview">
      <strong>{preview.summary}</strong>

      {preview.eligible.length > 0 && (
        <table className="ask__table ask__table--tight">
          <thead>
            <tr>
              <th>Record</th>
              <th>Goes to</th>
            </tr>
          </thead>
          <tbody>
            {preview.eligible.map((e) => (
              <tr key={e.instanceId}>
                <td>
                  <code>{e.reference}</code>
                </td>
                <td>{e.to.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {preview.refused.length > 0 && (
        <p className="ask__refused">
          <strong>{preview.refused.length} refused:</strong>{' '}
          {preview.refused.map((r) => `${r.reference} (${r.reason})`).join('; ')}
        </p>
      )}
      {preview.skipped.length > 0 && (
        <p className="ask__skipped">
          <strong>{preview.skipped.length} skipped:</strong>{' '}
          {preview.skipped.map((s) => `${s.reference} (${s.reason})`).join('; ')}
        </p>
      )}

      <div className="ask__confirmRow">
        <span className="ask__digest">
          Confirming runs exactly these {preview.eligible.length}. A record that becomes eligible in the meantime
          is not included.
        </span>
        <button className="cs__btn cs__btn--primary" onClick={onConfirm} disabled={busy || !preview.eligible.length}>
          {busy ? 'Working…' : `${VERB[preview.kind] ?? 'Confirm'} ${preview.eligible.length}`}
        </button>
      </div>
    </div>
  );
}

/* The copilot can do three things now; the words follow the thing done. */
const VERB: Record<string, string> = { send_reminder: 'Send', assign: 'Reassign', change_state: 'Move', set_answer: 'Change' };
const DONE: Record<string, string> = { send_reminder: 'sent', assign: 'reassigned', change_state: 'moved', set_answer: 'changed' };

function Result({ report }: { report: Report }) {
  return (
    <div className="ask__result" role="status" aria-live="polite">
      <strong>
        {report.sent.length} {DONE[report.kind ?? 'send_reminder'] ?? 'done'} of {report.attempted} attempted.
      </strong>
      {report.sent.map((s, i) => (
        <p key={i}>
          <code>{s.reference}</code> → {s.to.join(', ')}
        </p>
      ))}
      {report.skipped.map((s, i) => (
        <p key={`sk${i}`} className="ask__skipped">
          <code>{s.reference}</code> skipped — {s.reason}
        </p>
      ))}
      {report.failed.map((f, i) => (
        <p key={`f${i}`} className="ask__error">
          <code>{f.reference}</code> failed — {f.reason}
        </p>
      ))}
    </div>
  );
}
