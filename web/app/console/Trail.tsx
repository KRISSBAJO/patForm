'use client';

/**
 * What actually happened to one record, and what the copilot has been asked.
 *
 * The observability work in §20.2 made every action traceable by request,
 * event, job, attempt and result — and the only way to read any of it was a
 * command-line tool. An audit trail that needs a terminal is an audit trail
 * the people who need it cannot use.
 */

import { useCallback, useEffect, useState } from 'react';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

/*
 * One action the runtime ran. Every field is required and named as the API
 * names it, on purpose: the previous version guessed at `actionKey` and
 * `action_key`, both optional, and the API sends neither. Two optional guesses
 * cost nothing to compile and rendered every action in the trail as a dash.
 */
interface Attempt {
  id: number;
  action: string;
  status: string;
  attempts: number;
  performedBy: string | null;
  completedAt: string | null;
  lastError: string | null;
  result: string | null;
}

interface TraceStep {
  requestId: string;
  eventId: number;
  seq: number;
  type: string;
  actor: string | null;
  occurredAt: string;
  job: {
    id: number;
    transitionKey: string;
    attempts: number;
    doneAt: string | null;
    lastError: string | null;
  } | null;
  actions: Attempt[];
}

interface InstanceTrace {
  reference: string;
  stateName: string;
  outcome: string | null;
  diagnosis: string;
  steps: TraceStep[];
  stuck: { jobId: number; transitionKey: string; attempts: number; lastError: string | null }[];
}

/**
 * The trail for one record.
 *
 * Reads bottom-up in the database and top-down here: the first thing that
 * happened is first, because somebody asking "why did this stall" is following
 * a story, not scanning a log.
 */
/*
 * The action keys, in words.
 *
 * This page is read by somebody answering "what happened to my application",
 * often under pressure, sometimes an auditor. `send_email` is the key the
 * blueprint uses and not a sentence. Anything unmapped falls back to the key
 * with its underscores opened out, so a new action reads badly rather than
 * disappearing — the failure mode that produced the dashes in the first place.
 */
const ACTION_WORDS: Record<string, string> = {
  send_email: 'sent an email',
  request_approval: 'asked for a decision',
  call_webhook: 'called a webhook',
  create_task: 'created a task',
  assign: 'assigned it to somebody',
  set_field: 'set a field',
  generate_document: 'produced a document',
  schedule_timer: 'set a timer',
  cancel_timer: 'cancelled a timer',
};

function actionName(key: string): string {
  return ACTION_WORDS[key] ?? key.replace(/_/g, ' ');
}

/** "3 tries", never "1 attempt(s)". Callers only show this above one. */
function tries(n: number): string {
  return n === 1 ? '1 try' : `${n} tries`;
}

