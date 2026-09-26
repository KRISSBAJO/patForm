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
