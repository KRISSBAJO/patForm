import type { Blueprint } from '../blueprint/index.js';
import { VALUE_KIND } from '../blueprint/data.js';
import { Diagnostics, type Diagnostic } from '../compiler/diagnostics.js';
import type { AnswerFilter, Filter, QueryPlan, ActionPlan } from './plan.js';
import { BULK_EDITABLE_TYPES, IMPLEMENTED_ACTIONS } from './plan.js';
import { checkField } from '../blueprint/answers.js';

/**
 * Compiles a query plan into SQL.
 *
 * Every identifier in the emitted statement is written here. Nothing the model
 * produced is interpolated: keys are resolved against the blueprint and then
 * *discarded*, values go in as parameters, and a plan naming something the
 * blueprint does not have is refused rather than passed through to see what
 * happens.
 *
 * The diagnostics are the same class the blueprint compiler uses, for the same
 * reason: an operator who asks a question the system cannot answer deserves to
 * be told which part of it was the problem, not "no results".
 */

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  diagnostics: Diagnostic[];
  ok: boolean;
  /** Field keys the answer may show, after the blueprint has vetted them. */
  select: string[];
}

const ORDER_COLUMN: Record<string, string> = {
  state_entered_at: 'i.state_entered_at',
  created_at: 'i.created_at',
  hours_in_state: 'i.state_entered_at',
};

/** Which comparisons make sense against which kind of value. */
const OPS_FOR_KIND: Record<string, Set<string>> = {
  text: new Set(['eq', 'neq', 'contains', 'is_empty', 'is_not_empty', 'in']),
  number: new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty', 'in']),
  boolean: new Set(['eq', 'neq', 'is_empty', 'is_not_empty']),
  date: new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty']),
  time: new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty']),
  choice: new Set(['eq', 'neq', 'in', 'is_empty', 'is_not_empty']),
  list: new Set(['contains', 'is_empty', 'is_not_empty']),
  file: new Set(['is_empty', 'is_not_empty']),
  none: new Set([]),
};

export function compileQuery(bp: Blueprint, plan: QueryPlan, tenantId: string, now: Date): CompiledQuery {
  const d = new Diagnostics();
  const params: unknown[] = [tenantId, plan.processKey];
  const where: string[] = ['i.tenant_id = $1', 'i.process_key = $2'];

  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const fieldByKey = new Map<string, { type: string; classification: string }>();
  const walk = (fields: typeof bp.data.fields): void => {
    for (const f of fields) {
      fieldByKey.set(f.key, { type: f.type, classification: f.classification });
      if (f.fields) walk(f.fields);
    }
  };
  walk(bp.data.fields);

  const stateKeys = new Set(bp.workflow.states.map((s) => s.key));

  for (const [i, filter] of plan.filters.entries()) {
    const at = `filters[${i}]`;
    const clause = compileFilter(filter, { bp, at, d, push, fieldByKey, stateKeys, now });
    if (clause) where.push(clause);
  }

  // Selected fields are checked but never spliced in: the answer is built in
  // TypeScript from the `data` jsonb, so a field key cannot become a column.
  const select: string[] = [];
  for (const key of plan.select ?? []) {
    if (!fieldByKey.has(key)) {
      d.error('QRY001', 'select', `The process has no field "${key}".`, 'Name a field the blueprint declares.');
      continue;
    }
    select.push(key);
  }

  const order = plan.orderBy ? ORDER_COLUMN[plan.orderBy.by]! : 'i.state_entered_at';
  const direction = plan.orderBy?.direction === 'asc' ? 'asc' : 'desc';
  const limit = Math.min(plan.limit, 200);

  const sql = `
    select i.id, i.state, i.data, i.outcome, i.created_at, i.state_entered_at, i.completed_at,
           i.process_version_id
      from instance i
     where ${where.join('\n       and ')}
     order by ${order} ${direction}
     limit ${limit}`;

  return { sql, params, diagnostics: d.items, ok: d.publishable, select };
}

interface Ctx {
  bp: Blueprint;
  at: string;
  d: Diagnostics;
  push: (value: unknown) => string;
  fieldByKey: Map<string, { type: string; classification: string }>;
  stateKeys: Set<string>;
  now: Date;
}

