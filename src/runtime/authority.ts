/**
 * Approval authority: grants, delegations, and the one question the engine
 * asks — "may this person approve this amount, here, now?"
 *
 * PRD Module 1, ORG-05 to ORG-07. Holding a role with `approve` says somebody
 * can take part in approvals; a grant says up to how much. An approval that
 * declares an amount field refuses anybody whose grant does not cover it,
 * and the engine escalates at routing time when nobody named could.
 *
 * Delegations let one person act for another for a while. The delegate is
 * named on whatever the holder is named on, with the holder's limit or a
 * lower cap — never more. Delegations do not chain.
 */
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { delegatorsOf, requireWorkspaceCapability, type Principal } from './policy.js';
export { delegatorsOf };
import { currentRequestId, logIfEnabled } from './trace.js';

const UUID = /^[0-9a-f-]{36}$/;

export interface GrantRow {
  id: string; actor_id: string; actor_email: string; actor_name: string; decision_type: string;
  amount_limit: string | null; currency: string; legal_entity_id: string | null;
  valid_from: Date; valid_to: Date | null; granted_by: string | null; created_at: Date; revoked_at: Date | null;
}
export interface DelegationRow {
  id: string; from_actor_id: string; from_email: string; from_name: string;
  to_actor_id: string; to_email: string; to_name: string; scope: string;
  amount_limit: string | null; valid_from: Date; valid_to: Date | null; reason: string | null;
  created_at: Date; revoked_at: Date | null;
}

/** What somebody may approve: `limit` null means unlimited; `none` means no grant at all. */
export interface Authority {
  none: boolean;
  limit: number | null;
  currency: string | null;
  /** How it was arrived at, for the record and the refusal. */
  via: { kind: 'own'; grantId: string } | { kind: 'delegated'; from: string; fromEmail: string; delegationId: string } | null;
}

// ----------------------------------------------------------------- audit

/**
 * One row per administrative change to people and authority, append-only.
 * Written inside the caller's transaction so a change and its audit row
 * commit or roll back together.
 */
