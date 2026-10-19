# Patform against the Enterprise Workflow PRD: Module 1 and the launch gates

Date: 19 October 2026. Read-only audit of this repository against
`Enterprise_Workflow_Platform_PRD.docx` (v1.0, 18 Oct 2026), Section 4
(Module 1, Organization People and Access) and the shared launch gates in
Section 3.1. Nothing was changed. Line numbers refer to the code as of
commit `69ed409`.

## The short version

Patform already covers Modules 2, 3 and 4 of the PRD well, and the
engine is solid: one transaction per transition, row locks, idempotent
actions, an outbox with a tested restore. **Module 1 is the gap.** There is
a tenant, people, roles and sessions, but no organisation chart: no
units, legal entities, managers, approval limits or delegation. Every
"send to my manager" or "over £5,000 goes to the director" rule in the
PRD has nothing to stand on yet.

One security bug was found and should be fixed first. Beyond that, the
build order below gets to a sellable expense product with the least
rework.

## Launch gates

| Gate | Status | Notes |
|---|---|---|
| Tenant isolation | **Mostly done, one hole** | Almost every table has `tenant_id`. Scoping is by application code, not Postgres row security. One route crosses tenants (below). |
| Server-side authorisation | **Done, flat** | Central `authorize` / `require_` in `src/runtime/policy.ts`. UI does no checks, which is correct. Roles are flat: no department, entity or amount scope. |
| Activity history | **Done for records, missing for admin** | Append-only `event` table per record with trigger (`schema.sql:491-521`). Role changes, deactivation, API keys, webhooks and OAuth clients write no audit row. |
| Accessible primary journeys | **Done** | axe on 67 screens, 0 violations (`docs/accessibility.md`). One NVDA session only, one form. |
| Safe error handling | **Done, with gaps** | Global handler, no stack traces leak (`server.ts:1405-1817`). No CSRF token (SameSite cookie only). No body size cap by default. Login has no rate limit. |
| Reliable state transitions | **Done** | `FOR UPDATE` on instance and approval; double vote refused; idempotent actions (`engine.ts:303-489, 1386-1448`). Proof suite passed 42 proofs including concurrent workers. |
| Recovery | **Tested locally only** | pg_dump restore drill passed (`docs/recovery-drill.json`). No scheduled backups, no point-in-time restore, never tested against Renviq staging. |

## Security finding (fix before anything else)

**`POST /api/members/:id/revoke-sessions` crosses tenants.**
`src/api/server.ts:846-849` checks that the caller can administer their
own workspace, then calls `revokeAllSessions(pool, id)`, which runs
`update session ... where actor_id = $1` with no tenant filter
(`src/runtime/auth.ts:303-309`). An admin in tenant A can sign out any
user in tenant B whose id they know. Compare `setMemberActive`
(`workspace.ts:551`), which does filter by tenant. Fix: add
`and actor_id in (select id from actor where tenant_id = $2)`. One line
plus a test.

Three smaller ones:

- `signIn` finds the actor by email across all tenants and takes the first
  row (`auth.ts:172-178`). One email in two workspaces gives an undefined
  result. Needs a workspace picker.
- `GET /api/members` lets a `read_only` member see everyone's session
  count and last-seen time (`workspace.ts:115-125`).
- Three places compute `max(seq)+1` for events without the instance lock
  (`console-queries.ts:526`, `export.ts:324`, `share-record.ts:93`). Two
  notes at once can hit the unique constraint and return a 500.

## Module 1, requirement by requirement

| Req | What the PRD asks | Patform today | Verdict |
|---|---|---|---|
| ORG-01 | Tenant setup: name, timezone, currency, locale, calendars, first admin, enabled modules | `tenant` table and signup flow. No timezone, currency, calendars or module switches on the tenant. | Partial |
| ORG-02 | Legal entities, nested units, matrix reporting, cycle rejection | None of these records exist. | **Absent** |
| ORG-03 | Membership states: invited, active, suspended, deactivated | `actor.active` boolean plus `invitation` states. Deactivation revokes sessions, keys and tokens in one transaction (`workspace.ts:540-600`). No suspended state. | Partial |
| ORG-04 | Permissions = role + scope (department, entity, ownership, confidentiality, amount) | Workspace roles (owner, admin, builder, operator, approver, analyst, read_only) and per-process roles. Field classifications public/internal/confidential/restricted enforced server-side (`policy.ts:365-442`). No department, entity or amount scope. | Partial |
| ORG-05 | Approval grants with monetary limit, entity scope, validity dates | Approver must hold the process role with `approve` and be named on the request. No limits, no dates, no entity. Amount routing only via blueprint conditions. | **Absent** |
| ORG-06 | Delegation with scope, dates, exclusions, cap at the original limit | Nothing. Only admin reassignment of a task (`engine.ts:944`). | **Absent** |
| ORG-07 | Four-eyes on privilege increases | `changeRole` applies immediately, no second admin, no audit row (`workspace.ts:604-640`). | **Absent** |
| ORG-08 | SSO and provisioning (SAML/OIDC, SCIM) | `actor_identity` table and `linkIdentity` exist but nothing uses them except a proof. `src/api/oauth.ts` is Patform acting as an OAuth *server* for API clients, not sign-in via an IdP. | Absent (hooks only) |
| ORG-09 | Directory import with dry run, duplicates, row errors | Bulk *invitations* with dry run (`server.ts:857-866`). No CSV of people, no manager column. | Partial |
| ORG-10 | Service accounts separate from humans, owners, rotation, expiry | API keys and OAuth grants act *as* a human actor with scopes. No non-human principal. | Partial |
| ORG-11 | Access reviews (retain, revoke, flag with reason) | `access_denial` logs refusals only. | **Absent** |
| ORG-12 | Authority changes show impacted pending tasks, reassign with reasoning kept | Deactivation does not touch open tasks. Reassignment is manual, one by one or via copilot. Routing explanation is not stored on reassignment. | Partial |

