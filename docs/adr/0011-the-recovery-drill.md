# ADR-0011: The recovery drill

**Status:** accepted · **Date:** 2026-09-21

## Context

§20.2's recovery gate: *"Backup restoration and job replay exercises succeed in a non-production environment."*

§10.4 puts numbers behind it — recovery point objective **15 minutes**, recovery time objective **4 hours**, restore drill **quarterly**. Every one of those was a number in a document. Nothing had ever taken a backup of this system, and nothing had ever restored one.

`npm run drill` is the exercise. It is written as a drill rather than a test because the thing being checked is a *procedure*, and a procedure that only works when its author runs it on a quiet machine is not a procedure.

## Decisions

**Prove the backup can be taken, before anything else.** Not assumed. This is the first step because it is the one that failed: see below.

**Compare by content digest, not by row counts.** A restore that silently dropped a jsonb column, lost timezone information, or reordered an array has identical counts. The drill hashes the rendered rows of every table and reports *which* table disagrees. Ordering is by the rendered row rather than by a key, because not every table has a sortable primary key and a digest that depended on physical order would report a false difference after any restore.

**Check that the safeguards survived.** A restored database where `event` accepts an `UPDATE`, or `process_version` accepts one, is an audit hole that no row count would show — and exactly what a restore done by hand, or by a tool invoked with `--disable-triggers`, would produce. The drill tries both writes and requires both to be refused.

**Replay has to replay something.** Two records go into the backup deliberately: one submitted and never drained, whose outbox rows must actually run after the restore; and one drained and then marked undelivered again — the crash window where the effect happened but the queue never learned — which must *not* run twice. Without both, "no duplicated effects" is true of an empty queue and means nothing.

**Suppress delivery first.** A recovery exercise that emails customers is an incident. `suppressDelivery` is called before anything else, on the same reasoning as ADR-0009's finding about the proof suite.

**Nothing touches the source except the drill's own records,** which are cleaned up through the same transaction-local trigger bypass retention uses. One tenant, `drill:recovery`, is reused across runs: a fresh tenant each time would accumulate published versions, and those cannot be deleted — correctly, since immutability is the point. Keeping one tenant was the cheaper answer than weakening an invariant for tidiness.

## What running it found

**The backup command on this machine produced no backup.**

```
pg_dump: error: aborting because of server version mismatch
pg_dump: detail: server version: 17.11; pg_dump version: 16.4
```

pg_dump refuses a server newer than itself. That is correct behaviour and a surprising thing to discover during an incident. The failure that makes a backup policy worthless is usually this one rather than a disk, and it is invisible until somebody tries — which is the entire argument for the drill existing.

The drill now searches for a usable client (`PG_BIN`, then `PATH`, then the container's own binaries, which match by construction) and refuses with the versions it found rather than a generic error. Against Renviq the container fallback does not apply and the answer is a matching client on the machine running the drill; the message says so.

**A digest taken outside the dump's snapshot is not a comparison.**

The drill passed, then failed, then passed, depending on whether the worker happened to be running. pg_dump takes a consistent snapshot of its own; computing the comparison digest on a separate connection reads a *different* moment, so any write in between shows up as the restore disagreeing with the source. A live worker draining the queue is exactly such a write.

The fix is `pg_export_snapshot`: open a repeatable-read transaction on the source, publish its snapshot id, compute the digest inside it, and pass `--snapshot` to pg_dump. Both then see the same database. The transaction has to stay open until the dump finishes, because the snapshot dies with it.

This is also the technique for taking a consistent backup alongside anything else that reads, so it is worth more than the bug it fixed.

**A held row needs its availability cleared, not just its completion.** Simulating the crash window by setting `done_at = null` left `available_at` thirty seconds in the future from the original claim, so the replay was never offered the row and the drill reported it as unfinished. That is not only a bug in the simulation: rows held by a worker that no longer exists come back only after the visibility timeout elapses, so **a restore does not resume instantly even once the database is up.** That delay is part of the RTO rather than separate from it.

**"The queue is empty" is not what a successful replay means.** The first scoped assertion required zero undelivered rows across the whole database, and the seeded workspace legitimately holds a webhook that has exhausted its attempts. The claim that is actually true is "everything replayable was replayed", scoped to the records the drill controls.

## The finding worth carrying

The last step of the drill is not a pass/fail so much as a statement, and it is the one to read aloud in a planning meeting:

> A record submitted after the backup is absent from the restore, along with the message it had already sent. That is the RPO working as designed. The window is not only lost data: those messages reached real inboxes, and the restored system has no memory of having sent them — so it will send them again when the work is redone. **Anything with an external effect inside the window happens twice.**

Fifteen minutes of RPO is fifteen minutes of duplicate emails, duplicate documents, and duplicate webhooks, not fifteen minutes of missing rows. The idempotency ledger protects everything the backup knows about and nothing it does not. Reducing that exposure is a shorter RPO or an effect log kept outside the database, and neither is built.

## Evidence

`docs/recovery-drill.json`, rewritten on every run. From the local container: a 113 KB backup covering 1,168 rows across 23 tables in 0.7s, restored in 1.0s, all 23 tables matching on content hash, both immutability triggers holding, two undelivered outbox rows both completed by the replay with zero duplicated effects, and the post-backup record correctly absent.

Run three times consecutively with the API and worker live, after the snapshot fix: three passes.
