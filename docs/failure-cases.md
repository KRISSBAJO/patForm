# Failure cases found while hand-compiling

This is the output that §23 week 2 asks for: "define the process blueprint schema and compile three real processes by hand" → "schema v0.1 and failure cases."

Three processes were compiled by hand against schema v0.1: church worker onboarding (§4.1), employee onboarding (§4.3), and expense approval (§4.4). What follows is what broke, in the order it broke, and what was done about it.

The short version: **the schema was never the hard part. Every real problem was a rule about how the parts relate to each other.** That is worth knowing before anyone budgets a builder UI.

---

## Faults the compiler caught in my own work

These are mistakes made while writing the three reference blueprints. Each one looked correct on the page.

### 1. An SLA with nothing behind it

`hr_review` in employee onboarding declared `slaHours: 48`. Nothing fired at 48 hours. The dashboard would have shown records breaching an SLA that the process had no mechanism to act on — a number that makes the operator feel informed and changes nothing.

**Rule added:** `OPS006` (warning). A state with an SLA and no timer transition out of it.

**Why warning, not error:** an SLA used purely for reporting is a legitimate choice. The builder should have to see it, not be stopped by it.

### 2. A blocking task that blocked nothing

Church worker onboarding created `verify_safeguarding` as a `blocking: true` task when the role involved under-18s. Nothing was triggered by its completion. The record moved to the department leader as soon as the *class* check finished.

A volunteer applying for children's ministry could have reached approval with no safeguarding check, and the blueprint would have looked correct in review — the task was there, it said "blocking", and it appeared in the record.

**Rule added:** `BLOCK001` (error). A blocking task that no transition waits for.
**Rule added:** `BLOCK002` (error). A transition waiting for a task nothing creates.

**Fix to the process:** a real `safeguarding_check` waiting state between the class check and the leader, with the transition out of it gated on the check being confirmed, and a declined path when it is not.

This is the single most valuable thing that came out of the exercise. It is a safeguarding failure that a builder UI would render as a tidy diagram.

### 3. A reminder addressed to nobody

Expense approval used one `approver_reminder` template for both the manager chase and the finance chase, addressed to `{ assignee: "current" }`. No transition in that process ever assigns the record. The reminder would have been queued, "sent", and delivered to an empty recipient list — and the delivery log would show it as handled.

**Rule added:** `ASSIGN001` (error). A message or task addressed to the current assignee in a workflow that never assigns.

**Fix to the process:** two templates, one to the manager's email field, one to the finance approver role.

---

## Gaps in the model that hand-compiling exposed

These are places where the representation could not say what the process needed to say. They are open decisions, not bugs.

### G1. There is no "all blocking tasks are done" trigger — **fixed**

Employee onboarding provisions equipment and accounts in parallel, then completes. The only available trigger was `task_completed` for one named task, so the blueprint chained them: finishing equipment *created* the accounts task, and finishing accounts completed the record.

Worse than the original note said. The accounts task did not exist until equipment was done, so IT could not do them in the other order or at the same time — which is how they are actually done.

**Fixed** with a `tasks_completed` trigger naming its set, and the reference process rewritten to fan out and join.

The original recommendation here was a `join` state type waiting for "all blocking tasks". That was rejected on second look: an inferred set is whatever `create_task` actions happened to run, so a task created under a condition that did not hold would either hang the record forever or be skipped silently — and which one you got would depend on the data. That is the shape of fault this document is mostly about.

Naming the set costs one thing: you can add a fifth task and forget to join it, and the record completes with work still open. So the compiler closes it — **BLOCK003** refuses a join that leaves out a blocking task created in the same state. That is the trade: explicit in the blueprint, and the one gap explicitness opens is a build error.

Two runtime decisions worth recording:

- **A task that was never created does not satisfy the join.** Of the two available wrong answers, a record that waits is visible — it sits in the state, the queue shows it, the state's SLA fires — and a record that completes with work outstanding is invisible. BLOCK002 makes the never-created case a build error, so this should be unreachable from a published blueprint.
- **The instance row is locked before the check.** Two people finishing two tasks at the same instant serialise: the first sees the other still open and does nothing, the second sees both done and moves the record. Without the lock both would read "still open" and the record would sit in a state with no work left in it.

Proof 26 checks both tasks open together, that neither alone releases the record, that either order completes it, and that the join fires once rather than once per task. The blueprint carries a scenario for the reverse order — which is a scenario that could not be written under the chain, because the second task did not exist yet.

### G2. Approvals cannot express "any two of these four"

`mode` is `single`, `sequential`, or `any_of`. Real approval policies include quorums ("any two directors") and conditional escalation ("finance too, but only over £5,000, and only outside the approved vendor list").

The threshold case is currently handled by splitting into two transitions with different `when` conditions, which works and is readable. Quorum has no expression at all.

**Recommendation:** do not add quorum for MVP. Do confirm with design partners that nobody needs it, because retrofitting it touches the approval runtime.

**Built** after all, with `mode: "quorum"` and `required`. Retrofitting it did touch the approval runtime, as predicted — and found that the runtime had never implemented `sequential` either (entry 81).

### G3. The expression model cannot reach into repeating groups

`sum` and `count` over a repeating group work. Anything else does not: "any line item over £200", "more than three items", "any item in a restricted category" are all inexpressible.

Expense approval wants the first of these for a real policy. It is currently not modelled.

**Recommendation:** add `any` and `all` quantifiers over a repeating group in v0.2. They are a contained addition and the runtime cost is bounded.

### G4. Timers are relative to state entry only — **fixed**

`afterHoursInState` was the only timing primitive, so a hire approved in March and one approved the day before they start got the same reminder schedule. Onboarding wanted to chase equipment three days before `start_date` and could not say it.

**Fixed** with `relativeTo` naming a date field and `offsetHours` moving off it, negative for before.

The original note called the data-changing problem "a real design question, not a schema one", and it was right. Three answers came out of building it.

**Editing the date reschedules.** A deadline hung off a date is only as current as that date; move a start date forward a week and every deadline hanging off it has moved. `updateRecord` reschedules the current occupancy's timers, leaving a timer that has already fired alone.

**A date timer fires once per record; a duration timer fires once per occupancy.** The difference is what each measures. "Forty-eight hours after arriving" is about how long you have been here, so coming back restarts it — that is what makes a nudge a nudge. "Three days before the start date" is a day in the calendar, and the calendar does not move because the record came back. Without this distinction a date timer on a self-loop is an infinite loop: it fires, re-enters the state, reschedules to the same moment which is now past, and fires again. The chase in employee onboarding is exactly that shape, so this was not hypothetical.

**A date that is not there yet means no deadline, not a guessed one.** A deadline computed from a missing date is a deadline on the wrong day, and the record would be chased or expired against it. TIME002 warns when the date is one the respondent may leave blank, because that is also how a deadline silently never happens.

Proof 28 gives two records the same arrival instant and start dates five months apart, checks they get different deadlines three days before each, moves one date and checks the deadline follows, then drains twice past it and checks it fired once.

**Found by the proof, not by the feature.** The first version passed while changing nothing: `hr_admin` held the `edit` capability and listed no `editableFields`, so the runtime refused every field and returned `refused` rather than throwing. `editableFields` absent means "may change nothing", which is the safe reading of an omission and makes the capability decorative. **SEC012** now warns, and it fired on two of the three reference processes and all eighty-eight packs.

### G5. Nothing expresses "this person may not approve their own request" — **fixed**

Expense approval addresses the manager approval to `{ field: manager_email }`, which the claimant types in. Nothing prevented a claimant entering their own address, and the blueprint could not describe the control that would.

**Fixed** with `Approval.notTheSubmitter`, enforced in the policy engine beside every other refusal.

Three things came out of building it that were not in the original note.

**The flag belongs on the approval, not the party.** The sketch here put it on the party — `{ field: "manager_email", notTheSubmitter: true }`. How an approver is *addressed* is a different question from whether the submitter may be one: put it on the party and an approval addressed two ways needs the flag twice and can carry it once.

**"The submitter" was a guess.** The runtime answered "who submitted this" by taking the first field of type `email`. That was right in all three reference processes and all eighty-eight packs, by luck of declaration order — reorder the fields and every message addressed to the submitter goes to their manager instead. A control that bars the submitter and guesses which address that is reads as enforced in review and bars the wrong person at runtime, which is worse than no control. `data.submitterField` now names it, and **SEC010** refuses to publish a process that bars the submitter without saying who they are.

**`two_person_decision` counted approvals, not people.** The category control audited `approvals.length >= 2`, which two approvals addressed to the same role satisfies, and which one person holding that role satisfies alone. It now requires two approvals, addressed to different parties, with the submitter barred from all of them. Finance requires it, and turning it on immediately found `mileage_claim`: a Finance pack with one approval and no amount field, so one line manager could sign off any distance on their own. A mileage claim is a money claim; it asks for the amount now.

Proof 27 submits a £450 claim with the claimant's own address in the manager field — which is what somebody defrauding this would actually do — and checks the refusal, that the record stays where it was, and that a different person named the same way still decides it normally. That last half matters: a control that refuses everybody is not separation of duties, it is a broken process.

### G7. Values an operator fills in later had nowhere to live

**Found by the first live AI generation, not by hand-compiling.**

Asked to model incident reporting, the model produced a triage severity, an investigation reference, a set of follow-up actions and a closure flag — all of them things somebody fills in *during* the process, not things the reporter types on the intake form. The schema had only one place to put a field, so the compiler warned six times that they would never be collected.

