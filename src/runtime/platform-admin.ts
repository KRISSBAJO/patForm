import { inTransaction, type Pool } from './db.js';
import { AuthorizationError } from './policy.js';
import { isEnabled as mfaEnabled } from './mfa.js';

export type PlatformRole = 'owner' | 'operator' | 'viewer';

/** Explicit bootstrap allowlist. Every address must identify exactly one verified account. */
export async function bootstrapPlatformOwner(pool: Pool): Promise<void> {
  const emails = (process.env.PLATFORM_BOOTSTRAP_EMAILS ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  for (const email of new Set(emails)) {
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('PLATFORM_BOOTSTRAP_EMAILS contains an invalid email');
    await inTransaction(pool, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `select a.id from actor a join credential c on c.actor_id = a.id
       where lower(a.email) = $1 and a.active and a.email_verified_at is not null`, [email],
    );
    if (rows.length === 0) {
      console.warn(`Platform bootstrap skipped ${email}: active verified account not found`);
      return;
    }
    if (rows.length !== 1) throw new Error(`Platform bootstrap found multiple accounts for ${email}; use an exact actor grant`);
    const id = rows[0]!.id;
    const grant = await db.query(
      `insert into platform_operator (actor_id, role) values ($1, 'owner')
       on conflict (actor_id) do nothing returning actor_id`, [id],
    );
    if (grant.rowCount) {
      await db.query(
        `insert into platform_admin_audit (actor_id, action, target_id)
         values ($1, 'bootstrap_owner', $2)`, [id, id],
      );
    }
    });
  }
}

export async function recordDeployment(pool: Pool): Promise<void> {
  await pool.query(`insert into platform_deployment (revision, environment) values ($1, $2)`,
    [process.env.RENDER_GIT_COMMIT?.slice(0, 40) ?? null, process.env.STAGING_COMBINED_SERVICE === 'true' ? 'staging' : 'production']);
}

export async function requirePlatformRole(pool: Pool, actorId: string, minimum: PlatformRole = 'viewer'): Promise<PlatformRole> {
  const { rows } = await pool.query<{ role: PlatformRole }>(
    `select p.role from platform_operator p join actor a on a.id = p.actor_id
     where p.actor_id = $1 and p.revoked_at is null and a.active and a.email_verified_at is not null`, [actorId],
  );
  const role = rows[0]?.role;
  const level = { viewer: 1, operator: 2, owner: 3 };
  if (!role || level[role] < level[minimum] || !(await mfaEnabled(pool, actorId))) {
    throw new AuthorizationError('administer', 'platform access requires an active grant, verified email and two-step verification');
  }
  return role;
}

export async function platformOverview(pool: Pool) {
  const [counts, mail, worker, alerts, recent, deployments] = await Promise.all([
    pool.query(`select
      (select count(*)::int from tenant) as workspaces,
      (select count(*)::int from actor where active) as people,
      (select count(distinct (tenant_id, process_key))::int from process_version) as processes,
      (select count(*)::int from instance) as records,
      (select count(*)::int from instance where completed_at is null) as open_records,
      (select count(*)::int from outbox where done_at is null and last_error is not null) as failed_jobs,
      (select count(*)::int from webhook_delivery where status = 'dead_letter') as dead_webhooks,
      (select count(*)::int from timer where fired_at is null and cancelled_at is null and due_at < now()) as overdue_timers`),
    pool.query(`select status, count(*)::int as count from (
      select status from email_log where sent_at > now() - interval '7 days'
      union all select status from platform_email where sent_at > now() - interval '7 days'
    ) m group by status order by status`),
    pool.query(`select worker_id, seen_at, actions, timers, webhooks, errors
      from platform_worker_heartbeat order by seen_at desc limit 5`),
    pool.query(`select level, sent, bounced, complained, raised_at from delivery_alert
      where cleared_at is null order by raised_at desc limit 1`),
    pool.query(`select t.id, t.name, count(i.id)::int as records
      from tenant t left join instance i on i.tenant_id = t.id
      where t.name not like 'scenario:%'
      group by t.id order by t.created_at desc limit 5`),
    pool.query(`select revision, environment, started_at from platform_deployment order by id desc limit 10`),
  ]);
  return {
    counts: counts.rows[0], mail: mail.rows, workers: worker.rows.map((w) => ({ ...w, healthy: Date.now() - new Date(w.seen_at).getTime() < 30_000 })),
    deliveryAlert: alerts.rows[0] ?? null, recentWorkspaces: recent.rows, deployments: deployments.rows,
    api: { ok: true, uptimeSeconds: Math.floor(process.uptime()), revision: process.env.RENDER_GIT_COMMIT?.slice(0, 12) ?? null },
    stagingCombinedService: process.env.STAGING_COMBINED_SERVICE === 'true',
  };
}

