import { createHash, randomBytes } from 'node:crypto';
import { inTransaction, type Client, type Pool } from './db.js';
import { setPassword } from './auth.js';
import { WORKSPACE_GRANTS, requireWorkspaceCapability, type Principal, type WorkspaceRole } from './policy.js';
import type { Capability } from '../blueprint/roles.js';
import { logIfEnabled } from './trace.js';
import { InvalidInput } from './errors.js';
import { isVerified, sendVerification } from './account.js';
import { invitationMail, sendPlatformMail } from './platform-mail.js';

/**
 * Workspaces and the people in them — §6.1's IAM-01 and IAM-04.
 *
 * *"Users can create or join a tenant workspace"* and *"owners can invite,
 * deactivate, and revoke sessions for users."* Only the last of those existed.
 * A workspace came from the seed script, and there was no way for a second
 * person to get into one — invisible in a demo, and blocking on the first day
 * of a pilot.
 *
 * Three rules shape everything here, and each exists because the obvious
 * implementation gets it wrong:
 *
 * **Nobody can invite somebody more powerful than themselves.** The same
 * intersection as API keys and OAuth scopes. Without it, `builder` is a
 * privilege escalation with one extra step: invite an owner, accept it
 * yourself.
 *
 * **The last owner cannot be removed.** Not by deactivation, not by demotion.
 * A workspace with no owner has nobody who can invite one, which makes it
 * unrecoverable without database access — and "contact support to get back
 * into your own account" is the failure mode this prevents.
 *
 * **Deactivation revokes sessions in the same transaction.** `resolveSession`
 * already joins on `a.active`, so a deactivated person is refused on their
 * next request; revoking as well means the row is gone rather than merely
 * ignored, which is what somebody reading the session table during an incident
 * needs to see.
 */

const INVITE_TTL_DAYS = 7;

// Re-exported so existing callers keep one import; defined in errors.ts
// because account recovery needs it too.
export { InvalidInput } from './errors.js';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ------------------------------------------------------------ creating one

export interface NewWorkspace {
  workspaceName: string;
  ownerEmail: string;
  ownerName: string;
  password: string;
}

/**
 * IAM-01's first half: creating a workspace.
 *
 * Unauthenticated by necessity — there is nobody to authenticate yet. That
 * makes it the one endpoint in this system a stranger can reach and cause a
 * write with, so the guards are here rather than in the caller: a real
 * address, a password long enough to be worth hashing, and a workspace name.
 *
 * The address is unverified when this returns, and a verification link is on
 * its way. What that gate actually costs the owner is one thing: they cannot
 * invite anybody else until they follow it. That is the abuse worth stopping —
 * a workspace created under somebody else's address, used to send invitations
 * that look like they came from them — and it is the only thing blocked,
 * because a sign-up that cannot do anything at all until the mail arrives is
 * how a pilot loses its first user.
 */
export async function createWorkspace(
  pool: Pool,
  args: NewWorkspace,
): Promise<{ tenantId: string; actorId: string }> {
  const email = args.ownerEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new InvalidInput('that is not an email address');
  if (args.password.length < 12) {
    throw new InvalidInput('a password of at least 12 characters, please — this account owns everything in the workspace');
  }
  if (!args.workspaceName.trim()) throw new InvalidInput('the workspace needs a name');

  return inTransaction(pool, async (client) => {
    const { rows: tenants } = await client.query<{ id: string }>(
      'insert into tenant (name) values ($1) returning id',
      [args.workspaceName.trim()],
    );
    const tenantId = tenants[0]!.id;

    const { rows: actors } = await client.query<{ id: string }>(
      `insert into actor (tenant_id, email, display_name, workspace_role, provisioned_by)
       values ($1, $2, $3, 'owner', 'signup') returning id`,
      [tenantId, email, args.ownerName.trim() || email],
    );
    const actorId = actors[0]!.id;

    await setPassword(client, actorId, args.password);

    logIfEnabled('info', 'workspace.created', { tenantId, actorId });
    return { tenantId, actorId };
  }).then(async (created) => {
    // After the commit, not inside it. The send is a network call: holding a
    // transaction open across one is how a slow provider becomes a lock
    // timeout, and a rollback after a delivered email cannot be undone.
    await sendVerification(pool, { actorId: created.actorId });
    return created;
  });
}

// ------------------------------------------------------------------ people

