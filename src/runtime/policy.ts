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
  /** Someone filling in a public form. Holds no capability but `submit`. */
  | { kind: 'respondent'; tenantId: string; label?: string }
  /** The runtime itself: timers firing, workers draining the outbox. */
  | { kind: 'system'; reason: 'timer' | 'worker' | 'migration' };

export type Action =
  | 'submit'
  | 'view'
  | 'edit'
  | 'approve'
  | 'operate'
  | 'report'
  | 'administer';

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
  /** For `complete_task`: who the task was assigned to. */
  taskAssignee?: string | null;
}

/**
 * Deny by default. Every return path below states a reason, and the caller
 * records the refusals.
 */
export async function authorize(client: Client, args: AuthorizeArgs): Promise<Decision> {
  const { principal, action, tenantId, processKey, blueprint } = args;

  // 1. Tenancy, before anything else. Section 10.3: a principal from another
  //    tenant is refused whatever role they hold in their own.
  if (principal.kind !== 'system' && principal.tenantId !== tenantId) {
    return { allowed: false, reason: 'principal belongs to a different tenant', roles: [] };
  }

  // 2. The runtime acting on its own behalf. Still tenant-scoped above, still
  //    audited by the caller, but it holds no blueprint role.
  if (principal.kind === 'system') {
    return { allowed: true, reason: `system:${principal.reason}`, roles: [] };
  }

  // 3. A respondent can start a process and see their own record. Nothing else.
  if (principal.kind === 'respondent') {
    const allowed = action === 'submit' || action === 'view';
    return {
      allowed,
      reason: allowed ? 'respondent' : `a respondent may not ${action}`,
      roles: [],
    };
  }

  // 4. The actor must exist, be active, and belong to this tenant.
  const { rows: actors } = await client.query<{ active: boolean; email: string }>(
    'select active, email from actor where id = $1 and tenant_id = $2',
    [principal.actorId, tenantId],
  );
  const actor = actors[0];
  if (!actor) return { allowed: false, reason: 'no such actor in this tenant', roles: [] };
  if (!actor.active) return { allowed: false, reason: 'actor is deactivated', roles: [] };

  // 5. Which blueprint roles they hold in THIS process.
  const { rows: memberships } = await client.query<{ role_key: string }>(
    'select role_key from membership where tenant_id = $1 and actor_id = $2 and process_key = $3',
    [tenantId, principal.actorId, processKey],
  );
  const roleKeys = memberships.map((m) => m.role_key);
  if (!roleKeys.length) {
    return { allowed: false, reason: 'actor holds no role in this process', roles: [] };
  }

  const roles = blueprint.roles.filter((r) => roleKeys.includes(r.key));
  const needed = CAPABILITY_FOR[action];
  if (!roles.some((r) => r.capabilities.includes(needed))) {
    return {
      allowed: false,
      reason: `no role held (${roleKeys.join(', ')}) has the "${needed}" capability`,
      roles: roleKeys,
    };
  }

  // 6. Approving is not a capability alone. The pending request names its
  //    approvers, and holding the capability does not put you on that list —
  //    otherwise any approver in the workspace could decide any record.
  if (action === 'approve' && args.namedApprovers) {
    const addresses = new Set(args.namedApprovers);
    const isNamed =
      addresses.has(actor.email) || roleKeys.some((key) => addresses.has(`role:${key}`));
    if (!isNamed) {
      return {
        allowed: false,
        reason: 'actor is not named as an approver on this request',
        roles: roleKeys,
      };
    }
  }

  return { allowed: true, reason: `via ${roleKeys.join(', ')}`, roles: roleKeys };
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
export function redact(blueprint: Blueprint, roleKeys: string[], data: Answers): Answers {
  if (!roleKeys.length) return data;

  const roles = blueprint.roles.filter((r) => roleKeys.includes(r.key));
  if (!roles.length) return data;

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

export function rejectUneditable(
  blueprint: Blueprint,
  roleKeys: string[],
  patch: Answers,
): string[] {
  const allowed = editableFields(blueprint, roleKeys);
  return Object.keys(patch).filter((key) => !allowed.has(key));
}
