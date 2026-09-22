/**
 * Rate limiting on the one door a stranger can reach.
 *
 * §12.3. The public form is served at a guessable URL with no credential in
 * front of it — that is the point of it — so the only thing standing between a
 * published process and an unbounded write loop is this file.
 *
 * It reuses the counter the API keys already use (`takeRateTokenShared`),
 * which is Redis-backed when `REDIS_URL` is set and per-process otherwise, and
 * **fails open** when the counter is unreachable. That decision is already
 * made and is the right one: a limiter that refuses everything when its cache
 * is down has turned a cache outage into an outage.
 *
 * What is *not* here, named rather than implied: spam control. A limiter stops
 * one caller making a thousand records. It does not stop a thousand callers
 * making one each, and it cannot tell a real submission from a plausible
 * fabricated one. That needs a challenge, reputation, or content scoring, and
 * none of them are built.
 */

import type { IncomingMessage } from 'node:http';
import { takeRateTokenShared, type RateVerdict } from './keys.js';

/**
 * How many proxies sit in front of this process.
 *
 * `x-forwarded-for` is a request header, which means it is written by whoever
 * is calling. Trusting it unconditionally makes per-caller limiting free to
 * defeat — send a random address on every request and every request is a new
 * caller. Refusing to read it at all is just as wrong behind a load balancer:
 * every request then appears to come from the balancer, and one person's
 * budget is everybody's.
 *
 * So it is counted, not trusted. `TRUST_PROXY=1` means one hop, and the
 * caller is the last-but-one entry — the one the nearest proxy observed and
 * therefore could not have forged. The default is 0: no proxies, use the
 * socket, believe nothing in the headers.
 */
const TRUSTED_HOPS = Math.max(0, Number(process.env.TRUST_PROXY ?? 0) || 0);

export function callerFor(req: IncomingMessage): string {
  const socket = req.socket.remoteAddress ?? 'unknown';
  if (TRUSTED_HOPS === 0) return socket;

  const header = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chain.length) return socket;

  /*
   * Count back from the end. The rightmost entry was added by the proxy
   * closest to us, so with N trusted hops the first address we did not
   * observe ourselves — and the first one the caller could have written — is
   * at length - N. Anything further left is theirs to invent.
   */
  const index = chain.length - TRUSTED_HOPS;
  return chain[index] ?? chain[0] ?? socket;
}

export interface IntakeLimit {
  /** What the budget is for, in the header and in the log. */
  scope: string;
  perMinute: number;
  /** A second, slower window, where one exists. */
  perHour?: number;
}

/*
 * The budgets.
 *
 * Reading a form and checking answers are cheap and happen a lot — a form with
 * conditional pages calls `check` on most edits, and a limit that a careful
 * respondent can hit is a limit that breaks the product rather than protecting
 * it. Submitting writes a record, sends mail and starts a workflow, so it is
 * the one worth being mean about.
 */
export const INTAKE_LIMITS: { test: RegExp; method: string; limit: IntakeLimit }[] = [
  { method: 'POST', test: /^\/api\/forms\/[a-z0-9_]+\/submit$/, limit: { scope: 'submit', perMinute: 5, perHour: 20 } },
  { method: 'POST', test: /^\/api\/forms\/[a-z0-9_]+\/draft$/, limit: { scope: 'draft', perMinute: 30 } },
  { method: 'POST', test: /^\/api\/forms\/[a-z0-9_]+\/check$/, limit: { scope: 'check', perMinute: 120 } },
  { method: 'GET', test: /^\/api\/forms\/[a-z0-9_]+\/draft$/, limit: { scope: 'resume', perMinute: 60 } },
  { method: 'GET', test: /^\/api\/forms\/[a-z0-9_]+$/, limit: { scope: 'read', perMinute: 60 } },
];

export function limitFor(method: string, pathname: string): IntakeLimit | null {
  return INTAKE_LIMITS.find((r) => r.method === method && r.test.test(pathname))?.limit ?? null;
}

export interface IntakeVerdict {
  ok: boolean;
  retryAfterSeconds: number;
  headers: Record<string, string>;
}

/** The narrower of the two windows decides, and says which it was. */
function tighter(a: RateVerdict & { shared: boolean; window: string }, b?: RateVerdict & { shared: boolean; window: string }) {
  if (!b) return a;
  if (!a.ok) return a;
  if (!b.ok) return b;
  return a.remaining <= b.remaining ? a : b;
}

/**
 * Takes a token for one public request.
 *
 * Keyed on the caller **and** the process, so one person hammering one form
 * does not spend the budget of somebody filling in a different one, and so a
 * limit reported in a header is a limit about the thing that was asked for.
 */
export async function takeIntakeToken(
  caller: string,
  processKey: string,
  limit: IntakeLimit,
  now = Date.now(),
): Promise<IntakeVerdict> {
  const perMinute = {
    ...(await takeRateTokenShared(`intake:${limit.scope}:${processKey}:${caller}`, limit.perMinute, 60, now)),
    window: '60s',
  };
  const perHour = limit.perHour
    ? {
        ...(await takeRateTokenShared(
          `intake:${limit.scope}:h:${processKey}:${caller}`,
          limit.perHour,
          3600,
          now,
        )),
        window: '3600s',
      }
    : undefined;

  const decided = tighter(perMinute, perHour);
  return {
    ok: decided.ok,
    retryAfterSeconds: decided.retryAfterSeconds,
    headers: {
      'x-ratelimit-limit': String(decided.limit),
      'x-ratelimit-remaining': String(decided.remaining),
      'x-ratelimit-reset': String(Math.ceil(decided.resetAt / 1000)),
      'x-ratelimit-window': decided.window,
      'x-ratelimit-scope': `${limit.scope}:${decided.shared ? 'shared' : 'process'}`,
      ...(decided.ok ? {} : { 'retry-after': String(decided.retryAfterSeconds) }),
    },
  };
}

/** The process a form path names, for keying the budget. */
export function processKeyFrom(pathname: string): string {
  return pathname.split('/')[3] ?? 'unknown';
}
