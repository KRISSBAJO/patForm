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

**Updating templates in a running workspace.** The catalogue is generated
from `src/packs/catalogue.ts`. After changing it, `npm run packs -- --catalogue`
publishes a new version of each template that changed and leaves the rest
alone, without a re-seed. Workspaces that installed the older version keep it.

**Signatures.** A `signature` field lets the person type their name and adopt
it in one of three handwriting styles, or draw it with a mouse, finger or pen
(using `signature_pad`). The printed name is always part of the value. Every
Finance template that asks for money ends with one. It is evidence of who put
their name to the record and when, not a qualified electronic signature.

The spike drops and recreates the schema before every proof. If the app is
running against the same database, that signs everybody out and empties the
workspace. Set `PROOF_DATABASE_URL` to a second database (on the local
container, `create database patform_proofs`) and the spike uses that instead.

## The runtime spike

Section 23 week 3 asks for a spike of workflow state, timers, idempotent email,
versioning, and migration, producing architecture decision records and
performance evidence. `npm run spike` is that, and it proves twenty-one things:

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
| Every action traces back to the request that caused it | §20.2 observability: the link survives the worker boundary and a restart |
| A privacy request erases one person without destroying anybody else | §20.2 privacy: the manager named on somebody else's form is redacted, not deleted |
| A webhook actually leaves, is signed, survives a rotation, dies in a dead letter, and replays | §11.2, against a real HTTP server that verifies the signature itself |
| A workspace can be created and joined, and nobody can grant more than they hold | IAM-01, IAM-04, IAM-05: escalation, last owner and session revocation all refused |
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

Fields, states, automation rules, approvals, tasks, messages and roles have
form editors. Intent, most of the form experience, documents and tests are
edited through the JSON tab — a stated gap, not a hidden one.

**Messages** are edited as the email they become: who it goes to and who is
copied in, subject and body, a picker that puts a `{{field}}` at the cursor,
and a preview that shows each placeholder as the field it will be filled
from. Restricted fields are not offered; confidential ones say who they may go
to. What the compiler says about a message appears on the message itself,
and the editor lists which rules send it — or says that nothing does, so it
will never leave. Renaming a message's key renames it in the automation and
the tests that refer to it. A message's skip condition is still JSON.

Two people cannot overwrite each other. Opening a draft claims it for two
minutes, renewed while the tab is open; anyone else who opens it sees who has
it and a read-only editor, with **Take over** for when that person has walked
away. Underneath the lease, every save and publish names the revision it was
made against, and one that has fallen behind is refused with the name of who
saved since — the unsaved change stays in the tab, and can be copied out as
JSON. Every draft route checks `administer`, not only the one that opens it.
See entries 71 and 72 in [docs/failure-cases.md](docs/failure-cases.md).

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

### Bulk actions

§6.4: *"Bulk actions require permission checks per record, an impact preview,
rate limits, and result report."* Four actions, from two places — tick rows
on **Records**, or ask for it in **Ask** — through the one path above: preview,
confirm the exact set, report.

- **Send a message** — a template from the process, to its own recipients.
- **Give a task to someone** — an open task on each record, to a member or a
  role. An administrator's call, checked per record, as reassigning somebody's
  work always was here. The new assignee is checked once against live
  membership: somebody deactivated, or holding nothing that can operate the
  process, is refused on every row rather than handed work they cannot open.
  The old assignee loses the ability to complete it; the record says who it
  was taken from. Whoever now has the work gets **one** email per bulk
  action listing every record — not forty for forty tasks — with a link to
  each and no answers in it; a role is told through the members who hold it.
  The report says who was emailed, and who could not be and why.
- **Move to a state** — by the process's own manual steps only, never a raw
  state write, so the step's role list, condition, emails and tasks all
  apply. A record whose state has no manual step to the target is left alone
  and told why. A target nothing leads to by hand does not compile (`ACT007`).
- **Change an answer** — one field to one value, through the same edit path a
  single change takes: the role must list the field in its `editableFields`,
  calculated fields are recomputed, deadlines hung off a changed date move,
  and a "record updated" step can fire. The value is checked by the form's own
  validator before anything is previewed (`ACT009`, `ACT010`), and the preview
  shows each record's current value, where the member may see it.

  **Lists change by one item.** A multi-select can have one option **added**
  or **removed** — "give everybody a monitor" adds it to what each record
  already has, and leaves alone the ones that have it — or be **replaced**
  outright. The add or remove is worked out again inside the record's lock at
  write time, so it lands on what the record holds then, not on what the
  preview saw. A **repeating group** can only have a row **added**, checked
  column by column; rows have no identity across records, so replacing or
  removing one would be a guess (`ACT011`). Adding a row recalculates totals
  built from it — an expense claim's total, and so where it is routed — just
  as a single edit would. Addresses are text and are set like text. Which of
  these a person is offered still comes from their role's `editableFields`:
  in the shipped processes no staff role may edit line items, so that option
  appears only where a process grants it.
  Every edit, single or bulk, now keeps what it replaced in the record's
  history; before, the event named the fields and not their old values.

The preview sorts every selected record into *will change*, *left alone* (and
why) and *not allowed* (and why). The report does the same for what actually
happened, because a role can be removed between the two and each record is
checked again when it runs. At most 200 records per action, and previews
count against the same twenty-an-hour limit as questions. A preview from the
console is recorded like a question, so it can be confirmed only by the person
who previewed it and only against the digest they saw.

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

## Recovering from a backup

```bash
npm run drill
```

§20.2's recovery gate, as an exercise rather than a runbook. §10.4's targets —
RPO 15 minutes, RTO 4 hours, quarterly drill — were numbers nobody had
measured, and nothing had ever restored this system.

Seven steps: a backup can be taken at all, it completes inside the RPO, the
restore completes inside the RTO, the restored database matches the source on a
content hash of every table, the immutability triggers survive, replaying jobs
finishes the unfinished and repeats nothing else, and the RPO window is
measured.

Nothing touches the source but the drill's own records. The restore goes to a
scratch database that is dropped at the end, and delivery is suppressed first,
because a recovery exercise that emails customers is an incident.

**It found that the backup command on this machine produced no backup** —
`pg_dump` 16.4 refuses a 17.11 server. That is invisible until somebody tries,
which is the argument for a drill.

