/**
 * The deeper Expenses module: categories with their own rules, per-diem and
 * mileage rate cards per branch or country, payment runs that pay many
 * claims under one bank reference and produce the bank file, reports by
 * category, cost centre, month and claimant, and every big list a page at
 * a time. Finance works here; a claimant sees their own claims and the
 * allowance calculator.
 */
import { createHash } from 'node:crypto';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { enabledModules } from './modules.js';
import { open as unseal } from './secret-box.js';
import { readListQuery, runList, toCsv, type ListSpec } from './listing.js';
import { expenseSettings, moveSettlement } from './expenses.js';

const UUID = /^[0-9a-f-]{36}$/;
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[, ]/g, '')); return Number.isFinite(n) ? n : NaN; };
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const dayOf = (v: unknown, what: string, required = false): string | null => { const s = text(v, 10); if (!s) { if (required) throw new InvalidInput(`${what} is required`); return null; } if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new InvalidInput(`${what} must be a date`); return s; };

interface Who { tenantId: string; actorId: string; email: string; finance: boolean; admin: boolean }
async function who(pool: Pool, principal: Principal, need: 'any' | 'finance' | 'admin' = 'any'): Promise<Who> {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  if (!(await enabledModules(pool, principal.tenantId)).has('expenses')) throw new InvalidInput('the Expenses module is switched off for this workspace');
  const { rows } = await pool.query<{ email: string; workspace_role: string }>('select email, workspace_role from actor where id = $1 and active', [principal.actorId]);
  if (!rows[0]) throw new InvalidInput('signed-in members only');
  const admin = ['owner', 'admin'].includes(rows[0].workspace_role);
  let finance = admin;
  if (!finance) { try { await requireWorkspaceCapability(pool, principal, 'operate', 'expenses'); finance = true; } catch { finance = false; } }
  if (need === 'finance' && !finance) throw new InvalidInput('only Finance can do this');
  if (need === 'admin' && !admin) throw new InvalidInput('only an owner or admin can do this');
  return { tenantId: principal.tenantId, actorId: principal.actorId, email: rows[0].email, finance, admin };
}
async function base(client: Client | Pool, tenantId: string) { const { rows } = await client.query<{ default_currency: string }>('select default_currency from tenant where id = $1', [tenantId]); return rows[0]?.default_currency ?? 'USD'; }

// -------------------------------------------------------------- categories

/** Categories with their rules. Seeded from the settings list the first time, so nothing changes for existing workspaces. */
export async function listCategories(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const settings = await expenseSettings(pool, w.tenantId);
  const { rows: existing } = await pool.query<{ n: number }>('select count(*)::int as n from expense_category where tenant_id = $1', [w.tenantId]);
  if (!existing[0]!.n) {
    for (const [i, key] of settings.categories.entries()) {
      await pool.query('insert into expense_category (tenant_id, key, name, account_code, sort_order) values ($1, $2, $3, $4, $5) on conflict do nothing', [w.tenantId, key, key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '), settings.accountCodes[key] ?? null, i]);
    }
  }
  const { rows } = await pool.query('select id, key, name, account_code, max_per_line, max_per_claim, receipt_required, note_required, active, sort_order from expense_category where tenant_id = $1 order by sort_order, name', [w.tenantId]);
  return { categories: rows, currency: await base(pool, w.tenantId), defaultAccountCode: settings.defaultAccountCode, canEdit: w.admin };
}

/** Save a category and mirror the list and account codes into the settings the claim form reads. */
export async function saveCategory(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal, 'admin');
  const name = text(body.name, 80);
  if (!name) throw new InvalidInput('give the category a name');
  const key = (text(body.key, 40) || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!key) throw new InvalidInput('the category needs a key');
  const cap = (v: unknown, what: string) => { if (v === undefined || v === null || v === '') return null; const n = num(v); if (!(n >= 0)) throw new InvalidInput(`${what} must be a number`); return n; };
  const maxLine = cap(body.maxPerLine, 'maxPerLine'); const maxClaim = cap(body.maxPerClaim, 'maxPerClaim');
  await inTransaction(pool, async (client) => {
    await client.query(
      `insert into expense_category (tenant_id, key, name, account_code, max_per_line, max_per_claim, receipt_required, note_required, active, sort_order) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (tenant_id, key) do update set name = excluded.name, account_code = excluded.account_code, max_per_line = excluded.max_per_line, max_per_claim = excluded.max_per_claim,
         receipt_required = excluded.receipt_required, note_required = excluded.note_required, active = excluded.active, sort_order = excluded.sort_order`,
      [w.tenantId, key, name, text(body.accountCode, 40) || null, maxLine, maxClaim, body.receiptRequired === true, body.noteRequired === true, body.active !== false, Math.trunc(num(body.sortOrder ?? 0)) || 0]);
    await syncSettings(client, w.tenantId, w.actorId);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'expenses.category_saved', detail: { key, maxLine, maxClaim } });
  });
  return { key };
}

