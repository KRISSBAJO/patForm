/**
 * Structure and offices: the tiers of an organisation (for a church:
 * National, District, Zone, Area, Station), the offices at each tier, and
 * who holds them when.
 *
 * Four things are kept apart, because mixing them is what breaks at scale:
 *   - a jurisdiction (Area 07) and the station that hosts its office
 *   - an office (Area Pastor) and the person holding it
 *   - the permissions an office carries and its title
 *   - the approval authority (a mandate) and the permission to administer
 *
 * One person may hold many offices at once: an Area Pastor is usually also
 * the Resident Pastor of the station that hosts the Area. Each holding has
 * its own unit, dates and mandate.
 *
 * Permissions reach down the tree: an Area Admin may do what the office
 * allows in the Area and every station under it, and nowhere else. A
 * workspace owner or admin may do everything.
 */
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import type { Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { seedChurchRequestTypes } from './general-approvals.js';

export const PERMISSIONS = ['people', 'appointments', 'structure', 'reports'] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const OFFICE_KINDS = ['overseer', 'assistant', 'admin', 'secretary', 'unit_head', 'officer'] as const;

const UUID = /^[0-9a-f-]{36}$/;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const keyOf = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
const day = (v: unknown, what: string): string | null => {
  const s = text(v, 10);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new InvalidInput(`${what} must be a date`);
  return s;
};
const today = () => new Date().toISOString().slice(0, 10);

export interface Level { id: string; key: string; name: string; rank: number; is_station: boolean }
export interface OfficeType { id: string; key: string; name: string; level_id: string | null; kind: (typeof OFFICE_KINDS)[number]; single: boolean; permissions: string[]; active: boolean; sort: number }
export interface Unit { id: string; name: string; parent_id: string | null; level_id: string | null; host_station_id: string | null; country: string | null; code: string | null; active: boolean }

// ------------------------------------------------------------- the tree

export async function loadUnits(client: Client | Pool, tenantId: string): Promise<Map<string, Unit>> {
  const { rows } = await client.query<Unit>('select id, name, parent_id, level_id, host_station_id, country, code, active from org_unit where tenant_id = $1', [tenantId]);
  return new Map(rows.map((u) => [u.id, u]));
}
/** The unit and every unit above it, nearest first. */
export function chainOf(units: Map<string, Unit>, id: string | null): Unit[] {
  const out: Unit[] = []; const seen = new Set<string>();
  let at = id ? units.get(id) : undefined;
  while (at && !seen.has(at.id)) { out.push(at); seen.add(at.id); at = at.parent_id ? units.get(at.parent_id) : undefined; }
  return out;
}
async function levels(client: Client | Pool, tenantId: string): Promise<Map<string, Level>> {
  const { rows } = await client.query<Level>('select id, key, name, rank, is_station from org_level where tenant_id = $1 order by rank', [tenantId]);
  return new Map(rows.map((l) => [l.id, l]));
}
const isStation = (lv: Map<string, Level>, u: Unit | undefined) => !!u?.level_id && !!lv.get(u.level_id)?.is_station;

// ------------------------------------------------------------- who may

interface Ctx { tenantId: string; actorId: string; email: string; workspaceAdmin: boolean; scopes: { unitId: string; perms: Set<string> }[]; units: Map<string, Unit> }

async function context(client: Client | Pool, principal: Principal): Promise<Ctx> {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  const { rows } = await client.query<{ email: string; workspace_role: string; active: boolean }>('select email, workspace_role, active from actor where id = $1 and tenant_id = $2', [principal.actorId, principal.tenantId]);
  const me = rows[0];
  if (!me?.active) throw new InvalidInput('signed-in members only');
  if (['pre_hire', 'auditor'].includes(me.workspace_role)) throw new InvalidInput('your access does not include the structure');
  const { rows: held } = await client.query<{ unit_id: string; permissions: string[] }>(
    `select h.unit_id, t.permissions from office_holder h join office_type t on t.id = h.office_type_id
      where h.tenant_id = $1 and h.actor_id = $2 and h.starts_on <= current_date and (h.ends_on is null or h.ends_on > current_date) and t.active`, [principal.tenantId, principal.actorId]);
  return {
    tenantId: principal.tenantId, actorId: principal.actorId, email: me.email,
    workspaceAdmin: ['owner', 'admin'].includes(me.workspace_role),
    scopes: held.filter((h) => h.permissions.length).map((h) => ({ unitId: h.unit_id, perms: new Set(h.permissions) })),
    units: await loadUnits(client, principal.tenantId),
  };
}
function can(c: Ctx, perm: Permission, unitId: string | null): boolean {
  if (c.workspaceAdmin) return true;
  if (!unitId) return false;
  const up = new Set(chainOf(c.units, unitId).map((u) => u.id));
  return c.scopes.some((s) => s.perms.has(perm) && up.has(s.unitId));
}
function must(c: Ctx, perm: Permission, unitId: string | null, what: string) {
  if (!can(c, perm, unitId)) throw new InvalidInput(`you do not hold an office that allows ${what} here`);
}
function mustAdmin(c: Ctx) { if (!c.workspaceAdmin) throw new InvalidInput('only a workspace owner or admin can change the structure settings'); }

// --------------------------------------------------------------- reading

/** The whole tree with what each unit lacks, the settings, and what the caller may do. */
export async function readStructure(pool: Pool, principal: Principal) {
  const c = await context(pool, principal);
  const [lv, ot, cat, un, held, bodies] = await Promise.all([
    pool.query<Level>('select id, key, name, rank, is_station from org_level where tenant_id = $1 order by rank', [c.tenantId]),
    pool.query<OfficeType>('select id, key, name, level_id, kind, single, permissions, active, sort from office_type where tenant_id = $1 order by sort, name', [c.tenantId]),
    pool.query('select id, key, name, active, sort from unit_catalog where tenant_id = $1 order by sort, name', [c.tenantId]),
    pool.query<Unit & { members: number }>(
      `select u.id, u.name, u.parent_id, u.level_id, u.host_station_id, u.country, u.code, u.active,
              (select count(*)::int from actor a where a.org_unit_id = u.id and a.active) as members
         from org_unit u where u.tenant_id = $1 order by u.name`, [c.tenantId]),
    pool.query<{ id: string; unit_id: string; office_type_id: string; department_id: string | null; actor_id: string; name: string; acting: boolean }>(
      `select h.id, h.unit_id, h.office_type_id, h.department_id, h.actor_id, a.display_name as name, h.acting from office_holder h join actor a on a.id = h.actor_id
        where h.tenant_id = $1 and h.starts_on <= current_date and (h.ends_on is null or h.ends_on > current_date)`, [c.tenantId]),
    pool.query('select id, name, org_unit_id, structure_key from mtg_body where tenant_id = $1 and active order by name', [c.tenantId]).catch(() => ({ rows: [] })),
  ]);
  const types = ot.rows.filter((t) => t.active);
  const byUnit = new Map<string, typeof held.rows>();
  for (const h of held.rows) { const l = byUnit.get(h.unit_id) ?? []; l.push(h); byUnit.set(h.unit_id, l); }
  const units = un.rows.map((u) => {
    const holders = byUnit.get(u.id) ?? [];
    const seats = types.filter((t) => t.single && t.kind !== 'unit_head' && t.level_id && t.level_id === u.level_id);
    const vacant = seats.filter((t) => !holders.some((h) => h.office_type_id === t.id)).map((t) => t.id);
    const head = types.find((t) => t.kind === 'overseer' && t.level_id === u.level_id);
    const overseer = head ? holders.find((h) => h.office_type_id === head.id) : undefined;
    return { ...u, holders: holders.length, vacant, overseer: overseer ? { name: overseer.name, acting: overseer.acting } : null };
  });
  const { rows: mine } = await pool.query(
    `select h.id, h.unit_id, u.name as unit, t.name as office, t.kind, h.acting, h.starts_on::text, h.mandate_limit, t.permissions
       from office_holder h join office_type t on t.id = h.office_type_id join org_unit u on u.id = h.unit_id
      where h.tenant_id = $1 and h.actor_id = $2 and h.starts_on <= current_date and (h.ends_on is null or h.ends_on > current_date) order by t.sort`, [c.tenantId, c.actorId]);
  return {
    levels: lv.rows, officeTypes: ot.rows, catalog: cat.rows, units, committees: bodies.rows,
    me: { workspaceAdmin: c.workspaceAdmin, scopes: c.scopes.map((s) => ({ unitId: s.unitId, permissions: [...s.perms] })), offices: mine },
    permissions: PERMISSIONS,
  };
}

/** One unit: its offices now and before, its departments, members and committees. */
export async function unitDetail(pool: Pool, principal: Principal, unitId: string) {
  const c = await context(pool, principal);
  const unit = c.units.get(unitId);
  if (!unit) throw new InvalidInput('no such unit');
  const [holders, departments, members, children, committees] = await Promise.all([
    pool.query(
      `select h.id, h.office_type_id, h.department_id, h.actor_id, a.display_name as name, a.email, h.acting, h.starts_on::text, h.ends_on::text, h.mandate_limit, h.end_reason,
              ab.display_name as appointed_by, (h.starts_on <= current_date and (h.ends_on is null or h.ends_on > current_date)) as live
         from office_holder h join actor a on a.id = h.actor_id left join actor ab on ab.id = h.appointed_by
        where h.tenant_id = $1 and h.unit_id = $2 order by live desc, h.starts_on desc limit 200`, [c.tenantId, unitId]),
    pool.query(`select d.id, d.catalog_id, c.name, c.key, d.active from station_department d join unit_catalog c on c.id = d.catalog_id where d.station_id = $1 order by c.sort, c.name`, [unitId]),
    pool.query(`select id, display_name, email, workspace_role, position_title from actor where tenant_id = $1 and org_unit_id = $2 and active order by display_name limit 500`, [c.tenantId, unitId]),
    pool.query<{ n: number }>('select count(*)::int as n from org_unit where tenant_id = $1 and parent_id = $2', [c.tenantId, unitId]),
    pool.query('select id, name, structure_key from mtg_body where tenant_id = $1 and org_unit_id = $2 and active', [c.tenantId, unitId]).catch(() => ({ rows: [] })),
  ]);
  return {
    unit, chain: chainOf(c.units, unitId).map((u) => ({ id: u.id, name: u.name, level_id: u.level_id })),
    host: unit.host_station_id ? c.units.get(unit.host_station_id) ?? null : null,
    hosts: [...c.units.values()].filter((u) => u.host_station_id === unitId).map((u) => ({ id: u.id, name: u.name, level_id: u.level_id })),
    holders: holders.rows, departments: departments.rows, members: members.rows, children: children.rows[0]!.n, committees: committees.rows,
    can: Object.fromEntries(PERMISSIONS.map((p) => [p, can(c, p, unitId)])),
  };
}

/** People to choose from when appointing: members of the workspace, searched. */
export async function searchPeople(pool: Pool, principal: Principal, q: string) {
  const c = await context(pool, principal);
  const like = `%${q.trim().slice(0, 80)}%`;
  const { rows } = await pool.query(
    `select a.id, a.display_name, a.email, u.name as unit from actor a left join org_unit u on u.id = a.org_unit_id
      where a.tenant_id = $1 and a.active and a.workspace_role not in ('pre_hire', 'auditor') and (a.display_name ilike $2 or a.email ilike $2) order by a.display_name limit 25`, [c.tenantId, like]);
  return rows;
}

// --------------------------------------------------------------- settings

export const CHURCH = {
  levels: [
    { key: 'national', name: 'National', rank: 1 }, { key: 'district', name: 'District', rank: 2 }, { key: 'zone', name: 'Zone', rank: 3 },
    { key: 'area', name: 'Area', rank: 4 }, { key: 'station', name: 'Station', rank: 5, station: true },
  ],
  offices: [
    ['national_pastor', 'National Pastor', 'national', 'overseer', true, ['appointments', 'reports']],
    ['national_admin', 'National Admin', 'national', 'admin', false, ['people', 'appointments', 'structure', 'reports']],
    ['district_pastor', 'District Pastor', 'district', 'overseer', true, ['appointments', 'reports']],
    ['district_admin', 'District Admin', 'district', 'admin', false, ['people', 'appointments', 'structure', 'reports']],
    ['zonal_pastor', 'Zonal Pastor', 'zone', 'overseer', true, ['appointments', 'reports']],
    ['zonal_admin', 'Zonal Admin', 'zone', 'admin', false, ['people', 'appointments', 'structure', 'reports']],
    ['area_pastor', 'Area Pastor', 'area', 'overseer', true, ['appointments', 'reports']],
    ['area_admin', 'Area Admin', 'area', 'admin', false, ['people', 'appointments', 'structure', 'reports']],
    ['resident_pastor', 'Resident Pastor', 'station', 'overseer', true, ['appointments', 'reports']],
    ['associate_pastor', 'Associate Pastor', 'station', 'assistant', false, []],
    ['church_admin', 'Church Administrator', 'station', 'admin', false, ['people', 'appointments', 'structure', 'reports']],
    ['cmc_secretary', 'CMC Secretary', 'station', 'secretary', true, ['reports']],
    ['unit_head', 'Unit Head', 'station', 'unit_head', false, []],
  ] as [string, string, string, OfficeType['kind'], boolean, string[]][],
  catalog: ['Choir', 'Ushering', 'Protocol', 'Children', 'Youth', 'Women', 'Men', 'Evangelism', 'Prayer', 'Media', 'Sanitation', 'Welfare', 'Sunday School', 'Follow-up', 'Technical'],
};

/** Lays down the church tiers, offices and unit catalogue in an empty workspace, and the default approval policy. */
export async function setupChurch(pool: Pool, principal: Principal, body: Record<string, unknown>, adopt: (processKey: string) => Promise<unknown>) {
  const c = await context(pool, principal); mustAdmin(c);
  const result = await inTransaction(pool, async (client) => {
    await client.query('select id from tenant where id = $1 for update', [c.tenantId]);
    const { rows: had } = await client.query('select 1 from org_level where tenant_id = $1 limit 1', [c.tenantId]);
    if (had.length) throw new InvalidInput('this workspace already has its levels; change them in the settings instead');
    const ids = new Map<string, string>();
    for (const l of CHURCH.levels) {
      const { rows } = await client.query<{ id: string }>('insert into org_level (tenant_id, key, name, rank, is_station) values ($1, $2, $3, $4, $5) returning id', [c.tenantId, l.key, l.name, l.rank, !!l.station]);
      ids.set(l.key, rows[0]!.id);
    }
    let sort = 0;
    for (const [key, name, level, kind, single, perms] of CHURCH.offices) {
      await client.query('insert into office_type (tenant_id, key, name, level_id, kind, single, permissions, sort) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (tenant_id, key) do nothing', [c.tenantId, key, name, ids.get(level), kind, single, perms, sort += 10]);
    }
    sort = 0;
    for (const name of CHURCH.catalog) await client.query('insert into unit_catalog (tenant_id, key, name, sort) values ($1, $2, $3, $4) on conflict (tenant_id, key) do nothing', [c.tenantId, keyOf(name), name, sort += 10]);
    // Everyday church requests in General Approvals, routed by office.
    const requestTypes = await seedChurchRequestTypes(client, c.tenantId, c.actorId);
    await recordWorkspaceAudit(client, { tenantId: c.tenantId, actorId: c.actorId, action: 'structure.church_setup', detail: { levels: CHURCH.levels.length, offices: CHURCH.offices.length, requestTypes } });
    return { levels: CHURCH.levels.length, offices: CHURCH.offices.length, catalog: CHURCH.catalog.length, requestTypes };
  });
  const adopted: string[] = [];
  if (body.adoptPolicy !== false) {
    // Every policy-driven process without a policy of its own gets the church line as its default.
    const { rows } = await pool.query<{ process_key: string; approvals: { policy?: boolean }[] }>(
      `select distinct on (process_key) process_key, blueprint->'workflow'->'approvals' as approvals from process_version where tenant_id = $1 order by process_key, version desc`, [c.tenantId]);
    for (const p of rows) {
      if (!(p.approvals ?? []).some((a) => a.policy)) continue;
      const { rows: has } = await pool.query('select 1 from approval_policy where tenant_id = $1 and process_key = $2 and active and branch_id is null', [c.tenantId, p.process_key]);
      if (has.length) continue;
      await adopt(p.process_key); adopted.push(p.process_key);
    }
  }
  return { ...result, adopted };
}

export async function saveLevel(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const c = await context(pool, principal); mustAdmin(c);
  const name = text(body.name, 60); if (!name) throw new InvalidInput('give the level a name');
  const rank = Math.trunc(Number(body.rank));
  if (!(rank >= 1 && rank <= 20)) throw new InvalidInput('rank is a number from 1 (top) to 20');
  const id = text(body.id, 36);
  if (id) {
    const { rows } = await pool.query('update org_level set name = $3, rank = $4 where id = $1 and tenant_id = $2 returning id', [id, c.tenantId, name, rank]);
    if (!rows[0]) throw new InvalidInput('no such level');
  } else {
    await pool.query('insert into org_level (tenant_id, key, name, rank, is_station) values ($1, $2, $3, $4, $5)', [c.tenantId, keyOf(text(body.key, 40) || name), name, rank, body.isStation === true]).catch((e) => { if (e.code === '23505') throw new InvalidInput('a level with that key exists'); throw e; });
  }
  await recordWorkspaceAudit(pool, { tenantId: c.tenantId, actorId: c.actorId, action: 'structure.level_saved', targetId: id || null, detail: { name, rank } });
  return { ok: true };
}

export async function saveOfficeType(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const c = await context(pool, principal); mustAdmin(c);
  const name = text(body.name, 80); if (!name) throw new InvalidInput('give the office a name');
  const kind = text(body.kind, 20);
  if (!(OFFICE_KINDS as readonly string[]).includes(kind)) throw new InvalidInput(`kind must be one of ${OFFICE_KINDS.join(', ')}`);
  const levelId = text(body.levelId, 36) || null;
  if (levelId && !(await levels(pool, c.tenantId)).has(levelId)) throw new InvalidInput('no such level');
  const permissions = Array.isArray(body.permissions) ? [...new Set(body.permissions.map((p) => text(p, 20)))] : [];
  for (const p of permissions) if (!(PERMISSIONS as readonly string[]).includes(p)) throw new InvalidInput(`permission must be one of ${PERMISSIONS.join(', ')}`);
  const id = text(body.id, 36);
  const params = [name, levelId, kind, body.single === true, permissions, body.active !== false, Math.trunc(Number(body.sort) || 0)];
  if (id) {
    const { rows } = await pool.query('update office_type set name = $3, level_id = $4, kind = $5, single = $6, permissions = $7, active = $8, sort = $9 where id = $1 and tenant_id = $2 returning id', [id, c.tenantId, ...params]);
    if (!rows[0]) throw new InvalidInput('no such office');
  } else {
    await pool.query('insert into office_type (tenant_id, key, name, level_id, kind, single, permissions, active, sort) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [c.tenantId, keyOf(text(body.key, 40) || name), ...params]).catch((e) => { if (e.code === '23505') throw new InvalidInput('an office with that key exists'); throw e; });
  }
  await recordWorkspaceAudit(pool, { tenantId: c.tenantId, actorId: c.actorId, action: 'structure.office_type_saved', targetId: id || null, detail: { name, kind, permissions } });
  return { ok: true };
}

export async function saveCatalogItem(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const c = await context(pool, principal); mustAdmin(c);
  const name = text(body.name, 60); if (!name) throw new InvalidInput('give the unit a name');
  const id = text(body.id, 36);
  if (id) {
    const { rows } = await pool.query('update unit_catalog set name = $3, active = $4, sort = $5 where id = $1 and tenant_id = $2 returning id', [id, c.tenantId, name, body.active !== false, Math.trunc(Number(body.sort) || 0)]);
    if (!rows[0]) throw new InvalidInput('no such catalogue unit');
  } else {
    await pool.query('insert into unit_catalog (tenant_id, key, name, sort) values ($1, $2, $3, $4)', [c.tenantId, keyOf(name), name, Math.trunc(Number(body.sort) || 0)]).catch((e) => { if (e.code === '23505') throw new InvalidInput('that unit is already in the catalogue'); throw e; });
  }
  await recordWorkspaceAudit(pool, { tenantId: c.tenantId, actorId: c.actorId, action: 'structure.catalog_saved', detail: { name } });
  return { ok: true };
}

// ------------------------------------------------------------------ units

/** Creates or changes a jurisdiction or a station. Only inside the tree the caller may shape. */
export async function saveUnit(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const c = await context(pool, principal);
  return inTransaction(pool, async (client) => {
    await client.query('select id from tenant where id = $1 for update', [c.tenantId]);
    const lv = await levels(client, c.tenantId);
    const units = await loadUnits(client, c.tenantId); c.units = units;
    const id = text(body.id, 36);
    const existing = id ? units.get(id) : undefined;
    if (id && !existing) throw new InvalidInput('no such unit');
    const name = body.name === undefined && existing ? existing.name : text(body.name, 120);
    if (!name) throw new InvalidInput('give it a name');
    const parentId = body.parentId === undefined ? existing?.parent_id ?? null : (text(body.parentId, 36) || null);
    const levelId = body.levelId === undefined ? existing?.level_id ?? null : (text(body.levelId, 36) || null);
    if (lv.size && !levelId) throw new InvalidInput('choose its level');
    const level = levelId ? lv.get(levelId) : undefined;
    if (levelId && !level) throw new InvalidInput('no such level');
    const parent = parentId ? units.get(parentId) : undefined;
    if (parentId && !parent) throw new InvalidInput('no such parent');
    if (parent) {
      if (isStation(lv, parent)) throw new InvalidInput('a station cannot have units under it');
      const pl = parent.level_id ? lv.get(parent.level_id) : undefined;
      if (pl && level && level.rank <= pl.rank) throw new InvalidInput(`a ${level.name} cannot sit under a ${pl.name}`);
      if (id && chainOf(units, parentId).some((u) => u.id === id)) throw new InvalidInput('a unit cannot sit inside itself');
    }
    if (existing) must(c, 'structure', id, 'changing this unit');
    if (!existing || parentId !== existing.parent_id) {
      if (parentId) must(c, 'structure', parentId, 'adding units'); else mustAdmin(c);
    }
    const country = body.country === undefined ? existing?.country ?? null : (text(body.country, 2).toUpperCase() || null);
    if (country && !/^[A-Z]{2}$/.test(country)) throw new InvalidInput('country is a two-letter code');
    const code = body.code === undefined ? existing?.code ?? null : (text(body.code, 20) || null);
    let host = body.hostStationId === undefined ? existing?.host_station_id ?? null : (text(body.hostStationId, 36) || null);
    if (host) {
      if (level?.is_station) host = null;
      else {
        const h = units.get(host);
        if (!h || !isStation(lv, h)) throw new InvalidInput('the host must be a station');
        if (!id || !chainOf(units, host).some((u) => u.id === id)) throw new InvalidInput('the host station must be inside this jurisdiction');
      }
    }
    const active = body.active === undefined ? existing?.active ?? true : body.active !== false;
    let unitId = id;
    try {
      if (existing) {
        await client.query('update org_unit set name = $3, parent_id = $4, level_id = $5, country = $6, code = $7, host_station_id = $8, active = $9 where id = $1 and tenant_id = $2', [id, c.tenantId, name, parentId, levelId, country, code, host, active]);
      } else {
        const { rows } = await client.query<{ id: string }>('insert into org_unit (tenant_id, name, parent_id, level_id, country, code, active) values ($1, $2, $3, $4, $5, $6, $7) returning id', [c.tenantId, name, parentId, levelId, country, code, active]);
        unitId = rows[0]!.id;
      }
    } catch (e) { if ((e as { code?: string }).code === '23505') throw new InvalidInput(`there is already a ${name} there`); throw e; }
    await recordWorkspaceAudit(client, { tenantId: c.tenantId, actorId: c.actorId, action: existing ? 'structure.unit_updated' : 'structure.unit_created', targetId: unitId, detail: { name, parentId, level: level?.key ?? null } });
    return { id: unitId };
  });
}

/** Which catalogue units a station runs. */
export async function setDepartments(pool: Pool, principal: Principal, stationId: string, body: Record<string, unknown>) {
  const c = await context(pool, principal);
  const lv = await levels(pool, c.tenantId);
  if (!isStation(lv, c.units.get(stationId))) throw new InvalidInput('departments belong to a station');
  must(c, 'structure', stationId, 'changing departments');
  const ids = Array.isArray(body.catalogIds) ? body.catalogIds.map((x) => text(x, 36)).filter((x) => UUID.test(x)) : [];
  await inTransaction(pool, async (client) => {
    await client.query('update station_department set active = false where station_id = $1 and not (catalog_id = any($2::uuid[]))', [stationId, ids]);
    for (const cid of ids) {
      await client.query(`insert into station_department (tenant_id, station_id, catalog_id) select $1, $2, id from unit_catalog where id = $3 and tenant_id = $1 and active
                          on conflict (station_id, catalog_id) do update set active = true`, [c.tenantId, stationId, cid]);
    }
    await recordWorkspaceAudit(client, { tenantId: c.tenantId, actorId: c.actorId, action: 'structure.departments_set', targetId: stationId, detail: { count: ids.length } });
  });
  return { ok: true };
}

/** Puts a member in a unit (their station). Needs the people permission where they are going and where they are now. */
export async function placeMember(pool: Pool, principal: Principal, actorId: string, body: Record<string, unknown>) {
  const c = await context(pool, principal);
  const unitId = text(body.unitId, 36) || null;
  if (unitId && !c.units.has(unitId)) throw new InvalidInput('no such unit');
  const { rows } = await pool.query<{ org_unit_id: string | null }>('select org_unit_id from actor where id = $1 and tenant_id = $2 and active', [actorId, c.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such member');
  if (unitId) must(c, 'people', unitId, 'placing people');
  if (rows[0].org_unit_id) must(c, 'people', rows[0].org_unit_id, 'moving people out of their unit');
  if (!unitId && !rows[0].org_unit_id) return { ok: true };
  await pool.query('update actor set org_unit_id = $3 where id = $1 and tenant_id = $2', [actorId, c.tenantId, unitId]);
  await recordWorkspaceAudit(pool, { tenantId: c.tenantId, actorId: c.actorId, action: 'structure.member_placed', targetId: actorId, detail: { from: rows[0].org_unit_id, to: unitId } });
  return { ok: true };
}

// ---------------------------------------------------------- appointments

/** Checks an office can be held at a unit, and returns it. */
export async function officeFor(client: Client | Pool, tenantId: string, unit: Unit, officeTypeId: string): Promise<OfficeType> {
  const { rows } = await client.query<OfficeType>('select id, key, name, level_id, kind, single, permissions, active, sort from office_type where id = $1 and tenant_id = $2', [officeTypeId, tenantId]);
  const t = rows[0];
  if (!t || !t.active) throw new InvalidInput('no such office');
  if (t.level_id && t.level_id !== unit.level_id) throw new InvalidInput(`${t.name} is not an office at this level`);
  return t;
}

export async function appoint(pool: Pool, principal: Principal, body: Record<string, unknown>, reroute: (client: Client, tenantId: string, unitId: string, officeTypeId: string) => Promise<void>) {
  const c = await context(pool, principal);
  const unitId = text(body.unitId, 36);
  const unit = c.units.get(unitId);
  if (!unit) throw new InvalidInput('no such unit');
  must(c, 'appointments', unitId, 'appointing');
  const actorId = text(body.actorId, 36);
  if (!UUID.test(actorId)) throw new InvalidInput('choose the person');
  const startsOn = day(body.startsOn, 'the start date') ?? today();
  const endsOn = day(body.endsOn, 'the end date');
  if (endsOn && endsOn < startsOn) throw new InvalidInput('the end date is before the start');
  const mandate = body.mandateLimit === undefined || body.mandateLimit === null || body.mandateLimit === '' ? null : Number(body.mandateLimit);
  if (mandate !== null && !(mandate >= 0)) throw new InvalidInput('the mandate limit must be a number');
  return inTransaction(pool, async (client) => {
    await client.query('select id from tenant where id = $1 for update', [c.tenantId]);
    const office = await officeFor(client, c.tenantId, unit, text(body.officeTypeId, 36));
    const { rows: person } = await client.query<{ display_name: string; org_unit_id: string | null }>('select display_name, org_unit_id from actor where id = $1 and tenant_id = $2 and active', [actorId, c.tenantId]);
    if (!person[0]) throw new InvalidInput('that person is not an active member');
    let departmentId: string | null = null;
    if (office.kind === 'unit_head') {
      departmentId = text(body.departmentId, 36);
      const { rows: d } = await client.query('select 1 from station_department where id = $1 and station_id = $2 and active', [departmentId || null, unitId]);
      if (!d[0]) throw new InvalidInput('choose which unit they will head');
    }
    const live = `starts_on <= current_date and (ends_on is null or ends_on > current_date)`;
    const { rows: current } = await client.query<{ id: string; actor_id: string; name: string }>(
      `select h.id, h.actor_id, a.display_name as name from office_holder h join actor a on a.id = h.actor_id
        where h.tenant_id = $1 and h.unit_id = $2 and h.office_type_id = $3 and h.department_id is not distinct from $4 and ${live.replace(/starts_on|ends_on/g, (m) => `h.${m}`)}`, [c.tenantId, unitId, office.id, departmentId]);
    if (current.some((h) => h.actor_id === actorId)) throw new InvalidInput(`${person[0].display_name} already holds this office here`);
    const seatTaken = office.single || office.kind === 'unit_head';
    if (seatTaken && current.length) {
      if (body.replace !== true) throw new InvalidInput(`${current[0]!.name} holds this office; choose to replace them`);
      await client.query(`update office_holder set ends_on = greatest(starts_on, $2::date), ended_by = $3, end_reason = 'replaced' where id = any($1::uuid[])`, [current.map((h) => h.id), startsOn, c.actorId]);
    }
    const { rows } = await client.query<{ id: string }>(
      `insert into office_holder (tenant_id, unit_id, office_type_id, department_id, actor_id, acting, starts_on, ends_on, mandate_limit, appointed_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [c.tenantId, unitId, office.id, departmentId, actorId, body.acting === true, startsOn, endsOn, mandate, c.actorId]);
    // A station office makes that station their home if they have none yet.
    const lv = await levels(client, c.tenantId);
    if (!person[0].org_unit_id && isStation(lv, unit)) await client.query('update actor set org_unit_id = $2 where id = $1', [actorId, unitId]);
    await recordWorkspaceAudit(client, { tenantId: c.tenantId, actorId: c.actorId, action: 'structure.appointed', targetId: rows[0]!.id, detail: { unitId, office: office.key, actorId, acting: body.acting === true, replaced: current.map((h) => h.actor_id) } });
    await reroute(client, c.tenantId, unitId, office.id);
    return { id: rows[0]!.id };
  });
}

export async function endAppointment(pool: Pool, principal: Principal, holderId: string, body: Record<string, unknown>, reroute: (client: Client, tenantId: string, unitId: string, officeTypeId: string) => Promise<void>) {
  const c = await context(pool, principal);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ unit_id: string; office_type_id: string; starts_on: string; ends_on: string | null }>('select unit_id, office_type_id, starts_on::text, ends_on::text from office_holder where id = $1 and tenant_id = $2 for update', [holderId, c.tenantId]);
    const h = rows[0];
    if (!h) throw new InvalidInput('no such appointment');
    must(c, 'appointments', h.unit_id, 'ending appointments');
    if (h.ends_on && h.ends_on <= today()) throw new InvalidInput('that appointment has already ended');
    const endsOn = day(body.endsOn, 'the end date') ?? today();
    const reason = text(body.reason, 40) || 'ended';
    await client.query('update office_holder set ends_on = greatest(starts_on, $2::date), ended_by = $3, end_reason = $4 where id = $1', [holderId, endsOn, c.actorId, reason]);
    await recordWorkspaceAudit(client, { tenantId: c.tenantId, actorId: c.actorId, action: 'structure.appointment_ended', targetId: holderId, detail: { reason, endsOn } });
    await reroute(client, c.tenantId, h.unit_id, h.office_type_id);
    return { ok: true };
  });
}

/** Ties a committee (a Meetings body) to a unit, so a policy step can ask "the CMC of the requester's station". */
export async function linkCommittee(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const c = await context(pool, principal);
  const unitId = text(body.unitId, 36) || null;
  if (unitId && !c.units.has(unitId)) throw new InvalidInput('no such unit');
  must(c, 'structure', unitId, 'linking committees');
  const key = keyOf(text(body.key, 40));
  if (!key) throw new InvalidInput('give the committee a key, like cmc');
  const { rows } = await pool.query('update mtg_body set org_unit_id = $3, structure_key = $4 where id = $1 and tenant_id = $2 returning id', [text(body.bodyId, 36) || null, c.tenantId, unitId, key]);
  if (!rows[0]) throw new InvalidInput('no such committee');
  await recordWorkspaceAudit(pool, { tenantId: c.tenantId, actorId: c.actorId, action: 'structure.committee_linked', targetId: rows[0].id, detail: { unitId, key } });
  return { ok: true };
}

/** May this person invite into this unit (and seat them in this office)? Throws if not. */
export async function checkInviteScope(pool: Pool, principal: Principal, unitId: string, officeTypeId: string | null) {
  const c = await context(pool, principal);
  const unit = c.units.get(unitId);
  if (!unit) throw new InvalidInput('no such unit');
  must(c, 'people', unitId, 'inviting people');
  if (officeTypeId) { must(c, 'appointments', unitId, 'appointing'); await officeFor(pool, c.tenantId, unit, officeTypeId); }
  return { workspaceAdmin: c.workspaceAdmin };
}

// ------------------------------------------------- resolving an office

export interface Holder { actor_id: string; email: string; name: string; acting: boolean; mandate_limit: string | null }
async function holdersAt(client: Client | Pool, tenantId: string, unitId: string, officeTypeIds: string[]): Promise<(Holder & { office_type_id: string })[]> {
  const { rows } = await client.query<Holder & { office_type_id: string }>(
    `select h.actor_id, a.email, a.display_name as name, h.acting, h.mandate_limit, h.office_type_id from office_holder h join actor a on a.id = h.actor_id
      where h.tenant_id = $1 and h.unit_id = $2 and h.office_type_id = any($3::uuid[]) and a.active and h.starts_on <= current_date and (h.ends_on is null or h.ends_on > current_date)
      order by h.acting, h.starts_on`, [tenantId, unitId, officeTypeIds]);
  return rows;
}

export interface OfficeResolution { unitId: string | null; officeTypeId: string | null; office: string; holders: Holder[]; vacant: boolean; wentTo: { unitId: string; unit: string } | null }

/**
 * Who holds `officeKey` for someone in `fromUnitId`: the nearest unit at the
 * office's level, on the way up from theirs. A vacant seat goes to the
 * overseer of the next unit up, and says so.
 */
export async function resolveOffice(client: Client | Pool, tenantId: string, fromUnitId: string | null, officeKey: string): Promise<OfficeResolution> {
  const { rows: t } = await client.query<OfficeType>('select id, key, name, level_id, kind, single, permissions, active, sort from office_type where tenant_id = $1 and key = $2 and active', [tenantId, officeKey]);
  const office = t[0];
  const none: OfficeResolution = { unitId: null, officeTypeId: office?.id ?? null, office: office?.name ?? officeKey, holders: [], vacant: false, wentTo: null };
  if (!office || !fromUnitId) return none;
  const units = await loadUnits(client, tenantId);
  const chain = chainOf(units, fromUnitId);
  const seat = office.level_id ? chain.find((u) => u.level_id === office.level_id) : chain[0];
  if (!seat) return none;
  const holders = await holdersAt(client, tenantId, seat.id, [office.id]);
  if (holders.length) return { unitId: seat.id, officeTypeId: office.id, office: office.name, holders, vacant: false, wentTo: null };
  const above = await overseersAbove(client, tenantId, units, seat.id, []);
  return { unitId: seat.id, officeTypeId: office.id, office: office.name, holders: above?.holders ?? [], vacant: true, wentTo: above ? { unitId: above.unitId, unit: above.unit } : null };
}

/** The overseer of the nearest unit above `unitId` that has one, skipping `exclude` (emails). */
export async function overseersAbove(client: Client | Pool, tenantId: string, units: Map<string, Unit>, unitId: string, exclude: string[]): Promise<{ unitId: string; unit: string; holders: Holder[] } | null> {
  const { rows: heads } = await client.query<{ id: string; level_id: string | null }>(`select id, level_id from office_type where tenant_id = $1 and kind = 'overseer' and active`, [tenantId]);
  for (const u of chainOf(units, unitId).slice(1)) {
    const ids = heads.filter((h) => h.level_id === u.level_id).map((h) => h.id);
    if (!ids.length) continue;
    const found = (await holdersAt(client, tenantId, u.id, ids)).filter((h) => !exclude.includes(h.email.toLowerCase()));
    if (found.length) return { unitId: u.id, unit: u.name, holders: found };
  }
  return null;
}

/**
 * Someone else who may stand in for an office holder at `unitId`: an
 * assistant at the same unit (an Associate Pastor), else the overseer above.
 */
export async function alternateFor(client: Client | Pool, tenantId: string, unitId: string, exclude: string[]): Promise<{ how: 'assistant' | 'above'; unit: string; holders: Holder[] } | null> {
  const units = await loadUnits(client, tenantId);
  const unit = units.get(unitId);
  if (!unit) return null;
  const { rows: assist } = await client.query<{ id: string }>(`select id from office_type where tenant_id = $1 and kind = 'assistant' and active and (level_id is null or level_id = $2)`, [tenantId, unit.level_id]);
  const helpers = (await holdersAt(client, tenantId, unitId, assist.map((a) => a.id))).filter((h) => !exclude.includes(h.email.toLowerCase()));
  if (helpers.length) return { how: 'assistant', unit: unit.name, holders: helpers };
  const above = await overseersAbove(client, tenantId, units, unitId, exclude);
  return above ? { how: 'above', unit: above.unit, holders: above.holders } : null;
}

/** The voting members of the committee with this key nearest the requester (their station's CMC, or the workspace's). */
export async function resolveCommittee(client: Client | Pool, tenantId: string, fromUnitId: string | null, key: string): Promise<{ bodyId: string | null; name: string; emails: string[] }> {
  const units = await loadUnits(client, tenantId);
  const ids = chainOf(units, fromUnitId).map((u) => u.id);
  const { rows } = await client.query<{ id: string; name: string; org_unit_id: string | null }>('select id, name, org_unit_id from mtg_body where tenant_id = $1 and structure_key = $2 and active', [tenantId, key]);
  const body = ids.map((id) => rows.find((r) => r.org_unit_id === id)).find(Boolean) ?? rows.find((r) => !r.org_unit_id);
  if (!body) return { bodyId: null, name: key, emails: [] };
  const { rows: m } = await client.query<{ email: string }>('select a.email from mtg_body_member m join actor a on a.id = m.actor_id where m.body_id = $1 and m.voting and m.until is null and a.active', [body.id]);
  return { bodyId: body.id, name: body.name, emails: m.map((x) => x.email.toLowerCase()) };
}

/** The unit an actor belongs to (their station). */
export async function unitOfActor(client: Client | Pool, actorId: string | null): Promise<string | null> {
  if (!actorId) return null;
  const { rows } = await client.query<{ org_unit_id: string | null }>('select org_unit_id from actor where id = $1', [actorId]);
  return rows[0]?.org_unit_id ?? null;
}

/** The offices a person holds at the given seats, for the record of who decided "as" what, and their mandates. */
export async function holdingsAt(client: Client | Pool, tenantId: string, actorId: string, seats: { unitId: string; officeTypeId: string }[]) {
  if (!seats.length) return [];
  const { rows } = await client.query<{ unit_id: string; unit: string; office_type_id: string; office: string; acting: boolean; mandate_limit: string | null }>(
    `select h.unit_id, u.name as unit, h.office_type_id, t.name as office, h.acting, h.mandate_limit from office_holder h join org_unit u on u.id = h.unit_id join office_type t on t.id = h.office_type_id
      where h.tenant_id = $1 and h.actor_id = $2 and h.starts_on <= current_date and (h.ends_on is null or h.ends_on > current_date)`, [tenantId, actorId]);
  return rows.filter((r) => seats.some((s) => s.unitId === r.unit_id && s.officeTypeId === r.office_type_id));
}
