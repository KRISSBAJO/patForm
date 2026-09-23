import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Telling a person from a script, on the one door with no credential on it.
 *
 * Rate limiting stops one caller making a thousand records. It does not stop
 * a thousand callers making one each, and nothing before this looked at a
 * submission and asked whether a person had filled it in. Two signals do
 * that here, both cheap and both invisible to someone using the form:
 *
 * **A ticket.** Loading the form hands out a signed timestamp. A submission
 * without one never loaded the form; one that arrives within three seconds of
 * it did not fill it in. Nobody types a name, an address and a start date in
 * three seconds, and a script posting straight at the endpoint has no ticket
 * at all.
 *
 * **A trap.** The form carries one extra input, off-screen, hidden from
 * assistive tech and out of the tab order. A person never reaches it. A
 * script that fills every input it finds fills that one too.
 *
 * Neither signal rejects anything. A submission that fails screening is
 * *held*: kept whole, shown to an operator, and turned into a record only if
 * somebody releases it. Password managers do fill hidden inputs, and a
 * three-second submission can be a person pasting from a saved draft — a
 * check that silently discarded them would lose a real application with
 * nobody ever knowing it arrived. What screening does refuse is to let a
 * suspicious submission *act*: no receipt, no approval request, no email to
 * the "manager" address a bot typed in. That last one is the real harm — a
 * form that emails whatever address it is given is a relay for anyone's spam.
 *
 * Not here, and said so: no CAPTCHA, no IP reputation, no scoring of what the
 * answers say. Those catch more and cost real people more, and each is a
 * decision about a third party or about false positives that should be made
 * with somebody's actual traffic in front of it.
 */

/** Faster than this from loading the form to submitting it is not a person typing. */
export const MIN_FILL_MS = 3_000;

/** A ticket from the future is a forged one; allow for clocks a little apart. */
const FUTURE_SKEW_MS = 60_000;

/** The name of the trap input. Plausible, so a script that skips obvious honeypots fills it. */
export const TRAP_FIELD = 'website';

export type HoldReason = 'no_ticket' | 'bad_ticket' | 'too_fast' | 'trap_filled';

export const HOLD_REASON_WORDS: Record<HoldReason, string> = {
  no_ticket: 'sent without loading the form',
  bad_ticket: 'carried a form ticket that was not ours',
  too_fast: `submitted less than ${MIN_FILL_MS / 1000} seconds after the form loaded`,
  trap_filled: 'filled in a field that is hidden from people',
};

export interface Screening {
  hold: boolean;
  reasons: HoldReason[];
  /** From the ticket being issued to the submission, when there was a valid ticket. */
  elapsedMs: number | null;
}

let devSecret: Buffer | null = null;

/**
 * The signing key.
 *
 * Required in production. Without a fixed one each restart signs with a new
 * key, every form open at the time of a deploy carries a ticket the server no
 * longer recognises, and every one of those submissions is held — the
 * deployment works, and quietly routes its real applicants to a queue.
 */
function secret(): Buffer {
  const configured = process.env.FORM_TICKET_SECRET;
  if (configured) {
    if (configured.length < 32) throw new Error('FORM_TICKET_SECRET must be at least 32 characters');
    return Buffer.from(configured);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'FORM_TICKET_SECRET is not set. Without it every restart invalidates the forms people have open, ' +
        'and their submissions are held as suspected spam.',
    );
  }
  devSecret ??= randomBytes(32);
  return devSecret;
}

/** Fails at startup rather than on the first public submission. */
export function assertScreeningConfigured(): void {
  secret();
}

function mac(processKey: string, issuedAt: number, nonce: string): string {
  return createHmac('sha256', secret()).update(`${processKey}.${issuedAt}.${nonce}`).digest('base64url');
}

/** A ticket for one process, issued when its form is served. */
export function issueTicket(processKey: string, now = Date.now()): string {
  const nonce = randomBytes(9).toString('base64url');
  return `${now}.${nonce}.${mac(processKey, now, nonce)}`;
}

/** When a ticket was issued, or null if it is not one this server signed for this process. */
function verify(processKey: string, ticket: string, now: number): number | null {
  const parts = ticket.split('.');
  if (parts.length !== 3) return null;
  const [issued, nonce, given] = parts as [string, string, string];
  const issuedAt = Number(issued);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + FUTURE_SKEW_MS) return null;
  const expected = Buffer.from(mac(processKey, issuedAt, nonce));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return issuedAt;
}

export function screen(args: { processKey: string; ticket?: unknown; trap?: unknown; now?: number }): Screening {
  const now = args.now ?? Date.now();
  const reasons: HoldReason[] = [];
  let elapsedMs: number | null = null;

  if (typeof args.ticket !== 'string' || !args.ticket) {
    reasons.push('no_ticket');
  } else {
    const issuedAt = verify(args.processKey, args.ticket, now);
    if (issuedAt === null) reasons.push('bad_ticket');
    else {
      elapsedMs = Math.max(0, now - issuedAt);
      if (elapsedMs < MIN_FILL_MS) reasons.push('too_fast');
    }
  }

  if (typeof args.trap === 'string' ? args.trap.trim() !== '' : args.trap !== undefined && args.trap !== null) {
    reasons.push('trap_filled');
  }

  return { hold: reasons.length > 0, reasons, elapsedMs };
}