The last step is the one to read aloud:

> A record submitted after the backup is absent from the restore, along with
> the message it had already sent. The window is not only lost data — those
> messages reached real inboxes, and the restored system has no memory of
> having sent them, so it will send them again when the work is redone.
> **Anything with an external effect inside the window happens twice.**

Fifteen minutes of RPO is fifteen minutes of duplicate email, not fifteen
minutes of missing rows. Evidence is written to `docs/recovery-drill.json`.

## Diagnosing a stuck record

```bash
npm run support -- <record-id | request-id> --as <actor-id>
```

§20.2's observability and supportability gates. Four of the five identifiers
the gate names already existed; the request id did not, so they were four
separate facts that happened to be about the same thing.

Every inbound call opens a request id, returns it in `x-request-id`, and stamps
it on every event, outbox job and action run it causes — **including the work a
worker performs minutes later in another process**, because the id travels on
the outbox row. A caller may supply their own (§11.1); a timer gets one of its
own, since a deadline is its own cause.

The trace answers in a sentence first:

```
Retrying: "submit" has failed 4 time(s) and will be attempted again
  — HRIS rejected the webhook: 401 Unauthorized.
```

then lists each step with its event, job, attempts, action runs and results.
Both directions work: one record end to end, or everything one request caused
across every record it touched. Also at `/api/records/:id/trace` and
`/api/trace/:requestId`.

It takes a principal and shows what that person may see, because a support tool
that bypasses authorization is a psql prompt with better formatting. Structured
logs are behind `PATFORM_LOG=json`, and carry identifiers rather than answers —
a log is somewhere with different retention and no redaction.

## Accessibility

```bash
npm run a11y
```

§20.2's gate: WCAG 2.2 AA across the builder, respondent, approval and operator
flows. Audited with axe-core plus manual review; the record is in
[docs/accessibility.md](docs/accessibility.md).

**axe found two violations. Six of the eight real problems came from reading.**
That ratio is the useful part:

- The focus ring was **2.53:1 on both dark sidebars**, under WCAG 1.4.11's 3:1.
  A keyboard user could not see where they were. axe does not test focus
  indicator contrast at all.
- Two colour tokens were verified against `--ink` and failed on the lighter
  dark surfaces they were also used on. A token is safe on the lightest surface
  it lands on, not the one it was tested against.
- The builder's dialogs had `role="dialog" aria-modal="true"` and **no focus
  management whatsoever** — Tab walked out into a page that was still rendered,
  still clickable, and no longer visible to the person using it. axe passed
  them, because the attributes were correct.

Not met, and named rather than implied: no screen-reader testing, no zoom or
reflow testing, no Windows High Contrast, and the landing page is outside the
gate's four flows.

## Privacy

```bash
npm run data-map -- --as <actor-id>
npm run erase -- someone@example.com --as <actor-id> [--apply] --reason "..."
```

§20.2's privacy gate. The review is in [docs/privacy.md](docs/privacy.md) —
data map, retention, subprocessors, terms, deletion workflow.

**The data map is derived, not written.** A hand-maintained one is right on the
day it is written and wrong by the next publish. Everything it needs is already
declared, so it is a query: purpose, subjects, retention, and per field its
classification, who supplies it, why it is collected, who it is hidden from,
and **every route by which a value can leave the record** — an email
placeholder, a document, a webhook, a CSV export, an approval's context panel.
That last column is the one a written data map always gets wrong.

On its first run it found six confidential fields with no stated reason for
being collected, and a restricted workplace-adjustment field **hidden from
nobody** — readable by the IT operator setting up a laptop. Nobody had decided
that. It is now a compiler warning (`SEC010`).

**Erasure is not retention.** Retention deletes by age; a privacy request
deletes by person, and a person can appear in a record that is not about them.
The hiring manager named on a new hire's form is a data subject in somebody
else's record:

- **subject** — the record is about them, so it is deleted with its history.
- **mentioned** — they are named in somebody else's record, so only the fields
  naming them are redacted to `[erased]`. The record still shows a manager was
  asked and approved; removing the key would make the audit read as though
  nobody ever was.

Previews by default, `--reason` required to apply, a record still running is
left alone, and `erasure_run` is written before the deletion so the account
outlives the data.

**It does not reach backups.** The recovery drill proves those restore
faithfully, so an erased person is in every backup taken before the request.
That is a retention schedule, not a delete, and the CLI says so after every run
rather than leaving somebody to remember.

## The public API

```bash
npm run public-api                                   # /v1 on 3320
npm run keys -- issue "CI" --as <actor-id> --scopes view,edit
```

§11.1, versioned under `/v1` in its own process. The console's API is called by
a page that ships with it and can change with it; this is called by somebody
else's build, which cannot — so a console route cannot become a public promise
by being reachable. OpenAPI at `/openapi.json`, served by the API so it cannot
describe a deployment other than the one answering.

| | |
|---|---|
| Auth | Scoped API key, `Authorization: Bearer pat_live_…`. Never a cookie — that would make every endpoint reachable from a browser carrying a console session. |
| Scopes | A key carries a subset of its creator's capabilities, intersected again on every request, so it cannot outlive the authority it came from. |
| Permissions | **Hidden fields are omitted, not masked.** `data.bank_account` is absent and named in `omitted_fields`. A consumer that got `"[redacted]"` would store it. |
| Pagination | Cursor, not offset. An offset skips and repeats rows while records are being created underneath you. |
| Idempotency | `Idempotency-Key` on any POST, stored so it survives a restart. Reusing a key with a different body is a 409, not a silent replay. |
| Filtering | Explicit. An unrecognised filter is a 422 — silently returning everything when a caller asked for a subset is how an integration leaks. |
| Rate limits | Per key *and* per workspace, with `X-RateLimit-*` on every response. |
| Errors | One shape, with `X-Request-Id` on all of them. |

## Dashboards, records and CSV import

**Dashboard** and **Records** in the console; §13.1's nine metrics and a
cursor-paged browse.

Everything is computed from the event log at read time. There is no aggregate
table, which is slower and satisfies §13.2's "derived aggregates can be
rebuilt" by construction rather than by a rebuild job somebody must remember.

