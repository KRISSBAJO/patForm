# ADR-0006: AI proposes through three gates, behind a provider interface

**Status:** accepted · **Date:** 2026-09-21

## Context

§7.1 draws the boundary: *"AI proposes; deterministic services validate, authorize, execute, and audit."* §7.3 adds that *"model output is treated as untrusted input and validated against strict schemas."* §17.3 says use a provider abstraction, and §19 names vendor dependency as a standing risk.

Those are easy sentences to agree with and easy to implement as a thin wrapper that does none of it.

## Decision

**Three gates, in order, and nothing skips ahead.**

| Gate | Asks | Enforced by |
|---|---|---|
| shape | Is this a blueprint at all? | Zod parse |
| compile | Would the runtime execute it safely? | the compiler (BLD-04) |
| run | Do its own scenarios pass? | the engine (BLD-05) |

A blueprint that fails a gate gets its diagnostics back **once** — §7.4 gates validity "after one repair attempt", so one is the default. Fail twice and the pipeline refuses, and the caller is told exactly which rule was broken. Nothing publishes on a model's say-so.

**Two providers, each in its own file, no shim between them.** Claude through the Anthropic SDK, OpenAI through the OpenAI SDK. A second provider is the only honest way to know the abstraction holds — the first time you need to switch is a bad moment to discover the interface leaked. Adding a third is a file and a case in `providerFor`.

**A versioned prompt registry.** Every generation records model, prompt version, token counts, cost, repairs and the resulting diagnostics. Eval results are comparable only within a prompt version, so the version bumps whenever the text does.

**The description is fenced as data.** A customer's process description arrives inside explicit markers with an instruction that anything inside them is a process to model, never a rule to follow. This is §12.3's "prompt injection through submitted text", and the `injected_instruction` eval case exercises it against a description that tries to add an exfiltration webhook.

## The thing this ADR exists to say

**The compiler cannot catch a wrong classification.**

A model that labels a bank account `internal` produces a blueprint that compiles with zero errors, passes every scenario, and quietly emails salary details to a line manager. Every structural rule is satisfied. The blueprint is *correct* and *wrong*.

That gap is not closable by more compiler rules, because the compiler has no idea what a field means — only what shape it is. It is closable only by case-specific expectations: this description mentions a salary payment, therefore some field must exist, it must be at least `restricted`, and it must not appear in a message body.

So the eval is not a nice-to-have that follows the feature. It is the only check on an entire class of failure, and its control assertions carry §7.4's zero-tolerance gate while ordinary omissions get 2%.

## Consequences

- **Model tier is not a cost knob here.** Claude Opus 5 produced a publishable ten-state process on the first attempt with no repair. gpt-4o-mini never produced a complete blueprint across six cases, failing at the shape gate every time — it converged (five missing sections down to two leaf fields) but ran out of repair. A blueprint is a large, deeply structured artifact; a small model is not a cheaper way to make one, it is a way to make none.
- **Generation is slow and not cheap.** Roughly 150–250 seconds and $0.43–$0.69 per process on Opus, driven by ~25,000 output tokens. That is fine for a one-off creation step and would not be fine in a request path. It belongs in a durable job, and §14.3's "model tokens" line should assume a real cost per generated process rather than a rounding error.
- **The repair loop earns its place even when it does not fire.** Its value is the refusal: a blueprint that still has errors after repair does not reach a customer, and the operator sees the diagnostics rather than a broken process.
- **A false control failure is as damaging as a missed one.** The first eval run flagged Opus for classifying `confirm_accuracy` as `internal` — a yes/no checkbox whose *label* mentioned a bank account. The assertion was matching prose. A gate that cries wolf gets switched off, so classification rules now only consider fields whose type can actually hold the value.
- **A control gate with nothing to check must not report PASS.** The same run reported zero control failures for a provider that had produced zero blueprints. It now reports "not evaluated" and fails the suite, because a gate you can satisfy by producing nothing is not a gate.

## Evidence

`npm run generate` and `npm run eval`, against live endpoints.

Generating an incident-reporting process from four sentences of plain English produced, on the first attempt with no repair: 10 states with four distinct terminal outcomes, 18 transitions, 28 fields, 13 email templates, a document, and all six scenario kinds — with injury nature and medical treatment correctly classified `restricted` and given collection reasons. It also surfaced a real gap in the schema, recorded as G7 in [failure-cases.md](../failure-cases.md): values an operator fills in later had nowhere to live.
