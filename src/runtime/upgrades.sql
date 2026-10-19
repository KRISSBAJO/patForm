-- Changes to a database that already exists.
--
-- `schema.sql` describes a database created from nothing, and until this file
-- the only way to give a running database a new column was to drop it and
-- re-seed, which signs every member out and empties the workspace. Each
-- statement here is safe to run on every start: it does nothing the second
-- time. Anything added to schema.sql for an existing table belongs here too.

-- Majority vote: how many people may vote, counted when the vote is asked.
alter table approval_request add column if not exists electorate int;

-- A site owner can pause new intake for one workspace without hiding its existing records.
alter table tenant add column if not exists intake_paused_at timestamptz;
alter table tenant add column if not exists intake_pause_reason text;
alter table tenant add column if not exists is_scenario boolean not null default false;
update tenant set is_scenario = true where name like 'scenario:%' and not is_scenario;

-- Compiling AI drafts with failing sample scenarios stay private until the
-- scenarios pass again at the final publish boundary.
alter table process_draft add column if not exists ai_review_required boolean not null default false;

create table if not exists brand_asset (
  id uuid primary key,
  tenant_id uuid not null references tenant(id),
  draft_id uuid not null references process_draft(id) on delete cascade,
  kind text not null check (kind in ('logo', 'banner')),
  storage_key text not null unique,
  content_type text not null,
  byte_size int not null,
  created_at timestamptz not null default now()
);

create table if not exists process_draft_history (
  draft_id uuid not null references process_draft(id) on delete cascade,
  revision int not null,
  blueprint jsonb not null,
  actor_id uuid references actor(id),
  saved_at timestamptz not null default now(),
  primary key (draft_id, revision)
);
create or replace function record_process_draft_history() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into process_draft_history (draft_id, revision, blueprint, actor_id)
    values (new.id, new.revision, new.blueprint, new.updated_by)
    on conflict (draft_id, revision) do nothing;
  elsif new.blueprint is distinct from old.blueprint then
    insert into process_draft_history (draft_id, revision, blueprint, actor_id)
    values (new.id, new.revision, new.blueprint, new.updated_by)
    on conflict (draft_id, revision) do nothing;
  end if;
  return new;
end;
$$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'process_draft_history_write' and tgrelid = 'process_draft'::regclass) then
    create trigger process_draft_history_write after insert or update of blueprint on process_draft
      for each row execute function record_process_draft_history();
  end if;
end $$;
insert into process_draft_history (draft_id, revision, blueprint, actor_id, saved_at)
  select id, revision, blueprint, updated_by, updated_at from process_draft
  on conflict (draft_id, revision) do nothing;

create table if not exists ai_draft_job (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  actor_id uuid not null references actor(id),
  process_key text not null,
  process_name text,
  description text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed')),
  stage text not null default 'waiting',
  draft_id uuid,
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  completed_at timestamptz
);
alter table ai_draft_job add column if not exists stage text not null default 'waiting';
alter table ai_draft_job add column if not exists heartbeat_at timestamptz;
alter table ai_draft_job add column if not exists source_draft_id uuid;
alter table ai_draft_job add column if not exists source_revision int;
alter table ai_draft_job add column if not exists source_blueprint jsonb;
alter table ai_draft_job add column if not exists proposal jsonb;
alter table ai_draft_job add column if not exists review jsonb;
alter table ai_draft_job add column if not exists applied_at timestamptz;
-- What the worker is doing right now, for the page that is waiting.
alter table ai_draft_job add column if not exists note text;
-- What a staged draft has built so far: counts per stage, for the page.
alter table ai_draft_job add column if not exists progress jsonb;

-- Every model call the platform makes, with what it cost. The pipeline had
-- measured tokens and price on every attempt and thrown the numbers away.
create table if not exists ai_usage (
  id            bigserial primary key,
  tenant_id     uuid,
  actor_id      uuid,
  job_id        uuid,
  purpose       text not null,
  provider      text not null,
  model         text not null,
  stage         text not null,
  attempt       int not null,
  input_tokens  int,
  output_tokens int,
  cost_usd      numeric(12, 6),
  latency_ms    int,
  outcome       text not null,
  created_at    timestamptz not null default now()
);
create index if not exists ai_usage_recent on ai_usage (created_at desc);
create index if not exists ai_usage_tenant on ai_usage (tenant_id, created_at desc);
create index if not exists ai_draft_job_queue on ai_draft_job (created_at) where status in ('queued', 'running');
create unique index if not exists ai_draft_job_active_key on ai_draft_job (tenant_id, process_key) where status in ('queued', 'running');
update process_draft set ai_review_required = true
  where not ai_review_required and id in (select draft_id from ai_draft_job where draft_id is not null);

create table if not exists file_deletion (
  storage_key text primary key,
  queued_at timestamptz not null default now()
);

