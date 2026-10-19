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
