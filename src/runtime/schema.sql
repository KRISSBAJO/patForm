-- Runtime schema for the Patform workflow engine.
--
-- Targets PostgreSQL 17, which is what Renviq provisions. Everything here uses
-- the standard protocol and standard SQL: no extensions beyond pgcrypto, no
-- LISTEN/NOTIFY, and no session-scoped advisory locks, so it behaves the same
-- through a transaction-mode PgBouncer as it does on a direct connection.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tenancy

create table tenant (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------- identity

-- Section 6.1: a person, scoped to one tenant. Deactivating them is a status
-- change rather than a delete, because their decisions stay in the history.
create table actor (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  email       text not null,
  display_name text not null,
  -- Section 6.1 IAM-02. This sits ABOVE the per-process roles: it says what
  -- someone may do across the workspace, including in processes they hold no
  -- role in. It never confers the power to approve; see runtime/policy.ts.
  workspace_role text not null default 'read_only'
    check (workspace_role in ('owner','admin','builder','operator','approver','analyst','read_only')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (tenant_id, email)
);

-- §12.1 authentication. The hash is scrypt with a per-credential salt; the
-- plaintext never reaches this table and never reaches a log.
create table credential (
  actor_id     uuid primary key references actor(id),
  password_hash text not null,
  updated_at   timestamptz not null default now()
);

-- A session is a random token the browser holds; this table stores only its
-- SHA-256, so a dump of this table cannot be replayed as a login.
create table session (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  actor_id    uuid not null references actor(id),
  tenant_id   uuid not null references tenant(id),
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

create index session_live on session (actor_id) where revoked_at is null;

-- Which blueprint role a person holds, in which process. Roles are defined
-- per process, so a membership is per process too: being an approver for
-- expenses grants nothing in onboarding.
create table membership (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  actor_id    uuid not null references actor(id),
  process_key text not null,
  role_key    text not null,
  granted_at  timestamptz not null default now(),
  granted_by  text,
  unique (tenant_id, actor_id, process_key, role_key)
);

create index membership_lookup on membership (tenant_id, actor_id, process_key);

-- Section 12.1: an append-only record of every authorization decision that
-- was refused. A denial nobody can see is indistinguishable from an attack
-- nobody noticed.
create table access_denial (
  id          bigserial primary key,
  tenant_id   uuid,
  actor_id    uuid,
  actor_label text not null,
  action      text not null,
  resource    text not null,
  instance_id uuid,
  reason      text not null,
  occurred_at timestamptz not null
);

create index access_denial_recent on access_denial (occurred_at desc);

-- ------------------------------------------------------- published versions

create table process_version (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  process_key  text not null,
  version      int  not null,
  blueprint    jsonb not null,
  published_at timestamptz not null default now(),
  published_by text not null,
  unique (tenant_id, process_key, version)
);

-- Section 9.2: "A published process version is immutable." Enforced here
-- rather than by convention, because every instance pins one of these rows and
-- a silent edit would rewrite the rules a finished record was decided under.
create or replace function process_version_is_immutable() returns trigger as $$
begin
  raise exception 'process_version % is published and cannot be % (publish a new version instead)',
    coalesce(old.id::text, '?'), lower(tg_op);
end;
$$ language plpgsql;

create trigger process_version_no_update before update or delete on process_version
  for each row execute function process_version_is_immutable();

-- ------------------------------------------------------------- case records

create table instance (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenant(id),
  process_key        text not null,
  process_version_id uuid not null references process_version(id),
  state              text not null,
  data               jsonb not null default '{}'::jsonb,
  assignee           text,
  identity_key       text,
  outcome            text,
  created_at         timestamptz not null default now(),
  state_entered_at   timestamptz not null default now(),
  completed_at       timestamptz
);

-- Duplicate detection spans versions of the same process: someone resubmitting
-- after a new version is published is still the same person, not a new case.
create unique index instance_identity_uq
  on instance (tenant_id, process_key, identity_key)
  where identity_key is not null;

create index instance_open on instance (tenant_id, process_key, state) where completed_at is null;

-- §6.3: "Autosave and secure resume link for authenticated or tokenized
-- respondents." The token is what scopes a respondent to ONE record — without
-- it, "a respondent may view" means they may view anybody's.
create table resume_token (
  token_hash  text primary key,
  tenant_id   uuid not null references tenant(id),
  instance_id uuid not null references instance(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

-- ------------------------------------------------------------------ drafts

-- BLD-06: "Published versions are immutable; edits create a new draft."
--
-- A draft is where a process is edited. It is not a version and nothing runs
-- against it — the compiler decides whether it may ever become one.
create table process_draft (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  process_key     text not null,
  /** The published version this was opened from, so the impact of publishing is knowable. */
  based_on_version int,
  blueprint       jsonb not null,
  created_by      text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  published_as    int,
  unique (tenant_id, process_key, id)
);

create index draft_open on process_draft (tenant_id, process_key) where published_as is null;

-- ------------------------------------------------------------------ intake

-- §6.3: "Autosave and secure resume link." A draft is a form somebody has
-- started and not finished. It is deliberately NOT an instance: a process
-- that counts half-filled forms as cases reports nonsense, and a respondent
-- who abandons one should leave no record to chase.
create table draft (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenant(id),
  process_version_id   uuid not null references process_version(id),
  token_hash           text not null unique,
  answers              jsonb not null default '{}'::jsonb,
  page                 int not null default 0,
  submitted_instance_id uuid references instance(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  expires_at           timestamptz not null
);

create index draft_live on draft (expires_at) where submitted_instance_id is null;

-- Uploaded files. The bytes live outside the database; this row is the record
-- of them, and the checksum is what makes "the same file" answerable.
--
-- NOT built: object storage, malware scanning, quarantine, presigned access
-- (§12.1 uploads). Local disk is a development stand-in and is named as one in
-- runtime/files.ts rather than left to be discovered.
create table file (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  draft_id     uuid references draft(id) on delete cascade,
  instance_id  uuid references instance(id),
  field_key    text not null,
  filename     text not null,
  content_type text not null,
  byte_size    bigint not null,
  checksum     text not null,
  storage_key  text not null,
  scan_status  text not null default 'unscanned'
    check (scan_status in ('unscanned', 'clean', 'quarantined')),
  uploaded_at  timestamptz not null default now()
);

create index file_for_draft on file (draft_id);
create index file_for_instance on file (instance_id);

-- ------------------------------------------------------------ event history

create table event (
  id          bigserial primary key,
  tenant_id   uuid not null,
  instance_id uuid not null references instance(id),
  seq         int  not null,
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  actor       text,
  -- §20.2 observability: the request that caused this. Stamped from async
  -- context, so it is present whether the change came from the API, a worker,
  -- or a CLI, and 'unattributed' when nothing claimed it.
  request_id  text not null default 'unattributed',
  occurred_at timestamptz not null,
  unique (instance_id, seq)
);

-- Section 6.4: "Corrections append history; destructive overwriting of audit
-- evidence is prohibited."
create or replace function event_is_append_only() returns trigger as $$
begin
  -- §9.2 and §12.1 require configurable retention, which means SOMETHING has
  -- to be able to delete history eventually. That door is this setting, which
  -- only runtime/retention.ts opens, only inside its own transaction, and only
  -- after writing a retention_run row saying what it is about to do.
  if coalesce(current_setting('patform.retention_run', true), '') = 'on'
     and tg_op = 'DELETE' then
    return old;
  end if;
  raise exception 'event history is append-only; % is not permitted', lower(tg_op);
end;
$$ language plpgsql;

-- §12.1 "Data lifecycle": every deletion pass says what it removed and why,
-- and the record of the deletion outlives the data.
create table retention_run (
  id              bigserial primary key,
  tenant_id       uuid not null references tenant(id),
  process_key     text not null,
  retention_days  int not null,
  instances_deleted int not null,
  events_deleted  int not null,
  oldest_removed  timestamptz,
  newest_removed  timestamptz,
  run_by          text not null,
  ran_at          timestamptz not null default now()
);

create trigger event_no_update before update or delete on event
  for each row execute function event_is_append_only();

-- ------------------------------------------------------------------- outbox

-- Section 10.2 step 2: the domain change and this row are written in one
-- transaction, so an action can never be scheduled for a state change that
-- rolled back, and a committed state change can never lose its actions.
create table outbox (
  id             bigserial primary key,
  tenant_id      uuid not null,
  instance_id    uuid not null,
  event_id       bigint not null references event(id),
  transition_key text not null,
  created_at     timestamptz not null,
  available_at   timestamptz not null,
  claimed_by     text,
  claimed_at     timestamptz,
  attempts       int not null default 0,
  done_at        timestamptz,
  last_error     text,
  -- Carried forward rather than re-derived. The worker runs later in another
  -- process, so this is the only surviving link back to the request that
  -- caused the work — which is the whole point of having one.
  request_id     text not null default 'unattributed'
);

create index outbox_ready on outbox (available_at, id) where done_at is null;

-- Support looks a request up by id, so it needs to be cheap. Each index sits
-- with its table: putting all three here referenced action_run before it
-- existed, which is the same ordering trap the foreign keys had.
create index event_by_request on event (request_id);
create index outbox_by_request on outbox (request_id);

-- -------------------------------------------------------- idempotency ledger

-- Section 6.5: "Action execution has a stable key to prevent duplicate emails,
-- documents, webhooks, or charges."
create table action_run (
  id               bigserial primary key,
  tenant_id        uuid not null,
  instance_id      uuid not null references instance(id),
  idempotency_key  text not null,
  action_do        text not null,
  status           text not null default 'running',
  attempts         int  not null default 1,
  result           jsonb,
  last_error       text,
  created_at       timestamptz not null,
  completed_at     timestamptz,
  -- The request that originated the work, and the worker run that performed
  -- it. A retry keeps the first and changes the second, which is what makes
  -- "why did this happen twice" answerable.
  request_id       text not null default 'unattributed',
  performed_by     text,
  unique (instance_id, idempotency_key)
);

create index action_run_by_request on action_run (request_id);

-- --------------------------------------------------------------- side effects
--
-- Every effect table carries a unique action_run_id. That single constraint is
-- what makes the whole system safe to retry: two workers racing the same action
-- produce one row and one loser, not two emails.

create table email_log (
  id            bigserial primary key,
  tenant_id     uuid not null,
  instance_id   uuid not null,
  action_run_id bigint not null references action_run(id) unique,
  template_key  text not null,
  recipients    text[] not null,
  subject       text not null,
  body          text not null,
  -- §6.6: the log distinguishes queued, sent, delivered where supported,
  -- bounced, complained and failed. Anything past `sent` arrives by webhook
  -- from the provider and is not wired yet.
  status        text not null default 'queued'
    check (status in ('queued','sent','delivered','bounced','complained','failed','skipped')),
  provider      text,
  provider_message_id text,
  failure       text,
  sent_at       timestamptz not null
);

create table task (
  id            bigserial primary key,
  tenant_id     uuid not null,
  instance_id   uuid not null,
  action_run_id bigint not null references action_run(id) unique,
  task_key      text not null,
  assignee      text,
  blocking      boolean not null default true,
  status        text not null default 'open',
  due_at        timestamptz,
  created_at    timestamptz not null,
  completed_at  timestamptz,
  completed_by  text
);

create index task_open on task (instance_id, task_key) where status = 'open';

create table approval_request (
  id            bigserial primary key,
  tenant_id     uuid not null,
  instance_id   uuid not null,
  action_run_id bigint not null references action_run(id) unique,
  approval_key  text not null,
  approvers     text[] not null,
  mode          text not null,
  status        text not null default 'pending',
  decision      text,
  decided_by    text,
  decided_at    timestamptz,
  reason        text,
  created_at    timestamptz not null,
  due_at        timestamptz
);

create index approval_pending on approval_request (instance_id, approval_key) where status = 'pending';

-- Section 6.6: generated output is stored with template version, record
-- version, checksum, actor, and timestamp.
create table document (
  id                 bigserial primary key,
  tenant_id          uuid not null,
  instance_id        uuid not null,
  action_run_id      bigint not null references action_run(id) unique,
  document_key       text not null,
  template_ref       text not null,
  process_version_id uuid not null references process_version(id),
  checksum           text not null,
  filename           text not null,
  -- The bytes themselves. Small, controlled documents; object storage is the
  -- eventual home (§10.1) and is named as not-built in the README.
  content            bytea,
  byte_size          int,
  created_by         text not null,
  created_at         timestamptz not null
);

create table webhook_delivery (
  id            bigserial primary key,
  tenant_id     uuid not null,
  instance_id   uuid not null,
  action_run_id bigint not null references action_run(id) unique,
  event_name    text not null,
  payload       jsonb not null,
  status        text not null default 'delivered',
  delivered_at  timestamptz not null
);

-- ------------------------------------------------------------------- timers

-- Section 6.5: relative deadlines and reminders using the tenant timezone,
-- stored canonically in UTC.
create table timer (
  id             bigserial primary key,
  tenant_id      uuid not null,
  instance_id    uuid not null,
  transition_key text not null,
  state_key      text not null,
  entered_at     timestamptz not null,
  due_at         timestamptz not null,
  fired_at       timestamptz,
  cancelled_at   timestamptz,
  unique (instance_id, transition_key, entered_at)
);

create index timer_due on timer (due_at, id) where fired_at is null and cancelled_at is null;

-- --------------------------------------------------------------- copilot
--
-- §7.3 wants the AI audit to record "model, prompt template version, tool
-- plan, human approval, execution result, and errors". One row per question
-- carries all six, which is also what makes §7.4's action-precision gate
-- measurable: the confirmed plan and what ran are on the same row.
--
-- `plan_digest` is what binds them. The preview hashes the plan together with
-- the exact instance ids it resolved; execution refuses unless the caller
-- hands that digest back. So "100 percent of executed actions match the
-- confirmed plan" is enforced rather than asserted, and a record that becomes
-- eligible between preview and confirmation is not swept up.
create table copilot_run (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  actor_id        uuid references actor(id),
  process_key     text not null,
  question        text not null,
  -- the model's own account of what it understood, shown back before anything runs
  reading         text,
  plan            jsonb not null,
  action_plan     jsonb,
  diagnostics     jsonb not null default '[]'::jsonb,
  -- resolved at preview: every instance the plan matched, with its per-record
  -- authorization decision. Execution reads this, never the query again.
  targets         jsonb not null default '[]'::jsonb,
  plan_digest     text,
  status          text not null default 'previewed'
    check (status in ('answered','previewed','confirmed','executed','refused','failed')),
  -- §7.3: model, prompt version, tokens, latency, and any error
  provider        text,
  model           text,
  prompt_version  text,
  input_tokens    int,
  output_tokens   int,
  latency_ms      int,
  error           text,
  -- §6.4: "bulk actions require ... a result report"
  result          jsonb,
  confirmed_by    text,
  confirmed_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index copilot_run_recent on copilot_run (tenant_id, created_at desc);