Journey and safeguards (4.3): the "no manager" rule (block or route to a
fallback pool, chosen in the template, never guess) cannot be implemented
because there is no manager. Today the requester types their manager's
email into a form field (`seed.ts:74`), which is why the
`notTheSubmitter` guard exists.

Acceptance scenarios (4.4):

1. Entity A cannot reach Entity B's record: **passes at tenant level**, no
   concept of entity within a tenant.
2. Delegate with a lower limit cannot approve above it: **cannot be
   tested**, no delegation, no limits.
3. Deactivating an approver terminates sessions, exposes affected tasks,
   assigns the replacement: sessions **yes**; tasks **no**.
4. Import with invalid manager gives a row error: **cannot be tested**, no
   manager import.

## What already exists and should not be rebuilt

- Workflow engine with approvals in five modes (single, any_of,
  sequential, quorum, majority), timers, SLAs, reminders, parallel steps,
  child actions, outbox and worker. ADRs in `docs/adr`.
- Forms with repeating groups, calculated totals, conditional rules,
  signatures, scanned photo evidence, restricted fields, drafts, resume
  links. Immutable published versions (`process_version` trigger).
- An **expense-approval blueprint** already compiled: line items, totals,
  threshold routing, auto-approve under a limit.
- Console: my work, records with history, dashboard, saved views, export,
  share, copilot, builder with AI generation, test and publish, packs,
  keys, webhooks, OAuth, MFA, platform admin.
- Public API with API keys, OAuth 2.0 + PKCE, idempotency keys, OpenAPI.
- Privacy: retention runs, erasure, data map.
- Email via RelyKit, PDF generation without a browser.

## Progress

- 19 Oct 2026: the four findings above are fixed (commit 311a3be).
- 19 Oct 2026: step 2, the org chart core, is built: `legal_entity`,
  `org_unit` (nested, cycle-checked), `reporting_line` (dated primary
  manager, one open line per person), placement on `actor`, the
  `{ manager: 'submitter', fallback }` party, `approval_routed` and
  `routing_unresolved` events, routes under `/api/org` and
  `/api/members/:id/{manager,placement,reporting}`, and the builder option.
  No People-page UI for it yet; membership lifecycle enum (ORG-03) not done.
- 19 Oct 2026: step 3 (ORG-05/06) and most of step 4 (ORG-07, admin audit)
  are built: `authority_grant` (limit, currency, decision type, entity
  scope, validity), `delegation` (capped at the holder, no chaining),
  `approval.authority` on the blueprint with escalation at routing and a
  second check at decide time, delegates admitted to named approvals,
  `workspace_admin_audit` (append-only) written for grants, delegations,
  role changes, deactivation and manager changes, routes under
  `/api/authority` and `/api/audit`, step-up on grant, delegate and manager
  changes. Not done: the two-admin approval of privilege increases (only
  self-grant is refused), and console pages for any of it.
- 19 Oct 2026: the module layer (ORG-01) is built: a module catalogue in
  `src/runtime/modules.ts`, `tenant_module` per workspace, the pack gallery
  filtered by enabled modules, workspace settings (name, time zone, default
  currency, locale) with validation, routes under `/api/modules` and
  `/api/workspace/settings`, `modules` on `/api/session`, and a
  "Modules & workspace" page in the console settings menu. Audited.
- 19 Oct 2026: console pages: a "Place in the organisation" section on
  every member profile (manager with effective date and history, unit,
  entity, title) and a Settings > "Organisation & authority" page with
  Structure (entities, nested units, move, head), Approval authority
  (grants, delegations, revoke) and Audit tabs. Checked in the browser.
