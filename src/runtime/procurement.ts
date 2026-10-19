/**
 * Procurement (PRD Module 6): suppliers, quotes, orders, receiving, invoice
 * matching and payment.
 *
 * The purchase request is a process like any other (blueprint finance kind
 * 'purchase'): routed to the requester's manager, budget held on submission.
 * Its approval opens a requisition (expenses.ts, recordFinanceOutcome).
 * From there each step is a record with its own controls:
 *
 *   supplier   draft → under review → approved, or restricted / suspended /
 *              archived with a reason. Approving a supplier and checking its
 *              bank details are separate, by different people (PRC-01, 08).
 *   quotes     recorded against a requisition; sealed until opened after the
 *              deadline; the choice needs a reason and, above a set amount,
 *              a set number of quotes (PRC-04).
 *   order      references the requisition and the supplier version; an
 *              increase past the tolerance, or a change of supplier, needs
 *              re-approval by someone else; calls against a framework
 *              agreement use up its limit under a row lock (PRC-05, 09).
 *   receipt    accepted, rejected with a reason, returned; append-only.
 *              An approved order is not proof of delivery (PRC-06).
 *   invoice    matched line by line against what was accepted and not yet
 *              invoiced, and against the order price within a tolerance.
 *              A mismatch holds it with the reason shown until someone other
 *              than whoever entered it decides (PRC-07).
 *   payment    needs the supplier's bank details checked at their current
 *              version; the version paid against is kept (PRC-08).
 *   cancel     releases the budget; refused once goods are accepted or an
 *              invoice exists, which need an explicit return (PRC-10).
 */
import { randomUUID } from 'node:crypto';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { enabledModules } from './modules.js';
import { open as unseal, seal } from './secret-box.js';
import { tableToCsv } from './export.js';

const UUID = /^[0-9a-f-]{36}$/;
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const day = (v: unknown, what: string): string | null => {
  const s = text(v, 10);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(s).getTime())) throw new InvalidInput(`${what} must be a date`);
  return s;
};

export interface ProcurementSettings {
  /** A purchase request up to this needs only the requester's manager. */
  managerLimit: number;
  priceTolerancePct: number;
  amountTolerance: number;
  orderIncreasePct: number;
  quotesRequired: number;
  quotesRequiredOver: number;
  requireVendorBankCheck: boolean;
}
const DEFAULTS: ProcurementSettings = {
  managerLimit: 1000, priceTolerancePct: 2, amountTolerance: 0, orderIncreasePct: 10, quotesRequired: 1, quotesRequiredOver: 0, requireVendorBankCheck: true,
};

// ------------------------------------------------------------------ access

async function requireModule(pool: Pool, principal: Principal): Promise<{ tenantId: string; actorId: string }> {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  if (!(await enabledModules(pool, principal.tenantId)).has('procurement')) {
    throw new InvalidInput('the Procurement module is switched off for this workspace — an owner can switch it on in Settings');
  }
  return { tenantId: principal.tenantId, actorId: principal.actorId };
}
/** Buyers: anyone who may operate processes. */
async function requireBuyer(pool: Pool, principal: Principal) {
  const who = await requireModule(pool, principal);
  await requireWorkspaceCapability(pool, principal, 'operate', 'procurement');
  return who;
}
async function requireProcAdmin(pool: Pool, principal: Principal) {
  const who = await requireModule(pool, principal);
  await requireWorkspaceCapability(pool, principal, 'administer', 'procurement');
  return who;
}
async function isAdmin(client: Client | Pool, actorId: string): Promise<boolean> {
  const { rows } = await client.query<{ workspace_role: string }>('select workspace_role from actor where id = $1', [actorId]);
  return ['owner', 'admin'].includes(rows[0]?.workspace_role ?? '');
}
async function baseCurrency(client: Client | Pool, tenantId: string) {
  const { rows } = await client.query<{ default_currency: string }>('select default_currency from tenant where id = $1', [tenantId]);
  return rows[0]?.default_currency ?? 'GBP';
}

// ---------------------------------------------------------------- settings

export async function procurementSettings(client: Client | Pool, tenantId: string): Promise<ProcurementSettings> {
  const { rows } = await client.query<Record<string, string | number | boolean>>('select * from procurement_settings where tenant_id = $1', [tenantId]);
  const r = rows[0];
  if (!r) return { ...DEFAULTS };
  return {
    managerLimit: Number(r.manager_limit), priceTolerancePct: Number(r.price_tolerance_pct), amountTolerance: Number(r.amount_tolerance), orderIncreasePct: Number(r.order_increase_pct),
    quotesRequired: Number(r.quotes_required), quotesRequiredOver: Number(r.quotes_required_over), requireVendorBankCheck: Boolean(r.require_vendor_bank_check),
  };
}

export async function readProcurementSettings(pool: Pool, principal: Principal) {
  const { tenantId } = await requireModule(pool, principal);
  return { ...(await procurementSettings(pool, tenantId)), currency: await baseCurrency(pool, tenantId) };
}

export async function updateProcurementSettings(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const { tenantId, actorId } = await requireProcAdmin(pool, principal);
  const cur = await procurementSettings(pool, tenantId);
  const pick = (k: keyof ProcurementSettings, min: number, max: number, int = false) => {
    if (body[k] === undefined) return cur[k] as number;
    const n = num(body[k]);
    if (!Number.isFinite(n) || n < min || n > max) throw new InvalidInput(`${k} must be between ${min} and ${max}`);
    return int ? Math.trunc(n) : round(n);
  };
  const next: ProcurementSettings = {
    managerLimit: pick('managerLimit', 0, 1e12), priceTolerancePct: pick('priceTolerancePct', 0, 100), amountTolerance: pick('amountTolerance', 0, 1e12),
    orderIncreasePct: pick('orderIncreasePct', 0, 1000), quotesRequired: pick('quotesRequired', 1, 10, true),
    quotesRequiredOver: pick('quotesRequiredOver', 0, 1e12),
    requireVendorBankCheck: body.requireVendorBankCheck === undefined ? cur.requireVendorBankCheck : body.requireVendorBankCheck === true,
  };
  await inTransaction(pool, async (client) => {
    await client.query(
      `insert into procurement_settings (tenant_id, price_tolerance_pct, amount_tolerance, order_increase_pct, quotes_required, quotes_required_over, require_vendor_bank_check, updated_by, updated_at, manager_limit)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
       on conflict (tenant_id) do update set manager_limit = excluded.manager_limit, price_tolerance_pct = excluded.price_tolerance_pct, amount_tolerance = excluded.amount_tolerance,
         order_increase_pct = excluded.order_increase_pct, quotes_required = excluded.quotes_required, quotes_required_over = excluded.quotes_required_over,
         require_vendor_bank_check = excluded.require_vendor_bank_check, updated_by = excluded.updated_by, updated_at = now()`,
      [tenantId, next.priceTolerancePct, next.amountTolerance, next.orderIncreasePct, next.quotesRequired, next.quotesRequiredOver, next.requireVendorBankCheck, actorId, next.managerLimit]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'procurement.settings_changed', detail: next });
  });
  return readProcurementSettings(pool, principal);
}

// ---------------------------------------------------------------- vendors

const VENDOR_FIELDS = ['name', 'registrationNo', 'taxId', 'contactName', 'contactEmail', 'contactPhone', 'documentsRef', 'dueDiligence', 'externalRef'] as const;

function vendorInput(body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, string | null> = {};
  for (const k of VENDOR_FIELDS) {
    if (body[k] === undefined) { if (!partial) out[k] = null; continue; }
    out[k] = text(body[k], k === 'dueDiligence' ? 2000 : 200) || null;
  }
  if (!partial && !out.name) throw new InvalidInput('a supplier needs a name');
  if (out.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.contactEmail)) throw new InvalidInput('the contact email is not an email address');
  let categories: string[] | undefined;
  if (body.categories !== undefined) {
    if (!Array.isArray(body.categories)) throw new InvalidInput('categories must be a list');
    categories = [...new Set(body.categories.map((c) => text(c, 40)).filter(Boolean))].slice(0, 30);
  }
  return { out, categories };
}

