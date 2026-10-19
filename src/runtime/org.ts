/**
 * The organisation directory: legal entities, units, and who reports to whom.
 *
 * PRD Module 1, ORG-02 and the journey in 4.3. This is what lets a process
 * say "the submitter's manager" and mean a line an administrator set, dated,
 * rather than an address the respondent typed into a form.
 *
 * Two rules the tables cannot enforce on their own are enforced here, under
 * the tenant's row lock so two administrators cannot race past them:
 *   - no cycles, in unit parents or in management chains
 *   - one open primary reporting line per person; a new one closes the old
 */
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';

export interface LegalEntityRow { id: string; name: string; code: string | null; created_at: Date }
export interface OrgUnitRow {
  id: string; name: string; parent_id: string | null; legal_entity_id: string | null;
  head_actor_id: string | null; members: number; created_at: Date;
}
export interface ReportingLineRow {
  id: string; actor_id: string; manager_id: string; manager_email: string; manager_name: string;
  kind: 'primary' | 'dotted'; effective_from: Date; effective_to: Date | null;
}

const UUID = /^[0-9a-f-]{36}$/;

function cleanName(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 120) {
    throw new InvalidInput(`${what} needs a name of 1 to 120 characters`);
  }
  return raw.trim();
}

function optionalId(raw: unknown, what: string): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !UUID.test(raw)) throw new InvalidInput(`${what} must be an id`);
  return raw;
}

async function administrator(pool: Pool, principal: Principal): Promise<{ tenantId: string; actorId: string }> {
  await requireWorkspaceCapability(pool, principal, 'administer', 'organisation');
  if (principal.kind !== 'actor') throw new Error('unreachable');
  return { tenantId: principal.tenantId, actorId: principal.actorId };
}

/** Serialises every structural change to one tenant's directory. */
async function lockTenant(client: Client, tenantId: string): Promise<void> {
  await client.query('select id from tenant where id = $1 for update', [tenantId]);
}

// ------------------------------------------------------------- reading

export async function orgChart(pool: Pool, principal: Principal) {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  const tenantId = principal.tenantId;
  const { rows: me } = await pool.query<{ workspace_role: string }>('select workspace_role from actor where id = $1', [principal.actorId]);
  if (me[0]?.workspace_role === 'pre_hire') throw new InvalidInput('your access to the workspace starts on your first day');
  const [entities, units, lines] = await Promise.all([
    pool.query<LegalEntityRow>(
      'select id, name, code, created_at from legal_entity where tenant_id = $1 order by name', [tenantId]),
    pool.query<OrgUnitRow>(
      `select u.id, u.name, u.parent_id, u.legal_entity_id, u.head_actor_id, u.created_at,
              (select count(*)::int from actor a where a.org_unit_id = u.id and a.active) as members
         from org_unit u where u.tenant_id = $1 order by u.name`, [tenantId]),
    pool.query<{ actor_id: string; manager_id: string; manager_email: string; manager_name: string }>(
      `select r.actor_id, r.manager_id, m.email as manager_email, m.display_name as manager_name
         from reporting_line r join actor m on m.id = r.manager_id
        where r.tenant_id = $1 and r.kind = 'primary' and r.effective_to is null`, [tenantId]),
  ]);
  const { rows: people } = await pool.query<{
    id: string; email: string; display_name: string; active: boolean;
    org_unit_id: string | null; legal_entity_id: string | null; position_title: string | null;
  }>(
    `select id, email, display_name, active, org_unit_id, legal_entity_id, position_title
       from actor where tenant_id = $1 order by active desc, display_name`, [tenantId]);
  const managerOf = new Map(lines.rows.map((l) => [l.actor_id, l]));
  return {
    entities: entities.rows,
    units: units.rows,
    people: people.map((p) => {
      const line = managerOf.get(p.id);
      return { ...p, manager: line ? { id: line.manager_id, email: line.manager_email, name: line.manager_name } : null };
    }),
  };
}

