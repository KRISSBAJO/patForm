# ADR-0001: PostgreSQL on Renviq, modular monolith

**Status:** accepted · **Date:** 2026-09-21

## Context

§10.1 recommends a modular monolith over PostgreSQL, with object storage, Redis, durable jobs, and an outbox. LogaXP operates [Renviq](https://renviq.com), its own managed PostgreSQL cloud.

Using an in-house platform for an in-house product can be a bad trade if it constrains the architecture. It does not here, and it is worth being precise about why.

## Decision

Run on PostgreSQL 17 provisioned by Renviq.

Renviq is managed PostgreSQL, not a database with a proprietary layer on top. Its own positioning is the relevant fact: *"No custom database language. No proprietary client required. Export and migrate with standard tools."* Applications connect over the standard protocol with standard drivers.

So this is not a choice between the architecture the document recommends and a house product. Renviq **is** the recommended architecture, operated by a team down the hall.

## What this buys

- **Operational work is someone else's.** Backups, WAL archiving, PITR, replica lag, recovery drills. §17.3 says buy the database operations; this is that, with the shortest possible escalation path.
- **No lock-in to unwind.** If Renviq is ever wrong for this workload, `pg_dump` moves it. The spike code has no Renviq-specific line in it — `DATABASE_URL` is the entire integration surface.
- **Feedback in both directions.** A demanding first-party workload is good for Renviq, and the escalation path for a production incident is a colleague.

## Constraints this imposes

**PgBouncer.** Renviq lists PgBouncer in its stack. In transaction-pooling mode, session-scoped features break: `LISTEN/NOTIFY`, session advisory locks, and `WITH HOLD` cursors. The runtime therefore uses **none of them**. The job queue is `FOR UPDATE SKIP LOCKED` inside a single transaction, which is pooling-safe. This costs a polling interval instead of a push notification, and that is an acceptable price for portability.

**Connection budget.** The free plan allows 20 connections. Workers must share a bounded pool rather than opening one per job. The spike runs a pool of 16 and eight concurrent workers without saturating it.

**Not a queue.** PostgreSQL is a perfectly good queue at this scale and a bad one at very large scale. The outbox is deliberately a plain table with an index, so it can be moved behind a dedicated broker later without changing the callers.

## Alternatives rejected

| Option | Why not |
|---|---|
| Microservices from the start | §10.1 is right. Network failure, tracing, and deployment cost before any usage justifies them. |
| A managed queue (SQS, Redis Streams) now | Two systems to keep consistent, and the outbox exists precisely so the state change and its actions commit together. Add a broker when queue depth demands one, not before. |
| A durable-execution engine (Temporal and similar) | Worth a spike later, per §17.3. Right now it would add an operational dependency to prove a pattern that took ~400 lines of SQL and TypeScript. |
| A different managed Postgres | No technical reason. Renviq is standard Postgres with a shorter incident path. |

## Evidence

`npm run spike` against PostgreSQL 17.11. All eight proofs pass, including eight concurrent workers with zero double-processing. Nothing in the runtime depends on where the database is hosted: the same command runs against a local container or a Renviq connection string, changing only `DATABASE_URL`.