export async function listVendors(pool: Pool, principal: Principal) {
  const { tenantId } = await requireBuyer(pool, principal);
  const { rows } = await pool.query(
    `select v.id, v.name, v.registration_no, v.tax_id, v.contact_name, v.contact_email, v.contact_phone, v.categories,
            v.legal_entity_id, v.documents_ref, v.due_diligence, v.status, v.status_reason, v.external_ref, v.version,
            v.created_by, v.created_at, v.updated_at,
            b.bank_name, b.account_last4 as bank_last4, b.version as bank_version,
            (b.id is not null and b.verified_version = b.version) as bank_verified,
            (select count(*)::int from purchase_order o where o.vendor_id = v.id and o.status <> 'cancelled') as orders,
            (select count(*)::int from purchase_order o where o.vendor_id = v.id and o.expected_by is not null and o.status in ('received', 'closed', 'partially_received')
               and (select min(r.received_at)::date from goods_receipt r where r.order_id = o.id and r.accepted > 0) <= o.expected_by) as on_time,
            (select count(*)::int from purchase_order o where o.vendor_id = v.id and o.expected_by is not null and o.status in ('received', 'closed', 'partially_received')) as delivered_with_date,
            (select coalesce(sum(r.rejected), 0) from goods_receipt r join purchase_order o on o.id = r.order_id where o.vendor_id = v.id) as rejected_qty,
            (select coalesce(sum(r.accepted + r.rejected), 0) from goods_receipt r join purchase_order o on o.id = r.order_id where o.vendor_id = v.id) as delivered_qty,
            (select count(*)::int from vendor_invoice i where i.vendor_id = v.id and i.status = 'held') as invoices_held
       from vendor v left join vendor_bank b on b.vendor_id = v.id
      where v.tenant_id = $1 order by v.status = 'archived', lower(v.name)`, [tenantId]);
  return rows;
}

export async function createVendor(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const { out, categories } = vendorInput(body, false);
  return inTransaction(pool, async (client) => {
    const { rows: dup } = await client.query('select 1 from vendor where tenant_id = $1 and lower(name) = lower($2)', [tenantId, out.name]);
    if (dup[0]) throw new InvalidInput(`there is already a supplier called ${out.name}`);
    const { rows } = await client.query<{ id: string }>(
      `insert into vendor (tenant_id, name, registration_no, tax_id, contact_name, contact_email, contact_phone, categories, documents_ref, due_diligence, external_ref, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [tenantId, out.name, out.registrationNo, out.taxId, out.contactName, out.contactEmail, out.contactPhone, JSON.stringify(categories ?? []),
        out.documentsRef, out.dueDiligence, out.externalRef, actorId]);
    await client.query(`insert into vendor_status_history (tenant_id, vendor_id, from_status, to_status, actor_id) values ($1, $2, null, 'draft', $3)`, [tenantId, rows[0]!.id, actorId]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'vendor.created', targetId: rows[0]!.id, detail: { name: out.name } });
    return { id: rows[0]!.id, status: 'draft' };
  });
}

/** Details change; identity changes on an approved supplier send it back for review. */
export async function updateVendor(pool: Pool, principal: Principal, vendorId: string, body: Record<string, unknown>) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const { out, categories } = vendorInput(body, true);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ name: string; tax_id: string | null; registration_no: string | null; status: string }>(
      'select name, tax_id, registration_no, status from vendor where id = $1 and tenant_id = $2 for update', [vendorId, tenantId]);
    const v = rows[0];
    if (!v) throw new InvalidInput('no such supplier');
    const sets: string[] = []; const params: unknown[] = [vendorId];
    const col: Record<string, string> = { name: 'name', registrationNo: 'registration_no', taxId: 'tax_id', contactName: 'contact_name', contactEmail: 'contact_email', contactPhone: 'contact_phone', documentsRef: 'documents_ref', dueDiligence: 'due_diligence', externalRef: 'external_ref' };
    for (const [k, value] of Object.entries(out)) { params.push(value); sets.push(`${col[k]} = $${params.length}`); }
    if (categories) { params.push(JSON.stringify(categories)); sets.push(`categories = $${params.length}`); }
    if (!sets.length) throw new InvalidInput('nothing to change');
    const identityChanged = (out.name !== undefined && out.name !== v.name) || (out.taxId !== undefined && out.taxId !== v.tax_id) || (out.registrationNo !== undefined && out.registrationNo !== v.registration_no);
    if (out.name === null) throw new InvalidInput('a supplier needs a name');
    let status = v.status;
    if (identityChanged && v.status === 'approved') {
      status = 'under_review';
      sets.push(`status = 'under_review'`, `status_reason = 'Legal identity changed; needs approval again'`);
      await client.query(`insert into vendor_status_history (tenant_id, vendor_id, from_status, to_status, reason, actor_id) values ($1, $2, 'approved', 'under_review', 'Legal identity changed', $3)`, [tenantId, vendorId, actorId]);
    }
    await client.query(`update vendor set ${sets.join(', ')}, version = version + 1, updated_at = now() where id = $1`, params);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'vendor.updated', targetId: vendorId, detail: { fields: Object.keys(out), identityChanged } });
    return { id: vendorId, status };
  });
}

const VENDOR_MOVES: Record<string, string[]> = {
  under_review: ['draft', 'restricted', 'suspended'],
  approved: ['under_review', 'restricted', 'suspended'],
  restricted: ['approved', 'under_review'],
  suspended: ['approved', 'restricted', 'under_review'],
  archived: ['draft', 'under_review', 'approved', 'restricted', 'suspended'],
  draft: ['under_review'],
};

/** PRC-02. Approving needs administer and someone other than who created it. */
export async function setVendorStatus(pool: Pool, principal: Principal, vendorId: string, body: { to?: unknown; reason?: unknown }) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const to = text(body.to, 20);
  const reason = text(body.reason, 500) || null;
  if (!VENDOR_MOVES[to]) throw new InvalidInput('to must be under_review, approved, restricted, suspended, archived or draft');
  if (['restricted', 'suspended', 'archived'].includes(to) && !reason) throw new InvalidInput('give a reason');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; created_by: string | null; name: string }>(
      'select status, created_by, name from vendor where id = $1 and tenant_id = $2 for update', [vendorId, tenantId]);
    const v = rows[0];
    if (!v) throw new InvalidInput('no such supplier');
    if (!VENDOR_MOVES[to]!.includes(v.status)) throw new InvalidInput(`a supplier that is ${v.status.replace('_', ' ')} cannot be moved to ${to.replace('_', ' ')}`);
    if (to === 'approved') {
      if (!(await isAdmin(client, actorId))) throw new InvalidInput('only an owner or admin can approve a supplier');
      if (v.created_by === actorId) throw new InvalidInput('someone other than the person who added the supplier must approve it');
    }
    await client.query(
      `update vendor set status = $2, status_reason = $3, approved_by = case when $2 = 'approved' then $4::uuid else approved_by end, updated_at = now() where id = $1`,
      [vendorId, to, reason, actorId]);
    await client.query(`insert into vendor_status_history (tenant_id, vendor_id, from_status, to_status, reason, actor_id) values ($1, $2, $3, $4, $5, $6)`,
      [tenantId, vendorId, v.status, to, reason, actorId]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'vendor.status_changed', targetId: vendorId, detail: { name: v.name, from: v.status, to, reason } });
    return { id: vendorId, status: to };
  });
}

export async function vendorHistory(pool: Pool, principal: Principal, vendorId: string) {
  const { tenantId } = await requireBuyer(pool, principal);
  const { rows } = await pool.query(
    `select h.from_status, h.to_status, h.reason, h.occurred_at, a.display_name as actor_name
       from vendor_status_history h left join actor a on a.id = h.actor_id where h.tenant_id = $1 and h.vendor_id = $2 order by h.id desc`, [tenantId, vendorId]);
  return rows;
}

/** PRC-08. A change bumps the version and needs checking by someone else. */
export async function saveVendorBank(pool: Pool, principal: Principal, vendorId: string, body: Record<string, unknown>) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const accountName = text(body.accountName, 120); const bankName = text(body.bankName, 120);
  const bankCode = text(body.bankCode, 20) || null;
  const accountNumber = text(body.accountNumber, 40).replace(/[\s-]/g, '').toUpperCase();
  if (!accountName || !bankName) throw new InvalidInput('give the account name and the bank');
  if (!/^[A-Z0-9]{6,34}$/.test(accountNumber)) throw new InvalidInput('the account number should be 6 to 34 letters or digits');
  return inTransaction(pool, async (client) => {
    const { rows: v } = await client.query('select 1 from vendor where id = $1 and tenant_id = $2', [vendorId, tenantId]);
    if (!v[0]) throw new InvalidInput('no such supplier');
    const { rows: existing } = await client.query<{ id: string; version: number }>('select id, version from vendor_bank where vendor_id = $1 for update', [vendorId]);
    const id = existing[0]?.id ?? randomUUID();
    const sealed = seal(accountNumber, id);
    const version = (existing[0]?.version ?? 0) + 1;
    if (existing[0]) {
      await client.query(
        `update vendor_bank set account_name = $2, bank_name = $3, bank_code = $4, account_sealed = $5, account_last4 = $6, version = $7, changed_by = $8, updated_at = now() where id = $1`,
        [id, accountName, bankName, bankCode, sealed, accountNumber.slice(-4), version, actorId]);
    } else {
      await client.query(
        `insert into vendor_bank (id, tenant_id, vendor_id, account_name, bank_name, bank_code, account_sealed, account_last4, changed_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, tenantId, vendorId, accountName, bankName, bankCode, sealed, accountNumber.slice(-4), actorId]);
    }
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'vendor.bank_changed', targetId: vendorId, detail: { version, bankName, last4: accountNumber.slice(-4) } });
    return { vendorId, account: `•••• ${accountNumber.slice(-4)}`, version, verified: false };
  });
}

