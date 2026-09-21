# Patform

An AI process platform by LogaXP: describe a process, and get the form, approvals,
reminders, documents and dashboard built together — then run together afterwards.

This repository is the core of it, built in the order §23 of the product document
recommends. It starts at §23 week 2: *"define the process blueprint schema and compile three real processes by hand"* → *"schema v0.1 and failure cases."*

This is not the product. It is the typed representation everything else in the product hangs off — the thing the AI proposes, the compiler validates, the editors edit, the runtime executes, and the versioning system pins. Getting it right costs days. Getting it wrong costs the architecture.

## What is here

```
src/blueprint/     the schema — ten sections, two expression languages, no executable code
src/compiler/      the rules that decide whether a blueprint may be published
src/runtime/       the workflow engine: outbox, idempotency, timers, policy, scenarios
src/ai/            generation: two providers, a versioned prompt, three gates
src/api/           the console API: session cookies, scrypt passwords
src/worker.ts      the durable worker — without it, no deadline ever fires
src/seed.ts        a workspace that looks like a Tuesday, for the console
web/               the landing page, and the operator console at /console
src/spike.ts       eight proofs that the runtime behaves as the document requires
src/eval.ts        scores generation against the section 7.4 release gates
evals/             curated cases, including one that tries to inject an instruction
processes/         three real processes, compiled by hand
tests/             the compiler's regression suite
docs/              schema reference, failure cases, and architecture decisions
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
npm test          # compiler rules
npm run check     # compile every process
```

To run the runtime proofs you need a PostgreSQL 17 database. Either start a
throwaway one:

```bash
npm run db:up && npm run spike
```

or point `DATABASE_URL` in `.env` at a [Renviq](https://renviq.com) connection
string and run `npm run spike` against managed Postgres. Nothing in the runtime
is specific to either.

## The runtime spike

Section 23 week 3 asks for a spike of workflow state, timers, idempotent email,
versioning, and migration, producing architecture decision records and
performance evidence. `npm run spike` is that, and it proves eight things:

| Proof | Result |
|---|---|
| Every blueprint's own scenarios run against the real engine | 21/21 across three processes |
| Authorization is enforced by the runtime, not the caller | cross-tenant, wrong capability, and un-named approver all refused |
| Idempotent email under replay | 3 deliveries, 1 email |
| Concurrent workers never double-process | 8 workers, 40 instances, 40 emails, 0 duplicates |
| A dead worker loses nothing and duplicates nothing | recovered after the visibility timeout, 1 email |
| Timers fire once, on time, cancelled on exit | nothing at +47h, once at +49h, nothing on a second sweep |
| A double submission makes one case | 2 concurrent submissions, 1 instance, 1 receipt |
| Published versions cannot be edited | refused by the database, not by convention |
| Submission and workflow start are inside the §10.4 budget | ack p95 15ms against a 1500ms budget |

Decisions and their trade-offs are in [docs/adr/](docs/adr/).

## The operator console

```bash
npm run db:up && npm run seed && npm run api    # API on 3310
npm --prefix web run dev                        # console at localhost:3210/console
```

§8.2's four questions — what arrived, what needs you, what is late, what
failed — over the real engine. Sign in with any seeded account; `npm run seed`
prints them. Who you sign in as is the most useful control on the screen:

| Signed in as | Sees |
|---|---|
| Joy — hr_admin / admin | 5 tasks, including ones assigned to other roles (break-glass) |
| Priya — hiring_manager / approver | 2 approvals, 0 tasks, and no automation panel at all |
| Ini — it_operator / operator | only the 2 IT tasks, not HR's |
| Dana — hiring_manager / read_only | refused: *not named as an approver on this request* |

## What is not built

Named here rather than implied by silence:

- **Email verification, MFA, OAuth/OIDC, password reset.** Sign-in is a scrypt
  password and a session cookie; §12.1's other authentication rows are not done.
- **Rate limiting and spam control on public submission** (§12.3).
- **Malware scanning and upload quarantine** (§12.1). Files are metadata only.
- **A real email provider.** `email_log` records what would be sent. Wiring SES
  means passing `action_run.id` as the provider's idempotency key (ADR-0002).
- **Parallel task joins, approval quorums, date-relative timers, separation of
  duties** — the v0.2 list in [docs/failure-cases.md](docs/failure-cases.md).

Open a record as Priya and the payroll fields come back `hidden from your
role` — the same `hiddenFields` the blueprint declares and the compiler
validates.

## Generating a process

```bash
npm run generate -- "describe a process in plain English" --provider anthropic --run
```

A description becomes a blueprint or a refusal. Three gates, in order: Zod
decides whether it is a blueprint at all, the compiler decides whether the
runtime could execute it safely, and the blueprint's own scenarios decide
whether it does what it claims. Failing a gate buys one repair with the
diagnostics fed back. Failing twice publishes nothing.

Claude and OpenAI each sit behind the provider interface in their own file with
their own SDK. Adding a third is a file and a case.

```bash
npm run eval -- --provider anthropic
```

scores generation against §7.4's release gates. Its control assertions test the
one thing the compiler structurally cannot: **a model that classifies a bank
account as `internal` produces a blueprint that compiles clean, passes every
scenario, and emails salary details to a line manager.** No compiler rule
catches that, because the compiler knows what shape a field is and not what it
means. See [docs/adr/0006](docs/adr/0006-the-ai-boundary.md).

## Where this fits

§21 puts the typed process schema and compiler at **P0**, and AI generation at **P1**. Hand-compiling supports that ordering strongly: a generator without a compiler produces confident, plausible, broken processes. The compiler is what makes generated output safe to publish, and it is useful on its own before any AI exists.

Open questions the schema cannot yet express — parallel task joins, approval quorums, quantifiers over repeating groups, date-relative timers, separation of duties — are listed with recommendations in [docs/failure-cases.md](docs/failure-cases.md). None of them blocks a design-partner demo.