Two of §13.2's rules shape it more than the arithmetic:

- **Definitions travel with the numbers.** A completion rate means nothing
  without knowing what counted as eligible. Click any tile to read it.
- **Small cohorts are suppressed.** A rate over fewer than five records is
  withheld, and the tile shows *why* where the number would be — a dash reads
  as zero, and this means something quite different.

**CSV import** goes through `validateAnswers`, the same function the public
form uses. An importer with its own idea of what is valid is a second front
door with a weaker lock. One bad row refuses the whole file by default: a
hundred-row spreadsheet with four bad rows should not become ninety-six records
and a puzzle.

## The public form has a budget

§12.3. The form is the one door with no credential on it — that is the point of
it — so the budget is the whole defence between a published process and an
unbounded write loop.

| Route | Per minute | Per hour |
| --- | --- | --- |
| `GET /api/forms/:key` | 60 | — |
| `POST /api/forms/:key/check` | 120 | — |
| `POST /api/forms/:key/draft` | 30 | — |
| `GET /api/forms/:key/draft` | 60 | — |
| `POST /api/forms/:key/submit` | **5** | **20** |

Reading and checking happen on most edits of a conditional form, so a limit a
careful respondent can reach breaks the product rather than protecting it.
Submitting writes a record, sends mail and starts a workflow, which is the one
worth being mean about.

**`x-forwarded-for` is counted, not trusted.** The header is written by whoever
is calling. Believe it and per-caller limiting is free to defeat — a random
address per request is a new caller every time. Refuse to read it and every
request behind a load balancer looks like it came from the balancer, so one
person's budget is everybody's. `TRUST_PROXY` says how many proxies are in
front; the caller is that many entries from the right, which is the first
address this process did not observe itself. The default is `0`: no proxies,
use the socket, believe nothing in the headers.

It shares the counter the API keys use, so `REDIS_URL` makes the limit real
across processes and its absence makes it per-process. **It fails open**, for
the reason below: a limiter that refuses everything when its counter is
unreachable has turned a cache outage into an outage.

A refused request is a `429` carrying `Retry-After` and the `x-ratelimit-*`
headers, all of which are in `access-control-expose-headers` — a respondent's
browser that cannot read why it was refused shows a form that looks broken.

### Sending health

Single bounces were already handled: a hard bounce or a complaint suppresses
the address, and nothing is sent to it again. Nothing watched the **rate**,
and the rate is what the provider suspends an account over. RelyKit sends
through Amazon SES, which reviews an account at a 5% hard-bounce rate or a
0.1% complaint rate — and a paused account stops every message from every
workspace, password resets included.

The worker now measures both over seven days, across process mail and the
platform's own messages, because the provider sees one account. It raises an
alert at **watch** (2% / 0.05%) and again at **act** (5% / 0.1%), once each,
and says when it has recovered — an alert that repeated every minute would be
muted by the day it mattered. Each change is a log line and, when
`OPS_ALERT_EMAIL` is set, an email naming the templates and workspaces the
problems came from. Below fifty messages it reports *too few to judge*
unless there are five or more problems outright.

Workspace admins see their own share on **Automation health**, as two rates
against the thresholds, since "2.4%" means nothing without knowing where 5% is.

**After reinstating an address**, the console lists what it missed while it
was blocked — each message now records exactly which recipients it dropped,
rather than a phrase in its failure note. Nothing is ticked for a record that
has finished, each resend is rendered from the record as it is now, and each
goes once: it has its own ledger row keyed to the original message and the
address. A resend that fails is rolled back rather than marked sent. Lifting
a suppression is limited to addresses the workspace has written to, which is
also what it can see.

**A real provider never sees a reserved address.** Every seed, proof and demo
uses `example.test`, so none of it can reach a person — which only held while
the provider was the console one. The development API runs with whatever
`.env` names, and with RelyKit configured, a test submission handed a
`.test` address to the real account: a guaranteed hard bounce on the number
this section exists to protect. Real providers are now wrapped so that
`.test`, `.example`, `.invalid`, `localhost` and the `example.*` domains are
dropped before sending, with the reason on the record.

### Telling a person from a script

A budget stops one caller making a thousand records. It does nothing about a
thousand callers making one each — and each of those used to *act* on arrival.
The onboarding form emails whatever address is typed as the manager's, so a
fabricated submission was an email from this platform to an address a
stranger chose. That is a spam relay, and it is the harm this section exists
for.

Two signals, both invisible to someone using the form:

- **A ticket.** Serving the form hands out a signed timestamp. A submission
  without one never loaded the form; one that arrives within three seconds of
  it was not typed.
- **A trap.** One extra input, off-screen, hidden from assistive tech and out
  of the tab order. A person never reaches it; a script that fills every input
  it finds fills that one too.

Neither rejects anything. A submission that fails either is **held**: kept
whole in its own table, never made into a record, so it sends nothing, starts
nothing, counts in no metric, and cannot absorb a real person's later
submission as a duplicate of itself. The response looks the same as any other,
so a script learns nothing. Operators see the queue under **Held
submissions** in the console, with why each one was held and its answers
through their usual field-level redaction. **Release** makes it a record by the
ordinary submit path, under the reference the person was shown, and its
receipt and first request go out then. **Discard** deletes the answers.
Anything left is deleted after thirty days.

Holding rather than discarding is deliberate: password managers do fill hidden
inputs, and somebody submitting a finished draft can be fast. A check that
silently threw those away would lose a real application with nobody knowing
it had arrived.

Production refuses to start without `FORM_TICKET_SECRET`, because a key that
changes on every restart invalidates every form open during a deploy and
quietly routes those people to the queue. The public API (`/v1/records`) is
not screened — its callers hold a key, which is the proof screening
approximates.

## Webhooks, OAuth and shared rate limits

```bash
npm run api && npm run worker            # the worker delivers webhooks too
```

### Webhooks (§11.2)

**These had never been sent.** `call_webhook` wrote a row with status
`delivered` and made no HTTP request; a hundred of them sat in the seeded
workspace saying delivered. A customer would have seen success in the console
and silence in their own system — the worst version of this failure, because
the evidence agrees with you.

Now: registered endpoints, real delivery through the worker, and