export async function reportingHistory(pool: Pool, principal: Principal, actorId: string): Promise<ReportingLineRow[]> {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  const { rows } = await pool.query<ReportingLineRow>(
    `select r.id, r.actor_id, r.manager_id, m.email as manager_email, m.display_name as manager_name,
            r.kind, r.effective_from, r.effective_to
       from reporting_line r join actor m on m.id = r.manager_id
      where r.tenant_id = $1 and r.actor_id = $2
      order by (r.effective_to is null) desc, r.effective_from desc, r.created_at desc`,
    [principal.tenantId, actorId]);
  return rows;
}

/**
 * The primary manager of a member at a moment in time, or null. Used by the
 * engine to route; `at` is the record's clock, so a replayed action resolves
 * the same manager it did the first time.
 */
export async function managerOf(
  client: Client | Pool,
  args: { tenantId: string; actorId: string; at: Date },
): Promise<{ id: string; email: string } | null> {
  const { rows } = await client.query<{ id: string; email: string }>(
    `select m.id, m.email
       from reporting_line r join actor m on m.id = r.manager_id
      where r.tenant_id = $1 and r.actor_id = $2 and r.kind = 'primary'
        and r.effective_from <= $3 and (r.effective_to is null or r.effective_to > $3)
        and m.active
      order by r.effective_from desc limit 1`,
    [args.tenantId, args.actorId, args.at]);
  return rows[0] ?? null;
}

// ------------------------------------------------------------- entities

export async function createLegalEntity(pool: Pool, principal: Principal, body: { name?: unknown; code?: unknown }) {
  const { tenantId } = await administrator(pool, principal);
  const name = cleanName(body.name, 'A legal entity');
  const code = body.code === undefined || body.code === null || body.code === '' ? null : String(body.code).trim().slice(0, 40);
  const { rows } = await pool.query<LegalEntityRow>(
    `insert into legal_entity (tenant_id, name, code) values ($1, $2, $3)
     on conflict (tenant_id, name) do update set code = excluded.code
     returning id, name, code, created_at`,
    [tenantId, name, code]);
  return rows[0]!;
}

// ---------------------------------------------------------------- units

async function unitInTenant(client: Client, tenantId: string, unitId: string): Promise<{ id: string; parent_id: string | null }> {
  const { rows } = await client.query<{ id: string; parent_id: string | null }>(
    'select id, parent_id from org_unit where id = $1 and tenant_id = $2', [unitId, tenantId]);
  if (!rows[0]) throw new InvalidInput('no such unit');
  return rows[0];
}

/** Walks up from `startId`; true if `target` is an ancestor (or the start itself). */
async function unitChainReaches(client: Client, tenantId: string, startId: string, target: string): Promise<boolean> {
  let current: string | null = startId;
  const seen = new Set<string>();
  while (current) {
    if (current === target) return true;
    if (seen.has(current)) return true; // already a cycle; never extend it
    seen.add(current);
    const step: { rows: { parent_id: string | null }[] } = await client.query<{ parent_id: string | null }>(
      'select parent_id from org_unit where id = $1 and tenant_id = $2', [current, tenantId]);
    current = step.rows[0]?.parent_id ?? null;
  }
  return false;
}

export async function createOrgUnit(pool: Pool, principal: Principal, body: {
  name?: unknown; parentId?: unknown; legalEntityId?: unknown; headActorId?: unknown;
}) {
  const { tenantId } = await administrator(pool, principal);
  const name = cleanName(body.name, 'A unit');
  const parentId = optionalId(body.parentId, 'parentId');
  const legalEntityId = optionalId(body.legalEntityId, 'legalEntityId');
  const headActorId = optionalId(body.headActorId, 'headActorId');
  return inTransaction(pool, async (client) => {
    await lockTenant(client, tenantId);
    if (parentId) await unitInTenant(client, tenantId, parentId);
    if (legalEntityId) await entityInTenant(client, tenantId, legalEntityId);
    if (headActorId) await memberInTenant(client, tenantId, headActorId);
    const { rows } = await client.query<OrgUnitRow>(
      `insert into org_unit (tenant_id, name, parent_id, legal_entity_id, head_actor_id)
       values ($1, $2, $3, $4, $5)
       returning id, name, parent_id, legal_entity_id, head_actor_id, created_at, 0 as members`,
      [tenantId, name, parentId, legalEntityId, headActorId]);
    return rows[0]!;
  }).catch((err: unknown) => {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
      throw new InvalidInput(`there is already a unit called "${name}" there`);
    }
    throw err;
  });
}

