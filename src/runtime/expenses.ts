/**
 * The Expenses module (PRD Module 5): policy, currency, budgets, line
 * decisions, settlement, advances, bank details and the accounting export.
 *
 * Four moments matter:
 *   1. Submission (`applyFinancePolicy`, then `reserveBudget` inside the
 *      submission's transaction). The workspace's policy is copied onto the
 *      claim, converted into the claim's currency at the rate in force now;
 *      the rate itself and the amount in the workspace currency are kept on
 *      the record (EXP-04). The receipt rule, categories and any advance
 *      being retired are checked. A budget for the cost centre is reserved
 *      atomically: an enforced budget refuses a claim it cannot cover, and
 *      two claims arriving together cannot both take the last of it (EXP-05).
 *   2. Approval (`recordFinanceOutcome`, called by the engine in the same
 *      transaction). A claim gets a settlement awaiting payment; an advance
 *      gets its own record. The budget hold becomes consumed. A process that
 *      ends any other way releases its hold (`releaseFinanceHolds`).
 *   3. Review. Finance may approve, reduce or reject single lines before
 *      paying (EXP-07). The submitted amounts are never changed; the amount
 *      to pay, the advance set against it and the budget follow.
 *   4. Payment. Finance checks the claimant's bank details (EXP-09), then
 *      records paid with a reference, or failed, or void (EXP-08). A change
 *      of bank details after the check needs a fresh check. Paid claims go
 *      out in numbered export batches with account codes (EXP-10).
 *
 * Money is decimal in the database and rounded to two places here.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Blueprint } from '../blueprint/index.js';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { enabledModules } from './modules.js';
import { open as unseal, seal } from './secret-box.js';
import { tableToCsv } from './export.js';
import { procurementSettings } from './procurement.js';
import type { Answers } from './expr.js';

export interface ExpenseSettings {
  categories: string[];
  autoApproveLimit: number;
  managerLimit: number;
  lineLimit: number;
  receiptThreshold: number;
  advanceRetirementDays: number;
  accountCodes: Record<string, string>;
  defaultAccountCode: string | null;
  requireVerifiedBeneficiary: boolean;
  updatedAt: Date | null;
}

const DEFAULTS: ExpenseSettings = {
  categories: ['travel', 'accommodation', 'subsistence', 'equipment', 'training', 'other'],
  autoApproveLimit: 100,
  managerLimit: 1000,
  lineLimit: 200,
  receiptThreshold: 0,
  advanceRetirementDays: 14,
  accountCodes: {},
  defaultAccountCode: null,
  requireVerifiedBeneficiary: true,
  updatedAt: null,
};

/** Thrown inside the submission transaction so the instance rolls back with it. */
export class BudgetExceeded extends Error {
  constructor(readonly field: string, message: string) { super(message); }
}

const UUID = /^[0-9a-f-]{36}$/;
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------------------------------------------------------------- settings

export async function expenseSettings(client: Client | Pool, tenantId: string): Promise<ExpenseSettings> {
  const { rows } = await client.query<{
    categories: string[]; auto_approve_limit: string; manager_limit: string; line_limit: string;
    receipt_threshold: string; advance_retirement_days: number; account_codes: Record<string, string>;
    default_account_code: string | null; require_verified_beneficiary: boolean; updated_at: Date;
  }>('select * from expense_settings where tenant_id = $1', [tenantId]);
  const r = rows[0];
  if (!r) return { ...DEFAULTS };
  return {
    categories: r.categories,
    autoApproveLimit: Number(r.auto_approve_limit),
    managerLimit: Number(r.manager_limit),
    lineLimit: Number(r.line_limit),
    receiptThreshold: Number(r.receipt_threshold),
    advanceRetirementDays: r.advance_retirement_days,
    accountCodes: r.account_codes ?? {},
    defaultAccountCode: r.default_account_code,
    requireVerifiedBeneficiary: r.require_verified_beneficiary,
    updatedAt: r.updated_at,
  };
}

async function baseCurrency(client: Client | Pool, tenantId: string): Promise<string> {
  const { rows } = await client.query<{ default_currency: string }>('select default_currency from tenant where id = $1', [tenantId]);
  return rows[0]?.default_currency ?? 'GBP';
}

async function requireModule(pool: Pool, principal: Principal): Promise<string> {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  if (!(await enabledModules(pool, principal.tenantId)).has('expenses')) {
    throw new InvalidInput('the Expenses module is switched off for this workspace — an owner can switch it on in Settings');
  }
  return principal.tenantId;
}

/** Finance staff: anyone who may operate processes in this workspace. */
async function requireFinance(pool: Pool, principal: Principal): Promise<{ tenantId: string; actorId: string }> {
  const tenantId = await requireModule(pool, principal);
  await requireWorkspaceCapability(pool, principal, 'operate', 'expenses');
  if (principal.kind !== 'actor') throw new Error('unreachable');
  return { tenantId, actorId: principal.actorId };
}

/** Budgets serve both Expenses and Procurement: either module being on is enough. */
async function requireBudgetModule(pool: Pool, principal: Principal, capability: 'operate' | 'administer') {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  const on = await enabledModules(pool, principal.tenantId);
  if (!on.has('expenses') && !on.has('procurement')) {
    throw new InvalidInput('budgets need the Expenses or Procurement module switched on');
  }
  await requireWorkspaceCapability(pool, principal, capability, 'budgets');
  return { tenantId: principal.tenantId, actorId: principal.actorId };
}

async function requireFinanceAdmin(pool: Pool, principal: Principal): Promise<{ tenantId: string; actorId: string }> {
  const tenantId = await requireModule(pool, principal);
  await requireWorkspaceCapability(pool, principal, 'administer', 'expenses');
  if (principal.kind !== 'actor') throw new Error('unreachable');
  return { tenantId, actorId: principal.actorId };
}

async function emailOf(client: Client | Pool, actorId: string): Promise<string> {
  const { rows } = await client.query<{ email: string }>('select email from actor where id = $1', [actorId]);
  return rows[0]?.email ?? '';
}

export async function readExpenseSettings(pool: Pool, principal: Principal) {
  const tenantId = await requireModule(pool, principal);
  return { ...(await expenseSettings(pool, tenantId)), currency: await baseCurrency(pool, tenantId) };
}