- **HMAC-SHA256 signing** over `timestamp.body`, in Stripe's header layout
  because an integrator has already written that verification code once. The
  timestamp is *inside* the signed string, so a captured request cannot be
  replayed next week.
- **Rotation with overlap.** Both secrets sign during a rotation, so a consumer
  redeploys at its own pace and drops nothing. A single-secret rotation is a
  scheduled outage.
- **Retry with backoff, then a terminal dead letter** at six attempts — the
  half people leave out. A delivery that retries forever is a queue that never
  drains.
- **Inspect and replay.** Replay resets the attempt budget: a dead letter fixed
  a day later deserves the full six, not one more try.
- **The payload is an intersection**, not a union — what the process declares
  *and* what the endpoint opted into, so adding a field to a process never
  silently widens what a subscriber receives.
- An event nobody subscribes to still leaves a `no_subscriber` row. Silence is
  indistinguishable from never having fired.

### OAuth 2.0 (§11.1)

Authorization code with PKCE for installed integrations, beside the API keys
for server-to-server. No implicit grant and no password grant — both removed in
OAuth 2.1, and for good reasons: implicit puts the token in browser history,
password grant makes the integration handle the customer's password.

- **PKCE on every client**, public or confidential (RFC 9700), and `S256` only.
- **Exact redirect URI matching.** Prefix matching is how an open redirect on
  the client's own domain becomes a stolen token.
- **Refresh tokens rotate and reuse is treated as theft.** A used one revokes
  the whole grant, because a race and a stolen token look identical from the
  server and only one assumption is safe.
- **Scopes are intersected with what the granting member holds *now*.** Somebody
  demoted this morning cannot leave an integration acting with yesterday's
  authority.

**The consent screen** is at `/oauth/authorize`, taking the standard query
string. It asks the server the same questions the grant asks before drawing
anything, so it only ever shows a request that would work: a made-up client,
another workspace's client, a redirect address not registered exactly, plain
PKCE or an unknown scope is an error page, and **nothing redirects**. A valid
request is shown in words — the application's name, the workspace, what it
will be able to do, what it asked for that the member does not hold and so
will not get, and the host the browser goes to next. Signed out, it asks you
to sign in and brings you back. **Deny** returns `access_denied` with the
state, to the registered address only; **Allow** returns the code. The page
cannot be framed by another site (`frame-ancestors 'none'`, and the console and
builder get the same), and sends no referrer.

The first screen here drew a consent page for any request and sent Refuse to
whatever `redirect_uri` the link carried — an open redirect under this domain.
`/authorize` now forwards to the new screen. See entry 79 in
[docs/failure-cases.md](docs/failure-cases.md). A proof covers the flow end to
end: consent, PKCE, a replayed code revoking what it produced, refresh
rotation and reuse as theft, and a demoted member's integration losing what
they lost. Nothing tested OAuth before it.

### Rate limits (§10.1)

`REDIS_URL` gives a counter shared across processes; without it the limit is
per process, which behind more than one is a limit in name only.
`X-RateLimit-Scope` says which you are hitting.

**It fails open.** A limiter that refuses everything when its counter is
unreachable has turned a cache outage into a total outage, and the thing it
guards against is less harmful than that.

## Process packs

```bash
npm run packs              # publish the built-in catalogue
npm run packs -- --list    # what is in it
```

§1.2 states the idea as a contrast: **"Templates copy a form. Process packs
include schema, workflow, messages, documents, dashboard, and policy
defaults."** That sentence is the product, so three things follow.

**A pack that does not compile cannot be listed.** Publishing runs the same
compiler a workspace's own blueprint goes through. Shipping a template that
errors on install teaches people the errors are noise, and the compiler being
believed is what this platform sells.

**The contents are computed, never written.** The card saying "20 fields ·
8 states · 2 approvals · 3 tasks · 7 messages · 1 document · 6 scenarios ·
3 restricted, 5 hidden from at least one role, kept 7 years" is derived from
the blueprint at publish time. A hand-written feature list is marketing; this
is a description that cannot drift.

**Installing produces a draft, not a live process.** §1.3's "review before
publish" does not stop applying because we wrote the blueprint — arguably it
applies more. It opens in the builder with the diagnostics panel already
pointed at it, and you decide when it goes live.

The three built-in packs are the reference processes, which is deliberate:
they have been run, hand-compiled, and carry their own scenarios, rather than
being examples written to look good.

## Slack and Teams

Register a destination with `kind: "slack"` or `"teams"` and an incoming
webhook URL. Notifications go through the **same queue as webhooks** — one
backoff, one dead letter, one replay — with a different renderer. A second
delivery mechanism would need proving separately.

**The payload is deliberately thin: a reference, a stage, a link, and only
the fields the endpoint opted into.** Never the answers. Three reasons in
order:

1. A team channel has a different audience from a record. Everyone in
   `#people-ops` can read it, and the field-level permissions that govern the
   record do not reach into Slack.
2. Chat history is retained by a third party on their schedule. Retention and
   the erasure workflow cannot reach a message already posted.
3. It survives being wrong. "Priya's expense of £4,200 needs approval" in the
   wrong channel is a disclosure; "EB9FD715 needs approval" is a nuisance.

Slack gets Block Kit with fallback text (a Block Kit message without it is
announced as "this content can't be displayed"); Teams gets a MessageCard.
Neither is signed, because neither verifies our signature — the webhook URL is
itself the credential, and signing would be theatre.

## Joining a workspace

```bash
curl -X POST http://localhost:3310/api/workspaces -H 'content-type: application/json'   -d '{"workspaceName":"Acme","ownerEmail":"you@acme.test","ownerName":"You","password":"CHOOSE-A-REAL-PASSWORD"}'
```

IAM-01 and IAM-04. Before this a workspace came from `npm run seed` and there
was **no way for a second person to get into one** — invisible in a demo,
blocking on day one of a pilot.

Three rules, each because the obvious implementation gets it wrong:

- **Nobody can invite somebody more powerful than themselves.** A `builder`
  holds `administer`, so without this it is a privilege escalation with one
  extra step: invite an owner, accept it yourself. `GET /api/members/grantable`
  returns what you may hand out, so the interface cannot offer what the server
  will refuse.
