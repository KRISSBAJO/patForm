# ADR-0003: Timers belong to an occupancy of a state, not to the state

**Status:** accepted · **Date:** 2026-09-21

## Context

§6.5 asks for relative deadlines and reminders in the tenant timezone, stored canonically in UTC. The subtle part is not the storage. It is what happens when a record leaves a state with a pending timer, and what happens when it comes back.

Three behaviours have to be distinguishable:

1. A manager who has not replied in 48 hours gets a reminder.
2. A manager who replied in 3 hours gets nothing, ever, including on day 30.
3. A record sent back for clarification and then returned to the manager starts a **fresh** 48 hours, not the remainder of the old one.

## Decision

A timer row is keyed on `(instance_id, transition_key, entered_at)`, where `entered_at` is the moment the record entered that state on that occasion.

- **Entering** a state schedules every timer transition leaving it, due at `entered_at + afterHoursInState`.
- **Leaving** cancels every unfired timer whose `entered_at` matches the occupancy being left.
- **Re-entering** — including a self-loop, which is how reminders are written — gets a new `entered_at`, so the clock restarts.
- **Firing** re-checks that the instance is still in that state with that same `entered_at`, so a timer claimed just as the record moved is discarded rather than applied to the wrong state.

Claiming uses the same `FOR UPDATE SKIP LOCKED` statement the outbox uses, so a timer fires once even with several schedulers running.

## Consequences

- Behaviour 3 falls out for free. Re-entry restarts the clock, which is what both a reminder and an SLA mean.
- Repeating reminders are expressed as a timer transition looping a state onto itself. No separate recurrence concept is needed, and `FLOW007` still rejects a self-loop that has neither a timer nor a condition.
- `entered_at` in the key means a record that entered, left, and re-entered within the same millisecond would collide. Real state changes are separated by at least a transaction commit, so this has not been observed — but if sub-millisecond re-entry ever appears, the key should gain the event id.
- Timers are polled, not pushed. `LISTEN/NOTIFY` would be lower latency and is unavailable through a transaction-mode pooler (ADR-0001). At 48-hour granularity the polling interval is irrelevant; if minute-level SLAs are ever sold, this needs revisiting.

## Evidence

From `npm run spike`, *Timers fire once, on time, and are cancelled on exit*: nothing fired at +47h, exactly one firing at +49h, and nothing on a second sweep at the same instant. One reminder was sent. When the manager approved at +50h, the pending timer for that occupancy was cancelled rather than left to fire into a state the record had already left.
