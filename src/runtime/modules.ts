/**
 * Modules: the shelves of the shop.
 *
 * The platform — forms, workflow, inbox, people, the org chart and the
 * builder — is always on. Everything else is a module a workspace switches
 * on: it brings its templates (packs, by category) and, as they are built,
 * its shared records, menus and settings. Billing and navigation both read
 * this list, so it lives in code where a release can change it, and the
 * choice lives in `tenant_module`.
 *
 * Switching a module off hides it. It never deletes a record.
 */
import { inTransaction, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';

export interface ModuleDefinition {
  key: string;
  name: string;
  summary: string;
  /** Always on; cannot be switched off. */
  core?: boolean;
  /** Pack categories this module brings. A category no module claims is core. */
  categories: string[];
  /** What is built today, in plain words, so the switch does not oversell. */
  status: 'available' | 'templates_only' | 'coming';
}

export const MODULES: readonly ModuleDefinition[] = [
  {
    key: 'platform',
    name: 'Platform',
    summary: 'Forms, workflow, approvals, the work inbox, people, the org chart and the builder.',
    core: true,
    categories: [],
    status: 'available',
  },
  {
    key: 'expenses',
    name: 'Expenses, advances and reimbursements',
    summary: 'Claims, advances and their retirement, approval limits, and settlement records for Finance.',
    categories: ['Finance'],
    status: 'available',
  },
  {
    key: 'procurement',
    name: 'Procurement and vendors',
    summary: 'Purchase requests, suppliers, quotes, purchase orders, deliveries, invoice matching and supplier payments.',
    categories: ['Procurement'],
    status: 'available',
  },
  {
    key: 'hr',
    name: 'Employee lifecycle and HR requests',
    summary: 'Hiring, onboarding, leave, transfers, probation, documents and offboarding, with tasks for each team and pay kept to HR.',
    categories: ['People'],
    status: 'available',
  },
  {
    key: 'appraisals',
    name: 'Goals, appraisals and development',
    summary: 'Goals, review cycles with self, peer and manager reviews, calibration, appeals and development plans. Ratings never change pay on their own.',
    categories: [],
    status: 'available',
  },
  {
    key: 'assets',
    name: 'Assets, IT and service operations',
    summary: 'Asset register, hand-outs and returns, access requests and revocation, service tickets with targets, maintenance and change requests.',
    categories: ['IT', 'Facilities'],
    status: 'available',
  },
  {
    key: 'contracts',
    name: 'Contracts, compliance and audit',
    summary: 'Contracts with versioned reviews and renewals by notice date, obligations, policies and acknowledgements, controls, audit engagements with scoped auditor access, findings and legal holds.',
    categories: ['Legal', 'Compliance'],
    status: 'available',
  },
  {
    key: 'meetings',
    name: 'Meetings and resolutions',
    summary: 'Boards, committees and management meetings: notices, papers, attendance and quorum, minutes, resolutions with votes, written resolutions signed through Patform Sign, action items and a register.',
    categories: [],
    status: 'available',
  },
  {
    key: 'general_approvals',
    name: 'General approvals',
    summary: 'Everyday requests with their own fields, attachment rules, approval chains and decision history.',
    categories: [],
    status: 'available',
  },
];

const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));
const CATEGORY_MODULE = new Map(MODULES.flatMap((m) => m.categories.map((c) => [c, m.key] as const)));

/** The module keys a workspace has on, core included. */
export async function enabledModules(pool: Pool, tenantId: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ module_key: string }>(
    'select module_key from tenant_module where tenant_id = $1 and enabled', [tenantId]);
  const on = new Set(rows.map((r) => r.module_key));
  for (const m of MODULES) if (m.core) on.add(m.key);
  return on;
}

/** Whether a pack in this category is on the shelf for this workspace. */
export function categoryAvailable(category: string, enabled: Set<string>): boolean {
  const owner = CATEGORY_MODULE.get(category);
  return owner === undefined || enabled.has(owner);
}

export async function listModules(pool: Pool, principal: Principal) {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  const on = await enabledModules(pool, principal.tenantId);
  const { rows } = await pool.query<{ module_key: string; changed_at: Date; changed_by_name: string | null; plan: string | null }>(
    `select m.module_key, m.changed_at, a.display_name as changed_by_name, m.plan
       from tenant_module m left join actor a on a.id = m.changed_by
      where m.tenant_id = $1`, [principal.tenantId]);
  const state = new Map(rows.map((r) => [r.module_key, r]));
  return MODULES.map((m) => ({
    ...m,
    enabled: on.has(m.key),
    changedAt: state.get(m.key)?.changed_at ?? null,
    changedBy: state.get(m.key)?.changed_by_name ?? null,
    plan: state.get(m.key)?.plan ?? null,
  }));
}