export async function platformWorkspaces(pool: Pool, search: string, page: number, scope: 'customers' | 'tests' | 'all' = 'customers') {
  const limit = 25;
  const offset = (page - 1) * limit;
  const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const where = `t.name ilike $1 and ($2 = 'all' or ($2 = 'tests' and t.name like 'scenario:%') or ($2 = 'customers' and t.name not like 'scenario:%'))`;
  const { rows } = await pool.query(
    `select t.id, t.name, t.created_at,
      (select count(*)::int from actor a where a.tenant_id = t.id and a.active) as people,
      (select count(distinct process_key)::int from process_version p where p.tenant_id = t.id) as processes,
      (select count(*)::int from instance i where i.tenant_id = t.id) as records,
      (select count(*)::int from outbox o where o.tenant_id = t.id and o.done_at is null and o.last_error is not null) as failed_jobs
     from tenant t where ${where} order by t.created_at desc, t.id limit $3 offset $4`,
    [term, scope, limit, offset],
  );
  const total = await pool.query<{ count: number }>(`select count(*)::int as count from tenant t where ${where}`, [term, scope]);
  return { rows, total: total.rows[0]?.count ?? 0, page, pageSize: limit };
}

export async function platformWorkspace(pool: Pool, tenantId: string) {
  const tenant = await pool.query('select id, name, created_at from tenant where id = $1', [tenantId]);
  if (!tenant.rows[0]) return null;
  const [people, processes, jobs, mail] = await Promise.all([
    pool.query(`select a.id, a.display_name, a.email, a.workspace_role, a.active, a.email_verified_at,
      (select count(*)::int from session s where s.actor_id = a.id and s.revoked_at is null and s.expires_at > now()) as sessions
      from actor a where a.tenant_id = $1 order by a.created_at desc limit 100`, [tenantId]),
    pool.query(`select process_key, max(version)::int as version, max(published_at) as published_at
      from process_version where tenant_id = $1 group by process_key order by process_key`, [tenantId]),
    pool.query(`select count(*)::int as pending, count(*) filter (where last_error is not null)::int as failed
      from outbox where tenant_id = $1 and done_at is null`, [tenantId]),
    pool.query(`select status, count(*)::int as count from email_log
      where tenant_id = $1 and sent_at > now() - interval '7 days' group by status`, [tenantId]),
  ]);
  return { workspace: tenant.rows[0], people: people.rows, processes: processes.rows, jobs: jobs.rows[0], mail: mail.rows };
}

export async function platformJobs(pool: Pool, page: number) {
  const { rows } = await pool.query(
    `select o.id, o.tenant_id, t.name as workspace, o.instance_id, o.transition_key,
      o.attempts, o.created_at, o.available_at, o.request_id
     from outbox o join tenant t on t.id = o.tenant_id
     where o.done_at is null and o.last_error is not null
     order by o.created_at desc limit 25 offset $1`, [(page - 1) * 25],
  );
  return { rows, page };
}

