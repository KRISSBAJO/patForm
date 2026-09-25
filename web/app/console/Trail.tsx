'use client';

/**
 * What actually happened to one record, and what the copilot has been asked.
 *
 * The observability work in §20.2 made every action traceable by request,
 * event, job, attempt and result — and the only way to read any of it was a
 * command-line tool. An audit trail that needs a terminal is an audit trail
 * the people who need it cannot use.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';

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
              <span className="tr__type">{step.type === 'record_note_added' ? 'Note added' : step.type}</span>
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

interface RunSummary {
  id: string;
  question: string;
  status: string;
  asked_by: string | null;
  created_at: string;
}

interface Run extends RunSummary {
  reading: string | null;
  confirmed_at: string | null;
  plan: unknown;
  action_plan: unknown | null;
  result: unknown | null;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  latency_ms: number | null;
  error: string | null;
}

interface RunPage { runs: RunSummary[]; total: number; page: number; pageSize: number }

function runState(status: string): { label: string; icon: IconName; tone: string } {
  switch (status) {
    case 'answered': return { label: 'Answered', icon: 'done', tone: 'done' };
    case 'previewed': return { label: 'Ready to review', icon: 'trail', tone: 'review' };
    case 'executed': return { label: 'Action completed', icon: 'done', tone: 'done' };
    case 'failed': return { label: 'Failed', icon: 'reject', tone: 'issue' };
    case 'refused': return { label: 'Could not answer', icon: 'reject', tone: 'issue' };
    default: return { label: status.replace(/_/g, ' '), icon: 'trail', tone: 'review' };
  }
}

/**
 * §7.3's required record: model, prompt version, plan, human approval, result
 * and errors, for every question anybody asked.
 *
 * It was written faithfully from the first day and had no reader. An AI audit
 * log nobody can open is a compliance claim rather than a control.
 */
