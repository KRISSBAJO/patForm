# ADR-0008: Real documents, real delivery, and what happens when a send is refused

**Status:** accepted · **Date:** 2026-09-21

## Context

§20.1 step 8: *"A PDF packet is generated once and delivered; all attempts and evidence are visible."*

Until now the runtime pretended at both ends. `generate_document` wrote a row with a checksum computed over its *inputs* and no file. `email_log` recorded what would have been sent. The console displayed both as though they had happened, which is a stronger claim than the code could support.

## Decisions

**PDFs are written directly, not rendered by a browser.** `runtime/pdf.ts` lays a small block model — headings, paragraphs, rules, lists, definition rows, tables — onto pages using the standard Helvetica faces, and `htmlToBlocks` maps a controlled HTML template onto it.

§17.3 says buy proven rendering infrastructure, and for arbitrary HTML that is right. What a browser buys is fidelity to CSS a *controlled* template does not use; what it costs is a 300 MB Chromium in every worker and a rendering surface that moves between versions. The subset accepted here is stated in the module rather than discovered by a customer. DOCX is not built, and a template that asks for it produces a document saying so rather than a silently incomplete one.

**The output is deterministic.** No creation timestamp, no object ordering that varies. The checksum is taken over the finished bytes, not the inputs, because "the same record produced the same file" is the claim worth being able to check — and a checksum over inputs cannot detect a template change.

**Email goes through RelyKit,** LogaXP's own transactional API, on the same reasoning as Renviq in ADR-0001: a standard HTTP surface costs no architectural freedom, and the escalation path in an incident is a colleague. `ConsoleProvider` is the default, and delivery requires *two* switches — a key and `EMAIL_PROVIDER=relykit` — because a key left in a `.env` from last week should not quietly turn a test run into real mail in somebody's inbox.

**`action_run.id` is passed as the provider's `Idempotency-Key`.** ADR-0002 said the guarantee stops at the database boundary and named this as the bounded work to fix it. It is now done: a retry that reaches the provider is deduplicated on their side using the same key the ledger uses.

## The distinction that made it work

A failed send is either worth retrying or it is not, and the two must be handled differently:

| | Handling | Why |
|---|---|---|
| 5xx, 429, dropped connection | **throw** | The outbox backs off and tries again. The rollback loses the log row, which is fine — the retry writes another. |
| 4xx: bad address, unverified domain, suppressed recipient | **record and commit** | It will fail identically forever. Retrying buries the real problem under attempt counts, and throwing would roll back the record of the failure. |

The first attempt at this threw on every failure, which rolled back the `email_log` row along with the transaction — so a permanent rejection left no trace at all. That is the same trap as the refusal audit in ADR-0007, and it does not have the same fix: `email_log` has a foreign key to `action_run`, whose row is uncommitted in that very transaction, so it cannot be written on a separate connection. Committing the permanent failure instead is what keeps it on the record.

Because a refused send now commits, the outbox looks clean. Automation health therefore unions failed sends into its failure list — otherwise the console would show nothing wrong while somebody never got their email.

## What this found

The outbox's own error-and-backoff path **had never executed**. Nothing had ever thrown from inside an action, so the first real failure hit a statement where Postgres could not infer a parameter's type and resolved `$2` as an interval. A retry path that has never run is not a retry path.

## Evidence

From `npm run spike`, *Documents are real files, and email actually leaves*: a 2,633-byte PDF checksummed over its own bytes, carrying the employee's name and none of their payroll or identification data — the mapping never named those, and the renderer cannot widen it. Replaying every action produced one document and one welcome email with the packet attached. Each send carried a distinct idempotency key. A permanent rejection was recorded as `failed` with its reason rather than logged as delivered.