async function syncSettings(client: Client, tenantId: string, actorId: string) {
  const { rows } = await client.query<{ key: string; account_code: string | null }>('select key, account_code from expense_category where tenant_id = $1 and active order by sort_order, name', [tenantId]);
  const codes: Record<string, string> = {}; for (const r of rows) if (r.account_code) codes[r.key] = r.account_code;
  await client.query(
    `insert into expense_settings (tenant_id, categories, account_codes, updated_by, updated_at) values ($1, $2, $3, $4, now())
     on conflict (tenant_id) do update set categories = excluded.categories, account_codes = excluded.account_codes, updated_by = excluded.updated_by, updated_at = now()`,
    [tenantId, JSON.stringify(rows.map((r) => r.key)), JSON.stringify(codes), actorId]);
}

// -------------------------------------------------------------- rate cards

/** Per-diem and mileage rates, by branch or country, with the dates they apply. */
export async function listRateCards(pool: Pool, principal: Principal) {
  const w = await who(pool, principal);
  const { rows } = await pool.query(
    `select r.id, r.kind, r.label, r.branch_id, b.name as branch, b.country as branch_country, r.country, r.rate, r.currency, r.unit, r.effective_from::text, r.effective_to::text, r.active
       from expense_rate_card r left join hr_branch b on b.id = r.branch_id where r.tenant_id = $1 order by r.kind, r.active desc, b.name nulls first, r.country nulls first, r.effective_from desc`, [w.tenantId]);
  return { cards: rows, currency: await base(pool, w.tenantId), canEdit: w.admin };
}