export async function updateOrgUnit(pool: Pool, principal: Principal, unitId: string, body: {
  name?: unknown; parentId?: unknown; legalEntityId?: unknown; headActorId?: unknown;
}) {
  const { tenantId } = await administrator(pool, principal);
  return inTransaction(pool, async (client) => {
    await lockTenant(client, tenantId);
    const unit = await unitInTenant(client, tenantId, unitId);
    const sets: string[] = [];
    const params: unknown[] = [unitId, tenantId];
    if (body.name !== undefined) { params.push(cleanName(body.name, 'A unit')); sets.push(`name = $${params.length}`); }
    if (body.parentId !== undefined) {
      const parentId = optionalId(body.parentId, 'parentId');
      if (parentId) {
        await unitInTenant(client, tenantId, parentId);
        // ORG-02: a unit may not be inside itself, however many levels down.
        if (await unitChainReaches(client, tenantId, parentId, unit.id)) {
          throw new InvalidInput('that would put the unit inside itself');
        }
      }
      params.push(parentId); sets.push(`parent_id = $${params.length}`);
    }
    if (body.legalEntityId !== undefined) {
      const id = optionalId(body.legalEntityId, 'legalEntityId');
      if (id) await entityInTenant(client, tenantId, id);
      params.push(id); sets.push(`legal_entity_id = $${params.length}`);
    }
    if (body.headActorId !== undefined) {
      const id = optionalId(body.headActorId, 'headActorId');
      if (id) await memberInTenant(client, tenantId, id);
      params.push(id); sets.push(`head_actor_id = $${params.length}`);
    }
    if (!sets.length) throw new InvalidInput('nothing to change');
    const { rows } = await client.query<OrgUnitRow>(
      `update org_unit set ${sets.join(', ')} where id = $1 and tenant_id = $2
       returning id, name, parent_id, legal_entity_id, head_actor_id, created_at,
                 (select count(*)::int from actor a where a.org_unit_id = org_unit.id and a.active) as members`,
      params);
    return rows[0]!;
  });
}

async function entityInTenant(client: Client, tenantId: string, id: string): Promise<void> {
  const { rows } = await client.query('select id from legal_entity where id = $1 and tenant_id = $2', [id, tenantId]);
  if (!rows[0]) throw new InvalidInput('no such legal entity');
}

async function memberInTenant(client: Client, tenantId: string, id: string): Promise<{ id: string; active: boolean }> {
  const { rows } = await client.query<{ id: string; active: boolean }>(
    'select id, active from actor where id = $1 and tenant_id = $2', [id, tenantId]);
  if (!rows[0]) throw new InvalidInput('no such member');
  return rows[0];
}

// --------------------------------------------------------------- people

