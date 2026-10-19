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
  check (kind in ('invitation', 'verify_email', 'password_reset', 'delivery_alert', 'task_assigned', 'record_shared', 'scheduled_report'));

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