export async function listMembers(pool: Pool, principal: Principal) {
  if (principal.kind !== 'actor') throw new Error('signed-in members only');
  const { rows } = await pool.query(
    `select a.id, a.email, a.display_name, a.workspace_role, a.active, a.provisioned_by,
            a.external_id, a.created_at,
            (select count(*)::int from session s
              where s.actor_id = a.id and s.revoked_at is null and s.expires_at > now()) as sessions,
            (select count(*)::int from membership m where m.actor_id = a.id) as process_roles,
            (select max(s.last_seen_at) from session s where s.actor_id = a.id) as last_seen_at,
            (select array_agg(i.provider) from actor_identity i where i.actor_id = a.id) as identities
       from actor a where a.tenant_id = $1 order by a.active desc, a.display_name`,
    [principal.tenantId],
  );
  return rows;
}

export interface InviteRow {
  email: string;
  role: string;
}

export interface InviteRowResult {
  email: string;
  role: string;
  status: 'ready' | 'sent' | 'skipped' | 'failed';
  /** Why a row will not go, or something worth knowing about one that will. */
  note?: string;
}

/** Most at once. A mistake in a pasted list should cost a hundred emails at worst, not a thousand. */
export const MAX_INVITES = 100;

/**
 * Many invitations at once — typed, pasted or from a spreadsheet.
 *
 * Checked in full before anything is sent, and the same checks run again as
 * each one goes: a list is where typos, duplicates and people who are already
 * here turn up, and one bad row should be a line in the result, not a reason
 * to stop the other forty. `dryRun` answers row by row without sending, which
 * is what the page shows before anybody presses Send.
 *
 * Each row that goes out is an ordinary `invite`, so nothing here can grant
 * more than one invitation can: the role must be one this person may hand
 * out, and their own address must be confirmed.
 */
export async function inviteMany(
  pool: Pool,
  args: { principal: Principal; rows: InviteRow[]; message?: string; dryRun: boolean },
): Promise<{ rows: InviteRowResult[] }> {
  await requireWorkspaceCapability(pool, args.principal, 'administer', 'invitations');
  const principal = args.principal;
  if (principal.kind !== 'actor') throw new Error('unreachable');
  if (!args.rows.length) throw new InvalidInput('add at least one address');
  if (args.rows.length > MAX_INVITES) {
    throw new InvalidInput(`at most ${MAX_INVITES} invitations at once — split the list`);
  }
  if (!(await isVerified(pool, principal.actorId))) {
    throw new InvalidInput(
      'confirm your own email address first — we sent you a link when you created the workspace, and invitations go out under your name',
    );
  }

  const grantable = grantableRoles(await inTransaction(pool, (c) => roleOf(c, principal.actorId)));
  const emails = args.rows.map((r) => r.email.trim().toLowerCase());
  const { rows: members } = await pool.query<{ email: string; active: boolean }>(
    'select lower(email) as email, active from actor where tenant_id = $1 and lower(email) = any($2::text[])',
    [principal.tenantId, emails],
  );
  const { rows: pending } = await pool.query<{ email: string }>(
    `select lower(email) as email from invitation
      where tenant_id = $1 and lower(email) = any($2::text[])
        and accepted_at is null and revoked_at is null and expires_at > now()`,
    [principal.tenantId, emails],
  );
  const memberOf = new Map(members.map((m) => [m.email, m.active]));
  const invited = new Set(pending.map((p) => p.email));

  const seen = new Set<string>();
  const checked: InviteRowResult[] = args.rows.map((row) => {
    const email = row.email.trim().toLowerCase();
    const role = row.role.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const out = (status: InviteRowResult['status'], note?: string): InviteRowResult => ({ email, role, status, note });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return out('skipped', 'not an email address');
    if (seen.has(email)) return out('skipped', 'already further up the list');
    seen.add(email);
    if (!(role in WORKSPACE_GRANTS)) return out('skipped', `"${row.role}" is not a role`);
    if (!grantable.includes(role as WorkspaceRole)) return out('skipped', `you cannot give the ${role.replace(/_/g, ' ')} role`);
    if (memberOf.get(email) === true) return out('skipped', 'already in this workspace');
    if (memberOf.get(email) === false) return out('skipped', 'a deactivated member — reactivate them instead');
    if (invited.has(email)) return out('ready', 'already invited; sending replaces the old link');
    return out('ready');
  });

  if (args.dryRun) return { rows: checked };

  const results: InviteRowResult[] = [];
  for (const row of checked) {
    if (row.status !== 'ready') {
      results.push(row);
      continue;
    }
    try {
      const sent = await invite(pool, {
        principal,
        email: row.email,
        workspaceRole: row.role as WorkspaceRole,
        message: args.message,
      });
      results.push(
        sent.delivered === 'failed'
          ? { ...row, status: 'failed', note: 'invitation made, but the email did not send' }
          : { ...row, status: 'sent', note: undefined },
      );
    } catch (err) {
      results.push({ ...row, status: 'failed', note: err instanceof Error ? err.message : String(err) });
    }
  }
  return { rows: results };
}

