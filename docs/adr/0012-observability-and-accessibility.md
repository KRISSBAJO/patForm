# ADR-0012: The last two quality gates

**Status:** accepted · **Date:** 2026-09-21

## Context

§20.2 has eight gates. Six were met by work done for other reasons. Two had never been touched:

**Observability:** *"Every workflow action has traceable request, event, job, attempt, and result identifiers."*

**Accessibility:** *"Core builder, respondent, approval, and operator flows meet WCAG 2.2 AA target."*

Alongside them, §20.2's supportability gate: *"Support can diagnose a failed instance without direct database modification."*

## Observability

Four of the five identifiers already existed — `event.id`, `outbox.id`, the attempt counters, and `action_run.id` with its result. **The request was missing entirely**, so they were four separate facts that happened to concern the same thing, and relating them meant matching on timestamps.

**The request id lives in async context.** That is a real trade: an implicit value is harder to follow than an argument. The alternative is a parameter on `submit`, `decide`, `completeTask`, `applyTransition`, `executeAction` and `performEffect` that none of them reads and all of them pass on, and a value every function must carry and no function may use is what ambient context is for.

**It crosses the worker boundary deliberately.** This is the only link that could break: the job runs minutes later in another process with no memory of what caused it. The id is stamped on the outbox row, and `runOutbox` re-enters that request's context for each claimed row — so every event, action run and log line the job produces carries the id of the submission that started it, and survives a restart.

**A timer gets an id of its own.** Nothing outside asked for it; a deadline passed. Leaving those `unattributed` would have made "why did I get this reminder" unanswerable for exactly the messages people ask about.

**A caller may supply their own id.** §11.1 asks for request IDs on the API. One that arrives in `x-request-id` is used, returned on the response, and appears on everything the call caused — which is what makes a support conversation short. It is a label, never an authority, so the only checks are shape and length.

**Logs carry identifiers and never answers.** §10.1 asks for "tenant-safe support diagnostics". A record's data belongs to the respondent, and a log is somewhere with different retention, different access control and no redaction. `detail` is for text this codebase wrote.

### The supportability half

`runtime/support.ts` answers the three questions a failed instance actually produces: what happened, in what order, and which step failed and why. It reads across five tables nobody should have to join by hand, in both directions — one record end to end, or everything one request caused across every record it touched.

The point is not that a psql prompt is forbidden. Somebody handed one will use it, because the alternative is telling a customer "I can't see". The way to stop that is to make the read they need easier than the query they would write.

The diagnosis is one sentence, ordered by usefulness: a permanent failure outranks a retry, a retry outranks a wait, and a record doing exactly what it should says so plainly rather than being described in a way that sounds like a problem. From the seeded workspace:

> Retrying: "submit" has failed 4 time(s) and will be attempted again — HRIS rejected the webhook: 401 Unauthorized.

`npm run support -- <record-id | request-id> --as <actor-id>` is the same data through the same permission checks. It takes a principal because a support tool that bypasses authorization is a psql prompt with better formatting.

**An action run is tied to its event by parsing the idempotency key** — `transitionKey:actionKey:eventId`. The key was built that way for correctness in ADR-0002 and carries the correlation for free; adding an `event_id` column would create a second source of truth for what an action belongs to.

## Accessibility

Audited with axe-core 4.10.2 against the WCAG 2.2 AA rule set, then by hand. Full record in [docs/accessibility.md](../accessibility.md); `npm run a11y` re-runs the automated half.

**axe found two violations. Six of the eight real problems came from reading.** That ratio is the finding, and it is why the check script says so in its own header rather than reporting a green tick.

What axe caught, and only once signed in — which is why auditing a login page and declaring victory is worth nothing:

- `aria-allowed-attr`, critical: panel headings were `<button aria-selected="true">`, which is invalid ARIA, a keyboard stop with no action, and a heading missing from the outline.
- `color-contrast`, serious: two labels in the sidebar's account block.

What it could not see:

**The focus ring was invisible on every dark surface.** `--green` is 6.42:1 on paper and **2.53:1** on the sidebar, under 1.4.11's 3:1. A keyboard user could not see where they were in either navigation. axe does not test focus indicator contrast at all.

**Contrast was checked against the wrong surface.** Two dark-mode tokens passed against `--ink` and failed on `--ink-raised` and the current nav item. The habit worth keeping: *a colour token is safe on the lightest surface it lands on, not the one it was tested against.*

**`aria-modal="true"` made a promise the behaviour did not keep.** The builder's dialogs had the correct attributes and no focus management at all — Tab walked out into a page that was still rendered, still clickable, and no longer visible to the person using it. axe passed them because the attributes were right. This is the sixth instance in this project of *present in review, absent at runtime*, and the first in the interface.

Fixing it produced three sub-findings, each a general trap:

- `useEffect(..., [onClose])` with an inline arrow tears down on every parent render, so the cleanup restored focus mid-life to a control inside the dialog.
- `document.activeElement` on mount does not find the opener, because **the button that opened the dialog disables itself while the request runs**, and a disabled button drops focus to `<body>` immediately.
- Focusing the dialog on mount worked in a real browser and failed headless, because the parent re-renders the instant the in-flight flag clears. That is a race, not a test artifact.

**Two things only a mouse could do,** a missing skip link, a placeholder standing in for a label, and status messages — the builder's save state and error tally, the console's sign-in error — that changed without anyone being told.

## What is still not met

Named rather than implied. **No screen-reader testing:** everything above is code inspection plus automated checks, and a gate claimed without hearing the thing read aloud is a claim about markup rather than about use. No zoom or reflow testing at 400%. No Windows High Contrast. The landing page is outside the gate's four flows and unaudited. One dialog restores focus to the page rather than to its opener.

On observability: there are no traces in the OpenTelemetry sense and no metrics — §10.1 asks for both. What exists is the identifier chain the gate names, structured logs behind `PATFORM_LOG=json`, and the support view.

## Evidence

`npm run spike`, *Every action traces back to the request that caused it, across the worker boundary*: one submission produced 1 event, 1 job and 3 action runs, all carrying the same id and none unattributed, with the actions running in a later drain that knew nothing about the submission. A timer firing got an id of its own. Asking by request id found one record; an admin of another workspace asking the same id found none.

`npm run a11y`: no automated violations across the respondent form and its error state, console sign-in and its error state, the operator queue, the record panel, Ask, the builder, and the publish dialog — plus a behavioural check that the dialog is labelled, takes focus, and closes on Escape.
