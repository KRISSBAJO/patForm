import type { Blueprint, Capability, Role } from '../blueprint/index.js';
import type { Client, Pool } from './db.js';
import type { Answers } from './expr.js';

/**
 * The central policy engine required by §12.1: "Central policy engine,
 * server-side checks, deny by default."
 *
 * Everything that changes a record goes through `authorize` first. There is no
 * second path and no convenience overload that skips it, because a control
 * with a bypass is not a control.
 *
 * The blueprint is the policy. Roles, capabilities, hidden fields and editable
 * fields are declared there, validated by the compiler, and enforced here — so
 * the thing a builder reads in review is the thing the runtime actually does.
 */

export type Principal =
  /** A signed-in member of the workspace. */
  | { kind: 'actor'; tenantId: string; actorId: string }
  /**
   * Someone filling in a public form. `instanceId` is set once they have a
   * resume token, and it is the ONLY thing that scopes them to a record — a
   * respondent without it may submit and read nothing.
   */
  | { kind: 'respondent'; tenantId: string; instanceId?: string; label?: string }
  /** The runtime itself: timers firing, workers draining the outbox. */
  | { kind: 'system'; reason: 'timer' | 'worker' | 'migration' };

/**
 * §6.1 IAM-02, sitting above the per-process roles: what someone may do across
 * the workspace, including in processes they hold no role in.
 *
 * Note what is absent from every row. A workspace role NEVER grants `approve`.
 * Deciding a record requires a process role and being named on that particular
 * request — an administrator can unstick a process, reassign work and read
 * anything, and still cannot approve your expense claim. Separation of duties
 * is not a feature you add later; it is an absence you have to preserve.
 */
export const WORKSPACE_GRANTS = {
  owner: ['administer', 'view', 'edit', 'operate', 'report'],
  admin: ['administer', 'view', 'edit', 'operate', 'report'],
  builder: ['administer', 'view', 'report'],
  operator: ['view', 'operate', 'report'],
  approver: ['view'],
  analyst: ['view', 'report'],
  read_only: ['view'],
} as const satisfies Record<string, readonly Capability[]>;

export type WorkspaceRole = keyof typeof WORKSPACE_GRANTS;

export const WORKSPACE_ROLES = Object.keys(WORKSPACE_GRANTS) as WorkspaceRole[];

export type Action = 'submit' | 'view' | 'edit' | 'approve' | 'operate' | 'report' | 'administer';

const CAPABILITY_FOR: Record<Action, Capability> = {
  submit: 'submit',
  view: 'view',
  edit: 'edit',
  approve: 'approve',
  operate: 'operate',
  report: 'report',
  administer: 'administer',
};

export interface Decision {
  allowed: boolean;
  reason: string;
  /** Blueprint roles this principal holds in this process. */
  roles: string[];
  workspaceRole?: WorkspaceRole;
}

export class AuthorizationError extends Error {
  constructor(
    readonly action: Action,
    readonly reason: string,
  ) {
    super(`refused: ${action} — ${reason}`);
    this.name = 'AuthorizationError';
  }
}

export interface AuthorizeArgs {
  principal: Principal;
  action: Action;
  /** The tenant that owns the thing being touched. */
  tenantId: string;
  processKey: string;
  blueprint: Blueprint;
  instanceId?: string;
  /**
   * For `approve`: the approvers the pending request actually names. A role
   * with the approve capability is not enough — you must be on the request.
   */
  namedApprovers?: string[];
  /**
   * For `approve`: an address that must not decide this one, whoever else is
   * named. Separation of duties — the submitter of a record may not approve
   * their own request.
   *
   * Checked here rather than in the engine so the refusal is reasoned and
   * audited like every other one, and so there is a single place that decides
   * whether somebody may approve.
   */
  barredApprover?: string | null;
  /** For completing a task: its assignee and its own completion rule. */
  task?: { assignee: string | null; completableBy: 'assignee' | 'any_operator' };
}

/**
 * Deny by default. Every return path below states a reason, and the caller
 * records the refusals.
 */