/**
 * The roles somebody may hand out.
 *
 * A role is grantable when its capabilities are a subset of the granter's.
 * Comparing capability sets rather than a hard-coded hierarchy means this
 * stays correct if WORKSPACE_GRANTS changes — a new role slots in without
 * anybody remembering to update a list here.
 */
export function grantableRoles(granter: WorkspaceRole): WorkspaceRole[] {
  const held = new Set(WORKSPACE_GRANTS[granter] as readonly Capability[]);
  return (Object.keys(WORKSPACE_GRANTS) as WorkspaceRole[]).filter((role) =>
    (WORKSPACE_GRANTS[role] as readonly Capability[]).every((c) => held.has(c)),
  );
}

async function roleOf(client: Client, actorId: string): Promise<WorkspaceRole> {
  const { rows } = await client.query<{ workspace_role: WorkspaceRole }>(
    'select workspace_role from actor where id = $1',
    [actorId],
  );
  if (!rows[0]) throw new InvalidInput('no such member');
  return rows[0].workspace_role;
}

/** Guards the one state a workspace cannot recover from without a DBA. */
async function refuseIfLastOwner(client: Client, tenantId: string, actorId: string): Promise<void> {
  const { rows } = await client.query<{ count: number }>(
    `select count(*)::int as count from actor
      where tenant_id = $1 and workspace_role = 'owner' and active and id <> $2`,
    [tenantId, actorId],
  );
  if (rows[0]!.count === 0) {
    throw new InvalidInput('this is the only active owner — promote somebody else first, or the workspace has nobody who can');
  }
}

// ------------------------------------------------------------- invitations

export interface InviteArgs {
  principal: Principal;
  email: string;
  workspaceRole: WorkspaceRole;
  processRoles?: { processKey: string; roleKey: string }[];
  message?: string;
}

export async function invite(
  pool: Pool,
  args: InviteArgs,
): Promise<{ id: string; token: string; expiresAt: string; delivered: string }> {
  await requireWorkspaceCapability(pool, args.principal, 'administer', 'invitations');
  const principal = args.principal;
  if (principal.kind !== 'actor') throw new Error('unreachable');
  const tenantId = principal.tenantId;
  const email = args.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new InvalidInput('that is not an email address');

  /*
   * The verification gate, and the only thing it guards.
   *
   * Without it, anybody can create a workspace under a colleague's address and
   * send invitations that arrive saying that colleague invited you. The
   * invitation is the one thing a sign-up does that reaches a third party, so
   * it is the one thing that waits for proof the address is theirs.
   */
  if (!(await isVerified(pool, principal.actorId))) {
    throw new InvalidInput(
      'confirm your own email address first — we sent you a link when you created the workspace, and invitations go out under your name',
    );
  }

  const sent = await inTransaction(pool, async (client) => {
    const granterRole = await roleOf(client, principal.actorId);
    if (!grantableRoles(granterRole).includes(args.workspaceRole)) {
      // Otherwise every role holding `administer` is an escalation with one
      // extra step: invite an owner, accept it yourself.
      throw new InvalidInput(
        `you hold "${granterRole}", which cannot grant "${args.workspaceRole}" — you would be handing out more than you have`,
      );
    }

    const { rows: existing } = await client.query<{ id: string; active: boolean }>(
      'select id, active from actor where tenant_id = $1 and email = $2',
      [tenantId, email],
    );
    if (existing[0]?.active) throw new InvalidInput('somebody with that address is already in this workspace');
    if (existing[0]) throw new InvalidInput('that address belongs to a deactivated member — reactivate them instead');

    // One open invitation per address. A second would mean two valid links
    // and a question about which role actually applies.
    await client.query(
      `update invitation set revoked_at = now()
        where tenant_id = $1 and email = $2 and accepted_at is null and revoked_at is null`,
      [tenantId, email],
    );

    const token = `inv_${randomBytes(24).toString('base64url')}`;
    const { rows } = await client.query<{ id: string; expires_at: Date }>(
      `insert into invitation
         (tenant_id, email, workspace_role, process_roles, token_hash, invited_by, message, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8))
       returning id, expires_at`,
      [
        tenantId,
        email,
        args.workspaceRole,
        JSON.stringify(args.processRoles ?? []),
        hash(token),
        principal.actorId,
        args.message ?? '',
        INVITE_TTL_DAYS,
      ],
    );

    const { rows: about } = await client.query<{ workspace_name: string; invited_by: string }>(
      `select t.name as workspace_name, a.display_name as invited_by
         from tenant t, actor a where t.id = $1 and a.id = $2`,
      [tenantId, principal.actorId],
    );

    logIfEnabled('info', 'invitation.created', { tenantId, role: args.workspaceRole });
    return {
      id: rows[0]!.id,
      token,
      expiresAt: rows[0]!.expires_at.toISOString(),
      workspaceName: about[0]!.workspace_name,
      invitedBy: about[0]!.invited_by,
    };
  });

  // Outside the transaction: a provider timeout must not roll back the
  // invitation. If the mail fails the row is still there and it can be resent.
  const mail = invitationMail({
    to: email,
    token: sent.token,
    workspaceName: sent.workspaceName,
    invitedBy: sent.invitedBy,
    workspaceRole: args.workspaceRole,
    message: args.message,
    expiresAt: sent.expiresAt,
  });
  const delivery = await sendPlatformMail(pool, {
    kind: 'invitation',
    to: email,
    subject: mail.subject,
    text: mail.text,
    tenantId,
    actorId: principal.actorId,
    idempotencyKey: `invite:${sent.id}`,
  });

  return {
    id: sent.id,
    token: sent.token,
    expiresAt: sent.expiresAt,
    delivered: delivery?.status ?? 'failed',
  };
}