create table if not exists platform_operator (
  actor_id uuid primary key references actor(id),
  role text not null check (role in ('owner', 'operator', 'viewer')),
  granted_by uuid references actor(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists platform_worker_heartbeat (
  worker_id text primary key,
  seen_at timestamptz not null,
  actions bigint not null default 0,
  timers bigint not null default 0,
  webhooks bigint not null default 0,
  errors bigint not null default 0
);

create table if not exists platform_deployment (
  id bigserial primary key,
  revision text,
  environment text not null,
  started_at timestamptz not null default now()
);
create index if not exists platform_deployment_recent on platform_deployment (started_at desc);

create table if not exists platform_admin_audit (
  id bigserial primary key,
  actor_id uuid references actor(id),
  action text not null,
  tenant_id uuid references tenant(id),
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists platform_admin_audit_recent on platform_admin_audit (occurred_at desc, id desc);
create or replace function platform_admin_audit_is_append_only() returns trigger as $$
begin
  raise exception 'platform admin audit is append-only';
end;
$$ language plpgsql;
drop trigger if exists platform_admin_audit_no_change on platform_admin_audit;
create trigger platform_admin_audit_no_change before update or delete on platform_admin_audit
  for each row execute function platform_admin_audit_is_append_only();

-- Who took a spreadsheet of a whole process, when, and what it left out.
create table if not exists process_export (
  id          bigserial primary key,
  tenant_id   uuid not null,
  process_key text not null,
  actor       text,
  rows        int not null,
  withheld    text[] not null default '{}',
  filters     jsonb not null default '{}'::jsonb,
  request_id  text not null default 'unattributed',
  occurred_at timestamptz not null default now()
);
create index if not exists process_export_tenant on process_export (tenant_id, occurred_at desc);

-- A record sent to a colleague is a platform email of its own kind.
alter table platform_email drop constraint if exists platform_email_kind_check;
alter table platform_email add constraint platform_email_kind_check
  check (kind in ('invitation', 'verify_email', 'password_reset', 'delivery_alert', 'task_assigned', 'record_shared', 'scheduled_report',
                  'signature_request', 'signature_code', 'signature_completed', 'signature_declined', 'signature_reminder', 'signature_not_needed'));

-- The Records page's filters with a name, shared by the workspace; and, when
-- scheduled, emailed to whoever scheduled it, rendered under their roles.
create table if not exists saved_view (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  process_key  text not null,
  name         text not null,
  params       jsonb not null default '{}'::jsonb,
  created_by   uuid not null,
  schedule     text check (schedule in ('daily', 'weekly', 'monthly')),
  format       text not null default 'xlsx' check (format in ('csv', 'xlsx')),
  last_sent_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists saved_view_process on saved_view (tenant_id, process_key);
create index if not exists saved_view_due on saved_view (last_sent_at) where schedule is not null;

-- A device that asked to be told when work is waiting for its owner.
-- The endpoint is the push service's URL for that device; the two keys
-- encrypt each message for it alone (runtime/web-push.ts).
create table if not exists push_subscription (
  id           bigserial primary key,
  tenant_id    uuid not null,
  actor_id     uuid not null,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  failed_at    timestamptz
);
create index if not exists push_subscription_actor on push_subscription (actor_id);
-- When the people waited on were told by push; null until the worker has.
alter table approval_request add column if not exists notified_at timestamptz;
alter table task add column if not exists notified_at timestamptz;
alter table approval_request add column if not exists signature_name text;
alter table approval_vote add column if not exists signature_name text;

-- ------------------------------------------------------------ organisation
--
-- PRD Module 1 (ORG-02): the directory a workflow can route by. Until these
-- tables, "your manager" was an email the respondent typed, and the only
-- control on it was barring the submitter from approving their own claim.
-- A reporting line here is set by an administrator and dated, so a decision
-- made last March can still say who the manager was last March.

create table if not exists legal_entity (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  name        text not null,
  code        text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

-- Nested units: a department inside a division inside an entity. The parent
-- chain is checked for cycles in code, under the tenant's row lock, because a
-- check constraint cannot see other rows.
create table if not exists org_unit (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  name            text not null,
  parent_id       uuid references org_unit(id),
  legal_entity_id uuid references legal_entity(id),
  head_actor_id   uuid references actor(id),
  created_at      timestamptz not null default now(),
  check (parent_id is distinct from id)
);
create unique index if not exists org_unit_name_uq
  on org_unit (tenant_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- Who reports to whom, and since when. Closing a line (effective_to) rather
-- than deleting it is what lets the history explain an old approval. One
-- open primary line per person; dotted lines are extra and do not route.
create table if not exists reporting_line (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  actor_id       uuid not null references actor(id),
  manager_id     uuid not null references actor(id),
  kind           text not null default 'primary' check (kind in ('primary', 'dotted')),
  effective_from timestamptz not null default now(),
  effective_to   timestamptz,
  created_by     uuid references actor(id),
  created_at     timestamptz not null default now(),
  check (actor_id <> manager_id),
  constraint reporting_line_dates check (effective_to is null or effective_to >= effective_from)
);
create unique index if not exists reporting_line_open_primary_uq
  on reporting_line (tenant_id, actor_id) where kind = 'primary' and effective_to is null;
create index if not exists reporting_line_actor on reporting_line (tenant_id, actor_id, effective_from desc);

alter table actor add column if not exists org_unit_id uuid references org_unit(id);
alter table actor add column if not exists legal_entity_id uuid references legal_entity(id);
alter table actor add column if not exists position_title text;
-- A back-dated replacement may close the previous line at its own start, so a
-- zero-length line is allowed: it records a correction, not a tenure.
alter table reporting_line drop constraint if exists reporting_line_check1;
alter table reporting_line drop constraint if exists reporting_line_dates;
alter table reporting_line add constraint reporting_line_dates check (effective_to is null or effective_to >= effective_from);

-- --------------------------------------------------------------- authority
--
-- PRD Module 1, ORG-05 to ORG-07. Who may approve what, up to how much, and
-- who may act for whom. A role says somebody *can* approve; a grant says how
-- far. "A job title alone shall not imply authority": an approval that
-- declares an amount refuses anyone without a grant that covers it.

create table if not exists authority_grant (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  actor_id        uuid not null references actor(id),
  -- A process key, or '*' for every process that checks authority.
  decision_type   text not null default '*',
  -- Null is unlimited. Compared in the currency below.
  amount_limit    numeric(18, 2),
  currency        text not null default 'GBP',
  legal_entity_id uuid references legal_entity(id),
  valid_from      timestamptz not null default now(),
  valid_to        timestamptz,
  granted_by      uuid references actor(id),
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_by      uuid references actor(id),
  check (amount_limit is null or amount_limit >= 0),
  check (valid_to is null or valid_to > valid_from)
);
create index if not exists authority_grant_actor on authority_grant (tenant_id, actor_id) where revoked_at is null;

-- ORG-06: a delegation names the holder, the delegate, the scope and the
-- dates. The delegate never exceeds the holder's own limit, and may be
-- capped lower. Delegations do not chain: only the holder's own grants
-- count, never grants the holder was in turn delegated.
create table if not exists delegation (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  from_actor_id  uuid not null references actor(id),
  to_actor_id    uuid not null references actor(id),
  -- A process key, or '*'.
  scope          text not null default '*',
  amount_limit   numeric(18, 2),
  valid_from     timestamptz not null default now(),
  valid_to       timestamptz,
  reason         text,
  created_by     uuid references actor(id),
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  revoked_by     uuid references actor(id),
  check (from_actor_id <> to_actor_id),
  check (amount_limit is null or amount_limit >= 0),
  check (valid_to is null or valid_to > valid_from)
);
create index if not exists delegation_to on delegation (tenant_id, to_actor_id) where revoked_at is null;

-- Workspace-level administrative changes, append-only, like the platform
-- audit but for one tenant's own administrators: roles, access, managers,
-- grants, delegations. The record trail covers records; this covers people.
create table if not exists workspace_admin_audit (
  id          bigserial primary key,
  tenant_id   uuid not null references tenant(id),
  actor_id    uuid references actor(id),
  action      text not null,
  target_id   text,
  detail      jsonb not null default '{}'::jsonb,
  request_id  text,
  occurred_at timestamptz not null default now()
);
create index if not exists workspace_admin_audit_recent on workspace_admin_audit (tenant_id, occurred_at desc, id desc);
create or replace function workspace_admin_audit_is_append_only() returns trigger as $$
begin
  raise exception 'workspace admin audit is append-only';
end;
$$ language plpgsql;
drop trigger if exists workspace_admin_audit_no_change on workspace_admin_audit;
create trigger workspace_admin_audit_no_change before update or delete on workspace_admin_audit
  for each row execute function workspace_admin_audit_is_append_only();

-- ----------------------------------------------------------------- modules
--
-- PRD ORG-01: which modules a workspace has switched on, and the workspace
-- settings the modules share. The catalogue of modules lives in code
-- (runtime/modules.ts); this records the choice. Switching a module off hides
-- its templates and menus; it deletes nothing.

alter table tenant add column if not exists timezone text not null default 'Europe/London';
alter table tenant add column if not exists default_currency text not null default 'GBP';
alter table tenant add column if not exists locale text not null default 'en-GB';

create table if not exists tenant_module (
  tenant_id   uuid not null references tenant(id),
  module_key  text not null,
  enabled     boolean not null default true,
  plan        text,
  changed_by  uuid references actor(id),
  changed_at  timestamptz not null default now(),
  primary key (tenant_id, module_key)
);

-- ---------------------------------------------------------------- expenses
--
-- PRD Module 5. Approval says a claim may be paid; settlement says whether
-- it was (EXP-08), kept apart so a failed payment is never shown as paid.
-- Advances are their own record with what is still owed (EXP-06). The
-- policy numbers live in expense_settings, per workspace, and are copied
-- onto each claim when it is submitted, so changing them later never
-- changes how an old claim was routed.

create table if not exists expense_settings (
  tenant_id               uuid primary key references tenant(id),
  categories              jsonb not null default '["travel","accommodation","subsistence","equipment","training","other"]'::jsonb,
  auto_approve_limit      numeric(18, 2) not null default 100,
  manager_limit           numeric(18, 2) not null default 1000,
  line_limit              numeric(18, 2) not null default 200,
  receipt_threshold       numeric(18, 2) not null default 0,
  advance_retirement_days int not null default 14,
  updated_by              uuid references actor(id),
  updated_at              timestamptz not null default now(),
  check (auto_approve_limit >= 0 and manager_limit >= 0 and line_limit >= 0 and receipt_threshold >= 0),
  check (advance_retirement_days between 1 and 365)
);

create table if not exists expense_settlement (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  instance_id   uuid not null references instance(id) unique,
  claimant      text not null,
  amount        numeric(18, 2) not null check (amount >= 0),
  currency      text not null,
  -- awaiting_payment -> paid | failed; failed -> paid | void; nothing leaves paid.
  status        text not null default 'awaiting_payment'
                check (status in ('awaiting_payment', 'paid', 'failed', 'void')),
  reference     text,
  note          text,
  advance_id    uuid,
  paid_at       timestamptz,
  updated_by    uuid references actor(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists expense_settlement_open on expense_settlement (tenant_id, status, created_at desc);

create table if not exists cash_advance (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  instance_id   uuid not null references instance(id) unique,
  reference     text not null,
  holder        text not null,
  amount        numeric(18, 2) not null check (amount > 0),
  currency      text not null,
  -- approved -> disbursed -> (awaiting_return ->) retired; approved -> void.
  status        text not null default 'approved'
                check (status in ('approved', 'disbursed', 'awaiting_return', 'retired', 'void')),
  outstanding   numeric(18, 2) not null check (outstanding >= 0),
  spent         numeric(18, 2) not null default 0 check (spent >= 0),
  returned      numeric(18, 2) not null default 0 check (returned >= 0),
  disbursed_at  timestamptz,
  due_at        timestamptz,
  disbursed_ref text,
  updated_by    uuid references actor(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, reference)
);
create index if not exists cash_advance_open on cash_advance (tenant_id, status, due_at);

-- Every movement on an advance, append-only: what was spent against it by
-- which claim, and what was handed back.
create table if not exists advance_movement (
  id          bigserial primary key,
  tenant_id   uuid not null references tenant(id),
  advance_id  uuid not null references cash_advance(id),
  kind        text not null check (kind in ('disbursed', 'spent', 'returned', 'voided')),
  amount      numeric(18, 2) not null check (amount >= 0),
  instance_id uuid references instance(id),
  reference   text,
  actor_id    uuid references actor(id),
  occurred_at timestamptz not null default now()
);
create index if not exists advance_movement_by_advance on advance_movement (advance_id, id);
create or replace function advance_movement_is_append_only() returns trigger as $$
begin
  raise exception 'advance movements are append-only';
end;
$$ language plpgsql;
drop trigger if exists advance_movement_no_change on advance_movement;
create trigger advance_movement_no_change before update or delete on advance_movement
  for each row execute function advance_movement_is_append_only();

-- ------------------------------------------------- expenses, second stage
--
-- PRD Module 5: EXP-04 (currency), EXP-05 (budgets), EXP-07 (line-level
-- decisions), EXP-09 (beneficiary), EXP-10 (accounting export).

-- Settlement amounts are in the workspace currency. What was claimed, in
-- what currency, at what rate, is kept beside it; approved can be less than
-- requested once Finance has reviewed lines; advance_applied is what came
-- off an advance.
alter table expense_settlement add column if not exists requested_amount numeric(18, 2);
alter table expense_settlement add column if not exists approved_amount numeric(18, 2);
alter table expense_settlement add column if not exists advance_applied numeric(18, 2) not null default 0;
alter table expense_settlement add column if not exists original_currency text;
alter table expense_settlement add column if not exists original_amount numeric(18, 2);
alter table expense_settlement add column if not exists fx_rate numeric(18, 8);
alter table expense_settlement add column if not exists beneficiary_id uuid;
alter table expense_settlement add column if not exists beneficiary_version int;
alter table expense_settlement add column if not exists beneficiary_verified_version int;
alter table expense_settlement add column if not exists beneficiary_verified_by uuid references actor(id);
alter table expense_settlement add column if not exists beneficiary_verified_at timestamptz;
alter table expense_settlement add column if not exists export_id uuid;
alter table expense_settlement add column if not exists exported_at timestamptz;
update expense_settlement set requested_amount = amount where requested_amount is null;
update expense_settlement set approved_amount = amount + advance_applied where approved_amount is null;

alter table expense_settings add column if not exists account_codes jsonb not null default '{}'::jsonb;
alter table expense_settings add column if not exists default_account_code text;
alter table expense_settings add column if not exists require_verified_beneficiary boolean not null default true;

-- advance movements may now be reversed when Finance cuts a claim that had
-- already been set against an advance
alter table advance_movement drop constraint if exists advance_movement_kind_check;
alter table advance_movement add constraint advance_movement_kind_check
  check (kind in ('disbursed', 'spent', 'returned', 'voided', 'spent_reversed'));

-- EXP-07: Finance's decision on each line. The submitted amounts stay on
-- the record untouched; this holds the current decision and the history is
-- in the record's events.
create table if not exists expense_line_decision (
  tenant_id     uuid not null references tenant(id),
  instance_id   uuid not null references instance(id),
  line_index    int not null check (line_index >= 0),
  requested     numeric(18, 2) not null,
  approved      numeric(18, 2) not null check (approved >= 0),
  status        text not null check (status in ('approved', 'reduced', 'rejected')),
  reason        text,
  decided_by    uuid references actor(id),
  decided_at    timestamptz not null default now(),
  primary key (instance_id, line_index),
  check (approved <= requested)
);

-- EXP-04: rates Finance keeps, from a foreign currency into the workspace
-- currency. A claim takes the latest rate in force when it is submitted and
-- keeps it.
create table if not exists exchange_rate (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  from_currency  text not null check (from_currency ~ '^[A-Z]{3}$'),
  to_currency    text not null check (to_currency ~ '^[A-Z]{3}$'),
  rate           numeric(18, 8) not null check (rate > 0),
  effective_from timestamptz not null default now(),
  source         text not null,
  entered_by     uuid references actor(id),
  created_at     timestamptz not null default now(),
  check (from_currency <> to_currency)
);
create index if not exists exchange_rate_lookup on exchange_rate (tenant_id, from_currency, to_currency, effective_from desc);

-- EXP-05: a budget per cost centre per period, advisory or enforced.
create table if not exists expense_budget (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  cost_centre  text not null,
  period_start date not null,
  period_end   date not null,
  amount       numeric(18, 2) not null check (amount >= 0),
  mode         text not null default 'advisory' check (mode in ('advisory', 'enforced')),
  created_by   uuid references actor(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (period_end >= period_start)
);
create unique index if not exists expense_budget_period_uq on expense_budget (tenant_id, cost_centre, period_start);

-- What each claim holds against a budget: reserved while it is in progress,
-- consumed once approved (at the approved amount), released if it is not.
create table if not exists budget_reservation (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  budget_id   uuid not null references expense_budget(id),
  instance_id uuid not null references instance(id) unique,
  amount      numeric(18, 2) not null check (amount >= 0),
  status      text not null default 'reserved' check (status in ('reserved', 'consumed', 'released')),
  over_budget boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists budget_reservation_by_budget on budget_reservation (budget_id, status);

-- EXP-09: where a person is paid. The account number is sealed with the
-- application key and bound to this row's id; only the last four digits
-- are ever shown outside the reveal route. Each change bumps the version,
-- which invalidates any payment checked against the old one.
create table if not exists expense_beneficiary (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  holder          text not null,
  account_name    text not null,
  bank_name       text not null,
  bank_code       text,
  account_sealed  text not null,
  account_last4   text not null,
  version         int not null default 1,
  updated_by      uuid references actor(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, holder)
);

-- EXP-10: each export is a numbered batch, so a ledger import can be
-- reconciled against exactly the claims it contained.
create table if not exists expense_export (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  batch_no    int not null,
  rows        int not null,
  total       numeric(18, 2) not null,
  currency    text not null,
  checksum    text not null,
  created_by  uuid references actor(id),
  created_at  timestamptz not null default now(),
  unique (tenant_id, batch_no)
);

-- Directory import: people created from a spreadsheet, waiting for their
-- invitation to set a password.
alter table actor drop constraint if exists actor_provisioned_by_check;
alter table actor add constraint actor_provisioned_by_check
  check (provisioned_by in ('seed', 'signup', 'invite', 'scim', 'import'));

-- ------------------------------------------------------------- procurement
--
-- PRD Module 6. A purchase request is a process (blueprint finance kind
-- 'purchase'); its approval opens a requisition. Everything after that —
-- quotes, orders, receipts, invoices, payment — is a record here, because
-- each has its own state and its own controls, not a step in one form.

create table if not exists procurement_settings (
  tenant_id               uuid primary key references tenant(id),
  price_tolerance_pct     numeric(6, 2) not null default 2 check (price_tolerance_pct >= 0 and price_tolerance_pct <= 100),
  amount_tolerance        numeric(18, 2) not null default 0 check (amount_tolerance >= 0),
  order_increase_pct      numeric(6, 2) not null default 10 check (order_increase_pct >= 0),
  quotes_required         int not null default 1 check (quotes_required between 1 and 10),
  quotes_required_over    numeric(18, 2) not null default 0 check (quotes_required_over >= 0),
  require_vendor_bank_check boolean not null default true,
  updated_by              uuid references actor(id),
  updated_at              timestamptz not null default now()
);

-- PRC-01, PRC-02. A supplier and where it stands. The status change and
-- its reason are kept; approving a supplier is separate from checking its
-- bank details (PRC-08).
create table if not exists vendor (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id),
  name             text not null,
  registration_no  text,
  tax_id           text,
  contact_name     text,
  contact_email    text,
  contact_phone    text,
  categories       jsonb not null default '[]'::jsonb,
  legal_entity_id  uuid references legal_entity(id),
  documents_ref    text,
  due_diligence    text,
  status           text not null default 'draft'
                   check (status in ('draft', 'under_review', 'approved', 'restricted', 'suspended', 'archived')),
  status_reason    text,
  external_ref     text,
  version          int not null default 1,
  created_by       uuid references actor(id),
  approved_by      uuid references actor(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists vendor_name_uq on vendor (tenant_id, lower(name));

create table if not exists vendor_status_history (
  id          bigserial primary key,
  tenant_id   uuid not null references tenant(id),
  vendor_id   uuid not null references vendor(id),
  from_status text,
  to_status   text not null,
  reason      text,
  actor_id    uuid references actor(id),
  occurred_at timestamptz not null default now()
);

-- PRC-08. Sealed like staff bank details; each change bumps the version;
-- verification must be by someone other than whoever made the change.
create table if not exists vendor_bank (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  vendor_id      uuid not null references vendor(id) unique,
  account_name   text not null,
  bank_name      text not null,
  bank_code      text,
  account_sealed text not null,
  account_last4  text not null,
  version        int not null default 1,
  changed_by     uuid references actor(id),
  verified_version int,
  verified_by    uuid references actor(id),
  verified_at    timestamptz,
  updated_at     timestamptz not null default now()
);

-- PRC-09. A framework agreement: a limit, a period, and what orders have used.
create table if not exists vendor_agreement (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  vendor_id    uuid not null references vendor(id),
  title        text not null,
  limit_amount numeric(18, 2) not null check (limit_amount > 0),
  valid_from   date not null,
  valid_to     date not null,
  created_by   uuid references actor(id),
  created_at   timestamptz not null default now(),
  check (valid_to >= valid_from)
);

-- An approved purchase request, waiting to be sourced and ordered.
create table if not exists purchase_requisition (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  instance_id   uuid not null references instance(id) unique,
  reference     text not null,
  requester     text not null,
  title         text,
  amount        numeric(18, 2) not null,
  currency      text not null,
  cost_centre   text,
  needed_by     date,
  status        text not null default 'approved' check (status in ('approved', 'sourcing', 'ordered', 'cancelled')),
  quotes_open_at timestamptz,
  quotes_opened  boolean not null default false,
  selected_quote_id uuid,
  selection_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, reference)
);

-- PRC-04. A quote received for a requisition. Sealed quotes are recorded
-- but their amounts are withheld until they are opened after the deadline.
create table if not exists vendor_quote (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  requisition_id uuid not null references purchase_requisition(id),
  vendor_id      uuid not null references vendor(id),
  amount         numeric(18, 2) not null check (amount >= 0),
  lead_days      int,
  notes          text,
  document_ref   text,
  received_at    timestamptz not null default now(),
  entered_by     uuid references actor(id),
  unique (requisition_id, vendor_id)
);

-- PRC-05. An order and its lines. A material change makes a new revision;
-- an increase beyond the tolerance needs re-approval by someone else.
create table if not exists purchase_order (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  number          int not null,
  requisition_id  uuid references purchase_requisition(id),
  vendor_id       uuid not null references vendor(id),
  vendor_version  int not null,
  agreement_id    uuid references vendor_agreement(id),
  revision        int not null default 1,
  status          text not null default 'issued'
                  check (status in ('pending_approval', 'issued', 'partially_received', 'received', 'closed', 'cancelled')),
  currency        text not null,
  total           numeric(18, 2) not null check (total >= 0),
  approved_total  numeric(18, 2) not null,
  expected_by     date,
  delivery_location text,
  terms           text,
  exception_reason text,
  external_ref    text,
  created_by      uuid references actor(id),
  approved_by     uuid references actor(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, number)
);

create table if not exists purchase_order_line (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references purchase_order(id),
  line_no      int not null,
  description  text not null,
  kind         text not null default 'goods' check (kind in ('goods', 'service')),
  quantity     numeric(18, 3) not null check (quantity > 0),
  unit_price   numeric(18, 2) not null check (unit_price >= 0),
  unique (order_id, line_no)
);

create table if not exists purchase_order_revision (
  id         bigserial primary key,
  order_id   uuid not null references purchase_order(id),
  revision   int not null,
  total      numeric(18, 2) not null,
  lines      jsonb not null,
  vendor_id  uuid not null,
  reason     text,
  actor_id   uuid references actor(id),
  occurred_at timestamptz not null default now()
);

-- PRC-06. What arrived, line by line: accepted, rejected (with a reason),
-- and returned later. Append-only; a correction is another row.
create table if not exists goods_receipt (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  order_id    uuid not null references purchase_order(id),
  line_id     uuid not null references purchase_order_line(id),
  accepted    numeric(18, 3) not null default 0 check (accepted >= 0),
  rejected    numeric(18, 3) not null default 0 check (rejected >= 0),
  returned    numeric(18, 3) not null default 0 check (returned >= 0),
  reason      text,
  evidence_ref text,
  received_at timestamptz not null default now(),
  received_by uuid references actor(id),
  check (accepted + rejected + returned > 0)
);
create or replace function goods_receipt_is_append_only() returns trigger as $$
begin
  raise exception 'goods receipts are append-only';
end;
$$ language plpgsql;
drop trigger if exists goods_receipt_no_change on goods_receipt;
create trigger goods_receipt_no_change before update or delete on goods_receipt
  for each row execute function goods_receipt_is_append_only();

-- PRC-07. An invoice against an order, matched to what was accepted.
create table if not exists vendor_invoice (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  vendor_id     uuid not null references vendor(id),
  order_id      uuid not null references purchase_order(id),
  invoice_no    text not null,
  invoice_date  date not null,
  currency      text not null,
  total         numeric(18, 2) not null check (total >= 0),
  status        text not null default 'held'
                check (status in ('held', 'approved', 'paid', 'rejected', 'void')),
  mismatches    jsonb not null default '[]'::jsonb,
  review_reason text,
  reviewed_by   uuid references actor(id),
  entered_by    uuid references actor(id),
  bank_version  int,
  payment_ref   text,
  paid_at       timestamptz,
  external_ref  text,
  exported_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, vendor_id, invoice_no)
);

create table if not exists vendor_invoice_line (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references vendor_invoice(id),
  line_id     uuid not null references purchase_order_line(id),
  quantity    numeric(18, 3) not null check (quantity > 0),
  unit_price  numeric(18, 2) not null check (unit_price >= 0)
);


alter table procurement_settings add column if not exists manager_limit numeric(18, 2) not null default 1000;

-- ---------------------------------------------------------------- people HR
--
-- PRD Module 7. Employment records, lifecycle cases (onboarding, offboarding,
-- transfer, probation, urgent termination) built from editable templates of
-- team tasks, leave, document acknowledgments, restricted case notes, and the
-- declared owner of each HR field. Teams see their tasks and the basic facts
-- about a person; pay, notes and restricted cases are HR's alone.

-- A future employee can sign in to do their own onboarding tasks and nothing
-- else, until the activation task gives them their real role (acceptance 1).
alter table actor drop constraint if exists actor_workspace_role_check;
alter table actor add constraint actor_workspace_role_check
  check (workspace_role in ('owner','admin','builder','operator','approver','analyst','read_only','pre_hire','auditor'));
alter table invitation drop constraint if exists invitation_workspace_role_check;
alter table invitation add constraint invitation_workspace_role_check
  check (workspace_role in ('owner','admin','builder','operator','approver','analyst','read_only','pre_hire','auditor'));

create table if not exists hr_settings (
  tenant_id          uuid primary key references tenant(id),
  -- HR-12: who owns each field. 'patform' or the name of the outside system.
  field_owners       jsonb not null default '{"identity":"patform","employment_status":"patform","compensation":"patform","leave_balance":"patform","payroll_ref":"patform"}'::jsonb,
  activation_role    text not null default 'read_only',
  anniversary_notice_days int not null default 14,
  updated_by         uuid references actor(id),
  updated_at         timestamptz not null default now()
);

-- Who is in which team. HR is also every owner and admin.
create table if not exists hr_team_member (
  tenant_id  uuid not null references tenant(id),
  team       text not null check (team in ('hr', 'it', 'facilities', 'finance')),
  actor_id   uuid not null references actor(id),
  added_at   timestamptz not null default now(),
  primary key (tenant_id, team, actor_id)
);

create table if not exists employee_record (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id),
  actor_id         uuid references actor(id),
  email            text not null,
  name             text not null,
  employment_type  text not null default 'employee' check (employment_type in ('employee', 'contractor', 'intern')),
  status           text not null default 'pre_hire' check (status in ('pre_hire', 'active', 'leaving', 'left')),
  location         text,
  start_date       date,
  end_date         date,
  probation_end    date,
  payroll_ref      text,
  external_ref     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, email)
);
create unique index if not exists employee_record_actor_uq on employee_record (actor_id) where actor_id is not null;

-- HR-06: pay is separate, so no query that serves a team can reach it.
create table if not exists employee_compensation (
  id             bigserial primary key,
  tenant_id      uuid not null references tenant(id),
  employee_id    uuid not null references employee_record(id),
  amount         numeric(18, 2) not null check (amount >= 0),
  currency       text not null,
  period         text not null default 'year' check (period in ('year', 'month', 'hour')),
  effective_from date not null,
  reason         text,
  entered_by     uuid references actor(id),
  created_at     timestamptz not null default now()
);

create table if not exists employee_certification (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  employee_id uuid not null references employee_record(id),
  name        text not null,
  expires_on  date not null,
  created_at  timestamptz not null default now()
);

-- HR-02, HR-03: a template is a list of team tasks; a task may wait for
-- other tasks and for the start or end date, and may carry an action.
create table if not exists lifecycle_template (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  kind        text not null check (kind in ('onboarding', 'offboarding', 'transfer', 'probation')),
  name        text not null,
  employment_type text,
  location    text,
  tasks       jsonb not null,
  active      boolean not null default true,
  updated_by  uuid references actor(id),
  updated_at  timestamptz not null default now()
);

create table if not exists lifecycle_case (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  employee_id   uuid not null references employee_record(id),
  kind          text not null check (kind in ('onboarding', 'offboarding', 'transfer', 'probation', 'urgent_termination')),
  status        text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  restricted    boolean not null default false,
  effective_date date,
  summary       text,
  changes       jsonb,
  applied_at    timestamptz,
  authorized_by uuid references actor(id),
  created_by    uuid references actor(id),
  created_at    timestamptz not null default now(),
  closed_at     timestamptz
);
create index if not exists lifecycle_case_open on lifecycle_case (tenant_id, status, kind);

create table if not exists lifecycle_task (
  id            uuid primary key default gen_random_uuid(),
  case_id       uuid not null references lifecycle_case(id),
  key           text not null,
  title         text not null,
  team          text not null check (team in ('hr', 'it', 'facilities', 'finance', 'manager', 'employee')),
  critical      boolean not null default false,
  prerequisites jsonb not null default '[]'::jsonb,
  wait_until    date,
  action        text check (action in ('activate_access', 'revoke_access', 'finance_clearance', 'recover_assets')),
  status        text not null default 'open' check (status in ('open', 'done', 'excepted')),
  note          text,
  evidence_ref  text,
  completed_by  uuid references actor(id),
  completed_at  timestamptz,
  unique (case_id, key)
);

-- HR-10: notes on a case, kept to HR unless shared, and labelled by kind.
create table if not exists case_note (
  id          bigserial primary key,
  case_id     uuid not null references lifecycle_case(id),
  category    text not null default 'general' check (category in ('general', 'health', 'disciplinary', 'compensation')),
  shared      boolean not null default false,
  body        text not null,
  author_id   uuid references actor(id),
  created_at  timestamptz not null default now(),
  check (category = 'general' or not shared)
);

-- HR-05: leave.
create table if not exists leave_type (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  key          text not null,
  name         text not null,
  annual_days  numeric(6, 2) not null default 0 check (annual_days >= 0),
  unlimited    boolean not null default false,
  active       boolean not null default true,
  unique (tenant_id, key)
);
create table if not exists leave_entitlement (
  tenant_id    uuid not null references tenant(id),
  employee_id  uuid not null references employee_record(id),
  leave_type_id uuid not null references leave_type(id),
  year         int not null,
  days         numeric(6, 2) not null check (days >= 0),
  primary key (employee_id, leave_type_id, year)
);
create table if not exists public_holiday (
  tenant_id  uuid not null references tenant(id),
  day        date not null,
  name       text not null,
  primary key (tenant_id, day)
);
create table if not exists leave_request (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  employee_id   uuid not null references employee_record(id),
  leave_type_id uuid not null references leave_type(id),
  start_date    date not null,
  end_date      date not null,
  days          numeric(6, 2) not null check (days > 0),
  reason        text,
  status        text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'cancelled')),
  approver_id   uuid references actor(id),
  decided_by    uuid references actor(id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists leave_request_employee on leave_request (employee_id, start_date);

-- HR-07: documents to receive or agree to, by version.
create table if not exists hr_document (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  title       text not null,
  version     text not null,
  kind        text not null check (kind in ('receipt', 'agreement')),
  document_ref text,
  created_by  uuid references actor(id),
  created_at  timestamptz not null default now(),
  unique (tenant_id, title, version)
);
create table if not exists document_request (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  document_id     uuid not null references hr_document(id),
  employee_id     uuid not null references employee_record(id),
  due_date        date,
  status          text not null default 'sent' check (status in ('sent', 'acknowledged', 'excepted')),
  statement       text,
  acknowledged_at timestamptz,
  exception_reason text,
  created_at      timestamptz not null default now(),
  unique (document_id, employee_id)
);

-- HR-12: a change to a field another system owns becomes a task, not an overwrite.
create table if not exists hr_reconciliation (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  employee_id uuid not null references employee_record(id),
  field       text not null,
  owner       text not null,
  current_value text,
  proposed_value text,
  status      text not null default 'open' check (status in ('open', 'applied', 'dismissed')),
  raised_by   uuid references actor(id),
  resolved_by uuid references actor(id),
  note        text,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

-- HR-01: an approved hiring request, waiting for its hires.
create table if not exists hiring_requisition (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  instance_id  uuid not null references instance(id) unique,
  reference    text not null,
  position     text not null,
  headcount    int not null check (headcount > 0),
  filled       int not null default 0 check (filled >= 0),
  cost_centre  text,
  amount       numeric(18, 2) not null default 0,
  status       text not null default 'open' check (status in ('open', 'filled', 'cancelled')),
  created_at   timestamptz not null default now(),
  check (filled <= headcount)
);
alter table lifecycle_case add column if not exists hiring_id uuid references hiring_requisition(id);

-- ------------------------------------------------------------- appraisals
--
-- PRD Module 8. A template is versioned and validated before publication;
-- a cycle copies the published template, so a result can always be
-- recomputed from what was used at the time (11.3). Each stage has its own
-- window and visibility. Calibration keeps the original score. A rating
-- never changes pay: recommendations are separate and need HR approval.

create table if not exists review_template (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  name        text not null,
  version     int not null default 1,
  status      text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  scale_min   int not null default 1,
  scale_max   int not null default 5,
  na_policy   text not null default 'block' check (na_policy in ('block', 'redistribute')),
  decimals    int not null default 2 check (decimals between 0 and 4),
  sections    jsonb not null,
  created_by  uuid references actor(id),
  created_at  timestamptz not null default now(),
  published_at timestamptz,
  check (scale_max > scale_min)
);

create table if not exists review_cycle (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  name          text not null,
  kind          text not null check (kind in ('annual', 'quarterly', 'probation', 'project', 'continuous')),
  template      jsonb not null,
  template_id   uuid references review_template(id),
  eligibility   jsonb not null default '{}'::jsonb,
  stages        jsonb not null,
  peer_mode     text not null default 'confidential' check (peer_mode in ('identified', 'confidential')),
  min_cohort    int not null default 3 check (min_cohort between 2 and 20),
  status        text not null default 'draft' check (status in ('draft', 'active', 'published', 'closed')),
  created_by    uuid references actor(id),
  created_at    timestamptz not null default now(),
  launched_at   timestamptz,
  published_at  timestamptz
);

-- The eligibility snapshot (APR-01): who was in, and why, at launch.
create table if not exists review_participant (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  cycle_id      uuid not null references review_cycle(id),
  actor_id      uuid not null references actor(id),
  manager_id    uuid references actor(id),
  eligible      boolean not null default true,
  reason        text,
  needs_reviewer boolean not null default false,
  reviewer_note text,
  unique (cycle_id, actor_id)
);

create table if not exists reviewer_assignment (
  id             uuid primary key default gen_random_uuid(),
  participant_id uuid not null references review_participant(id),
  reviewer_id    uuid not null references actor(id),
  stage          text not null check (stage in ('self', 'peer', 'manager', 'additional')),
  active         boolean not null default true,
  assigned_by    uuid references actor(id),
  reason         text,
  created_at     timestamptz not null default now(),
  ended_at       timestamptz,
  ended_reason   text
);
create unique index if not exists reviewer_assignment_active_uq on reviewer_assignment (participant_id, reviewer_id, stage) where active;

-- A response by one reviewer at one stage. Kept, and attributed, even when
-- the assignment ends (acceptance 5).
create table if not exists assessment (
  id             uuid primary key default gen_random_uuid(),
  participant_id uuid not null references review_participant(id),
  assignment_id  uuid not null references reviewer_assignment(id) unique,
  reviewer_id    uuid not null references actor(id),
  stage          text not null,
  responses      jsonb not null default '{}'::jsonb,
  narrative      text,
  recommendation jsonb,
  calculation    jsonb,
  score          numeric(8, 4),
  status         text not null default 'draft' check (status in ('draft', 'submitted')),
  submitted_at   timestamptz,
  updated_at     timestamptz not null default now()
);

create table if not exists calibration_adjustment (
  id             bigserial primary key,
  participant_id uuid not null references review_participant(id),
  original_score numeric(8, 4),
  adjusted_score numeric(8, 4) not null,
  evidence       text not null,
  reason         text not null,
  actor_id       uuid references actor(id),
  occurred_at    timestamptz not null default now()
);
create or replace function calibration_is_append_only() returns trigger as $$
begin
  raise exception 'calibration adjustments are append-only';
end;
$$ language plpgsql;
drop trigger if exists calibration_no_change on calibration_adjustment;
create trigger calibration_no_change before update or delete on calibration_adjustment
  for each row execute function calibration_is_append_only();

create table if not exists review_result (
  participant_id   uuid primary key references review_participant(id),
  manager_score    numeric(8, 4),
  calibrated_score numeric(8, 4),
  summary          text,
  published_at     timestamptz not null default now(),
  acknowledged_at  timestamptz,
  acknowledgement  text,
  appeal_status    text not null default 'none' check (appeal_status in ('none', 'open', 'upheld', 'changed'))
);

create table if not exists review_appeal (
  id              uuid primary key default gen_random_uuid(),
  participant_id  uuid not null references review_participant(id),
  reason          text not null,
  reviewer_id     uuid references actor(id),
  due_date        date not null,
  status          text not null default 'open' check (status in ('open', 'upheld', 'changed')),
  outcome         text,
  new_score       numeric(8, 4),
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);

-- APR-11: a recommendation is only a proposal until HR approves it.
create table if not exists review_recommendation (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  participant_id uuid not null references review_participant(id),
  kind           text not null check (kind in ('promotion', 'pay_increase')),
  detail         text not null,
  status         text not null default 'proposed' check (status in ('proposed', 'approved', 'declined')),
  decided_by     uuid references actor(id),
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now()
);

create table if not exists goal (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id),
  owner_id         uuid not null references actor(id),
  cycle_id         uuid references review_cycle(id),
  aligned_to       uuid references goal(id),
  title            text not null,
  description      text,
  success_criteria text not null,
  weight           numeric(6, 2) not null default 0 check (weight >= 0 and weight <= 100),
  target_date      date,
  status           text not null default 'draft' check (status in ('draft', 'approved', 'achieved', 'missed', 'withdrawn')),
  progress         int not null default 0 check (progress between 0 and 100),
  evidence         text,
  approved_by      uuid references actor(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create table if not exists goal_revision (
  id          bigserial primary key,
  goal_id     uuid not null references goal(id),
  proposed    jsonb not null,
  previous    jsonb not null,
  reason      text not null,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  proposed_by uuid references actor(id),
  decided_by  uuid references actor(id),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);

create table if not exists development_item (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  employee_id    uuid not null references actor(id),
  participant_id uuid references review_participant(id),
  kind           text not null check (kind in ('action', 'training', 'checkin')),
  title          text not null,
  owner_id       uuid references actor(id),
  due_date       date,
  status         text not null default 'open' check (status in ('open', 'done', 'dropped')),
  evidence       text,
  created_by     uuid references actor(id),
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);

-- ------------------------------------------------------ assets and service
--
-- PRD Module 9. An asset is registered against what was received, never
-- straight from an order. Custody is a history of assignments; returning
-- ends one, it never deletes it. Access is pending until the target system
-- confirms or an authorised person records evidence, and a failed
-- revocation stays on its own list whatever happens to the HR case.

create table if not exists ops_settings (
  tenant_id  uuid primary key references tenant(id),
  settings   jsonb not null default '{}'::jsonb,
  updated_by uuid references actor(id),
  updated_at timestamptz not null default now()
);

create table if not exists asset (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  tag             text not null,
  category        text not null,
  name            text not null,
  serial          text,
  owner_entity    text,
  location        text,
  acquisition_ref text,
  order_line_id   uuid references purchase_order_line(id),
  warranty_until  date,
  condition       text not null default 'good' check (condition in ('new', 'good', 'fair', 'poor', 'broken')),
  status          text not null default 'in_stock' check (status in ('in_stock', 'assigned', 'in_repair', 'restricted', 'lost', 'retired', 'disposed')),
  shared          boolean not null default false,
  restricted_reason text,
  created_by      uuid references actor(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, tag)
);

create table if not exists asset_event (
  id         bigserial primary key,
  asset_id   uuid not null references asset(id),
  kind       text not null,
  detail     jsonb not null default '{}'::jsonb,
  actor_id   uuid references actor(id),
  occurred_at timestamptz not null default now()
);
create or replace function asset_event_is_append_only() returns trigger as $$
begin
  raise exception 'asset history is append-only';
end;
$$ language plpgsql;
drop trigger if exists asset_event_no_change on asset_event;
create trigger asset_event_no_change before update or delete on asset_event
  for each row execute function asset_event_is_append_only();

create table if not exists asset_assignment (
  id             uuid primary key default gen_random_uuid(),
  asset_id       uuid not null references asset(id),
  custodian_id   uuid not null references actor(id),
  status         text not null default 'pending_ack' check (status in ('pending_approval', 'pending_ack', 'active', 'returned', 'cancelled')),
  approved_by    uuid references actor(id),
  assigned_by    uuid references actor(id),
  condition_out  text not null,
  accessories    jsonb not null default '[]'::jsonb,
  handover_ref   text,
  acknowledged_at timestamptz,
  acknowledgement text,
  returned_at    timestamptz,
  condition_in   text,
  accessories_in jsonb,
  return_ref     text,
  returned_by    uuid references actor(id),
  case_id        uuid references lifecycle_case(id),
  created_at     timestamptz not null default now()
);
create index if not exists asset_assignment_open on asset_assignment (asset_id) where status in ('pending_approval', 'pending_ack', 'active');

create table if not exists access_system (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id),
  name       text not null,
  owner_id   uuid not null references actor(id),
  connector_actor_id uuid references actor(id),
  roles      jsonb not null default '[]'::jsonb,
  max_days   int,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table if not exists access_request (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  number        int not null,
  system_id     uuid not null references access_system(id),
  role          text not null,
  holder_id     uuid not null references actor(id),
  requested_by  uuid not null references actor(id),
  justification text not null,
  expires_on    date,
  status        text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'provisioned', 'failed', 'cancelled')),
  decided_by    uuid references actor(id),
  decided_at    timestamptz,
  decision_note text,
  provisioned_via text check (provisioned_via in ('connector', 'manual')),
  evidence_ref  text,
  provisioned_by uuid references actor(id),
  provisioned_at timestamptz,
  failure_note  text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, number)
);

create table if not exists access_grant (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  system_id    uuid not null references access_system(id),
  role         text not null,
  holder_id    uuid not null references actor(id),
  request_id   uuid references access_request(id),
  status       text not null default 'active' check (status in ('active', 'revoking', 'revoked', 'revoke_failed')),
  granted_at   timestamptz not null default now(),
  expires_on   date,
  revoke_requested_at timestamptz,
  revoke_reason text,
  revoked_via  text,
  revoke_evidence text,
  revoked_by   uuid references actor(id),
  revoked_at   timestamptz,
  failure_note text,
  failed_at    timestamptz,
  reviewed_at  timestamptz,
  reviewed_by  uuid references actor(id),
  review_note  text
);

create table if not exists service_type (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  key         text not null,
  name        text not null,
  description text,
  team        text not null check (team in ('it', 'facilities')),
  approval    text not null default 'none' check (approval in ('none', 'manager')),
  fields      jsonb not null default '[]'::jsonb,
  roles       jsonb,
  respond_hours numeric(8, 2) not null default 8,
  resolve_hours numeric(8, 2) not null default 40,
  evidence_required boolean not null default false,
  active      boolean not null default true,
  unique (tenant_id, key)
);

create table if not exists ticket (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  number        int not null,
  type_id       uuid references service_type(id),
  kind          text not null default 'request' check (kind in ('request', 'incident', 'corrective')),
  title         text not null,
  description   text,
  details       jsonb not null default '{}'::jsonb,
  requester_id  uuid not null references actor(id),
  team          text not null,
  assignee_id   uuid references actor(id),
  impact        int not null default 3 check (impact between 1 and 3),
  urgency       int not null default 3 check (urgency between 1 and 3),
  priority      int not null default 4 check (priority between 1 and 4),
  status        text not null default 'new' check (status in ('awaiting_approval', 'new', 'in_progress', 'waiting_on_user', 'resolved', 'closed', 'cancelled', 'rejected')),
  approver_id   uuid references actor(id),
  approved_by   uuid references actor(id),
  approved_at   timestamptz,
  respond_due   timestamptz,
  resolve_due   timestamptz,
  responded_at  timestamptz,
  paused_since  timestamptz,
  paused_seconds int not null default 0,
  breached_at   timestamptz,
  escalated_at  timestamptz,
  resolution    text,
  resolution_evidence text,
  resolved_at   timestamptz,
  closed_at     timestamptz,
  reopened      int not null default 0,
  asset_id      uuid references asset(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, number)
);

create table if not exists ticket_note (
  id         bigserial primary key,
  ticket_id  uuid not null references ticket(id),
  kind       text not null check (kind in ('work_note', 'update', 'system')),
  body       text not null,
  author_id  uuid references actor(id),
  occurred_at timestamptz not null default now()
);

create table if not exists maintenance_plan (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  asset_id    uuid not null references asset(id),
  title       text not null,
  every_days  int not null check (every_days between 1 and 3660),
  checklist   jsonb not null,
  team        text not null check (team in ('it', 'facilities')),
  next_due    date not null,
  active      boolean not null default true,
  created_by  uuid references actor(id),
  created_at  timestamptz not null default now()
);

-- Acceptance 4: one job per plan and date, however often the scheduler runs.
create table if not exists maintenance_job (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  plan_id     uuid not null references maintenance_plan(id),
  asset_id    uuid not null references asset(id),
  due_on      date not null,
  status      text not null default 'open' check (status in ('open', 'done')),
  draft       jsonb,
  version     int not null default 0,
  results     jsonb,
  findings    text,
  photos      jsonb not null default '[]'::jsonb,
  location    jsonb,
  outcome     text check (outcome in ('pass', 'fail')),
  follow_up_ticket uuid references ticket(id),
  completed_by uuid references actor(id),
  completed_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (plan_id, due_on)
);

create table if not exists change_request (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  number        int not null,
  title         text not null,
  kind          text not null default 'normal' check (kind in ('normal', 'emergency')),
  description   text,
  impact        text not null,
  risk          text not null check (risk in ('low', 'medium', 'high')),
  system_id     uuid references access_system(id),
  asset_id      uuid references asset(id),
  preconditions jsonb not null default '[]'::jsonb,
  rollback_plan text not null,
  window_start  timestamptz,
  window_end    timestamptz,
  status        text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected', 'in_progress', 'completed', 'failed', 'rolled_back')),
  requested_by  uuid not null references actor(id),
  approved_by   uuid references actor(id),
  approved_at   timestamptz,
  decision_note text,
  started_by    uuid references actor(id),
  started_at    timestamptz,
  finished_at   timestamptz,
  verification  text,
  retrospective text,
  retrospective_by uuid references actor(id),
  retrospective_at timestamptz,
  created_at    timestamptz not null default now(),
  unique (tenant_id, number)
);

-- Module 9: offboarding's equipment task checks the asset register.
alter table lifecycle_task drop constraint if exists lifecycle_task_action_check;
alter table lifecycle_task add constraint lifecycle_task_action_check check (action in ('activate_access', 'revoke_access', 'finance_clearance', 'recover_assets'));

-- Photos for maintenance, hand-outs, returns and tickets. Stored in S3 under
-- ops/photos/, viewed only through short-lived links once the malware scan
-- has passed.
create table if not exists ops_photo (
  id            uuid primary key,
  tenant_id     uuid not null references tenant(id),
  asset_id      uuid references asset(id),
  job_id        uuid references maintenance_job(id),
  assignment_id uuid references asset_assignment(id),
  ticket_id     uuid references ticket(id),
  filename      text not null,
  content_type  text not null,
  byte_size     int not null,
  checksum      text not null,
  storage_key   text not null,
  scan_status   text not null default 'unscanned' check (scan_status in ('unscanned', 'clean', 'quarantined')),
  uploaded_by   uuid references actor(id),
  created_at    timestamptz not null default now(),
  check (num_nonnulls(asset_id, job_id, assignment_id, ticket_id) >= 1)
);

-- A general connector: Patform posts signed requests to the system's address
-- when access is approved or removed, and the system answers or calls back.
alter table access_system add column if not exists connector_url text;
alter table access_system add column if not exists connector_secret text;

create table if not exists ops_connector_delivery (
  id            bigserial primary key,
  tenant_id     uuid not null references tenant(id),
  system_id     uuid not null references access_system(id),
  kind          text not null check (kind in ('provision', 'revoke')),
  request_id    uuid references access_request(id),
  grant_id      uuid references access_grant(id),
  payload       jsonb not null,
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'done', 'failed')),
  attempts      int not null default 0,
  available_at  timestamptz not null default now(),
  claimed_by    text,
  response_status int,
  last_error    text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create unique index if not exists ops_connector_delivery_request on ops_connector_delivery (request_id) where kind = 'provision';
create unique index if not exists ops_connector_delivery_grant on ops_connector_delivery (grant_id) where kind = 'revoke';

-- Ready-made directory connectors: Microsoft 365 (Graph) and Google Workspace
-- (Admin SDK). Each role maps to a group; the app identity is in the
-- environment, the customer's directory is chosen here.
alter table access_system add column if not exists connector_kind text check (connector_kind in ('webhook', 'microsoft365', 'google_workspace'));
alter table access_system add column if not exists connector_config jsonb;

-- ------------------------------------------- contracts, compliance, audit
--
-- PRD Module 10. Contracts carry versions, and approvals belong to a
-- version: a material revision invalidates them. Obligations and renewal
-- reminders become dated tasks, created once each. Policies, controls,
-- audit engagements and findings keep their history. Auditors get scoped,
-- time-limited, read-only access, and everything they open is logged.
-- Legal holds stop deletion and are visible only to the people who manage
-- them. Storing controls here is not a certification.

-- A new workspace role: an external auditor holds no capability at all and
-- sees only what an engagement grants, until it expires.
alter table actor drop constraint if exists actor_workspace_role_check;
alter table actor add constraint actor_workspace_role_check
  check (workspace_role in ('owner','admin','builder','operator','approver','analyst','read_only','pre_hire','auditor'));
alter table invitation drop constraint if exists invitation_workspace_role_check;
alter table invitation add constraint invitation_workspace_role_check
  check (workspace_role in ('owner','admin','builder','operator','approver','analyst','read_only','pre_hire','auditor'));

create table if not exists gov_member (
  tenant_id  uuid not null references tenant(id),
  team       text not null check (team in ('legal', 'compliance', 'security', 'finance')),
  actor_id   uuid not null references actor(id),
  added_at   timestamptz not null default now(),
  primary key (tenant_id, team, actor_id)
);

create table if not exists gov_settings (
  tenant_id  uuid primary key references tenant(id),
  settings   jsonb not null default '{}'::jsonb,
  updated_by uuid references actor(id),
  updated_at timestamptz not null default now()
);

create table if not exists contract (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  number          int not null,
  title           text not null,
  counterparty    text not null,
  vendor_id       uuid references vendor(id),
  entity          text,
  project         text,
  owner_id        uuid not null references actor(id),
  value           numeric(18, 2),
  currency        text,
  start_date      date,
  end_date        date,
  auto_renews     boolean not null default false,
  notice_days     int check (notice_days between 0 and 3650),
  notice_calendar text not null default 'calendar' check (notice_calendar in ('calendar', 'business')),
  personal_data   boolean not null default false,
  status          text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'out_for_signature', 'signed', 'expired', 'terminated')),
  current_version int not null default 1,
  created_by      uuid references actor(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, number)
);

create table if not exists contract_version (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid not null references contract(id),
  version      int not null,
  document_ref text,
  changes      text,
  material     boolean not null default true,
  terms        jsonb not null,
  created_by   uuid references actor(id),
  created_at   timestamptz not null default now(),
  unique (contract_id, version)
);

create table if not exists contract_review (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid not null references contract(id),
  version      int not null,
  discipline   text not null check (discipline in ('business', 'legal', 'security', 'finance')),
  reviewer_id  uuid not null references actor(id),
  decision     text not null check (decision in ('approved', 'changes_requested')),
  note         text,
  decided_at   timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidated_reason text
);

create table if not exists contract_envelope (
  id            uuid primary key default gen_random_uuid(),
  contract_id   uuid not null references contract(id),
  version       int not null,
  provider      text not null,
  envelope_ref  text not null,
  status        text not null default 'sent' check (status in ('sent', 'delivered', 'completed', 'declined', 'voided')),
  signed_artifact_ref text,
  history       jsonb not null default '[]'::jsonb,
  created_by    uuid references actor(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists obligation (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  contract_id   uuid references contract(id),
  title         text not null,
  owner_id      uuid not null references actor(id),
  kind          text not null check (kind in ('recurring', 'one_off', 'event')),
  every_months  int check (every_months between 1 and 120),
  next_due      date,
  evidence_required boolean not null default true,
  escalate_after_days int not null default 7,
  escalate_to   uuid references actor(id),
  active        boolean not null default true,
  created_by    uuid references actor(id),
  created_at    timestamptz not null default now()
);

-- Acceptance 2 and GOV-04: one task per obligation and date, and one renewal
-- task per contract and notice deadline, however often the scheduler runs.
create table if not exists obligation_task (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  obligation_id uuid references obligation(id),
  contract_id   uuid references contract(id),
  kind          text not null check (kind in ('obligation', 'renewal')),
  title         text not null,
  due_on        date not null,
  notice_deadline date,
  owner_id      uuid not null references actor(id),
  status        text not null default 'open' check (status in ('open', 'done', 'waived')),
  evidence      text,
  note          text,
  completed_by  uuid references actor(id),
  completed_at  timestamptz,
  escalated_at  timestamptz,
  created_at    timestamptz not null default now()
);
create unique index if not exists obligation_task_once on obligation_task (obligation_id, due_on) where kind = 'obligation';
create unique index if not exists renewal_task_once on obligation_task (contract_id, notice_deadline) where kind = 'renewal';

create table if not exists policy (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id),
  title      text not null,
  owner_id   uuid not null references actor(id),
  created_at timestamptz not null default now()
);
create table if not exists policy_version (
  id            uuid primary key default gen_random_uuid(),
  policy_id     uuid not null references policy(id),
  version       int not null,
  summary       text not null,
  document_ref  text,
  status        text not null default 'draft' check (status in ('draft', 'approved', 'published', 'superseded')),
  effective_from date,
  created_by    uuid references actor(id),
  approved_by   uuid references actor(id),
  approved_at   timestamptz,
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (policy_id, version)
);
create table if not exists policy_campaign (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  policy_version_id uuid not null references policy_version(id),
  audience          jsonb not null default '{}'::jsonb,
  due_on            date not null,
  created_by        uuid references actor(id),
  created_at        timestamptz not null default now()
);
create table if not exists policy_ack (
  campaign_id     uuid not null references policy_campaign(id),
  actor_id        uuid not null references actor(id),
  acknowledged_at timestamptz not null default now(),
  statement       text not null,
  primary key (campaign_id, actor_id)
);

create table if not exists gov_control (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  ref            text not null,
  title          text not null,
  owner_id       uuid not null references actor(id),
  framework      text,
  evidence_type  text not null,
  frequency_days int not null check (frequency_days between 1 and 3660),
  next_test_due  date not null,
  status         text not null default 'not_tested' check (status in ('not_tested', 'effective', 'ineffective')),
  created_at     timestamptz not null default now(),
  unique (tenant_id, ref)
);
create table if not exists control_test (
  id           uuid primary key default gen_random_uuid(),
  control_id   uuid not null references gov_control(id),
  result       text not null check (result in ('pass', 'fail')),
  evidence_ref text not null,
  notes        text,
  tested_by    uuid references actor(id),
  tested_at    timestamptz not null default now()
);

create table if not exists gov_exception (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  kind         text not null check (kind in ('policy', 'control')),
  target_id    uuid not null,
  subject      text not null,
  reason       text not null,
  requested_by uuid references actor(id),
  decided_by   uuid references actor(id),
  decision_note text,
  status       text not null default 'requested' check (status in ('requested', 'approved', 'rejected')),
  expires_on   date,
  created_at   timestamptz not null default now()
);

create table if not exists engagement (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  title          text not null,
  scope          jsonb not null,
  period_from    date not null,
  period_to      date not null,
  lead_id        uuid not null references actor(id),
  status         text not null default 'planning' check (status in ('planning', 'fieldwork', 'reporting', 'closed')),
  sampling_notes text,
  created_by     uuid references actor(id),
  created_at     timestamptz not null default now()
);
create table if not exists engagement_auditor (
  engagement_id uuid not null references engagement(id),
  actor_id      uuid not null references actor(id),
  expires_at    timestamptz not null,
  can_export    boolean not null default false,
  granted_by    uuid references actor(id),
  granted_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  primary key (engagement_id, actor_id)
);
create table if not exists evidence_request (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagement(id),
  title         text not null,
  detail        text,
  owner_id      uuid not null references actor(id),
  due_on        date,
  status        text not null default 'open' check (status in ('open', 'submitted', 'accepted', 'rejected')),
  evidence      jsonb not null default '[]'::jsonb,
  decided_by    uuid references actor(id),
  decision_note text,
  created_by    uuid references actor(id),
  created_at    timestamptz not null default now()
);
create table if not exists finding (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  engagement_id uuid not null references engagement(id),
  number        int not null,
  title         text not null,
  detail        text not null,
  severity      text not null check (severity in ('low', 'medium', 'high', 'critical')),
  owner_id      uuid not null references actor(id),
  management_response text,
  target_date   date,
  status        text not null default 'open' check (status in ('open', 'remediating', 'awaiting_validation', 'closed')),
  reopened      int not null default 0,
  validated_by  uuid references actor(id),
  validated_at  timestamptz,
  escalated_at  timestamptz,
  created_by    uuid references actor(id),
  created_at    timestamptz not null default now(),
  unique (engagement_id, number)
);
create table if not exists finding_action (
  id          bigserial primary key,
  finding_id  uuid not null references finding(id),
  kind        text not null check (kind in ('response', 'evidence', 'validated', 'reopened', 'escalated', 'note')),
  body        text not null,
  evidence_ref text,
  actor_id    uuid references actor(id),
  occurred_at timestamptz not null default now()
);

-- GOV-10: every look and every export by an auditor, and every refusal.
create table if not exists auditor_access_log (
  id            bigserial primary key,
  tenant_id     uuid not null references tenant(id),
  engagement_id uuid references engagement(id),
  actor_id      uuid not null references actor(id),
  action        text not null check (action in ('view', 'export', 'denied')),
  target_kind   text not null,
  target_id     text,
  occurred_at   timestamptz not null default now()
);

create table if not exists evidence_pack (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  engagement_id uuid not null references engagement(id),
  manifest      jsonb not null,
  content       jsonb not null,
  sha256        text not null,
  created_by    uuid references actor(id),
  created_at    timestamptz not null default now()
);

create table if not exists legal_hold (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  title          text not null,
  reason         text not null,
  scope          jsonb not null,
  status         text not null default 'active' check (status in ('active', 'released', 'cleared')),
  created_by     uuid references actor(id),
  created_at     timestamptz not null default now(),
  released_by    uuid references actor(id),
  released_at    timestamptz,
  release_reason text,
  cleared_by     uuid references actor(id),
  cleared_at     timestamptz,
  clear_note     text
);

create table if not exists retention_schedule (
  tenant_id   uuid not null references tenant(id),
  process_key text not null,
  enabled     boolean not null default true,
  last_run_at timestamptz,
  set_by      uuid references actor(id),
  primary key (tenant_id, process_key)
);

-- Acceptance 4: a purge that a hold stopped, kept for review.
create table if not exists retention_block (
  id           bigserial primary key,
  tenant_id    uuid not null references tenant(id),
  process_key  text not null,
  hold_id      uuid not null references legal_hold(id),
  held_records int not null,
  record_ids   jsonb not null,
  run_by       text not null,
  occurred_at  timestamptz not null default now()
);

create or replace function gov_is_append_only() returns trigger as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$ language plpgsql;
drop trigger if exists auditor_access_log_no_change on auditor_access_log;
create trigger auditor_access_log_no_change before update or delete on auditor_access_log for each row execute function gov_is_append_only();
drop trigger if exists retention_block_no_change on retention_block;
create trigger retention_block_no_change before update or delete on retention_block for each row execute function gov_is_append_only();
drop trigger if exists finding_action_no_change on finding_action;
create trigger finding_action_no_change before update or delete on finding_action for each row execute function gov_is_append_only();
drop trigger if exists control_test_no_change on control_test;
create trigger control_test_no_change before update or delete on control_test for each row execute function gov_is_append_only();

-- Contract and policy documents in the workspace's S3 bucket, shown only
-- after the malware scan passes. A version's document_ref is gov-file:<id>.
create table if not exists gov_file (
  id                uuid primary key,
  tenant_id         uuid not null references tenant(id),
  purpose           text not null check (purpose in ('contract', 'policy', 'signed', 'signing')),
  contract_id       uuid references contract(id),
  policy_version_id uuid references policy_version(id),
  filename          text not null,
  content_type      text not null,
  byte_size         int not null,
  sha256            text not null,
  storage_key       text not null,
  scan_status       text not null default 'unscanned' check (scan_status in ('unscanned', 'clean', 'quarantined')),
  uploaded_by       uuid references actor(id),
  created_at        timestamptz not null default now()
);

-- DocuSign envelopes are sent and followed by Patform; manual ones are typed in.
alter table contract_envelope add column if not exists remote boolean not null default false;
alter table contract_envelope add column if not exists signers jsonb not null default '[]'::jsonb;
alter table contract_envelope add column if not exists last_checked_at timestamptz;
alter table contract_envelope add column if not exists remote_void_pending boolean not null default false;
alter table contract_envelope add column if not exists remote_error text;

-- PRD 17.3: workspace export and closure.
alter table tenant add column if not exists closed_at timestamptz;

create table if not exists tenant_export (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  requested_by uuid,
  reason       text not null default 'export',
  status       text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed', 'expired')),
  storage_key  text,
  manifest     jsonb,
  sha256       text,
  byte_size    bigint,
  error        text,
  created_at   timestamptz not null default now(),
  ready_at     timestamptz,
  expires_at   timestamptz
);

create table if not exists tenant_closure (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  requested_by        uuid,
  requested_by_email  text,
  reason              text not null,
  status              text not null default 'requested' check (status in ('requested', 'suspended', 'approved', 'deleting', 'closed', 'cancelled')),
  export_id           uuid references tenant_export(id),
  export_waived       boolean not null default false,
  suspended_at        timestamptz,
  suspended_actors    jsonb not null default '[]'::jsonb,
  waiting_until       timestamptz,
  approved_by         uuid,
  approved_at         timestamptz,
  progress            jsonb not null default '{}'::jsonb,
  certificate         jsonb,
  cancelled_by        uuid,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  closed_at           timestamptz
);
create unique index if not exists tenant_closure_open on tenant_closure (tenant_id) where status not in ('closed', 'cancelled');

-- Workspace closure (PRD 17.3) must be able to delete a closed workspace's
-- history. The append-only guards allow a DELETE only when the transaction
-- has set patform.workspace_purge, which only runtime/tenant-lifecycle.ts
-- does, inside its own transaction, after a site owner approved the closure.
-- Updates are never allowed, and nothing else changes for anyone else.
create or replace function event_is_append_only() returns trigger as $$
begin
  if tg_op = 'DELETE' and (coalesce(current_setting('patform.retention_run', true), '') = 'on'
                           or coalesce(current_setting('patform.workspace_purge', true), '') = 'on') then
    return old;
  end if;
  raise exception 'event history is append-only; % is not permitted', lower(tg_op);
end;
$$ language plpgsql;
create or replace function process_version_is_immutable() returns trigger as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('patform.workspace_purge', true), '') = 'on' then return old; end if;
  raise exception 'process_version % is published and cannot be % (publish a new version instead)', coalesce(old.id::text, '?'), lower(tg_op);
end;
$$ language plpgsql;
create or replace function workspace_admin_audit_is_append_only() returns trigger as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('patform.workspace_purge', true), '') = 'on' then return old; end if;
  raise exception 'workspace admin audit is append-only';
end;
$$ language plpgsql;
create or replace function advance_movement_is_append_only() returns trigger as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('patform.workspace_purge', true), '') = 'on' then return old; end if;
  raise exception 'advance movements are append-only';
end;
$$ language plpgsql;
create or replace function goods_receipt_is_append_only() returns trigger as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('patform.workspace_purge', true), '') = 'on' then return old; end if;
  raise exception 'goods receipts are append-only';