function compileFilter(filter: Filter, ctx: Ctx): string | null {
  const { bp, at, d, push, stateKeys } = ctx;

  switch (filter.kind) {
    case 'state': {
      const unknown = filter.is.filter((k) => !stateKeys.has(k));
      if (unknown.length) {
        d.error('QRY002', at, `The process has no state "${unknown[0]}".`, `States are: ${[...stateKeys].join(', ')}.`);
        return null;
      }
      return `i.state = any(${push(filter.is)}::text[])`;
    }

    case 'state_type': {
      const keys = bp.workflow.states.filter((s) => filter.is.includes(s.type)).map((s) => s.key);
      if (!keys.length) {
        d.error('QRY002', at, `The process has no ${filter.is.join(' or ')} states.`);
        return null;
      }
      return `i.state = any(${push(keys)}::text[])`;
    }

    /**
     * The SLA lives in the blueprint, not the database, so "overdue" is
     * compiled into an explicit list of (state, deadline) pairs rather than a
     * column comparison. That keeps one definition of late — the same one the
     * console and the timers use.
     */
    case 'overdue': {
      const withSla = bp.workflow.states.filter((s) => s.slaHours);
      if (!withSla.length) {
        d.warn(
          'QRY003',
          at,
          'No state in this process declares an SLA, so no record can be overdue.',
          'Set "late after" on the states that should have a deadline.',
        );
        return filter.is ? 'false' : 'true';
      }
      const pairs = withSla
        .map((s) => `(i.state = ${push(s.key)} and i.state_entered_at < ${push(new Date(ctx.now.getTime() - s.slaHours! * 3_600_000))})`)
        .join(' or ');
      const open = 'i.completed_at is null';
      return filter.is ? `${open} and (${pairs})` : `not (${pairs})`;
    }

    case 'in_state_longer_than':
      return `i.state_entered_at < ${push(new Date(ctx.now.getTime() - filter.hours * 3_600_000))}`;

    case 'created_within_days':
      return `i.created_at >= ${push(new Date(ctx.now.getTime() - filter.days * 86_400_000))}`;

    case 'completed':
      return filter.is ? 'i.completed_at is not null' : 'i.completed_at is null';

    case 'outcome':
      return `i.outcome = any(${push(filter.is)}::text[])`;

    case 'has_open_task': {
      if (filter.task && !bp.workflow.tasks.some((t) => t.key === filter.task)) {
        d.error('QRY002', at, `The process has no task "${filter.task}".`);
        return null;
      }
      const narrow = filter.task ? ` and t.task_key = ${push(filter.task)}` : '';
      return `exists (select 1 from task t where t.instance_id = i.id and t.status = 'open'${narrow})`;
    }

    case 'has_pending_approval': {
      if (filter.approval && !bp.workflow.approvals.some((a) => a.key === filter.approval)) {
        d.error('QRY002', at, `The process has no approval "${filter.approval}".`);
        return null;
      }
      const narrow = filter.approval ? ` and a.approval_key = ${push(filter.approval)}` : '';
      return `exists (select 1 from approval_request a where a.instance_id = i.id and a.status = 'pending'${narrow})`;
    }

    case 'has_failure': {
      const failing = `(exists (select 1 from outbox o where o.instance_id = i.id and o.attempts >= 5 and o.done_at is null)
                     or exists (select 1 from email_log e where e.instance_id = i.id and e.status = 'failed'))`;
      return filter.is ? failing : `not ${failing}`;
    }

    case 'records':
      return `i.id = any(${push(filter.ids)}::uuid[])`;

    case 'answer':
      return compileAnswerFilter(filter, ctx);
  }
}

