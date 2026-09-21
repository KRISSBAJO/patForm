# ADR-0004: Immutability and append-only history are enforced by the database

**Status:** accepted · **Date:** 2026-09-21

## Context

§9.2: *"A published process version is immutable. Every instance records the version that governs it."*
§6.4: *"Corrections append history; destructive overwriting of audit evidence is prohibited."*

Both are usually implemented as a rule the application layer agrees to follow. That holds until someone writes a migration script, a support engineer fixes a record by hand, or a new endpoint forgets. The failure is silent, and what it rewrites is the rules a finished decision was made under.

## Decision

Enforce both in PostgreSQL, with `BEFORE UPDATE OR DELETE` triggers that raise.

- `process_version` cannot be updated or deleted. Publishing adds a row.
- `event` cannot be updated or deleted. Corrections are new events.

A support engineer with a `psql` prompt and good intentions gets an error, not a silent rewrite.

## Consequences

- Every instance pins `process_version_id`. A record that started under v1 is decided under v1 even after v3 is live, which is what makes §9.2's "a new version may affect only new instances by default" true rather than aspirational.
- Fixing a genuinely broken published version means publishing a corrected one and, if in-flight records must move, running an explicit migration with the impact report §9.2 requires. That is deliberately more work than an `UPDATE`.
- Retention deletion needs a documented path that suspends the trigger under an audited procedure. **This is not yet built**, and it is required before any retention claim is made to a customer. Recorded as open.
- The triggers cost a negligible amount per write and nothing per read.

## Evidence

From `npm run spike`, *A published version cannot be edited, and a live record keeps the version it started under*: an `UPDATE` against a published version was refused by the database. An `UPDATE` against the record's event history was refused too. A second version was published, and the in-flight record continued under the first.
