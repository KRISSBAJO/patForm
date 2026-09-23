import type { Pool } from 'pg';
import type { Principal } from './policy.js';
import { loadDraft } from './builder.js';
import { InvalidInput, invite } from './workspace.js';
import { inTransaction } from './db.js';

/** People and responsibilities for an installed process, scoped to its workspace. */
export async function processSetup(pool: Pool, principal: Principal, draftId: string) {
  const draft = await loadDraft(pool, principal, draftId);
  if (principal.kind !== 'actor') throw new InvalidInput('sign in first');
  const { tenantId } = principal;
  const { rows: members } = await pool.query<{
    id: string; email: string; display_name: string; workspace_role: string; provisioned_by: string;
  }>(
    `select id, email, display_name, workspace_role, provisioned_by from actor
      where tenant_id = $1 and active = true order by display_name`,
    [tenantId],
  );
  const { rows: assignments } = await pool.query<{ actor_id: string; role_key: string }>(
    `select actor_id, role_key from membership where tenant_id = $1 and process_key = $2`,
    [tenantId, draft.processKey],
  );
  const activeMemberIds = new Set(members.map((member) => member.id));
  const { rows: live } = await pool.query<{ version: number; public_id: string | null }>(
    `select p.version, f.public_id from process_version p
       left join public_form f on f.tenant_id = p.tenant_id and f.process_key = p.process_key
      where p.tenant_id = $1 and p.process_key = $2 order by p.version desc limit 1`,
    [tenantId, draft.processKey],
  );
  const { rows: publication } = await pool.query<{ published_as: number | null }>(
    'select published_as from process_draft where id = $1 and tenant_id = $2',
    [draftId, tenantId],
  );
  const approvalRoles = new Set(
    (draft.blueprint.workflow.approvals ?? []).flatMap((approval) =>
      approval.approvers.flatMap((party) => 'role' in party ? [party.role] : [])),
  );
  const taskRoles = new Set(
    (draft.blueprint.workflow.tasks ?? []).flatMap((task) =>
      'role' in task.assignee ? [task.assignee.role] : []),
  );
  const notifiedRoles = new Set(
    (draft.blueprint.communications.email ?? []).flatMap((message) =>
      [...message.to, ...message.cc].flatMap((party) => 'role' in party ? [party.role] : [])),
  );
  const roles = draft.blueprint.roles
    .filter((role) => role.kind === 'internal')
    .map((role) => ({
      key: role.key,
      name: role.name,
      capabilities: role.capabilities,
      decides: approvalRoles.has(role.key),
      doesWork: taskRoles.has(role.key),
      receivesUpdates: notifiedRoles.has(role.key),
      // Process membership grants the role's capabilities directly. A member's
      // workspace role does not have to contain the same capabilities.
      eligibleActorIds: members.map((member) => member.id),
      actorIds: assignments.filter((item) => item.role_key === role.key && activeMemberIds.has(item.actor_id)).map((item) => item.actor_id),
    }));
  return {
    draft,
    members,
    roles,
    live: live[0] ?? null,
    publishedAs: publication[0]?.published_as ?? null,
  };
}

/** Give or remove one existing member's process role. A directory-managed member stays directory-managed. */
export async function assignProcessRole(
  pool: Pool,
  args: { principal: Principal; draftId: string; roleKey: string; actorId: string; assigned: boolean },
) {
  const setup = await processSetup(pool, args.principal, args.draftId);
  if (args.principal.kind !== 'actor') throw new InvalidInput('sign in first');
  const principal = args.principal;
  const role = setup.roles.find((item) => item.key === args.roleKey);
  if (!role) throw new InvalidInput('that role is not part of this process');
  const member = setup.members.find((item) => item.id === args.actorId);
  if (!member) throw new InvalidInput('choose an active member of this workspace');
  if (member.provisioned_by === 'scim') {
    throw new InvalidInput('this account is managed by your directory — change its group membership there');
  }
  await inTransaction(pool, async (client) => {
    // Serialize changes to a role. Without this lock, two removals could each
    // see the other member and leave a live process with nobody assigned.
    await client.query('select pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [principal.tenantId, `${setup.draft.processKey}:${args.roleKey}`]);
    if (!args.assigned && setup.live && (role.decides || role.doesWork || role.receivesUpdates)) {
      const { rows } = await client.query<{ holders: number }>(
        `select count(*)::integer as holders from membership m
           join actor a on a.id = m.actor_id and a.tenant_id = m.tenant_id and a.active = true
          where m.tenant_id = $1 and m.process_key = $2 and m.role_key = $3`,
        [principal.tenantId, setup.draft.processKey, args.roleKey],
      );
      if (rows[0]!.holders <= 1) {
        throw new InvalidInput('add a replacement before removing the last person from a required role');
      }
    }
    if (args.assigned) {
      await client.query(
        `insert into membership (tenant_id, actor_id, process_key, role_key, granted_by)
         values ($1, $2, $3, $4, $5) on conflict do nothing`,
        [principal.tenantId, args.actorId, setup.draft.processKey, args.roleKey, `actor:${principal.actorId}`],
      );
    } else {
      await client.query(
        `delete from membership where tenant_id = $1 and actor_id = $2 and process_key = $3 and role_key = $4`,
        [principal.tenantId, args.actorId, setup.draft.processKey, args.roleKey],
      );
    }
  });
  return { roleKey: args.roleKey, actorId: args.actorId, assigned: args.assigned };
}

/** Invite a missing decision maker with only the process role chosen on this page. */
export async function inviteProcessMember(
  pool: Pool,
  args: { principal: Principal; draftId: string; roleKey: string; email: string },
) {
  const setup = await processSetup(pool, args.principal, args.draftId);
  const role = setup.roles.find((item) => item.key === args.roleKey);
  if (!role) throw new InvalidInput('that role is not part of this process');
  const blueprintRole = setup.draft.blueprint.roles.find((item) => item.key === role.key)!;
  const sent = await invite(pool, {
    principal: args.principal,
    email: args.email,
    workspaceRole: blueprintRole.capabilities.includes('approve') ? 'approver' : blueprintRole.capabilities.includes('operate') ? 'operator' : 'read_only',
    processRoles: [{ processKey: setup.draft.processKey, roleKey: role.key }],
    message: `Join to help with ${setup.draft.processName}.`,
  });
  return { id: sent.id, expiresAt: sent.expiresAt, delivered: sent.delivered };
}