- **The last owner cannot be removed** — not by deactivation, not by
  demotion. A workspace with no owner has nobody who can invite one, and
  "contact support to get back into your own account" is the failure this
  prevents.
- **Deactivation revokes sessions in the same transaction.** `resolveSession`
  already joins on `a.active`, so they are refused on the next request either
  way; revoking means the rows are gone rather than ignored, which is what
  somebody reading the session table during an incident needs.

Invitations are single-use, expire in seven days, and only the hash is stored —
the link is the credential. The preview a stranger can read shows the workspace
name, the role and who asked, and nothing else. The token is **not** returned
over HTTP: it is emailed, and the response says `delivered` instead. Returning
it as well would let any member who can invite mint a working link for an
address whose owner never sees it.

### Two-step verification

§12.1's MFA option, as TOTP — the second factor somebody can set up in thirty
seconds with an app they already have, and it needs no vendor. Five properties
separate a real one from the appearance of one, and each is a way it is
usually got wrong:

- **Enrolment is confirmed by a code, never by generating one.** An enrolment
  that switches on when the secret is created locks out everybody whose scan
  silently failed.
- **A code cannot be spent twice.** The counter it belonged to is recorded, so
  a code read over a shoulder — or out of a proxy log — is not good for
  another thirty seconds. Including the code that confirmed enrolment.
- **Guesses are capped at five.** Six digits is a million possibilities;
  unlimited attempts make that number decorative. The counter is written
  *outside* the verification transaction, because the first version
  incremented it inside one that rolled back on every wrong code.
- **Recovery codes are single use and stored as hashes**, so a dump of the
  table is not a set of working ones.
- **Turning it off asks for the password, not a code.** Somebody holding the
  phone but not the password is exactly who must not remove the factor.
- **The secret is sealed at rest.** A second factor is only a second factor
  if a copy of the database is not enough to pass it, and the secret was
  stored as text. It is now AES-256-GCM under `MFA_ENCRYPTION_KEY`, a key
  outside the database, and each value is bound to its account, so one copied
  onto another account does not decrypt. Production will not start without
  the key. Secrets stored before this change still work and are sealed the
  next time they are used; to rotate, move the key to
  `MFA_ENCRYPTION_KEY_PREVIOUS` and set a new one, and each secret moves on its
  next use. A secret that cannot be opened is a clear refusal and an `error`
  log line — tampering or the wrong key — pointing the person at a recovery
  code. A KMS would keep the key out of the process's environment too; the
  stored format names its key, so one can be put behind it.

A correct password on an enrolled account returns a challenge token and
**sets no cookie**. The challenge is its own short-lived row rather than a
session carrying a flag: a session that exists but "does not count yet" is one
missing check away from being a session that counts.

A phone whose clock is a minute out still works. Rejecting drift is how a
second factor becomes a support queue.

**Confirm it is you.** Signing in used to be the only time anybody was asked,
so a session left open — or a lifted cookie — could issue an API key, add a
webhook that ships records elsewhere, change a role or run a deletion. Now
anything that **grants access or destroys data** needs a sign-in from the last
ten minutes: issuing an API key, adding a webhook or rotating its secret,
registering an OAuth application, inviting somebody, changing a role,
reactivating a member, setting up a new authenticator, and running a retention
deletion (not its preview). Anything that **reduces** access never asks —
revoking keys, grants and invitations, deactivating somebody, signing out
sessions — because in an incident those must be one click.

The check is in the API's dispatcher, before any handler runs, so no route can
forget it. It answers `403 reauthenticate` rather than refusing, and the
console asks for the password (and the code, if two-step is on), then sends
the same request again — the person never presses the button twice. Confirming
spends the code's window like signing in does. Five wrong answers end the
session: whoever is guessing inside it does not get to keep it.

### The catalogue

```bash
npm run packs:check
```

Eighty-eight process packs across nineteen areas — Church 10, Projects 10,
Events 10, People 9, Finance 7, IT 5, Compliance 5, Community 5, Operations 5,
and the rest. Every one compiles, and the build fails if one stops: a template
that does not compile teaches somebody that the compiler is an obstacle rather
than a check.

They are **generated, not hand-written**. Eighty-eight hand-authored
blueprints would be eighty-eight chances to get the compiler's fifty rules
wrong and eighty-eight places to fix anything the schema learns next. Each pack declares only what makes it
different — its fields, who approves, how long it is kept — and
[`src/packs/generate.ts`](src/packs/generate.ts) produces the shape they all
share:

```
submitted ─▶ in review ─▶ (second review) ─▶ done
     │            │                │
     │            └─▶ rejected ◀───┘
     └─▶ withdrawn                └─▶ expired (SLA)
```

Everything the compiler insists on — a reachable terminal state, a way out of
every state, an SLA with something that fires when it passes, six kinds of
test scenario, a reason for every restricted field — is produced once,
correctly, for all of them.

### Rules by category

The packs were honest starting points and nothing more: every one declared
*"the approval chain is a reasonable guess"* as an open decision. That is fine
for a form and not fine for a process, because the part worth having is not
the questions — it is **who decides, by when, what happens when nobody does,
and what is watched afterwards.**

So the domain rules live in [`src/packs/rules.ts`](src/packs/rules.ts), one
entry per category. A pack says what it is about; its category says how it
must behave:

| | |
|---|---|
| **Health & safety** | Looked at within a day, escalated to a director within two, kept ten years |
| **Compliance** | Assessed in two days, counsel in three, kept seven years, and it must record *when the thing happened* |
| **Finance** | Over a thousand needs a controller as well, everything kept seven years |
| **IT** | Triaged the same working day, escalated within one |
| **Customer** | Acknowledged within a day — the deadline a complaints regulator measures |
| **Church** | A week with the minister, then the senior minister |
| **Communications** | Eight hours — a journalist has a deadline whether or not anybody replies |

Three things follow, and the third is the point:

1. **Rules apply by construction.** The escalation chain, the retention floor
   and the threshold tier are generated, so a new pack cannot forget them.
2. **Changing a rule changes every pack in that category** — the only way
   eighty-eight stay consistent.
3. **Nothing can be missed.** `npm run packs:check` audits every pack against
   its category's controls and *fails the build*. On its first run it found
   four Compliance packs that recorded when something was reported and not
   when it happened — all four genuine.