end;
$$ language plpgsql;
create or replace function calibration_is_append_only() returns trigger as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('patform.workspace_purge', true), '') = 'on' then return old; end if;
  raise exception 'calibration adjustments are append-only';
end;
$$ language plpgsql;
create or replace function asset_event_is_append_only() returns trigger as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('patform.workspace_purge', true), '') = 'on' then return old; end if;
  raise exception 'asset history is append-only';
end;
$$ language plpgsql;
create or replace function gov_is_append_only() returns trigger as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('patform.workspace_purge', true), '') = 'on' then return old; end if;
  raise exception '% is append-only', tg_table_name;
end;
$$ language plpgsql;

-- -------------------------------------------------------- Patform Sign
--
-- Built-in electronic signature. A document (a contract version or any PDF)
-- goes to signers in order or together; each proves control of their email
-- with a one-time code, agrees to sign electronically, fills their fields and
-- signs. The finished PDF carries the signatures and a certificate page, and
-- its SHA-256 is kept so anyone can check a copy. Every step is an
-- append-only event. This is a simple electronic signature: what most
-- commercial contracts need, not a qualified one.

alter table gov_file drop constraint if exists gov_file_purpose_check;
alter table gov_file add constraint gov_file_purpose_check check (purpose in ('contract', 'policy', 'signed', 'signing'));