export async function updateExpenseSettings(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const { tenantId, actorId } = await requireFinanceAdmin(pool, principal);
  const current = await expenseSettings(pool, tenantId);
  const amount = (key: string, fallback: number) => {
    if (body[key] === undefined) return fallback;
    if (body[key] === null || String(body[key]).trim() === '') throw new InvalidInput(`${key} must be an amount`);
    const n = num(body[key]);
    if (n < 0 || n > 1e12) throw new InvalidInput(`${key} must be a positive amount`);
    return round(n);
  };
  let categories = current.categories;
  if (body.categories !== undefined) {
    if (!Array.isArray(body.categories) || !body.categories.length || body.categories.length > 50) {
      throw new InvalidInput('categories must be a list of 1 to 50 names');
    }
    categories = [...new Set(body.categories.map((c) => String(c).trim().toLowerCase().replace(/\s+/g, '_')))];
    if (categories.some((c) => !/^[a-z][a-z0-9_]{0,39}$/.test(c))) throw new InvalidInput('each category must be a short name of letters, digits or underscores');
  }
  let accountCodes = current.accountCodes;
  if (body.accountCodes !== undefined) {
    if (!body.accountCodes || typeof body.accountCodes !== 'object' || Array.isArray(body.accountCodes)) throw new InvalidInput('accountCodes must map categories to codes');
    accountCodes = {};
    for (const [k, v] of Object.entries(body.accountCodes as Record<string, unknown>)) {
      const code = text(v, 40);
      if (code && !/^[A-Za-z0-9.\-_/]+$/.test(code)) throw new InvalidInput(`account code for ${k} may use letters, digits and . - _ / only`);
      if (code) accountCodes[k] = code;
    }
  }
  const defaultAccountCode = body.defaultAccountCode === undefined ? current.defaultAccountCode : (text(body.defaultAccountCode, 40) || null);
  const next = {
    categories,
    autoApproveLimit: amount('autoApproveLimit', current.autoApproveLimit),
    managerLimit: amount('managerLimit', current.managerLimit),
    lineLimit: amount('lineLimit', current.lineLimit),
    receiptThreshold: amount('receiptThreshold', current.receiptThreshold),
    advanceRetirementDays: body.advanceRetirementDays === undefined ? current.advanceRetirementDays : Math.trunc(num(body.advanceRetirementDays)),
    accountCodes,
    defaultAccountCode,
    requireVerifiedBeneficiary: body.requireVerifiedBeneficiary === undefined ? current.requireVerifiedBeneficiary : body.requireVerifiedBeneficiary === true,
  };
  if (next.advanceRetirementDays < 1 || next.advanceRetirementDays > 365) throw new InvalidInput('advanceRetirementDays must be 1 to 365');
  if (next.autoApproveLimit > next.managerLimit) throw new InvalidInput('the auto-approve limit cannot be above the manager limit');
  await inTransaction(pool, async (client) => {
    await client.query(
      `insert into expense_settings (tenant_id, categories, auto_approve_limit, manager_limit, line_limit, receipt_threshold,
         advance_retirement_days, account_codes, default_account_code, require_verified_beneficiary, updated_by, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       on conflict (tenant_id) do update set categories = excluded.categories, auto_approve_limit = excluded.auto_approve_limit,
         manager_limit = excluded.manager_limit, line_limit = excluded.line_limit, receipt_threshold = excluded.receipt_threshold,
         advance_retirement_days = excluded.advance_retirement_days, account_codes = excluded.account_codes,
         default_account_code = excluded.default_account_code, require_verified_beneficiary = excluded.require_verified_beneficiary,
         updated_by = excluded.updated_by, updated_at = now()`,
      [tenantId, JSON.stringify(next.categories), next.autoApproveLimit, next.managerLimit, next.lineLimit, next.receiptThreshold,
        next.advanceRetirementDays, JSON.stringify(next.accountCodes), next.defaultAccountCode, next.requireVerifiedBeneficiary, actorId]);
    await recordWorkspaceAudit(client, {
      tenantId, actorId, action: 'expenses.settings_changed',
      detail: { ...next, categories: next.categories.join(', '), accountCodes: Object.entries(next.accountCodes).map(([k, v]) => `${k}=${v}`).join(', ') },
    });
  });
  return readExpenseSettings(pool, principal);
}

// ---------------------------------------------------------- exchange rates

export async function listRates(pool: Pool, principal: Principal) {
  const tenantId = await requireModule(pool, principal);
  const { rows } = await pool.query(
    `select r.id, r.from_currency, r.to_currency, r.rate, r.effective_from, r.source, r.created_at, a.display_name as entered_by
       from exchange_rate r left join actor a on a.id = r.entered_by
      where r.tenant_id = $1 order by r.from_currency, r.effective_from desc limit 500`, [tenantId]);
  return rows;
}

