/**
 * The Expenses module (PRD Module 5): policy, settlement and advances.
 *
 * Three moments matter:
 *   1. Submission. The workspace's expense policy is copied onto the claim
 *      (`applyFinancePolicy`), and the receipt rule, allowed categories and
 *      any advance being retired are checked. Routing then compares against
 *      the copied numbers, so a later policy change never re-routes an old
 *      claim.
 *   2. Approval. When a finance process reaches its success state the engine
 *      calls `recordFinanceOutcome` in the same transaction: a claim gets a
 *      settlement awaiting payment, an advance gets its own record.
 *   3. Payment. Finance records what actually happened — paid, failed,
 *      voided; disbursed, returned — each as a dated, attributed change.
 *      Approval and payment are separate facts (EXP-08): a failed payment
 *      leaves an approved claim unpaid, never "reimbursed".
 *
 * Every money value is a decimal in the database and rounded to two places
 * here before it is stored.
 */
import type { Blueprint } from '../blueprint/index.js';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { enabledModules } from './modules.js';
import type { Answers } from './expr.js';

export interface ExpenseSettings {
  categories: string[];
  autoApproveLimit: number;
  managerLimit: number;
  lineLimit: number;
  receiptThreshold: number;
  advanceRetirementDays: number;
  updatedAt: Date | null;
}

const DEFAULTS: ExpenseSettings = {
  categories: ['travel', 'accommodation', 'subsistence', 'equipment', 'training', 'other'],
  autoApproveLimit: 100,
  managerLimit: 1000,
  lineLimit: 200,
  receiptThreshold: 0,
  advanceRetirementDays: 14,
  updatedAt: null,
};

const UUID = /^[0-9a-f-]{36}$/;
const round = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// ---------------------------------------------------------------- settings