Three hand-compiled processes never hit this, because when you write a blueprint by hand you unconsciously avoid the shapes the schema makes awkward. A generator has no such instinct, which is exactly why it found the gap.

**Fixed:** a field may declare `setBy: "respondent" | "operator" | "system"`. Only respondent fields must appear in the experience. `REF003` skips the other two.

### G8. A permission scenario could not test submission

The `attempt` step accepted view, edit, approve, export and operate — so "can a stranger start this process?" was the one permission question a scenario could not ask. gpt-4o-mini tried to write it and failed the schema.

**Fixed:** `submit` is now an assertable action.

### 4. The whole permission model was decorative

Blueprints declared roles, capabilities, `hiddenFields` and `editableFields`. The compiler validated every one of them and refused to publish a blueprint whose permissions were incoherent. Three processes passed their permission scenarios.

The runtime checked nothing. `decide()` applied an approval from any caller in any tenant; `completeTask()` the same; field-level visibility was enforced nowhere. The permission scenarios that passed were asserting against a lookup table in `scenarios.ts` — the test harness — not against the engine.

Same shape as the safeguarding task above, one layer up: **present in review, absent at runtime**, and worse than an obviously missing control because a review finds the missing one.

**Fixed** in [ADR-0007](adr/0007-authorization-in-the-runtime.md): one policy engine, deny by default, every mutation through it, and `engine.can()` so scenarios exercise the production path.

### 5. The audit record of a refusal rolled back with the refusal

The first run of the new authorization proof failed on its last assertion: four refusals happened correctly and one reached the audit table.

`require_` wrote the denial on the caller's client and then threw. The throw rolled the transaction back, taking the audit record with it — so a refused action left no trace, which is the exact failure the table had just been added to prevent.

**Fixed:** refusals are written on their own connection, outside any caller transaction.

Worth naming the general shape, because it will recur: **anything written to explain why a transaction failed cannot live inside that transaction.**

### 6. An approver who could not approve

Naming an approver went through `checkParty`, which asked whether the role exists. It never asked whether that role holds the `approve` capability — and the policy engine refuses `approve` to a role that does not, so an approval naming one waits forever.

Nothing reads as wrong. The role is real, the approval is wired up, the transition fires, the scenarios that do not exercise that approver pass. It is only visible from the policy engine's side.

Found by using the builder: changing an approval to sequential and picking `hr_admin` — which holds `administer`, `operate` and `edit`, everything except `approve` — compiled clean.

**Fixed:** **SEC009**, which also refuses a respondent role named as an approver, since `authorize()` rejects `approve` for a respondent principal before it looks at any role at all.

That is the fourth of these, and the pattern is now the thing to watch for rather than any individual instance: **a control that is present in review and absent at runtime.** The first three were the safeguarding task nothing waited for, the permission model above, and `editableFields` that no code path could reach.

### 7. A read that could not see its own write

`openDraft` inserted a draft inside a transaction and then called `loadDraft(pool, …)` to return it. That takes a second connection out of the pool, and a second connection cannot see an uncommitted row. It compiled, it type-checked, and it failed on the first click with `no such draft`.

Same family as case 5, from the opposite direction: there the write had to escape the transaction; here the read had to wait for it. The general shape is worth stating as **a pool is not a connection** — any helper taking a `Pool` is a different session from the transaction that called it.

**Fixed:** the transaction returns an id and nothing else; the draft is read after it commits.

### 8. The proof suite was sending real email

The Engine's constructor carried a comment saying it defaulted to the console provider "so a local database never delivers real mail to a real person because somebody forgot to unset a variable". It did not. Naming a provider in the environment was enough, and the harnesses read the same `.env` as the server.

So once `EMAIL_PROVIDER=resend` was configured, `npm run spike` began firing forty live sends per run at addresses under `example.test`. It surfaced as a concurrency proof reporting 19 emails for 40 instances — the provider was rejecting and throttling them, and the proof was reading that as a concurrency fault.

The guard cannot live in the Engine, which has no way to tell a proof run from a real one. It lives in the harness.

**Fixed:** `suppressDelivery(reason)` at the top of `spike`, `seed` and `eval` unsets the variable and says on stdout that it did. The Engine's comment now describes what the code does rather than what it was supposed to do.

Third general shape, and the one that connects all of these: **a comment claiming a safeguard is not a safeguard.** Two of the eight faults here were found because the code disagreed with a sentence written directly above it.

### 9. A reminder addressed to a role reached nobody, and the log said it was sent

`resolveParty` turned `{ role: 'hr_approver' }` into the literal string `role:hr_approver`. That string went into `email_log.recipients`, where it reads as a delivered reminder — and was filtered out of the provider's `to` list one line later. Every role-addressed message was logged against the role and handed to the provider with nobody on it.

The comment justifying it said the spike had no directory and left fan-out to a notification service. `membership` and `actor` had become a directory, and the notification service was never built.

The database held its own proof, from a live send before the fix:

| recipients | provider | status | failure |
|---|---|---|---|
| `{role:hr_approver}` | resend | failed | `422 missing_required_field Missing 'to' field.` |
| `{sam@example.test}` | console | queued | — |

The provider rejected it for having no recipient. Nothing here noticed, because the log row looked fine.

**Fixed,** and more narrowly than it first appears. `role:X` is a correct *identity*: the policy engine reads it as "anyone currently holding this role", which is what `completableBy: 'assignee'` promises and what stops a task becoming uncompletable the moment one person leaves. So tasks and approvals keep the marker and only email resolves it. The distinction worth carrying: **a party is an identity; a recipient is an address.** A role nobody holds now writes a `skipped` row saying so.

Fifth instance of *present in review, absent at runtime*, and the second where the code contradicted a comment directly above it.

### 10. Recording the export made the export unreproducible

Exporting a record appends a `record_exported` event, which is right — taking a copy of somebody's personal data is what an audit is for. But the second export's history then contains the first export's event, so no two exports of an unchanged record hash the same, and the checksum exists precisely so a file can be checked against the system that made it.

**Fixed:** `record_exported` entries are carried in the bundle, where a reader can see who took a copy, and left out of the digest. Nothing about the record itself is excluded.

The general shape: **a feature that observes something must not change what it observes.** Worth remembering for anything else that writes an audit trail about reads.

### 11. Five queries on one client is not parallelism

The export fetched history, approvals, tasks, messages and documents with `Promise.all` over a single pooled client. A pg client is one connection and one statement at a time, so this is a deprecation warning today and a lost query later. The parallelism was imaginary.

**Fixed:** awaited in sequence.

### 12. The backup command produced no backup

```
pg_dump: error: aborting because of server version mismatch
pg_dump: detail: server version: 17.11; pg_dump version: 16.4
```

pg_dump refuses a server newer than itself. Correct behaviour, and a surprising thing to meet during an incident. The failure that makes a backup policy worthless is usually this one rather than a disk, and it is invisible until somebody actually tries — which is the whole argument for a drill rather than a runbook.

**Fixed:** `npm run drill` searches for a usable client and refuses with the versions it found, rather than a generic error.

### 13. A digest taken outside the dump's snapshot is not a comparison

The drill passed, then failed, then passed, depending on whether the worker happened to be running. pg_dump takes a consistent snapshot of its own; computing the comparison digest on a separate connection reads a *different* moment, so any write in between looks like the restore disagreeing with the source.

**Fixed** with `pg_export_snapshot`: open a repeatable-read transaction, publish its snapshot id, digest inside it, and pass `--snapshot` to pg_dump. The transaction stays open until the dump finishes, because the snapshot dies with it.

Worth more than the bug: this is the technique for a consistent backup alongside anything else that reads.

### 14. A held row needs its availability cleared, not just its completion

Simulating a crash by setting `done_at = null` left `available_at` thirty seconds ahead from the original claim, so the replay was never offered the row.

That is not only a flaw in the simulation. Rows held by a worker that no longer exists come back only after the visibility timeout elapses, so **a restore does not resume instantly even once the database is up.** That delay belongs inside the RTO, not beside it.

### 15. The focus ring was invisible on every dark surface