export function AskHistory({ processKey, onRerun, onDetailChange }: { processKey: string; onRerun: (run: Run) => void; onDetailChange: (open: boolean) => void }) {
  const [data, setData] = useState<RunPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Run | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const listScroll = useRef(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ process: processKey, page: String(page), pageSize: '10', summary: '1' });
    if (query) params.set('q', query);
    if (status) params.set('status', status);
    setLoading(true);
    setError(null);
    setData(null);
    void get<RunPage>(`/api/copilot/runs?${params}`).then((next) => {
      if (live) setData(next);
    }).catch((err: Error) => {
      if (live) setError(err.message);
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [processKey, page, query, status]);

  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    setSelected(null);
    setDetailError(null);
    setDetailLoading(true);
    void get<Run>(`/api/copilot/runs/${encodeURIComponent(selectedId)}`).then((run) => {
      if (live) setSelected(run);
    }).catch((err: Error) => {
      if (live) setDetailError(err.message);
    }).finally(() => {
      if (live) setDetailLoading(false);
    });
    return () => { live = false; };
  }, [selectedId]);

  useEffect(() => { onDetailChange(Boolean(selectedId)); }, [selectedId, onDetailChange]);

  useEffect(() => {
    if (selectedId) requestAnimationFrame(() => window.scrollTo(0, 0));
  }, [selectedId]);

  const backToList = () => {
    setSelectedId(null);
    requestAnimationFrame(() => window.scrollTo(0, listScroll.current));
  };

  if (selectedId) {
    const state = selected ? runState(selected.status) : null;
    return <div className="ah__detailPage">
      <button type="button" className="ah__back" onClick={backToList}><Icon name="back" /> Back to questions</button>
      {detailLoading ? <p className="ah__empty" role="status">Loading question…</p> : detailError ? <p className="ah__empty" role="alert">Could not load this question: {detailError}</p> : selected && state ? <>
        <div className="ah__detailHeader">
          <span className={`ah__icon ah__icon--${state.tone}`} aria-hidden="true"><Icon name={state.icon} /></span>
          <div><span className={`ah__status ah__status--${state.tone}`}>{state.label}</span><h3>{selected.question}</h3><p>Asked by {selected.asked_by ?? 'Workspace member'} · {new Date(selected.created_at).toLocaleString()}</p></div>
        </div>
        <section className="ah__detailSection"><h4>Answer</h4><p>{selected.reading ?? 'No answer was saved for this question.'}</p>{selected.error && <p className="ah__error">{selected.error}</p>}</section>
        {selected.plan != null && <section className="ah__detailSection"><div className="ah__detailSectionHead"><h4>Review the plan</h4><button type="button" className="cs__btn" onClick={() => onRerun(selected)}><Icon name="search" /> Review again</button></div><p>Rechecks this saved plan against current records. Any proposed action still needs your confirmation.</p><details className="ah__technical"><summary>Technical plan</summary><pre className="st__pre">{JSON.stringify(selected.plan, null, 2)}</pre></details></section>}
        {selected.result != null && <section className="ah__detailSection"><h4>Action result</h4><pre className="st__pre">{JSON.stringify(selected.result, null, 2)}</pre></section>}
        <section className="ah__detailSection"><h4>Audit details</h4><dl className="ah__auditGrid"><div><dt>Status</dt><dd>{state.label}</dd></div><div><dt>Model</dt><dd>{selected.model ?? 'Unavailable'}</dd></div><div><dt>Provider</dt><dd>{selected.provider ?? 'Unavailable'}</dd></div><div><dt>Prompt version</dt><dd>{selected.prompt_version ?? 'Unavailable'}</dd></div><div><dt>Response time</dt><dd>{selected.latency_ms == null ? 'Unavailable' : `${selected.latency_ms} ms`}</dd></div>{selected.confirmed_at && <div><dt>Confirmed</dt><dd>{new Date(selected.confirmed_at).toLocaleString()}</dd></div>}</dl></section>
      </> : null}
    </div>;
  }

  return (
    <div className="ah">
      <div className="ah__tools">
        <form className="ah__search" onSubmit={(event) => { event.preventDefault(); setPage(1); setQuery(search.trim()); }}>
          <Icon name="search" />
          <label className="ask__srOnly" htmlFor="ask-history-search">Search recent questions</label>
          <input id="ask-history-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search questions…" />
          <button type="submit" className="cs__btn">Search</button>
        </form>
        <label className="ask__srOnly" htmlFor="ask-history-status">Filter activity</label>
        <select id="ask-history-status" className="ah__filter" value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}>
          <option value="">All activity</option>
          <option value="answered">Answered</option>
          <option value="previewed">Ready to review</option>
          <option value="executed">Action completed</option>
          <option value="issues">Issues</option>
        </select>
      </div>
      {loading ? <p className="ah__empty" role="status">Loading activity…</p> : error ? <p className="ah__empty" role="alert">Could not load activity: {error}</p> : !data?.runs?.length ? (
        <p className="ah__empty">{query || status ? 'No questions match these filters.' : 'No questions yet for this process. Ask one above to get started.'}</p>
      ) : (
        <ul className="ah__list">
          {data.runs.map((r) => {
            const state = runState(r.status);
            return <li key={r.id} className="ah__item"><button type="button" className="ah__rowButton" onClick={() => { listScroll.current = window.scrollY; setSelectedId(r.id); }} aria-label={`View details for ${r.question}`}>
              <span className={`ah__icon ah__icon--${state.tone}`} aria-hidden="true"><Icon name={state.icon} /></span>
              <span className="ah__rowText"><strong>{r.question}</strong><span className="ah__summary"><span className={`ah__status ah__status--${state.tone}`}>{state.label}</span><span>{r.asked_by ?? 'Workspace member'}</span></span></span>
              <time dateTime={r.created_at}>{new Date(r.created_at).toLocaleString()}</time><span className="ah__chevron" aria-hidden="true">›</span>
            </button></li>;
          })}
        </ul>
      )}
      {!loading && data && data.total > 0 && <div className="ah__pager">
        <span>Showing {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total}</span>
        <div><button type="button" className="cs__btn" disabled={page <= 1 || loading} onClick={() => setPage((n) => n - 1)}>Previous</button><span>Page {page} of {Math.ceil(data.total / data.pageSize)}</span><button type="button" className="cs__btn" disabled={page * data.pageSize >= data.total || loading} onClick={() => setPage((n) => n + 1)}>Next</button></div>
      </div>}
    </div>
  );
}
