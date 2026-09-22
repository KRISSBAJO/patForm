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

### G1. There is no "all blocking tasks are done" trigger

Employee onboarding provisions equipment and accounts in parallel, then completes. The only available trigger is `task_completed` for one named task, so the blueprint chains them: finishing equipment creates the accounts task, and finishing accounts completes the record.

This works but is dishonest — it models a parallel fan-out as a sequence, and it means the process is slower than it needs to be and breaks if IT does them in the other order.

**Options:** add a `tasks_completed` trigger taking a set; or add a `join` state type that waits for all blocking tasks; or keep chaining and accept it. A join is the right answer, and it needs a runtime design before it goes in the schema.

**Cost of deferring:** every process with parallel work models it as a false sequence. That will show up in customer processes quickly.

### G2. Approvals cannot express "any two of these four"

`mode` is `single`, `sequential`, or `any_of`. Real approval policies include quorums ("any two directors") and conditional escalation ("finance too, but only over £5,000, and only outside the approved vendor list").

The threshold case is currently handled by splitting into two transitions with different `when` conditions, which works and is readable. Quorum has no expression at all.

**Recommendation:** do not add quorum for MVP. Do confirm with design partners that nobody needs it, because retrofitting it touches the approval runtime.

### G3. The expression model cannot reach into repeating groups

`sum` and `count` over a repeating group work. Anything else does not: "any line item over £200", "more than three items", "any item in a restricted category" are all inexpressible.

Expense approval wants the first of these for a real policy. It is currently not modelled.

**Recommendation:** add `any` and `all` quantifiers over a repeating group in v0.2. They are a contained addition and the runtime cost is bounded.

### G4. Timers are relative to state entry only

`afterHoursInState` is the only timing primitive. Real processes want "three days before the start date" and "on the last working day of the month".

Employee onboarding wants to chase equipment relative to `start_date`, not relative to when HR happened to approve. It currently cannot.

**Recommendation:** add `relativeTo: { field }` with an offset in v0.2. Note that this makes timers depend on data that can change after the timer is scheduled, which the runtime has to handle — that is a real design question, not a schema one.

### G5. Nothing expresses "this person may not approve their own request"

Expense approval addresses the manager approval to `{ field: manager_email }`, which the claimant types in. Nothing prevents a claimant entering their own address.

This is the most likely fraud vector in the whole expense process and the blueprint cannot describe the control.

**Recommendation:** this is a runtime identity concern, not a blueprint one, but the blueprint needs a way to *declare* it — something like `approvers: [{ field: "manager_email", notTheSubmitter: true }]`. Worth deciding before an expense pack ships.

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