- 19 Oct 2026: the Expenses module (PRD Module 5) is built. Policy in
  `expense_settings` per workspace (auto-approve, manager-only and
  single-item limits, receipt threshold, categories, days to retire an
  advance), copied onto each claim at submission. Two processes,
  `staff-expense-claim` and `cash-advance`, routed to the manager from the
  directory and shipped as built-in Finance templates (generated by
  `scripts/make-expense-blueprints.py`). Approval opens an
  `expense_settlement` (awaiting payment, paid with a reference, failed,
  void; paid is final) or a `cash_advance`; a claim quoting an advance
  reference retires it and only the remainder is paid; money returned is
  recorded against it; every movement is in append-only
  `advance_movement`. Console: an Expenses page in the sidebar when the
  module is on, with Claims to pay, Advances and Policy.
- 19 Oct 2026: the rest of Module 5. EXP-04: Finance keeps exchange rates
  (`exchange_rate`, never edited); a claim in another currency takes the
  rate in force at submission and keeps it, with the amount in the
  workspace currency, and the limits are converted for routing. EXP-05:
  `expense_budget` per cost centre and period, advisory or enforced;
  `budget_reservation` held inside the submission transaction under the
  budget row lock (two claims at once cannot both take the last of it),
  consumed on approval, released on rejection, expiry or void. EXP-07:
  `expense_line_decision`; Finance approves, cuts or rejects lines before
  payment, the submitted claim never changes, and the advance and budget
  follow. EXP-09: `expense_beneficiary`, account number sealed with the
  application key (AES-256-GCM, bound to the row), masked everywhere,
  revealed only through an audited route; payment needs a check at the
  current version, and a change after the check needs a new one. EXP-10:
  numbered export batches, one row per approved line with account codes
  per category, rounding absorbed on the last line, formula-safe, never
  including bank details. Console: Claims (review lines, check bank,
  pay), Advances, Budgets, Exports, Policy and rates, My bank details.
  Production note: set `MFA_ENCRYPTION_KEY`, which also seals bank details.
- 19 Oct 2026: directory import (ORG-09). People > Import from a
  spreadsheet: CSV with email, name, unit (nested as "A > B"), manager
  email, title, role, entity. Every row is checked first and named
  errors come back per row (bad or duplicate email, unknown or
  deactivated manager, self-management, reporting loops including ones
  through existing lines, ambiguous unit names, roles the importer cannot
  give). Nothing is saved unless every row is clean, and the real run
  re-checks inside one transaction under the workspace lock. New people
  are created at once (provisioned_by 'import', no password) with their
  place in the organisation; their invitation adopts that row. An import
  never changes an existing member's role.

## What to build first

In this order. Each step is sellable on its own; none is wasted if the
next one is delayed.

1. **Fix the four findings above.** A day. The cross-tenant revoke is a
   real bug in a product that will sell on tenant isolation.

2. **Org chart core (ORG-02, part of ORG-03).** New tables: `org_unit`
   (nested, cycle check), `legal_entity`, `position`, `reporting_line`
   (effective-dated, primary manager, cycle check). Membership lifecycle
   enum replacing the boolean. New `Party` kind in the blueprint:
   `manager_of: submitter`, `unit_head`, `fallback_pool`. This single
   step unlocks "route to my manager" and the no-manager rule in 4.3,
   which the expense module needs on day one.

3. **Approval authority (ORG-05).** `authority_grant`: decision type,
   amount limit, currency, entity scope, valid from/to. `decide` in
   `engine.ts` checks the grant before counting the vote. Blueprint gets
   an `escalate_when: amount > approver.limit` route. This is the
   expense module's "Finance controls" story.

4. **Admin audit and four-eyes (ORG-07 and the history gate).** Write a
   row to an append-only `workspace_admin_audit` for role changes,
   deactivation, grants, keys, webhooks, OAuth clients. Privilege
   increases become a two-admin approval, which is just a Patform
   process run on the admin itself.

5. **Deactivation reassigns (ORG-12).** On deactivate, list open tasks and
   pending approvals, reassign to the configured replacement, keep the
   original routing reason on the task.

6. **Directory import (ORG-09).** CSV with email, name, unit, position,
   manager email, legal entity. Dry run, row errors, refuse to publish a
   broken hierarchy. Reuse the invitation dry-run pattern.

7. **Delegation (ORG-06).** Table plus a check in `resolveParty`: the
   delegate inherits the smaller of the two limits.

Defer until a customer asks: SSO/SCIM (ORG-08), access reviews (ORG-11),
non-human service principals (ORG-10). These are enterprise checklist
items that cost sales but not pilots.