export async function authorize(client: Client, args: AuthorizeArgs): Promise<Decision> {
  const { principal, action, tenantId, processKey, blueprint } = args;

  // 1. Tenancy, before anything else. §10.3: a principal from another tenant
  //    is refused whatever role they hold in their own.
  if (principal.kind !== 'system' && principal.tenantId !== tenantId) {
    return { allowed: false, reason: 'principal belongs to a different tenant', roles: [] };
  }

  // 2. The runtime acting on its own behalf. Still tenant-scoped above, still
  //    audited by the caller, but it holds no blueprint role.
  if (principal.kind === 'system') {
    return { allowed: true, reason: `system:${principal.reason}`, roles: [] };
  }

  // 3. A respondent may start a process, and read or amend the ONE record
  //    their resume token names. Allowing `view` on the strength of being a
  //    respondent — which is what this did before — lets anyone holding any
  //    public link read every record in the tenant (§12.3, broken object
  //    authorization in public resume links), so the principal carries an
  //    instance rather than a promise.
  if (principal.kind === 'respondent') {
    if (action === 'submit') return { allowed: true, reason: 'respondent', roles: [] };

    // §20.1 step 6: an approver asks for changes and the respondent answers.
    // The blueprint's respondent role already says which fields that may
    // touch; refusing `edit` outright made those declarations unreachable.
    if (action !== 'view' && action !== 'edit') {
      return { allowed: false, reason: `a respondent may not ${action}`, roles: [] };
    }
    if (!principal.instanceId) {
      return { allowed: false, reason: 'respondent has no resume token for any record', roles: [] };
    }
    if (!args.instanceId) {
      return { allowed: false, reason: 'a respondent may not browse records', roles: [] };
    }
    if (principal.instanceId !== args.instanceId) {
      return { allowed: false, reason: 'resume token is for a different record', roles: [] };
    }

    // Returning the respondent role means the field-level checks that already
    // exist — redaction on read, editableFields on write — apply to them
    // unchanged. The capability opens the door; the role decides how far.
    const respondentRole = blueprint.roles.find((r) => r.kind === 'respondent');
    if (action === 'edit' && !respondentRole?.editableFields?.length) {
      return {
        allowed: false,
        reason: 'this process lets respondents change nothing after submitting',
        roles: [],
      };
    }
    return {
      allowed: true,
      reason: 'respondent, via their own resume token',
      roles: respondentRole ? [respondentRole.key] : [],
    };
  }

  // 4. The actor must exist, be active, and belong to this tenant.
  const { rows: actors } = await client.query<{
    active: boolean;
    email: string;
    workspace_role: WorkspaceRole;
  }>('select active, email, workspace_role from actor where id = $1 and tenant_id = $2', [
    principal.actorId,
    tenantId,
  ]);
  const actor = actors[0];
  if (!actor) return { allowed: false, reason: 'no such actor in this tenant', roles: [] };
  if (!actor.active) return { allowed: false, reason: 'actor is deactivated', roles: [] };

  // 5. Which blueprint roles they hold in THIS process.
  const { rows: memberships } = await client.query<{ role_key: string }>(
    'select role_key from membership where tenant_id = $1 and actor_id = $2 and process_key = $3',
    [tenantId, principal.actorId, processKey],
  );
  const roleKeys = memberships.map((m) => m.role_key);
  const needed = CAPABILITY_FOR[action];
  const workspaceRole = actor.workspace_role;

  // 6. Approving comes only from a process role. See WORKSPACE_GRANTS above.
  if (action === 'approve') {
    if (!roleKeys.length) {
      return { allowed: false, reason: 'actor holds no role in this process', roles: [], workspaceRole };
    }
    const canApprove = blueprint.roles
      .filter((r) => roleKeys.includes(r.key))
      .some((r) => r.capabilities.includes('approve'));
    if (!canApprove) {
      return {
        allowed: false,
        reason: `no role held (${roleKeys.join(', ')}) has the "approve" capability`,
        roles: roleKeys,
        workspaceRole,
      };
    }
    /*
     * Separation of duties, before the naming check.
     *
     * Ordered first on purpose: being named and being barred are both true of
     * a claimant who typed their own address into "your manager's email", and
     * the useful refusal is the one that says why.
     */
    if (args.barredApprover && actor.email.toLowerCase() === args.barredApprover.toLowerCase()) {
      return {
        allowed: false,
        reason: 'the person who submitted a record may not approve it',
        roles: roleKeys,
        workspaceRole,
      };
    }
    if (args.namedApprovers) {
      const addresses = new Set(args.namedApprovers);
      const isNamed = addresses.has(actor.email) || roleKeys.some((k) => addresses.has(`role:${k}`));
      if (!isNamed) {
        return {
          allowed: false,
          reason: 'actor is not named as an approver on this request',
          roles: roleKeys,
          workspaceRole,
        };
      }
    }
    return {
      allowed: true,
      reason: `named approver via ${roleKeys.join(', ')}`,
      roles: roleKeys,
      workspaceRole,
    };
  }

  // 7. Everything else may come from either level.
  const fromProcess = blueprint.roles
    .filter((r) => roleKeys.includes(r.key))
    .some((r) => r.capabilities.includes(needed));
  const grants = WORKSPACE_GRANTS[workspaceRole] as readonly Capability[];
  const fromWorkspace = grants.includes(needed);

  if (!fromProcess && !fromWorkspace) {
    return {
      allowed: false,
      reason: roleKeys.length
        ? `neither the roles held (${roleKeys.join(', ')}) nor workspace role "${workspaceRole}" grant "${needed}"`
        : `actor holds no role in this process, and workspace role "${workspaceRole}" does not grant "${needed}"`,
      roles: roleKeys,
      workspaceRole,
    };
  }

  // 8. Completing a task is checked against that task's own rule. A task
  //    addressed to a role is completable by anyone holding it, which is the
  //    ordinary case; one addressed to a person stays theirs until somebody
  //    reassigns it.
  //
  //    Stepping in over an assignment is break-glass, so it needs `administer`
  //    rather than merely `operate`. A workspace-level operator who could
  //    complete anybody's task would make per-task assignment decorative —
  //    which is the failure this whole area was fixed to stop repeating.
  if (action === 'operate' && args.task && args.task.completableBy === 'assignee') {
    const { assignee } = args.task;
    if (assignee) {
      const breakGlass = grants.includes('administer');
      const isAssignee =
        assignee === actor.email || roleKeys.some((k) => assignee === `role:${k}`) || breakGlass;
      if (!isAssignee) {
        return { allowed: false, reason: `task is assigned to ${assignee}`, roles: roleKeys, workspaceRole };
      }
    }
  }

  const via = [fromProcess ? roleKeys.join(', ') : null, fromWorkspace ? `workspace:${workspaceRole}` : null]
    .filter(Boolean)
    .join(' + ');
  return { allowed: true, reason: `via ${via}`, roles: roleKeys, workspaceRole };
}

