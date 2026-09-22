import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * The request identifier, and the thread that carries it.
 *
 * §20.2's observability gate: *"Every workflow action has traceable request,
 * event, job, attempt, and result identifiers."* Four of those five already
 * existed — `event.id`, `outbox.id`, `outbox.attempts`/`action_run.attempts`,
 * and `action_run.id` with its `result`. The request was missing entirely, so
 * there was no way to ask "what did that submission cause?" and get an answer
 * rather than a reconstruction from timestamps.
 *
 * It is held in async context rather than threaded through every signature.
 * That is a real trade — an implicit value is harder to follow than an
 * argument — and it is the right one here, because the alternative is adding a
 * parameter to `submit`, `decide`, `completeTask`, `applyTransition`,
 * `executeAction` and `performEffect` that none of them use for anything
 * except passing it on. A value every function must carry and no function may
 * read is exactly what ambient context is for.
 *
 * It crosses one boundary deliberately. The worker runs minutes later in
 * another process, so the request that *caused* the work is stamped onto the
 * outbox row and read back when the job runs. The chain is therefore
 * request → event → job → attempt → result, and the first link survives a
 * restart, which is the only reason it is worth having.
 */

export interface TraceContext {
  /** Stable for one inbound request, and for everything it causes. */
  requestId: string;
  /** Where the request came in: an API route, a worker loop, a CLI. */
  source: string;
  actorId?: string;
  tenantId?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** A request id. Short enough to read aloud on a support call. */
export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * Accepts a caller's id, or issues one.
 *
 * §11.1 asks for request IDs on the API. A client that sends one gets it back
 * and sees it on everything its call caused, which is what makes a support
 * conversation short. It is not trusted for anything but correlation, so the
 * only checks are shape and length — an id is a label, never an authority.
 */
export function requestIdFrom(header: string | string[] | undefined): string {
  const given = Array.isArray(header) ? header[0] : header;
  if (given && /^[\w.:-]{8,64}$/.test(given)) return given;
  return newRequestId();
}

export function withTrace<T>(context: TraceContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

/**
 * The request id to stamp on a row.
 *
 * Returns a placeholder rather than null when there is no context: a row that
 * says `unattributed` is a fact about how the work started, and a null is a
 * question. Both are honest; only one is searchable.
 */
export function currentRequestId(): string {
  return storage.getStore()?.requestId ?? 'unattributed';
}

// ------------------------------------------------------------------ logging

type Level = 'info' | 'warn' | 'error';

/**
 * One structured line per thing that happened.
 *
 * §10.1 asks for structured logs and "tenant-safe support diagnostics". The
 * second half is the constraint that shapes this: a log line may carry
 * identifiers and never answers. A record's data is the respondent's, and
 * putting it in a log moves it somewhere with different retention, different
 * access control and no redaction — so the fields here are ids, keys, counts
 * and durations, and `detail` is for text this codebase wrote.
 */
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const trace = storage.getStore();
  const line = {
    at: new Date().toISOString(),
    level,
    event,
    requestId: trace?.requestId,
    source: trace?.source,
    tenantId: trace?.tenantId,
    actorId: trace?.actorId,
    ...fields,
  };
  for (const key of Object.keys(line)) {
    if ((line as Record<string, unknown>)[key] === undefined) delete (line as Record<string, unknown>)[key];
  }
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else console.log(text);
}

/** Whether structured logs are emitted at all. Off by default: the CLIs are read by people. */
export const LOGGING_ON = process.env.PATFORM_LOG === 'json';

export function logIfEnabled(level: Level, event: string, fields?: Record<string, unknown>): void {
  if (LOGGING_ON) log(level, event, fields);
}