export async function saveRateCard(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal, 'admin');
  const kind = text(body.kind, 10);
  if (!['per_diem', 'mileage'].includes(kind)) throw new InvalidInput('kind must be per_diem or mileage');
  const label = text(body.label, 120);
  if (!label) throw new InvalidInput('give the rate a label, like "Lagos per diem" or "Own car"');
  const rate = num(body.rate);
  if (!(rate >= 0)) throw new InvalidInput('give the rate');
  const currency = text(body.currency, 10).toUpperCase() || (await base(pool, w.tenantId));
  if (!/^[A-Z]{3}$/.test(currency)) throw new InvalidInput('currency must be a three-letter ISO code');
  const unit = text(body.unit, 10) || (kind === 'mileage' ? 'km' : 'day');
  if (!(kind === 'mileage' ? ['km', 'mile'] : ['day', 'half_day', 'night']).includes(unit)) throw new InvalidInput(kind === 'mileage' ? 'unit must be km or mile' : 'unit must be day, half_day or night');
  const branchId = body.branchId ? text(body.branchId, 36) : null;
  if (branchId && !UUID.test(branchId)) throw new InvalidInput('branchId must be an id');
  if (branchId) { const { rows: b } = await pool.query('select 1 from hr_branch where id = $1 and tenant_id = $2', [branchId, w.tenantId]); if (!b[0]) throw new InvalidInput('no such branch'); }
  const country = text(body.country, 10).toUpperCase() || null;
  if (country && !/^[A-Z]{2}$/.test(country)) throw new InvalidInput('country must be a two-letter ISO code');
  const from = dayOf(body.effectiveFrom, 'effectiveFrom') ?? new Date().toISOString().slice(0, 10);
  const to = dayOf(body.effectiveTo, 'effectiveTo');
  if (to && to < from) throw new InvalidInput('effectiveTo is before effectiveFrom');
  const id = body.id ? text(body.id, 36) : null;
  if (id) {
    const { rowCount } = await pool.query(
      `update expense_rate_card set kind = $3, label = $4, branch_id = $5, country = $6, rate = $7, currency = $8, unit = $9, effective_from = $10, effective_to = $11, active = $12 where id = $1 and tenant_id = $2`,
      [id, w.tenantId, kind, label, branchId, country, rate, currency, unit, from, to, body.active !== false]);
    if (!rowCount) throw new InvalidInput('no such rate card');
    return { id };
  }
  const { rows } = await pool.query<{ id: string }>(
    `insert into expense_rate_card (tenant_id, kind, label, branch_id, country, rate, currency, unit, effective_from, effective_to, active, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [w.tenantId, kind, label, branchId, country, rate, currency, unit, from, to, body.active !== false, w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'expenses.rate_card_saved', targetId: rows[0]!.id, detail: { kind, label, rate, currency } });
  return { id: rows[0]!.id };
}

/** What a trip is worth: the rate that applies to the person's branch (or its country, or anywhere) on the date, times the quantity. */
export async function allowance(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal);
  const kind = params.get('kind') === 'mileage' ? 'mileage' : 'per_diem';
  const quantity = num(params.get('quantity') ?? 1);
  if (!(quantity >= 0)) throw new InvalidInput('quantity must be a number');
  const on = dayOf(params.get('date'), 'date') ?? new Date().toISOString().slice(0, 10);
  let branchId = params.get('branch') && UUID.test(params.get('branch')!) ? params.get('branch') : null;
  let country: string | null = null;
  if (!branchId) {
    const { rows } = await pool.query<{ branch_id: string | null }>('select branch_id from employee_record where tenant_id = $1 and actor_id = $2', [w.tenantId, w.actorId]);
    branchId = rows[0]?.branch_id ?? null;
  }
  if (branchId) { const { rows } = await pool.query<{ country: string }>('select country from hr_branch where id = $1', [branchId]); country = rows[0]?.country ?? null; }
  const { rows } = await pool.query<{ id: string; label: string; rate: string; currency: string; unit: string; branch_id: string | null; country: string | null }>(
    `select id, label, rate, currency, unit, branch_id, country from expense_rate_card
      where tenant_id = $1 and kind = $2 and active and effective_from <= $3 and (effective_to is null or effective_to >= $3)
        and (branch_id = $4 or (branch_id is null and (country = $5 or country is null)))
      order by (branch_id is not null) desc, (country is not null) desc, effective_from desc`, [w.tenantId, kind, on, branchId, country]);
  const card = rows[0];
  if (!card) return { kind, quantity, card: null, amount: null, currency: await base(pool, w.tenantId), options: rows };
  return { kind, quantity, card, amount: round(Number(card.rate) * quantity), currency: card.currency, options: rows };
}

// ------------------------------------------------------------ payment runs

async function nextRunNo(client: Client, tenantId: string) {
  const { rows } = await client.query<{ n: number }>('select coalesce(max(run_no), 0)::int + 1 as n from expense_payment_run where tenant_id = $1', [tenantId]);
  return rows[0]!.n;
}

/** Gather claims that are ready to pay (bank checked when the policy says so) into one run. */
export async function createPaymentRun(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await who(pool, principal, 'finance');
  const settings = await expenseSettings(pool, w.tenantId);
  const ids = body.settlementIds === 'all' ? null : Array.isArray(body.settlementIds) ? body.settlementIds.map((x) => text(x, 36)).filter((x) => UUID.test(x)) : [];
  if (ids && !ids.length) throw new InvalidInput('choose the claims to pay, or all');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; amount: string; currency: string; ok: boolean }>(
      `select s.id, s.amount, s.currency,
              (not $3 or (b.id is not null and s.beneficiary_verified_version = b.version and s.beneficiary_id = b.id)) as ok
         from expense_settlement s left join expense_beneficiary b on b.tenant_id = s.tenant_id and lower(b.holder) = lower(s.claimant)
        where s.tenant_id = $1 and s.status in ('awaiting_payment', 'failed') and s.payment_run_id is null and ($2::uuid[] is null or s.id = any($2::uuid[]))
        for update of s`, [w.tenantId, ids, settings.requireVerifiedBeneficiary]);
    const ready = rows.filter((r) => r.ok);
    const skipped = rows.length - ready.length;
    if (!ready.length) throw new InvalidInput(skipped ? `None of those claims has checked bank details; ${skipped} skipped.` : 'There is nothing ready to pay.');
    const currency = ready[0]!.currency;
    if (ready.some((r) => r.currency !== currency)) throw new InvalidInput('A run pays one currency at a time; choose claims in the same currency.');
    const total = round(ready.reduce((t, r) => t + Number(r.amount), 0));
    const runNo = await nextRunNo(client, w.tenantId);
    const { rows: run } = await client.query<{ id: string }>(
      `insert into expense_payment_run (tenant_id, run_no, currency, count, total, note, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [w.tenantId, runNo, currency, ready.length, total, text(body.note, 300) || null, w.actorId]);
    await client.query('update expense_settlement set payment_run_id = $2, updated_at = now() where id = any($1::uuid[])', [ready.map((r) => r.id), run[0]!.id]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'expenses.payment_run_created', targetId: run[0]!.id, detail: { runNo, count: ready.length, total, currency, skipped } });
    return { id: run[0]!.id, runNo, count: ready.length, total, currency, skipped };
  });
}