/** A rate from a foreign currency into the workspace currency. Rates are never edited: a new one supersedes. */
export async function addRate(pool: Pool, principal: Principal, body: { from?: unknown; rate?: unknown; source?: unknown; effectiveFrom?: unknown }) {
  const { tenantId, actorId } = await requireFinanceAdmin(pool, principal);
  const from = text(body.from, 3).toUpperCase();
  const to = await baseCurrency(pool, tenantId);
  if (!/^[A-Z]{3}$/.test(from)) throw new InvalidInput('from must be a three-letter currency code');
  if (from === to) throw new InvalidInput(`${to} is the workspace currency; it needs no rate`);
  const rate = num(body.rate);
  if (!(rate > 0) || rate > 1e9) throw new InvalidInput('rate must be a positive number: how many units of the workspace currency one unit buys');
  const source = text(body.source, 120);
  if (!source) throw new InvalidInput('say where the rate comes from (for example: CBN official rate, 19 Oct)');
  const effectiveFrom = body.effectiveFrom ? new Date(String(body.effectiveFrom)) : new Date();
  if (Number.isNaN(effectiveFrom.getTime())) throw new InvalidInput('effectiveFrom must be a date');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into exchange_rate (tenant_id, from_currency, to_currency, rate, effective_from, source, entered_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`, [tenantId, from, to, rate, effectiveFrom, source, actorId]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'expenses.rate_added', detail: { from, to, rate, source, effectiveFrom } });
    return { id: rows[0]!.id, from, to, rate, effectiveFrom, source };
  });
}

async function rateFor(client: Client | Pool, tenantId: string, from: string, to: string, at: Date): Promise<{ rate: number; source: string; effectiveFrom: Date } | null> {
  if (from === to) return { rate: 1, source: 'same currency', effectiveFrom: at };
  const { rows } = await client.query<{ rate: string; source: string; effective_from: Date }>(
    `select rate, source, effective_from from exchange_rate
      where tenant_id = $1 and from_currency = $2 and to_currency = $3 and effective_from <= $4
      order by effective_from desc, created_at desc limit 1`, [tenantId, from, to, at]);
  return rows[0] ? { rate: Number(rows[0].rate), source: rows[0].source, effectiveFrom: rows[0].effective_from } : null;
}

// ----------------------------------------------------------------- budgets

export async function listBudgets(pool: Pool, principal: Principal) {
  const { tenantId } = await requireBudgetModule(pool, principal, 'operate');
  const { rows } = await pool.query(
    `select b.id, b.cost_centre, b.period_start, b.period_end, b.amount, b.mode, b.updated_at,
            coalesce(sum(r.amount) filter (where r.status = 'reserved'), 0) as reserved,
            coalesce(sum(r.amount) filter (where r.status = 'consumed'), 0) as consumed
       from expense_budget b left join budget_reservation r on r.budget_id = b.id
      where b.tenant_id = $1
      group by b.id order by b.period_start desc, b.cost_centre`, [tenantId]);
  return rows.map((r) => ({
    ...r,
    available: round(Number(r.amount) - Number(r.reserved) - Number(r.consumed)),
  }));
}

/** One budget per cost centre per period start; saving again changes the amount or mode. */
export async function saveBudget(pool: Pool, principal: Principal, body: {
  costCentre?: unknown; periodStart?: unknown; periodEnd?: unknown; amount?: unknown; mode?: unknown;
}) {
  const { tenantId, actorId } = await requireBudgetModule(pool, principal, 'administer');
  const costCentre = text(body.costCentre, 60);
  if (!costCentre) throw new InvalidInput('costCentre is required');
  const start = text(body.periodStart, 10); const end = text(body.periodEnd, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) throw new InvalidInput('give a period start and end as dates, end not before start');
  if (body.amount === undefined || String(body.amount).trim() === '') throw new InvalidInput('amount is required');
  const amount = round(num(body.amount));
  if (amount < 0) throw new InvalidInput('amount cannot be negative');
  const mode = body.mode === 'enforced' ? 'enforced' : 'advisory';
  return inTransaction(pool, async (client) => {
    const { rows: overlap } = await client.query(
      `select 1 from expense_budget where tenant_id = $1 and cost_centre = $2 and period_start <> $3::date
         and daterange(period_start, period_end, '[]') && daterange($3::date, $4::date, '[]')`,
      [tenantId, costCentre, start, end]);
    if (overlap[0]) throw new InvalidInput(`another ${costCentre} budget already covers part of that period`);
    const { rows } = await client.query<{ id: string }>(
      `insert into expense_budget (tenant_id, cost_centre, period_start, period_end, amount, mode, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (tenant_id, cost_centre, period_start) do update
         set period_end = excluded.period_end, amount = excluded.amount, mode = excluded.mode, updated_at = now()
       returning id`, [tenantId, costCentre, start, end, amount, mode, actorId]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'expenses.budget_saved', targetId: rows[0]!.id, detail: { costCentre, start, end, amount, mode } });
    return { id: rows[0]!.id, costCentre, periodStart: start, periodEnd: end, amount, mode };
  });
}

async function budgetFor(client: Client | Pool, tenantId: string, costCentre: string, at: Date) {
  const { rows } = await client.query<{ id: string; amount: string; mode: 'advisory' | 'enforced' }>(
    `select id, amount, mode from expense_budget
      where tenant_id = $1 and cost_centre = $2 and period_start <= $3::date and period_end >= $3::date limit 1`,
    [tenantId, costCentre, at.toISOString().slice(0, 10)]);
  return rows[0] ?? null;
}

/**
 * Inside the submission's transaction: lock the budget row, count what is
 * held against it, and hold this claim's amount. An enforced budget throws
 * BudgetExceeded, which rolls the submission back. The row lock is what
 * stops two claims arriving together from both taking the last of it.
 */
export async function reserveBudget(client: Client, args: {
  tenantId: string; instanceId: string; budgetId: string; amount: number; field: string;
}): Promise<{ over: boolean; available: number; mode: string }> {
  const { rows } = await client.query<{ amount: string; mode: string; cost_centre: string }>(
    'select amount, mode, cost_centre from expense_budget where id = $1 for update', [args.budgetId]);
  const budget = rows[0];
  if (!budget) return { over: false, available: 0, mode: 'none' };
  const { rows: used } = await client.query<{ held: string }>(
    `select coalesce(sum(amount), 0) as held from budget_reservation where budget_id = $1 and status in ('reserved', 'consumed')`, [args.budgetId]);
  const available = round(Number(budget.amount) - Number(used[0]!.held));
  const over = args.amount > available;
  if (over && budget.mode === 'enforced') {
    throw new BudgetExceeded(args.field, `The ${budget.cost_centre} budget has ${available.toFixed(2)} left, and this claim needs ${args.amount.toFixed(2)}. Ask Finance.`);
  }
  await client.query(
    `insert into budget_reservation (tenant_id, budget_id, instance_id, amount, over_budget) values ($1, $2, $3, $4, $5)
     on conflict (instance_id) do nothing`,
    [args.tenantId, args.budgetId, args.instanceId, args.amount, over]);
  return { over, available, mode: budget.mode };
}

/** A finance process that ended without success gives back what it held. */
export async function releaseFinanceHolds(client: Client, instanceId: string): Promise<void> {
  await client.query(
    `update budget_reservation set status = 'released', updated_at = now() where instance_id = $1 and status <> 'released'`, [instanceId]);
}

// -------------------------------------------------------------- submission

export interface PolicyResult {
  answers: Answers;
  rejected: string[];
  problems: string[];
  budget: { budgetId: string; amount: number; field: string } | null;
}

/**
 * Copies the policy onto the answers and checks the rules a form cannot.
 * Each refused field has a reason at the same index, so the form can say why.
 */
export async function applyFinancePolicy(
  pool: Pool,
  args: { bp: Blueprint; tenantId: string; answers: Answers; submitterEmail: string | null; now?: Date },
): Promise<PolicyResult> {
  const finance = args.bp.finance;
  if (!finance) return { answers: args.answers, rejected: [], problems: [], budget: null };
  const now = args.now ?? new Date();
  const settings = await expenseSettings(pool, args.tenantId);
  const base = await baseCurrency(pool, args.tenantId);
  const answers: Answers = { ...args.answers };
  const rejected: string[] = [];
  const problems: string[] = [];
  const refuse = (field: string, why: string) => { rejected.push(field); problems.push(why); };

  // EXP-04: the claim's currency and the rate into the workspace currency.
  let rate = 1;
  if (finance.currencyField) {
    const raw = answers[finance.currencyField];
    const currency = typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : base;
    if (!/^[A-Z]{3}$/.test(currency)) {
      refuse(finance.currencyField, 'Give the currency as a three-letter code, such as USD.');
    } else {
      answers[finance.currencyField] = currency;
      const found = await rateFor(pool, args.tenantId, currency, base, now);
      if (!found) refuse(finance.currencyField, `There is no ${currency} to ${base} exchange rate on file. Ask Finance to add one.`);
      else rate = found.rate;
    }
  }
  const amount = num(answers[finance.amountField]);
  const baseAmount = round(amount * rate);
  if (finance.fxRateField) answers[finance.fxRateField] = rate;
  if (finance.baseAmountField) answers[finance.baseAmountField] = baseAmount;

  // The limits are in the workspace currency; the routing compares them with
  // amounts in the claim's currency, so they are converted at the same rate.
  const inClaimCurrency = (limit: number) => round(limit / rate);
  if (finance.policy.autoApproveLimit) answers[finance.policy.autoApproveLimit] = inClaimCurrency(settings.autoApproveLimit);
  // A purchase request is routed by Procurement's own manager limit.
  const managerLimit = finance.kind === 'purchase' ? (await procurementSettings(pool, args.tenantId)).managerLimit : settings.managerLimit;
  if (finance.policy.managerLimit) answers[finance.policy.managerLimit] = inClaimCurrency(managerLimit);
  if (finance.policy.lineLimit) answers[finance.policy.lineLimit] = inClaimCurrency(settings.lineLimit);

  if (finance.receiptField && baseAmount > settings.receiptThreshold) {
    const receipt = answers[finance.receiptField];
    if (receipt === undefined || receipt === null || String(receipt).trim() === '') {
      refuse(finance.receiptField, `A receipt is needed for claims over ${settings.receiptThreshold} ${base}.`);
    }
  }
  if (finance.categoryField) {
    const category = answers[finance.categoryField];
    if (typeof category === 'string' && category && !settings.categories.includes(category)) {
      refuse(finance.categoryField, `"${category}" is not a category Finance accepts.`);
    }
  }
  if (finance.advanceReferenceField) {
    const ref = answers[finance.advanceReferenceField];
    if (typeof ref === 'string' && ref.trim()) {
      const { rows } = await pool.query<{ holder: string; status: string }>(
        'select holder, status from cash_advance where tenant_id = $1 and upper(reference) = upper($2)', [args.tenantId, ref.trim()]);
      const advance = rows[0];
      if (!advance || !args.submitterEmail || advance.holder.toLowerCase() !== args.submitterEmail.toLowerCase()) {
        refuse(finance.advanceReferenceField, 'That advance reference is not one of your advances.');
      } else if (!['disbursed', 'awaiting_return'].includes(advance.status)) {
        refuse(finance.advanceReferenceField, advance.status === 'approved' ? 'That advance has not been paid out yet.' : 'That advance is already settled.');
      }
    }
  }

  // EXP-05: the budget is found here; it is held inside the transaction.
  let budget: PolicyResult['budget'] = null;
  if (finance.costCentreField && !rejected.length) {
    const costCentre = answers[finance.costCentreField];
    if (typeof costCentre === 'string' && costCentre) {
      const found = await budgetFor(pool, args.tenantId, costCentre, now);
      if (found) budget = { budgetId: found.id, amount: baseAmount, field: finance.costCentreField };
    }
  }
  return { answers, rejected, problems, budget };
}

// ---------------------------------------------------------------- approval

async function currentBeneficiary(client: Client | Pool, tenantId: string, holder: string) {
  const { rows } = await client.query<{ id: string; version: number }>(
    'select id, version from expense_beneficiary where tenant_id = $1 and lower(holder) = lower($2)', [tenantId, holder]);
  return rows[0] ?? null;
}

/**
 * Called by the engine, inside the transition's transaction, when a finance
 * process reaches its success state. Idempotent on the instance.
 */
export async function recordFinanceOutcome(
  client: Client,
  args: { bp: Blueprint; instanceId: string; tenantId: string; data: Answers; submitter: string; now: Date },
): Promise<{ type: string; payload: unknown }[]> {
  const finance = args.bp.finance;
  if (!finance) return [];
  const currency = await baseCurrency(client, args.tenantId);
  const amount = round(num(args.data[finance.amountField]));

  if (finance.kind === 'advance') {
    const reference = `ADV-${args.instanceId.slice(0, 8).toUpperCase()}`;
    const { rows } = await client.query<{ id: string }>(
      `insert into cash_advance (tenant_id, instance_id, reference, holder, amount, currency, outstanding)
       values ($1, $2, $3, $4, $5, $6, $5) on conflict (instance_id) do nothing returning id`,
      [args.tenantId, args.instanceId, reference, args.submitter, amount, currency]);
    if (!rows[0]) return [];
    return [{ type: 'advance_recorded', payload: { reference, amount, currency, status: 'approved' } }];
  }

  if (finance.kind === 'hiring') {
    // HR-01: an approved hiring request opens a requisition for its hires.
    // The budget hold becomes consumed at the estimated cost.
    const requested = finance.baseAmountField ? round(num(args.data[finance.baseAmountField])) : amount;
    const reference = `HR-${args.instanceId.slice(0, 8).toUpperCase()}`;
    const position = (finance.titleField ? text(args.data[finance.titleField], 200) : '') || 'Position';
    const headcount = Math.max(1, Math.trunc(num(finance.headcountField ? args.data[finance.headcountField] : 1) || 1));
    const costCentre = finance.costCentreField ? text(args.data[finance.costCentreField], 60) || null : null;
    const { rows } = await client.query<{ id: string }>(
      `insert into hiring_requisition (tenant_id, instance_id, reference, position, headcount, cost_centre, amount)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (instance_id) do nothing returning id`,
      [args.tenantId, args.instanceId, reference, position, headcount, costCentre, requested]);
    await client.query(
      `update budget_reservation set status = 'consumed', amount = $2, updated_at = now() where instance_id = $1 and status = 'reserved'`,
      [args.instanceId, requested]);
    return rows[0] ? [{ type: 'hiring_opened', payload: { reference, position, headcount } }] : [];
  }

  if (finance.kind === 'purchase') {
    // PRC-03: an approved request becomes a requisition waiting to be sourced.
    // The budget hold becomes consumed at the requested amount; the order and
    // the invoices adjust it later.
    const requested = finance.baseAmountField ? round(num(args.data[finance.baseAmountField])) : amount;
    const reference = `PR-${args.instanceId.slice(0, 8).toUpperCase()}`;
    const title = finance.titleField ? text(args.data[finance.titleField], 200) || null : null;
    const neededBy = finance.neededByField && typeof args.data[finance.neededByField] === 'string' ? String(args.data[finance.neededByField]).slice(0, 10) : null;
    const costCentre = finance.costCentreField ? text(args.data[finance.costCentreField], 60) || null : null;
    const { rows } = await client.query<{ id: string }>(
      `insert into purchase_requisition (tenant_id, instance_id, reference, requester, title, amount, currency, cost_centre, needed_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (instance_id) do nothing returning id`,
      [args.tenantId, args.instanceId, reference, args.submitter, title, requested, currency, costCentre, neededBy]);
    await client.query(
      `update budget_reservation set status = 'consumed', amount = $2, updated_at = now() where instance_id = $1 and status = 'reserved'`,
      [args.instanceId, requested]);
    return rows[0] ? [{ type: 'requisition_opened', payload: { reference, amount: requested, currency } }] : [];
  }

  const rate = finance.fxRateField ? num(args.data[finance.fxRateField]) || 1 : 1;
  const originalCurrency = finance.currencyField ? String(args.data[finance.currencyField] ?? currency) : currency;
  const requested = finance.baseAmountField ? round(num(args.data[finance.baseAmountField])) : amount;

  let applied = 0;
  let advanceId: string | null = null;
  const events: { type: string; payload: unknown }[] = [];
  const ref = finance.advanceReferenceField ? args.data[finance.advanceReferenceField] : null;
  if (typeof ref === 'string' && ref.trim()) {
    const { rows } = await client.query<{ id: string; reference: string; outstanding: string; status: string }>(
      `select id, reference, outstanding, status from cash_advance where tenant_id = $1 and upper(reference) = upper($2) for update`,
      [args.tenantId, ref.trim()]);
    const advance = rows[0];
    if (advance && ['disbursed', 'awaiting_return'].includes(advance.status)) {
      const held = Number(advance.outstanding);
      applied = round(Math.min(held, requested));
      const left = round(held - applied);
      advanceId = advance.id;
      await client.query(
        `update cash_advance set outstanding = $2::numeric, spent = spent + $3::numeric,
           status = case when $2::numeric = 0 then 'retired' else 'awaiting_return' end, updated_at = now() where id = $1`,
        [advance.id, left, applied]);
      await client.query(
        `insert into advance_movement (tenant_id, advance_id, kind, amount, instance_id, occurred_at) values ($1, $2, 'spent', $3, $4, $5)`,
        [args.tenantId, advance.id, applied, args.instanceId, args.now]);
      events.push({ type: 'advance_retired', payload: { advance: advance.reference, applied, stillToReturn: left, payable: round(requested - applied) } });
    }
  }
  const payable = round(requested - applied);
  const beneficiary = await currentBeneficiary(client, args.tenantId, args.submitter);
  const { rows } = await client.query<{ id: string }>(
    `insert into expense_settlement (tenant_id, instance_id, claimant, amount, currency, advance_id, status,
       requested_amount, approved_amount, advance_applied, original_currency, original_amount, fx_rate, beneficiary_id, beneficiary_version)
     values ($1, $2, $3, $4::numeric, $5, $6, case when $4::numeric = 0 then 'paid' else 'awaiting_payment' end,
       $7, $7, $8, $9, $10, $11, $12, $13)
     on conflict (instance_id) do nothing returning id`,
    [args.tenantId, args.instanceId, args.submitter, payable, currency, advanceId, requested, applied,
      originalCurrency, amount, rate, beneficiary?.id ?? null, beneficiary?.version ?? null]);
  await client.query(
    `update budget_reservation set status = 'consumed', amount = $2, updated_at = now() where instance_id = $1 and status = 'reserved'`,
    [args.instanceId, requested]);
  if (rows[0]) {
    events.push({
      type: 'settlement_opened',
      payload: { amount: payable, currency, status: payable === 0 ? 'paid' : 'awaiting_payment',
        ...(originalCurrency !== currency ? { originalAmount: amount, originalCurrency, rate } : {}) },
    });
  }
  return events;
}

// ------------------------------------------------------------ line review

/**
 * EXP-07. Finance approves, reduces or rejects single lines before paying.
 * The claim as submitted never changes. The approved total is recomputed in
 * the workspace currency at the rate kept on the claim; if less was approved
 * than was set against an advance, the difference goes back on the advance;
 * the budget follows the approved amount.
 */
export async function reviewLines(pool: Pool, principal: Principal, settlementId: string, body: { lines?: unknown }) {
  const { tenantId, actorId } = await requireFinance(pool, principal);
  if (!UUID.test(settlementId)) throw new InvalidInput('no such settlement');
  if (!Array.isArray(body.lines) || !body.lines.length) throw new InvalidInput('send the lines you are deciding');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      status: string; instance_id: string; claimant: string; advance_id: string | null; advance_applied: string;
      fx_rate: string | null; export_id: string | null;
    }>(`select status, instance_id, claimant, advance_id, advance_applied, fx_rate, export_id from expense_settlement
         where id = $1 and tenant_id = $2 for update`, [settlementId, tenantId]);
    const s = rows[0];
    if (!s) throw new InvalidInput('no such settlement');
    if (!['awaiting_payment', 'failed'].includes(s.status)) throw new InvalidInput('lines can only be changed before the claim is paid');
    if (s.claimant.toLowerCase() === (await emailOf(client, actorId)).toLowerCase()) throw new InvalidInput('you cannot review your own claim');
    const { rows: inst } = await client.query<{ data: Answers; process_version_id: string }>(
      'select data, process_version_id from instance where id = $1 for update', [s.instance_id]);
    const { rows: ver } = await client.query<{ blueprint: Blueprint }>('select blueprint from process_version where id = $1', [inst[0]!.process_version_id]);
    const finance = ver[0]!.blueprint.finance;
    if (!finance?.linesField || !finance.lineAmountField) throw new InvalidInput('this process has no lines to review');
    const lines = (inst[0]!.data[finance.linesField] as Record<string, unknown>[] | undefined) ?? [];
    const rate = Number(s.fx_rate ?? 1) || 1;

    const decided: { index: number; requested: number; approved: number; status: string; reason: string | null }[] = [];
    for (const raw of body.lines as Record<string, unknown>[]) {
      const index = Math.trunc(num(raw?.index));
      if (!Number.isInteger(index) || index < 0 || index >= lines.length) throw new InvalidInput(`line ${raw?.index} does not exist`);
      const requested = round(num(lines[index]![finance.lineAmountField]));
      const approved = raw?.approved === undefined ? requested : round(num(raw.approved));
      if (approved < 0 || approved > requested) throw new InvalidInput(`line ${index + 1}: approve between 0 and ${requested}`);
      const reason = text(raw?.reason, 300) || null;
      if (approved < requested && !reason) throw new InvalidInput(`line ${index + 1}: give a reason for approving less than claimed`);
      const status = approved === requested ? 'approved' : approved === 0 ? 'rejected' : 'reduced';
      await client.query(
        `insert into expense_line_decision (tenant_id, instance_id, line_index, requested, approved, status, reason, decided_by, decided_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now())
         on conflict (instance_id, line_index) do update set approved = excluded.approved, status = excluded.status,
           reason = excluded.reason, decided_by = excluded.decided_by, decided_at = now()`,
        [tenantId, s.instance_id, index, requested, approved, status, reason, actorId]);
      decided.push({ index, requested, approved, status, reason });
    }

    // Approved total, in the claim's currency then the workspace's.
    const { rows: all } = await client.query<{ line_index: number; approved: string }>(
      'select line_index, approved from expense_line_decision where instance_id = $1', [s.instance_id]);
    const byIndex = new Map(all.map((d) => [d.line_index, Number(d.approved)]));
    const approvedOriginal = round(lines.reduce((sum, line, i) => sum + (byIndex.has(i) ? byIndex.get(i)! : num(line[finance.lineAmountField!])), 0));
    const approvedBase = round(approvedOriginal * rate);
    const oldApplied = Number(s.advance_applied);
    const newApplied = round(Math.min(oldApplied, approvedBase));
    const giveBack = round(oldApplied - newApplied);
    if (giveBack > 0 && s.advance_id) {
      await client.query(
        `update cash_advance set outstanding = outstanding + $2::numeric, spent = spent - $2::numeric, status = 'awaiting_return', updated_at = now() where id = $1`,
        [s.advance_id, giveBack]);
      await client.query(
        `insert into advance_movement (tenant_id, advance_id, kind, amount, instance_id, actor_id) values ($1, $2, 'spent_reversed', $3, $4, $5)`,
        [tenantId, s.advance_id, giveBack, s.instance_id, actorId]);
    }
    const payable = round(approvedBase - newApplied);
    const status = payable > 0 ? s.status : newApplied > 0 ? 'paid' : 'void';
    await client.query(
      `update expense_settlement set approved_amount = $3, advance_applied = $4, amount = $5, status = $6,
         note = case when $6 = 'void' then 'Every line was rejected' when $6 = 'paid' and status <> 'paid' then 'Covered in full by the advance' else note end,
         updated_by = $7, updated_at = now() where id = $1 and tenant_id = $2`,
      [settlementId, tenantId, approvedBase, newApplied, payable, status, actorId]);
    await client.query(
      `update budget_reservation set amount = $2, status = case when $3 then 'released' else status end, updated_at = now()
        where instance_id = $1 and status <> 'released'`,
      [s.instance_id, approvedBase, status === 'void']);
    await appendRecordEvent(client, {
      tenantId, instanceId: s.instance_id, actorId, type: 'lines_reviewed',
      payload: { lines: decided, approvedOriginal, approvedBase, advanceApplied: newApplied, returnedToAdvance: giveBack, payable, status },
    });
    return { id: settlementId, approvedAmount: approvedBase, amount: payable, status, lines: decided };
  });
}

export async function settlementLines(pool: Pool, principal: Principal, settlementId: string) {
  const { tenantId } = await requireFinance(pool, principal);
  const { rows } = await pool.query<{ instance_id: string; fx_rate: string | null; original_currency: string | null; process_version_id: string; data: Answers }>(
    `select s.instance_id, s.fx_rate, s.original_currency, i.process_version_id, i.data
       from expense_settlement s join instance i on i.id = s.instance_id where s.id = $1 and s.tenant_id = $2`, [settlementId, tenantId]);
  const s = rows[0];
  if (!s) throw new InvalidInput('no such settlement');
  const { rows: ver } = await pool.query<{ blueprint: Blueprint }>('select blueprint from process_version where id = $1', [s.process_version_id]);
  const finance = ver[0]!.blueprint.finance;
  if (!finance?.linesField || !finance.lineAmountField) return { currency: s.original_currency, rate: Number(s.fx_rate ?? 1), lines: [] };
  const { rows: dec } = await pool.query<{ line_index: number; approved: string; status: string; reason: string | null }>(
    'select line_index, approved, status, reason from expense_line_decision where instance_id = $1', [s.instance_id]);
  const byIndex = new Map(dec.map((d) => [d.line_index, d]));
  const lines = ((s.data[finance.linesField] as Record<string, unknown>[] | undefined) ?? []).map((line, index) => {
    const d = byIndex.get(index);
    const requested = round(num(line[finance.lineAmountField!]));
    return {
      index,
      description: finance.lineDescriptionField ? String(line[finance.lineDescriptionField] ?? '') : `Line ${index + 1}`,
      requested,
      approved: d ? Number(d.approved) : requested,
      status: d?.status ?? 'pending',
      reason: d?.reason ?? null,
    };
  });
  return { currency: s.original_currency, rate: Number(s.fx_rate ?? 1), lines };
}

// --------------------------------------------------------- bank details

function mask(last4: string) { return `•••• ${last4}`; }

/**
 * EXP-09. A person enters their own bank details; an administrator may enter
 * them for someone else. The account number is sealed and bound to the row,
 * and every change bumps the version, which means any payment checked
 * against the old details must be checked again.
 */
export async function saveBeneficiary(pool: Pool, principal: Principal, body: {
  holder?: unknown; accountName?: unknown; bankName?: unknown; bankCode?: unknown; accountNumber?: unknown;
}) {
  const tenantId = await requireModule(pool, principal);
  if (principal.kind !== 'actor') throw new Error('unreachable');
  const myEmail = await emailOf(pool, principal.actorId);
  const holder = body.holder ? text(body.holder, 200) : myEmail;
  if (holder.toLowerCase() !== myEmail.toLowerCase()) await requireWorkspaceCapability(pool, principal, 'administer', 'expenses');
  const accountName = text(body.accountName, 120);
  const bankName = text(body.bankName, 120);
  const bankCode = text(body.bankCode, 20) || null;
  const accountNumber = text(body.accountNumber, 40).replace(/[\s-]/g, '').toUpperCase();
  if (!accountName || !bankName) throw new InvalidInput('give the account name and the bank');
  if (!/^[A-Z0-9]{6,34}$/.test(accountNumber)) throw new InvalidInput('the account number should be 6 to 34 letters or digits');
  if (bankCode && !/^[A-Za-z0-9-]{2,20}$/.test(bankCode)) throw new InvalidInput('the bank or sort code should be letters, digits or dashes');
  const { rows: member } = await pool.query('select 1 from actor where tenant_id = $1 and lower(email) = lower($2)', [tenantId, holder]);
  if (!member[0]) throw new InvalidInput('no such member');

  return inTransaction(pool, async (client) => {
    const { rows: existing } = await client.query<{ id: string; version: number }>(
      'select id, version from expense_beneficiary where tenant_id = $1 and lower(holder) = lower($2) for update', [tenantId, holder]);
    const id = existing[0]?.id ?? randomUUID();
    const sealed = seal(accountNumber, id);
    const last4 = accountNumber.slice(-4);
    let version = 1;
    if (existing[0]) {
      version = existing[0].version + 1;
      await client.query(
        `update expense_beneficiary set account_name = $2, bank_name = $3, bank_code = $4, account_sealed = $5, account_last4 = $6,
           version = $7, updated_by = $8, updated_at = now() where id = $1`,
        [id, accountName, bankName, bankCode, sealed, last4, version, principal.actorId]);
    } else {
      await client.query(
        `insert into expense_beneficiary (id, tenant_id, holder, account_name, bank_name, bank_code, account_sealed, account_last4, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, tenantId, holder, accountName, bankName, bankCode, sealed, last4, principal.actorId]);
    }
    // Every unpaid claim of theirs now points at the new details, unchecked.
    const { rows: affected } = await client.query<{ instance_id: string; was_verified: boolean }>(
      `update expense_settlement set beneficiary_id = $3, beneficiary_version = $4
        where tenant_id = $1 and lower(claimant) = lower($2) and status in ('awaiting_payment', 'failed')
        returning instance_id, (beneficiary_verified_version is not null) as was_verified`,
      [tenantId, holder, id, version]);
    for (const a of affected.filter((x) => x.was_verified)) {
      await appendRecordEvent(client, { tenantId, instanceId: a.instance_id, actorId: principal.actorId, type: 'beneficiary_changed',
        payload: { version, note: 'Bank details changed after they were checked; they must be checked again before payment.' } });
    }
    await recordWorkspaceAudit(client, { tenantId, actorId: principal.actorId, action: 'beneficiary.changed', targetId: holder,
      detail: { version, bankName, last4, unpaidClaimsAffected: affected.length } });
    return { holder, accountName, bankName, bankCode, account: mask(last4), version, unpaidClaimsAffected: affected.length };
  });
}

