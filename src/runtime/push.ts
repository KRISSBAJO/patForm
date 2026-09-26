import type { Pool } from './db.js';
import { logIfEnabled } from './trace.js';
import type { Principal } from './policy.js';
import { sendWebPush, vapidKeysFromEnv, type PushSubscriptionKeys } from './web-push.js';

/**
 * Notifications for people who decide.
 *
 * An approver learns of new work from an email, or from opening the console.
 * On a phone, neither is a tap on the shoulder. A push notification is: the
 * console, installed to the home screen, asks once for permission and hands
 * the server a subscription; when a decision or a task is waiting for that
 * person, their phone says so, and a tap opens the record.
 *
 * What it will not do: carry answers. A notification is shown on a lock
 * screen and routed through Google's or Apple's push service; it says which
 * process and which reference, and nothing a form collected.
 *
 * Who is told is decided here, not by the engine: the worker looks for
 * approvals and tasks that have not been announced, resolves the party the
 * same way the engine resolves email recipients (a role through the
 * membership directory, an address through the actor table), pushes to every
 * device those people have subscribed, and marks the row. A subscription the
 * push service reports gone is forgotten.
 */
export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
}

export function pushConfig(): PushConfig {
  const keys = vapidKeysFromEnv();
  return { enabled: keys !== null, publicKey: keys?.publicKey ?? null };
}