alter table platform_email drop constraint if exists platform_email_kind_check;
alter table platform_email add constraint platform_email_kind_check
  check (kind in ('invitation', 'verify_email', 'password_reset', 'delivery_alert', 'task_assigned', 'record_shared', 'scheduled_report',
                  'signature_request', 'signature_code', 'signature_completed', 'signature_declined', 'signature_reminder', 'signature_not_needed'));

create table if not exists sign_envelope (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id),
  number           int not null,
  title            text not null,
  message          text,
  contract_id      uuid references contract(id),
  contract_version int,
  document_file_id uuid not null references gov_file(id),
  original_sha256  text not null,
  page_count       int not null,
  routing          text not null default 'sequential' check (routing in ('sequential', 'parallel')),
  status           text not null default 'draft' check (status in ('draft', 'sent', 'completed', 'declined', 'voided', 'expired')),
  reminder_days    int not null default 3 check (reminder_days between 0 and 30),
  expires_at       timestamptz not null,
  created_by       uuid references actor(id),
  created_at       timestamptz not null default now(),
  sent_at          timestamptz,
  completed_at     timestamptz,
  voided_at        timestamptz,
  void_reason      text,
  final_file_id    uuid references gov_file(id),
  final_sha256     text,
  unique (tenant_id, number)
);
create index if not exists sign_envelope_final on sign_envelope (final_sha256) where final_sha256 is not null;