/**
 * What the invitee sees before deciding, without being signed in.
 *
 * Deliberately thin: the workspace name, the role, and who asked. Not the
 * member list, not the processes, not anything else — whoever holds this link
 * has not proved they are the person it was sent to, and an invitation is
 * otherwise a read-only window into a workspace for anybody who intercepts an
 * email.
 */
export async function readInvitation(
  pool: Pool,
  token: string,
): Promise<{ workspaceName: string; email: string; workspaceRole: string; invitedBy: string; expiresAt: string }> {
  const { rows } = await pool.query<{
    email: string;
    workspace_role: string;
    workspace_name: string;
    invited_by_name: string;
    expires_at: Date;
    accepted_at: Date | null;
    revoked_at: Date | null;
  }>(
    `select i.email, i.workspace_role, t.name as workspace_name, a.display_name as invited_by_name,
            i.expires_at, i.accepted_at, i.revoked_at
       from invitation i join tenant t on t.id = i.tenant_id join actor a on a.id = i.invited_by
      where i.token_hash = $1`,
    [hash(token)],
  );
  const row = rows[0];
  // One message for every failure. Distinguishing "expired" from "never
  // existed" tells somebody holding a guessed token that they guessed right.
  if (!row || row.accepted_at || row.revoked_at || row.expires_at < new Date()) {
    throw new InvalidInput('that invitation is not valid any more');
  }

  return {
    workspaceName: row.workspace_name,
    email: row.email,
    workspaceRole: row.workspace_role,
    invitedBy: row.invited_by_name,
    expiresAt: row.expires_at.toISOString(),
  };
}

