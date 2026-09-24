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
  completed_at timestamptz
);
alter table ai_draft_job add column if not exists stage text not null default 'waiting';
create index if not exists ai_draft_job_queue on ai_draft_job (created_at) where status in ('queued', 'running');
create unique index if not exists ai_draft_job_active_key on ai_draft_job (tenant_id, process_key) where status in ('queued', 'running');

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
