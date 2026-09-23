/**
 * Something the caller got wrong and can fix.
 *
 * Distinguished from a plain Error because the API maps unknown errors to 500,
 * and a password three characters too short reported as "internal error" is
 * wrong twice: the person cannot tell it was their mistake, and it logs as an
 * outage that nobody can reproduce. These are the only endpoints a stranger
 * can reach, so it matters most here.
 *
 * It lives in its own module rather than in `workspace.ts` because account
 * recovery needs it too, and importing it from there would make the two
 * modules circular — which works in ESM right up until somebody moves a call
 * to the top level.
 */
export class InvalidInput extends Error {}

/** Asked for something that is not there, or not any more: a discarded draft. The API answers 404. */
export class NotFound extends Error {}

/**
 * Somebody else got there first.
 *
 * Two people editing one draft used to be last-write-wins: the second save
 * replaced the whole blueprint, and the first person's work disappeared
 * without either of them being told. This is what the save path throws
 * instead, and it carries enough to say *who* and *when* — "someone else
 * changed this" sends a person to find out who, which is the question the
 * refusal could have answered.
 *
 * `held` — another member is editing it right now and their lease is live.
 * `stale` — it was saved after you last loaded it, so your copy is behind.
 * `published` — it has already become a version and is no longer a draft.
 */
export class DraftConflict extends Error {
  constructor(
    readonly kind: 'held' | 'stale' | 'published',
    message: string,
    readonly detail: { by?: string; at?: string; revision?: number; version?: number } = {},
  ) {
    super(message);
  }
}

/**
 * A public form link that names nothing, or no longer names one thing.
 *
 * `ambiguous` is the old `/f/<process_key>` link once a second workspace
 * publishes the same key: answered with a message and 410, never by picking
 * one of them. See form-links.ts.
 */
export class FormLinkError extends Error {
  constructor(
    readonly kind: 'not_found' | 'ambiguous',
    message: string,
  ) {
    super(message);
  }
}