/** IAM-01's second half: joining one. */
export async function acceptInvitation(
  pool: Pool,
  args: { token: string; displayName: string; password: string },
): Promise<{ tenantId: string; actorId: string; workspaceName: string }> {
  if (args.password.length < 12) throw new InvalidInput('a password of at least 12 characters, please');

  return inTransaction(pool, async (client) => {
    /*
     * Locked for the duration.
     *
     * Two people following the same link at the same moment would otherwise
     * both pass the "not accepted" check and both create an account. The
     * second would fail on the unique index — but with half the work done and
     * an error nobody can read.
     */
    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      email: string;
      workspace_role: WorkspaceRole;
      process_roles: { processKey: string; roleKey: string }[];
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(
      `select id, tenant_id, email, workspace_role, process_roles, expires_at, accepted_at, revoked_at
         from invitation where token_hash = $1 for update`,
      [hash(args.token)],
    );
    const invitation = rows[0];
    if (!invitation || invitation.accepted_at || invitation.revoked_at || invitation.expires_at < new Date()) {
      throw new InvalidInput('that invitation is not valid any more');
    }

    const { rows: tenants } = await client.query<{ name: string }>('select name from tenant where id = $1', [
      invitation.tenant_id,
    ]);

    const { rows: actors } = await client.query<{ id: string }>(
      `insert into actor (tenant_id, email, display_name, workspace_role, provisioned_by)
       values ($1, $2, $3, $4, 'invite') returning id`,
      [invitation.tenant_id, invitation.email, args.displayName.trim() || invitation.email, invitation.workspace_role],
    );
    const actorId = actors[0]!.id;

    await setPassword(client, actorId, args.password);

    // Verified by arrival. They followed a link that was emailed to that
    // address, which is exactly what a verification link proves — asking them
    // to do it twice would be ceremony.
    await client.query('update actor set email_verified_at = now() where id = $1', [actorId]);

    // The process roles they were invited for, so they arrive able to do the
    // job rather than able to see nothing.
    for (const role of invitation.process_roles ?? []) {
      await client.query(
        `insert into membership (tenant_id, actor_id, process_key, role_key)
         values ($1, $2, $3, $4) on conflict do nothing`,
        [invitation.tenant_id, actorId, role.processKey, role.roleKey],
      );
    }

    await client.query('update invitation set accepted_at = now(), accepted_actor_id = $1 where id = $2', [
      actorId,
      invitation.id,
    ]);

    logIfEnabled('info', 'invitation.accepted', { tenantId: invitation.tenant_id, actorId });
    return { tenantId: invitation.tenant_id, actorId, workspaceName: tenants[0]?.name ?? '' };
  });
}

export async function listInvitations(pool: Pool, principal: Principal) {
  await requireWorkspaceCapability(pool, principal, 'administer', 'invitations');
  if (principal.kind !== 'actor') throw new Error('unreachable');
  const { rows } = await pool.query(
    `select i.id, i.email, i.workspace_role, i.expires_at, i.accepted_at, i.revoked_at, i.created_at,
            a.display_name as invited_by
       from invitation i join actor a on a.id = i.invited_by
      where i.tenant_id = $1 order by i.created_at desc limit 100`,
    [principal.tenantId],
  );
  return rows;
}

export async function revokeInvitation(
  pool: Pool,
  args: { principal: Principal; invitationId: string },
): Promise<{ revoked: boolean }> {
  await requireWorkspaceCapability(pool, args.principal, 'administer', 'invitations');
  if (args.principal.kind !== 'actor') throw new Error('unreachable');
  const { rowCount } = await pool.query(
    `update invitation set revoked_at = now()
      where id = $1 and tenant_id = $2 and accepted_at is null and revoked_at is null`,
    [args.invitationId, args.principal.tenantId],
  );
  return { revoked: (rowCount ?? 0) > 0 };
}

// ------------------------------------------------- deactivate and reinstate

export async function setMemberActive(
  pool: Pool,
  args: { principal: Principal; actorId: string; active: boolean },
): Promise<{ actorId: string; active: boolean; sessionsRevoked: number }> {
  await requireWorkspaceCapability(pool, args.principal, 'administer', 'members');
  const principal = args.principal;
  if (principal.kind !== 'actor') throw new Error('unreachable');
  const tenantId = principal.tenantId;

  return inTransaction(pool, async (client) => {
    const { rows: target } = await client.query<{ workspace_role: WorkspaceRole; provisioned_by: string }>(
      'select workspace_role, provisioned_by from actor where id = $1 and tenant_id = $2',
      [args.actorId, tenantId],
    );
    if (!target[0]) throw new InvalidInput('no such member');

    if (target[0].provisioned_by === 'scim') {
      // The directory owns this row. Changing it here would be overwritten on
      // the next sync, and the person doing it would never find out why.
      throw new InvalidInput('this account is managed by your directory — deactivate them there');
    }

    if (!args.active) {
      await refuseIfLastOwner(client, tenantId, args.actorId);
      // Somebody who deactivates themselves cannot undo it, and if they were
      // the only admin nobody else can either.
      if (args.actorId === principal.actorId) {
        throw new InvalidInput('you cannot deactivate yourself — ask another owner or admin');
      }
    }

    await client.query('update actor set active = $1 where id = $2 and tenant_id = $3', [
      args.active,
      args.actorId,
      tenantId,
    ]);

    /*
     * Revoked in the same transaction, not merely refused afterwards.
     *
     * `resolveSession` joins on `a.active`, so a deactivated person is turned
     * away on their next request either way. Revoking as well means the rows
     * are gone rather than ignored — which is what somebody reading the
     * session table during an incident needs to see, and what makes "revoke
     * sessions" in IAM-04 a thing that happened rather than a consequence.
     */
    let sessionsRevoked = 0;
    if (!args.active) {
      const { rowCount } = await client.query(
        'update session set revoked_at = now() where actor_id = $1 and revoked_at is null',
        [args.actorId],
      );
      sessionsRevoked = rowCount ?? 0;
    }

    logIfEnabled('info', args.active ? 'member.reactivated' : 'member.deactivated', {
      tenantId,
      target: args.actorId,
      sessionsRevoked,
    });
    return { actorId: args.actorId, active: args.active, sessionsRevoked };
  });
}