export async function verifyVendorBank(pool: Pool, principal: Principal, vendorId: string) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ version: number; changed_by: string | null }>(
      'select b.version, b.changed_by from vendor_bank b join vendor v on v.id = b.vendor_id where b.vendor_id = $1 and v.tenant_id = $2 for update', [vendorId, tenantId]);
    const b = rows[0];
    if (!b) throw new InvalidInput('this supplier has no bank details yet');
    if (b.changed_by === actorId) throw new InvalidInput('someone other than the person who entered the bank details must check them');
    await client.query('update vendor_bank set verified_version = version, verified_by = $2, verified_at = now() where vendor_id = $1', [vendorId, actorId]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'vendor.bank_verified', targetId: vendorId, detail: { version: b.version } });
    return { vendorId, verifiedVersion: b.version };
  });
}

export async function revealVendorBank(pool: Pool, principal: Principal, vendorId: string) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const { rows } = await pool.query<{ id: string; account_name: string; bank_name: string; bank_code: string | null; account_sealed: string; version: number }>(
    'select b.id, b.account_name, b.bank_name, b.bank_code, b.account_sealed, b.version from vendor_bank b join vendor v on v.id = b.vendor_id where b.vendor_id = $1 and v.tenant_id = $2', [vendorId, tenantId]);
  const b = rows[0];
  if (!b) throw new InvalidInput('this supplier has no bank details yet');
  await recordWorkspaceAudit(pool, { tenantId, actorId, action: 'vendor.bank_revealed', targetId: vendorId, detail: { version: b.version } });
  return { accountName: b.account_name, bankName: b.bank_name, bankCode: b.bank_code, accountNumber: unseal(b.account_sealed, b.id).plaintext, version: b.version };
}

// ------------------------------------------------------------- agreements