export async function paymentRun(pool: Pool, principal: Principal, runId: string) {
  const w = await who(pool, principal, 'finance');
  if (!UUID.test(runId)) throw new InvalidInput('no such run');
  const { rows } = await pool.query(`select r.*, a.display_name as created_by_name, p.display_name as paid_by_name from expense_payment_run r left join actor a on a.id = r.created_by left join actor p on p.id = r.paid_by where r.id = $1 and r.tenant_id = $2`, [runId, w.tenantId]);
  if (!rows[0]) throw new InvalidInput('no such run');
  const { rows: items } = await pool.query(
    `select s.id, s.instance_id, s.amount, s.currency, s.status, s.reference, coalesce(i.data->>'claimant_name', s.claimant) as claimant_name, s.claimant, i.data->>'cost_centre' as cost_centre, i.data->>'category' as category,
            b.bank_name, b.account_last4 from expense_settlement s join instance i on i.id = s.instance_id left join expense_beneficiary b on b.tenant_id = s.tenant_id and lower(b.holder) = lower(s.claimant)
      where s.payment_run_id = $1 order by claimant_name`, [runId]);
  return { ...rows[0], items };
}

/** The file for the bank: one line per claim with the full account number. Finance admins only; every generation is logged. */
export async function paymentRunBankFile(pool: Pool, principal: Principal, runId: string) {
  const w = await who(pool, principal, 'admin');
  const run = await paymentRun(pool, principal, runId) as { run_no: number; currency: string; items: { id: string; amount: string; claimant: string; claimant_name: string }[] };
  const { rows: bens } = await pool.query<{ id: string; holder: string; account_name: string; bank_name: string; bank_code: string | null; account_sealed: string }>(
    'select id, holder, account_name, bank_name, bank_code, account_sealed from expense_beneficiary where tenant_id = $1', [w.tenantId]);
  const byHolder = new Map(bens.map((b) => [b.holder.toLowerCase(), b]));
  const lines = run.items.map((it) => {
    const b = byHolder.get(it.claimant.toLowerCase());
    return { claimant: it.claimant_name, account_name: b?.account_name ?? '', bank: b?.bank_name ?? '', bank_code: b?.bank_code ?? '', account: b ? unseal(b.account_sealed, b.id).plaintext : '', amount: Number(it.amount).toFixed(2), currency: run.currency, reference: `RUN-${run.run_no}-${it.id.slice(0, 8).toUpperCase()}` };
  });
  const csv = toCsv(lines, [['claimant', 'Payee'], ['account_name', 'Account name'], ['bank', 'Bank'], ['bank_code', 'Bank code'], ['account', 'Account number'], ['amount', 'Amount'], ['currency', 'Currency'], ['reference', 'Reference']].map(([key, label]) => ({ key: key!, label: label! })));
  const checksum = createHash('sha256').update(csv).digest('hex');
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'expenses.bank_file_generated', targetId: runId, detail: { runNo: run.run_no, lines: lines.length, checksum } });
  return { filename: `payment-run-${run.run_no}.csv`, csv, checksum, lines: lines.length };
}

