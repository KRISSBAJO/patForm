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
  is_scenario boolean not null default false,
  created_at  timestamptz not null default now(),
  intake_paused_at timestamptz,
  intake_pause_reason text
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
  /*
   * IAM-05, "Enterprise SSO and SCIM are deferred but the identity model must
   * accommodate them" — marked *Design now*, which is the whole point: these
   * two columns cost nothing today and are a migration of every account if
   * they arrive later.
   *
   * `external_id` is SCIM's `externalId`: the identifier the customer's
   * directory uses, which survives the person changing their name or email.
   * `provisioned_by` says who owns this row — an account SCIM created must not
   * be editable in the console, or the directory will overwrite the change on
   * its next sync and nobody will know why.
   */
  external_id    text,
  /*
   * §12.1's "verified email".
   *
   * Null means nobody has proved they control this address. Accepting an
   * invitation sets it, because using a link that was emailed to you *is* the
   * proof — there is no second step worth asking for. Signing up does not,
   * because nothing about typing an address demonstrates anything.
   */
  email_verified_at timestamptz,
  provisioned_by text not null default 'seed'
    check (provisioned_by in ('seed', 'signup', 'invite', 'scim')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, email)
);

-- One directory identifier per person is not enough. Somebody signs in with a
-- password today, their company turns on Google tomorrow, and both have to
-- reach the same account — so identities hang off the actor rather than
-- living on it. Passwords stay in `credential`, which already had this shape.
--
-- The subject, never the email. An IdP's `sub` is stable; an email address is
-- a display value that changes when somebody marries or a domain is bought.
-- Matching on email is how one person ends up with two accounts, or worse,
-- how two people end up with one.
create table actor_identity (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid not null references actor(id) on delete cascade,
  provider      text not null,
  subject       text not null,
  -- What the address was when this was linked, for the audit rather than for
  -- matching.
  email_at_link text,
  linked_at     timestamptz not null default now(),
  last_seen_at  timestamptz,
  unique (provider, subject)
);

create index actor_identity_by_actor on actor_identity (actor_id);
create unique index actor_external_id on actor (tenant_id, external_id) where external_id is not null;

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
  revoked_at  timestamptz,
  /*
   * When the person last proved it was them — at sign-in, or by confirming
   * again. Actions that grant access or destroy data ask for this to be
   * recent; see runtime/step-up.ts. `reauth_failures` counts wrong answers to
   * that question, and five end the session.
   */
  authenticated_at timestamptz not null default now(),
  reauth_failures  int not null default 0
);

create index session_live on session (actor_id) where revoked_at is null;