/** Request correlation without event payloads, answers, recipients, or raw errors. */
export async function platformTrace(pool: Pool, requestId: string) {
  const [events, jobs, actions] = await Promise.all([
    pool.query(`select e.tenant_id, t.name as workspace, e.instance_id, e.seq, e.type, e.occurred_at
      from event e join tenant t on t.id = e.tenant_id where e.request_id = $1
      order by e.occurred_at, e.seq limit 100`, [requestId]),
    pool.query(`select o.id, o.tenant_id, t.name as workspace, o.instance_id, o.transition_key,
      o.attempts, o.created_at, o.done_at, (o.last_error is not null) as has_error
      from outbox o join tenant t on t.id = o.tenant_id where o.request_id = $1
      order by o.id limit 100`, [requestId]),
    pool.query(`select a.id, a.tenant_id, t.name as workspace, a.instance_id, a.action_do,
      a.status, a.attempts, a.created_at, a.completed_at
      from action_run a join tenant t on t.id = a.tenant_id where a.request_id = $1
      order by a.id limit 100`, [requestId]),
  ]);
  return { requestId, events: events.rows, jobs: jobs.rows, actions: actions.rows };
}

export async function platformMail(pool: Pool) {
  const [process, account, alert, failures] = await Promise.all([
    pool.query(`select e.tenant_id, t.name as workspace, e.status, count(*)::int as count
      from email_log e join tenant t on t.id = e.tenant_id
      where e.sent_at > now() - interval '7 days'
      group by e.tenant_id, t.name, e.status order by t.name, e.status`),
    pool.query(`select p.tenant_id, t.name as workspace, p.kind, p.status, count(*)::int as count
      from platform_email p left join tenant t on t.id = p.tenant_id
      where p.sent_at > now() - interval '7 days'
      group by p.tenant_id, t.name, p.kind, p.status order by t.name, p.kind`),
    pool.query(`select id, level, sent, bounced, complained, raised_at, cleared_at
      from delivery_alert order by raised_at desc limit 20`),
    pool.query(`select e.id, e.tenant_id, t.name as workspace, e.status, e.template_key as kind, e.sent_at
      from email_log e join tenant t on t.id = e.tenant_id
      where e.status in ('failed','bounced','complained') and e.sent_at > now() - interval '7 days'
      union all
      select p.id, p.tenant_id, coalesce(t.name, 'Platform') as workspace, p.status, p.kind, p.sent_at
      from platform_email p left join tenant t on t.id = p.tenant_id
      where p.status = 'failed' and p.sent_at > now() - interval '7 days'
      order by sent_at desc limit 30`),
  ]);
  return { process: process.rows, account: account.rows, alerts: alert.rows, failures: failures.rows };
}

export async function platformAudit(pool: Pool, page: number) {
  const { rows } = await pool.query(`select a.id, a.actor_id, p.display_name as actor, a.action,
    a.tenant_id, t.name as workspace, a.target_id, a.detail, a.occurred_at
    from platform_admin_audit a left join actor p on p.id = a.actor_id
    left join tenant t on t.id = a.tenant_id
    order by a.id desc limit 50 offset $1`, [(page - 1) * 50]);
  return { rows, page };
}

export async function platformOperators(pool: Pool) {
  const { rows } = await pool.query(`select p.actor_id, p.role, p.granted_at, p.revoked_at,
    a.display_name, a.email, a.active, a.email_verified_at, (m.confirmed_at is not null) as mfa_enabled
    from platform_operator p join actor a on a.id = p.actor_id
    left join mfa_enrolment m on m.actor_id = p.actor_id
    order by p.revoked_at nulls first, p.granted_at desc`);
  return { rows };
}