export async function myBeneficiary(pool: Pool, principal: Principal) {
  const tenantId = await requireModule(pool, principal);
  if (principal.kind !== 'actor') throw new Error('unreachable');
  const { rows } = await pool.query<{ account_name: string; bank_name: string; bank_code: string | null; account_last4: string; version: number; updated_at: Date }>(
    'select account_name, bank_name, bank_code, account_last4, version, updated_at from expense_beneficiary where tenant_id = $1 and lower(holder) = lower($2)',
    [tenantId, await emailOf(pool, principal.actorId)]);
  const b = rows[0];
  return b ? { accountName: b.account_name, bankName: b.bank_name, bankCode: b.bank_code, account: mask(b.account_last4), version: b.version, updatedAt: b.updated_at } : null;
}

/** Finance checks the details before paying. Not by the claimant themselves. */
export async function verifyBeneficiary(pool: Pool, principal: Principal, settlementId: string) {
  const { tenantId, actorId } = await requireFinance(pool, principal);
  if (!UUID.test(settlementId)) throw new InvalidInput('no such settlement');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ claimant: string; instance_id: string; status: string }>(
      'select claimant, instance_id, status from expense_settlement where id = $1 and tenant_id = $2 for update', [settlementId, tenantId]);
    const s = rows[0];
    if (!s) throw new InvalidInput('no such settlement');
    if (!['awaiting_payment', 'failed'].includes(s.status)) throw new InvalidInput('this claim is not waiting for payment');
    if (s.claimant.toLowerCase() === (await emailOf(client, actorId)).toLowerCase()) throw new InvalidInput('you cannot check the bank details on your own claim');
    const b = await currentBeneficiary(client, tenantId, s.claimant);
    if (!b) throw new InvalidInput('the claimant has not given bank details yet');
    await client.query(
      `update expense_settlement set beneficiary_id = $2, beneficiary_version = $3, beneficiary_verified_version = $3,
         beneficiary_verified_by = $4, beneficiary_verified_at = now() where id = $1`,
      [settlementId, b.id, b.version, actorId]);
    await appendRecordEvent(client, { tenantId, instanceId: s.instance_id, actorId, type: 'beneficiary_verified', payload: { version: b.version } });
    return { id: settlementId, verifiedVersion: b.version };
  });
}