export async function expenseSettings(client: Client | Pool, tenantId: string): Promise<ExpenseSettings> {
  const { rows } = await client.query<{
    categories: string[]; auto_approve_limit: string; manager_limit: string; line_limit: string;
    receipt_threshold: string; advance_retirement_days: number; updated_at: Date;
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
    updatedAt: r.updated_at,
  };
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

export async function readExpenseSettings(pool: Pool, principal: Principal) {
  const tenantId = await requireModule(pool, principal);
  return expenseSettings(pool, tenantId);
}

export async function updateExpenseSettings(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const tenantId = await requireModule(pool, principal);
  await requireWorkspaceCapability(pool, principal, 'administer', 'expenses');
  if (principal.kind !== 'actor') throw new Error('unreachable');
  const current = await expenseSettings(pool, tenantId);
  const amount = (key: string, fallback: number) => {
    if (body[key] === undefined) return fallback;
    const n = num(body[key]);
    if (n < 0 || n > 1e12 || (body[key] !== 0 && !String(body[key]).trim())) throw new InvalidInput(`${key} must be a positive amount`);
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
  const next = {
    categories,
    autoApproveLimit: amount('autoApproveLimit', current.autoApproveLimit),
    managerLimit: amount('managerLimit', current.managerLimit),
    lineLimit: amount('lineLimit', current.lineLimit),
    receiptThreshold: amount('receiptThreshold', current.receiptThreshold),
    advanceRetirementDays: body.advanceRetirementDays === undefined ? current.advanceRetirementDays : Math.trunc(num(body.advanceRetirementDays)),
  };
  if (next.advanceRetirementDays < 1 || next.advanceRetirementDays > 365) throw new InvalidInput('advanceRetirementDays must be 1 to 365');
  if (next.autoApproveLimit > next.managerLimit) throw new InvalidInput('the auto-approve limit cannot be above the manager limit');
  await inTransaction(pool, async (client) => {
    await client.query(
      `insert into expense_settings (tenant_id, categories, auto_approve_limit, manager_limit, line_limit, receipt_threshold, advance_retirement_days, updated_by, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (tenant_id) do update set categories = excluded.categories, auto_approve_limit = excluded.auto_approve_limit,
         manager_limit = excluded.manager_limit, line_limit = excluded.line_limit, receipt_threshold = excluded.receipt_threshold,
         advance_retirement_days = excluded.advance_retirement_days, updated_by = excluded.updated_by, updated_at = now()`,
      [tenantId, JSON.stringify(next.categories), next.autoApproveLimit, next.managerLimit, next.lineLimit, next.receiptThreshold, next.advanceRetirementDays, principal.actorId]);
    await recordWorkspaceAudit(client, { tenantId, actorId: principal.actorId, action: 'expenses.settings_changed', detail: { ...next, categories: next.categories.join(', ') } });
  });
  return expenseSettings(pool, tenantId);
}

// -------------------------------------------------------------- submission

/**
 * Copies the policy onto the answers and checks the rules a form cannot.
 * Returns the answers to store and any fields to refuse, in the same shape
 * as the engine's own validation so the form shows them the same way.
 */
export async function applyFinancePolicy(
  pool: Pool,
  args: { bp: Blueprint; tenantId: string; answers: Answers; submitterEmail: string | null },
): Promise<{ answers: Answers; rejected: string[]; problems: string[] }> {
  const finance = args.bp.finance;
  if (!finance) return { answers: args.answers, rejected: [], problems: [] };
  const settings = await expenseSettings(pool, args.tenantId);
  const answers: Answers = { ...args.answers };
  const rejected: string[] = [];
  const problems: string[] = [];
  if (finance.policy.autoApproveLimit) answers[finance.policy.autoApproveLimit] = settings.autoApproveLimit;
  if (finance.policy.managerLimit) answers[finance.policy.managerLimit] = settings.managerLimit;
  if (finance.policy.lineLimit) answers[finance.policy.lineLimit] = settings.lineLimit;

  const amount = num(answers[finance.amountField]);
  if (finance.receiptField && amount > settings.receiptThreshold) {
    const receipt = answers[finance.receiptField];
    if (receipt === undefined || receipt === null || String(receipt).trim() === '') {
      rejected.push(finance.receiptField);
      problems.push(`A receipt is needed for claims over ${settings.receiptThreshold}.`);
    }
  }
  if (finance.categoryField) {
    const category = answers[finance.categoryField];
    if (typeof category === 'string' && category && !settings.categories.includes(category)) {
      rejected.push(finance.categoryField);
      problems.push(`"${category}" is not a category Finance accepts.`);
    }
  }
  if (finance.advanceReferenceField) {
    const ref = answers[finance.advanceReferenceField];
    if (typeof ref === 'string' && ref.trim()) {
      const { rows } = await pool.query<{ holder: string; status: string }>(
        'select holder, status from cash_advance where tenant_id = $1 and upper(reference) = upper($2)',
        [args.tenantId, ref.trim()]);
      const advance = rows[0];
      if (!advance || !args.submitterEmail || advance.holder.toLowerCase() !== args.submitterEmail.toLowerCase()) {
        rejected.push(finance.advanceReferenceField);
        problems.push('That advance reference is not one of your advances.');
      } else if (!['disbursed', 'awaiting_return'].includes(advance.status)) {
        rejected.push(finance.advanceReferenceField);
        problems.push(advance.status === 'approved' ? 'That advance has not been paid out yet.' : 'That advance is already settled.');
      }
    }
  }
  return { answers, rejected, problems };
}

// ---------------------------------------------------------------- approval

/**
 * Called by the engine, inside the transition's transaction, when a finance
 * process reaches its success state. Idempotent on the instance: a replay
 * writes nothing twice. Returns events for the record history.
 */
export async function recordFinanceOutcome(
  client: Client,
  args: { bp: Blueprint; instanceId: string; tenantId: string; data: Answers; submitter: string; now: Date },
): Promise<{ type: string; payload: unknown }[]> {
  const finance = args.bp.finance;
  if (!finance) return [];
  const { rows: tenant } = await client.query<{ default_currency: string }>('select default_currency from tenant where id = $1', [args.tenantId]);
  const currency = tenant[0]?.default_currency ?? 'GBP';
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

  // A claim. If it retires an advance, what was spent comes off what is
  // still held; only the remainder (if any) is paid out to the claimant.
  let payable = amount;
  let advanceId: string | null = null;
  const events: { type: string; payload: unknown }[] = [];
  const ref = finance.advanceReferenceField ? args.data[finance.advanceReferenceField] : null;
  if (typeof ref === 'string' && ref.trim()) {
    const { rows } = await client.query<{ id: string; reference: string; outstanding: string; status: string }>(
      `select id, reference, outstanding, status from cash_advance
        where tenant_id = $1 and upper(reference) = upper($2) for update`,
      [args.tenantId, ref.trim()]);
    const advance = rows[0];
    if (advance && ['disbursed', 'awaiting_return'].includes(advance.status)) {
      const held = Number(advance.outstanding);
      const applied = round(Math.min(held, amount));
      const left = round(held - applied);
      payable = round(amount - applied);
      advanceId = advance.id;
      await client.query(
        `update cash_advance set outstanding = $2::numeric, spent = spent + $3::numeric,
           status = case when $2::numeric = 0 then 'retired' else 'awaiting_return' end, updated_at = now()
         where id = $1`,
        [advance.id, left, applied]);
      await client.query(
        `insert into advance_movement (tenant_id, advance_id, kind, amount, instance_id, occurred_at)
         values ($1, $2, 'spent', $3, $4, $5)`,
        [args.tenantId, advance.id, applied, args.instanceId, args.now]);
      events.push({
        type: 'advance_retired',
        payload: { advance: advance.reference, applied, stillToReturn: left, payable },
      });
    }
  }
  const { rows } = await client.query<{ id: string }>(
    `insert into expense_settlement (tenant_id, instance_id, claimant, amount, currency, advance_id, status)
     values ($1, $2, $3, $4::numeric, $5, $6, case when $4::numeric = 0 then 'paid' else 'awaiting_payment' end)
     on conflict (instance_id) do nothing returning id`,
    [args.tenantId, args.instanceId, args.submitter, payable, currency, advanceId]);
  if (rows[0]) events.push({ type: 'settlement_opened', payload: { amount: payable, currency, status: payable === 0 ? 'paid' : 'awaiting_payment' } });
  return events;
}

// ----------------------------------------------------------------- payment

export async function listSettlements(pool: Pool, principal: Principal, status?: string) {
  const { tenantId } = await requireFinance(pool, principal);
  const { rows } = await pool.query(
    `select s.id, s.instance_id, s.claimant, s.amount, s.currency, s.status, s.reference, s.note,
            s.paid_at, s.created_at, s.updated_at, a.reference as advance_reference, i.process_key,
            coalesce(i.data->>'claimant_name', s.claimant) as claimant_name
       from expense_settlement s
       join instance i on i.id = s.instance_id
       left join cash_advance a on a.id = s.advance_id
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
 * EXP-08 and EXP-11. Paid needs a reference (the evidence); failed and void
 * need a reason. Nothing moves a paid settlement: a correction after payment
 * is a new adjustment, not an edit.
 */
export async function moveSettlement(pool: Pool, principal: Principal, settlementId: string, body: {
  to?: unknown; reference?: unknown; note?: unknown; paidAt?: unknown;
}) {
  const { tenantId, actorId } = await requireFinance(pool, principal);
  if (!UUID.test(settlementId)) throw new InvalidInput('no such settlement');
  const to = String(body.to ?? '');
  if (!SETTLEMENT_MOVES[to]) throw new InvalidInput('to must be paid, failed or void');
  const reference = typeof body.reference === 'string' ? body.reference.trim().slice(0, 120) : '';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (to === 'paid' && !reference) throw new InvalidInput('give the payment reference (bank or payroll batch)');
  if (to !== 'paid' && !note) throw new InvalidInput('give a reason');
  const paidAt = to === 'paid' ? (body.paidAt ? new Date(String(body.paidAt)) : new Date()) : null;
  if (paidAt && Number.isNaN(paidAt.getTime())) throw new InvalidInput('paidAt must be a date');

  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; instance_id: string; amount: string; currency: string }>(
      'select status, instance_id, amount, currency from expense_settlement where id = $1 and tenant_id = $2 for update',
      [settlementId, tenantId]);
    const current = rows[0];
    if (!current) throw new InvalidInput('no such settlement');
    if (!SETTLEMENT_MOVES[to]!.includes(current.status)) {
      throw new InvalidInput(current.status === 'paid'
        ? 'this claim is already paid; a paid record cannot be changed'
        : `a ${current.status.replace('_', ' ')} settlement cannot be marked ${to}`);
    }
    await client.query(
      `update expense_settlement set status = $3, reference = coalesce(nullif($4, ''), reference), note = coalesce(nullif($5, ''), note),
         paid_at = $6, updated_by = $7, updated_at = now() where id = $1 and tenant_id = $2`,
      [settlementId, tenantId, to, reference, note, paidAt, actorId]);
    await appendRecordEvent(client, {
      tenantId, instanceId: current.instance_id, actorId,
      type: to === 'paid' ? 'settlement_paid' : to === 'failed' ? 'settlement_failed' : 'settlement_voided',
      payload: { amount: Number(current.amount), currency: current.currency, reference: reference || null, note: note || null },
    });
    return { id: settlementId, status: to };
  });
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
  const reference = typeof body.reference === 'string' ? body.reference.trim().slice(0, 120) : '';
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
  const reference = typeof body.reference === 'string' ? body.reference.trim().slice(0, 120) : '';
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
    awaiting: string; awaiting_amount: string; failed: string; paid_30d: string;
    advances_open: string; advances_overdue: string; held: string;
  }>(
    `select
       (select count(*) from expense_settlement where tenant_id = $1 and status = 'awaiting_payment') as awaiting,
       (select coalesce(sum(amount), 0) from expense_settlement where tenant_id = $1 and status = 'awaiting_payment') as awaiting_amount,
       (select count(*) from expense_settlement where tenant_id = $1 and status = 'failed') as failed,
       (select coalesce(sum(amount), 0) from expense_settlement where tenant_id = $1 and status = 'paid' and paid_at > now() - interval '30 days') as paid_30d,
       (select count(*) from cash_advance where tenant_id = $1 and status in ('disbursed', 'awaiting_return')) as advances_open,
       (select count(*) from cash_advance where tenant_id = $1 and status in ('disbursed', 'awaiting_return') and due_at < now()) as advances_overdue,
       (select coalesce(sum(outstanding), 0) from cash_advance where tenant_id = $1 and status in ('disbursed', 'awaiting_return')) as held`,
    [tenantId]);
  const r = rows[0]!;
  const { rows: t } = await pool.query<{ default_currency: string }>('select default_currency from tenant where id = $1', [tenantId]);
  return {
    currency: t[0]?.default_currency ?? 'GBP',
    awaitingPayment: Number(r.awaiting), awaitingAmount: Number(r.awaiting_amount), failed: Number(r.failed),
    paidLast30Days: Number(r.paid_30d), advancesOpen: Number(r.advances_open), advancesOverdue: Number(r.advances_overdue),
    heldOnAdvances: Number(r.held),
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