export async function grantPlatformOperator(pool: Pool, actingId: string, email: string, role: PlatformRole) {
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query<{ id: string }>(`select a.id from actor a join credential c on c.actor_id = a.id
      where lower(a.email) = lower($1) and a.active and a.email_verified_at is not null`, [email.trim()]);
    if (rows.length !== 1) return { granted: false, reason: 'Exactly one active verified account is required.' };
    const id = rows[0]!.id;
    await db.query(`insert into platform_operator (actor_id, role, granted_by) values ($1, $2, $3)
      on conflict (actor_id) do update set role = excluded.role, granted_by = excluded.granted_by,
      granted_at = now(), revoked_at = null`, [id, role, actingId]);
    await db.query(`insert into platform_admin_audit (actor_id, action, target_id, detail)
      values ($1, 'grant_operator', $2, $3)`, [actingId, id, JSON.stringify({ role })]);
    return { granted: true, actorId: id };
  });
}

export async function revokePlatformOperator(pool: Pool, actingId: string, targetId: string) {
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query<{ actor_id: string; role: PlatformRole; revoked_at: Date | null }>(
      'select actor_id, role, revoked_at from platform_operator where actor_id = $1 for update', [targetId],
    );
    const target = rows[0];
    if (!target || target.revoked_at) return { revoked: false };
    if (target.role === 'owner') {
      await db.query(`select actor_id from platform_operator where role = 'owner' and revoked_at is null for update`);
      const count = await db.query<{ count: number }>(`select count(*)::int as count from platform_operator
        where role = 'owner' and revoked_at is null`);
      if ((count.rows[0]?.count ?? 0) <= 1) return { revoked: false, reason: 'The last platform owner cannot be removed.' };
    }
    await db.query('update platform_operator set revoked_at = now() where actor_id = $1', [targetId]);
    await db.query(`insert into platform_admin_audit (actor_id, action, target_id)
      values ($1, 'revoke_operator', $2)`, [actingId, targetId]);
    return { revoked: true };
  });
}

export async function auditPlatform(pool: Pool, actorId: string, action: string, tenantId: string | null, targetId: string | null, detail: object = {}) {
  await pool.query(`insert into platform_admin_audit (actor_id, action, tenant_id, target_id, detail)
    values ($1, $2, $3, $4, $5)`, [actorId, action, tenantId, targetId, JSON.stringify(detail)]);
}

export async function retryPlatformJob(pool: Pool, actorId: string, outboxId: number) {
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query<{ tenant_id: string; done_at: Date | null; last_error: string | null; claimed_at: Date | null }>(
      'select tenant_id, done_at, last_error, claimed_at from outbox where id = $1 for update', [outboxId],
    );
    const job = rows[0];
    if (!job || job.done_at || !job.last_error || (job.claimed_at && Date.now() - job.claimed_at.getTime() < 300_000)) return { retried: false };
    await db.query(`update outbox set available_at = now(), claimed_by = null, claimed_at = null,
      last_error = null where id = $1`, [outboxId]);
    await db.query(`insert into platform_admin_audit (actor_id, action, tenant_id, target_id)
      values ($1, 'retry_job', $2, $3)`, [actorId, job.tenant_id, String(outboxId)]);
    return { retried: true };
  });
}

export async function revokePlatformSessions(pool: Pool, actorId: string, targetActorId: string) {
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query<{ tenant_id: string }>('select tenant_id from actor where id = $1', [targetActorId]);
    if (!rows[0]) return { revoked: 0 };
    const result = await db.query('update session set revoked_at = now() where actor_id = $1 and revoked_at is null', [targetActorId]);
    await db.query(`insert into platform_admin_audit (actor_id, action, tenant_id, target_id, detail)
      values ($1, 'revoke_sessions', $2, $3, $4)`,
      [actorId, rows[0].tenant_id, targetActorId, JSON.stringify({ count: result.rowCount })]);
    return { revoked: result.rowCount ?? 0 };
  });
}

