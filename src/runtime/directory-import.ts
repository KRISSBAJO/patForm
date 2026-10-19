/**
 * Directory import (PRD ORG-09): people, units, titles and managers from a
 * spreadsheet, checked before anything is saved.
 *
 * Every row is checked in full and the answer comes back row by row: a bad
 * address, a duplicate, an unknown manager, someone managing themselves, a
 * reporting loop that only exists once the whole file is applied. If any
 * row has an error, nothing is saved: "an invalid manager reference shall
 * not silently create a broken hierarchy". The real run repeats every check
 * inside one transaction under the workspace lock, so what was checked is
 * what is saved.
 *
 * New people are created at once, provisioned_by 'import', with no
 * password; their invitation (sent only when asked) is how they set one.
 * Existing people get their unit, title and manager updated; their workspace
 * role is never changed by an import, because a spreadsheet is not the place
 * to hand out admin rights.
 */
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { WORKSPACE_ROLES, requireWorkspaceCapability, type Principal, type WorkspaceRole } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { grantableRoles, invite } from './workspace.js';

export const MAX_IMPORT_ROWS = 2000;

export interface ImportRow {
  email?: unknown; name?: unknown; role?: unknown; unit?: unknown; manager?: unknown; title?: unknown; entity?: unknown;
}

export interface RowResult {
  row: number;
  email: string;
  name: string;
  action: 'create' | 'update' | 'unchanged' | 'error';
  changes: string[];
  errors: string[];
  warnings: string[];
}