Platform items to schedule alongside, not before: scheduled Renviq
backups and one restore test against staging; CSRF Origin check; login
rate limit; body size cap; GitHub Actions running `npm test` and the
proof suite; a second screen-reader pass on the approval journey.

## Positioning note

The PRD sells control and evidence. Patform's README sells AI generation.
Keep the AI as the way an admin stands up a process in 30 minutes
(Section 24's own target) and lead the pitch with approvals, authority and
audit. The code already fits that story better than the README does.

## Module 6, Procurement (19 Oct 2026)

Built: the Purchase request process (`processes/purchase-request.blueprint.json`,
generated by `scripts/make-procurement-blueprints.py`), routed to the
manager from the directory with Procurement's own manager limit, budget
held from submission; approval opens a requisition. `src/runtime/procurement.ts`
covers PRC-01 to PRC-12: suppliers with states, reasons and history
(approval by an admin who did not add them), sealed bank details checked
by someone other than whoever entered them; quotes, sealed until opened
after a deadline, a chosen quote with a reason and a minimum count above
a set amount; orders tied to the request and supplier version, revisions
with re-approval past the tolerance or on a supplier change, framework
agreements whose limits orders use up under a row lock, suspended
suppliers only under an admin's exception; append-only receipts with
partial, rejected and returned quantities; invoices matched to accepted
quantities and order prices within tolerances, held with reasons for an
independent review; payment only to checked bank details, version kept;
cancellation releasing the budget and refused once goods or invoices
exist; supplier performance from source records; a CSV export of paid
invoices with references and no bank details. Budgets are shared with
Expenses and work when either module is on. Console: Procurement page
(To order, Orders, Invoices, Suppliers, Agreements, Budgets, Rules).
All four PRD acceptance scenarios are tests.

Not built: a supplier portal (suppliers do not sign in; quotes are entered
by Procurement), catalogue items, document expiry tracking, and an ERP
connector beyond the CSV export.

## Module 7, Employee lifecycle and HR requests (19 Oct 2026)

Built in `src/runtime/hr.ts`, with the HR page in the console and the
Hiring request process (`processes/hiring-request.blueprint.json`,
generated by `scripts/make-hr-blueprints.py`).

- Who sees what: HR (owners, admins, HR team) sees everything; IT,
  Facilities and Finance teams see their tasks and only the basic facts
  about a person; managers see manager tasks for their direct reports;
  employees see their own tasks, leave and documents. Pay lives in its own
  table that only HR reads (HR-06, acceptance 4).
- A new `pre_hire` workspace role with no capability: a future employee
  signs in to their own onboarding tasks only, and the activation task
  gives them the configured role on the start date after the required
  checks (HR-02, HR-03, acceptance 1).
- Lifecycle cases (onboarding, offboarding, transfer, probation, urgent
  termination) built from editable templates of team tasks with
  prerequisites, date waits and actions; templates are validated (no loops,
  revocation never waits for other tasks). Readiness summary of blockers.
  Non-critical tasks can be waived by an HR admin with a reason.
- Offboarding revokes access on the end date regardless of other tasks;
  Finance clearance names open advances and unpaid claims rather than
  blocking revocation (HR-08, JRN-04). Urgent termination needs an HR admin,
  revokes access and sessions at once, and is restricted (HR-09,
  acceptance 2).
- Transfers date the new reporting line from the effective date; unit,
  title and entity change on the day via the worker (acceptance 3).
- Probation reviews with confirm, extend (HR admin) or end (HR-04).
- Leave: types, entitlements, public holidays, working-day counting,
  overlap refusal, same-team absence shown to the approver, manager
  approval from the directory with HR as fallback, cancellation (HR-05).
- Documents by version, acknowledged as received or agreed, with the
  exact statement recorded (HR-07).
- Restricted case notes by category; health, disciplinary and pay notes
  are never shared (HR-10).
- Upcoming: probation ends, starts, leavers, certification expiry and
  anniversaries (HR-11).
- Field ownership: identity, employment status, pay, leave balance and
  payroll reference can be declared owned by another system; changes to
  those become reconciliation tasks (HR-12).
- Hiring requests with budget hold; approval opens a requisition and each
  onboarding against it fills a place (HR-01).

Not built: an applicant tracking integration, uploading documents (they
are referenced), per-employee leave accrual rules beyond a yearly figure.

## Module 8, Goals, appraisals and development (19 Oct 2026)

Built in `src/runtime/appraisals.ts`, with the Appraisals page in the
console. No AI scores, ranks or decides anything (APR-12).

- Templates are versioned. Publishing checks that scored sections add up
  to 100 and that item weights inside each section add up to 100 (or are
  all left equal); every error names its section (APR-03, acceptance 2).
  Editing a published template makes a new draft version.
- Cycles (annual, quarterly, probation, project, continuous) keep a copy of
  the template, so later edits never change them. Launch takes an
  eligibility snapshot with the reason for anyone left out (APR-01). Self,
  peer, manager and calibration stages each have a window, enforced on save.
- Scores are worked out from the template and stored with the calculation
  and its version. A missing score blocks submission and is never zero.
  "Not applicable" either blocks or moves the weight to the other items,
  as the template says, and the move is recorded (APR-05, 11.3).
- Peer feedback is named or confidential. The manager sees nothing before
  the peer window closes; confidential feedback appears only as averages,
  without comments or names, and only from at least the minimum group size
  (APR-04, APR-06, acceptance 1).
- Calibration adds an append-only row with original and adjusted score,
  who, evidence and reason; the manager's review is untouched (APR-07,
  acceptance 3).