/** Mark the run paid: every claim in it gets the bank reference, through the same rule as paying one by one. */
export async function settlePaymentRun(pool: Pool, principal: Principal, runId: string, body: Record<string, unknown>) {
  const w = await who(pool, principal, 'finance');
  const reference = text(body.reference, 120);
  if (!reference) throw new InvalidInput('give the bank reference for the run');
  const run = await paymentRun(pool, principal, runId) as { status: string; items: { id: string; status: string }[] };
  if (run.status !== 'draft') throw new InvalidInput('this run is already closed');
  const failed: string[] = [];
  for (const it of run.items) {
    if (it.status === 'paid') continue;
    try { await moveSettlement(pool, principal, it.id, { to: 'paid', reference }); } catch (err) { failed.push(err instanceof Error ? err.message : String(err)); }
  }
  if (failed.length) throw new InvalidInput(`${failed.length} claim(s) could not be paid: ${failed[0]}`);
  await pool.query(`update expense_payment_run set status = 'paid', reference = $3, paid_by = $4, paid_at = now() where id = $1 and tenant_id = $2`, [runId, w.tenantId, reference, w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'expenses.payment_run_paid', targetId: runId, detail: { reference, count: run.items.length } });
  return { id: runId, status: 'paid', paid: run.items.length };
}

export async function cancelPaymentRun(pool: Pool, principal: Principal, runId: string) {
  const w = await who(pool, principal, 'finance');
  return inTransaction(pool, async (client) => {
    const { rowCount } = await client.query(`update expense_payment_run set status = 'cancelled' where id = $1 and tenant_id = $2 and status = 'draft'`, [runId, w.tenantId]);
    if (!rowCount) throw new InvalidInput('only a draft run can be cancelled');
    await client.query('update expense_settlement set payment_run_id = null, updated_at = now() where payment_run_id = $1', [runId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'expenses.payment_run_cancelled', targetId: runId, detail: {} });
    return { id: runId, status: 'cancelled' };
  });
}

// ----------------------------------------------------------------- reports