export interface ImportResult {
  applied: boolean;
  rows: RowResult[];
  summary: { create: number; update: number; unchanged: number; errors: number; unitsToCreate: string[]; entitiesToCreate: string[] };
  invitations?: { sent: number; failed: { email: string; reason: string }[] };
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const str = (v: unknown, max: number) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const unitParts = (path: string) => path.split(/\s*[>/]\s*/).map((p) => p.trim()).filter(Boolean);
const unitKey = (parts: string[]) => parts.map((p) => p.toLowerCase()).join(' > ');

export async function importDirectory(pool: Pool, principal: Principal, body: {
  rows?: unknown; dryRun?: unknown; sendInvitations?: unknown;
}): Promise<ImportResult> {
  await requireWorkspaceCapability(pool, principal, 'administer', 'members');
  if (principal.kind !== 'actor') throw new Error('unreachable');
  if (!Array.isArray(body.rows) || !body.rows.length) throw new InvalidInput('send at least one row');
  if (body.rows.length > MAX_IMPORT_ROWS) throw new InvalidInput(`at most ${MAX_IMPORT_ROWS} rows in one import`);
  const dryRun = body.dryRun !== false;
  const tenantId = principal.tenantId;

  const outcome = await inTransaction(pool, async (client) => {
    await client.query('select id from tenant where id = $1 for update', [tenantId]);
    const result = await plan(client, tenantId, principal.actorId, body.rows as ImportRow[]);
    if (dryRun || result.summary.errors > 0) return { result, created: [] as { email: string; role: WorkspaceRole }[] };
    const created = await apply(client, tenantId, principal.actorId, result);
    await recordWorkspaceAudit(client, {
      tenantId, actorId: principal.actorId, action: 'directory.imported',
      detail: { created: result.summary.create, updated: result.summary.update, unitsCreated: result.summary.unitsToCreate.length, entitiesCreated: result.summary.entitiesToCreate.length },
    });
    result.applied = true;
    return { result, created };
  });

  // After the commit, one invitation each, through the ordinary invite path
  // and its checks. A failure is a line in the result, not a rollback.
  if (outcome.result.applied && body.sendInvitations === true && outcome.created.length) {
    const failed: { email: string; reason: string }[] = [];
    let sent = 0;
    for (const person of outcome.created) {
      try {
        const done = await invite(pool, { principal, email: person.email, workspaceRole: person.role });
        if (done.delivered === 'failed') failed.push({ email: person.email, reason: 'the email could not be sent' });
        else sent++;
      } catch (err) {
        failed.push({ email: person.email, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    outcome.result.invitations = { sent, failed };
  }
  // The working state stays on the server.
  const { _ctx: _drop, ...clean } = outcome.result as ImportResult & { _ctx?: unknown };
  return clean;
}

interface Existing { id: string; email: string; name: string; active: boolean; provisioned_by: string; unit_id: string | null; entity_id: string | null; title: string | null; manager_email: string | null }

async function plan(client: Client, tenantId: string, importerId: string, input: ImportRow[]): Promise<ImportResult & { _ctx: Ctx }> {
  const { rows: people } = await client.query<Existing>(
    `select a.id, lower(a.email) as email, a.display_name as name, a.active, a.provisioned_by,
            a.org_unit_id as unit_id, a.legal_entity_id as entity_id, a.position_title as title,
            (select lower(m.email) from reporting_line r join actor m on m.id = r.manager_id
              where r.actor_id = a.id and r.kind = 'primary' and r.effective_to is null limit 1) as manager_email
       from actor a where a.tenant_id = $1`, [tenantId]);
  const byEmail = new Map(people.map((p) => [p.email, p]));
  const { rows: units } = await client.query<{ id: string; name: string; parent_id: string | null }>(
    'select id, name, parent_id from org_unit where tenant_id = $1', [tenantId]);
  const unitById = new Map(units.map((u) => [u.id, u]));
  const pathOf = (id: string): string[] => {
    const out: string[] = []; let cur: string | null = id; const seen = new Set<string>();
    while (cur && !seen.has(cur)) { seen.add(cur); const u = unitById.get(cur); if (!u) break; out.unshift(u.name); cur = u.parent_id; }
    return out;
  };
  const unitByPath = new Map(units.map((u) => [unitKey(pathOf(u.id)), u.id]));
  // A bare unit name that is unique anywhere in the tree also matches it.
  const byLeaf = new Map<string, string[]>();
  for (const u of units) byLeaf.set(u.name.toLowerCase(), [...(byLeaf.get(u.name.toLowerCase()) ?? []), u.id]);
  const { rows: entities } = await client.query<{ id: string; name: string }>('select id, name from legal_entity where tenant_id = $1', [tenantId]);
  const entityByName = new Map(entities.map((e) => [e.name.toLowerCase(), e.id]));
  const { rows: me } = await client.query<{ workspace_role: WorkspaceRole }>('select workspace_role from actor where id = $1', [importerId]);
  const grantable = grantableRoles(me[0]!.workspace_role);

  const results: RowResult[] = [];
  const seenEmails = new Map<string, number>();
  const unitsToCreate = new Map<string, string[]>();
  const entitiesToCreate = new Map<string, string>();
  // The manager everybody will have once the file is applied.
  const finalManager = new Map<string, string | null>(people.filter((p) => p.active).map((p) => [p.email, p.manager_email]));
  const fileRows: { r: RowResult; email: string; unit: string[] | null; entity: string | null; manager: string | null; title: string | null; role: WorkspaceRole; existing?: Existing }[] = [];

  input.forEach((raw, i) => {
    const r: RowResult = { row: i + 2, email: '', name: '', action: 'unchanged', changes: [], errors: [], warnings: [] };
    results.push(r);
    const email = str(raw?.email, 254).toLowerCase();
    r.email = email;
    r.name = str(raw?.name, 120);
    if (!email) { r.errors.push('email is missing'); return; }
    if (!EMAIL.test(email)) { r.errors.push(`"${email}" is not an email address`); return; }
    if (seenEmails.has(email)) { r.errors.push(`${email} is also on row ${seenEmails.get(email)}`); return; }
    seenEmails.set(email, r.row);
    const existing = byEmail.get(email);
    if (existing && !existing.active) r.errors.push('this person is deactivated; reactivate them on the People page first');
    if (existing?.provisioned_by === 'scim') r.errors.push('this person is managed by your directory sync');
    if (!existing && !r.name) r.errors.push('a new person needs a name');
    if (existing && !r.name) r.name = existing.name;

    let role: WorkspaceRole = 'read_only';
    const roleText = str(raw?.role, 40).toLowerCase().replace(/[\s-]+/g, '_');
    if (roleText) {
      if (!WORKSPACE_ROLES.includes(roleText as WorkspaceRole)) r.errors.push(`role "${roleText}" is not one of ${WORKSPACE_ROLES.join(', ')}`);
      else if (!existing && !grantable.includes(roleText as WorkspaceRole)) r.errors.push(`you cannot give the "${roleText}" role`);
      else role = roleText as WorkspaceRole;
      if (existing && WORKSPACE_ROLES.includes(roleText as WorkspaceRole)) {
        r.warnings.push('an import never changes an existing member\'s role; change it on the People page');
      }
    }

    const unitText = str(raw?.unit, 300);
    let unit: string[] | null = null;
    if (unitText) {
      unit = unitParts(unitText);
      const key = unitKey(unit);
      if (!unitByPath.has(key)) {
        const leaf = unit.length === 1 ? byLeaf.get(unit[0]!.toLowerCase()) : undefined;
        if (leaf && leaf.length === 1) unit = pathOf(leaf[0]!);
        else if (leaf && leaf.length > 1) r.errors.push(`there are ${leaf.length} units called "${unit[0]}"; give the full path, such as "Operations > ${unit[0]}"`);
        else {
          for (let k = 1; k <= unit.length; k++) {
            const prefix = unit.slice(0, k);
            if (!unitByPath.has(unitKey(prefix))) unitsToCreate.set(unitKey(prefix), prefix);
          }
        }
      }
    }
    const entityText = str(raw?.entity, 120);
    if (entityText && !entityByName.has(entityText.toLowerCase())) entitiesToCreate.set(entityText.toLowerCase(), entityText);

    const managerText = str(raw?.manager, 254).toLowerCase();
    let manager: string | null = null;
    if (managerText) {
      if (managerText === email) r.errors.push('nobody can be their own manager');
      else if (!EMAIL.test(managerText)) r.errors.push(`manager "${managerText}" is not an email address`);
      else manager = managerText;
    }
    const title = str(raw?.title, 120) || null;
    fileRows.push({ r, email, unit, entity: entityText || null, manager, title, role, existing });
    if (!r.errors.length && manager) finalManager.set(email, manager);
    else if (!r.errors.length && !finalManager.has(email)) finalManager.set(email, null);
  });

  // Managers must exist once the file is applied, be active, and the chains must not loop.
  for (const f of fileRows) {
    if (f.r.errors.length || !f.manager) continue;
    const inFile = seenEmails.has(f.manager);
    const known = byEmail.get(f.manager);
    if (!inFile && !known) f.r.errors.push(`manager ${f.manager} is neither in this file nor in the workspace`);
    else if (!inFile && known && !known.active) f.r.errors.push(`manager ${f.manager} is deactivated`);
    else if (inFile && results.find((x) => x.email === f.manager)?.errors.length) f.r.errors.push(`manager ${f.manager} has errors on their own row`);
  }
  for (const f of fileRows) {
    if (f.r.errors.length || !f.manager) continue;
    let cur: string | null | undefined = f.manager;
    const seen = new Set<string>([f.email]);
    while (cur) {
      if (seen.has(cur)) { f.r.errors.push(`this makes a reporting loop: ${[...seen, cur].join(' → ')}`); break; }
      seen.add(cur);
      cur = finalManager.get(cur);
    }
  }

  // What changes, in words.
  for (const f of fileRows) {
    if (f.r.errors.length) { f.r.action = 'error'; continue; }
    if (!f.existing) { f.r.action = 'create'; f.r.changes.push(`add as ${f.role.replace('_', ' ')}`); }
    const e = f.existing;
    if (f.unit) {
      const now = e?.unit_id ? unitKey(pathOf(e.unit_id)) : null;
      if (now !== unitKey(f.unit)) f.r.changes.push(`unit: ${f.unit.join(' > ')}`);
    }
    if (f.entity && (!e?.entity_id || entities.find((x) => x.id === e.entity_id)?.name.toLowerCase() !== f.entity.toLowerCase())) f.r.changes.push(`entity: ${f.entity}`);
    if (f.title && f.title !== e?.title) f.r.changes.push(`title: ${f.title}`);
    if (f.manager && f.manager !== e?.manager_email) f.r.changes.push(`manager: ${f.manager}`);
    if (e && f.r.name && f.r.name !== e.name) f.r.warnings.push('the name in the file differs from the workspace; the workspace name is kept');
    if (e) f.r.action = f.r.changes.length ? 'update' : 'unchanged';
  }

  const count = (a: RowResult['action']) => results.filter((x) => x.action === a).length;
  return {
    applied: false,
    rows: results,
    summary: {
      create: count('create'), update: count('update'), unchanged: count('unchanged'), errors: results.filter((x) => x.errors.length).length,
      unitsToCreate: [...unitsToCreate.values()].map((p) => p.join(' > ')),
      entitiesToCreate: [...entitiesToCreate.values()],
    },
    _ctx: { fileRows, unitsToCreate, entitiesToCreate, unitByPath, entityByName, byEmail },
  };
}

interface Ctx {
  fileRows: { r: RowResult; email: string; unit: string[] | null; entity: string | null; manager: string | null; title: string | null; role: WorkspaceRole; existing?: Existing }[];
  unitsToCreate: Map<string, string[]>;
  entitiesToCreate: Map<string, string>;
  unitByPath: Map<string, string>;
  entityByName: Map<string, string>;
  byEmail: Map<string, Existing>;
}

async function apply(client: Client, tenantId: string, importerId: string, planned: ImportResult & { _ctx?: Ctx }): Promise<{ email: string; role: WorkspaceRole }[]> {
  const ctx = (planned as { _ctx: Ctx })._ctx;
  for (const [key, name] of ctx.entitiesToCreate) {
    const { rows } = await client.query<{ id: string }>(
      `insert into legal_entity (tenant_id, name) values ($1, $2) on conflict (tenant_id, name) do update set name = excluded.name returning id`, [tenantId, name]);
    ctx.entityByName.set(key, rows[0]!.id);
  }
  // Parents before children: sort by depth.
  for (const parts of [...ctx.unitsToCreate.values()].sort((a, b) => a.length - b.length)) {
    const parent = parts.length > 1 ? ctx.unitByPath.get(unitKey(parts.slice(0, -1)))! : null;
    const { rows } = await client.query<{ id: string }>(
      'insert into org_unit (tenant_id, name, parent_id) values ($1, $2, $3) returning id', [tenantId, parts[parts.length - 1], parent]);
    ctx.unitByPath.set(unitKey(parts), rows[0]!.id);
  }
  const created: { email: string; role: WorkspaceRole }[] = [];
  const idOf = new Map<string, string>([...ctx.byEmail].map(([e, p]) => [e, p.id]));
  for (const f of ctx.fileRows) {
    if (f.r.action === 'create') {
      const { rows } = await client.query<{ id: string }>(
        `insert into actor (tenant_id, email, display_name, workspace_role, provisioned_by) values ($1, $2, $3, $4, 'import') returning id`,
        [tenantId, f.email, f.r.name, f.role]);
      idOf.set(f.email, rows[0]!.id);
      created.push({ email: f.email, role: f.role });
    }
  }
  for (const f of ctx.fileRows) {
    if (f.r.action !== 'create' && f.r.action !== 'update') continue;
    const id = idOf.get(f.email)!;
    await client.query(
      `update actor set org_unit_id = coalesce($2, org_unit_id), legal_entity_id = coalesce($3, legal_entity_id),
         position_title = coalesce($4, position_title) where id = $1`,
      [id, f.unit ? ctx.unitByPath.get(unitKey(f.unit)) ?? null : null, f.entity ? ctx.entityByName.get(f.entity.toLowerCase()) ?? null : null, f.title]);
    if (f.manager && f.manager !== f.existing?.manager_email) {
      await client.query(
        `update reporting_line set effective_to = greatest(now(), effective_from)
          where tenant_id = $1 and actor_id = $2 and kind = 'primary' and effective_to is null`, [tenantId, id]);
      await client.query(
        `insert into reporting_line (tenant_id, actor_id, manager_id, kind, effective_from, created_by) values ($1, $2, $3, 'primary', now(), $4)`,
        [tenantId, id, idOf.get(f.manager)!, importerId]);
    }
  }
  return created;
}