export async function createAgreement(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const { tenantId, actorId } = await requireProcAdmin(pool, principal);
  const vendorId = text(body.vendorId, 36);
  const title = text(body.title, 200);
  const limit = round(num(body.limitAmount));
  const from = day(body.validFrom, 'validFrom'); const to = day(body.validTo, 'validTo');
  if (!UUID.test(vendorId)) throw new InvalidInput('choose a supplier');
  if (!title) throw new InvalidInput('give the agreement a title');
  if (!(limit > 0)) throw new InvalidInput('the limit must be more than nothing');
  if (!from || !to || to < from) throw new InvalidInput('give a start and end date, end not before start');
  const { rows: v } = await pool.query('select 1 from vendor where id = $1 and tenant_id = $2', [vendorId, tenantId]);
  if (!v[0]) throw new InvalidInput('no such supplier');
  const { rows } = await pool.query<{ id: string }>(
    `insert into vendor_agreement (tenant_id, vendor_id, title, limit_amount, valid_from, valid_to, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [tenantId, vendorId, title, limit, from, to, actorId]);
  await recordWorkspaceAudit(pool, { tenantId, actorId, action: 'agreement.created', targetId: rows[0]!.id, detail: { vendorId, title, limit, from, to } });
  return { id: rows[0]!.id };
}

export async function listAgreements(pool: Pool, principal: Principal) {
  const { tenantId } = await requireBuyer(pool, principal);
  const { rows } = await pool.query(
    `select g.id, g.vendor_id, v.name as vendor_name, g.title, g.limit_amount, g.valid_from, g.valid_to,
            coalesce((select sum(o.total) from purchase_order o where o.agreement_id = g.id and o.status <> 'cancelled'), 0) as used
       from vendor_agreement g join vendor v on v.id = g.vendor_id where g.tenant_id = $1 order by g.valid_to desc`, [tenantId]);
  return rows.map((r) => ({ ...r, remaining: round(Number(r.limit_amount) - Number(r.used)) }));
}

// ----------------------------------------------------------- requisitions

export async function listRequisitions(pool: Pool, principal: Principal) {
  const { tenantId } = await requireBuyer(pool, principal);
  const { rows } = await pool.query(
    `select r.id, r.instance_id, r.reference, r.requester, r.title, r.amount, r.currency, r.cost_centre, r.needed_by, r.status,
            r.quotes_open_at, r.quotes_opened, r.selected_quote_id, r.selection_reason, r.created_at,
            coalesce(i.data->>'requester_name', r.requester) as requester_name,
            (select count(*)::int from vendor_quote q where q.requisition_id = r.id) as quotes,
            (select o.number from purchase_order o where o.requisition_id = r.id and o.status <> 'cancelled' order by o.created_at desc limit 1) as order_number
       from purchase_requisition r join instance i on i.id = r.instance_id
      where r.tenant_id = $1 order by case r.status when 'approved' then 0 when 'sourcing' then 1 when 'ordered' then 2 else 3 end, r.created_at desc limit 500`, [tenantId]);
  return rows;
}

async function requisitionFor(client: Client | Pool, tenantId: string, id: string, lock = false) {
  if (!UUID.test(id)) throw new InvalidInput('no such request');
  const { rows } = await client.query<{
    id: string; instance_id: string; status: string; amount: string; quotes_open_at: Date | null; quotes_opened: boolean; selected_quote_id: string | null; reference: string;
  }>(`select id, instance_id, status, amount, quotes_open_at, quotes_opened, selected_quote_id, reference from purchase_requisition where id = $1 and tenant_id = $2${lock ? ' for update' : ''}`, [id, tenantId]);
  if (!rows[0]) throw new InvalidInput('no such request');
  return rows[0];
}

const sealed = (r: { quotes_open_at: Date | null; quotes_opened: boolean }) => r.quotes_open_at !== null && !r.quotes_opened;

/** PRC-04. Amounts of sealed quotes are withheld until they are opened. */
export async function listQuotes(pool: Pool, principal: Principal, requisitionId: string) {
  const { tenantId } = await requireBuyer(pool, principal);
  const r = await requisitionFor(pool, tenantId, requisitionId);
  const { rows } = await pool.query<{ id: string; vendor_id: string; vendor_name: string; amount: string | null; lead_days: number | null; notes: string | null; document_ref: string | null; received_at: Date }>(
    `select q.id, q.vendor_id, v.name as vendor_name, q.amount, q.lead_days, q.notes, q.document_ref, q.received_at
       from vendor_quote q join vendor v on v.id = q.vendor_id where q.requisition_id = $1 order by q.amount`, [r.id]);
  const hide = sealed(r);
  return {
    sealed: hide, opensAt: r.quotes_open_at, selectedQuoteId: r.selected_quote_id,
    quotes: (hide ? [...rows].sort((a, b) => a.received_at.getTime() - b.received_at.getTime()) : rows).map((q) => ({ ...q, amount: hide ? null : q.amount, notes: hide ? null : q.notes })),
  };
}

export async function setQuoteDeadline(pool: Pool, principal: Principal, requisitionId: string, body: { opensAt?: unknown }) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const at = body.opensAt ? new Date(String(body.opensAt)) : null;
  if (!at || Number.isNaN(at.getTime())) throw new InvalidInput('give the date and time the quotes may be opened');
  return inTransaction(pool, async (client) => {
    const r = await requisitionFor(client, tenantId, requisitionId, true);
    if (r.quotes_opened) throw new InvalidInput('the quotes have already been opened');
    if (!['approved', 'sourcing'].includes(r.status)) throw new InvalidInput('this request is no longer being sourced');
    await client.query(`update purchase_requisition set quotes_open_at = $2, status = 'sourcing', updated_at = now() where id = $1`, [r.id, at]);
    await appendRecordEvent(client, { tenantId, instanceId: r.instance_id, actorId, type: 'quotes_sealed', payload: { opensAt: at } });
    return { id: r.id, opensAt: at };
  });
}

export async function addQuote(pool: Pool, principal: Principal, requisitionId: string, body: Record<string, unknown>) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const vendorId = text(body.vendorId, 36);
  const amount = round(num(body.amount));
  if (!UUID.test(vendorId)) throw new InvalidInput('choose a supplier');
  if (!(amount >= 0)) throw new InvalidInput('give the quoted amount');
  const leadDays = body.leadDays === undefined || body.leadDays === '' ? null : Math.trunc(num(body.leadDays));
  if (leadDays !== null && !(leadDays >= 0 && leadDays <= 3650)) throw new InvalidInput('lead time must be a number of days');
  return inTransaction(pool, async (client) => {
    const r = await requisitionFor(client, tenantId, requisitionId, true);
    if (!['approved', 'sourcing'].includes(r.status)) throw new InvalidInput('this request is no longer being sourced');
    if (r.quotes_open_at && r.quotes_open_at.getTime() < Date.now()) throw new InvalidInput('the deadline for quotes has passed');
    const { rows: v } = await client.query<{ status: string; name: string }>('select status, name from vendor where id = $1 and tenant_id = $2', [vendorId, tenantId]);
    if (!v[0]) throw new InvalidInput('no such supplier');
    if (['suspended', 'archived'].includes(v[0].status)) throw new InvalidInput(`${v[0].name} is ${v[0].status} and cannot quote`);
    await client.query(
      `insert into vendor_quote (tenant_id, requisition_id, vendor_id, amount, lead_days, notes, document_ref, entered_by) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (requisition_id, vendor_id) do update set amount = excluded.amount, lead_days = excluded.lead_days, notes = excluded.notes,
         document_ref = excluded.document_ref, received_at = now(), entered_by = excluded.entered_by`,
      [tenantId, r.id, vendorId, amount, leadDays, text(body.notes, 1000) || null, text(body.documentRef, 300) || null, actorId]);
    await client.query(`update purchase_requisition set status = 'sourcing', updated_at = now() where id = $1 and status = 'approved'`, [r.id]);
    // The requester's record says a quote arrived, never from whom or for how much.
    await appendRecordEvent(client, { tenantId, instanceId: r.instance_id, actorId, type: 'quote_received', payload: {} });
    return { requisitionId: r.id, vendorId };
  });
}

/** The release event for sealed quotes: only after the deadline. */
export async function openQuotes(pool: Pool, principal: Principal, requisitionId: string) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  return inTransaction(pool, async (client) => {
    const r = await requisitionFor(client, tenantId, requisitionId, true);
    if (!r.quotes_open_at) throw new InvalidInput('these quotes are not sealed');
    if (r.quotes_opened) throw new InvalidInput('the quotes are already open');
    if (r.quotes_open_at.getTime() > Date.now()) throw new InvalidInput(`the quotes cannot be opened before ${r.quotes_open_at.toISOString()}`);
    await client.query('update purchase_requisition set quotes_opened = true, updated_at = now() where id = $1', [r.id]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'quotes.opened', targetId: r.id, detail: { reference: r.reference } });
    await appendRecordEvent(client, { tenantId, instanceId: r.instance_id, actorId, type: 'quotes_opened', payload: {} });
    return { id: r.id, opened: true };
  });
}

export async function selectQuote(pool: Pool, principal: Principal, requisitionId: string, body: { quoteId?: unknown; reason?: unknown }) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const quoteId = text(body.quoteId, 36);
  const reason = text(body.reason, 1000);
  if (!reason) throw new InvalidInput('say why this quote was chosen');
  const settings = await procurementSettings(pool, tenantId);
  return inTransaction(pool, async (client) => {
    const r = await requisitionFor(client, tenantId, requisitionId, true);
    if (sealed(r)) throw new InvalidInput('open the sealed quotes before choosing one');
    if (!['approved', 'sourcing'].includes(r.status)) throw new InvalidInput('this request is no longer being sourced');
    const { rows: q } = await client.query<{ id: string }>('select id from vendor_quote where id = $1 and requisition_id = $2', [quoteId, r.id]);
    if (!q[0]) throw new InvalidInput('no such quote on this request');
    const { rows: n } = await client.query<{ n: number }>('select count(*)::int as n from vendor_quote where requisition_id = $1', [r.id]);
    if (Number(r.amount) > settings.quotesRequiredOver && n[0]!.n < settings.quotesRequired) {
      throw new InvalidInput(`requests over ${settings.quotesRequiredOver} need ${settings.quotesRequired} quotes; this one has ${n[0]!.n}`);
    }
    await client.query('update purchase_requisition set selected_quote_id = $2, selection_reason = $3, updated_at = now() where id = $1', [r.id, quoteId, reason]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'quote.selected', targetId: r.id, detail: { quoteId, reason } });
    return { id: r.id, selectedQuoteId: quoteId };
  });
}

// ----------------------------------------------------------------- orders

interface LineIn { description: string; kind: 'goods' | 'service'; quantity: number; unitPrice: number }
function linesIn(raw: unknown): LineIn[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 200) throw new InvalidInput('an order needs 1 to 200 lines');
  return raw.map((l, i) => {
    const o = (l ?? {}) as Record<string, unknown>;
    const description = text(o.description, 300);
    const quantity = round3(num(o.quantity));
    const unitPrice = round(num(o.unitPrice));
    if (!description) throw new InvalidInput(`line ${i + 1}: describe the item`);
    if (!(quantity > 0)) throw new InvalidInput(`line ${i + 1}: quantity must be more than nothing`);
    if (!(unitPrice >= 0)) throw new InvalidInput(`line ${i + 1}: give a unit price`);
    return { description, kind: o.kind === 'service' ? 'service' : 'goods', quantity, unitPrice };
  });
}
const totalOf = (lines: LineIn[]) => round(lines.reduce((s, l) => s + round(l.quantity * l.unitPrice), 0));

/** PRC-02 acceptance 3: who can order from this supplier. */
async function checkVendorForOrder(client: Client, tenantId: string, vendorId: string, actorId: string, exceptionReason: string) {
  const { rows } = await client.query<{ status: string; name: string; version: number; status_reason: string | null }>(
    'select status, name, version, status_reason from vendor where id = $1 and tenant_id = $2 for share', [vendorId, tenantId]);
  const v = rows[0];
  if (!v) throw new InvalidInput('no such supplier');
  if (['draft', 'under_review'].includes(v.status)) throw new InvalidInput(`${v.name} is not approved yet`);
  if (v.status === 'archived') throw new InvalidInput(`${v.name} is archived`);
  if (v.status === 'restricted' && !exceptionReason) throw new InvalidInput(`${v.name} is restricted (${v.status_reason ?? 'no reason given'}); give an exception reason to order`);
  if (v.status === 'suspended') {
    if (!exceptionReason) throw new InvalidInput(`${v.name} is suspended (${v.status_reason ?? 'no reason given'}); an owner or admin must give an exception reason to order`);
    if (!(await isAdmin(client, actorId))) throw new InvalidInput(`${v.name} is suspended; only an owner or admin can order under an exception`);
  }
  return v;
}

async function nextOrderNumber(client: Client, tenantId: string) {
  await client.query('select id from tenant where id = $1 for update', [tenantId]);
  const { rows } = await client.query<{ n: number }>('select coalesce(max(number), 1000) + 1 as n from purchase_order where tenant_id = $1', [tenantId]);
  return Number(rows[0]!.n);
}

async function checkAgreement(client: Client, tenantId: string, agreementId: string, vendorId: string, amount: number, excludeOrder?: string) {
  const { rows } = await client.query<{ vendor_id: string; limit_amount: string; valid_from: string; valid_to: string; title: string }>(
    `select vendor_id, limit_amount, valid_from::text, valid_to::text, title from vendor_agreement where id = $1 and tenant_id = $2 for update`, [agreementId, tenantId]);
  const g = rows[0];
  if (!g) throw new InvalidInput('no such agreement');
  if (g.vendor_id !== vendorId) throw new InvalidInput('that agreement is with a different supplier');
  const today = new Date().toISOString().slice(0, 10);
  if (today < g.valid_from || today > g.valid_to) throw new InvalidInput(`the agreement "${g.title}" is not in force today`);
  const { rows: used } = await client.query<{ used: string }>(
    `select coalesce(sum(total), 0) as used from purchase_order where agreement_id = $1 and status <> 'cancelled' and ($2::uuid is null or id <> $2)`, [agreementId, excludeOrder ?? null]);
  const remaining = round(Number(g.limit_amount) - Number(used[0]!.used));
  if (amount > remaining) throw new InvalidInput(`the agreement "${g.title}" has ${remaining.toFixed(2)} left; this order is ${amount.toFixed(2)}`);
}

/** Keeps the budget hold of the request in step with the order; refuses an enforced overrun. */
async function moveBudget(client: Client, instanceId: string | null, amount: number, release = false) {
  if (!instanceId) return;
  const { rows } = await client.query<{ budget_id: string; amount: string }>(
    `select budget_id, amount from budget_reservation where instance_id = $1 and status <> 'released' for update`, [instanceId]);
  const hold = rows[0];
  if (!hold) return;
  if (release) { await client.query(`update budget_reservation set status = 'released', updated_at = now() where instance_id = $1`, [instanceId]); return; }
  const delta = round(amount - Number(hold.amount));
  if (delta > 0) {
    const { rows: b } = await client.query<{ amount: string; mode: string; cost_centre: string }>('select amount, mode, cost_centre from expense_budget where id = $1 for update', [hold.budget_id]);
    const { rows: used } = await client.query<{ held: string }>(
      `select coalesce(sum(amount), 0) as held from budget_reservation where budget_id = $1 and status in ('reserved', 'consumed')`, [hold.budget_id]);
    const available = round(Number(b[0]!.amount) - Number(used[0]!.held));
    if (b[0]!.mode === 'enforced' && delta > available) {
      throw new InvalidInput(`the ${b[0]!.cost_centre} budget has ${available.toFixed(2)} left; this order needs ${delta.toFixed(2)} more than the request held`);
    }
  }
  await client.query('update budget_reservation set amount = $2, updated_at = now() where instance_id = $1', [instanceId, amount]);
}

export async function createOrder(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const lines = linesIn(body.lines);
  const total = totalOf(lines);
  const vendorId = text(body.vendorId, 36);
  const exceptionReason = text(body.exceptionReason, 500);
  const requisitionId = text(body.requisitionId, 36) || null;
  const agreementId = text(body.agreementId, 36) || null;
  const expectedBy = day(body.expectedBy, 'expectedBy');
  if (!UUID.test(vendorId)) throw new InvalidInput('choose a supplier');
  const settings = await procurementSettings(pool, tenantId);
  return inTransaction(pool, async (client) => {
    const v = await checkVendorForOrder(client, tenantId, vendorId, actorId, exceptionReason);
    let req: Awaited<ReturnType<typeof requisitionFor>> | null = null;
    let status = 'issued';
    if (requisitionId) {
      req = await requisitionFor(client, tenantId, requisitionId, true);
      if (!['approved', 'sourcing'].includes(req.status)) throw new InvalidInput('this request has already been ordered or cancelled');
      if (sealed(req)) throw new InvalidInput('open the sealed quotes first');
      if (req.selected_quote_id) {
        const { rows: q } = await client.query<{ vendor_id: string }>('select vendor_id from vendor_quote where id = $1', [req.selected_quote_id]);
        if (q[0]?.vendor_id !== vendorId) throw new InvalidInput('the order must go to the supplier whose quote was chosen');
      } else {
        const { rows: n } = await client.query<{ n: number }>('select count(*)::int as n from vendor_quote where requisition_id = $1', [req.id]);
        if (Number(req.amount) > settings.quotesRequiredOver && settings.quotesRequired > 1) {
          throw new InvalidInput(`choose a quote first: requests over ${settings.quotesRequiredOver} need ${settings.quotesRequired} quotes (this one has ${n[0]!.n})`);
        }
      }
      if (total > round(Number(req.amount) * (1 + settings.orderIncreasePct / 100))) status = 'pending_approval';
    } else if (!(await isAdmin(client, actorId))) {
      throw new InvalidInput('an order without an approved request needs an owner or admin');
    }
    if (agreementId) await checkAgreement(client, tenantId, agreementId, vendorId, total);
    if (req) await moveBudget(client, req.instance_id, total);
    const number = await nextOrderNumber(client, tenantId);
    const currency = await baseCurrency(client, tenantId);
    const { rows } = await client.query<{ id: string }>(
      `insert into purchase_order (tenant_id, number, requisition_id, vendor_id, vendor_version, agreement_id, status, currency, total, approved_total,
         expected_by, delivery_location, terms, exception_reason, external_ref, created_by, approved_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) returning id`,
      [tenantId, number, req?.id ?? null, vendorId, v.version, agreementId, status, currency, total, status === 'issued' ? total : (req ? Number(req.amount) : 0),
        expectedBy, text(body.deliveryLocation, 300) || null, text(body.terms, 2000) || null, exceptionReason || null, text(body.externalRef, 120) || null,
        actorId, status === 'issued' ? actorId : null]);
    const orderId = rows[0]!.id;
    await writeLines(client, orderId, lines);
    await client.query(`insert into purchase_order_revision (order_id, revision, total, lines, vendor_id, reason, actor_id) values ($1, 1, $2, $3, $4, 'created', $5)`,
      [orderId, total, JSON.stringify(lines), vendorId, actorId]);
    if (req) {
      await client.query(`update purchase_requisition set status = 'ordered', updated_at = now() where id = $1`, [req.id]);
      await appendRecordEvent(client, { tenantId, instanceId: req.instance_id, actorId, type: 'order_raised', payload: { order: number, status } });
    }
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'order.created', targetId: orderId,
      detail: { number, vendor: v.name, total, status, ...(exceptionReason ? { exceptionReason, vendorStatus: v.status } : {}) } });
    return { id: orderId, number, status, total };
  });
}

async function writeLines(client: Client, orderId: string, lines: LineIn[]) {
  for (const [i, l] of lines.entries()) {
    await client.query(`insert into purchase_order_line (order_id, line_no, description, kind, quantity, unit_price) values ($1, $2, $3, $4, $5, $6)`,
      [orderId, i + 1, l.description, l.kind, l.quantity, l.unitPrice]);
  }
}

/**
 * PRC-05. A material change is a new revision. An increase past the
 * tolerance, or a different supplier, goes back for approval. Lines already
 * received cannot drop below what was accepted.
 */
export async function reviseOrder(pool: Pool, principal: Principal, orderId: string, body: Record<string, unknown>) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const reason = text(body.reason, 500);
  if (!reason) throw new InvalidInput('say why the order is changing');
  const lines = linesIn(body.lines);
  const total = totalOf(lines);
  const settings = await procurementSettings(pool, tenantId);
  return inTransaction(pool, async (client) => {
    const o = await orderFor(client, tenantId, orderId, true);
    if (!['issued', 'pending_approval', 'partially_received'].includes(o.status)) throw new InvalidInput(`a ${o.status.replace('_', ' ')} order cannot be changed`);
    const vendorId = text(body.vendorId, 36) || o.vendor_id;
    const { rows: received } = await client.query<{ line_no: number; net: string }>(
      `select l.line_no, coalesce(sum(r.accepted - r.returned), 0) as net from purchase_order_line l left join goods_receipt r on r.line_id = l.id
        where l.order_id = $1 group by l.line_no having coalesce(sum(r.accepted - r.returned), 0) > 0`, [o.id]);
    for (const r of received) {
      const nl = lines[r.line_no - 1];
      if (!nl || nl.quantity < Number(r.net)) throw new InvalidInput(`line ${r.line_no} already has ${Number(r.net)} accepted; it cannot be removed or reduced below that`);
    }
    const { rows: invoiced } = await client.query<{ n: number }>(`select count(*)::int as n from vendor_invoice where order_id = $1 and status not in ('rejected', 'void')`, [o.id]);
    if (vendorId !== o.vendor_id && (received.length || invoiced[0]!.n)) throw new InvalidInput('the supplier cannot change once goods or invoices exist');
    let v = { version: o.vendor_version };
    if (vendorId !== o.vendor_id) v = await checkVendorForOrder(client, tenantId, vendorId, actorId, text(body.exceptionReason, 500));
    if (o.agreement_id) await checkAgreement(client, tenantId, o.agreement_id, vendorId, total, o.id);
    const needsApproval = vendorId !== o.vendor_id || total > round(Number(o.approved_total) * (1 + settings.orderIncreasePct / 100));
    const status = needsApproval ? 'pending_approval' : o.status;
    await moveBudget(client, o.instance_id, total);
    // Lines are replaced; receipts reference lines, so received lines keep their ids.
    const { rows: existing } = await client.query<{ id: string; line_no: number }>('select id, line_no from purchase_order_line where order_id = $1', [o.id]);
    const byNo = new Map(existing.map((l) => [l.line_no, l.id]));
    for (const [i, l] of lines.entries()) {
      const id = byNo.get(i + 1);
      if (id) await client.query('update purchase_order_line set description = $2, kind = $3, quantity = $4, unit_price = $5 where id = $1', [id, l.description, l.kind, l.quantity, l.unitPrice]);
      else await client.query(`insert into purchase_order_line (order_id, line_no, description, kind, quantity, unit_price) values ($1, $2, $3, $4, $5, $6)`, [o.id, i + 1, l.description, l.kind, l.quantity, l.unitPrice]);
    }
    for (const [no, id] of byNo) {
      if (no > lines.length) {
        const { rows: used } = await client.query('select 1 from goods_receipt where line_id = $1 union select 1 from vendor_invoice_line where line_id = $1', [id]);
        if (used[0]) throw new InvalidInput(`line ${no} has deliveries or invoices and cannot be removed`);
        await client.query('delete from purchase_order_line where id = $1', [id]);
      }
    }
    const revision = o.revision + 1;
    await client.query(
      `update purchase_order set revision = $2, total = $3, status = $4, vendor_id = $5, vendor_version = $6, approved_by = case when $7 then null else approved_by end, updated_at = now() where id = $1`,
      [o.id, revision, total, status, vendorId, v.version, needsApproval]);
    await client.query(`insert into purchase_order_revision (order_id, revision, total, lines, vendor_id, reason, actor_id) values ($1, $2, $3, $4, $5, $6, $7)`,
      [o.id, revision, total, JSON.stringify(lines), vendorId, reason, actorId]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'order.revised', targetId: o.id, detail: { number: o.number, revision, total, needsApproval, reason } });
    return { id: o.id, revision, status, total };
  });
}

export async function approveOrder(pool: Pool, principal: Principal, orderId: string) {
  const { tenantId, actorId } = await requireProcAdmin(pool, principal);
  return inTransaction(pool, async (client) => {
    const o = await orderFor(client, tenantId, orderId, true);
    if (o.status !== 'pending_approval') throw new InvalidInput('this order is not waiting for approval');
    if (o.created_by === actorId) throw new InvalidInput('someone other than the person who raised or changed the order must approve it');
    const { rows: rev } = await client.query<{ actor_id: string }>('select actor_id from purchase_order_revision where order_id = $1 order by revision desc limit 1', [o.id]);
    if (rev[0]?.actor_id === actorId) throw new InvalidInput('someone other than the person who raised or changed the order must approve it');
    const { rows: got } = await client.query<{ n: number }>('select count(*)::int as n from goods_receipt where order_id = $1', [o.id]);
    const status = got[0]!.n ? 'partially_received' : 'issued';
    await client.query('update purchase_order set status = $2, approved_total = total, approved_by = $3, updated_at = now() where id = $1', [o.id, status, actorId]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'order.approved', targetId: o.id, detail: { number: o.number, total: Number(o.total) } });
    return { id: o.id, status };
  });
}

/** PRC-10. Releases the budget; refused once goods are accepted or an invoice exists. */
export async function cancelOrder(pool: Pool, principal: Principal, orderId: string, body: { reason?: unknown }) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const reason = text(body.reason, 500);
  if (!reason) throw new InvalidInput('give a reason');
  return inTransaction(pool, async (client) => {
    const o = await orderFor(client, tenantId, orderId, true);
    if (['cancelled', 'closed'].includes(o.status)) throw new InvalidInput(`this order is already ${o.status}`);
    const { rows: net } = await client.query<{ net: string }>('select coalesce(sum(accepted - returned), 0) as net from goods_receipt where order_id = $1', [o.id]);
    if (Number(net[0]!.net) > 0) throw new InvalidInput('goods have been accepted on this order; record their return first');
    const { rows: inv } = await client.query<{ n: number }>(`select count(*)::int as n from vendor_invoice where order_id = $1 and status not in ('rejected', 'void')`, [o.id]);
    if (inv[0]!.n) throw new InvalidInput('this order has invoices; reject or void them first');
    await client.query(`update purchase_order set status = 'cancelled', updated_at = now() where id = $1`, [o.id]);
    if (o.requisition_id) {
      await client.query(`update purchase_requisition set status = 'cancelled', updated_at = now() where id = $1`, [o.requisition_id]);
      await moveBudget(client, o.instance_id, 0, true);
      if (o.instance_id) await appendRecordEvent(client, { tenantId, instanceId: o.instance_id, actorId, type: 'order_cancelled', payload: { order: o.number, reason } });
    }
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'order.cancelled', targetId: o.id, detail: { number: o.number, reason } });
    return { id: o.id, status: 'cancelled' };
  });
}

async function orderFor(client: Client | Pool, tenantId: string, orderId: string, lock = false) {
  if (!UUID.test(orderId)) throw new InvalidInput('no such order');
  const { rows } = await client.query<{
    id: string; number: number; status: string; vendor_id: string; vendor_version: number; total: string; approved_total: string;
    revision: number; agreement_id: string | null; requisition_id: string | null; created_by: string | null; instance_id: string | null; expected_by: string | null;
  }>(`select o.id, o.number, o.status, o.vendor_id, o.vendor_version, o.total, o.approved_total, o.revision, o.agreement_id, o.requisition_id,
             o.created_by, r.instance_id, o.expected_by::text
        from purchase_order o left join purchase_requisition r on r.id = o.requisition_id
       where o.id = $1 and o.tenant_id = $2${lock ? ' for update of o' : ''}`, [orderId, tenantId]);
  if (!rows[0]) throw new InvalidInput('no such order');
  return rows[0];
}

export async function listOrders(pool: Pool, principal: Principal) {
  const { tenantId } = await requireBuyer(pool, principal);
  const { rows } = await pool.query(
    `select o.id, o.number, o.status, o.revision, o.currency, o.total, o.approved_total, o.expected_by, o.delivery_location, o.exception_reason,
            o.created_at, v.name as vendor_name, v.status as vendor_status, r.reference as requisition_reference, g.title as agreement_title,
            a.display_name as created_by_name
       from purchase_order o join vendor v on v.id = o.vendor_id
       left join purchase_requisition r on r.id = o.requisition_id
       left join vendor_agreement g on g.id = o.agreement_id
       left join actor a on a.id = o.created_by
      where o.tenant_id = $1
      order by case o.status when 'pending_approval' then 0 when 'issued' then 1 when 'partially_received' then 2 else 3 end, o.number desc limit 500`, [tenantId]);
  return rows;
}

/** Each line: ordered, accepted, rejected, returned, still to come, invoiced, still to invoice. */
export async function orderLines(client: Client | Pool, orderId: string) {
  const { rows } = await client.query<{
    id: string; line_no: number; description: string; kind: string; quantity: string; unit_price: string;
    accepted: string; rejected: string; returned: string; invoiced: string;
  }>(`select l.id, l.line_no, l.description, l.kind, l.quantity, l.unit_price,
             coalesce((select sum(accepted) from goods_receipt r where r.line_id = l.id), 0) as accepted,
             coalesce((select sum(rejected) from goods_receipt r where r.line_id = l.id), 0) as rejected,
             coalesce((select sum(returned) from goods_receipt r where r.line_id = l.id), 0) as returned,
             coalesce((select sum(il.quantity) from vendor_invoice_line il join vendor_invoice i on i.id = il.invoice_id
                        where il.line_id = l.id and i.status not in ('rejected', 'void')), 0) as invoiced
        from purchase_order_line l where l.order_id = $1 order by l.line_no`, [orderId]);
  return rows.map((l) => {
    const net = round3(Number(l.accepted) - Number(l.returned));
    return {
      id: l.id, lineNo: l.line_no, description: l.description, kind: l.kind, quantity: Number(l.quantity), unitPrice: Number(l.unit_price),
      accepted: Number(l.accepted), rejected: Number(l.rejected), returned: Number(l.returned), netAccepted: net,
      toCome: round3(Math.max(0, Number(l.quantity) - net)), invoiced: Number(l.invoiced), toInvoice: round3(Math.max(0, net - Number(l.invoiced))),
    };
  });
}

export async function orderDetail(pool: Pool, principal: Principal, orderId: string) {
  const { tenantId } = await requireBuyer(pool, principal);
  const o = await orderFor(pool, tenantId, orderId);
  const [lines, revisions, invoices] = await Promise.all([
    orderLines(pool, o.id),
    pool.query(`select r.revision, r.total, r.reason, r.occurred_at, a.display_name as actor_name from purchase_order_revision r left join actor a on a.id = r.actor_id where r.order_id = $1 order by r.revision desc`, [o.id]),
    pool.query(`select id, invoice_no, invoice_date, total, status, mismatches from vendor_invoice where order_id = $1 order by created_at`, [o.id]),
  ]);
  return { ...o, lines, revisions: revisions.rows, invoices: invoices.rows };
}

// --------------------------------------------------------------- receiving

/** PRC-06. Accepted cannot exceed what is still to come; rejected needs a reason. */
export async function receiveGoods(pool: Pool, principal: Principal, orderId: string, body: { lines?: unknown; evidenceRef?: unknown }) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  if (!Array.isArray(body.lines) || !body.lines.length) throw new InvalidInput('say what arrived');
  const evidence = text(body.evidenceRef, 300) || null;
  return inTransaction(pool, async (client) => {
    const o = await orderFor(client, tenantId, orderId, true);
    if (!['issued', 'partially_received'].includes(o.status)) throw new InvalidInput(o.status === 'pending_approval' ? 'this order is waiting for approval; nothing can be received yet' : `a ${o.status} order cannot receive goods`);
    const lines = await orderLines(client, o.id);
    let late = false;
    for (const raw of body.lines as Record<string, unknown>[]) {
      const line = lines.find((l) => l.id === raw?.lineId);
      if (!line) throw new InvalidInput('a received line is not on this order');
      const accepted = round3(num(raw.accepted ?? 0)); const rejected = round3(num(raw.rejected ?? 0));
      if (!(accepted >= 0) || !(rejected >= 0) || accepted + rejected === 0) throw new InvalidInput(`line ${line.lineNo}: give the quantity accepted or rejected`);
      if (accepted > line.toCome) throw new InvalidInput(`line ${line.lineNo}: only ${line.toCome} still to come; ${accepted} cannot be accepted`);
      const reason = text(raw.reason, 500);
      if (rejected > 0 && !reason) throw new InvalidInput(`line ${line.lineNo}: give a reason for the rejected quantity`);
      await client.query(
        `insert into goods_receipt (tenant_id, order_id, line_id, accepted, rejected, reason, evidence_ref, received_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, o.id, line.id, accepted, rejected, reason || null, evidence, actorId]);
      line.toCome = round3(line.toCome - accepted);
    }
    if (o.expected_by && new Date().toISOString().slice(0, 10) > o.expected_by) late = true;
    const status = lines.every((l) => l.toCome <= 0) ? 'received' : 'partially_received';
    await client.query('update purchase_order set status = $2, updated_at = now() where id = $1', [o.id, status]);
    if (o.instance_id) await appendRecordEvent(client, { tenantId, instanceId: o.instance_id, actorId, type: 'goods_received', payload: { order: o.number, status, late } });
    return { id: o.id, status, late };
  });
}