/** Owners and admins switch modules. Core cannot be switched off. */
export async function setModule(pool: Pool, principal: Principal, key: string, body: { enabled?: unknown; plan?: unknown }) {
  await requireWorkspaceCapability(pool, principal, 'administer', 'modules');
  if (principal.kind !== 'actor') throw new Error('unreachable');
  const def = BY_KEY.get(key);
  if (!def) throw new InvalidInput('no such module');
  if (typeof body.enabled !== 'boolean') throw new InvalidInput('enabled must be true or false');
  if (def.core && !body.enabled) throw new InvalidInput(`${def.name} is always on`);
  const plan = typeof body.plan === 'string' ? body.plan.trim().slice(0, 40) || null : null;
  return inTransaction(pool, async (client) => {
    await client.query(
      `insert into tenant_module (tenant_id, module_key, enabled, plan, changed_by, changed_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (tenant_id, module_key) do update
         set enabled = excluded.enabled, plan = coalesce(excluded.plan, tenant_module.plan),
             changed_by = excluded.changed_by, changed_at = now()`,
      [principal.tenantId, key, body.enabled, plan, principal.actorId]);
    await recordWorkspaceAudit(client, {
      tenantId: principal.tenantId, actorId: principal.actorId,
      action: body.enabled ? 'module.enabled' : 'module.disabled', targetId: key, detail: { plan },
    });
    return { key, enabled: body.enabled };
  });
}

// ------------------------------------------------------ workspace settings

const TIMEZONES = (() => {
  try { return new Set((Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone')); }
  catch { return null; }
})();

export async function workspaceSettings(pool: Pool, principal: Principal) {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  const { rows } = await pool.query<{ name: string; timezone: string; default_currency: string; locale: string; created_at: Date }>(
    'select name, timezone, default_currency, locale, created_at from tenant where id = $1', [principal.tenantId]);
  const t = rows[0]!;
  return { name: t.name, timezone: t.timezone, defaultCurrency: t.default_currency, locale: t.locale, createdAt: t.created_at };
}

/** ORG-01's tenant setup fields, changeable by owners and admins. */
export async function updateWorkspaceSettings(pool: Pool, principal: Principal, body: {
  name?: unknown; timezone?: unknown; defaultCurrency?: unknown; locale?: unknown;
}) {
  await requireWorkspaceCapability(pool, principal, 'administer', 'workspace');
  if (principal.kind !== 'actor') throw new Error('unreachable');
  const sets: string[] = [];
  const params: unknown[] = [principal.tenantId];
  const detail: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) throw new InvalidInput('name must be 1 to 120 characters');
    params.push(body.name.trim()); sets.push(`name = $${params.length}`); detail.name = body.name.trim();
  }
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== 'string' || (TIMEZONES ? !TIMEZONES.has(body.timezone) : !/^[A-Za-z_]+\/[A-Za-z_\/+-]+$|^UTC$/.test(body.timezone))) {
      throw new InvalidInput('timezone must be an IANA name such as Africa/Lagos');
    }
    params.push(body.timezone); sets.push(`timezone = $${params.length}`); detail.timezone = body.timezone;
  }
  if (body.defaultCurrency !== undefined) {
    const c = String(body.defaultCurrency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new InvalidInput('defaultCurrency must be a three-letter code such as NGN');
    params.push(c); sets.push(`default_currency = $${params.length}`); detail.defaultCurrency = c;
  }
  if (body.locale !== undefined) {
    const l = String(body.locale).trim();
    try { new Intl.Locale(l); } catch { throw new InvalidInput('locale must be a language tag such as en-NG'); }
    params.push(l); sets.push(`locale = $${params.length}`); detail.locale = l;
  }
  if (!sets.length) throw new InvalidInput('nothing to change');
  await inTransaction(pool, async (client) => {
    await client.query(`update tenant set ${sets.join(', ')} where id = $1`, params);
    await recordWorkspaceAudit(client, { tenantId: principal.tenantId, actorId: principal.actorId, action: 'workspace.settings_changed', detail });
  });
  // Read back after the commit, on its own connection, so the caller sees what was saved.
  return workspaceSettings(pool, principal);
}
