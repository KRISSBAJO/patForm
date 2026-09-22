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
src/api/           the API: public form, console, session cookies
src/runtime/intake.ts   the respondent side: form, draft, submit, status
src/runtime/pdf.ts      a PDF writer; no browser, no dependencies
src/runtime/email.ts    delivery, through RelyKit or the console
templates/         document templates, in the HTML subset pdf.ts accepts
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
performance evidence. `npm run spike` is that, and it proves seventeen things:

| Proof | Result |
|---|---|
| Every blueprint's own scenarios run against the real engine | 21/21 across three processes |
| A form can be filled in, saved, submitted and amended when asked | §20.1 steps 4 and 6, end to end |
| Documents are real files, and email actually leaves | §20.1 step 8: one PDF, one send, refusals recorded |
| Authorization is enforced by the runtime, not the caller | cross-tenant, wrong capability, and un-named approver all refused |
| A resume link opens one record and no others | somebody else's record refused, revoking the link kills it |
| A draft opens, refuses to publish while broken, and says what a publish would change | operator refused, SEC009 blocks publish server-side, impact counts the in-flight record |
| The operator asks what is overdue and sends a reminder matching what they confirmed | §20.1 step 9: a typed plan, a bound digest, 3 sent and a replay sending 0 |
| An administrator exports the record with its history, and only then is it deleted | §20.1 step 11: same checksum twice, fields withheld and named, then retention |
| A worker fires deadlines with nobody watching | 49 hours passed, 1 reminder, 0 timers left unfired |
| Retention deletes, only for an administrator, and says what it removed | preview first, then 1 instance and 1 event, against an append-only history |
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

## The builder

```bash
npm run db:up && npm run seed && npm run api    # API on 3310
npm --prefix web run dev                        # builder at localhost:3210/builder
```

§20.1 step 3 — change a field and an approval threshold, resolve the warnings,
publish. Sign in as Joy (`hr_admin / admin`); an operator is refused, because
`administer` is what lets you rewrite a process rather than run one.

The third column is the point. It is the compiler, it never collapses, it
updates on every keystroke, and clicking an entry selects what caused it —
renaming one field key produces thirteen errors naming the form page, both
approvals, the document placeholder and the scenario tests, and greys out
publish until they are gone.

- **Test** runs the blueprint's own scenarios against the real engine in a
  scratch workspace — the same policy checks, the same effects, nothing
  simulated.
- **Publish** shows what changes first: fields added, removed or retyped,
  states added or removed, any data the removed fields strand, and how many
  records are still running. Those stay on the version they started under,
  which is safe and surprising enough to be worth a number on the screen.
- A draft that does not compile is still saved. Nothing you type is lost
  because it is currently invalid.

Fields, states, approvals, tasks and roles have form editors. Intent, the form
experience, transitions, messages, documents and tests are edited through the
JSON tab — a stated gap, not a hidden one. There is no draft locking yet, so
two people editing the same process will overwrite each other.

## Asking the process

```bash
npm run db:up && npm run seed && npm run api && npm run worker
npm --prefix web run dev                        # console at localhost:3210/console
```

§20.1 step 9, under **Ask**. Type a question; you get back what the system
understood, the records it matched, and — when the question asked for
something to be done — exactly who each message would reach, before a button
appears.

**The model never touches the database.** It emits a typed plan
([src/copilot/plan.ts](src/copilot/plan.ts)) from a closed set of filters, and
a compiler resolves every key against the blueprint and writes the SQL itself.
Values arrive as parameters; field keys are parameters too, so a key cannot
become a column. Press *Show the plan this ran* to see it — the model wrote
that, not the query.

This matters more than it first sounds. The records being asked about contain
text that respondents typed, so the model reads attacker-controlled input every
time it answers a question. The planning step is given the process schema and
not one answer.

Three refusals worth knowing:

- **A restricted field cannot be filtered on.** "Which records have a national
  insurance number starting QQ" reads restricted data one yes/no at a time and
  never displays it, so redaction never gets a turn. `QRY004`.
- **An action cannot carry a message.** A reminder names a template from the
  blueprint. There is no body and no recipient override; the schema refuses
  both.
- **The confirmation is bound to the plan.** The preview hashes the plan with
  the exact ids it resolved, and execution works from that list rather than
  re-running the query. A record that becomes overdue between preview and
  confirmation is not swept up — you confirmed eleven records, not "whatever
  matches when I press the button".

Confirming twice sends once, via the same idempotency key the workflow's own
actions use. Every run leaves a `copilot_run` row carrying the model, prompt
version, plan, targets, confirmation and result (§7.3).

## Exporting a record

§20.1 step 11, the **Export** button on any record. JSON or CSV, containing the
record, its full audit history, every decision with its stated reason, every
message, and every document with its checksum.

- **Redaction applies.** An export is a read. An administrator who also holds a
  process role that hides payroll fields gets a file without them, and the
  bundle *names* what was withheld rather than quietly being shorter.
- **The checksum is stable**, so a file you were handed can be checked against
  the system later. It covers the record, not the log of who has copied it.
- **The export is itself an event** on the record's history.

Then `npm run retention` applies the configured action. The order in that
sentence is the requirement: retention deletes the record and its events, so
afterwards there is nothing left to export.

## The respondent side

```bash
npm run db:up && npm run seed && npm run api && npm run worker
npm --prefix web run dev
```

`/f/employee_onboarding` is the public form: multi-page, conditional sections,
autosave with a resume link in the address bar, and a status page at
`/f/status?resume=…` where a respondent answers a request for changes.

Two properties worth knowing:

- **A draft is not a record.** Half-finished forms never become instances, so
  abandonment does not create work for an operator or distort the intake count.
- **The browser holds no rules.** The API serves each field's constraint
  *values* and the renderer turns them into native HTML attributes;
  `validateAnswers` on the server is what decides. One source of truth, two
  enforcers, nothing to drift apart.

## What is not built

Named here rather than implied by silence:

- **Email verification, MFA, OAuth/OIDC, password reset.** Sign-in is a scrypt
  password and a session cookie; §12.1's other authentication rows are not done.
- **Rate limiting and spam control on public submission** (§12.3).
- **Malware scanning and upload quarantine** (§12.1). Files are metadata only.
- **A verified sending domain.** Delivery needs two switches to leave the
  machine: `EMAIL_PROVIDER` naming a provider *and* that provider's
  credentials. Without both, everything is logged and nothing is sent.
  `spike`, `seed` and `eval` ignore the setting entirely and say so on stdout —
  a test harness reading the same `.env` as the server will otherwise mail real
  people the day somebody configures a provider.
- **DOCX rendering.** HTML templates become PDFs; a blueprint asking for DOCX
  gets a document that says so rather than a silently incomplete one.
- **Object storage for documents.** The bytes live in Postgres, which is fine
  at a packet's size and wrong at scale (§10.1).
- **Bounce and complaint handling.** `email_log` has the statuses; nothing
  consumes the provider's webhooks yet, so nothing moves past `sent`.
- **Bulk assignment and status changes.** The copilot's action schema names
  `assign` and `change_state`; the compiler refuses both with `ACT001`.
  Reminders are the only bulk action the runtime performs.
- **A graph editor for transitions.** The builder has form editors for fields,
  states, approvals, tasks and roles; everything else goes through its JSON
  tab. There is also no draft locking, so two people editing one process will
  overwrite each other.
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
