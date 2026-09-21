# ADR-0007: The blueprint is the policy, and the runtime enforces it

**Status:** accepted · **Date:** 2026-09-21

## Context

§6.1 IAM-03: *"Every authorization check is enforced server-side."*
§12.1: *"Central policy engine, server-side checks, deny by default, record and field scope where required."*
§6.4: *"Sensitive fields can be hidden from roles that otherwise access the record."*

Before this change none of that was true, and it looked like it was.

Blueprints declared roles, capabilities, `hiddenFields` and `editableFields`. The compiler validated all of it and refused to publish a blueprint whose permissions were incoherent — a respondent granted `operate`, a role permitted to edit a field it could not see, approvals with no approver. Every reference resolved. Every process passed its own permission scenarios.

And the engine checked nothing. `decide()` would apply an approval from any caller in any tenant. `completeTask()` the same. `hiddenFields` was enforced nowhere. The permission scenarios that passed were asserting against a lookup table in the test harness, not against the system.

This is the same failure shape as the safeguarding task in [failure-cases.md](../failure-cases.md): **a control that is present in review and absent at runtime.** It is worse than an obviously missing control, because a review finds the missing one.

## Decision

**One policy engine, and no second path.** `authorize()` in `runtime/policy.ts` is the only thing that says yes. Every engine mutation calls `require_()` before it touches a row. There is no convenience overload that skips it, because a control with a bypass is not a control.

**The blueprint is the policy.** Roles and capabilities are not a separate permissions system that must be kept in step with the process — they are the same declaration the builder reads, the compiler validates and the runtime enforces. That is what makes "what the review showed you" and "what happens" the same thing.

**Principals, not strings.** The engine used to take `actor: string` and believe it. It now takes a `Principal`:

| Kind | Is | Holds |
|---|---|---|
| `actor` | a signed-in member | whatever roles their memberships grant, in that process only |
| `respondent` | someone on a public form | `submit` and `view`, nothing else |
| `system` | timers and outbox workers | tenant-scoped, no blueprint role, audited |

Membership is per process. Being an approver for expenses grants nothing in onboarding.

**Six refusals, in order:** wrong tenant → no such actor → deactivated → no role in this process → no role with the capability → not named on this particular approval request.

That last one matters on its own. Holding the `approve` capability is not the same as being the approver *this record asked for*. Without it, any approver in the workspace could decide any record — which is not a permission model, it is a job title.

**Field scope both ways.** Reads are redacted on the way out, so a field a role may not see is never serialised rather than hidden in the client. Writes are checked against `editableFields`, because holding `edit` is not permission to change everything. A field is hidden only when *every* role the actor holds hides it, so holding a second, broader role is how someone legitimately sees more.

## Consequences

- **The permission scenarios now test the system.** `engine.can()` is the same call the engine makes before it mutates, so a scenario asserting "the IT operator may not approve" exercises the production path. Previously it exercised a constant.
- **Scenario casts are real.** Each internal role in a blueprint gets a member with a membership for the duration of a scenario.
- **An approval addressed to an email field exposed a modelling gap.** `{ field: "manager_email" }` names an approver by address, and nothing in the blueprint links that field to a role — G5 in failure-cases. The scenario runner gives the cast member the address the record will name, rather than rewriting the record to match the cast, because the second one is a test bending data to pass.
- **Still open:** `taskAssignee` is passed to the policy engine and not yet used, so any holder of `operate` may complete any task rather than only their own. Deliberate for now — tasks are reassigned often and an over-tight rule would be worked around — but it should become a per-task setting, not stay an omission.
- **Also open:** capabilities are per process. A tenant-level role model (§6.1 IAM-02's owner / admin / builder / analyst) sits above this and is not built.

## The bug this found in itself

The first run of the authorization proof failed on its last assertion: four refusals happened correctly and **one** reached the audit table.

`require_` wrote the denial on the caller's client and then threw. The throw rolled the transaction back, and the audit record of the refusal rolled back with it. A refused action left no trace — which is the exact failure the table was added to prevent, reintroduced by the code that was meant to prevent it.

Refusals are now written on their own connection, outside any caller transaction. The proof records five.

## Evidence

From `npm run spike`, *Authorization is enforced by the runtime, not by the caller*:

- A hiring manager from **another tenant** was refused: *principal belongs to a different tenant*.
- An IT operator was refused: *no role held (it_operator) has the "approve" capability*.
- A second hiring manager, with the right role, was refused: *actor is not named as an approver on this request*.
- A respondent was refused: *a respondent may not approve*.
- `national_id` and `bank_account` came back `[redacted]` to the hiring manager while `job_title` did not.
- An edit to a field outside the role's editable list was refused.
- The approver the record actually names was allowed through.
- Five refusals are on the audit record.

All 21 blueprint scenarios still pass with enforcement switched on.
