# ADR-0010: The operational copilot, and exporting a record before deleting it

**Status:** accepted · **Date:** 2026-09-21

## Context

Two acceptance steps, and they are the last two.

§20.1 step 9: *"The operator asks which records are overdue and sends a confirmed reminder to authorized targets."*

§20.1 step 11: *"An administrator exports the record and audit history and then applies the configured retention action."*

Step 9 is the one with teeth. §7.1 requires "a permission-filtered query service; no raw model database access" and, for actions, "preview, explicit confirmation, per-record authorization, idempotency, audit". §6.4 adds "permission checks per record, an impact preview, rate limits, and result report". §7.4 gates it: **"100 percent of executed actions match the confirmed plan."**

## Decisions

**The model emits a typed plan, never SQL.** `src/copilot/plan.ts` is a closed set of filters — `overdue`, `state`, `has_open_task`, `answer`, and nine others — with no free text that reaches the database. `src/copilot/compile.ts` resolves every key against the blueprint and writes every identifier in the emitted statement itself; values go in as parameters and keys are used only as parameters to `data ->> $n`. A model that can emit `WHERE` can emit `WHERE tenant_id <> $1`. A model that can only emit `{ kind: 'overdue' }` cannot.

This is the blueprint boundary again, and it matters more here. The records being queried contain text that respondents typed, so **the model is reading attacker-controlled input every time it answers a question about a record.** The planning step is therefore given the process *schema* and not one answer.

**"Overdue" compiles to the SLA the blueprint declares.** Not a hours-in-state guess, not a stored column: the compiler expands it into `(state = X and state_entered_at < deadline_X)` for each state that declares one, which is the same definition the console tiles and the timers use. A state with no SLA can never be overdue, and a process with no SLA at all warns rather than silently matching everything.

**A restricted answer cannot be used as a filter.** "Which records have a national insurance number starting QQ" reads restricted data one yes/no at a time and never displays it, so redaction on the way out never gets a turn. Confidential fields remain filterable; the ceiling is `restricted`. This is `QRY004`, and it is an error rather than a warning.

**An action cannot carry a message.** `send_reminder` names a template from the blueprint and nothing else — no body, no recipient override. The schema refuses both. A model-written message sent to a respondent under the workspace's name is a different product with a different risk, and §7.3 wants generated text touching employment decisions labelled and reviewed.

**The confirmation is bound to the plan by a digest.** This is what makes §7.4's gate enforceable rather than asserted. The preview resolves the matching instance ids, authorizes each one, and hashes `(plan, action, sorted ids)`. Execution takes that digest back, works from the **stored id list** rather than re-running the query, and re-authorizes each record because a role can be revoked in between.

So a record that becomes overdue thirty seconds after the preview is not swept up. That is the correct behaviour rather than a limitation: the operator confirmed eleven records, not "whatever matches when I press the button". A preview also cannot be spent by anyone but the person who took it, or it would be a stored capability.

**Idempotency reuses the engine's own path.** `Engine.runActionOnce` goes through the same `executeAction` the worker uses, keyed `copilot:<runId>`, so the effect tables' unique constraints and the delivery log behave identically and a second confirmation sends nothing. A parallel send path would have been a second thing to get right.

**The export is a read, so redaction applies.** An administrator who also holds a process role that hides payroll fields gets an export without them — and the bundle **names** what was withheld rather than quietly producing a shorter file. `redact()` substitutes the string `[redacted]`, which is right on screen and wrong in a file where it reads as data, so the placeholders are lifted into a `withheld` list.

**The export is itself an event.** Taking a copy of somebody's personal data is exactly the act an audit exists to record.

## What running it found

**A reminder addressed to a role reached nobody, and the log said it was sent.**

`resolveParty` turned `{ role: 'hr_approver' }` into the literal string `role:hr_approver`. That string was written into `email_log.recipients`, where it reads as a delivered reminder — and filtered out of the provider's `to` list one line later. Every role-addressed message was therefore logged against the role and handed to the provider with nobody on it.

The comment justifying it said the spike had no directory and left fan-out to a notification service. `membership` and `actor` had become a directory, and the notification service was never built.

The database carried its own proof, from a live send before the fix:

| recipients | provider | status | failure |
|---|---|---|---|
| `{role:hr_approver}` | resend | failed | `422 missing_required_field Missing 'to' field.` |
| `{sam@example.test}` | console | queued | — |

The provider rejected it for having no recipient. Nothing in Patform noticed, because the log row looked fine.

The fix is narrower than it first appears. `role:X` is a correct *identity* and the policy engine reads it deliberately as "anyone currently holding this role" — that is what `completableBy: 'assignee'` promises, and resolving it to one person's address would make a task uncompletable the moment they left. So tasks and approvals keep the marker; only email resolves it, through a new `resolveRecipients`. **A party is an identity; a recipient is an address.** A role nobody holds now writes a `skipped` log row saying so, instead of leaving no trace.

This is the fifth instance of *present in review, absent at runtime*, and the second where the code contradicted a comment sitting directly above it.

**Recording the export as an event made the export unreproducible.** The second export's history contained the first export's event, so no two exports of an unchanged record hashed the same — and the checksum exists precisely so a file you were handed can be checked against the system. `record_exported` entries are now carried in the bundle, where a reader can see who took a copy, and excluded from the digest. Nothing about the record itself is excluded.

**Five queries on one client is not parallelism.** The export used `Promise.all` over one pooled client. A pg client is one connection and one statement at a time; that is a deprecation warning today and a lost query later. The concurrency was imaginary.

## What is not built

Named rather than implied. `assign` and `change_state` exist in the action schema and are refused by the compiler with `ACT001` — visible in the type rather than discovered when somebody asks. There is no scheduled or recurring plan. The rate limit is twenty questions an hour per actor and two hundred records per action, both fixed rather than configurable. The export is JSON or CSV; documents are listed with their checksums but their bytes are not included.

## Evidence

From `npm run spike`:

*The operator asks what is overdue and sends a reminder that matches what they confirmed* — "overdue" matched 3 of 3, each past the SLA its state declares. A plan naming a state that does not exist was refused (`QRY002`), and so was filtering on a restricted answer (`QRY004`). An admin of another workspace asked the identical question and saw their own record and none of these — the plan cannot name a tenant, so the scope comes from who is asking. A stale digest was refused, and so was spending somebody else's preview. The confirmed run sent 3; a replay sent 0.

*An administrator exports the record with its history, and only then is it deleted* — the bundle carried the full history of a finished record, both decisions with their reasons, messages and documents. An approver could not export at all. An administrator who is also a hiring manager had three fields withheld and named. A second export of an unchanged record produced the same checksum. Retention then deleted one instance and eight events, in that order, because afterwards there is nothing left to export.

Driven through the console against the seeded workspace: *"Remind everyone whose approval is overdue"* produced the plan `{ kind: 'overdue', is: true }` ordered by hours in state, and the reading *"Because each reminder can only use one template, I have read this as the records sitting overdue with the hiring manager… overdue HR reviews need a separate run"* — the model explaining the action language's own limitation unprompted. Two records, both late at 60h, preview naming `priya@example.test` for each, then 2 sent of 2, two `manual_action` events on the records' histories, and one `copilot_run` row carrying provider, model, prompt version, latency, targets and confirmation.