export async function recordWorkspaceAudit(
  client: Client | Pool,
  args: { tenantId: string; actorId: string | null; action: string; targetId?: string | null; detail?: unknown },
): Promise<void> {
  await client.query(
    `insert into workspace_admin_audit (tenant_id, actor_id, action, target_id, detail, request_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [args.tenantId, args.actorId, args.action, args.targetId ?? null, JSON.stringify(args.detail ?? {}), currentRequestId()],
  );
}

export async function workspaceAudit(pool: Pool, principal: Principal, limit = 200) {
  await requireWorkspaceCapability(pool, principal, 'administer', 'audit');
  if (principal.kind !== 'actor') throw new Error('unreachable');
  const { rows } = await pool.query(
    `select w.id, w.action, w.target_id, w.detail, w.request_id, w.occurred_at,
            a.email as actor_email, a.display_name as actor_name
       from workspace_admin_audit w left join actor a on a.id = w.actor_id
      where w.tenant_id = $1 order by w.id desc limit $2`,
    [principal.tenantId, Math.min(Math.max(1, limit), 1000)],
  );
  return rows;
}

// ---------------------------------------------------------------- reading

function money(raw: string | null): number | null {
  return raw === null ? null : Number(raw);
}

async function ownGrants(client: Client | Pool, args: {
  tenantId: string; actorId: string; decisionType: string; legalEntityId: string | null; at: Date;
}): Promise<{ id: string; amount_limit: string | null; currency: string }[]> {
  const { rows } = await client.query<{ id: string; amount_limit: string | null; currency: string }>(
    `select id, amount_limit, currency from authority_grant
      where tenant_id = $1 and actor_id = $2 and revoked_at is null
        and decision_type in ('*', $3)
        and (legal_entity_id is null or legal_entity_id = $4)
        and valid_from <= $5 and (valid_to is null or valid_to > $5)
      order by amount_limit is null desc, amount_limit desc`,
    [args.tenantId, args.actorId, args.decisionType, args.legalEntityId, args.at],
  );
  return rows;
}

/**
 * The widest authority a person holds for one decision, counting their own
 * grants and anything delegated to them by somebody with a grant.
 *
 * `legalEntityId` is the entity the record belongs to (its submitter's), so
 * an entity-scoped grant in Entity A does not approve Entity B's spend.
 * `actingFor` narrows delegated authority to named holders, which is what
 * the engine wants: a delegate may only step in for someone the request
 * actually names.
 */
export async function authorityOf(client: Client | Pool, args: {
  tenantId: string; actorId: string; decisionType: string; legalEntityId: string | null; at: Date;
  actingFor?: string[];
}): Promise<Authority> {
  const own = await ownGrants(client, args);
  let best: Authority = { none: true, limit: 0, currency: null, via: null };
  const consider = (candidate: Authority) => {
    if (best.none) { best = candidate; return; }
    if (candidate.limit === null && best.limit !== null) best = candidate;
    else if (candidate.limit !== null && best.limit !== null && candidate.limit > best.limit) best = candidate;
  };
  if (own[0]) consider({ none: false, limit: money(own[0].amount_limit), currency: own[0].currency, via: { kind: 'own', grantId: own[0].id } });

  const { rows: delegations } = await client.query<{
    id: string; from_actor_id: string; from_email: string; amount_limit: string | null;
  }>(
    `select d.id, d.from_actor_id, f.email as from_email, d.amount_limit
       from delegation d join actor f on f.id = d.from_actor_id
      where d.tenant_id = $1 and d.to_actor_id = $2 and d.revoked_at is null and f.active
        and d.scope in ('*', $3)
        and d.valid_from <= $4 and (d.valid_to is null or d.valid_to > $4)`,
    [args.tenantId, args.actorId, args.decisionType, args.at],
  );
  for (const d of delegations) {
    if (args.actingFor && !args.actingFor.some((email) => email.toLowerCase() === d.from_email.toLowerCase())) continue;
    const holder = await ownGrants(client, { ...args, actorId: d.from_actor_id });
    if (!holder[0]) continue; // the holder has nothing to delegate
    const holderLimit = money(holder[0].amount_limit);
    const cap = money(d.amount_limit);
    // ORG-06: never above the holder's own limit; a cap on the delegation lowers it further.
    const limit = holderLimit === null ? cap : cap === null ? holderLimit : Math.min(holderLimit, cap);
    consider({ none: false, limit, currency: holder[0].currency, via: { kind: 'delegated', from: d.from_actor_id, fromEmail: d.from_email, delegationId: d.id } });
  }
  return best;
}

/** True when `authority` covers `amount`. No grant covers nothing, not even zero. */
export function covers(authority: Authority, amount: number): boolean {
  if (authority.none) return false;
  return authority.limit === null || amount <= authority.limit;
}

export async function listAuthority(pool: Pool, principal: Principal) {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  const [grants, delegations] = await Promise.all([
    pool.query<GrantRow>(
      `select g.id, g.actor_id, a.email as actor_email, a.display_name as actor_name, g.decision_type,
              g.amount_limit, g.currency, g.legal_entity_id, g.valid_from, g.valid_to, g.granted_by,
              g.created_at, g.revoked_at
         from authority_grant g join actor a on a.id = g.actor_id
        where g.tenant_id = $1 order by g.revoked_at is not null, a.display_name, g.created_at desc`,
      [principal.tenantId]),
    pool.query<DelegationRow>(
      `select d.id, d.from_actor_id, f.email as from_email, f.display_name as from_name,
              d.to_actor_id, t.email as to_email, t.display_name as to_name, d.scope, d.amount_limit,
              d.valid_from, d.valid_to, d.reason, d.created_at, d.revoked_at
         from delegation d join actor f on f.id = d.from_actor_id join actor t on t.id = d.to_actor_id
        where d.tenant_id = $1 order by d.revoked_at is not null, d.created_at desc`,
      [principal.tenantId]),
  ]);
  return { grants: grants.rows, delegations: delegations.rows };
}

// ---------------------------------------------------------------- writing

function parseAmount(raw: unknown, what: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[, ]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1e15) throw new InvalidInput(`${what} must be a positive amount, or empty for no limit`);
  return Math.round(n * 100) / 100;
}

function parseDate(raw: unknown, what: string, fallback: Date | null): Date | null {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) throw new InvalidInput(`${what} must be a date`);
  return d;
}

function parseScope(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '' || raw === '*') return '*';
  if (typeof raw !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(raw)) throw new InvalidInput('scope must be a process key or *');
  return raw;
}

async function administrator(pool: Pool, principal: Principal, resource: string) {
  await requireWorkspaceCapability(pool, principal, 'administer', resource);
  if (principal.kind !== 'actor') throw new Error('unreachable');
  return { tenantId: principal.tenantId, by: principal.actorId };
}

async function memberInTenant(client: Client, tenantId: string, id: unknown, what: string) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new InvalidInput(`${what} must be a member id`);
  const { rows } = await client.query<{ id: string; email: string; active: boolean }>(
    'select id, email, active from actor where id = $1 and tenant_id = $2', [id, tenantId]);
  if (!rows[0]) throw new InvalidInput(`${what}: no such member`);
  return rows[0];
}

/**
 * ORG-05. ORG-07's second pair of eyes: an administrator may not grant
 * authority to themselves. (A full two-admin approval of every privilege
 * change is a process of its own, which Patform can run; this is the floor.)
 */
export async function createGrant(pool: Pool, principal: Principal, body: {
  actorId?: unknown; decisionType?: unknown; amountLimit?: unknown; currency?: unknown;
  legalEntityId?: unknown; validFrom?: unknown; validTo?: unknown;
}) {
  const { tenantId, by } = await administrator(pool, principal, 'authority');
  const decisionType = parseScope(body.decisionType);
  const amountLimit = parseAmount(body.amountLimit, 'amountLimit');
  const currency = body.currency ? String(body.currency).trim().toUpperCase().slice(0, 3) : 'GBP';
  if (!/^[A-Z]{3}$/.test(currency)) throw new InvalidInput('currency must be a three-letter code');
  const validFrom = parseDate(body.validFrom, 'validFrom', new Date())!;
  const validTo = parseDate(body.validTo, 'validTo', null);
  if (validTo && validTo <= validFrom) throw new InvalidInput('validTo must be after validFrom');
  return inTransaction(pool, async (client) => {
    const target = await memberInTenant(client, tenantId, body.actorId, 'actorId');
    if (target.id === by) throw new InvalidInput('you cannot grant approval authority to yourself — ask another administrator');
    if (!target.active) throw new InvalidInput('that person is deactivated');
    let legalEntityId: string | null = null;
    if (body.legalEntityId) {
      if (typeof body.legalEntityId !== 'string' || !UUID.test(body.legalEntityId)) throw new InvalidInput('legalEntityId must be an id');
      const { rows } = await client.query('select id from legal_entity where id = $1 and tenant_id = $2', [body.legalEntityId, tenantId]);
      if (!rows[0]) throw new InvalidInput('no such legal entity');
      legalEntityId = body.legalEntityId;
    }
    const { rows } = await client.query<{ id: string }>(
      `insert into authority_grant (tenant_id, actor_id, decision_type, amount_limit, currency, legal_entity_id, valid_from, valid_to, granted_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [tenantId, target.id, decisionType, amountLimit, currency, legalEntityId, validFrom, validTo, by]);
    await recordWorkspaceAudit(client, {
      tenantId, actorId: by, action: 'authority.granted', targetId: target.id,
      detail: { grantId: rows[0]!.id, email: target.email, decisionType, amountLimit, currency, legalEntityId, validFrom, validTo },
    });
    logIfEnabled('info', 'authority.granted', { tenantId, by, target: target.id, amountLimit, decisionType });
    return { id: rows[0]!.id, actorId: target.id, decisionType, amountLimit, currency, legalEntityId, validFrom, validTo };
  });
}