create table if not exists sign_recipient (
  id               uuid primary key default gen_random_uuid(),
  envelope_id      uuid not null references sign_envelope(id),
  name             text not null,
  email            text not null,
  role             text not null default 'signer' check (role in ('signer', 'cc')),
  routing_order    int not null default 1,
  actor_id         uuid references actor(id),
  status           text not null default 'waiting' check (status in ('waiting', 'sent', 'viewed', 'signed', 'declined')),
  token_hash       text unique,
  otp_hash         text,
  otp_expires_at   timestamptz,
  otp_attempts     int not null default 0,
  otp_sent_count   int not null default 0,
  otp_window_start timestamptz,
  session_hash     text,
  session_expires_at timestamptz,
  verified_at      timestamptz,
  consented_at     timestamptz,
  consent_text     text,
  viewed_at        timestamptz,
  signed_at        timestamptz,
  declined_at      timestamptz,
  decline_reason   text,
  signature        jsonb,
  initials         jsonb,
  ip               text,
  user_agent       text,
  notified_at      timestamptz,
  last_reminded_at timestamptz,
  created_at       timestamptz not null default now()
);

create table if not exists sign_field (
  id           uuid primary key default gen_random_uuid(),
  envelope_id  uuid not null references sign_envelope(id),
  recipient_id uuid not null references sign_recipient(id),
  kind         text not null check (kind in ('signature', 'initials', 'date', 'name', 'text')),
  page         int not null check (page >= 1),
  x            numeric(6, 5) not null check (x >= 0 and x <= 1),
  y            numeric(6, 5) not null check (y >= 0 and y <= 1),
  width        numeric(6, 5) not null check (width > 0 and width <= 1),
  height       numeric(6, 5) not null check (height > 0 and height <= 1),
  required     boolean not null default true,
  label        text,
  value        text,
  filled_at    timestamptz
);