function compileAnswerFilter(filter: z_AnswerFilter, ctx: Ctx): string | null {
  const { at, d, push, fieldByKey } = ctx;

  const field = fieldByKey.get(filter.field);
  if (!field) {
    d.error('QRY001', at, `The process has no field "${filter.field}".`, 'Name a field the blueprint declares.');
    return null;
  }

  /**
   * A restricted answer is not a filter.
   *
   * Asking "which records have national_id starting 'QQ'" reads restricted
   * data one yes/no at a time, and it does so without ever displaying it, so
   * redaction on the way out does not help. §6.4 lets a role be blocked from
   * seeing a field; letting it search on that field would be the same
   * disclosure through a slower door.
   */
  if (field.classification === 'restricted') {
    d.error(
      'QRY004',
      at,
      `Field "${filter.field}" is restricted and cannot be used to filter records.`,
      'Restricted answers can be read on a record you may open, not searched across records.',
    );
    return null;
  }

  const kind = VALUE_KIND[field.type as keyof typeof VALUE_KIND];
  const allowed = OPS_FOR_KIND[kind] ?? new Set<string>();
  if (!allowed.has(filter.op)) {
    d.error(
      'QRY005',
      at,
      `"${filter.op}" is not a comparison you can make against ${filter.field}, which holds ${kind}.`,
      `Valid here: ${[...allowed].join(', ') || 'nothing — this field type holds no value'}.`,
    );
    return null;
  }

  const path = `i.data -> ${push(filter.field)}`;

  switch (filter.op) {
    case 'is_empty':
      return `(${path} is null or ${path} = 'null'::jsonb or ${path} = '""'::jsonb)`;
    case 'is_not_empty':
      return `(${path} is not null and ${path} <> 'null'::jsonb and ${path} <> '""'::jsonb)`;
    case 'contains':
      // For a list this asks whether the array holds the value; for text it is
      // a substring. jsonb distinguishes them, so the type decides.
      return kind === 'list'
        ? `${path} @> ${push(JSON.stringify([filter.value]))}::jsonb`
        : `(i.data ->> ${push(filter.field)}) ilike ${push(`%${String(filter.value ?? '')}%`)}`;
    case 'in': {
      const list = Array.isArray(filter.value) ? filter.value : [filter.value];
      return `(i.data ->> ${push(filter.field)}) = any(${push(list.map((v) => String(v)))}::text[])`;
    }
    default: {
      if (!typeMatches(kind, filter.value)) {
        d.error(
          'QRY006',
          at,
          `${filter.field} holds ${kind}, and the plan compares it against ${describe(filter.value)}.`,
        );
        return null;
      }
      const op = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.op]!;
      if (kind === 'number') return `((i.data ->> ${push(filter.field)})::numeric) ${op} ${push(Number(filter.value))}`;
      if (kind === 'date') return `((i.data ->> ${push(filter.field)})::date) ${op} ${push(String(filter.value))}::date`;
      if (kind === 'boolean') return `((i.data ->> ${push(filter.field)})::boolean) ${op} ${push(Boolean(filter.value))}`;
      return `(i.data ->> ${push(filter.field)}) ${op} ${push(String(filter.value))}`;
    }
  }
}

type z_AnswerFilter = import('zod').infer<typeof AnswerFilter>;

function typeMatches(kind: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (kind === 'number') return typeof value === 'number';
  if (kind === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string' || typeof value === 'number';
}

/** One row for a repeating group, checked field by field against the group's own fields. */
function checkRow(
  group: { label: string; fields?: { key: string; label: string }[] },
  row: unknown,
): string | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return `A row of ${group.label} is a set of answers.`;
  const fields = group.fields ?? [];
  const unknown = Object.keys(row).filter((k) => !fields.some((f) => f.key === k));
  if (unknown.length) return `${group.label} has no "${unknown[0]}".`;
  for (const child of fields) {
    const problem = checkField(child as never, (row as Record<string, unknown>)[child.key]);
    if (problem) return `${child.label}: ${problem}`;
  }
  return null;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return `a ${typeof value}`;
}

/**
 * Checks an action plan before anything is previewed.
 *
 * Separate from the query because the two fail differently: a query that does
 * not compile shows nothing, an action that does not compile would have
 * changed records.
 */
