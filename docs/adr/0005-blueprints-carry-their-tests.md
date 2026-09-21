# ADR-0005: A blueprint carries its own scenarios, and the runtime runs them

**Status:** accepted · **Date:** 2026-09-21

## Context

§7.2 lists `Tests` as a section of the blueprint: happy path, rejection, missing data, timeout, duplicate, permission. BLD-05 requires drafts to support preview with test records before publication.

The easy reading is that these are documentation for the builder. That would waste them.

## Decision

Scenarios are executable, and they run against **the same engine that runs production** — not a simulator, not a preview mode with its own code path.

`runScenarios` publishes the blueprint into a scratch tenant, drives it through the declared steps with a clock the scenario controls, and asserts on the resulting state, emails, documents, and open tasks. `TEST001` makes all six kinds a publish gate.

A scenario names only the answers it cares about; the runner fills the remaining required fields with type-valid placeholders. The exception is a `missing_data` scenario, where the gap is the point. Without this, every scenario would have to restate twenty answers and would stop being readable — and unreadable tests get deleted.

## Consequences

- "Test mode" is not a feature to build later. It exists, and it is the production code path.
- A generated blueprint arrives with executable acceptance criteria. That is what makes AI generation safe to ship: the model proposes a process *and* the cases that prove it, and the runtime checks the second against the first.
- Scenarios double as regression tests for the platform itself. Twenty-one currently run on every spike.
- **The taxonomy has a gap.** The six kinds have no name for "a valid submission that takes a different legitimate route". A volunteer who has not done the foundation class is not missing data, not a rejection, and not the happy path. It is currently filed as a second `happy_path`, which works but reads oddly. Worth adding an `alternate_path` kind in v0.2.
- Placeholder filling can mask a real omission: a scenario that forgets an answer still passes. Acceptable for now, because the compiler separately proves every required field is reachable on a page (`REF003`).

## Evidence

21 of 21 scenarios pass across three processes. Writing them is what surfaced the safeguarding gap documented in [failure-cases.md](../failure-cases.md) — something no amount of reading the diagram would have found.