/** Goods sent back after acceptance. Never below what has already been invoiced. */
export async function returnGoods(pool: Pool, principal: Principal, orderId: string, body: { lineId?: unknown; quantity?: unknown; reason?: unknown }) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const quantity = round3(num(body.quantity));
  const reason = text(body.reason, 500);
  if (!(quantity > 0)) throw new InvalidInput('give the quantity returned');
  if (!reason) throw new InvalidInput('give a reason');
  return inTransaction(pool, async (client) => {
    const o = await orderFor(client, tenantId, orderId, true);
    const line = (await orderLines(client, o.id)).find((l) => l.id === body.lineId);
    if (!line) throw new InvalidInput('that line is not on this order');
    if (quantity > line.netAccepted) throw new InvalidInput(`only ${line.netAccepted} accepted on line ${line.lineNo}`);
    if (line.netAccepted - quantity < line.invoiced) throw new InvalidInput(`line ${line.lineNo} has ${line.invoiced} invoiced; ask the supplier for a credit note before returning more`);
    await client.query(`insert into goods_receipt (tenant_id, order_id, line_id, returned, reason, received_by) values ($1, $2, $3, $4, $5, $6)`,
      [tenantId, o.id, line.id, quantity, reason, actorId]);
    if (o.status === 'received') await client.query(`update purchase_order set status = 'partially_received', updated_at = now() where id = $1`, [o.id]);
    return { id: o.id, lineId: line.id, returned: quantity };
  });
}