/** The full details, for making the payment. Audited every time. */
export async function revealBeneficiary(pool: Pool, principal: Principal, settlementId: string) {
  const { tenantId, actorId } = await requireFinance(pool, principal);
  const { rows } = await pool.query<{ claimant: string }>('select claimant from expense_settlement where id = $1 and tenant_id = $2', [settlementId, tenantId]);
  if (!rows[0]) throw new InvalidInput('no such settlement');
  const { rows: b } = await pool.query<{ id: string; account_name: string; bank_name: string; bank_code: string | null; account_sealed: string; version: number }>(
    'select id, account_name, bank_name, bank_code, account_sealed, version from expense_beneficiary where tenant_id = $1 and lower(holder) = lower($2)',
    [tenantId, rows[0].claimant]);
  if (!b[0]) throw new InvalidInput('the claimant has not given bank details yet');
  const accountNumber = unseal(b[0].account_sealed, b[0].id).plaintext;
  await recordWorkspaceAudit(pool, { tenantId, actorId, action: 'beneficiary.revealed', targetId: rows[0].claimant, detail: { settlementId, version: b[0].version } });
  return { accountName: b[0].account_name, bankName: b[0].bank_name, bankCode: b[0].bank_code, accountNumber, version: b[0].version };
}

// ----------------------------------------------------------------- payment

