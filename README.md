# Process blueprint schema and compiler

The first artefact for the LogaXP AI process platform, per §23 week 2 of the product document: *"define the process blueprint schema and compile three real processes by hand"* → *"schema v0.1 and failure cases."*

This is not the product. It is the typed representation everything else in the product hangs off — the thing the AI proposes, the compiler validates, the editors edit, the runtime executes, and the versioning system pins. Getting it right costs days. Getting it wrong costs the architecture.

## What is here

```
src/blueprint/     the schema — ten sections, two expression languages, no executable code
src/compiler/      the rules that decide whether a blueprint may be published
processes/         three real processes, compiled by hand
tests/             the compiler's regression suite
docs/              schema reference, and what broke while hand-compiling
schema/            generated JSON Schema for AI structured output
```

## Why a compiler and not a validator

A schema check tells you a blueprint is well-formed. It does not tell you the process works.

All three faults found while writing the reference processes passed the schema and would have passed a visual review:

- a blocking safeguarding check that nothing waited for, so a volunteer could reach approval without it
- an SLA with no timer behind it, reporting breaches the process could not act on
- a reminder addressed to a current assignee in a workflow that never assigns, which would have been logged as delivered

Those are now rules. The full account is in [docs/failure-cases.md](docs/failure-cases.md).

## The three reference processes

| Process | From | Exercises |
|---|---|---|
| [employee-onboarding](processes/employee-onboarding.blueprint.json) | §4.3, and the acceptance scenario in §20.1 | Two sequential approvals, clarification loop, parallel provisioning, PDF generation, restricted payroll data |
| [church-worker-onboarding](processes/church-worker-onboarding.blueprint.json) | §4.1 | Conditional safeguarding gate, external-evidence pattern, lapse timers, two approval levels |
| [expense-approval](processes/expense-approval.blueprint.json) | §4.4 | Repeating groups, calculated totals, threshold routing, auto-approval under £100 |

All three compile with zero errors and zero warnings. [`_broken-example`](processes/_broken-example.blueprint.json) compiles to 36 errors and 8 warnings and exists so the rules stay proven.

## Run it

```bash
npm install
npm test
npm run check
```

## Where this fits

§21 puts the typed process schema and compiler at **P0**, and AI generation at **P1**. Hand-compiling supports that ordering strongly: a generator without a compiler produces confident, plausible, broken processes. The compiler is what makes generated output safe to publish, and it is useful on its own before any AI exists.

Open questions the schema cannot yet express — parallel task joins, approval quorums, quantifiers over repeating groups, date-relative timers, separation of duties — are listed with recommendations in [docs/failure-cases.md](docs/failure-cases.md). None of them blocks a design-partner demo.