/** Spend over a period, in the workspace currency: by month, category, cost centre, claimant and status. */
export async function expenseReport(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal, 'finance');
  const to = dayOf(params.get('to'), 'to') ?? new Date().toISOString().slice(0, 10);
  const from = dayOf(params.get('from'), 'from') ?? new Date(new Date(`${to}T00:00:00Z`).getTime() - 365 * 86400000).toISOString().slice(0, 10);
  const p = [w.tenantId, from, to];
  const where = `s.tenant_id = $1 and s.created_at::date between $2 and $3 and s.status <> 'void'`;
  const q = async (sql: string) => (await pool.query<{ key: string; n: number; total: string }>(sql, p)).rows.map((r) => ({ key: r.key ?? '—', count: Number(r.n), total: Number(r.total) }));
  const [byMonth, byCategory, byCostCentre, byClaimant, byStatus, totals] = await Promise.all([
    q(`select to_char(s.created_at, 'YYYY-MM') as key, count(*)::int as n, coalesce(sum(s.amount), 0) as total from expense_settlement s where ${where} group by 1 order by 1`),
    q(`select i.data->>'category' as key, count(*)::int as n, coalesce(sum(s.amount), 0) as total from expense_settlement s join instance i on i.id = s.instance_id where ${where} group by 1 order by 3 desc`),
    q(`select i.data->>'cost_centre' as key, count(*)::int as n, coalesce(sum(s.amount), 0) as total from expense_settlement s join instance i on i.id = s.instance_id where ${where} group by 1 order by 3 desc`),
    q(`select coalesce(i.data->>'claimant_name', s.claimant) as key, count(*)::int as n, coalesce(sum(s.amount), 0) as total from expense_settlement s join instance i on i.id = s.instance_id where ${where} group by 1 order by 3 desc limit 10`),
    q(`select s.status as key, count(*)::int as n, coalesce(sum(s.amount), 0) as total from expense_settlement s where ${where} group by 1 order by 1`),
    pool.query<{ claims: string; total: string; paid: string; avg: string; reduced: string; reduced_by: string }>(
      `select count(*) as claims, coalesce(sum(amount), 0) as total, coalesce(sum(amount) filter (where status = 'paid'), 0) as paid, coalesce(avg(amount), 0) as avg,
              count(*) filter (where approved_amount is not null and requested_amount is not null and approved_amount < requested_amount) as reduced,
              coalesce(sum(requested_amount - approved_amount) filter (where approved_amount is not null and requested_amount is not null), 0) as reduced_by
         from expense_settlement s where ${where}`, p),
  ]);
  const t = totals.rows[0]!;
  const { rows: adv } = await pool.query<{ open: string; held: string; overdue: string }>(`select count(*) filter (where status in ('disbursed', 'awaiting_return')) as open, coalesce(sum(outstanding) filter (where status in ('disbursed', 'awaiting_return')), 0) as held, count(*) filter (where status in ('disbursed', 'awaiting_return') and due_at < now()) as overdue from cash_advance where tenant_id = $1`, [w.tenantId]);
  return { from, to, currency: await base(pool, w.tenantId), totals: { claims: Number(t.claims), total: Number(t.total), paid: Number(t.paid), average: round(Number(t.avg)), reduced: Number(t.reduced), reducedBy: Number(t.reduced_by) }, advances: { open: Number(adv[0]!.open), held: Number(adv[0]!.held), overdue: Number(adv[0]!.overdue) }, byMonth, byCategory, byCostCentre, byClaimant, byStatus };
}

// ------------------------------------------------------------------- lists

type Cols = { key: string; label: string }[];
const cols = (pairs: [string, string][]): Cols => pairs.map(([key, label]) => ({ key, label }));
async function paged(pool: Pool, w: Who, params: URLSearchParams, args: { spec: ListSpec; select: string; from: string; base: string[]; params: unknown[]; csv: { name: string; columns: Cols }; facets?: string }) {
  const query = readListQuery(params, args.spec);
  const page = await runList<Record<string, unknown>>(pool, { ...args, query });
  if (query.format === 'csv') {
    await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: `expenses.${args.csv.name}_exported`, detail: { rows: page.total, q: query.q, filters: query.filters } });
    return { filename: `${args.csv.name}-${new Date().toISOString().slice(0, 10)}.csv`, csv: toCsv(page.rows, args.csv.columns), rows: page.total };
  }
  const facets = args.facets ? (await pool.query(args.facets, [args.params[0]])).rows : [];
  return { ...page, facets };
}

const CLAIMS: ListSpec = { defaultSort: 'created_at:desc', columns: {
  claimant: { sql: `coalesce(i.data->>'claimant_name', s.claimant)`, sortable: true, searchable: true },
  email: { sql: 's.claimant', searchable: true },
  amount: { sql: 's.amount', sortable: true, filters: { amount_min: 'num_min', amount_max: 'num_max' } },
  status: { sql: 's.status', sortable: true, filters: { status: 'in' } },
  category: { sql: `i.data->>'category'`, sortable: true, filters: { category: 'in' } },
  cost_centre: { sql: `i.data->>'cost_centre'`, sortable: true, searchable: true, filters: { cost_centre: 'in' } },
  purpose: { sql: `i.data->>'business_purpose'`, searchable: true },
  reference: { sql: 's.reference', searchable: true },
  bank: { sql: `(b.id is not null and s.beneficiary_verified_version = b.version and s.beneficiary_id = b.id)`, filters: { bank_checked: 'bool' } },
  run: { sql: 'r.run_no', sortable: true, filters: { run: 'eq' } },
  created_at: { sql: 's.created_at', sortable: true, filters: { from: 'date_from', to: 'date_to' } },
  paid_at: { sql: 's.paid_at', sortable: true },
} };