export function compileAction(bp: Blueprint, action: ActionPlan): Diagnostic[] {
  const d = new Diagnostics();

  if (!IMPLEMENTED_ACTIONS.has(action.kind)) {
    d.error(
      'ACT001',
      'action',
      `"${action.kind}" is not built yet.`,
      'Reminders are the only bulk action the runtime performs today.',
    );
    return d.items;
  }

  if (action.kind === 'send_reminder') {
    const template = bp.communications.email.find((t) => t.key === action.template);
    if (!template) {
      d.error(
        'ACT002',
        'action.template',
        `The process has no email template "${action.template}".`,
        `Templates are: ${bp.communications.email.map((t) => t.key).join(', ')}.`,
      );
      return d.items;
    }
    // The template's own recipients are what the reminder goes to. An action
    // that could redirect a message to an address of its choosing would be a
    // way to exfiltrate a record one email at a time.
    if (!template.to.length) {
      d.error('ACT003', 'action.template', `Template "${template.key}" is addressed to nobody.`);
    }
  }

  if (action.kind === 'assign') {
    const task = bp.workflow.tasks.find((t) => t.key === action.task);
    if (!task) {
      d.error(
        'ACT004',
        'action.task',
        `The process has no task "${action.task}".`,
        `Tasks are: ${bp.workflow.tasks.map((t) => t.key).join(', ') || '(none)'}.`,
      );
    }
    const to = action.to.trim();
    if (to.startsWith('role:')) {
      const role = bp.roles.find((r) => r.key === to.slice(5));
      if (!role || role.kind !== 'internal') {
        d.error('ACT005', 'action.to', `"${to}" is not an internal role of this process.`);
      } else if (!role.capabilities.includes('operate')) {
        // A task handed to a role that cannot complete it is a task nobody
        // can complete — the one outcome reassignment exists to prevent.
        d.error('ACT005', 'action.to', `Role "${role.key}" cannot operate this process, so it could not complete the task.`);
      }
    } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      d.error('ACT005', 'action.to', `"${to}" is neither an email address nor a role.`, `Use a member's email or role:<key>.`);
    }
  }

  if (action.kind === 'set_answer') {
    const field = bp.data.fields.find((f) => f.key === action.field);
    if (!field) {
      d.error('ACT008', 'action.field', `The process has no field "${action.field}".`);
      return d.items;
    }
    if (!BULK_EDITABLE_TYPES.has(field.type) || field.setBy === 'system') {
      d.error(
        'ACT009',
        'action.field',
        `"${field.label}" cannot be set in bulk.`,
        'Only single-value fields — text, numbers, dates, choices, yes or no — are.',
      );
      return d.items;
    }
    /*
     * The value is checked against the field before anything is previewed,
     * by the same function the form uses. A value the form would refuse from
     * a respondent is not a value to write into two hundred records.
     */
    const mode = action.mode ?? 'set';
    const isList = field.type === 'multi_choice' || field.type === 'repeating_group';
    if (mode !== 'set' && !isList) {
      d.error('ACT011', 'action.mode', `"${mode}" is for lists; ${field.label} holds one value.`);
      return d.items;
    }
    if (field.type === 'repeating_group' && mode !== 'add') {
      d.error(
        'ACT011',
        'action.mode',
        `${field.label} can only have a row added in bulk.`,
        'Rows have no identity across records, so replacing or removing one would be a guess.',
      );
      return d.items;
    }

    let problem: string | null;
    if (field.type === 'multi_choice' && mode !== 'set') {
      const allowed = (field.choices ?? []).map((ch) => ch.value);
      problem = typeof action.value === 'string' && allowed.includes(action.value) ? null : 'Choose one of the options.';
    } else if (field.type === 'repeating_group') {
      problem = checkRow(field as never, action.value);
    } else {
      const kindOk =
        action.value === null ||
        (['number', 'currency'].includes(field.type)
          ? typeof action.value === 'number'
          : field.type === 'yes_no'
            ? typeof action.value === 'boolean'
            : field.type === 'multi_choice'
              ? Array.isArray(action.value)
              : typeof action.value === 'string');
      problem = kindOk ? checkField(field as never, action.value) : `${field.label} needs a ${field.type.replace(/_/g, ' ')} value.`;
    }
    if (problem) d.error('ACT010', 'action.value', problem);
  }

  if (action.kind === 'change_state') {
    const target = bp.workflow.states.find((s) => s.key === action.to);
    if (!target) {
      d.error('ACT006', 'action.to', `The process has no state "${action.to}".`);
    } else if (!bp.workflow.transitions.some((t) => t.to === action.to && t.trigger.on === 'manual')) {
      d.error(
        'ACT007',
        'action.to',
        `Nothing in the process moves a record to "${target.name}" by hand.`,
        `A bulk move follows the process's own manual steps, so the state needs one leading to it.`,
      );
    }
  }

  return d.items;
}
