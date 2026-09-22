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