create table if not exists sign_event (
  id           bigserial primary key,
  envelope_id  uuid not null references sign_envelope(id),
  recipient_id uuid references sign_recipient(id),
  kind         text not null,
  detail       jsonb not null default '{}'::jsonb,
  ip           text,
  user_agent   text,
  occurred_at  timestamptz not null default now()
);
drop trigger if exists sign_event_no_change on sign_event;
create trigger sign_event_no_change before update or delete on sign_event for each row execute function gov_is_append_only();

-- Reminders resend the same personal link, so it is kept sealed as well as hashed.
alter table sign_recipient add column if not exists token_sealed text;

-- Patform Sign: codes by SMS, and companies signing through several
-- authorised people ("any 2 of these 3 directors").
create table if not exists sign_party (
  id             uuid primary key default gen_random_uuid(),
  envelope_id    uuid not null references sign_envelope(id),
  name           text not null,
  required_count int not null check (required_count between 1 and 20),
  routing_order  int not null default 1,
  authority_note text,
  completed_at   timestamptz,
  created_at     timestamptz not null default now()
);

alter table sign_recipient add column if not exists party_id uuid references sign_party(id);
alter table sign_recipient add column if not exists title text;
alter table sign_recipient add column if not exists phone text;
alter table sign_recipient add column if not exists verify_by text not null default 'email';
alter table sign_recipient drop constraint if exists sign_recipient_verify_by_check;
alter table sign_recipient add constraint sign_recipient_verify_by_check check (verify_by in ('email', 'sms', 'email_and_sms'));
alter table sign_recipient add column if not exists sms_otp_hash text;
alter table sign_recipient add column if not exists authority_confirmed_at timestamptz;
alter table sign_recipient add column if not exists authority_statement text;
alter table sign_recipient add column if not exists party_slot int;
alter table sign_recipient drop constraint if exists sign_recipient_status_check;
alter table sign_recipient add constraint sign_recipient_status_check check (status in ('waiting', 'sent', 'viewed', 'signed', 'declined', 'not_needed'));

alter table sign_field add column if not exists party_id uuid references sign_party(id);
alter table sign_field add column if not exists slot int;
alter table sign_field add column if not exists filled_by uuid references sign_recipient(id);
alter table sign_field alter column recipient_id drop not null;
alter table sign_field drop constraint if exists sign_field_owner_check;
alter table sign_field add constraint sign_field_owner_check check (recipient_id is not null or (party_id is not null and slot is not null));
alter table sign_field drop constraint if exists sign_field_kind_check;
alter table sign_field add constraint sign_field_kind_check check (kind in ('signature', 'initials', 'date', 'name', 'text', 'title'));

-- The certificate seal applied to the finished file, when one is configured.
alter table sign_envelope add column if not exists seal jsonb;

alter table platform_email drop constraint if exists platform_email_kind_check;
alter table platform_email add constraint platform_email_kind_check
  check (kind in ('invitation', 'verify_email', 'password_reset', 'delivery_alert', 'task_assigned', 'record_shared', 'scheduled_report',
                  'signature_request', 'signature_code', 'signature_completed', 'signature_declined', 'signature_reminder', 'signature_not_needed'));