- Publishing creates results and opens promotion and pay recommendations
  as proposals. Approving one changes nothing; pay changes only when HR
  records it (APR-11, acceptance 4). Publishing and deciding a
  recommendation ask for the password again.
- Employees record receipt (not agreement) and can appeal within 30 days.
  The appeal reviewer cannot be the employee, the manager, anyone who
  reviewed them or anyone who calibrated the score (APR-08, APR-09).
- When a manager changes or leaves mid-cycle, their assignment ends and
  they lose access; their submitted review stays attributed to them. HR
  sees who needs a reviewer and assigns one with a reason (APR-13,
  acceptance 5).
- Goals with manager approval; once approved, a change to what a goal
  means is a revision the manager decides, with the old version kept
  (APR-02). Development plans of actions, training and check-ins, each
  closed with evidence (APR-10).
- Cycle report: completion and overdue by stage, rating spread with small
  groups hidden, appeals and development progress (APR-14).

Not built: continuous feedback notes between cycles, 360 reviewers chosen
by rule, and bulk reminders for overdue reviews.

## Module 9, Assets, IT and service operations (19 Oct 2026)

Built in `src/runtime/ops.ts`, with the Assets & IT page in the console.
IT and Facilities are the same teams the HR module uses for its tasks.

- Asset register: tag, category (from settings), serial, owner, location,
  purchase reference, warranty, condition and status, with an append-only
  history (OPS-01). Depreciation stays in the finance system.
- An asset bought through Procurement is registered only against an
  accepted goods receipt, one per unit received; receiving alone creates
  nothing (acceptance 1). Items bought elsewhere need a purchase reference.
- Hand-outs record condition, accessories and a handover reference; an
  admin approves first when the workspace says so; the holder confirms
  receipt. One holder at a time unless the asset is marked shared (OPS-02).
- Returns record condition and missing accessories and end the assignment
  without deleting it. During offboarding the return links to the HR case,
  and the HR "Recover laptop and phone" task cannot be marked done while
  the person still holds anything (acceptance 3).
- Service catalogue: team, questions (required or not), manager approval,
  roles allowed, response and resolution targets, evidence of completion
  (OPS-03).
- Access requests: system, role, business reason and expiry (required,
  with a maximum, where the system says so). The system owner approves,
  never the requester or holder. Approved is not access: it becomes access
  only when the system's connector account confirms, or someone in IT who
  is not the holder records evidence (OPS-04, acceptance 2).
- Revocation: when HR revokes access, every system access the person holds
  goes to "being removed". Deactivated holders and expired access are
  caught too. A failed removal is a critical exception on the overview and
  stays there until removal is confirmed, whatever happens to the HR case.
  System owners review access: keep with a reason, or remove (OPS-05).
- Tickets: requests and incidents, impact and urgency give the priority,
  assignment, private work notes, updates to the requester, escalation,
  resolution, reopening within the allowed days. The target clock pauses
  while waiting on the requester and the time moves the target. Missed
  targets are flagged and escalated once (OPS-06).
- Maintenance plans with checklists. The scheduler creates one job per plan
  and date even when run twice at once or retried (acceptance 4). A failed
  check needs findings, restricts the asset and opens corrective work; the
  restriction lifts only once that work is resolved (OPS-07).
- Change requests with impact, risk, preconditions, rollback plan and an
  execution window. A normal change starts only once approved by someone
  else, inside its window, with every precondition ticked. An emergency
  change can start at once and must be reviewed afterwards by an admin who
  neither asked for nor ran it (OPS-08).
- Field work: maintenance drafts carry a version so an old copy cannot
  overwrite newer work; location is accepted only when switched on in
  settings. Final approval and access changes are not offline (OPS-09).
- Overview: open tickets by age, missed targets, access problems, assets
  to recover, maintenance due, restricted assets and emergency changes
  waiting for review (OPS-10).