/**
 * Authorizes, records the refusal, and throws. Used by every engine mutation.
 *
 * The refusal is written on its OWN connection, deliberately. Recording it on
 * the caller's client would enrol it in the transaction that is about to roll
 * back, so the audit trail of a refused action would vanish with the action —
 * which is the failure this table exists to prevent.
 */
export async function require_(client: Client, args: AuthorizeArgs, audit: Pool): Promise<Decision> {
  const decision = await authorize(client, args);
  if (!decision.allowed) {
    await recordDenialIndependently(audit, args, decision.reason);
    throw new AuthorizationError(args.action, decision.reason);
  }
  return decision;
}

/** Writes a refusal outside any caller transaction, so a rollback cannot erase it. */
export async function recordDenialIndependently(
  pool: Pool,
  args: AuthorizeArgs,
  reason: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await recordDenial(client, args, reason);
  } finally {
    client.release();
  }
}

export async function recordDenial(client: Client, args: AuthorizeArgs, reason: string): Promise<void> {
  const { principal } = args;
  await client.query(
    `insert into access_denial
       (tenant_id, actor_id, actor_label, action, resource, instance_id, reason, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      args.tenantId,
      principal.kind === 'actor' ? principal.actorId : null,
      describe(principal),
      args.action,
      args.processKey,
      args.instanceId ?? null,
      reason,
    ],
  );
}

export function describe(principal: Principal): string {
  switch (principal.kind) {
    case 'actor':
      return `actor:${principal.actorId}`;
    case 'respondent':
      return `respondent:${principal.label ?? 'anonymous'}`;
    case 'system':
      return `system:${principal.reason}`;
  }
}

// ------------------------------------------------------------ field-level

/**
 * §6.4: "Sensitive fields can be hidden from roles that otherwise access the
 * record." Redaction happens on the way out, so a field a role may not see is
 * never serialised rather than hidden in the client.
 */
export function redact(blueprint: Blueprint, roleKeys: string[], data: Answers, workspaceRole?: WorkspaceRole): Answers {
  const roles = blueprint.roles.filter((r) => roleKeys.includes(r.key));
  // Workspace readers with no process role may inspect record metadata. In a
  // restricted process, even an accidentally underclassified internal answer
  // may identify a person, so only explicitly public answers remain visible.
  // Owners and administrators retain confidential access; restricted answers
  // still require a process role.
  if (!roles.length) {
    const privileged = workspaceRole === 'owner' || workspaceRole === 'admin';
    const sensitiveProcess = blueprint.intent.sensitivityCeiling === 'restricted';
    const hidden = new Set(
      blueprint.data.fields
        .filter((f) => f.classification === 'restricted' ||
          (!privileged && (f.classification === 'confidential' || (sensitiveProcess && f.classification === 'internal'))))
        .map((f) => f.key),
    );
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, hidden.has(key) ? '[redacted]' : value]),
    );
  }

  // A field is hidden only when EVERY role the actor holds hides it. Holding a
  // second, broader role is how someone legitimately sees more.
  const hidden = roles
    .map((r) => new Set(r.hiddenFields ?? []))
    .reduce<Set<string>>((intersection, next, index) => {
      if (index === 0) return next;
      return new Set([...intersection].filter((key) => next.has(key)));
    }, new Set());

  if (!hidden.size) return data;

  const out: Answers = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = hidden.has(key) ? '[redacted]' : value;
  }
  return out;
}

/**
 * Which fields this principal may *see*, as keys.
 *
 * `redact` answers the same question by rewriting a record. Searching needs
 * the answer before there is a record to rewrite: a search that matched a
 * hidden field would report which records contain a value without showing it,
 * and "one record matches 'QQ123456C'" discloses the value to anybody willing
 * to guess. The same intersection rule as `redact` — a field is hidden only
 * when every role the actor holds hides it.
 */
export function visibleFields(blueprint: Blueprint, roleKeys: string[], workspaceRole?: WorkspaceRole): string[] {
  const all = blueprint.data.fields.map((f) => f.key);
  const roles = blueprint.roles.filter((r) => roleKeys.includes(r.key));
  if (!roles.length) {
    const privileged = workspaceRole === 'owner' || workspaceRole === 'admin';
    const sensitiveProcess = blueprint.intent.sensitivityCeiling === 'restricted';
    return blueprint.data.fields
      .filter((f) => f.classification !== 'restricted' &&
        (privileged || (f.classification !== 'confidential' && !(sensitiveProcess && f.classification === 'internal'))))
      .map((f) => f.key);
  }

  const hidden = roles
    .map((r) => new Set(r.hiddenFields ?? []))
    .reduce<Set<string>>((intersection, next, index) => {
      if (index === 0) return next;
      return new Set([...intersection].filter((key) => next.has(key)));
    }, new Set());

  return all.filter((key) => !hidden.has(key));
}

/**
 * §6.4 again, from the other direction: which fields this principal may change
 * after submission. A role with no `editableFields` may change nothing, which
 * is the safe reading of an omission.
 */
export function editableFields(blueprint: Blueprint, roleKeys: string[]): Set<string> {
  const allowed = new Set<string>();
  for (const role of blueprint.roles as Role[]) {
    if (!roleKeys.includes(role.key)) continue;
    for (const key of role.editableFields ?? []) allowed.add(key);
  }
  return allowed;
}

export function rejectUneditable(blueprint: Blueprint, roleKeys: string[], patch: Answers): string[] {
  const allowed = editableFields(blueprint, roleKeys);
  return Object.keys(patch).filter((key) => !allowed.has(key));
}

/**
 * A gate that does not need a process.
 *
 * Every other check in this file resolves a capability through a blueprint
 * role, which is right for anything done *to* a record. Creating a process has
 * no blueprint to consult — the whole point is that one does not exist yet —
 * so the only honest source is the workspace role in WORKSPACE_GRANTS. Making
 * this its own function rather than handing `authorize` a stub blueprint keeps
 * the two kinds of authority distinguishable when reading the audit.
 *
 * `builder`, `admin` and `owner` hold `administer`; `operator` and below do
 * not, so an operator can run processes but cannot invent them.
 */
export async function requireWorkspaceCapability(
  pool: Pool,
  principal: Principal,
  capability: Capability,
  resource: string,
): Promise<{ workspaceRole: WorkspaceRole; email: string }> {
  if (principal.kind !== 'actor') {
    throw new AuthorizationError('administer', `${principal.kind} principals hold no workspace role`);
  }

  // Written on its own connection for the same reason as recordDenialIndependently:
  // the caller usually throws, and a refusal recorded inside the doomed
  // transaction would roll back with it.
  const refuse = async (reason: string): Promise<never> => {
    await pool.query(
      `insert into access_denial
         (tenant_id, actor_id, actor_label, action, resource, instance_id, reason, occurred_at)
       values ($1, $2, $3, 'administer', $4, null, $5, now())`,
      [principal.tenantId, principal.actorId, `actor:${principal.actorId}`, resource, reason],
    );
    throw new AuthorizationError('administer', reason);
  };

  const { rows } = await pool.query<{ active: boolean; email: string; workspace_role: WorkspaceRole }>(
    'select active, email, workspace_role from actor where id = $1 and tenant_id = $2',
    [principal.actorId, principal.tenantId],
  );
  const actor = rows[0];
  if (!actor) return refuse('no such actor in this tenant');
  if (!actor.active) return refuse('actor is deactivated');

  const granted = WORKSPACE_GRANTS[actor.workspace_role] as readonly Capability[] | undefined;
  if (!granted?.includes(capability)) {
    return refuse(`workspace role "${actor.workspace_role}" does not grant "${capability}"`);
  }
  return { workspaceRole: actor.workspace_role, email: actor.email };
}
