# ADR-0009: The builder, and three things that only appear when you run it

**Status:** accepted · **Date:** 2026-09-21

## Context

§20.1 step 3: *"The builder changes a field and approval threshold, resolves warnings, and publishes."* Four requirements sit behind that sentence — BLD-03 (edit without editing JSON), BLD-04 (the compiler names what is wrong), BLD-05 (test with sample records first), BLD-07 (publishing confirms schema and migration effects).

Everything the builder needs already existed: a typed schema, a compiler with ~45 rules, a scenario runner on the real engine, immutable versions. What did not exist was a way to touch any of it without writing JSON by hand.

## Decisions

**The diagnostics panel is always on screen.** Not a dialog on publish, not a tab. It is the third column, it updates on every keystroke, and clicking an entry selects the thing that caused it. The argument for compiling a process at all is that you find out immediately; a compiler whose output you have to go looking for gives most of that back.

**Diagnostics resolve by key, not only by path.** A diagnostic about an approval is usually reported at `workflow.transitions[0].actions[1]` — where the compiler was standing when it noticed, not where the approval is defined. That path is useless for navigation in exactly the cases that matter most, so the panel also reads the quoted keys out of the message and resolves those against the blueprint.

**A draft that does not compile is still a draft.** `saveDraft` stores work that fails Zod, and `loadDraft` returns the shape errors as diagnostics. Refusing to store something because it is currently invalid is how people lose an afternoon.

**Publishing re-validates server-side.** A publish endpoint that believes the client about whether a blueprint compiles is not a gate, and the gate is the whole architecture.

**The number on the publish screen is `inFlight`.** §9.2 says a new version governs only new instances, which is safe and also surprising: somebody who has just fixed a broken approval expects the records stuck on it to move. Saying how many will not is the honest thing to put in front of them.

**A new process starts from a description or a copy, never from a blank canvas.** The generation pipeline already runs shape → compile → repair and refuses to hand back something that does not compile. A blank skeleton would open with a dozen errors and teach people that the panel is noise.

## What running it found

Three faults, none of which are visible by reading the code.

**1. A read that could not see its own write.** `openDraft` inserted the draft inside a transaction, then called `loadDraft(pool, …)` to return it — a second connection out of the pool, which cannot see an uncommitted row. It compiled, it type-checked, it failed on the first click with `no such draft`. This is the same shape as the refusal audit in ADR-0007 and the delivery log in ADR-0008, approached from the other side: there the write had to escape the transaction, here the read had to wait for it. The transaction now returns an id and nothing else.

**2. An approver who could not approve.** `checkParty` verified that an approver's role *exists*. It never asked whether that role holds the `approve` capability — and the policy engine refuses `approve` to a role that does not, so an approval naming one waits forever. Nothing reads as wrong: the role is real, the approval is wired up, the transition fires. It is only visible from the policy engine's side, which is why the compiler now carries it as **SEC009**, along with the stronger case of a respondent role named as an approver, which `authorize()` refuses before it looks at any role at all.

This is the fourth instance of the same pattern in this codebase, after the safeguarding task nothing waited for, the permission model that was only checked in tests, and `editableFields` that no code path could reach: **a control that is present in review and absent at runtime.**

**3. The proof suite was sending real email.** The Engine's constructor carried a comment saying it defaulted to console "so a local database never delivers real mail to a real person because somebody forgot to unset a variable". It did not: naming a provider in the environment was enough. Once `EMAIL_PROVIDER=resend` went into `.env`, `npm run spike` began firing forty live sends per run at addresses under `example.test`, which the provider rejected or throttled — which is how it was found, as a concurrency proof reporting 19 emails for 40 instances.

The guard cannot live in the Engine, because the Engine cannot tell a proof run from a real one. It lives in the harness: `suppressDelivery(reason)` at the top of `spike`, `seed` and `eval`, which unsets the variable and says on stdout that it did. The Engine's comment now describes what the code does.

ADR-0008 claimed delivery required two switches so that "a key left in a `.env` from last week should not quietly turn a test run into real mail". That claim was true of `send-test` and false of everything else.

## What the builder does not do

Stated here rather than implied by silence. Intent, the form experience, transitions, messages, documents and scenario tests have no form editor and are edited through a JSON tab. Transitions especially deserve a graph editor. There is no draft locking, so two people editing the same process will overwrite each other; the draft is per-process, not per-person, which makes that visible but does not prevent it.

## Evidence

From `npm run spike`, *A draft opens, refuses to publish while broken, and says what a publish would change*: opening twice returned one draft; an operator was refused (`workspace role "operator" does not grant "administer"`); naming a role without the approve capability produced two SEC009 errors and a server-side publish refusal; a draft saved as `{"half":"typed"}` was kept and reopened as eleven shape diagnostics rather than throwing; after the fix the impact summary counted one record still running, named the added field, published version 2, and left the running record on v1.

Driven through the browser against the seeded workspace: renaming a field key produced thirteen errors naming the form page, both approvals, the document placeholder and the scenario tests, and disabled publish; changing the approval from `single` to `sequential` with a second approver produced SEC009, which navigated to the approval when clicked; fixing it ran 6/6 scenarios on the real engine and published version 2 against five in-flight records.