Added the same day:

- Photos (`src/runtime/ops-files.ts`): uploaded to the workspace's S3
  bucket under `ops/photos/`, type decided by the bytes (JPEG, PNG, WebP,
  5 MB), shrunk on the phone to 1600 px JPEG first, which also drops the
  camera's location. Shown only through 5-minute links once the bucket's
  malware scan passes. Attached to maintenance jobs, hand-outs, returns and
  tickets; a job accepts only its own uploads, and a photo that failed the
  scan blocks finishing.
- Offline field checklists (`/field.html`): the one page the service worker
  keeps on the phone. It holds the job list, saves answers and photos as
  they are typed, and queues finished work until there is signal. Each item
  carries the job's version, so an outdated phone gets a conflict to
  resolve, never a silent overwrite. Approvals and access changes stay
  online only.
- General connector: a system can have an https address and a signing
  secret (shown once, stored sealed). Approving access or starting a
  removal sends a signed request; the reply "done" confirms it, "failed"
  puts it on the critical list, anything else waits for a signed call back
  to `/api/ops/connectors/{system}/callback`. Unreachable systems are
  retried with backoff for 8 attempts, then shown as failed; IT can still
  finish by hand with evidence.

- Ready-made Microsoft 365 and Google Workspace connectors
  (`src/runtime/directory-connectors.ts`). Each role of a system maps to a
  group in the customer's directory: approval adds the person to the group,
  removal takes them out, and with "suspend when leaving" an HR removal or a
  deactivation also disables the account and signs it out everywhere.
  Patform's own app identity is in the environment (`MS365_CLIENT_ID`,
  `MS365_CLIENT_SECRET`; `GOOGLE_WORKSPACE_SA_EMAIL`, `_CLIENT_ID`,
  `_PRIVATE_KEY`); each workspace picks its own directory (Entra tenant, or
  Google admin to act as) and its admin consents on their side, so one
  workspace can never reach another's directory. People outside the
  configured email domains are refused. Setup shows the consent link or
  the delegation client ID and scopes, and "Test connection" signs in and
  checks every mapped group. Permanent refusals fail with the reason;
  rate limits and outages are retried.

To switch the connectors on, fill the five settings in `.env` locally and
in the Render environment for staging:

- Microsoft: register one multi-tenant app in Patform's Entra tenant, add
  the application permissions GroupMember.ReadWrite.All and User.Read.All
  (plus User.ReadWrite.All and User.RevokeSessions.All for suspending
  leavers), create a client secret.
- Google: create a service account in a Google Cloud project, enable the
  Admin SDK API, enable domain-wide delegation, create a JSON key, and copy
  its client_email, client_id and private_key.

## Module 10, Contracts, compliance and audit (19 Oct 2026)

Built in `src/runtime/gov.ts`, with the Compliance page in the console, and
legal holds wired into `src/runtime/retention.ts`. Teams: Legal,
Compliance, Security and Finance (Setup).

- Contracts: parties, linked supplier, entity, project, owner, value,
  dates, notice period (calendar or working days), automatic renewal,
  personal data flag, versions with document references (GOV-01).
- Reviews belong to a version. Business (the owner's manager or an
  admin), Legal, Security for personal data and Finance above a value are
  required as the rules say. The author of a version cannot review it. A
  material revision — flagged, or any change to value, currency, dates,
  notice or renewal, or the other party — cancels the approvals the policy
  names and sends the contract back for review; a non-material one carries
  them over and says so (GOV-02, acceptance 1).
- Signature: only an approved current version goes out; envelope status
  and the signed copy are tracked apart from approval; a revision voids an
  open envelope; "completed" needs the signed document (GOV-03). Validity
  and jurisdiction are for the chosen provider and the customer.
- Obligations: recurring (every N months), one-off or event-driven, with
  owner, evidence and escalation. Renewal tasks are dated from the notice
  deadline: end date less the notice period, in working days skipping
  weekends and the workspace's public holidays, moved earlier off
  non-working days. Created once each however often the sweep runs
  (GOV-04, acceptance 2). Renewal tasks record a decision; giving notice
  needs the notice as evidence.
- Policies: draft, approval by someone other than the author, publication
  with an effective date superseding the previous version, acknowledgement
  campaigns by role with the exact statement recorded, exceptions decided
  by Compliance (GOV-05).
- Controls: owner, evidence, test frequency, internal framework, tests
  (append-only) and exceptions; the page says plainly this is not a
  certification (GOV-06).
- Audit engagements: scope (processes, controls, contracts), period, lead,
  status, sampling notes, evidence requests submitted by their owner and
  accepted or rejected by someone else, findings with severity, management
  response, target date, remediation evidence, validation by someone other
  than the owner, reopening when the evidence is not enough, and escalation
  past the target date (GOV-07, GOV-08).
