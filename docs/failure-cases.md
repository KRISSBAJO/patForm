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