-- Platform access is independent of customer workspace ownership.
create table platform_operator (
  actor_id uuid primary key references actor(id),
  role text not null check (role in ('owner', 'operator', 'viewer')),
  granted_by uuid references actor(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table ai_draft_job (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  actor_id uuid not null references actor(id),
  process_key text not null,
  process_name text,
  description text not null,
  source_draft_id uuid,
  source_revision int,
  source_blueprint jsonb,
  proposal jsonb,
  review jsonb,
  applied_at timestamptz,
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
create index ai_draft_job_queue on ai_draft_job (created_at) where status in ('queued', 'running');
create unique index ai_draft_job_active_key on ai_draft_job (tenant_id, process_key) where status in ('queued', 'running');

create table platform_worker_heartbeat (
  worker_id text primary key,
  seen_at timestamptz not null,
  actions bigint not null default 0,
  timers bigint not null default 0,
  webhooks bigint not null default 0,
  errors bigint not null default 0
);

create table platform_deployment (
  id bigserial primary key,
  revision text,
  environment text not null,
  started_at timestamptz not null default now()
);
create index platform_deployment_recent on platform_deployment (started_at desc);

create table platform_admin_audit (
  id bigserial primary key,
  actor_id uuid references actor(id),
  action text not null,
  tenant_id uuid references tenant(id),
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index platform_admin_audit_recent on platform_admin_audit (occurred_at desc, id desc);

create or replace function platform_admin_audit_is_append_only() returns trigger as $$
begin
  raise exception 'platform admin audit is append-only';
end;
$$ language plpgsql;
create trigger platform_admin_audit_no_change before update or delete on platform_admin_audit
  for each row execute function platform_admin_audit_is_append_only();

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
  ai_review_required boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  published_as    int,
  /*
   * Draft locking. Two layers, because each one alone leaves a gap.
   *
   * `revision` is the guarantee: every save names the revision it was made
   * against and is refused if the draft moved on, so nothing is overwritten
   * without somebody being told. It cannot be bypassed and needs no clock.
   *
   * The lease is the warning: opening a draft claims it for two minutes,
   * renewed while the tab is open, so the second person learns someone is
   * editing *before* they start rather than when their first save bounces.
   * A lease that is not renewed simply expires — a closed laptop does not
   * lock a process for the rest of the week.
   */
  revision        int not null default 0,
  updated_by      uuid references actor(id),
  locked_by       uuid references actor(id),
  locked_at       timestamptz,
  locked_until    timestamptz,
  unique (tenant_id, process_key, id)
);

create index draft_open on process_draft (tenant_id, process_key) where published_as is null;

-- Every saved blueprint revision is retained for field-level history in the builder.
create table process_draft_history (
  draft_id uuid not null references process_draft(id) on delete cascade,
  revision int not null,
  blueprint jsonb not null,
  actor_id uuid references actor(id),
  saved_at timestamptz not null default now(),
  primary key (draft_id, revision)
);

create function record_process_draft_history() returns trigger language plpgsql as $$
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
create trigger process_draft_history_write after insert or update of blueprint on process_draft
  for each row execute function record_process_draft_history();

-- ----------------------------------------------------------- public links

-- One public link per (workspace, process), made at first publish and kept
-- across versions. Process keys are unique only within a workspace, so the
-- key alone never identified a form; see runtime/form-links.ts.
create table public_form (
  tenant_id    uuid not null references tenant(id),
  process_key  text not null,
  public_id    text not null unique,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, process_key)
);

create index public_form_key on public_form (process_key);

-- ------------------------------------------------------------ held intake

-- Spam control (runtime/screening.ts). A public submission that fails
-- screening is kept here whole and is NOT a record: it sends nothing, starts
-- nothing, counts in no metric, and cannot absorb a real person's later
-- submission as a duplicate of itself. Releasing it runs the ordinary submit
-- path with these answers, under this id, so the reference the person was
-- shown is the reference the record gets.
--
-- Resolved rows keep who decided and when, with the answers cleared on
-- discard. Everything here is deleted after thirty days by the worker's sweep.
create table held_submission (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenant(id),
  process_key        text not null,
  process_version_id uuid not null references process_version(id),
  answers            jsonb not null,
  reasons            text[] not null,
  elapsed_ms         int,
  draft_token_hash   text,
  received_at        timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by        uuid references actor(id),
  resolution         text check (resolution in ('released', 'discarded')),
  released_as        uuid
);

create index held_open on held_submission (tenant_id, process_key) where resolved_at is null;

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

-- S3 deletion may fail after a record's database transaction commits. Keep the
-- object key here until a worker has actually removed it.
create table file_deletion (
  storage_key text primary key,
  queued_at timestamptz not null default now()
);

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
  -- from the provider — see delivery_event below.
  status        text not null default 'queued'
    check (status in ('queued','sent','delivered','bounced','complained','failed','skipped')),
  provider      text,
  provider_message_id text,
  failure       text,
  sent_at       timestamptz not null,
  -- Recipients this message did not go to because they were suppressed.
  -- A column, not a phrase in `failure`: reinstating an address has to find
  -- every message it missed, and parsing prose back out of a log is how that
  -- lookup quietly misses the ones worded differently.
  suppressed    text[] not null default '{}'
);

create index email_log_suppressed on email_log using gin (suppressed);

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
  due_at        timestamptz,
  -- For a quorum, how many different people must approve; for a majority
  -- vote, more than half of `electorate`.
  required      int,
  -- For a majority vote: how many people may vote, counted when it is asked.
  electorate    int
);

create index approval_pending on approval_request (instance_id, approval_key) where status = 'pending';