- Auditors: a new workspace role with no capability. Access is per
  engagement, until a date (at most 180 days), read-only; records are shown
  only if in the engagement's processes and period; every view, export and
  refusal is logged (append-only); export is granted separately. Auditors
  are refused by HR, Appraisals, Assets, the member list, the org chart and
  every capability-checked route (GOV-10, acceptance 3).
- Evidence packs: originals (contract versions, review history, control
  tests, submitted evidence, findings, record histories) and a derived
  summary marked as such, with a manifest of sources, versions, times and a
  SHA-256 per item and for the pack (GOV-11).
- Legal holds: placed, released and cleared only by owners and Legal, and
  invisible to everyone else. Retention — manual or the new daily schedule
  — skips held records and records the blocked run for review. A released
  hold keeps blocking until someone other than the releaser reviews and
  clears it, so a release never triggers unreviewed deletion (GOV-09,
  acceptance 4).
- Dashboard: obligations due and overdue, overdue remediation, contracts
  ending with their notice deadlines, policy acknowledgement, open
  exceptions, control tests overdue; holds only for those allowed (GOV-12).

Fixed during the browser check: an older copy of the workspace-role rule
in the startup upgrades did not include the new auditor role, so the
server would not start once an auditor existed. Every copy now includes
it.

Added the same day:

- Documents (`gov.ts`, `object-store.ts`): contract and policy files (PDF or
  Word, typed by their bytes, up to 20 MB) go to the S3 bucket under
  `gov/files/`; a version points at `gov-file:<id>`; a file opens only
  through a 5-minute link after the malware scan passes, for people who may
  see the contract (or any member, for a published policy). Auditors open
  contract files only through an engagement that covers the contract, and
  each download is logged. Evidence packs list each document's SHA-256.
- DocuSign (`docusign.ts`): Patform's DocuSign app is in the environment
  (`DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_PRIVATE_KEY`,
  `DOCUSIGN_AUTH_SERVER`, `DOCUSIGN_REDIRECT_URI`); each workspace names
  the DocuSign user it sends as, who consents once. Only an approved
  current version with an uploaded, clean document can be sent; signers
  sign in order. Patform checks status every 15 minutes (or at once when
  DocuSign Connect calls, which only prompts a check and must carry a
  valid HMAC when `DOCUSIGN_CONNECT_HMAC_KEY` is set), downloads the signed
  PDF on completion and stores it with its SHA-256, and voids envelopes in
  DocuSign when the contract is revised. Hand-recorded envelopes still work.
- Workspace export and closure (`tenant-lifecycle.ts`, PRD 17.3). The
  workspace's tables are found from the database's own foreign keys, so new
  tables are covered automatically. An owner's export is a .tar.gz in the
  bucket: every table as JSON, every process definition version, every
  clean attachment, and a manifest with a SHA-256 per file; password and
  token hashes, secrets and sealed bank numbers are left out; it can be
  downloaded for seven days. Closure: the owner asks (typing the workspace
  name; an export starts), suspends once the export is ready or waived
  (other members signed out and deactivated, API keys revoked, webhooks and
  intake stopped), waits (`WORKSPACE_CLOSURE_WAIT_DAYS`, default 14), then a
  site owner approves — refused while any legal hold is active or released
  but unreviewed. The worker deletes every row and file of that workspace,
  table by table, and records a certificate (rows per table, files, export
  hash, and a note that backups expire on their own schedule). The
  append-only guards accept a DELETE only inside that transaction, through
  a transaction-local flag. Until deletion starts, the owner can cancel and
  everyone suspended is restored (API keys stay revoked). Site owners see
  and approve closures on the site admin page.

To switch DocuSign on: create an app (integration key) in DocuSign Apps and
Keys, generate its RSA key pair, add the redirect URI, and fill the
DOCUSIGN_* settings locally and on Render; use account-d.docusign.com until
the app passes DocuSign's go-live review.

## Patform Sign: built-in electronic signature (19 Oct 2026)

Built in `src/runtime/esign.ts` (flow) and `src/runtime/esign-pdf.ts`
(sealing, with pdf-lib), with the Signatures tab in Compliance, the public
signing page at `/sign/{link}` and the check page at `/sign/verify`.
DocuSign remains available as an option.

- Send a contract (its approved current version) or any PDF to signers in
  order or all at once, with people who get a copy. Place signature,
  initials, date, printed name and text boxes on the pages; positions are
  fractions of the page, so the sender's screen, the signer's screen and the
  stamped PDF agree.