/** Where a person sits: unit, entity and title. Null clears. */
export async function setMemberPlacement(pool: Pool, principal: Principal, actorId: string, body: {
  unitId?: unknown; legalEntityId?: unknown; positionTitle?: unknown;
}) {
  const { tenantId } = await administrator(pool, principal);
  return inTransaction(pool, async (client) => {
    await lockTenant(client, tenantId);
    await memberInTenant(client, tenantId, actorId);
    const sets: string[] = [];
    const params: unknown[] = [actorId, tenantId];
    if (body.unitId !== undefined) {
      const id = optionalId(body.unitId, 'unitId');
      if (id) await unitInTenant(client, tenantId, id);
      params.push(id); sets.push(`org_unit_id = $${params.length}`);
    }
    if (body.legalEntityId !== undefined) {
      const id = optionalId(body.legalEntityId, 'legalEntityId');
      if (id) await entityInTenant(client, tenantId, id);
      params.push(id); sets.push(`legal_entity_id = $${params.length}`);
    }
    if (body.positionTitle !== undefined) {
      const title = body.positionTitle === null || body.positionTitle === '' ? null : String(body.positionTitle).trim().slice(0, 120);
      params.push(title); sets.push(`position_title = $${params.length}`);
    }
    if (!sets.length) throw new InvalidInput('nothing to change');
    const { rows } = await client.query(
      `update actor set ${sets.join(', ')} where id = $1 and tenant_id = $2
       returning id, org_unit_id, legal_entity_id, position_title`, params);
    return rows[0]!;
  });
}

/**
 * Sets, replaces or removes a person's primary manager, effective now or at a
 * date. The previous line is closed, never deleted, so history can say who
 * approved as whose manager. A management chain may not loop back.
 */
export async function setManager(pool: Pool, principal: Principal, actorId: string, body: {
  managerId?: unknown; effectiveFrom?: unknown;
}) {
  const { tenantId, actorId: by } = await administrator(pool, principal);
  const managerId = optionalId(body.managerId, 'managerId');
  const effectiveFrom = body.effectiveFrom ? new Date(String(body.effectiveFrom)) : new Date();
  if (Number.isNaN(effectiveFrom.getTime())) throw new InvalidInput('effectiveFrom must be a date');
  if (managerId === actorId) throw new InvalidInput('nobody can be their own manager');

  return inTransaction(pool, async (client) => {
    await lockTenant(client, tenantId);
    await memberInTenant(client, tenantId, actorId);
    if (managerId) {
      const manager = await memberInTenant(client, tenantId, managerId);
      if (!manager.active) throw new InvalidInput('that person is deactivated and cannot manage anyone');
      // Walk up from the proposed manager along open primary lines. Reaching
      // the person being placed would close a loop.
      let current: string | null = managerId;
      const seen = new Set<string>();
      while (current) {
        if (current === actorId) throw new InvalidInput('that would make a reporting loop');
        if (seen.has(current)) break;
        seen.add(current);
        const step: { rows: { manager_id: string }[] } = await client.query<{ manager_id: string }>(
          `select manager_id from reporting_line
            where tenant_id = $1 and actor_id = $2 and kind = 'primary' and effective_to is null`,
          [tenantId, current]);
        current = step.rows[0]?.manager_id ?? null;
      }
    }
    const { rows: open } = await client.query<{ id: string; manager_id: string; effective_from: Date }>(
      `select id, manager_id, effective_from from reporting_line
        where tenant_id = $1 and actor_id = $2 and kind = 'primary' and effective_to is null`,
      [tenantId, actorId]);
    const previous = open[0] ?? null;
    if (previous && previous.manager_id === managerId) {
      return { actorId, managerId, changed: false };
    }
    if (previous) {
      // A line cannot end before it began; a back-dated replacement closes
      // the old one at its own start.
      const closeAt = effectiveFrom > previous.effective_from ? effectiveFrom : previous.effective_from;
      await client.query('update reporting_line set effective_to = $2 where id = $1', [previous.id, closeAt]);
    }
    if (managerId) {
      await client.query(
        `insert into reporting_line (tenant_id, actor_id, manager_id, kind, effective_from, created_by)
         values ($1, $2, $3, 'primary', $4, $5)`,
        [tenantId, actorId, managerId, effectiveFrom, by]);
    }
    await recordWorkspaceAudit(client, {
      tenantId, actorId: by, action: 'member.manager_changed', targetId: actorId,
      detail: { from: previous?.manager_id ?? null, to: managerId, effectiveFrom },
    });
    return { actorId, managerId, changed: true, previousManagerId: previous?.manager_id ?? null };
  });
}