export async function listSettlements(pool: Pool, principal: Principal, status?: string) {
  const { tenantId } = await requireFinance(pool, principal);
  const { rows } = await pool.query(
    `select s.id, s.instance_id, s.claimant, s.amount, s.currency, s.status, s.reference, s.note,
            s.paid_at, s.created_at, s.updated_at, a.reference as advance_reference, i.process_key,
            s.requested_amount, s.approved_amount, s.advance_applied, s.original_currency, s.original_amount, s.fx_rate,
            s.exported_at, e.batch_no as export_batch,
            coalesce(i.data->>'claimant_name', s.claimant) as claimant_name,
            b.account_last4 as bank_last4, b.bank_name, b.version as bank_version,
            (b.id is not null and s.beneficiary_verified_version = b.version and s.beneficiary_id = b.id) as bank_verified,
            (s.beneficiary_verified_version is not null and (b.id is null or s.beneficiary_verified_version <> b.version or s.beneficiary_id <> b.id)) as bank_changed
       from expense_settlement s
       join instance i on i.id = s.instance_id
       left join cash_advance a on a.id = s.advance_id
       left join expense_export e on e.id = s.export_id
       left join expense_beneficiary b on b.tenant_id = s.tenant_id and lower(b.holder) = lower(s.claimant)
      where s.tenant_id = $1 and ($2::text is null or s.status = $2)
      order by case s.status when 'failed' then 0 when 'awaiting_payment' then 1 else 2 end, s.created_at desc
      limit 500`,
    [tenantId, status ?? null]);
  return rows;
}

const SETTLEMENT_MOVES: Record<string, string[]> = {
  paid: ['awaiting_payment', 'failed'],
  failed: ['awaiting_payment'],
  void: ['awaiting_payment', 'failed'],
};

/**
 * EXP-08, EXP-09, EXP-11. Paid needs a reference and, when the policy says
 * so, bank details checked at their current version. Failed and void need a
 * reason. Nothing moves a paid settlement.
 */