/** Site support may correct a workspace label without touching its records. */
export async function renamePlatformWorkspace(pool: Pool, actorId: string, tenantId: string, name: string, reason: string) {
  const nextName = name.trim();
  if (nextName.length < 2 || nextName.length > 120) return { changed: false, reason: 'Name must be 2–120 characters.' };
  if (reason.trim().length < 8 || reason.trim().length > 500) return { changed: false, reason: 'Enter a reason of 8–500 characters.' };
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query<{ name: string }>('select name from tenant where id = $1 for update', [tenantId]);
    if (!rows[0]) return { changed: false, reason: 'Workspace not found.' };
    if (rows[0].name === nextName) return { changed: false, reason: 'That is already the workspace name.' };
    await db.query('update tenant set name = $1 where id = $2', [nextName, tenantId]);
    await db.query(`insert into platform_admin_audit (actor_id, action, tenant_id, target_id, detail)
      values ($1, 'rename_workspace', $2, $2, $3)`, [actorId, tenantId,
      JSON.stringify({ from: rows[0].name, to: nextName, reason: reason.trim() })]);
    return { changed: true, name: nextName };
  });
}

export async function changePlatformPerson(pool: Pool, actorId: string, tenantId: string, personId: string,
  change: { active?: boolean; workspaceRole?: string; reason: string }) {
  if (change.reason.trim().length < 8 || change.reason.trim().length > 500) return { changed: false, reason: 'Enter a reason of 8–500 characters.' };
  if (change.active === undefined && !change.workspaceRole) return { changed: false, reason: 'Choose an access change.' };
  if (change.workspaceRole && !['owner', 'admin', 'builder', 'operator', 'approver', 'analyst', 'read_only'].includes(change.workspaceRole))
    return { changed: false, reason: 'Invalid workspace role.' };
  return inTransaction(pool, async (db) => {
    // Lock the workspace first so parallel access changes cannot both remove its last owner.
    const tenant = await db.query('select id from tenant where id = $1 for update', [tenantId]);
    if (!tenant.rows[0]) return { changed: false, reason: 'Workspace not found.' };
    const { rows } = await db.query<{ active: boolean; workspace_role: string; display_name: string }>(
      'select active, workspace_role, display_name from actor where id = $1 and tenant_id = $2 for update', [personId, tenantId]);
    const person = rows[0];
    if (!person) return { changed: false, reason: 'Person not found in this workspace.' };
    const nextActive = change.active ?? person.active;
    const nextRole = change.workspaceRole ?? person.workspace_role;
    if (nextActive === person.active && nextRole === person.workspace_role) return { changed: false, reason: 'There is no change to save.' };
    if (personId === actorId && !nextActive) return { changed: false, reason: 'You cannot deactivate your own account.' };
    if (person.active && person.workspace_role === 'owner' && (!nextActive || nextRole !== 'owner')) {
      const owners = await db.query<{ count: number }>(`select count(*)::int as count from actor
        where tenant_id = $1 and id <> $2 and active and workspace_role = 'owner'`, [tenantId, personId]);
      if (!owners.rows[0]?.count) return { changed: false, reason: 'Assign another active workspace owner first.' };
    }
    if (!nextActive) {
      const grant = await db.query('select role from platform_operator where actor_id = $1 and revoked_at is null', [personId]);
      if (grant.rows[0]) return { changed: false, reason: 'Revoke this person’s site admin grant first.' };
    }
    await db.query('update actor set active = $1, workspace_role = $2 where id = $3', [nextActive, nextRole, personId]);
    if (!nextActive || nextRole !== person.workspace_role) {
      await db.query('update session set revoked_at = now() where actor_id = $1 and revoked_at is null', [personId]);
    }
    await db.query(`insert into platform_admin_audit (actor_id, action, tenant_id, target_id, detail)
      values ($1, 'change_workspace_access', $2, $3, $4)`, [actorId, tenantId, personId,
      JSON.stringify({ from: { active: person.active, role: person.workspace_role }, to: { active: nextActive, role: nextRole }, reason: change.reason.trim() })]);
    return { changed: true, active: nextActive, workspaceRole: nextRole };
  });
}