The audit also checks something the compiler structurally cannot: that no
state has two outgoing timers. Entering a state cancels the previous
occupancy's timers, so a reminder loop restarts the expiry it shares a state
with, and the expiry never fires. Every pack shipped with that fault and every
one compiled — see entry 53 in
[docs/failure-cases.md](docs/failure-cases.md).

What a generator cannot do is know somebody's process. These compile and run
on day one, which is what a template is. The builder is where they stop being
generic.

### Editing the automation

Fields, states, roles, approvals and tasks have had editors from the start,
across twenty-two field types. The one thing that could not be changed without
hand-editing JSON was the part that makes this a process rather than a form:
**when something happens, if something is true, do these things.**

The **Automation** tab in the builder is that, as rules. Each one reads as a
sentence — *"When the form is submitted, move to With hiring manager"* — and
opens into its trigger, its condition and its actions. Rules are grouped by
the state they leave, in the order a record meets them.

A rule list rather than a node canvas, for a reason that outlives the
aesthetics: a transition already *is* a rule, so the mapping is one to one,
and the compiler's diagnostics point at transition keys — which means every
error appears against the rule that caused it rather than being translated
onto a shape.

**Or describe it.** *"Escalate to HR if the hiring manager has not decided
within two days"* becomes one rule, and nothing is written until somebody
reads what it would do and presses a button. The same boundary as the
copilot — the model proposes, the compiler decides, a person applies:

- The model is given the **exact** states, approvals, tasks, templates and
  fields, and a check rejects anything referring to something that is not in
  those lists *before* the compiler sees it, so the refusal says "there is no
  message template called that" rather than `REF004`.
- The proposal is merged into a **copy** and the real compiler runs on it. One
  that breaks the process comes back as a refusal with the reason, never as an
  edit somebody has to notice.
- Refusals are honest. Asked to text somebody on their start date, it answers
  that there is no SMS action and that timers measure hours in a state rather
  than calendar dates — instead of inventing one.

**And a picture of it.** The rules are drawn as a map above the list —
states placed by how far they are from the start, timers dashed, and clicking
one narrows the list to its rules.

Read-only, deliberately. A draggable canvas would be a second source of truth
for the same graph, and the two would disagree the first time somebody edited
a rule the canvas could not draw — a condition, a webhook trigger, an action
list. The rules are the truth; this is a rendering, so it cannot drift. Layout
is computed rather than stored for the same reason.

Two things the editor knows that the JSON tab cannot:

- **Only one timer may leave a state.** Entering a state cancels that
  occupancy's timers, so a second one never fires. The compiler has no opinion
  — it is a property of the runtime — so the warning appears where somebody is
  about to add the second.
- **Numeric comparisons are only offered against numeric fields**, and a
  number typed into one is stored as a number. The compiler refuses `"1000"`
  against a currency field, and quoting it would be a type error nobody typed.

### Sessions

Eight hours, renewed at most once an hour while somebody is working. Fourteen
days was the wrong shape twice: a stolen cookie was good for a fortnight, and
renewal only began past the halfway mark, so an active session went untouched
for seven days and then jumped. Eight hours is a working day — sign in in the
morning, and it ends by itself overnight.

`npm run seed` and `npm run spike` reset the schema, which drops the session
table. Both say so on stdout, because the 401 that follows has no other
explanation attached to it.

### What is reachable

```bash
npm run reachable
```

Lists the console endpoints nothing in the interface calls. It exists because
**thirty of seventy-two were unreachable** and every proof passed anyway —
each one starts from a session and a tenant the harness builds directly, so
none of them ever tried to get from the front door to a published process.
Among the thirty: every `members` route, every `invitations` route, every
`forms` route.

Counting endpoints is not counting features. An endpoint is not a feature
until something a person can reach calls it. It now reports **all 72
reachable**, and it is in the same class of check as the accessibility gate:
cheap, run every time, and about something nobody notices until a customer
does.

The tool itself had three bugs on the way, every one of them hiding the
routes it exists to check — see entry 44 in
[docs/failure-cases.md](docs/failure-cases.md).

### Where records come from, and who can see them

Three things the console could not answer, all built and none of them linked:

- **Processes & forms** — each published process serves a form at its own
  link, `/f/<id>`. That link is the answer to "how does a record get created": send
  it to whoever fills it in, and every submission becomes a record routed by
  the process's own rules. Nobody needs an account to submit one.
- **People** — invite, change a role, deactivate, revoke sessions. The
  invitation link is never shown in the interface, only emailed, because
  anybody who can invite could otherwise mint one for an address whose owner
  never sees it. The role list offered is what the *server* will accept from
  that person, so the interface cannot offer a role it would refuse.
- **Builder** — linked from the rail. It was not linked at all, which is how
  somebody could use this console without learning that processes are designed
  rather than configured.

### Getting in at all

The landing page now reaches the application. It did not: "Sign in" pointed at
an anchor further down the same page, "Apply to the program" pointed at the
section it was inside, and there was no sign-up page at all —
`POST /api/workspaces` had existed since IAM-01 and nothing in the web
application called it.

- **`/signup`** creates the workspace and signs you in, so it ends at the
  console rather than at a login form asking for the password you chose ten
  seconds ago.
- **`/console`** is the sign-in, and carries the forgotten-password path.
- The narrow-screen menu opens. It did not, on the one width where the nav
  links are hidden — so a phone had no navigation whatsoever.

The accessibility gate now starts at the landing page, which is how nine
pre-existing contrast violations on it were found. A page that is not in a
flow is a page nobody checks.

### Confirming an address, and getting back in

Creating a workspace sends a verification link and marks the address
unverified. That gates exactly one thing — **inviting other people** — because
that is the only thing a fresh sign-up does that reaches a third party, and a
sign-up that can do nothing until an email arrives is how a pilot loses its
first user. Accepting an invitation, or spending a reset link, verifies the
address without a second round trip: following a link that was emailed to it is
the proof a verification link asks for.

```bash
curl -X POST http://localhost:3310/api/auth/forgot -H 'content-type: application/json' -d '{"email":"you@acme.test"}'
```

The answer is the same sentence for an address with an account, one without, a
deactivated member, and one that has asked five times this hour:

```
{"message":"If that address has an account, a reset link is on its way."}
```