interface BrowserSubscription {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

export async function saveSubscription(
  pool: Pool,
  principal: Principal,
  args: { subscription: BrowserSubscription; userAgent?: string | null },
): Promise<{ saved: boolean }> {
  if (principal.kind !== 'actor') throw new Error('sign in first');
  const s = args.subscription;
  const endpoint = typeof s.endpoint === 'string' ? s.endpoint : '';
  const p256dh = typeof s.keys?.p256dh === 'string' ? s.keys.p256dh : '';
  const auth = typeof s.keys?.auth === 'string' ? s.keys.auth : '';
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw new Error('that is not a push subscription');
  await pool.query(
    `insert into push_subscription (tenant_id, actor_id, endpoint, p256dh, auth, user_agent)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (endpoint) do update set tenant_id = excluded.tenant_id, actor_id = excluded.actor_id,
       p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failed_at = null`,
    [principal.tenantId, principal.actorId, endpoint, p256dh, auth, (args.userAgent ?? '').slice(0, 300) || null],
  );
  return { saved: true };
}

export async function removeSubscription(pool: Pool, principal: Principal, endpoint: string): Promise<{ removed: boolean }> {
  if (principal.kind !== 'actor') throw new Error('sign in first');
  const r = await pool.query('delete from push_subscription where actor_id = $1 and endpoint = $2', [principal.actorId, endpoint]);
  return { removed: Boolean(r.rowCount) };
}

export interface PushMessage {
  title: string;
  body: string;
  /** Where a tap goes, relative to the console's origin. */
  url: string;
  /** Collapses repeats about the same thing on the device. */
  tag?: string;
}

/** Sends one message to every device the given people have. Returns how many were sent. */
export async function pushTo(pool: Pool, actorIds: string[], message: PushMessage): Promise<number> {
  const keys = vapidKeysFromEnv();
  if (!keys || !actorIds.length) return 0;
  const { rows } = await pool.query<{ id: number; endpoint: string; p256dh: string; auth: string }>(
    'select id, endpoint, p256dh, auth from push_subscription where actor_id = any($1::uuid[]) and failed_at is null',
    [actorIds],
  );
  let sent = 0;
  for (const s of rows) {
    const sub: PushSubscriptionKeys = { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth };
    const result = await sendWebPush(keys, sub, message, { ttl: 24 * 3600, urgency: 'high', topic: message.tag });
    if (result.ok) {
      sent++;
      await pool.query('update push_subscription set last_used_at = now() where id = $1', [s.id]);
    } else if (result.gone) {
      await pool.query('delete from push_subscription where id = $1', [s.id]);
    } else {
      await pool.query('update push_subscription set failed_at = now() where id = $1', [s.id]);
      logIfEnabled('warn', 'push', { status: result.status, detail: result.detail });
    }
  }
  return sent;
}

/** A message to the caller's own devices, so "did it work" has an answer. */
export async function testPush(pool: Pool, principal: Principal): Promise<{ sent: number; devices: number }> {
  if (principal.kind !== 'actor') throw new Error('sign in first');
  const { rows } = await pool.query<{ n: number }>('select count(*)::int as n from push_subscription where actor_id = $1', [principal.actorId]);
  const sent = await pushTo(pool, [principal.actorId], {
    title: 'Notifications are on',
    body: 'This is what a waiting decision will look like.',
    url: '/console',
    tag: 'test',
  });
  return { sent, devices: rows[0]?.n ?? 0 };
}

/**
 * A party as the engine stores it, to the people it means. `role:key` goes
 * through the membership directory for that process; anything else is an
 * email address, which is an actor if they are a member.
 */
async function actorsFor(pool: Pool, tenantId: string, processKey: string, parties: string[]): Promise<string[]> {
  const roles = parties.filter((p) => p.startsWith('role:')).map((p) => p.slice(5));
  const emails = parties.filter((p) => !p.startsWith('role:') && p.includes('@')).map((p) => p.toLowerCase());
  const actors = parties.filter((p) => p.startsWith('actor:')).map((p) => p.slice(6));
  const ids = new Set<string>(actors);
  if (roles.length) {
    const { rows } = await pool.query<{ actor_id: string }>(
      `select m.actor_id from membership m join actor a on a.id = m.actor_id
        where m.tenant_id = $1 and m.process_key = $2 and m.role_key = any($3::text[]) and a.active`,
      [tenantId, processKey, roles],
    );
    for (const r of rows) ids.add(r.actor_id);
  }
  if (emails.length) {
    const { rows } = await pool.query<{ id: string }>(
      'select id from actor where tenant_id = $1 and lower(email) = any($2::text[]) and active',
      [tenantId, emails],
    );
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

/**
 * Tells people about decisions and tasks that are waiting for them and have
 * not been announced. Run by the worker each loop; cheap when there is
 * nothing new, because both queries stop at the unannounced rows.
 */
export async function notifyWaitingWork(pool: Pool, now = new Date()): Promise<number> {
  if (!vapidKeysFromEnv()) return 0;
  let sent = 0;

  const approvals = await pool.query<{
    id: number; tenant_id: string; instance_id: string; approvers: string[]; process_key: string; name: string; approval_key: string;
  }>(
    `select r.id, r.tenant_id, r.instance_id, r.approvers, r.approval_key, i.process_key, pv.blueprint ->> 'name' as name
       from approval_request r
       join instance i on i.id = r.instance_id
       join process_version pv on pv.id = i.process_version_id
      where r.status = 'pending' and r.notified_at is null
      order by r.id limit 50`,
  );
  for (const a of approvals.rows) {
    const claimed = await pool.query('update approval_request set notified_at = $2 where id = $1 and notified_at is null', [a.id, now]);
    if (!claimed.rowCount) continue;
    const people = await actorsFor(pool, a.tenant_id, a.process_key, a.approvers);
    sent += await pushTo(pool, people, {
      title: `Decision waiting: ${a.name}`,
      body: `${a.instance_id.slice(0, 8).toUpperCase()} is waiting for you.`,
      url: `/console?record=${a.instance_id}`,
      tag: `approval-${a.instance_id}`,
    });
  }

  const tasks = await pool.query<{
    id: number; tenant_id: string; instance_id: string; assignee: string | null; process_key: string; name: string; task_key: string;
  }>(
    `select t.id, t.tenant_id, t.instance_id, t.assignee, t.task_key, i.process_key, pv.blueprint ->> 'name' as name
       from task t
       join instance i on i.id = t.instance_id
       join process_version pv on pv.id = i.process_version_id
      where t.status = 'open' and t.notified_at is null
      order by t.id limit 50`,
  );
  for (const t of tasks.rows) {
    const claimed = await pool.query('update task set notified_at = $2 where id = $1 and notified_at is null', [t.id, now]);
    if (!claimed.rowCount) continue;
    if (!t.assignee) continue;
    const people = await actorsFor(pool, t.tenant_id, t.process_key, [t.assignee]);
    sent += await pushTo(pool, people, {
      title: `Task for you: ${t.name}`,
      body: `${t.instance_id.slice(0, 8).toUpperCase()} needs ${t.task_key.replace(/_/g, ' ')}.`,
      url: `/console?record=${t.instance_id}`,
      tag: `task-${t.instance_id}`,
    });
  }

  return sent;
}