export async function revokeGrant(pool: Pool, principal: Principal, grantId: string, reason?: unknown) {
  const { tenantId, by } = await administrator(pool, principal, 'authority');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; actor_id: string }>(
      `update authority_grant set revoked_at = now(), revoked_by = $3
        where id = $1 and tenant_id = $2 and revoked_at is null returning id, actor_id`,
      [grantId, tenantId, by]);
    if (!rows[0]) return { changed: false };
    await recordWorkspaceAudit(client, {
      tenantId, actorId: by, action: 'authority.revoked', targetId: rows[0].actor_id,
      detail: { grantId, reason: typeof reason === 'string' ? reason.slice(0, 500) : null },
    });
    return { changed: true };
  });
}

/** ORG-06. The holder, or an administrator, may delegate; never past the holder's own limit. */
export async function createDelegation(pool: Pool, principal: Principal, body: {
  fromActorId?: unknown; toActorId?: unknown; scope?: unknown; amountLimit?: unknown;
  validFrom?: unknown; validTo?: unknown; reason?: unknown;
}) {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  const tenantId = principal.tenantId;
  const fromId = body.fromActorId ?? principal.actorId;
  const self = fromId === principal.actorId;
  if (!self) await requireWorkspaceCapability(pool, principal, 'administer', 'authority');
  const scope = parseScope(body.scope);
  const amountLimit = parseAmount(body.amountLimit, 'amountLimit');
  const validFrom = parseDate(body.validFrom, 'validFrom', new Date())!;
  const validTo = parseDate(body.validTo, 'validTo', null);
  if (validTo && validTo <= validFrom) throw new InvalidInput('validTo must be after validFrom');
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) || null : null;
  return inTransaction(pool, async (client) => {
    const from = await memberInTenant(client, tenantId, fromId, 'fromActorId');
    const to = await memberInTenant(client, tenantId, body.toActorId, 'toActorId');
    if (from.id === to.id) throw new InvalidInput('nobody can delegate to themselves');
    if (!to.active) throw new InvalidInput('that person is deactivated');
    const { rows } = await client.query<{ id: string }>(
      `insert into delegation (tenant_id, from_actor_id, to_actor_id, scope, amount_limit, valid_from, valid_to, reason, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [tenantId, from.id, to.id, scope, amountLimit, validFrom, validTo, reason, principal.actorId]);
    await recordWorkspaceAudit(client, {
      tenantId, actorId: principal.actorId, action: 'delegation.created', targetId: from.id,
      detail: { delegationId: rows[0]!.id, from: from.email, to: to.email, scope, amountLimit, validFrom, validTo, reason },
    });
    return { id: rows[0]!.id, fromActorId: from.id, toActorId: to.id, scope, amountLimit, validFrom, validTo };
  });
}

export async function revokeDelegation(pool: Pool, principal: Principal, delegationId: string) {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  const tenantId = principal.tenantId;
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; from_actor_id: string }>(
      'select id, from_actor_id from delegation where id = $1 and tenant_id = $2 and revoked_at is null for update',
      [delegationId, tenantId]);
    if (!rows[0]) return { changed: false };
    if (rows[0].from_actor_id !== principal.actorId) {
      await requireWorkspaceCapability(pool, principal, 'administer', 'authority');
    }
    await client.query('update delegation set revoked_at = now(), revoked_by = $2 where id = $1', [delegationId, principal.actorId]);
    await recordWorkspaceAudit(client, {
      tenantId, actorId: principal.actorId, action: 'delegation.revoked', targetId: rows[0].from_actor_id,
      detail: { delegationId },
    });
    return { changed: true };
  });
}