export async function changeRole(
  pool: Pool,
  args: { principal: Principal; actorId: string; workspaceRole: WorkspaceRole },
): Promise<{ actorId: string; workspaceRole: WorkspaceRole }> {
  await requireWorkspaceCapability(pool, args.principal, 'administer', 'members');
  const principal = args.principal;
  if (principal.kind !== 'actor') throw new Error('unreachable');
  const tenantId = principal.tenantId;

  return inTransaction(pool, async (client) => {
    const granterRole = await roleOf(client, principal.actorId);
    if (!grantableRoles(granterRole).includes(args.workspaceRole)) {
      throw new InvalidInput(`you hold "${granterRole}", which cannot grant "${args.workspaceRole}"`);
    }

    const { rows: target } = await client.query<{ workspace_role: WorkspaceRole; provisioned_by: string }>(
      'select workspace_role, provisioned_by from actor where id = $1 and tenant_id = $2',
      [args.actorId, tenantId],
    );
    if (!target[0]) throw new InvalidInput('no such member');
    if (target[0].provisioned_by === 'scim') {
      throw new InvalidInput('this account is managed by your directory — change their group membership there');
    }

    // Demoting the last owner has the same consequence as deactivating them.
    if (target[0].workspace_role === 'owner' && args.workspaceRole !== 'owner') {
      await refuseIfLastOwner(client, tenantId, args.actorId);
    }

    await client.query('update actor set workspace_role = $1 where id = $2 and tenant_id = $3', [
      args.workspaceRole,
      args.actorId,
      tenantId,
    ]);
    return { actorId: args.actorId, workspaceRole: args.workspaceRole };
  });
}

// -------------------------------------------------------- external identity

/**
 * IAM-05's runtime half: attaching a directory identity to an account.
 *
 * Not wired to any provider — SSO is deferred. This exists so that when one
 * arrives, it has somewhere to write, and so the rule that matters is already
 * enforced: **match on the subject, never on the email.** An IdP's `sub` is
 * stable across a name change, a marriage, a domain migration. An email is a
 * display value, and matching on it is how one person ends up with two
 * accounts or two people end up with one.
 */
export async function linkIdentity(
  pool: Pool,
  args: { actorId: string; provider: string; subject: string; emailAtLink?: string },
): Promise<{ linked: boolean }> {
  const { rowCount } = await pool.query(
    `insert into actor_identity (actor_id, provider, subject, email_at_link)
     values ($1, $2, $3, $4)
     on conflict (provider, subject) do nothing`,
    [args.actorId, args.provider, args.subject, args.emailAtLink ?? null],
  );
  return { linked: (rowCount ?? 0) > 0 };
}

export async function actorForIdentity(
  pool: Pool,
  args: { provider: string; subject: string },
): Promise<{ actorId: string; tenantId: string } | null> {
  const { rows } = await pool.query<{ actor_id: string; tenant_id: string }>(
    `select i.actor_id, a.tenant_id from actor_identity i join actor a on a.id = i.actor_id
      where i.provider = $1 and i.subject = $2 and a.active`,
    [args.provider, args.subject],
  );
  if (!rows[0]) return null;
  void pool.query('update actor_identity set last_seen_at = now() where provider = $1 and subject = $2', [
    args.provider,
    args.subject,
  ]).catch(() => undefined);
  return { actorId: rows[0].actor_id, tenantId: rows[0].tenant_id };
}