export async function searchClaims(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal, 'finance');
  return paged(pool, w, params, {
    spec: CLAIMS, params: [w.tenantId], base: ['s.tenant_id = $1'],
    select: `s.id, s.instance_id, s.claimant, coalesce(i.data->>'claimant_name', s.claimant) as claimant_name, s.amount, s.currency, s.status, s.reference, s.note, s.paid_at, s.created_at,
             s.requested_amount, s.approved_amount, s.advance_applied, s.original_currency, s.original_amount, s.fx_rate, s.exported_at, e.batch_no as export_batch, r.run_no, s.payment_run_id,
             i.data->>'category' as category, i.data->>'cost_centre' as cost_centre, i.data->>'business_purpose' as purpose, i.data->>'expense_date' as expense_date, a.reference as advance_reference,
             b.account_last4 as bank_last4, b.bank_name, (b.id is not null and s.beneficiary_verified_version = b.version and s.beneficiary_id = b.id) as bank_verified,
             (s.beneficiary_verified_version is not null and (b.id is null or s.beneficiary_verified_version <> b.version or s.beneficiary_id <> b.id)) as bank_changed`,
    from: `expense_settlement s join instance i on i.id = s.instance_id left join cash_advance a on a.id = s.advance_id left join expense_export e on e.id = s.export_id left join expense_payment_run r on r.id = s.payment_run_id
           left join expense_beneficiary b on b.tenant_id = s.tenant_id and lower(b.holder) = lower(s.claimant)`,
    csv: { name: 'claims', columns: cols([['claimant_name', 'Claimant'], ['claimant', 'Email'], ['expense_date', 'Expense date'], ['category', 'Category'], ['cost_centre', 'Cost centre'], ['amount', 'To pay'], ['currency', 'Currency'], ['requested_amount', 'Claimed'], ['approved_amount', 'Approved'], ['status', 'Status'], ['reference', 'Payment reference'], ['run_no', 'Run'], ['paid_at', 'Paid'], ['created_at', 'Approved on']]) },
    facets: `select 'status' as kind, status as id, status as name, count(*)::int as n from expense_settlement where tenant_id = $1 group by status
             union all select 'category', i.data->>'category', i.data->>'category', count(*)::int from expense_settlement s join instance i on i.id = s.instance_id where s.tenant_id = $1 and i.data->>'category' is not null group by 2
             union all select 'cost_centre', i.data->>'cost_centre', i.data->>'cost_centre', count(*)::int from expense_settlement s join instance i on i.id = s.instance_id where s.tenant_id = $1 and i.data->>'cost_centre' is not null group by 2 order by 1, 3`,
  });
}

const ADVANCES: ListSpec = { defaultSort: 'created_at:desc', columns: {
  holder: { sql: 'a.holder', sortable: true, searchable: true },
  reference: { sql: 'a.reference', sortable: true, searchable: true },
  status: { sql: 'a.status', sortable: true, filters: { status: 'in' } },
  amount: { sql: 'a.amount', sortable: true },
  outstanding: { sql: 'a.outstanding', sortable: true },
  due_at: { sql: 'a.due_at', sortable: true, filters: { due_from: 'date_from', due_to: 'date_to' } },
  overdue: { sql: `(a.status in ('disbursed', 'awaiting_return') and a.due_at < now())`, filters: { overdue: 'bool' } },
  created_at: { sql: 'a.created_at', sortable: true },
} };