// ---------------------------------------------------------------- invoices

/**
 * PRC-07. Each line is matched against what was accepted and not yet
 * invoiced, and against the order price within the tolerance; the total
 * within the amount tolerance. Any mismatch holds the invoice, with the
 * reasons, for someone else to decide.
 */
export async function enterInvoice(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const orderId = text(body.orderId, 36);
  const invoiceNo = text(body.invoiceNo, 60);
  const invoiceDate = day(body.invoiceDate, 'invoiceDate');
  if (!invoiceNo) throw new InvalidInput('give the supplier\'s invoice number');
  if (!invoiceDate) throw new InvalidInput('give the invoice date');
  if (!Array.isArray(body.lines) || !body.lines.length) throw new InvalidInput('an invoice needs at least one line');
  const settings = await procurementSettings(pool, tenantId);
  return inTransaction(pool, async (client) => {
    const o = await orderFor(client, tenantId, orderId, true);
    if (['cancelled', 'pending_approval'].includes(o.status)) throw new InvalidInput(`a ${o.status.replace('_', ' ')} order cannot be invoiced`);
    const { rows: dup } = await client.query('select 1 from vendor_invoice where tenant_id = $1 and vendor_id = $2 and lower(invoice_no) = lower($3)', [tenantId, o.vendor_id, invoiceNo]);
    if (dup[0]) throw new InvalidInput(`invoice ${invoiceNo} from this supplier has already been entered`);
    const lines = await orderLines(client, o.id);
    const mismatches: string[] = [];
    const items: { lineId: string; quantity: number; unitPrice: number }[] = [];
    let total = 0; let expected = 0;
    for (const raw of body.lines as Record<string, unknown>[]) {
      const line = lines.find((l) => l.id === raw?.lineId);
      if (!line) throw new InvalidInput('an invoice line is not on this order');
      const quantity = round3(num(raw.quantity)); const unitPrice = round(num(raw.unitPrice));
      if (!(quantity > 0) || !(unitPrice >= 0)) throw new InvalidInput(`line ${line.lineNo}: give quantity and unit price`);
      if (quantity > line.toInvoice) {
        mismatches.push(`Line ${line.lineNo} (${line.description}): invoiced ${quantity}, but only ${line.toInvoice} ${line.kind === 'service' ? 'accepted as done' : 'accepted'} and not yet invoiced`);
      }
      const ceiling = round(line.unitPrice * (1 + settings.priceTolerancePct / 100));
      if (unitPrice > ceiling) mismatches.push(`Line ${line.lineNo} (${line.description}): price ${unitPrice} is above the order price ${line.unitPrice} plus ${settings.priceTolerancePct}%`);
      total = round(total + round(quantity * unitPrice));
      expected = round(expected + round(quantity * line.unitPrice));
      items.push({ lineId: line.id, quantity, unitPrice });
    }
    if (total - expected > settings.amountTolerance && !mismatches.some((m) => m.includes('price'))) {
      mismatches.push(`Total ${total} is ${round(total - expected)} above what the order prices give (${expected})`);
    }
    const stated = body.total === undefined || body.total === '' ? total : round(num(body.total));
    if (Math.abs(stated - total) > 0.01) mismatches.push(`The invoice total ${stated} does not equal its lines (${total})`);
    const status = mismatches.length ? 'held' : 'approved';
    const { rows } = await client.query<{ id: string }>(
      `insert into vendor_invoice (tenant_id, vendor_id, order_id, invoice_no, invoice_date, currency, total, status, mismatches, entered_by, external_ref)
       values ($1, $2, $3, $4, $5, (select currency from purchase_order where id = $3), $6, $7, $8, $9, $10) returning id`,
      [tenantId, o.vendor_id, o.id, invoiceNo, invoiceDate, stated, status, JSON.stringify(mismatches), actorId, text(body.externalRef, 120) || null]);
    for (const it of items) {
      await client.query('insert into vendor_invoice_line (invoice_id, line_id, quantity, unit_price) values ($1, $2, $3, $4)', [rows[0]!.id, it.lineId, it.quantity, it.unitPrice]);
    }
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'invoice.entered', targetId: rows[0]!.id, detail: { order: o.number, invoiceNo, total: stated, status, mismatches: mismatches.length } });
    return { id: rows[0]!.id, status, mismatches, total: stated };
  });
}