Anything that varies is an account-enumeration oracle (§12.3). Spending the
link revokes every session in the same transaction that sets the password —
a reset is what somebody does when they think an account is compromised.

Set **`APP_URL`** in any deployment. The links point there, the default is the
dev console, and a link to a plausible-but-wrong host fails silently: the mail
arrives, looks right, and the token cannot be spent.

### What happened after we handed it over

`email_log.status` used to stop at `sent`. Everything past that is something
the provider learns later and tells us about:

```bash
curl -X POST http://localhost:3310/api/webhooks/relykit   -H 'webhook-id: evt_1' -H 'webhook-timestamp: 1790000000'   -H 'webhook-signature: v1,<base64 hmac>' --data-binary @event.json
```

Set **`RELYKIT_WEBHOOK_SECRET`** or the endpoint answers 503. One that accepts
unsigned requests is a way to mark anybody's address as bounced.

Four things this gets right, each because the obvious version does not:

- **Redelivery is ordinary traffic.** The provider retries until it gets a
  2xx, so the same event arrives more than once as a matter of course.
  `delivery_event.event_id` is unique and the insert is the guard.
- **Status never moves backwards.** A message's state is the worst thing that
  happened to any recipient; a delivery notification arriving after a bounce
  leaves it bounced. Same ranking RelyKit uses, so the two agree.
- **A hard bounce stops the next send.** Both send paths check
  `suppressed_recipient` before handing anything over. Recording a bounce and
  then mailing the same dead address on the next transition is keeping a diary
  about it, not handling it. A soft bounce suppresses nobody — a full mailbox
  is not a dead one.
- **A blocked send is logged `skipped` with the reason.** The operator looking
  at a message that never arrived needs to see why, and the console's
  **Automation health** page is where.

The list is deployment-wide, because a dead mailbox is not a fact about who
wrote to it — but a tenant only sees the addresses it has actually mailed.
See [ADR-0014](docs/adr/0014-delivery-outcomes.md).

Platform mail — these three messages, and only these three — is logged in
`platform_email` rather than `email_log`. That table requires an instance and
an action run, which is what makes "every process email is traceable to the
action that sent it" a guarantee; making both nullable for three messages would
have turned it into a convention. See
[ADR-0013](docs/adr/0013-account-recovery.md).

**IAM-05** was marked *Design now*, so it is: `actor_identity` holds an
external identity per provider, and **matching is on the IdP's subject, never
the email**. An address is a display value that changes with a marriage or a
domain migration; matching on it is how one person ends up with two accounts.
`actor.provisioned_by` marks SCIM-managed rows, which the console then refuses
to edit — a change the directory would overwrite on its next sync is worse
than one that was never allowed.

## Generated blueprints declare what they assumed

BLD-02. The generator used to be told to record assumptions *in
`intent.outcome`* — prose in a field meant for something else, where the
compiler cannot check it and the builder cannot list it.

`intent.assumptions` and `intent.openDecisions` are modelled now, surfaced as
`BLD001` and `BLD002` warnings, and **enforced as a generation gate**: adding
the fields and a line in the prompt was not enough, and the first run came back
with a complete process and both arrays empty. A model asked for something
optional at the end of a long instruction will skip it, so a generated
blueprint declaring no assumptions is repaired like a compiler error. A
*hand-written* one legitimately declares none, which is why the gate lives in
the pipeline rather than the compiler.

From "Something for handling requests from staff. Manager signs off." it
produced seven assumptions and five open decisions, one marked blocking —
including that it had read "requests" as equipment and access rather than
leave or grievances, that it invented a £1,000 finance threshold, and that it
collects no attachments. Every one of those is a thing a reviewer needs to
correct, and none of them was in the description.

## The respondent side

```bash
npm run db:up && npm run seed && npm run api && npm run worker
npm --prefix web run dev
```

`/f/employee_onboarding` opens the public form, and moves itself to that
form's own link: multi-page, conditional sections, autosave with a resume link
in the address bar, and a status page at `/f/status?resume=…` where a
respondent answers a request for changes.

**Each form's link names one workspace's form.** A process key is unique only
inside a workspace, and the public lookups used to take the highest version of
a key across *all* of them — so two organisations that installed the same pack
shared one URL, and one's applicants could become the other's records. The
public API had the same lookup. Now every published process gets a link like
`/f/k7m2-q9x4-tbhw` at its first publish, kept across versions: random, so it
cannot be guessed and a workspace's forms cannot be listed by trying names. An
old `/f/<process_key>` link still works while only one workspace has that key,
and answers `410` with a message once two do, rather than choosing. The public
API files into its key's own workspace. A draft token only reads and writes
drafts of the form that issued it, and the spam ticket is signed for the form's
link, not its key.

Two properties worth knowing:

- **A draft is not a record.** Half-finished forms never become instances, so
  abandonment does not create work for an operator or distort the intake count.
- **The browser holds no rules.** The API serves each field's constraint
  *values* and the renderer turns them into native HTML attributes;
  `validateAnswers` on the server is what decides. One source of truth, two
  enforcers, nothing to drift apart.

## What is not built

Named here rather than implied by silence.

All of §6's `Must` requirements are now met. The four that were not — IAM-01,
IAM-04, IAM-05 and BLD-02 — are covered under *Joining a workspace* and
*Generated blueprints declare what they assumed* above.

BLD-01 asks for "a guided prompt, a process pack, **or blank canvas**". The
first two are built; the third was deliberately left out, because a blank
skeleton opens with a dozen errors and teaches people the diagnostics panel is
noise. A product judgement rather than an omission, recorded so it can be
overruled.

Everything below is a deliberate deferral:

- **SSO itself.** The identity model accommodates it (IAM-05) — external
  identities match on the provider's subject, never the email — and no
  provider is wired to it.
- **A KMS for the two-factor key.** Secrets are sealed with a key from the
  environment (see *Two-step verification*); a KMS would keep it out of the
  process entirely.
- **Trusted devices.** The second factor is asked for on every sign-in; there
  is no "remember this browser".
