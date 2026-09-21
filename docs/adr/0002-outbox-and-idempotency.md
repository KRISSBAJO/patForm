# ADR-0002: Transactional outbox, with idempotency keyed per occurrence

**Status:** accepted · **Date:** 2026-09-21

## Context

§19 names duplicated or lost outcomes as the risk that destroys trust: *"Lost or duplicated outcomes destroy trust."* An expense paid twice. An offer letter issued twice. A safeguarding email sent twice to the wrong person.

The failure has two halves, and they pull in opposite directions:

- Write the state change first, then send the email — a crash between them loses the email.
- Send the email first, then write the state — a crash between them sends an email for a state change that never happened.

## Decision

**The state change and the intent to act commit in one transaction.** `applyTransition` writes the new state, the event, the timer bookkeeping, and an `outbox` row atomically. There is no window in which one exists without the others.

**Every action carries an idempotency key that identifies an occurrence, not an action:**

```
transitionKey : actionKey : eventId
```

Including the event id is the load-bearing detail. A reminder timer that fires on Monday and again on Wednesday produces two different keys, and therefore two genuine reminders. A worker retrying Monday's delivery produces the same key, and therefore one reminder. Keying on the action alone would silently suppress the second real reminder; keying on the attempt would duplicate the first.

**Every effect table has `action_run_id ... unique`.** That single constraint is what makes the system safe rather than merely careful. Two workers reaching the same action at the same instant produce one `email_log` row and one unique violation — and the violation is treated as success, because somebody else already did it.

## Consequences

- Delivery is **at-least-once with exactly-once effects**. The outbox row may be claimed many times; the row in `email_log` is written once.
- A crashed worker costs one visibility timeout (30s), not a lost action. Its claim expires and another worker takes the row.
- A permanently failing action does not roll back its siblings: each action runs in its own transaction, and the outbox row records `last_error` and backs off exponentially, capped at five minutes.
- The honest limit: these effects are all database rows, so the effect and its bookkeeping commit together. **A real email provider sits outside that transaction.** For SES, Stripe, and webhooks, `action_run.id` must be passed as the provider's own idempotency key, and the provider's dedupe window becomes part of the guarantee. That is a known, bounded piece of work — not something this pattern hides.

## Evidence

From `npm run spike`:

- *Idempotent email under replay* — the outbox row was delivered three times; one email exists. Every replay short-circuited on the idempotency key.
- *Concurrent workers never double-process* — eight workers, forty instances, forty emails, zero duplicated effects.
- *A dead worker loses nothing and duplicates nothing* — a second worker saw nothing at +5s and recovered the row at +45s. One email, not two.
- *A double submission makes one case* — two concurrent submissions, one instance, one receipt, and the second attempt still visible in the event history as `duplicate_submission_ignored`.