export async function searchAdvances(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal, 'finance');
  return paged(pool, w, params, {
    spec: ADVANCES, params: [w.tenantId], base: ['a.tenant_id = $1'],
    select: `a.id, a.instance_id, a.reference, a.holder, coalesce(i.data->>'claimant_name', a.holder) as holder_name, a.amount, a.currency, a.status, a.outstanding, a.spent, a.returned, a.disbursed_at, a.due_at, a.created_at,
             (a.status in ('disbursed', 'awaiting_return') and a.due_at < now()) as overdue, i.data->>'purpose' as purpose`,
    from: 'cash_advance a join instance i on i.id = a.instance_id',
    csv: { name: 'advances', columns: cols([['holder_name', 'Holder'], ['reference', 'Reference'], ['amount', 'Advanced'], ['currency', 'Currency'], ['spent', 'Spent'], ['returned', 'Returned'], ['outstanding', 'Held'], ['status', 'Status'], ['due_at', 'Retire by']]) },
    facets: `select 'status' as kind, status as id, status as name, count(*)::int as n from cash_advance where tenant_id = $1 group by status order by 3`,
  });
}

const RUNS: ListSpec = { defaultSort: 'run_no:desc', columns: {
  run_no: { sql: 'r.run_no', sortable: true, searchable: true },
  status: { sql: 'r.status', sortable: true, filters: { status: 'in' } },
  total: { sql: 'r.total', sortable: true },
  count: { sql: 'r.count', sortable: true },
  reference: { sql: 'r.reference', searchable: true },
  created_at: { sql: 'r.created_at', sortable: true, filters: { from: 'date_from', to: 'date_to' } },
  paid_at: { sql: 'r.paid_at', sortable: true },
} };

export async function searchPaymentRuns(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal, 'finance');
  return paged(pool, w, params, {
    spec: RUNS, params: [w.tenantId], base: ['r.tenant_id = $1'],
    select: 'r.id, r.run_no, r.status, r.currency, r.count, r.total, r.reference, r.note, r.created_at, r.paid_at, a.display_name as created_by_name',
    from: 'expense_payment_run r left join actor a on a.id = r.created_by',
    csv: { name: 'payment-runs', columns: cols([['run_no', 'Run'], ['status', 'Status'], ['count', 'Claims'], ['total', 'Total'], ['currency', 'Currency'], ['reference', 'Reference'], ['created_at', 'Created'], ['paid_at', 'Paid']]) },
    facets: `select 'status' as kind, status as id, status as name, count(*)::int as n from expense_payment_run where tenant_id = $1 group by status order by 3`,
  });
}

const MINE: ListSpec = { defaultSort: 'created_at:desc', columns: {
  purpose: { sql: `i.data->>'business_purpose'`, searchable: true },
  category: { sql: `i.data->>'category'`, sortable: true, filters: { category: 'in' } },
  amount: { sql: `(i.data->>'expense_total')::numeric`, sortable: true },
  state: { sql: 'i.state', sortable: true, filters: { state: 'in' } },
  expense_date: { sql: `i.data->>'expense_date'`, sortable: true, filters: { from: 'date_from', to: 'date_to' } },
  created_at: { sql: 'i.created_at', sortable: true },
  paid: { sql: 's.status', filters: { paid: 'in' } },
} };

/** A person's own claims, whatever their state, with the payment that followed. */
export async function searchMyClaims(pool: Pool, principal: Principal, params: URLSearchParams) {
  const w = await who(pool, principal);
  return paged(pool, w, params, {
    spec: MINE, params: [w.tenantId, w.email.toLowerCase()], base: [`i.tenant_id = $1`, `i.process_key = 'staff_expense_claim'`, `lower(i.data->>'employee_email') = $2`],
    select: `i.id, i.state, i.outcome, i.created_at, i.completed_at, i.data->>'business_purpose' as purpose, i.data->>'category' as category, i.data->>'cost_centre' as cost_centre, i.data->>'expense_date' as expense_date,
             (i.data->>'expense_total')::numeric as amount, coalesce(nullif(i.data->>'claim_currency', ''), (select default_currency from tenant where id = i.tenant_id)) as currency,
             s.status as settlement_status, s.amount as to_pay, s.paid_at, s.reference`,
    from: 'instance i left join expense_settlement s on s.instance_id = i.id',
    csv: { name: 'my-claims', columns: cols([['expense_date', 'Date'], ['category', 'Category'], ['purpose', 'Purpose'], ['amount', 'Claimed'], ['currency', 'Currency'], ['state', 'Stage'], ['settlement_status', 'Payment'], ['paid_at', 'Paid']]) },
  });
}