export async function moveSettlement(pool: Pool, principal: Principal, settlementId: string, body: {
  to?: unknown; reference?: unknown; note?: unknown; paidAt?: unknown;
}) {
  const { tenantId, actorId } = await requireFinance(pool, principal);
  if (!UUID.test(settlementId)) throw new InvalidInput('no such settlement');
  const to = String(body.to ?? '');
  if (!SETTLEMENT_MOVES[to]) throw new InvalidInput('to must be paid, failed or void');
  const reference = text(body.reference, 120);
  const note = text(body.note, 500);
  if (to === 'paid' && !reference) throw new InvalidInput('give the payment reference (bank or payroll batch)');
  if (to !== 'paid' && !note) throw new InvalidInput('give a reason');
  const paidAt = to === 'paid' ? (body.paidAt ? new Date(String(body.paidAt)) : new Date()) : null;
  if (paidAt && Number.isNaN(paidAt.getTime())) throw new InvalidInput('paidAt must be a date');
  const settings = await expenseSettings(pool, tenantId);

  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      status: string; instance_id: string; amount: string; currency: string; claimant: string;
      beneficiary_id: string | null; beneficiary_verified_version: number | null;
    }>(`select status, instance_id, amount, currency, claimant, beneficiary_id, beneficiary_verified_version
          from expense_settlement where id = $1 and tenant_id = $2 for update`, [settlementId, tenantId]);
    const current = rows[0];
    if (!current) throw new InvalidInput('no such settlement');
    if (!SETTLEMENT_MOVES[to]!.includes(current.status)) {
      throw new InvalidInput(current.status === 'paid'
        ? 'this claim is already paid; a paid record cannot be changed'
        : `a ${current.status.replace('_', ' ')} settlement cannot be marked ${to}`);
    }
    if (to === 'paid' && settings.requireVerifiedBeneficiary) {
      const b = await currentBeneficiary(client, tenantId, current.claimant);
      if (!b) throw new InvalidInput('the claimant has not given bank details yet');
      if (current.beneficiary_verified_version === null) throw new InvalidInput('check the bank details before recording the payment');
      if (current.beneficiary_id !== b.id || current.beneficiary_verified_version !== b.version) {
        throw new InvalidInput('the bank details changed after they were checked; check them again before paying');
      }
    }
    await client.query(
      `update expense_settlement set status = $3, reference = coalesce(nullif($4, ''), reference), note = coalesce(nullif($5, ''), note),
         paid_at = $6, updated_by = $7, updated_at = now() where id = $1 and tenant_id = $2`,
      [settlementId, tenantId, to, reference, note, paidAt, actorId]);
    if (to === 'void') await releaseFinanceHolds(client, current.instance_id);
    await appendRecordEvent(client, {
      tenantId, instanceId: current.instance_id, actorId,
      type: to === 'paid' ? 'settlement_paid' : to === 'failed' ? 'settlement_failed' : 'settlement_voided',
      payload: { amount: Number(current.amount), currency: current.currency, reference: reference || null, note: note || null },
    });
    return { id: settlementId, status: to };
  });
}

// --------------------------------------------------------------- export

/**
 * EXP-10. Paid claims not yet exported, one row per approved line, with the
 * account code for its category, in a numbered batch. Bank details are never
 * in it. The last line of a claim absorbs the rounding, so the rows of each
 * claim add up to exactly what was approved.
 */