- Signers need no account: a personal link (only its hash is stored, with a
  sealed copy for reminders), then a 6-digit code to the same email address
  (10 minutes, five wrong tries lock it, five sends an hour), then agreement
  to sign electronically in stored words, then the document with their own
  boxes, signed with the existing draw-or-type pad. They can decline with a
  reason, which closes the envelope and tells the sender.
- Integrity: the original's SHA-256 is taken when the envelope is made and
  checked before showing and before sealing; a changed file is refused.
  The sealed PDF has the signatures stamped in place, a signature page for
  anyone without a box, and a certificate of completion (envelope, original
  hash, each signer's verification, consent, signing time, method, IP and
  browser, and the full event history). Its SHA-256 is kept; the public
  check page hashes a file in the browser and says whether it is a genuine,
  unchanged sealed copy.
- Every step is an append-only event. Reminders every N days, expiry,
  cancelling by the sender, and revising a contract voids an open envelope.
  Completing an envelope for a contract marks it signed and attaches the
  sealed copy. Everyone gets a link to the signed copy for 30 days.
- Codes are sent only in the email body, never the subject (subjects are
  logged). Found and fixed while testing in the browser: a wrong code was
  counted inside a transaction that was then undone, so the lock would
  never close; strikes are now committed before the refusal.

What it is: a simple electronic signature, which is what most commercial
contracts need. What it is not: a qualified signature; documents that the
law requires to carry one (some deeds and wills, in some countries) need a
qualified provider. Added the same day:

- Certificate seal (`esign-seal.ts`): when SIGN_SEAL_P12_BASE64 and
  SIGN_SEAL_PASSPHRASE hold a certificate, the finished PDF carries a PDF
  digital signature (adbe.pkcs7.detached, SHA-256) over the whole file.
  Acrobat and other readers show the seal and report any later change; the
  verify page reports it too when given the file. A certificate from a
  provider on Adobe's trusted list is shown as trusted; one made with
  `scripts/make-seal-certificate.mts` gives the same tamper protection but
  is shown as "identity unknown".
- Codes by text message (`sms.ts`): per signer, the sender chooses an email
  code, a text-message code, or both (both must be right). Providers:
  Termii (SMS_PROVIDER=termii, TERMII_API_KEY, TERMII_SENDER_ID,
  TERMII_CHANNEL) or Twilio (SMS_PROVIDER=twilio, TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN, TWILIO_FROM). Without a provider, text-message codes
  are refused when the envelope is made, never faked. The certificate says
  how each signer was verified.
- Companies signing through several authorised people: signers can be
  grouped under a company with "any N of these" and a recorded authority
  (e.g. a board resolution). Company boxes are placed per signatory slot;
  each signatory confirms "I am authorised to sign on behalf of …" (stored
  with the time) and takes the next slot; when N have signed, the rest are
  told they are no longer needed and their links say so. The PDF shows
  "For and on behalf of" with names and job titles; the certificate lists
  the company, the rule, the authority and who signed.

Found and fixed while testing: the signer's job title came out as the
document's title, because both columns are called `title` and the
document's overwrote the signer's when joined.

Added the same day:

- Trusted time stamp (`esign-tsa.ts`): the seal's signature is hashed and
  sent to a timestamping authority (RFC 3161); its signed token goes into
  the seal as an unsigned attribute, so readers show "signed at <time>,
  attested by <authority>" and the time stays provable after Patform's own
  certificate expires. SIGN_TSA_URL names the authority; the default is
  DigiCert's free public service, which Adobe trusts; "none" switches it
  off. If the authority does not answer, the seal is still made and the
  missing stamp is recorded on the envelope and in the event. The verify
  page reads the stamp from the file and checks it covers that very seal.
- Company register check (`company-register.ts`): a company signing
  through several people can carry its register number. UK: Companies
  House, free, with COMPANIES_HOUSE_API_KEY — the company must exist and be
  active (a dissolved or unknown company is refused), and each signatory is
  matched against current officers by surname and forename (initials and
  middle names allowed). A listed officer is recorded with role and
  appointment date; an unlisted one may still sign (board resolutions and
  powers of attorney exist) unless the sender ticks "only listed officers
  may sign". What the register said is snapshotted on the envelope with
  the time, shown to the sender and the signer, and printed on the
  certificate. Nigeria: the CAC has no public lookup; `registerProviders.NG`
  is the slot for a paid identity provider (Dojah, Prembly, Smile ID), and
  until one is wired in the check is reported as not available, never
  guessed.

Found and fixed while testing: with no register available, every signatory
was reported as "not listed"; now nothing is said about who is listed
unless a register actually answered.

Operations: the web proxy now passes PDFs through byte for byte and
forwards the caller's address; on the Vercel-plus-Render setup set
TRUST_PROXY=2 on the API so the certificate records the signer's real IP.
OBJECT_STORE=memory keeps files in memory for local trials (refused in
production).