export function RecordTrail({ instanceId }: { instanceId: string }) {
  const [trace, setTrace] = useState<InstanceTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [related, setRelated] = useState<{ requestId: string; rows: unknown } | null>(null);

  useEffect(() => {
    let live = true;
    get<InstanceTrace>(`/api/records/${instanceId}/trace`)
      .then((t) => live && setTrace(t))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [instanceId]);

  if (error) {
    return (
      <p className="tr__note" role="alert">
        {error}
      </p>
    );
  }
  if (!trace) return <p className="tr__note">Reading the trail…</p>;

  return (
    <div className="tr">
      {/* The one-line answer first. Everything below is the working. */}
      <p className="tr__diagnosis">{trace.diagnosis}</p>

      {trace.stuck.length > 0 && (
        <div className="tr__stuck" role="status">
          <strong>Still waiting</strong>
          <ul>
            {trace.stuck.map((s) => (
              <li key={s.jobId}>
                {s.transitionKey} — {tries(s.attempts)}
                {s.lastError ? `: ${s.lastError}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ol className="tr__steps">
        {trace.steps.map((step) => (
          <li key={`${step.eventId}-${step.seq}`} className="tr__step">
            <div className="tr__stepHead">
              <span className="tr__type">{step.type}</span>
              <span className="tr__when">{new Date(step.occurredAt).toLocaleString()}</span>
            </div>
            <div className="tr__meta">
              {step.actor ?? 'system'}
              {' · '}
              {/*
                * The request id is the thread: it is the same across
                * everything one call caused, including work a background
                * worker did minutes later. Clicking it shows the rest.
                */}
              <button
                type="button"
                className="cs__linkBtn cs__linkBtn--onLight"
                onClick={() => {
                  void get(`/api/trace/${encodeURIComponent(step.requestId)}`)
                    .then((rows) => setRelated({ requestId: step.requestId, rows }))
                    .catch((err: Error) => setError(err.message));
                }}
              >
                {step.requestId}
              </button>
            </div>

            {step.job && (
              <div className="tr__job">
                {step.job.transitionKey} · {step.job.doneAt ? 'done' : 'not done'}
                {step.job.attempts > 1 && ` · ${tries(step.job.attempts)}`}
                {step.job.lastError && <div className="tr__error">{step.job.lastError}</div>}
              </div>
            )}

            {step.actions?.length ? (
              <ul className="tr__actions">
                {step.actions.map((a) => (
                  <li key={a.id}>
                    <span className="tr__actionName">{actionName(a.action)}</span>
                    <span className="tr__actionMark" data-status={a.status}>
                      {a.status}
                    </span>
                    {a.attempts > 1 && <span className="tr__tries">{tries(a.attempts)}</span>}
                    {/* What it produced, by identifier — never contents. */}
                    {a.result && <span className="tr__result">{a.result}</span>}
                    {a.lastError && <span className="tr__error"> {a.lastError}</span>}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>

      {related && (
        <div className="tr__related">
          <div className="tr__stepHead">
            <span className="tr__type">Everything request {related.requestId} caused</span>
            <button type="button" className="cs__btn" onClick={() => setRelated(null)}>
              Close
            </button>
          </div>
          <pre className="st__pre">{JSON.stringify(related.rows, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * What happened to one email after we handed it over.
 *
 * `delivery_event` has held this since bounce handling shipped, and the only
 * reader was a SQL prompt.
 */
export function MessageTrail({ providerMessageId }: { providerMessageId: string }) {
  const [events, setEvents] = useState<{ type: string; recipient: string | null; occurred_at: string }[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    get<{ events: { type: string; recipient: string | null; occurred_at: string }[] }>(
      `/api/delivery/messages/${encodeURIComponent(providerMessageId)}`,
    )
      .then((b) => live && setEvents(b.events))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [providerMessageId]);

  if (error) return <span className="tr__error">{error}</span>;
  if (!events) return <span className="tr__note">Reading…</span>;
  if (!events.length) {
    return (
      <span className="tr__note">
        The provider has not said anything about this one yet. Delivery, bounces and complaints
        arrive minutes to hours later.
      </span>
    );
  }

  return (
    <ul className="tr__msg">
      {events.map((e, i) => (
        <li key={i}>
          <strong>{e.type.replace('email.', '')}</strong> {e.recipient ? `· ${e.recipient} ` : ''}·{' '}
          {new Date(e.occurred_at).toLocaleString()}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ copilot

interface Run {
  id: string;
  question: string;
  reading: string | null;
  status: string;
  asked_by: string | null;
  created_at: string;
  confirmed_at: string | null;
  plan: unknown;
  model: string | null;
  prompt_version: string | null;
  latency_ms: number | null;
  error: string | null;
}

/**
 * §7.3's required record: model, prompt version, plan, human approval, result
 * and errors, for every question anybody asked.
 *
 * It was written faithfully from the first day and had no reader. An AI audit
 * log nobody can open is a compliance claim rather than a control.
 */
export function AskHistory({ onRerun }: { onRerun: (run: Run) => void }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns(await get<Run[]>('/api/copilot/runs'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <p className="tr__note" role="alert">
        {error}
      </p>
    );
  }
  if (!runs?.length) {
    return (
      <p className="tr__note">
        Nothing asked yet. Every question is recorded here with the model, the prompt version, the
        plan it produced and whether a person approved it.
      </p>
    );
  }

  return (
    <ul className="tr__runs">
      {runs.slice(0, 15).map((r) => (
        <li key={r.id} className="tr__run">
          <div className="tr__runHead">
            <span className="tr__runQ">{r.question}</span>
            <span className="tr__when">{new Date(r.created_at).toLocaleString()}</span>
          </div>
          <div className="tr__meta">
            {r.asked_by ?? 'unknown'} · {r.status}
            {r.confirmed_at ? ' · approved' : ''}
            {r.latency_ms ? ` · ${r.latency_ms}ms` : ''}
            {r.model ? ` · ${r.model}` : ''}
            {r.prompt_version ? ` · ${r.prompt_version}` : ''}
          </div>
          {r.error && <div className="tr__error">{r.error}</div>}
          <div className="mg__rowActions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="cs__btn"
              onClick={() => setOpen(open === r.id ? null : r.id)}
              aria-expanded={open === r.id}
            >
              {open === r.id ? 'Hide the plan' : 'Show the plan'}
            </button>
            {r.plan != null && (
              <button type="button" className="cs__btn" onClick={() => onRerun(r)}>
                Run it again
              </button>
            )}
          </div>
          {open === r.id && <pre className="st__pre">{JSON.stringify(r.plan, null, 2)}</pre>}
        </li>
      ))}
    </ul>
  );
}