/** A held invoice: approved anyway or rejected, with a reason, by someone who did not enter it. */
export async function reviewInvoice(pool: Pool, principal: Principal, invoiceId: string, body: { decision?: unknown; reason?: unknown }) {
  const { tenantId, actorId } = await requireProcAdmin(pool, principal);
  const decision = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : null;
  const reason = text(body.reason, 1000);
  if (!decision) throw new InvalidInput('decide approve or reject');
  if (!reason) throw new InvalidInput('give a reason');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; entered_by: string | null; invoice_no: string }>(
      'select status, entered_by, invoice_no from vendor_invoice where id = $1 and tenant_id = $2 for update', [invoiceId, tenantId]);
    const inv = rows[0];
    if (!inv) throw new InvalidInput('no such invoice');
    if (inv.status !== 'held') throw new InvalidInput('only a held invoice needs a review');
    if (inv.entered_by === actorId) throw new InvalidInput('someone other than the person who entered the invoice must review it');
    await client.query('update vendor_invoice set status = $2, review_reason = $3, reviewed_by = $4, updated_at = now() where id = $1', [invoiceId, decision, reason, actorId]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: `invoice.${decision}`, targetId: invoiceId, detail: { invoiceNo: inv.invoice_no, reason } });
    return { id: invoiceId, status: decision };
  });
}