export async function exportPaid(pool: Pool, principal: Principal, body: { from?: unknown; to?: unknown }) {
  const { tenantId, actorId } = await requireFinance(pool, principal);
  const from = body.from ? new Date(String(body.from)) : new Date('1970-01-01');
  const to = body.to ? new Date(`${String(body.to).slice(0, 10)}T23:59:59.999Z`) : new Date();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new InvalidInput('from and to must be dates');
  const settings = await expenseSettings(pool, tenantId);
  return inTransaction(pool, async (client) => {
    await client.query('select id from tenant where id = $1 for update', [tenantId]);
    const { rows } = await client.query<{
      id: string; instance_id: string; claimant: string; amount: string; currency: string; reference: string | null; paid_at: Date;
      approved_amount: string | null; advance_applied: string; original_currency: string | null; fx_rate: string | null;
      data: Answers; blueprint: Blueprint; claimant_name: string | null;
    }>(`select s.id, s.instance_id, s.claimant, s.amount, s.currency, s.reference, s.paid_at, s.approved_amount, s.advance_applied,
               s.original_currency, s.fx_rate, i.data, v.blueprint, i.data->>'claimant_name' as claimant_name
          from expense_settlement s join instance i on i.id = s.instance_id join process_version v on v.id = i.process_version_id
         where s.tenant_id = $1 and s.status = 'paid' and s.export_id is null and s.paid_at between $2 and $3
         order by s.paid_at, s.id for update of s`, [tenantId, from, to]);
    if (!rows.length) throw new InvalidInput('there are no paid claims in that period that have not been exported already');
    const { rows: last } = await client.query<{ n: number }>('select coalesce(max(batch_no), 0) + 1 as n from expense_export where tenant_id = $1', [tenantId]);
    const batchNo = Number(last[0]!.n);
    const header = ['Batch', 'Claim', 'Claimant', 'Paid on', 'Payment reference', 'Cost centre', 'Category', 'Account code',
      'Line', 'Description', 'Original currency', 'Original amount', 'Rate', `Amount (${rows[0]!.currency})`, 'Advance applied', 'Paid to claimant'];
    const out: (string | number | null)[][] = [];
    let total = 0;
    for (const s of rows) {
      const finance = s.blueprint.finance;
      const rate = Number(s.fx_rate ?? 1) || 1;
      const { rows: dec } = await client.query<{ line_index: number; approved: string }>('select line_index, approved from expense_line_decision where instance_id = $1', [s.instance_id]);
      const byIndex = new Map(dec.map((d) => [d.line_index, Number(d.approved)]));
      const category = finance?.categoryField ? String(s.data[finance.categoryField] ?? '') : '';
      const costCentre = finance?.costCentreField ? String(s.data[finance.costCentreField] ?? '') : '';
      const account = settings.accountCodes[category] ?? settings.defaultAccountCode ?? '';
      const approvedBase = Number(s.approved_amount ?? s.amount);
      const lines = finance?.linesField && finance.lineAmountField
        ? ((s.data[finance.linesField] as Record<string, unknown>[] | undefined) ?? []).map((line, i) => ({
            i, description: finance.lineDescriptionField ? String(line[finance.lineDescriptionField] ?? '') : `Line ${i + 1}`,
            original: byIndex.has(i) ? byIndex.get(i)! : round(num(line[finance.lineAmountField!])),
          })).filter((l) => l.original > 0)
        : [{ i: 0, description: 'Claim', original: round(approvedBase / rate) }];
      let running = 0;
      lines.forEach((l, k) => {
        const baseAmount = k === lines.length - 1 ? round(approvedBase - running) : round(l.original * rate);
        running = round(running + baseAmount);
        out.push([batchNo, s.instance_id.slice(0, 8).toUpperCase(), s.claimant_name ?? s.claimant, s.paid_at.toISOString().slice(0, 10),
          s.reference, costCentre, category, account, l.i + 1, l.description, s.original_currency ?? s.currency, l.original, rate, baseAmount,
          k === 0 ? Number(s.advance_applied) : 0, k === 0 ? Number(s.amount) : 0]);
      });
      total = round(total + approvedBase);
    }
    const csv = tableToCsv({ header, rows: out as never });
    const checksum = createHash('sha256').update(csv).digest('hex');
    const { rows: batch } = await client.query<{ id: string }>(
      `insert into expense_export (tenant_id, batch_no, rows, total, currency, checksum, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [tenantId, batchNo, out.length, total, rows[0]!.currency, checksum, actorId]);
    await client.query('update expense_settlement set export_id = $2, exported_at = now() where id = any($1::uuid[])', [rows.map((r) => r.id), batch[0]!.id]);
    await recordWorkspaceAudit(client, { tenantId, actorId, action: 'expenses.exported', targetId: String(batchNo), detail: { claims: rows.length, rows: out.length, total, checksum } });
    return { batchNo, claims: rows.length, rows: out.length, total, currency: rows[0]!.currency, checksum, filename: `expenses-batch-${batchNo}.csv`, csv };
  });
}

export async function listExports(pool: Pool, principal: Principal) {
  const { tenantId } = await requireFinance(pool, principal);
  const { rows } = await pool.query(
    `select e.batch_no, e.rows, e.total, e.currency, e.checksum, e.created_at, a.display_name as created_by,
            (select count(*)::int from expense_settlement s where s.export_id = e.id) as claims
       from expense_export e left join actor a on a.id = e.created_by where e.tenant_id = $1 order by e.batch_no desc`, [tenantId]);
  return rows;
}

// ---------------------------------------------------------------- advances

export async function listAdvances(pool: Pool, principal: Principal) {
  const { tenantId } = await requireFinance(pool, principal);
  const { rows } = await pool.query(
    `select a.id, a.instance_id, a.reference, a.holder, a.amount, a.currency, a.status, a.outstanding,
            a.spent, a.returned, a.disbursed_at, a.due_at, a.created_at,
            coalesce(i.data->>'claimant_name', a.holder) as holder_name,
            (a.status in ('disbursed', 'awaiting_return') and a.due_at < now()) as overdue
       from cash_advance a join instance i on i.id = a.instance_id
      where a.tenant_id = $1
      order by (a.status in ('disbursed', 'awaiting_return') and a.due_at < now()) desc,
               case a.status when 'approved' then 0 when 'awaiting_return' then 1 when 'disbursed' then 2 else 3 end,
               a.created_at desc
      limit 500`,
    [tenantId]);
  return rows;
}

export async function advanceMovements(pool: Pool, principal: Principal, advanceId: string) {
  const { tenantId } = await requireFinance(pool, principal);
  const { rows } = await pool.query(
    `select m.id, m.kind, m.amount, m.reference, m.instance_id, m.occurred_at, a.display_name as actor_name
       from advance_movement m left join actor a on a.id = m.actor_id
      where m.tenant_id = $1 and m.advance_id = $2 order by m.id`,
    [tenantId, advanceId]);
  return rows;
}

/** EXP-06: paying the advance out starts the clock for retiring it. */
export async function disburseAdvance(pool: Pool, principal: Principal, advanceId: string, body: { reference?: unknown; disbursedAt?: unknown }) {
  const { tenantId, actorId } = await requireFinance(pool, principal);
  const reference = text(body.reference, 120);
  if (!reference) throw new InvalidInput('give the payment reference for the advance');
  const at = body.disbursedAt ? new Date(String(body.disbursedAt)) : new Date();
  if (Number.isNaN(at.getTime())) throw new InvalidInput('disbursedAt must be a date');
  const settings = await expenseSettings(pool, tenantId);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; instance_id: string; amount: string; reference: string }>(
      'select status, instance_id, amount, reference from cash_advance where id = $1 and tenant_id = $2 for update', [advanceId, tenantId]);
    const advance = rows[0];
    if (!advance) throw new InvalidInput('no such advance');
    if (advance.status !== 'approved') throw new InvalidInput('only an approved advance that has not been paid out can be disbursed');
    const due = new Date(at.getTime() + settings.advanceRetirementDays * 86_400_000);
    await client.query(
      `update cash_advance set status = 'disbursed', disbursed_at = $2, due_at = $3, disbursed_ref = $4, updated_by = $5, updated_at = now() where id = $1`,
      [advanceId, at, due, reference, actorId]);
    await client.query(
      `insert into advance_movement (tenant_id, advance_id, kind, amount, reference, actor_id, occurred_at) values ($1, $2, 'disbursed', $3, $4, $5, $6)`,
      [tenantId, advanceId, advance.amount, reference, actorId, at]);
    await appendRecordEvent(client, { tenantId, instanceId: advance.instance_id, actorId, type: 'advance_disbursed', payload: { reference: advance.reference, paymentReference: reference, dueAt: due } });
    return { id: advanceId, status: 'disbursed', dueAt: due };
  });
}

/** Money handed back against an advance. Never more than is still held. */
export async function recordAdvanceReturn(pool: Pool, principal: Principal, advanceId: string, body: { amount?: unknown; reference?: unknown }) {
  const { tenantId, actorId } = await requireFinance(pool, principal);
  const amount = round(num(body.amount));
  const reference = text(body.reference, 120);
  if (amount <= 0) throw new InvalidInput('amount must be more than nothing');
  if (!reference) throw new InvalidInput('give the reference for the money returned');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; instance_id: string; outstanding: string; reference: string }>(
      'select status, instance_id, outstanding, reference from cash_advance where id = $1 and tenant_id = $2 for update', [advanceId, tenantId]);
    const advance = rows[0];
    if (!advance) throw new InvalidInput('no such advance');
    if (!['disbursed', 'awaiting_return'].includes(advance.status)) throw new InvalidInput('this advance is not open');
    const held = Number(advance.outstanding);
    if (amount > held) throw new InvalidInput(`only ${held} is still held against this advance`);
    const left = round(held - amount);
    await client.query(
      `update cash_advance set outstanding = $2::numeric, returned = returned + $3::numeric,
         status = case when $2::numeric = 0 then 'retired' else status end, updated_by = $4, updated_at = now() where id = $1`,
      [advanceId, left, amount, actorId]);
    await client.query(
      `insert into advance_movement (tenant_id, advance_id, kind, amount, reference, actor_id) values ($1, $2, 'returned', $3, $4, $5)`,
      [tenantId, advanceId, amount, reference, actorId]);
    await appendRecordEvent(client, { tenantId, instanceId: advance.instance_id, actorId, type: 'advance_returned', payload: { reference: advance.reference, amount, stillToReturn: left } });
    return { id: advanceId, outstanding: left, status: left === 0 ? 'retired' : advance.status };
  });
}

export async function expenseSummary(pool: Pool, principal: Principal) {
  const { tenantId } = await requireFinance(pool, principal);
  const { rows } = await pool.query<{
    awaiting: string; awaiting_amount: string; failed: string; paid_30d: string; unexported: string;
    advances_open: string; advances_overdue: string; held: string; unchecked: string;
  }>(
    `select
       (select count(*) from expense_settlement where tenant_id = $1 and status = 'awaiting_payment') as awaiting,
       (select coalesce(sum(amount), 0) from expense_settlement where tenant_id = $1 and status = 'awaiting_payment') as awaiting_amount,
       (select count(*) from expense_settlement where tenant_id = $1 and status = 'failed') as failed,
       (select coalesce(sum(amount), 0) from expense_settlement where tenant_id = $1 and status = 'paid' and paid_at > now() - interval '30 days') as paid_30d,
       (select count(*) from expense_settlement where tenant_id = $1 and status = 'paid' and export_id is null and paid_at is not null) as unexported,
       (select count(*) from cash_advance where tenant_id = $1 and status in ('disbursed', 'awaiting_return')) as advances_open,
       (select count(*) from cash_advance where tenant_id = $1 and status in ('disbursed', 'awaiting_return') and due_at < now()) as advances_overdue,
       (select coalesce(sum(outstanding), 0) from cash_advance where tenant_id = $1 and status in ('disbursed', 'awaiting_return')) as held,
       (select count(*) from expense_settlement where tenant_id = $1 and status in ('awaiting_payment', 'failed') and beneficiary_verified_version is null) as unchecked`,
    [tenantId]);
  const r = rows[0]!;
  return {
    currency: await baseCurrency(pool, tenantId),
    awaitingPayment: Number(r.awaiting), awaitingAmount: Number(r.awaiting_amount), failed: Number(r.failed),
    paidLast30Days: Number(r.paid_30d), unexported: Number(r.unexported), bankUnchecked: Number(r.unchecked),
    advancesOpen: Number(r.advances_open), advancesOverdue: Number(r.advances_overdue), heldOnAdvances: Number(r.held),
  };
}

/** Appends to the record's own history, under its row lock, like every other event. */
async function appendRecordEvent(client: Client, args: { tenantId: string; instanceId: string; actorId: string; type: string; payload: unknown }) {
  await client.query('select id from instance where id = $1 for update', [args.instanceId]);
  await client.query(
    `insert into event (tenant_id, instance_id, seq, type, payload, actor, occurred_at)
     values ($1, $2, (select coalesce(max(seq), 0) + 1 from event where instance_id = $2), $3, $4, $5, now())`,
    [args.tenantId, args.instanceId, args.type, JSON.stringify(args.payload), `actor:${args.actorId}`]);
}