`:focus-visible` used `--green` (#14663f). Against paper that is 6.42:1; against the sidebar (#131a17) it is **2.53:1**, under WCAG 1.4.11's 3:1 for a focus indicator. A keyboard user could not see where they were in the console or builder navigation.

axe passed the page. **It does not test focus indicator contrast at all** — which is the general point about automated accessibility checking: it found two violations across these four flows, and six of the eight real problems came from reading.

**Fixed** with a `--focus-ring` token that becomes mint on dark surfaces. Mint is 10.1:1 there and 1.6:1 on paper, so it is exactly the wrong colour everywhere else — hence a scoped token rather than a changed one.

### 16. Contrast was checked against the wrong surface

`--on-dark-5` and `--on-dark-6` were verified against `--ink` and passed. The account block uses `--ink-raised` and the current nav item uses `#23302a`, and on those the same colours fall to 4.37:1 and 3.70:1.

The habit worth keeping: **a colour token is safe on the lightest surface it lands on, not on the one it was tested against.** Both now clear 4.5:1 everywhere they are used.

### 17. `aria-modal="true"` made a promise the behaviour did not keep

The builder's three dialogs had `role="dialog" aria-modal="true"` and no focus management whatsoever. Tab walked straight out into the page underneath — still rendered, still clickable, and no longer visible to the person using it. Escape did nothing.

axe passed them, because the attributes were correct. This is the accessibility form of the pattern this file keeps recording: **present in the markup, absent in the behaviour.** It is the sixth instance.

**Fixed** in `web/app/useDialog.ts`. Three things went wrong while fixing it, each worth its own note:

- `useEffect(..., [onClose])` with an inline arrow meant the effect tore down on every parent render, restoring focus mid-life to a control inside the dialog. The handler lives in a ref now and the effect runs once.
- The opener could not be found by reading `document.activeElement` on mount, because the button that opened the dialog **disables itself while the request runs** and a disabled button drops focus to `<body>` immediately. The last element focused outside a dialog is tracked continuously instead.
- Focusing the dialog on mount worked in a real browser and failed under the headless check, because the parent re-renders the instant the in-flight flag clears. That is a race, not a test artifact — it can happen to a person. Focus is set again on the next frame.

### 18. Two things only a mouse could do

The Ask results opened a record on row click with no keyboard equivalent (2.1.1), and its input had a placeholder where a label belonged — no accessible name, and no visible one after the first keystroke.

### 19. `npm run spike` is not safe to run beside a worker

One proof failed once and passed on every rerun. `resetSchema` drops tables between proofs, and a live worker polling the same database queries them mid-drop — the worker log shows `relation "outbox" does not exist`.

Not fixed, recorded: the harnesses assume they own the database. The drill solved its own version of this with an exported snapshot, which is the right shape of answer, and the spike would need the same treatment or a database of its own.

### 20. A restricted field readable by everybody

The data map's first run reported that `accessibility_notes` — a workplace-adjustment disclosure, correctly classified restricted and correctly justified — was hidden from **none** of the four internal roles. The IT operator setting up a laptop could read it.

Nobody had decided that. `hiddenFields` was set on the payroll fields and never on this one, and no rule asked. SEC007 checks *why* a restricted field is collected; nothing checked *who can see it*, which is the other half and the half a data map exposes.

**Fixed** in the reference blueprint, and now `SEC010`. A warning rather than an error, because a process whose only internal role is HR has nobody to hide anything from — it should be answered, not obeyed.

Six confidential fields also recorded no reason for being collected. The map flagged those too; the compiler already warned about restricted ones (SEC007) and the threshold turned out to be set one class too high.

### 21. An audit row that recorded the wrong number

`erasure_run` is written before the deletion, so the account of what was removed outlives the data — the same ordering retention uses, and right for the same reason. It passed `0` for the event count, because the deletion that produces the number had not happened yet. The operator was told "2 events"; the audit row said zero.

**An account with the wrong number in it is worse than none, because it looks authoritative.** Fixed by counting before writing.

### 22. A second implementation of identity

The CSV importer computed its own duplicate key: the identity fields joined with a null byte. Postgres text cannot hold a null byte, so it crashed — which was lucky, because had it not, the value would simply have been a different string from the one `identityFor` produces, no import would ever have detected a duplicate, and nobody would have known why.

The same trap as writing a second validator, and avoided everywhere else in this codebase by deliberate effort. `validateAnswers` has one implementation for exactly this reason; identity did not, because it was a private function nobody had needed twice yet.

**Fixed:** `identityFor` is exported and the importer calls it. One way of deciding whether two records are the same person.

### 23. A parameter beside an `interval`, again

```
operator does not exist: timestamp with time zone < interval
```

`$4 - interval '7 days'`: Postgres resolves the parameter against the interval on the right and decides it is one. This is the fault ADR-0008 recorded in the outbox backoff, met again in the abandonment metric, because nothing stops it recurring — it is a property of how Postgres infers parameter types, not a mistake either place made.

**The habit:** any parameter adjacent to an `interval` states its type. `$4::timestamptz`.

### 24. An endpoint asking for a scope nobody can hold

`POST /records` required the `submit` scope. No workspace role grants `submit` — it is the *respondent's* capability, held by people the form is about rather than by members. So a key could never have been issued with it and the endpoint was unreachable.

Found by the scope-intersection check refusing to issue the key, which is the check working. Creating records on a workspace's behalf is `edit`, which is what the CSV importer had already reasoned for itself.

**Fixed,** and a test now asserts every route's scope is one some workspace role actually grants.

### 25. Webhooks had never been sent

`call_webhook` inserted a `webhook_delivery` row with status `delivered` and made no HTTP request anywhere. A hundred of them sat in the seeded workspace saying delivered.

This is the seventh instance of *present in review, absent at runtime* and the most consequential, because of where the evidence pointed: a customer integrating against it would have seen success in the console, silence in their own system, and no reason to suspect us. §11.2 describes six behaviours and none of them existed.

**Fixed** with real delivery through the worker, signing, rotation with overlap, backoff into a terminal dead letter, inspect and replay. The proof uses a real `node:http` server that verifies the signature itself — a mock would have proved that the code calls `fetch`, which was never the question.

### 26. A default of `now()` is unclaimable by anything on another clock

Deliveries were inserted with `available_at` defaulting to wall-clock `now()`, and the claim query asks for `available_at <= $now`. Every caller that passes its own time — a replay, a backfill, the proof suite — found nothing to claim, because the row was due in their future.

**Fixed:** `available_at` comes from the event. That is also simply more correct — a delivery is due as of the thing that caused it, not as of the insert.

The general shape, and it cost three rounds of debugging in one sitting: **anything that takes a `now` must take it everywhere, including in defaults.** A single `now()` left in SQL makes the whole path untestable against a simulated clock, and the symptom is silence rather than an error.

### 27. A check that could only pass by accident

The webhook proof asserted that an event with no subscriber leaves a `no_subscriber` row — by counting those rows across the whole table. The proof registers an endpoint before it sends anything, so there were never going to be any, and the count was picking up rows from elsewhere.

Same family as the vacuous replay check in the recovery drill. **Fixed** by switching the endpoint off and asserting on that record specifically.

### 28. Five stale worker processes, because a kill command matched nothing

Throughout this session I restarted the worker with a `wmic ... | grep -i "worker.ts"` filter. `wmic`'s CSV output wraps and truncates long command lines, so the filter matched nothing and killed nothing — while every restart added another process. Five were running at once, several on code from hours earlier.

It explains three symptoms that each looked like something else at the time: a delivery row recorded with `provider: resend` after the environment had moved to RelyKit, a proof that failed once and passed on rerun, and a Slack endpoint that kept receiving the raw envelope after the renderer was written.

**The general shape, and it is the oldest one in this file:** a command that silently matches nothing looks exactly like a command that had nothing to do. `taskkill` on an empty list exits cleanly. Nothing in the output distinguishes "stopped 5" from "stopped 0".

Replaced with a PowerShell `Get-CimInstance` filter that prints each process it stops.

### 29. A model will not declare uncertainty just because you ask

BLD-02 wants a generated blueprint to carry its assumptions and open decisions. Adding `intent.assumptions` and `intent.openDecisions` to the schema, and a paragraph in the prompt asking for them, produced a complete process for "Something for handling requests from staff. Manager signs off." with **both arrays empty**.

The fields were in the JSON schema handed to the model. The instruction was explicit. It skipped them anyway, because something optional at the end of a long instruction competes with everything before it, and because a confident-looking answer is what the rest of the prompt rewards.

**Fixed** by making it a gate rather than a request: a generated blueprint declaring no assumptions is repaired through the same loop as a compiler error. It then produced seven assumptions and five open decisions — that it had read "requests" as equipment rather than leave, that it invented a £1,000 finance threshold, that it collects no attachments.

The gate lives in the pipeline, not the compiler, because a *hand-written* blueprint legitimately declares none: a person decided everything deliberately. The same claim means different things depending on who made it.

### 30. Validation reported as an outage

`createWorkspace` threw a plain `Error` for a password three characters too short, and the API maps unknown errors to 500. So the one endpoint a stranger can reach answered "internal error" to a mistake they could have fixed in two seconds — wrong twice over, because it also logged as an outage nobody could reproduce.

**Fixed** with an `InvalidInput` type the API maps to 400. Worth noting that every other runtime module still throws plain errors for this class of thing; it matters most here because these are the only unauthenticated write paths.

### 31. Three emails pointing at pages that did not exist

Invitation, verification and reset mail all went out with links to `/join/…`, `/verify/…` and `/reset/…`. The Next.js app served none of those routes. Every proof passed: the tokens were minted, hashed, single-use and correctly refused — and the person holding the email would have got a 404.

This is the seventh instance of the same shape in this project: **a control that is present in review and absent at runtime.** The safeguarding task nothing waited for, the permission model only checked in tests, `editableFields` unreachable, SEC009's unapprovable approver, `aria-modal` with no focus trap, the restricted field hidden from nobody, webhooks that were never sent — and now a link to nowhere.

**Fixed** by building the three pages and adding them to the accessibility scan, which is also what makes the regression visible: the scan mints live tokens, so a route that stops existing fails it.

**Generalisable:** when a system emits a reference to something — a URL, a file path, a queue name — something automated has to follow that reference. The proof that the reference was *generated correctly* is not the proof that it *resolves*.

### 32. A colour token that was safe on one surface

The forgot-password and resend controls reused `.cs__linkBtn`, which is mint green. That class was written for the dark sidebar, where mint is right. Both new uses are on paper, where mint is 1.6:1 — invisible.

The §20.2 gate had already established that a token has to be checked against every surface it appears on, and the check was not repeated when the class was reused rather than the colour.

**Fixed** with an explicit `--onLight` variant. **Generalisable:** a token is not safe; a token *on a surface* is safe. Reusing a class moves it to a new surface.

### 33. A password left the transaction that created the account

`createWorkspace` originally sent nothing. Adding verification put a network call in reach of the transaction that creates the tenant, the actor and the credential. Holding a transaction open across a provider call turns a slow provider into a lock timeout, and a rollback after a delivered email cannot be undone.

**Fixed** by sending after the commit, in a `.then` on the transaction rather than inside it. The same applies to the invitation. **Generalisable:** this is the counterpart to the rule already in this file that *anything written to explain why a transaction failed cannot live inside that transaction* — anything that reaches outside the database cannot live inside one either.

### 34. A helpful `\` that was not there

Several edits to `.mjs` and `.ts` files were made through a shell heredoc, and the heredoc collapsed `\r` to a real carriage return before Python saw it — so `split(/\r?\n/)` was written into the file as a regex containing an actual newline, which is a syntax error. Three attempts to fix it re-introduced it, because each fix went through the same heredoc.

**Fixed** by building the backslash from `chr(92)`. **Generalisable:** when the same edit fails the same way three times, the tool doing the editing is a suspect, not just the edit.

### 35. A comment that named the gap, for months

`email_log.status` carried this, and it was accurate every day it was there:

> *§6.6: the log distinguishes queued, sent, delivered where supported, bounced, complained and failed. Anything past `sent` arrives by webhook from the provider and is not wired yet.*

An honest comment is better than a silent gap, and it is not a substitute for the thing. The console showed "sent" for messages that had bounced an hour earlier, and the system kept writing to mailboxes that do not exist.

**Generalisable:** a comment that says a control is missing ages into a comment that everybody has read past. Anything written down as *not wired yet* wants a date or a test that fails.

### 36. A proof that proved nothing, because the answers were identical

The delivery proof submitted a second record to the same address to show that a suppressed recipient stops receiving mail. It passed the "nothing was sent" assertion immediately — because identity is `(personal_email, start_date)`, the second submission was recognised as a *duplicate*, no instance was created, and no action ever tried to send anything.

Nothing was sent, and the suppression had nothing to do with it.

**Found** because the proof also asserted on the `skipped` log row, which did not exist. **Generalisable:** an assertion that something did *not* happen is worth nothing unless something else proves the attempt was made. This is the fourth vacuous check in this file, and every one of them was a negative assertion.

### 37. An explainer that described a different screen

The console's "WHAT THIS SCREEN IS" panel described *My work* — on the dashboard, on the records browser, on the copilot, and now on a deliverability page it had never heard of. It had been wrong on four views since the second of them shipped, and it reads as confidently on the wrong page as on the right one.

**Fixed** by making it follow the view. **Generalisable:** copy that explains a screen is part of the screen. A fixed string in a shared layout is a claim that every view is the same view.

### 38. The front door was not connected to the building

The landing page's "Sign in" linked to `#lighthouse` — an anchor further down the same page. "Apply to the program" linked to `#lighthouse` from inside the `#lighthouse` section, so clicking it did nothing at all. There was no sign-up page: `POST /api/workspaces` had existed since IAM-01, was proved, documented and reachable by curl, and nothing in the web application called it.

So a visitor could read the whole marketing site and had no way into the product. Meanwhile the burger menu on narrow screens opened nothing, and the links it would have revealed are hidden below 900px — a phone had no navigation whatsoever.

Reported by the user, not by any check here. This is the eighth instance of **a control that is present in review and absent at runtime**, and the most expensive, because every other one is behind this one.

**Generalisable:** an endpoint is not a feature until something a person can reach calls it. The proofs, the tests and the API documentation all passed on a product nobody could sign up for — every one of them started from a session that the harness created directly.

### 39. Four contrast failures that had never been looked at

Auditing the landing page for the first time found nine violations across four rules, all pre-existing:

| Element | Foreground on background | Ratio |
|---|---|---|
| `.row__num` | `#b0a99a` on `#ffffff` | 2.33 |
| `.ai .eyebrow`, `.checked__arrow span` | `#a8d6bc` on `#14663f` | 4.33 |
| `.proposal__tag` | `#a8d6bc` on `#297450` | 3.50 |
| `.footer__base p` | `#6e7d74` on `#131a17` | 4.08 |

The first is a *border* token (`--rule`) used as text. The middle two are the same mint on two different greens, which is entry 32 again: a token is not safe, a token *on a surface* is safe — and the token has to clear the **lightest** surface it appears on, not the darkest.

**Generalisable:** the accessibility gate audited "the four flows in the gate", and the landing page was in none of them because no flow started there. A page that is not in a flow is a page nobody checks.

### 40. A shorthand that silently reset a gutter

The narrow-screen menu's links sat flush against the edge of the phone. The element carried both `.shell` (which sets `padding-inline: var(--gutter)`) and a new rule using the `padding` shorthand for vertical spacing — and the shorthand reset the horizontal padding to zero.

**Generalisable:** the `padding` and `margin` shorthands are not additive with the longhands; they overwrite the axis you did not mention. Use `padding-block` when you mean vertical.

### 41. The attempt counter that rolled back with the failure

The MFA challenge incremented `attempts` as the first statement of its verification transaction, with a comment explaining that doing it first was the point. Every wrong code then threw, the transaction rolled back, and the increment went with it. The cap never fired: six digits had unlimited guesses, which is not a second factor, it is a thirty-second delay.

This is **entry 1 in this file** — *anything written to explain why a transaction failed cannot live inside that transaction* — committed again with a comment asserting the opposite.

**Found** because the proof asserted the sixth attempt was refused *for exhausting attempts*, not merely refused. A proof that only checked "six wrong codes were all rejected" would have passed.

**Fixed** by claiming the attempt on the pool, in one statement that both increments and enforces the cap:

```sql
update mfa_challenge set attempts = attempts + 1
 where token_hash = $1 and used_at is null and expires_at > $2 and attempts < $3
 returning id, actor_id, attempts
```

**Generalisable:** a comment claiming a safeguard is not a safeguard — also already in this file, as the lesson from a different bug. Two rules I had written down, broken together, in code whose comments cited both.

### 42. Enrolling and signing in at the same instant

The MFA proof confirmed enrolment with a code and then signed in with the same code, and was refused. The replay guard was right: confirming spends that window like any other use.

The first instinct was to move the proof to the next window and carry on. The better answer was to assert the refusal — anybody who can see the enrolment code can otherwise spend it once more, and nothing else in the proof covered that.

**Generalisable:** when a proof trips over a control, the question is whether the control is wrong or the proof is describing a case worth keeping. Stepping around it silently discards a test the system just offered you for free.

### 43. Thirty endpoints with no way in

Asked whether the product was "child's play", the honest check was to diff the console's API surface against the paths the interface actually calls. **Thirty of seventy-two endpoints had nothing calling them.** Among them: every `members` route, every `invitations` route, every `forms` route, CSV import, API keys, webhooks, OAuth grants, the data map and retention.

The three things the user could not find were all built and all unreachable:

| Question | What existed | What reached it |
|---|---|---|
| How is a record created? | A public form at `/f/<key>`; a submission starts the record | Nothing in the console mentioned or linked it |
| Where do forms come from? | The builder, at `/builder` | Not linked from the console at all |
| How does an organization bring people in? | Invitations, roles, deactivation, session revocation | No page |

This is the ninth instance of **a control present in review and absent at runtime**, and by far the largest — it was most of the product. Every one of the twenty-four proofs passed throughout, because each starts from a session and a tenant the harness builds directly; none of them opens a browser and tries to get from the front door to a published process.

**Generalisable:** counting endpoints is not counting features. The cheap check that would have caught this at any point is the one run here — list the routes, list the paths the client calls, and subtract. It takes a minute and it does not need a person to notice something feels thin.


### 44. Twenty-six more, and a measuring tool that lied twice

The reachability check reported thirty unreachable endpoints. Wiring the obvious ones dropped it to twenty-six, and then the number stopped moving in a way that did not match the code — the People page was plainly calling `/api/members/:id/deactivate` while the tool insisted nothing was.

Two bugs in the tool, both of which hid **exactly the routes it exists to check**:

1. **A template hole holding a verb.** The check replaced `${...}` with a uuid and a key and tested those against the route. `/api/members/${id}/${active ? 'deactivate' : 'reactivate'}` has the *verb* in a hole, so nothing matched. Fixed by matching from the route's side: each route produces one concrete sample, each call site becomes a pattern with its holes widened.
2. **A query-string stripper eating a ternary.** `path.replace(/\?.*$/, '')` ran before the holes were replaced, so `${active ? 'a' : 'b'}` was truncated at its `?` and left half a path.

A third was subtler: a hole was widened to `[^/]+`, requiring at least one character. `/export${csv ? '?format=csv' : ''}` evaluates to nothing at all, so the export route — which the record panel had been calling all along — was reported unreachable. `[^/]*`.

**Generalisable:** a tool that measures whether work was done is itself work that can be wrong, and its failure mode is the quietest one available — it reports a number, and a number always looks like a measurement. The three bugs here all produced *over*-reporting, which is the safe direction; the same code one character different would have reported everything fine.


### 45. A first screen whose default tab was empty

The builder's "New process" dialog opens on **From a pack**, said *"No packs available"*, and left Install disabled with no explanation. Nothing had ever published a pack: the catalogue table, the publish function, the install flow and the pack browser were all built and the seed never called any of it.

So the first thing anybody does in the builder was a dead end with a greyed-out button, and the only way to discover the other two routes was to notice the tabs.

Three fixes, and the third is the general one:

- The seed publishes three built-in packs, each from a blueprint that compiles rather than from a written description of one.
- The dialog moves off an empty tab instead of sitting on it, and distinguishes *not asked yet* from *asked, and there are none* — they were the same empty array.
- **The disabled button says what is missing.** A disabled control with no reason is a dead end with a cursor on it, and the person cannot tell whether they have done something wrong or the feature is broken.

**Generalisable:** a default is a claim that this is the common case. A default that is empty on a fresh install is the worst possible first impression, and it is invisible to everybody whose database already has data.

### 46. Half the product was relit and half was not

The console's restyle was scoped to `.cs`, so the builder kept the old dark rail and the display serif. Two halves of one product with two navigations read as two products — and it was reported the same way, as "this still carries the old layout".

**Generalisable:** scoping a theme to one route is right for keeping marketing and application apart, and wrong the moment the application has more than one route. The check is not "does this page look right" but "do the pages a person moves between look like the same thing".


### 47. A modal that stopped scaling at six

The "New process" dialog held the pack catalogue. With three packs that was fine; with fifty-eight it was unusable — a modal cannot be linked to, cannot be filtered without feeling cramped, has no room for a description, and closes if you look away.

**Generalisable:** a container is a bet on how much will go in it. The bet here was made when the catalogue was empty, which is when it is easiest to get wrong and hardest to notice.

### 48. The builder checked the session once

It verified the session at load and never again, so a session that ended while somebody was working — expired, revoked from another device, or dropped by a schema reset — surfaced as the words *"sign in first"* next to a disabled button. The editor looked fine and refused every save.

**Fixed** by announcing the 401 once, from inside `call()`, and letting the top-level component put the whole builder back on the sign-in screen. Every call site would otherwise need the same branch, which means one of them would not have it.

**Generalisable:** authentication is not a condition to check at startup, it is a condition that can stop being true at any moment. Anything that checks it once is describing the past.


### 49. Nineteen chips where six used to fit

The pack gallery filtered by category with a wrapped row of chips. With six categories that reads as a toolbar; with nineteen it made three ragged rows that fought the search box for the same corner, and the reported symptom was simply that it looked wrong.

**Fixed** by moving the categories into a column beside the results, which does not reflow when one is added and stays scannable at any length.

**Generalisable:** a wrapped row is a layout that works until the number of things in it changes, and the number of things in it is exactly what a catalogue is expected to grow. Choosing it is a bet that the list will stay short.

### 50. `null` is not the same as absent

A baptism register is kept forever, so its pack declared `retentionDays: null`. The schema takes a number or nothing, and rejected it — while the rest of the system already reads *absent* as "kept indefinitely", and the data map says so in words rather than leaving a blank.

**Generalisable:** when a schema offers "omitted" as a meaning, `null` is a second way to say the same thing and therefore a second thing to handle. One of the two will be forgotten.


### 51. Contents are computed at publish, so an upgrade does not reach them

Cards gained a drawn preview — the path a record takes, and what the form asks — added to `describeContents`. The gallery then crashed on every pack, because contents are computed **once, at publish time**, and every row in the database had been written before the field existed.

That is the same property that makes a card trustworthy: it cannot drift from what installing gives you. It also means a pack a tenant published last month carries last month's shape, and no deployment republishes it.

**Fixed** in two places, and both were needed. Re-seeding fixed the built-ins; a `?? { flow: [], askedFor: [], deciders: [] }` fixed everything else, because a tenant's own packs are never re-seeded.

**Generalisable:** denormalising for correctness — computing once so two things cannot disagree — buys that guarantee by giving up the ability to change the shape later. Every field added to a computed record is a field the existing rows do not have.

### 52. A scrollable panel a keyboard could not scroll

The pack detail took focus on its outer container and put the scrolling on an inner one. axe called it `scrollable-region-focusable`, and it is a real fault rather than a technicality: somebody using a keyboard could open the panel, read the first screen, and have no way to reach the rest.

**Generalisable:** focus belongs on the element that scrolls, not on the element that looks like the dialog. The two are usually different, and only one of them is what somebody needs to operate.


### 53. Two timers leaving one state, and the second never fires

Every generated pack had a reminder that looped back to the review state after three days, and an expiry that closed the record after thirty. The comment beside them said *"nothing stalls forever"*.

Entering a state cancels the timers of the previous occupancy and schedules the new ones. A self-loop re-enters the state, so the three-day reminder **restarted the thirty-day expiry every time it fired**. The expiry was always thirty days away from three days ago. It could never arrive.

Eighty-eight packs shipped with it, and every one compiled: this is not a property of a blueprint, it is a property of the runtime, so the compiler has nothing to say about it. The process looks complete on the page and a record waits forever.

**Fixed** by giving every non-terminal state exactly one outgoing timer, and making escalation a *state* rather than a second timer — which is also what escalation means. `timerConflicts()` in `src/packs/audit.ts` now fails the build on any state with more than one.

**Generalisable:** two mechanisms competing for the same clock is a race with no error message. The tell was that both timers were written in the same function, five lines apart, by somebody who had read the code that cancels them — knowing the rule is not the same as noticing it applies.

### 54. A rule that matched a field name matched one pack

Finance's threshold tier was declared as `field: 'amount'`. One of the seven Finance packs calls its money field `amount`; the others use `estimated_cost`, `invoice_amount`, `refund_amount`, `transfer_amount`. Six packs silently got no tier, which is worse than having no rule — the category page would have claimed a control that six of its seven packs did not carry.

**Fixed** by attaching the tier to the pack's **money field**, whatever it is called: the first required currency field, and nothing if the pack asks for no money.

**Generalisable:** a rule keyed on a name is a rule that applies wherever somebody happened to use that name. Keying on a *type* or a *property* applies wherever the thing actually is.

### 55. The audit found four forms on its first run

Compliance requires that a record captures when the thing happened, not only when it was reported. Four packs did not: a data subject request, a policy acknowledgement, a conflict of interest and a whistleblowing report.

All four were genuine. A subject access clock starts when the person *first asked*, and they usually email somebody before finding the form. An acknowledgement that does not name a dated policy version proves nothing. An interest declared in June that arose in January is the thing a register exists to show.

**Generalisable:** the value of a rule is not that it encodes what you already knew — it is that it finds the cases where you did not apply it. Four out of five Compliance packs, written the same week by the same author, missed the same control.


### 56. The only thing that could not be edited was the point of the product

Fields, states, roles, approvals and tasks all had editors, across twenty-two field types. Transitions — *when this happens, if this is true, do these things* — had none. The only way to change what a process **does** was the raw JSON tab.

Reported as "the forms are static and not flexible", which was half right and pointed at the more important half: the forms were the flexible part.

**Generalisable:** the feature that is hardest to build an editor for is usually the feature the product is about. A tab that says "edit this as JSON for now" is a note that the hard part was deferred, and it reads as finished.

### 57. A screen-reader-only class that only exists on some routes

The rules editor used `.vw__srOnly` for the labels on its selects. That class is declared in the console's stylesheet and in the gallery's, and not in the builder's — so on the builder the labels rendered as visible text in the middle of every rule.

**Generalisable:** a utility class is an invisible dependency. `sr-only` is the one where getting it wrong shows the user the thing you meant to hide from them, and it fails silently in the direction that looks like a content bug rather than a styling one.


### 58. Renewal that began after seven days

Sessions lasted fourteen days and renewed only past the halfway mark. Both numbers were wrong and in opposite directions: a stolen cookie worked for a fortnight, and an *active* session was not touched for a week and then jumped — which is the shape that produces "it threw me out" without anybody being able to say when.

**Fixed** at eight hours, renewed at most once an hour. A working day, ending by itself overnight, and using it keeps it alive.

**Generalisable:** a lifetime and a renewal interval are one decision, not two. Choosing the lifetime first and the renewal as a fraction of it produces a renewal nobody would have chosen on its own.


### 59. A picture that could not contain its own buttons

The flow map is an SVG whose state nodes are clickable — click one, see only its rules. It carried `role="img"` with an `aria-label` describing the path, which seemed like the considerate thing to do.

`role="img"` declares everything inside it decoration. axe called it `nested-interactive`, and it is right: a screen reader would announce a picture and then find controls inside a picture. The nodes are buttons, so the container is a `group`, not an image.

**Generalisable:** adding a role to be helpful changes what the children mean. `img`, `presentation` and `application` all redefine their subtree, and the accessible thing to do is usually to add less rather than more.

### 60. A start screen with a third of the page empty

Nine hundred pixels of content in a twelve-hundred pixel page, one card in a row built for four, and illustrations drawn in greys that read as unloaded placeholders. Reported as "very very horrible", which was fair.

Three separate mistakes, and only the third is about taste:

- **The container was narrower than the page.** A max-width chosen for reading prose applied to a grid of cards.
- **A gallery was used for a list.** Work somebody already has is identified by its name, so it is a list; a picture of a generic process adds nothing and leaves an empty row whenever they have one or two. Recent work is a list now and the new-start routes are cards.
- **The drawings had no colour.** Grey outlines on a grey plate read as a wireframe. They use the brand green at three weights, and the plate under them is tinted to match.

**Generalisable:** an empty state is the screen most people see most often and the one least likely to be designed, because whoever built it had data.


### 61. A fix that never applied, and a warning that said so for a week

The reminder email named the person it was about and sent it to a *role*, which SEC002 flags: a confidential value reaching whoever currently holds a role is not the same set of people the record's permissions allow. I changed it, said so in a commit message, and moved on.

The edit never applied. The search string did not match the file — an escaped newline in the patch script against a real one in the source — and the script reported success because a no-op replace is not an error.

So the warning kept firing on all eighty-eight packs, in the pack detail panel, for a week. It was found when the user asked **"is that warning ok"**, which it was not.

Two things went wrong and only one is the code:

- **A silent no-op edit.** A `replace` that matches nothing returns the string unchanged and exits zero. Every patch that matters should assert it changed something — the ones in this session that used `assert old in s` were fine; this one did not.
- **A claim was made from the intent rather than the output.** The commit said the reminder no longer names anybody. Nobody read the generated email.

**Generalisable:** the check for "did my fix work" is running the thing, not re-reading the patch. A warning count that does not move after a fix that should have moved it is the cheapest possible signal, and it was on screen the whole time.

### 62. Two hundred and thirty pixels to list two processes

The builder's left column was a full-width list in a three-column editor, permanently visible, usually holding one or two rows. The editor — the reason anybody opens the page — got what was left.

**Fixed** with a sixty-eight pixel icon rail and a switcher that opens over the editor when it is wanted. Icons keep their labels: an icon-only rail is a memory test, and the references that work all keep the word.

**Generalisable:** a navigation column is sized for the largest list it might hold, and lives with the smallest one it usually does.


### 63. A label that named nothing

Every field in the respondent's form drew its label two ways: bound to the control with `htmlFor` for an ordinary input, or as a plain `<span>` for the radio and checkbox groups, which have no single control to point at. The file field was passed the `<span>` form — and it does have a single control, carrying the very id the label would have pointed at.

So the label was visible, looked correct in every screenshot, and named nothing. A screen reader reached the attachment on every form in the catalogue that takes one and announced an unlabelled file input.

It surfaced only because the builder's new preview renders the respondent's own components inside the builder's page, and the accessibility scan drives the builder. No flow in the gate had ever opened a form with a file field on it.

**Generalisable:** a shared renderer with a flag that turns off the label binding will eventually be passed that flag by something that needed it on. And the reason to run the same components in two places is not only consistency — it doubles the paths a scan can reach them through.

### 64. The summary that admitted it did not know

The version history describes what changed between two published versions by comparing fields, states, rules and approvals. The first real use of it published a change to the form's header, which is none of those, and the panel said:

> changed in ways this summary does not cover — compare the two blueprints

That sentence was written as a last resort and it did its job in the first five minutes: it is the reason the gap was noticed at all rather than a version quietly reporting nothing. The comparison now covers the form as well.

**Generalisable:** a summary that cannot say "I do not know" reports silence instead, and silence reads as "nothing happened". The escape hatch is worth writing before it is needed, because you find out you needed it by reading it.

### 65. Two controls that changed something nobody was looking at

Clicking a record's reference in **Records** loaded the record and rendered nothing, because the detail panel lived inside the **My work** view and the Records branch was the one caller that did not switch to it. The other two callers did. Clicking a process in the sidebar had the same shape: on Integrations or People it set `processKey`, which nothing on those pages shows, so the button was indistinguishable from a dead one.

Neither is a crash, neither logs anything, and both pass a review of the code that changed — the handler does exactly what it says. They are only visible by clicking the thing and watching the screen not move.

**Fixed** by making both navigate. A record now has its own page and its own address, so it can be linked in a ticket and survives a reload.

**Generalisable:** a control that writes state the current screen does not render is a broken control, however correct the write is. The test is not "did the state change" but "did anything change that the person can see".

### 66. A definition list with three children

The record's answers became a `<dl>`: a `<div>` per row holding `<dt>`, `<dd>` and the classification chip. A `<div>` inside a `<dl>` may hold a label/value group and nothing else, so the third child made the whole list malformed — not that row, the list — and a screen reader loses the pairing between every label and every value on the page.

It was caught the same minute it was written, by the scan that already drives the console. That is the entire argument for having the gate run on every flow rather than on the four in §20.2: this would have looked correct in a screenshot forever.

**Generalisable:** semantic markup has rules about what may sit next to what, and "it renders fine" is not evidence of anything.

### 67. A clock one workspace invented, applied to everybody

`Engine.drain(now)` takes the time as a parameter, and the outbox and timer tables are shared across tenants by design — one worker drains the whole database, which is what makes it a queue. Both of those are right. Together they were not.

Anything that simulates time was claiming **every tenant's** due work at a time that had not happened. The scenario runner advances the clock a fortnight to prove a reminder fires; the seed writes a week of history. Each of those fired other workspaces' timers early, sent their reminder emails, and left their records with a `state_entered_at` in the future.

In production that reads: customer A clicks "run the scenarios" in the builder, and customer B's overdue-approval reminders all send two weeks early.

It surfaced as a cosmetic oddity. A dashboard tile read **−301.9h** of stage aging, and a negative waiting time is not a rounding error. Nothing in the tests caught it because every proof makes its own tenant and then checks only its own tenant.

**Fixed** in two places, because there are two faults:

- `drain`, `runOutbox` and `fireDueTimers` take an optional tenant, and `drain` **refuses** a clock more than a minute from the real one unless a tenant is named. Refused rather than scoped automatically: a caller that invented a clock knows what it invented it for, and guessing would hide the next one. The guard immediately caught nine more callers in the proof suite.
- The dashboard no longer averages an impossible duration into a percentile. A negative age is dropped and reported — "1 of 7 records is dated in the future" — rather than clamped to zero, which would have folded a broken row silently into the distribution.

Proof 25 now advances one workspace fourteen days and checks that the workspace next door sent nothing, its state clock did not move, and an unscoped fabricated clock is refused.

**Generalisable, three ways.** A shared queue and an injectable clock are each fine and are not fine together — the dangerous bugs live at the seam between two correct decisions. Test isolation that only ever asserts about its own tenant cannot see damage done to another. And a measure that can print an impossibility is worth having precisely because somebody notices: this was found by a number looking wrong, not by anything that was watching for it.

### 68. Patching by script, and the site it got wrong

Scoping forty-odd `drain` calls was done with a regex that attached the nearest preceding tenant variable. One proof submits into its own tenant and then talks to a neighbouring one, so the nearest variable was the wrong one — and the suite still passed, because that particular drain settles nothing the assertion reads.

**Generalisable:** a mechanical edit needs a mechanical check. The fix was to print every call site with its function and its argument and read the list — thirty seconds, and it is the only reason the wrong one was found.

### 69. A field that collected a filename and looked like evidence

The `file` field type rendered a file picker, accepted a drop, listed what you chose, and marked itself required. What it sent was `[...e.target.files].map(f => f.name)`. The bytes never left the browser.

So employee onboarding — a process whose whole point includes a statutory right-to-work check — stored `"right-to-work.pdf"` and nothing else. Expense approval stored `"lunch.jpg"`. HR opens the record, sees a filename where the document should be, and has no reason to think it is not there.

This is worse than a missing control. A missing control is absent; this one was present, visible, and wrong. It was found while starting on "malware scanning and upload quarantine" — you cannot scan uploads you do not accept, and the premise of the task turned out to be the bug.

**Fixed** by refusing it. `SEC013` is an error, not a warning, because warnings do not block a publish and the thing it prevents is a published process making a claim about evidence it has not got. The builder no longer offers the type, and the respondent form says out loud what the control does for any version published before this.

The two fields became references — a right-to-work share code, and where the receipts are — which is **D1** in this document, already settled and already used by the church process for safeguarding. The pattern was right there. Nothing generalised it to the other two processes because nothing had asked the question that makes it obvious: *what is actually in the record?*

**Generalisable:** a control that looks like it worked is worse than one that visibly failed, and the difference is invisible from the code that renders it. The test is not "does the field accept input" but "what is in the row afterwards" — which is one `select` away and nobody had run it.

### 70. A checker that could not tell "absent" from "could not ask"

`mail:check` resolves SPF and DMARC for the sending domain and reports what is missing. The first version caught every DNS error and returned no records — so a refused connection was indistinguishable from a domain with nothing published.

It was tested by asking it about a domain whose answer was already known. Google's SPF and DMARC records certainly exist; the checker said they did not. This machine's resolver is `127.0.0.1` with nothing behind it, and every lookup was `ECONNREFUSED`.

Reported as written, that sends somebody to add records that are already there, and teaches them the tool is wrong — after which it will be ignored on the day it is right.

**Fixed** with three outcomes instead of two. `ENOTFOUND` and `ENODATA` are answers: the resolver was asked and said no. Anything else means the question never got a reply, and the honest report is *unknown*. The command exits `1` for missing and `2` for unreachable, so a pipeline cannot read "I could not find out" as a pass.

**Generalisable, and it is the third time in this document:** a check that collapses "no" and "no answer" into one value will always collapse them toward whichever is easier to return. The way to find it is to run the check against something whose answer you already know — which costs a minute and is the only test that would have caught this.

### 71. A permission check on the door and not on the rooms

Opening a draft in the builder checked `administer`. So did creating one and discarding one. Loading, saving, testing, the impact summary and publishing checked only that the caller belonged to the same workspace.

The builder's own process list hands a draft's id to anybody signed in. A read-only member — Dana, in the seed — loaded the onboarding draft and saved it back, and got `200` both times. Publishing takes the same path, so she could have published a process she is not allowed to open.

It was found while adding draft locking, by reading every function the lock would sit in. Nobody had tried the routes as the wrong person, because the interface never offers them to the wrong person — and the interface is not the gate.

**Fixed** with one check, `requireDraftAdmin`, called by every draft operation, using the same rule `openDraft` already used: `administer` from the process's roles or the workspace role. The locking proof now calls load, save, claim and publish as a read-only member and expects four refusals.

**Generalisable:** a check that runs once, at the first step of a flow, protects the flow only as long as nobody can start in the middle. An API can always be started in the middle.

### 72. A save that did nothing and said "saved"

`saveDraft` was an unconditional `update ... where published_as is null`. After somebody published the draft, that matched no rows — and the function went on to compile what it had been sent and return fresh diagnostics. The builder showed a green "saved". The work went nowhere.

The same statement was also last-write-wins. Two people editing one draft each saved the whole blueprint, and whichever saved second erased the other's work, with "saved" on both screens.

**Fixed** with two layers. Every save and publish names the revision it was made against, and one statement checks it together with the editing lease — `where revision = $n and <lease free, expired or mine>` — so there is no gap between checking and writing. When it matches nothing, the refusal says which of three things happened, with a name: someone else is editing (`held`), someone saved since you loaded (`stale`), or it was published (`published`). The lease tells the second person *before* they start: opening a draft someone else holds shows their name and a read-only editor, with a way to take over when they have walked away. A lease nobody renews expires in two minutes, so a closed laptop does not lock a process for a week.

Two details came from testing it rather than designing it. The debounce alone did not stop a slow save and a fast one overlapping, so one tab's second save carried the old revision and was refused as stale against itself; saves are now queued. And the same person with the draft in two tabs was told their own name — "Joy saved this after you opened it", said to Joy — so that case now says "you saved this from another tab".

**Generalisable:** a write that can match zero rows must check that it matched one. `rowCount` is free, and without it "saved" is a claim about the request, not about the database.

### 73. Renaming a field, and the seed that carried on without it

Entry 69 renamed `id_document` to `right_to_work_reference`. The seed still sent `id_document`. `engine.submit` refused the answers as incomplete and returned an empty id, the seed carried on with it, and Postgres rejected `""` as a uuid three calls later. The error named uuid parsing and nothing pointing at the field.

It was mine, from entry 69, and it went unnoticed because the proofs build their own data and never run the seed.

**Fixed** in the seed, which now stops at a refused submission and names the missing fields. **Generalisable:** a function that signals failure through an empty value needs every caller to check it, and the one that does not will fail somewhere else, later, in words about something else.

### 74. Three selects in a row, and none of them had a name

The builder's "who" picker — used for approvers, task assignees and now message recipients — is a row of selects with no visible label of their own. None of them had an accessible name either. A screen reader reached the approver list and announced "combo box", "combo box", "combo box".

It had been there since the approval editor was built. The accessibility gate never saw it, because the gate never opened a screen with one on it: it audited the form header editor and the publish dialog, and both of those happen to have none. Adding the message editor to the gate found it on the first run.

**Fixed** with a `label` on the picker that each caller fills in — "Approver 2", "Recipient 1", "Assigned to" — so every control says both what it is choosing and which one it is.

**Generalisable:** an automated gate covers the screens it visits and says nothing about the rest, and "no violations" reads the same either way. When something new is built, the first job is to point the gate at it — which is how this was found, and how any editor still not in the gate would be.

### 75. A public form that emailed whatever address it was given

The README listed spam control as "not built" and described the risk as records: a budget stops one caller making a thousand, not a thousand callers making one each. That undersold it. The onboarding form asks for the hiring manager's email and, on submission, the workflow emails that address. So every fabricated submission was a message from this platform's sending domain to an address a stranger typed — a relay, with our domain's reputation attached to it.

It was found by asking what a spam submission *does*, not what it *is*. The record is the visible part; the outbox is where the harm was.

**Fixed** by holding instead of acting. Public submissions carry a signed ticket from when the form was served, and the form carries a trap input no person reaches. One that fails either is held in its own table — not a record, so no transition runs and nothing is queued — until an operator releases or discards it. Nothing is discarded automatically, because password managers fill hidden inputs and a person resuming a finished draft can be quick; a filter that silently dropped them would lose a real application with nobody knowing it arrived.

Two details decided the shape. A held submission is not an `instance` with a flag, because every query that reads instances — the queue, metrics, exports, the copilot, duplicate detection — would each need to remember the flag, and the one that forgot would leak. And it does not occupy an identity slot: a script that used a real person's email would otherwise make that person's own submission a "duplicate" of the script's.

**Generalisable:** for anything a stranger can trigger, trace it to its side effects before deciding what the control is. The control belongs in front of the first effect that reaches someone outside, and here that was an email, not a row.

### 76. Test data that could only bounce, sent through the real account

Every seed, proof and demo uses `example.test` addresses, so that none of it can reach a person. That was true of the console provider. The development API reads `.env`, and `.env` names RelyKit — so testing the spam queue, I released a held submission and, by the code path, its receipt to `script.two@example.test` was handed to the real RelyKit account. What RelyKit did with it is not known here. A reserved domain has no mail server, so the best case is a refusal and the likely one a hard bounce, on the account whose bounce rate decides whether it may keep sending.

Found while building the thing that watches that rate, by asking which provider the test I was about to run would use. The earlier sends could not be counted afterwards: the proof suite resets the database it shares with development, and took the log with it.

**Fixed** at the provider rather than in each caller. Every real provider is wrapped, and a reserved recipient — `.test`, `.example`, `.invalid`, `localhost`, `example.com/.net/.org` — is dropped before the provider sees it, with the reason on the record. The console provider is left alone so development still looks like production. The end-to-end test for this change handed zero messages to the provider.

**Generalisable:** "our test data cannot reach anyone" is a property of the whole path, not of the addresses. It has to be enforced where the path leaves the building, because every other layer can be configured around it by a `.env` file nobody is thinking about.

### 77. A lift that reached further than the list

A workspace sees only the suppressed addresses it has written to — the list is deployment-wide, and showing all of it would hand one customer another's contacts. The lift endpoint had no such limit. An admin could reinstate any address on the deployment by typing it, including one another workspace's mail had just hard-bounced.

**Fixed** by applying the same scope to the lift as to the list. **Generalisable:** when reading is scoped, every write that names the same thing needs the same scope — the write is where it matters.

### 78. A key that was unique in one workspace, used as though it were unique everywhere

A process key is unique within a workspace: `unique (tenant_id, process_key, version)`. The public form lived at `/f/<process_key>`, and every lookup behind it — serving the form, checking answers, saving a draft, submitting — was `where process_key = $1 order by version desc limit 1`, with no workspace. Two workspaces that installed the same pack shared a URL. The one that had published more versions was served, and the other's applicants were filed as its records.

The public API had the same lookup. `POST /v1/records` authenticates a key that belongs to one workspace, then passed only the process key on — so one customer's key could create a record in another customer's process of the same name, if that one was on a higher version.

It was invisible in development, where there is one workspace, and in every proof, which reset the database between runs. It was noticed while adding spam control, by reading the query that served the form rather than the code that called it.

**Fixed** with a public id per (workspace, process) — random, kept across versions, made at first publish — which is now the link. Every intake lookup resolves to one workspace before reading anything. The public API passes its key's workspace. An old key-only link still works while the key is unique and refuses with a `410` once it is not. A draft token only reaches drafts of the form that issued it, and the spam ticket is signed for the form's link. A proof puts the other workspace on the higher version and goes in through every door.

**Generalisable:** a uniqueness constraint says what is unique *within what*. Every lookup by that value has to carry the "within" with it, and the ones that do not will work perfectly for as long as there is only one of the thing it was left out of.

### 79. A Refuse button that went wherever the link said

The OAuth consent page at `/authorize` read the request from the query string and drew itself — no call to the server first. Its Allow posted to the authorize endpoint, which checks the client and the redirect address exactly. Its Refuse did not post anything: it built `redirect_uri?error=access_denied` in the browser and went there.

So `/authorize?client_id=anything&code_challenge=x&redirect_uri=https://anywhere` drew a Patform-branded "Allow access?" for an application that did not exist, and one click on the safe-looking button sent the visitor to any site the link's author chose. An open redirect is the part of a phishing link that makes it look trustworthy, and this one was on the button people are told to press when unsure.

The same page listed every requested scope as though it would be granted, including ones the member did not hold, and could be framed by another site. The README, meanwhile, said there was no consent screen at all; this session set out to build one on that basis and found the page only through the accessibility gate's list of flows.

**Fixed** by replacing it. The new screen asks the server to validate the request before drawing anything, shows only a request that would work, and Deny goes through the server, which redirects only to an address the client registered exactly. `/authorize` forwards to it. A proof covers the whole OAuth flow, which had no test of any kind before.

**Generalisable:** the safe-looking choice gets the same scrutiny as the dangerous one. Here the Allow path was checked on the server and the Refuse path was not checked anywhere, because refusing felt like it could not hurt.

### 80. A form that offered four choices the server had never heard of

The Integrations page let an administrator issue an API key, choosing what it may do from `records:read`, `records:write`, `processes:read` and `events:read`. The server scopes keys by capability — `view`, `edit`, `report` — and checks that a key is no broader than the person making it. None of the four names is a capability, so every one failed that check: "you cannot grant a key records:read — you do not hold it yourself". No key had ever been created from the page.

It was found testing something else. The new "confirm it is you" prompt answered correctly, the request was sent again, and the retry failed — for a reason that had nothing to do with the prompt. The accessibility gate had been through the page every run; it checks what a page shows, not whether its one button works.

In the same run the gate failed the page for the first time, because the test had left a revoked key in the table and nobody had ever scanned a row of it: revoked keys, and deactivated members on People, were faded to 60% opacity, which put their text under the contrast minimum. The state is said in words on the row; it now uses the muted text colour instead, and the gate's own setup makes a revoked key so the row is always checked.

**Fixed** by offering the scopes the server checks, with what each lets a key do. **Generalisable:** a form's options are a claim about the server. When they are typed in by hand on the client, the only test of the claim is using it — and a page that only ever renders empty is a page whose rows have never been checked.

### 81. Three approval modes, one behaviour

The schema offered `single`, `sequential` and `any_of`, documented `sequential` as "runs approvers in the order listed", and the builder offered it as "each in turn, in the order listed". The runtime put every approver's address into one list, let anybody on it decide, and settled the request on the first decision. So a sequential approval of manager then HR could be settled by HR alone, before the manager had seen it — the same behaviour as any-of, under a name that promised a control.

No shipped process used it, which is why nothing failed. It was found adding quorums, which need the same thing sequential needed all along: a request that counts decisions and stays open until its mode is satisfied.

**Fixed** by making each decision a vote, one per person, with the request settled only when its mode is. In a sequence only the approver whose turn it is may decide. A proof runs a manager-then-HR sequence and shows HR refused out of turn and absent from their queue until the manager has approved.

**Generalisable:** an enum value is a promise, and a runtime that switches on some values and falls through on the rest keeps the promise for those it names. Search for every place the enum is consumed, not only where it is declared.

### 82. Retention that failed on any record an email provider had reported on

`delivery_event.email_log_id` referenced `email_log` with no `on delete`. Retention and privacy erasure both delete a record's email log. For any message the provider had sent a webhook about — delivered or bounced — the delete was blocked by the foreign key, and the whole run rolled back. With RelyKit webhooks configured, that is nearly every record in production.

The retention proof deleted a record that had never received a provider event, so it passed. It was found when the new vote table's foreign key made the same mistake and a later proof tripped over it; reading every foreign key onto the tables retention deletes turned up this one, and the resend table added earlier the same day had it too.

**Fixed** with `on delete cascade` on all three — a provider's report about a message goes when the message does, which is also what erasure should do with a row holding the recipient's address. The retention proof now gives the record a delivery event, a resend and an approval vote before deleting it; run without the cascade, it fails with the original foreign-key error.

**Generalisable:** a deletion job is tested by the richest record it will meet, not the simplest. Every table added later is a new way for it to fail, and the only place that shows is a proof whose record has one of everything.

### 83. "I can't sign in," while the proofs were running

The proof suite drops and recreates the schema before every proof. It read the same `DATABASE_URL` as the app, so running it during development emptied the workspace the console was using: every session vanished, the seeded accounts went with them, and somebody signing in was told their password was wrong. Re-seeding afterwards put the accounts back and signed everybody out a second time.

Nothing failed, which is why it took a person to notice. The suite was doing exactly what it should, against the wrong database.

**Fixed** with `PROOF_DATABASE_URL`: when it is set, the spike runs there and nowhere else, and it prints which database it is about to drop so the target is on screen before anything happens. The local setup uses a second database on the same container.

**Generalisable:** a command that destroys data should not share a setting with a command that serves it. One variable for both means the safe choice depends on remembering, every time, which one you are about to run.

### 84. "Over a thousand needs a controller", on every amount

Every Finance template with an amount said, on the template and in the builder, that anything over 1,000 also needs a financial controller. The generator sent every approved record to the controller whatever the amount: the transition out of the last approval went to the controller's state unconditionally. A £12 petty cash claim waited on the financial controller.

Seven templates had it, and each one failed its own happy-path scenario, which expects an ordinary claim to finish without the controller. Nothing noticed because nothing ran the templates' scenarios. `packs:check` compiled them, and compiling was all that was ever checked.

**Fixed** by splitting that transition on the amount: over the limit to the controller, otherwise straight on. Each Finance template now carries a second happy path over the limit, so both sides of the rule are tested, and the proof suite runs every template's scenarios (535 across 88).

**Generalisable:** a template is a claim about behaviour, and compiling it checks only that the claim is well formed. The scenarios were written, generated and shipped with every template, and nobody ran them. A test that is never executed is documentation.

### 85. Templates fixed in code, unchanged in every workspace

The catalogue is generated from code, but the seed is the only thing that ever wrote it to the database. A template fixed in code stayed as it was in a running workspace until the database was re-seeded, which in development signs everybody out and empties the workspace.

**Fixed** with `npm run packs -- --catalogue`, which publishes a new version of each template whose generated blueprint differs from the newest one stored, and nothing else. Running it twice publishes nothing the second time. Workspaces that installed the older version keep it. The first version of the comparison called every template changed, because Postgres stores JSON with its own key order; it compares with keys sorted.

### 86. "localhost:3210 says"

Discarding a draft, taking one over, reloading after a conflict and discarding a held submission all used the browser's `confirm()`. It rendered in the browser's styling, headed with the host name, and asked people to press "OK" to throw their work away. Separately, installing a template sent people to `/builder?draft=<id>`, and nothing read the `draft` parameter, so they landed on the start screen and had to find the draft they had just made.

**Fixed** with an in-app confirm dialog that names the action on its button ("Discard the draft", "Keep editing"), says what is lost, and uses the same focus handling as every other dialog: focus moves in and stays in, Escape and the backdrop both mean no, and focus goes back. A unit test fails if `confirm`, `alert` or `prompt` appears in the web app again. The builder now opens the draft it is sent to. Installing under a key that already exists, and asking for a draft that is gone, now answer 400 and 404 with a sentence instead of 500.

---

## What the compiler structurally cannot catch

This is the most important thing to come out of wiring a generator to the compiler, and it is worth stating separately from everything above.

**A model that labels a bank account `internal` produces a blueprint that compiles with zero errors and zero warnings, passes all six of its own scenarios, and emails salary details to a line manager.**

Every structural rule is satisfied. References resolve, the graph is sound, no restricted field appears in a message — because the field is not marked restricted. The blueprint is internally correct and externally wrong.

No amount of additional compiler rules closes this, because the compiler knows what shape a field is and has no idea what it *means*. Closing it needs case-specific expectations held outside the blueprint: this description mentions paying a salary, therefore a field matching `bank|account|iban` must exist, must be at least `restricted`, and must not appear in any email body.

That is what `evals/cases.json` is, and it is why control assertions carry §7.4's zero-tolerance gate while ordinary omissions are allowed 2%.

Two things learned building that harness, both of which made it *less* alarming and more useful:

- **Matching label prose produces false control failures.** The first run flagged a yes/no field called `confirm_accuracy` whose label read "I confirm my bank account details are correct". A checkbox cannot hold an account number, so `internal` was the right answer and the eval was wrong. A control gate that cries wolf gets ignored, which is worse than not having one. Classification rules now only consider field types that can actually carry the value.
- **A control gate with nothing to check must not report PASS.** The same run reported "0 control failures" for a provider that had produced no blueprints at all. Zero of zero is not a pass. It now reports "not evaluated" and fails the suite.

### G6. Field-level permission is per role, not per state

A hiring manager should see the start date before approval and the employee reference after it. Roles carry a fixed `hiddenFields` list, so visibility cannot change as the record moves.

**Recommendation:** acceptable for MVP. Note it, because the first customer who asks will not be the last.

---

## Modelling decisions worth carrying forward

### D1. Do not hold evidence you do not need

Church worker onboarding collects a safeguarding certificate *reference number* (internal) and a confirmation flag, not the certificate itself. The check happens in the diocesan system.

This kept the whole process under a `confidential` ceiling instead of `restricted`, which in turn keeps it inside what a beta tenant is allowed to hold (§12.2 — do not claim compliance you have not earned).

The pattern generalises: **record that a check happened and where to verify it, rather than storing the evidence.** It should be a default in the process packs, not a thing each customer rediscovers.

### D2. Telling someone their own answers back is not a disclosure

The first version of `SEC002` warned on any confidential field in any email body. Every real template tripped it, because every real template greets the person by name. A rule that fires on everything gets ignored.

The rule now depends on the recipient: quoting confidential values to the submitter is fine; sending them to a role or a third party warns. Restricted values are an error regardless of recipient.

**Generalisable:** privacy rules that ignore the recipient produce noise, and noisy rules get switched off.

### D3. The sensitivity ceiling earns its place

Declaring the highest data class a process may hold, and rejecting fields above it, caught a real thing: `accessibility_notes` in employee onboarding is health-adjacent and classified `restricted`. That forced an explicit decision about the ceiling rather than letting a health field arrive by accident inside a routine HR form.

---

## What this implies for the build

1. **The compiler is the product, more than the editor is.** Every fault above would have passed a visual review. Three of them were mine, made while concentrating, with the schema open. A customer describing a process in a prompt will make more, not fewer.

2. **Generated blueprints need these rules before AI generation ships, not after.** §21 puts the typed schema and compiler at P0 and AI generation at P1. Hand-compiling supports that ordering strongly: a generator without a compiler produces confident, plausible, broken processes.

3. **Six scenario kinds per process is achievable and worth enforcing.** Writing happy path, rejection, missing data, timeout, duplicate, and permission tests for three processes took under an hour each and surfaced the safeguarding gap. Making it a publish gate (`TEST001`) is not onerous.

4. **The gaps in G1–G6 are a v0.2 agenda, not blockers.** All three reference processes compile clean without them. None of them needs solving before a design partner sees a working process.