/** PRC-08: paid only to bank details checked at their current version, which is kept. */
export async function payInvoice(pool: Pool, principal: Principal, invoiceId: string, body: { reference?: unknown }) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  const reference = text(body.reference, 120);
  if (!reference) throw new InvalidInput('give the payment reference');
  const settings = await procurementSettings(pool, tenantId);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; vendor_id: string; order_id: string; invoice_no: string; total: string }>(
      'select status, vendor_id, order_id, invoice_no, total from vendor_invoice where id = $1 and tenant_id = $2 for update', [invoiceId, tenantId]);
    const inv = rows[0];
    if (!inv) throw new InvalidInput('no such invoice');
    if (inv.status !== 'approved') throw new InvalidInput(inv.status === 'held' ? 'this invoice is held; it needs a review first' : `a ${inv.status} invoice cannot be paid`);
    const { rows: b } = await client.query<{ version: number; verified_version: number | null }>('select version, verified_version from vendor_bank where vendor_id = $1', [inv.vendor_id]);
    if (settings.requireVendorBankCheck) {
      if (!b[0]) throw new InvalidInput('the supplier has no bank details');
      if (b[0].verified_version !== b[0].version) throw new InvalidInput('the supplier\'s bank details have changed or were never checked; someone other than whoever entered them must check them first');
    }
    await client.query(`update vendor_invoice set status = 'paid', payment_ref = $2, paid_at = now(), bank_version = $3, updated_at = now() where id = $1`, [invoiceId, reference, b[0]?.version ?? null]);
    const lines = await orderLines(client, inv.order_id);
    const { rows: unpaid } = await client.query<{ n: number }>(`select count(*)::int as n from vendor_invoice where order_id = $1 and status in ('held', 'approved')`, [inv.order_id]);
    if (lines.every((l) => l.toCome <= 0 && l.toInvoice <= 0) && unpaid[0]!.n === 0) {
      await client.query(`update purchase_order set status = 'closed', updated_at = now() where id = $1`, [inv.order_id]);
    }
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'invoice.paid', targetId: invoiceId, detail: { invoiceNo: inv.invoice_no, total: Number(inv.total), reference, bankVersion: b[0]?.version ?? null } });
    return { id: invoiceId, status: 'paid' };
  });
}

export async function listInvoices(pool: Pool, principal: Principal) {
  const { tenantId } = await requireBuyer(pool, principal);
  const { rows } = await pool.query(
    `select i.id, i.invoice_no, i.invoice_date, i.currency, i.total, i.status, i.mismatches, i.review_reason, i.payment_ref, i.paid_at, i.exported_at,
            i.created_at, v.name as vendor_name, o.number as order_number, e.display_name as entered_by_name, r.display_name as reviewed_by_name,
            (b.id is not null and b.verified_version = b.version) as bank_verified
       from vendor_invoice i join vendor v on v.id = i.vendor_id join purchase_order o on o.id = i.order_id
       left join actor e on e.id = i.entered_by left join actor r on r.id = i.reviewed_by
       left join vendor_bank b on b.vendor_id = i.vendor_id
      where i.tenant_id = $1
      order by case i.status when 'held' then 0 when 'approved' then 1 else 2 end, i.created_at desc limit 500`, [tenantId]);
  return rows;
}

/** PRC-12: paid invoices with every reference an accounting system needs. Bank details never. */
export async function exportInvoices(pool: Pool, principal: Principal) {
  const { tenantId, actorId } = await requireBuyer(pool, principal);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      id: string; vendor: string; vendor_ref: string | null; tax_id: string | null; number: number; order_ref: string | null; invoice_no: string;
      invoice_date: string; currency: string; total: string; payment_ref: string | null; paid_at: Date; invoice_ref: string | null; reference: string | null; cost_centre: string | null;
    }>(`select i.id, v.name as vendor, v.external_ref as vendor_ref, v.tax_id, o.number, o.external_ref as order_ref, i.invoice_no, i.invoice_date::text,
               i.currency, i.total, i.payment_ref, i.paid_at, i.external_ref as invoice_ref, r.reference, r.cost_centre
          from vendor_invoice i join vendor v on v.id = i.vendor_id join purchase_order o on o.id = i.order_id
          left join purchase_requisition r on r.id = o.requisition_id
         where i.tenant_id = $1 and i.status = 'paid' and i.exported_at is null order by i.paid_at for update of i`, [tenantId]);
    if (!rows.length) throw new InvalidInput('there are no paid invoices waiting to be exported');
    const header = ['Supplier', 'Supplier ref', 'Tax ID', 'Order', 'Order ref', 'Request', 'Cost centre', 'Invoice', 'Invoice date', 'Currency', 'Amount', 'Paid on', 'Payment reference', 'Invoice ref'];
    const out = rows.map((r) => [r.vendor, r.vendor_ref, r.tax_id, r.number, r.order_ref, r.reference, r.cost_centre, r.invoice_no, r.invoice_date, r.currency, Number(r.total),
      r.paid_at.toISOString().slice(0, 10), r.payment_ref, r.invoice_ref]);
    await client.query('update vendor_invoice set exported_at = now() where id = any($1::uuid[])', [rows.map((r) => r.id)]);
    const total = round(rows.reduce((s, r) => s + Number(r.total), 0));
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'invoices.exported', detail: { invoices: rows.length, total } });
    return { invoices: rows.length, total, filename: `supplier-invoices-${new Date().toISOString().slice(0, 10)}.csv`, csv: tableToCsv({ header, rows: out as never }) };
  });
}

export async function procurementSummary(pool: Pool, principal: Principal) {
  const { tenantId } = await requireBuyer(pool, principal);
  const { rows } = await pool.query<Record<string, string>>(
    `select
       (select count(*) from purchase_requisition where tenant_id = $1 and status in ('approved', 'sourcing')) as to_order,
       (select count(*) from purchase_order where tenant_id = $1 and status = 'pending_approval') as orders_pending,
       (select count(*) from purchase_order where tenant_id = $1 and status in ('issued', 'partially_received')) as orders_open,
       (select count(*) from vendor_invoice where tenant_id = $1 and status = 'held') as invoices_held,
       (select count(*) from vendor_invoice where tenant_id = $1 and status = 'approved') as invoices_to_pay,
       (select coalesce(sum(total), 0) from vendor_invoice where tenant_id = $1 and status = 'approved') as to_pay_amount,
       (select count(*) from vendor where tenant_id = $1 and status in ('draft', 'under_review')) as vendors_to_review,
       (select count(*) from vendor_bank b join vendor v on v.id = b.vendor_id where v.tenant_id = $1 and (b.verified_version is null or b.verified_version <> b.version)) as banks_unchecked`,
    [tenantId]);
  const r = rows[0]!;
  return {
    currency: await baseCurrency(pool, tenantId),
    toOrder: Number(r.to_order), ordersPending: Number(r.orders_pending), ordersOpen: Number(r.orders_open), invoicesHeld: Number(r.invoices_held),
    invoicesToPay: Number(r.invoices_to_pay), toPayAmount: Number(r.to_pay_amount), vendorsToReview: Number(r.vendors_to_review), banksUnchecked: Number(r.banks_unchecked),
  };
}

async function appendRecordEvent(client: Client, args: { tenantId: string; instanceId: string; actorId: string; type: string; payload: unknown }) {
  await client.query('select id from instance where id = $1 for update', [args.instanceId]);
  await client.query(
    `insert into event (tenant_id, instance_id, seq, type, payload, actor, occurred_at)
     values ($1, $2, (select coalesce(max(seq), 0) + 1 from event where instance_id = $2), $3, $4, $5, now())`,
    [args.tenantId, args.instanceId, args.type, JSON.stringify(args.payload), `actor:${args.actorId}`]);
}