-- Each person's decision on a request, one each.
--
-- A request used to be settled by its first decision, whatever the mode said,
-- so "sequential" behaved exactly like "any one of them" and a quorum had
-- nowhere to count. The request now stays pending until its mode is
-- satisfied, and this is the count. Unique per person, so nobody is two of
-- "any two directors".
create table approval_vote (
  id          bigserial primary key,
  -- Deleted with its request: retention and erasure delete requests, and a
  -- vote on nothing is not evidence of anything.
  request_id  bigint not null references approval_request(id) on delete cascade,
  tenant_id   uuid not null,
  actor       text not null,
  decision    text not null check (decision in ('approved', 'rejected', 'changes_requested')),
  reason      text,
  decided_at  timestamptz not null,
  unique (request_id, actor)
);

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

-- §11.2's subscribers. A customer registers a URL and the events they want.
--
-- Two secrets, not one. "Secrets rotate with overlap" means a rotation has a
-- period where both the old and the new are valid, so a consumer can redeploy
-- without dropping a delivery — every request during that window is signed
-- with both and the consumer accepts either.
create table webhook_endpoint (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  -- A Slack or Teams notification is a delivery with a different renderer,
  -- not a different mechanism. Folding them in here means one queue, one
  -- backoff, one dead letter and one replay — rather than a second set of
  -- all four that would need proving separately.
  kind           text not null default 'http' check (kind in ('http', 'slack', 'teams')),
  url            text not null,
  description    text not null default '',
  -- The event names this endpoint wants. Empty means every event.
  events         text[] not null default '{}',
  secret         text not null,
  -- Set during a rotation, cleared when it completes.
  previous_secret text,
  rotated_at     timestamptz,
  -- §11.2: "sensitive payload fields are opt-in and shown during webhook
  -- configuration". Named here rather than inferred, so adding a field to a
  -- process never silently widens what an existing endpoint receives.
  include_fields text[] not null default '{}',
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

create index webhook_endpoint_by_tenant on webhook_endpoint (tenant_id) where active;

-- One row per (event, endpoint). Claimed, attempted, retried and finally
-- dead-lettered by the same FOR UPDATE SKIP LOCKED pattern as the outbox,
-- because it is the same problem and one proven mechanism is worth more than
-- two.
--
-- This used to be a single row per event, written with status 'delivered' and
-- no HTTP request anywhere. A hundred of them said delivered and nothing had
-- ever left the machine.
create table webhook_delivery (
  id            bigserial primary key,
  tenant_id     uuid not null,
  instance_id   uuid not null,
  endpoint_id   uuid references webhook_endpoint(id) on delete cascade,
  action_run_id bigint references action_run(id),
  event_name    text not null,
  -- §11.2: process version, instance id, event id and occurred timestamp all
  -- travel with the payload so a consumer can order and deduplicate.
  event_id      bigint,
  payload       jsonb not null,
  status        text not null default 'pending'
    check (status in ('pending', 'delivered', 'failed', 'dead_letter', 'no_subscriber')),
  attempts      int not null default 0,
  available_at  timestamptz not null default now(),
  claimed_by    text,
  claimed_at    timestamptz,
  response_status int,
  last_error    text,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz
);

create index webhook_ready on webhook_delivery (available_at, id) where status = 'pending';
create index webhook_by_instance on webhook_delivery (instance_id);

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

-- --------------------------------------------------------------- erasure
--
-- §12.1's privacy request workflow, and the same principle as retention_run:
-- the account of what was removed is written before the removal, in the same
-- transaction, so it outlives the data. A deletion with no record of having
-- happened is indistinguishable from data loss.
--
-- It is deliberately not erasable by the procedure that writes it. A subject
-- can be told what was done without the telling itself holding their details:
-- the address is here because an auditor needs to match a request to an
-- action, and this table is subject to the same retention as any other record
-- of a decision.
create table erasure_run (
  id                 bigserial primary key,
  tenant_id          uuid not null references tenant(id),
  subject_email      text not null,
  reason             text not null,
  instances_deleted  int not null,
  events_deleted     int not null,
  instances_redacted int not null,
  fields_redacted    int not null,
  -- Appearances that could not be erased yet, and why.
  blocked            jsonb not null default '[]'::jsonb,
  run_by             text not null,
  ran_at             timestamptz not null
);

create index erasure_run_recent on erasure_run (tenant_id, ran_at desc);

-- --------------------------------------------------------------- api keys
--
-- §11.1's scoped server-to-server credentials. Only the hash is stored, on
-- the same reasoning as session tokens: a key that can be read back out of
-- the database is a key every administrator holds.
--
-- It references an actor rather than standing alone, so a key belonging to
-- somebody who has left stops working the moment they are deactivated — and
-- so that its scopes can be intersected with theirs on every request rather
-- than copied once at creation.
create table api_key (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  actor_id     uuid not null references actor(id),
  name         text not null,
  key_hash     text not null unique,
  -- Enough to recognise a key in a log and revoke the right one; not enough
  -- to use.
  key_prefix   text not null,
  scopes       text[] not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index api_key_by_tenant on api_key (tenant_id, created_at desc);

-- §11.1: "idempotency keys for mutations". A public API caller that retries a
-- submission after a timeout must not create a second record, and the
-- guarantee has to survive the process restarting — so the answer is stored
-- rather than held in memory.
create table api_idempotency (
  tenant_id    uuid not null references tenant(id),
  key          text not null,
  -- The request this answer belongs to. A key reused with a different body is
  -- a caller bug, and returning the first answer would hide it.
  request_hash text not null,
  status       int not null,
  response     jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, key)
);

-- ----------------------------------------------------------------- oauth
--
-- §11.1's installed integrations. Authorization code with PKCE; no implicit
-- grant and no password grant, both of which OAuth 2.1 removes.
create table oauth_client (
  client_id     text primary key,
  tenant_id     uuid not null references tenant(id),
  name          text not null,
  -- Matched exactly, never by prefix: "starts with" matching is how an open
  -- redirect on the client's own domain becomes a stolen token.
  redirect_uris text[] not null,
  secret_hash   text,
  confidential  boolean not null default false,
  created_at    timestamptz not null default now()
);

create table oauth_authorization (
  id             uuid primary key default gen_random_uuid(),
  code_hash      text not null unique,
  client_id      text not null references oauth_client(client_id),
  tenant_id      uuid not null references tenant(id),
  actor_id       uuid not null references actor(id),
  redirect_uri   text not null,
  scopes         text[] not null,
  code_challenge text not null,
  -- A code presented twice is treated as theft, not as a retry, so this is
  -- recorded rather than the row being deleted.
  used_at        timestamptz,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now()
);

-- The grant is what the customer consented to and what they revoke. Tokens
-- are what a client happens to hold right now. Keeping them apart is what
-- makes "revoke this integration" mean something.
create table oauth_grant (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null references oauth_client(client_id),
  tenant_id  uuid not null references tenant(id),
  actor_id   uuid not null references actor(id),
  scopes     text[] not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table oauth_token (
  id                 uuid primary key default gen_random_uuid(),
  grant_id           uuid not null references oauth_grant(id) on delete cascade,
  access_hash        text not null unique,
  refresh_hash       text not null unique,
  access_expires_at  timestamptz not null,
  refresh_expires_at timestamptz not null,
  -- Refresh tokens rotate and are single use. A used one presented again
  -- revokes the whole grant, because a race and a theft look identical from
  -- here and only one of them is safe to assume.
  used_at            timestamptz,
  created_at         timestamptz not null default now()
);

create index oauth_grant_by_tenant on oauth_grant (tenant_id, created_at desc);

-- ------------------------------------------------------------------ packs
--
-- §1.2's differentiator, stated as a contrast: "Templates copy a form.
-- Process packs include schema, workflow, messages, documents, dashboard,
-- and policy defaults." A pack is a working system, not a starting point.
--
-- `tenant_id` null means built-in: available to every workspace. Set means a
-- workspace published it for itself. The same table because the difference is
-- who may see it, not what it is — and because a pack a customer wrote and
-- later wants to share should not have to move.
create table pack (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenant(id),
  pack_key      text not null,
  version       int not null,
  name          text not null,
  summary       text not null,
  category      text not null,
  -- Who it is for, in their words. Shown on the card; this is the sentence
  -- somebody decides on.
  audience      text not null default '',
  blueprint     jsonb not null,
  -- Computed at publish from the blueprint, so a card cannot claim something
  -- the pack does not contain.
  contents      jsonb not null,
  published_by  text not null,
  published_at  timestamptz not null default now(),
  -- Withdrawn rather than deleted: a workspace that installed it deserves to
  -- keep seeing where their process came from.
  withdrawn_at  timestamptz,
  unique (tenant_id, pack_key, version)
);

create index pack_listing on pack (category, pack_key) where withdrawn_at is null;

-- What a workspace installed, and from where. §9.2's provenance, one level up:
-- a process that came from a pack should be able to say so, and to say which
-- version, when the pack is later fixed.
create table pack_install (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  pack_id      uuid not null references pack(id),
  process_key  text not null,
  draft_id     uuid,
  installed_by text not null,
  installed_at timestamptz not null default now()
);

create index pack_install_by_tenant on pack_install (tenant_id, installed_at desc);

-- ------------------------------------------------------------- invitations
--
-- IAM-01's "or join a tenant workspace" and IAM-04's "owners can invite".
--
-- Only the hash is stored, like every other credential here: the link is the
-- credential, and a dump of this table must not let somebody walk into a
-- workspace.
create table invitation (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  email         text not null,
  workspace_role text not null
    check (workspace_role in ('owner','admin','builder','operator','approver','analyst','read_only')),
  -- Process roles to grant on acceptance, so somebody arrives able to do the
  -- job they were invited for rather than able to see nothing.
  process_roles jsonb not null default '[]'::jsonb,
  token_hash    text not null unique,
  invited_by    uuid not null references actor(id),
  message       text not null default '',
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  accepted_actor_id uuid references actor(id),
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index invitation_open on invitation (tenant_id, email)
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------- account tokens
--
-- Verification and password reset. The same shape as `invitation` and for the
-- same reason: only the hash is stored, because the link is the credential.
--
-- One table rather than two. They differ in purpose, lifetime and what
-- happens on use, and in nothing else — and a second table would mean a
-- second place to get "single use" right.
create table auth_token (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid not null references actor(id) on delete cascade,
  purpose    text not null check (purpose in ('verify_email', 'password_reset')),
  token_hash text not null unique,
  -- The address it was sent to, which is not always the actor's current one:
  -- a verification for a *changed* address must not verify the old one.
  sent_to    text not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index auth_token_open on auth_token (actor_id, purpose) where used_at is null;

-- Platform mail: invitations, verification, password resets.
--
-- Its own table because `email_log` requires an instance and an action run,
-- and none of these belong to a record. Forcing them in would have meant
-- making both nullable, which would quietly weaken the guarantee that every
-- process email is traceable to the action that sent it.
create table platform_email (
  id           bigserial primary key,
  tenant_id    uuid references tenant(id),
  actor_id     uuid references actor(id),
  kind         text not null check (kind in ('invitation', 'verify_email', 'password_reset', 'delivery_alert', 'task_assigned')),
  recipient    text not null,
  subject      text not null,
  status       text not null default 'queued'
    check (status in ('queued', 'sent', 'failed', 'skipped')),
  provider     text,
  provider_message_id text,
  failure      text,
  sent_at      timestamptz not null default now()
);

create index platform_email_recent on platform_email (recipient, sent_at desc);

-- -------------------------------------------------------- delivery outcomes
--
-- §6.6's delivery log only reached `sent` on its own: everything after that is
-- something the provider learns minutes or hours later and tells us about.
--
-- This table is the idempotency ledger for those notifications. The provider
-- retries until it gets a 2xx, so the same event arrives more than once as a
-- matter of course, and `unique(event_id)` is what makes a redelivery a no-op
-- rather than a second bounce.
--
-- It also keeps the events we cannot act on. An `email.opened` changes no
-- status and suppresses nobody, and recording it anyway means the timeline
-- for a message is the whole story rather than the parts that happened to
-- change a column.
create table delivery_event (
  id           bigserial primary key,
  -- The provider's event id, from the `webhook-id` header. Not ours.
  event_id     text not null unique,
  provider     text not null,
  type         text not null,
  provider_message_id text,
  recipient    text,
  payload      jsonb not null,
  -- Which log row it matched, if any. Null means the message was not ours:
  -- a shared provider account also carries mail this deployment did not send.
  -- Deleted with the message it is about. It holds the recipient's address,
  -- so when retention or an erasure removes the message, this has to go too;
  -- and without the cascade it blocked that delete for any message a provider
  -- had reported on — which in production is nearly every one.
  email_log_id bigint references email_log(id) on delete cascade,
  platform_email_id bigint references platform_email(id),
  occurred_at  timestamptz not null,
  received_at  timestamptz not null default now()
);

create index delivery_event_message on delivery_event (provider_message_id);

-- Addresses this deployment must stop mailing.
--
-- Deployment-wide rather than per tenant, and deliberately: a hard bounce
-- means the mailbox does not exist, which is not a fact about who was writing
-- to it. The console only shows a tenant the addresses it has actually
-- mailed, so the list is not a way to read another tenant's contacts.
create table suppressed_recipient (
  email      text primary key,
  reason     text not null check (reason in ('hard_bounce', 'complaint', 'manual')),
  detail     text,
  -- The event that caused it, so an operator lifting a suppression can see
  -- what they are overruling.
  event_id   text,
  created_at timestamptz not null default now(),
  -- Set when somebody decides the address works after all. Kept rather than
  -- deleted: "this bounced in March and was reinstated in April" is the
  -- history an operator needs the second time it bounces.
  lifted_at  timestamptz,
  lifted_by  uuid references actor(id)
);

create index suppressed_recipient_live on suppressed_recipient (email) where lifted_at is null;

-- A message sent again to an address after its suppression was lifted.
--
-- One row per (message, address), unique, so pressing "send" twice — or two
-- people pressing it at once — sends once. The resend is its own effect with
-- its own action_run and email_log row; the original skipped message is left
-- exactly as it was, because it is the record of what happened at the time.
create table email_resend (
  id            bigserial primary key,
  tenant_id     uuid not null references tenant(id),
  email_log_id  bigint not null references email_log(id) on delete cascade,
  recipient     text not null,
  resent_log_id bigint references email_log(id) on delete cascade,
  resent_by     uuid not null references actor(id),
  resent_at     timestamptz not null default now(),
  unique (email_log_id, recipient)
);

-- The sending account's health, as the provider will judge it.
--
-- One open alert at most (the partial unique index), so two workers noticing
-- the same rate raise it once. A rise from `watch` to `act` closes the first
-- and opens the second; recovering closes it. Each row is one notification.
create table delivery_alert (
  id             bigserial primary key,
  level          text not null check (level in ('watch', 'act')),
  sent           int not null,
  bounced        int not null,
  complained     int not null,
  raised_at      timestamptz not null default now(),
  cleared_at     timestamptz
);

create unique index delivery_alert_open on delivery_alert ((true)) where cleared_at is null;

-- --------------------------------------------------- two-step verification
--
-- §12.1's MFA option. TOTP (RFC 6238), because it is the second factor
-- somebody can set up in thirty seconds with an app they already have and it
-- needs no vendor.
create table mfa_enrolment (
  actor_id     uuid primary key references actor(id) on delete cascade,
  secret       text not null,
  -- Null until a code proves the authenticator actually has the secret. An
  -- enrolment that switches on when the secret is generated locks out
  -- everybody whose scan silently failed.
  confirmed_at timestamptz,
  /*
   * The counter the last accepted code belonged to.
   *
   * Without it the same six digits work for every request inside their thirty
   * seconds, so a code read over a shoulder — or out of a proxy log — is good
   * for another window. A code from this step or earlier is refused.
   */
  last_used_step bigint,
  created_at   timestamptz not null default now()
);

-- What gets somebody back in when the phone is gone. Single use, and stored
-- as hashes: they are the credential at that moment, so a dump of this table
-- must not be a set of working ones.
create table mfa_recovery_code (
  id         bigserial primary key,
  actor_id   uuid not null references actor(id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index mfa_recovery_open on mfa_recovery_code (actor_id) where used_at is null;

-- The half-signed-in state between a correct password and a correct code.
--
-- Its own short-lived token rather than a session carrying a flag. A session
-- that exists but "does not count yet" is one missing check away from being a
-- session that counts, and that check would have to be repeated on every
-- route rather than written once here.
create table mfa_challenge (
  id         uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  actor_id   uuid not null references actor(id) on delete cascade,
  -- Six digits is a million possibilities. This is what stops unlimited
  -- guesses turning a factor into a delay.
  attempts   int not null default 0,
  user_agent text,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