- **CAPTCHA, IP reputation, and scoring what a submission says.** Public
  forms are screened with a signed ticket and a trap field, and a suspicious
  submission is held rather than acted on (above). Nothing challenges the
  person, checks where they are connecting from, or reads the answers for
  signs of spam. Each catches more and costs real people more, and is a
  choice to make with real traffic in front of it. Held submissions are not
  searched by a privacy request; they are deleted within thirty days.
- **Uploads at all** (§12.1), and therefore malware scanning and quarantine.
  The `file` field type looked like an upload and was not: the browser sent
  the file's *name* and the bytes never left the machine, so a record that
  said it held a right-to-work photograph held the string
  `"right-to-work.pdf"`. `SEC013` now refuses to publish a process with one,
  and the two that had them ask for a reference instead — the D1 pattern in
  [docs/failure-cases.md](docs/failure-cases.md), which the church process was
  already using for safeguarding. Accepting real files means storage,
  size and type limits, a quarantine state and a scanner, none of which
  exists; until it does, nothing pretends otherwise.
- **The DNS records for a verified sending domain**, which no repository can
  add for you. `npm run mail:check` looks: it resolves what a receiving server
  resolves, says which of SPF and DMARC are missing, and prints the records to
  add. It exits `1` when a record is absent and `2` when it could not reach a
  resolver, because those are different answers. DKIM it cannot check — the
  record is at `<selector>._domainkey.<domain>` and the selector comes from the
  provider — and it says so rather than listing two of three and reading like
  a pass.

  Delivery still needs two switches to leave the machine: `EMAIL_PROVIDER`
  naming a provider *and* that provider's credentials. There is now a third —
  a real provider with a `MAIL_FROM` that could never deliver refuses to start,
  because the default is `no-reply@localhost` and a deployment that believes it
  is sending is worse than one that will not boot. `spike`, `seed` and `eval`
  ignore the setting entirely and say so on stdout.
- **DOCX rendering.** HTML templates become PDFs; a blueprint asking for DOCX
  gets a document that says so rather than a silently incomplete one.
- **Object storage for documents.** The bytes live in Postgres, which is fine
  at a packet's size and wrong at scale (§10.1).
- **Automatic re-sending after an address is reinstated.** An admin sees what
  the address missed and chooses what to send (see *Sending health* above);
  nothing goes by itself, because a reminder from a fortnight ago may no longer
  be true. Messages to other workspaces' recipients, and the platform's own
  invitations and resets, are not offered for re-sending.
- **Changing or removing a particular row in bulk.** A repeating group can
  have a row added to many records; editing or deleting an existing row is a
  record-at-a-time change, because rows are not the same thing across
  records. Signatures, ratings, files and matrices are not bulk-editable.
- **Form editors for the rest of the blueprint.** The builder edits fields,
  states, rules, approvals, tasks, messages, roles and the form's header and
  field widths, and draws the flow as a read-only map. Intent, the rest of the
  form experience, documents and scenario tests still go through its JSON
  tab.
- **SMS.** §6.6 is explicit: *"SMS is not required for MVP; messaging consent
  and jurisdictional rules must be designed before launch."* Building the
  channel without consent capture would be building the thing that sentence
  warns about, and RelyKit's SMS is sandboxed until a provider route exists —
  so it would deliver nothing while looking as though it did.
- **Arbitrary customer code in workflows.** §5.2 lists this as an explicit
  non-goal for MVP, and the reason holds: it turns a typed, inspectable,
  compilable process into an execution sandbox with an entirely different
  security model. The expression languages exist so that behaviour is
  declarable without it.
- **Native mobile.** Out of scope for this repository. The public API is what
  would make it possible.
- **Dynamic client registration, and token introspection/revocation
  endpoints.** Clients are registered through the console.
- **Privacy terms, a DPIA, consent capture, and a subject access export.**
  The privacy gate's code half is built and its documentation half is in
  [docs/privacy.md](docs/privacy.md); the terms are a document for a lawyer and
  a named controller, and a placeholder here would be mistaken for advice.
- **Screen-reader testing, zoom and reflow at 400%, Windows High Contrast.**
  The accessibility gate is automated checks plus code review; a gate claimed
  without hearing the thing read aloud is a claim about markup, not about use.
- **Traces and metrics in the OpenTelemetry sense.** §10.1 asks for both. What
  exists is the identifier chain §20.2 names, structured logs, and the support
  view.
- **Point-in-time recovery.** The drill exercises a full backup and restore.
  Continuous archiving, which is what actually gets the RPO down from a backup
  interval to minutes, is a deployment concern and is not set up.
- **An effect log outside the database.** The idempotency ledger protects every
  effect the backup knows about and nothing inside the RPO window, so anything
  with an external effect in that window happens twice after a restore.
- **Quantifiers over repeating groups** ("any line item over £200") — what is
  left of the v0.2 list in [docs/failure-cases.md](docs/failure-cases.md).
  Parallel task joins, separation of duties, date-relative timers and approval
  quorums were on it and are now built. In each case the compiler refuses the
  half-built version: a join that leaves a blocking task out, a bar on a
  submitter the process never identifies, a deadline measured two ways at
  once, and a quorum that could never be met.
- **A vote rather than a veto.** In every approval mode one rejection settles
  it. A board that decides by majority cannot say so yet.

**Approvals that need more than one person.** An approval can be a
**quorum** — `mode: "quorum"`, `required: 2` — meaning that many *different
people* among the named approvers must approve: "any two directors". It can
also be **sequential**, each approver in the order listed, and that is now
what it does: until this change the first decision by anybody named settled
every approval whatever its mode, so a sequence behaved exactly like "any one
of them". Each person's decision is now a vote; the request stays open until
its mode is satisfied, one person cannot vote twice, and in a sequence only
the approver whose turn it is may decide. One rejection or request for changes
settles it at once, in every mode. Queues show a request only to people who
can act on it now, with how far it has got ("1 of 2 approved"), and the
decision records everybody whose vote settled it. The compiler refuses a
quorum with no count, a count on anything but a quorum (`APR001`), and a
quorum the named people can never meet (`APR002`); one addressed to a role
warns that it depends on how many people hold it (`APR003`). A quorum of two
satisfies the packs' two-person rule.

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

Open questions the schema cannot yet express — approval quorums, quantifiers over repeating groups — are listed with recommendations in [docs/failure-cases.md](docs/failure-cases.md). None of them blocks a design-partner demo.
