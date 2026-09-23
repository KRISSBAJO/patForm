import { BULK_EDITABLE_TYPES } from '../copilot/plan.js';
import { createHash } from 'node:crypto';
import type { Blueprint } from '../blueprint/index.js';
import type { Diagnostic } from '../compiler/diagnostics.js';
import { compileAction, compileQuery } from '../copilot/compile.js';
import { ActionPlan, Proposal, QueryPlan } from '../copilot/plan.js';
import { inTransaction, type Client, type Pool } from './db.js';
import { Engine } from './engine.js';
import { AuthorizationError, authorize, editableFields, redact, require_, type Principal } from './policy.js';
import { appUrl, sendPlatformMail } from './platform-mail.js';

/**
 * The operational copilot.
 *
 * §20.1 step 9: "The operator asks which records are overdue and sends a
 * confirmed reminder to authorized targets." Three separate promises in one
 * sentence, and the third is the one that decides whether this is a feature or
 * a liability.
 *
 * **Asks.** The model never sees the database and never writes SQL. It emits a
 * typed plan (../copilot/plan.ts) which a deterministic compiler turns into a
 * parameterised statement, refusing anything that names something the
 * blueprint does not have. This is the same boundary as blueprint generation,
 * for the same reason, and it matters more here: the records being queried
 * contain text that respondents typed, so the model is reading attacker-
 * controlled input every time it answers a question about a record.
 *
 * **Confirmed.** §7.4 gates action precision at "100 percent of executed
 * actions match the confirmed plan". That is only enforceable if the thing
 * confirmed and the thing executed are the same object, so the preview
 * resolves the target ids and hashes them with the plan, and execution works
 * from the stored list rather than re-running the query. A record that becomes
 * overdue thirty seconds after the preview is not included — which is the
 * correct behaviour, not a limitation: the operator confirmed eleven records,
 * not "whatever matches when I press the button".
 *
 * **Authorized targets.** §6.4 requires "permission checks per record". The
 * preview runs one, and so does the execution, because a permission can be
 * revoked in between and the preview is not a capability.
 */

const MAX_TARGETS = 200;
const RATE_LIMIT_PER_HOUR = 20;

export interface AskResult {
  runId: string;
  reading: string;
  plan: QueryPlan;
  action: ActionPlan | null;
  diagnostics: Diagnostic[];
  ok: boolean;
  rows: MatchedRecord[];
  /** Present when the question asked for something to be done. */
  preview: ActionPreview | null;
  audit: { provider: string; model: string; promptVersion: string; latencyMs: number };
}

export interface MatchedRecord {
  instanceId: string;
  reference: string;
  state: string;
  stateName: string;
  hoursInState: number;
  overdue: boolean;
  answers: Record<string, unknown>;
}

export interface ActionPreview {
  kind: string;
  summary: string;
  digest: string;
  /**
   * `to` is who a reminder goes to, who a task goes to, or the state a record
   * moves to. `from` is who has the task now; `via` is the manual step a move
   * takes — stored with the target so execution takes the step the operator
   * was shown, not whichever one it finds later.
   */
  eligible: { instanceId: string; reference: string; to: string[]; from?: string | null; via?: string }[];
  refused: { instanceId: string; reference: string; reason: string }[];
  skipped: { instanceId: string; reference: string; reason: string }[];
}

export interface ExecutionReport {
  runId: string;
  kind: string;
  attempted: number;
  /**
   * For a reassignment: who was told about their new work. `sent` false with a
   * reason when the email could not go — said, so a report never implies
   * somebody knows about work they were never told of.
   */
  notified?: { to: string; tasks: number; sent: boolean; reason?: string }[];
  sent: { instanceId: string; reference: string; to: string[] }[];
  skipped: { instanceId: string; reference: string; reason: string }[];
  failed: { instanceId: string; reference: string; reason: string }[];
}

function reference(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

/** The digest that binds a preview to its execution. Order-independent. */
function digestOf(plan: QueryPlan, action: ActionPlan, ids: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ plan, action, ids: [...ids].sort() }))
    .digest('hex')
    .slice(0, 32);
}

async function blueprintFor(client: Client, tenantId: string, processKey: string): Promise<Blueprint> {
  const { rows } = await client.query<{ blueprint: Blueprint }>(
    `select blueprint from process_version
      where tenant_id = $1 and process_key = $2 order by version desc limit 1`,
    [tenantId, processKey],
  );
  if (!rows[0]) throw new Error(`no published version of "${processKey}"`);
  return rows[0].blueprint;
}

/**
 * Runs a plan that has already been produced, and answers it.
 *
 * Split out from `ask` so the plan can come from a model or from a person
 * clicking filters — and so the proof suite can exercise the whole path
 * without spending a token or depending on what a model felt like emitting.
 */
export async function runPlan(
  pool: Pool,
  args: {
    principal: Principal;
    plan: QueryPlan;
    action?: ActionPlan | null;
    now?: Date;
  },
): Promise<{ rows: MatchedRecord[]; diagnostics: Diagnostic[]; ok: boolean; preview: ActionPreview | null; bp: Blueprint }> {
  const now = args.now ?? new Date();
  if (args.principal.kind !== 'actor') throw new Error('the copilot answers to signed-in members');
  const tenantId = args.principal.tenantId;

  return inTransaction(pool, async (client) => {
    const bp = await blueprintFor(client, tenantId, args.plan.processKey);

    // The query is permission-filtered before it is compiled: an actor who
    // may not view this process gets a refusal, not an empty list, because
    // "no results" and "not allowed" are different answers and conflating
    // them is how people conclude a process is empty.
    const decision = await require_(
      client,
      { principal: args.principal, action: 'view', tenantId, processKey: args.plan.processKey, blueprint: bp },
      pool,
    );

    const compiled = compileQuery(bp, args.plan, tenantId, now);
    const diagnostics = [...compiled.diagnostics];
    if (args.action) diagnostics.push(...compileAction(bp, args.action));
    const ok = !diagnostics.some((d) => d.severity === 'error');
    if (!ok) return { rows: [], diagnostics, ok, preview: null, bp };

    const { rows } = await client.query<{
      id: string;
      state: string;
      data: Record<string, unknown>;
      state_entered_at: Date;
    }>(compiled.sql, compiled.params);

    const stateByKey = new Map(bp.workflow.states.map((s) => [s.key, s]));
    const matched: MatchedRecord[] = rows.map((row) => {
      const state = stateByKey.get(row.state);
      const sla = state?.slaHours;
      // Redaction applies to the answer exactly as it does on the record view.
      const visible = redact(bp, decision.roles, row.data);
      const answers: Record<string, unknown> = {};
      for (const key of compiled.select) if (key in visible) answers[key] = visible[key];
      return {
        instanceId: row.id,
        reference: reference(row.id),
        state: row.state,
        stateName: state?.name ?? row.state,
        hoursInState: Math.round((now.getTime() - row.state_entered_at.getTime()) / 3_600_000),
        overdue: Boolean(sla && row.state_entered_at.getTime() + sla * 3_600_000 < now.getTime()),
        answers,
      };
    });

    const preview = args.action
      ? await previewAction(client, pool, { bp, principal: args.principal, action: args.action, plan: args.plan, matched })
      : null;

    return { rows: matched, diagnostics, ok, preview, bp };
  });
}

/**
 * Works out, per record, whether the action may run and would do anything.
 *
 * Three outcomes rather than two. *Refused* is a permission answer and belongs
 * on the audit; *skipped* means the action would be a no-op — the record has
 * already finished, or the template's own `skipWhen` excludes it — and is not
 * a failure. Collapsing them would make the report say eleven when the truth
 * is four sent, five already done, two not yours.
 */
async function previewAction(
  client: Client,
  audit: Pool,
  args: {
    bp: Blueprint;
    principal: Principal;
    action: ActionPlan;
    plan: QueryPlan;
    matched: MatchedRecord[];
  },
): Promise<ActionPreview> {
  const { bp, action, matched } = args;
  const eligible: ActionPreview['eligible'] = [];
  const refused: ActionPreview['refused'] = [];
  const skipped: ActionPreview['skipped'] = [];

  if (matched.length > MAX_TARGETS) {
    throw new Error(`a bulk action may touch at most ${MAX_TARGETS} records; this plan matched ${matched.length}`);
  }

  const template =
    action.kind === 'send_reminder' ? bp.communications.email.find((t) => t.key === action.template) : undefined;
  const tenantId = args.principal.kind === 'actor' ? args.principal.tenantId : '';

  /*
   * Reassigning is an administrator's call; the other two are operating the
   * process. Asked per record, below, because a permission can be scoped to
   * a record and "you may do this to nine of the eleven" is an answer.
   */
  const needs = action.kind === 'assign' ? 'administer' : action.kind === 'set_answer' ? 'edit' : 'operate';
  const field = action.kind === 'set_answer' ? bp.data.fields.find((f) => f.key === action.field) : undefined;
  const currentValues =
    action.kind === 'set_answer'
      ? await valuesOf(client, matched.map((m) => m.instanceId), action.field)
      : new Map<string, unknown>();

  /*
   * For a reassignment, the new assignee is checked once, up front: somebody
   * who has left, or who holds nothing on this process, would receive work
   * they cannot open. Better every record refused with that reason than
   * eleven tasks handed to a dead end.
   */
  const assigneeProblem =
    action.kind === 'assign' ? await problemWithAssignee(client, bp, tenantId, args.plan.processKey, action.to) : null;
  const openTasks =
    action.kind === 'assign'
      ? await openTasksFor(client, matched.map((m) => m.instanceId), action.task)
      : new Map<string, string | null>();
  const taskName =
    action.kind === 'assign' ? (bp.workflow.tasks.find((t) => t.key === action.task)?.name ?? action.task) : '';
  const target = action.kind === 'change_state' ? bp.workflow.states.find((s) => s.key === action.to) : undefined;

  for (const record of matched) {
    // §6.4: per record, not once for the process.
    let roles: string[] = [];
    try {
      const decision = await require_(
        client,
        {
          principal: args.principal,
          action: needs,
          tenantId,
          processKey: args.plan.processKey,
          blueprint: bp,
          instanceId: record.instanceId,
        },
        audit,
      );
      roles = decision.roles;
    } catch (err) {
      refused.push({
        instanceId: record.instanceId,
        reference: record.reference,
        reason: err instanceof AuthorizationError ? err.reason : String(err),
      });
      continue;
    }

    const state = bp.workflow.states.find((s) => s.key === record.state);
    if (state?.type === 'terminal') {
      skipped.push({ instanceId: record.instanceId, reference: record.reference, reason: 'the record has finished' });
      continue;
    }

    if (action.kind === 'assign') {
      if (assigneeProblem) {
        refused.push({ instanceId: record.instanceId, reference: record.reference, reason: assigneeProblem });
        continue;
      }
      if (!openTasks.has(record.instanceId)) {
        skipped.push({ instanceId: record.instanceId, reference: record.reference, reason: `no open "${taskName}" task` });
        continue;
      }
      const from = openTasks.get(record.instanceId) ?? null;
      if ((from ?? '').toLowerCase() === action.to.trim().toLowerCase()) {
        skipped.push({ instanceId: record.instanceId, reference: record.reference, reason: `already assigned to ${action.to}` });
        continue;
      }
      eligible.push({ instanceId: record.instanceId, reference: record.reference, to: [action.to.trim()], from });
      continue;
    }

    if (action.kind === 'set_answer') {
      // Holding `edit` is not permission to change every field — the same
      // rule a single edit is held to, asked here so the preview says so.
      if (!editableFields(bp, roles).has(action.field)) {
        refused.push({
          instanceId: record.instanceId,
          reference: record.reference,
          reason: `your roles cannot change ${field?.label ?? action.field}`,
        });
        continue;
      }
      const now = currentValues.get(record.instanceId) ?? null;
      const outcome = nextAnswer(field!, action, now);
      if ('skip' in outcome) {
        skipped.push({ instanceId: record.instanceId, reference: record.reference, reason: outcome.skip });
        continue;
      }
      // The current value is shown only if this member may see the field.
      const visible = redact(bp, roles, { [action.field]: now } as never);
      eligible.push({
        instanceId: record.instanceId,
        reference: record.reference,
        from: action.field in visible ? answerWords(field!, now) : 'hidden from your roles',
        to: [answerWords(field!, outcome.value)],
      });
      continue;
    }

    if (action.kind === 'change_state') {
      if (record.state === action.to) {
        skipped.push({ instanceId: record.instanceId, reference: record.reference, reason: `already in ${target?.name}` });
        continue;
      }
      const step = bp.workflow.transitions.find(
        (t) => t.from === record.state && t.to === action.to && t.trigger.on === 'manual',
      );
      if (!step) {
        skipped.push({
          instanceId: record.instanceId,
          reference: record.reference,
          reason: `nothing in the process moves a record from ${record.stateName} to ${target?.name} by hand`,
        });
        continue;
      }
      const by = step.trigger.on === 'manual' ? step.trigger.by : [];
      if (args.principal.kind === 'actor' && !roles.some((r) => by.includes(r))) {
        refused.push({
          instanceId: record.instanceId,
          reference: record.reference,
          reason: `only ${by.map((k) => bp.roles.find((r) => r.key === k)?.name ?? k).join(' or ')} may move it from ${record.stateName} to ${target?.name}`,
        });
        continue;
      }
      eligible.push({ instanceId: record.instanceId, reference: record.reference, to: [target?.name ?? action.to], via: step.key });
      continue;
    }

    const to = (template?.to ?? []).flatMap((party) => resolveRecipient(party, record, bp));
    if (!to.length) {
      skipped.push({
        instanceId: record.instanceId,
        reference: record.reference,
        reason: 'nobody to send to on this record',
      });
      continue;
    }

    eligible.push({ instanceId: record.instanceId, reference: record.reference, to });
  }

  const digest = digestOf(args.plan, action, eligible.map((e) => e.instanceId));
  const summary =
    action.kind === 'send_reminder'
      ? `Send "${template?.name ?? action.template}" to ${eligible.length} of ${matched.length} record(s).`
      : action.kind === 'assign'
        ? `Give the "${taskName}" task to ${action.to.trim()} on ${eligible.length} of ${matched.length} record(s).`
        : action.kind === 'set_answer'
          ? `${
              action.mode === 'add' && field?.type === 'repeating_group'
                ? `Add a row to ${field.label}`
                : action.mode === 'add'
                  ? `Add ${answerWords(field!, [action.value])} to ${field?.label}`
                  : action.mode === 'remove'
                    ? `Remove ${answerWords(field!, [action.value])} from ${field?.label}`
                    : `Set ${field?.label ?? action.field} to ${answerWords(field!, action.value)}`
            } on ${eligible.length} of ${matched.length} record(s).`
          : `Move ${eligible.length} of ${matched.length} record(s) to ${target?.name ?? action.to}.`;

  return { kind: action.kind, summary, digest, eligible, refused, skipped };
}

type SetAnswer = Extract<ActionPlan, { kind: 'set_answer' }>;
type FieldDef = Blueprint['data']['fields'][number];

/**
 * What one record's answer becomes, or why it is left alone.
 *
 * One function for the preview and for the write, so the two cannot
 * disagree. The write calls it again inside the record's lock, against the
 * answer as it is then — "add Monitor" adds to whatever each record has at
 * that moment, not to what the preview saw.
 */
export function nextAnswer(field: FieldDef, action: SetAnswer, current: unknown): { value: unknown } | { skip: string } {
  const mode = action.mode ?? 'set';
  if (mode === 'set') {
    return JSON.stringify(current ?? null) === JSON.stringify(action.value)
      ? { skip: `already ${answerWords(field, action.value)}` }
      : { value: action.value };
  }
  const list = Array.isArray(current) ? current : [];
  if (field.type === 'repeating_group') return { value: [...list, action.value] };
  const option = action.value as string;
  if (mode === 'add') {
    return list.includes(option)
      ? { skip: `already includes ${answerWords(field, [option])}` }
      : { value: [...list, option] };
  }
  if (!list.includes(option)) return { skip: `does not include ${answerWords(field, [option])}` };
  const next = list.filter((o) => o !== option);
  if (!next.length && field.required) return { skip: `it would leave ${field.label} empty, and it is required` };
  return { value: next };
}

/** An answer in words: choice labels, "3 items" for a list of rows, "empty" for nothing. */
function answerWords(field: FieldDef, value: unknown): string {
  const labelOf = (v: unknown) => field.choices?.find((c) => c.value === v)?.label ?? shown(v);
  if (field.type === 'repeating_group') {
    const n = Array.isArray(value) ? value.length : 0;
    return n === 1 ? '1 item' : `${n} items`;
  }
  if (Array.isArray(value)) return value.length ? value.map(labelOf).join(', ') : 'none';
  return labelOf(value);
}

/** One answer on each record, as stored. */
async function valuesOf(client: Client, ids: string[], field: string): Promise<Map<string, unknown>> {
  if (!ids.length) return new Map();
  const { rows } = await client.query<{ id: string; value: unknown }>(
    'select id, data -> $2 as value from instance where id = any($1::uuid[])',
    [ids, field],
  );
  return new Map(rows.map((r) => [r.id, r.value]));
}

function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/** The open task of this kind on each record, and who has it. */
async function openTasksFor(client: Client, ids: string[], taskKey: string): Promise<Map<string, string | null>> {
  if (!ids.length) return new Map();
  const { rows } = await client.query<{ instance_id: string; assignee: string | null }>(
    `select distinct on (instance_id) instance_id, assignee from task
      where instance_id = any($1::uuid[]) and task_key = $2 and status = 'open'
      order by instance_id, id`,
    [ids, taskKey],
  );
  return new Map(rows.map((r) => [r.instance_id, r.assignee]));
}

/**
 * Why this person could not take the work, or null if they could.
 *
 * A role was checked by the compiler. A person is checked here, against the
 * live membership: they must be an active member of this workspace and able
 * to operate this process — which is what completing a task asks of them.
 */
async function problemWithAssignee(
  client: Client,
  bp: Blueprint,
  tenantId: string,
  processKey: string,
  to: string,
): Promise<string | null> {
  const who = to.trim();
  if (who.startsWith('role:')) return null;
  const { rows } = await client.query<{ id: string; active: boolean }>(
    'select id, active from actor where tenant_id = $1 and lower(email) = lower($2)',
    [tenantId, who],
  );
  const member = rows[0];
  if (!member) return `${who} is not a member of this workspace`;
  if (!member.active) return `${who} has been deactivated`;
  const decision = await authorize(client, {
    principal: { kind: 'actor', tenantId, actorId: member.id },
    action: 'operate',
    tenantId,
    processKey,
    blueprint: bp,
  });
  return decision.allowed ? null : `${who} cannot work on this process (${decision.reason})`;
}

/**
 * Resolves who a template addresses, for the preview only.
 *
 * The engine resolves parties again at send time; this exists so the operator
 * can see who is about to be emailed before confirming, which is most of what
 * "authorized targets" means in practice. Role parties are shown as roles
 * rather than expanded into names — expanding them here would put a list of
 * colleagues' addresses on screen for a reminder the operator may not send.
 */
function resolveRecipient(party: unknown, record: MatchedRecord, bp: Blueprint): string[] {
  if (typeof party !== 'object' || party === null) return [];
  const p = party as Record<string, unknown>;
  if (typeof p.role === 'string') {
    const role = bp.roles.find((r) => r.key === p.role);
    return [`role: ${role?.name ?? p.role}`];
  }
  if (typeof p.field === 'string') {
    const value = record.answers[p.field];
    // The field may be redacted out of `answers`, in which case the operator
    // is told there is a recipient without being shown the address.
    if (typeof value === 'string' && value.includes('@')) return [value];
    return [`the ${p.field} on the record`];
  }
  if (typeof p.user === 'string') return [p.user];
  if (p.submitter === true) return ['the person who submitted it'];
  return [];
}

// ------------------------------------------------------------------- asking

export interface Asker {
  name: string;
  model: string;
  promptVersion: string;
  propose(question: string, context: PlanContext): Promise<{ proposal: Proposal; inputTokens?: number; outputTokens?: number }>;
}

export interface PlanContext {
  processKey: string;
  processName: string;
  states: { key: string; name: string; type: string; slaHours?: number }[];
  fields: { key: string; label: string; type: string; classification: string }[];
  tasks: { key: string; name: string }[];
  approvals: { key: string; name: string }[];
  templates: { key: string; name: string; to: string }[];
}

/** Everything the model is told. Answers are not in it; the schema is. */
export function planContext(bp: Blueprint): PlanContext {
  return {
    processKey: bp.key,
    processName: bp.name,
    states: bp.workflow.states.map((s) => ({ key: s.key, name: s.name, type: s.type, slaHours: s.slaHours })),
    // Restricted fields are named so the model can explain that it will not
    // filter on them, rather than inventing a field key that does not exist.
    fields: bp.data.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      classification: f.classification,
    })),
    tasks: bp.workflow.tasks.map((t) => ({ key: t.key, name: t.name })),
    approvals: bp.workflow.approvals.map((a) => ({ key: a.key, name: a.name })),
    templates: bp.communications.email.map((t) => ({
      key: t.key,
      name: t.name,
      to: t.to.map((p) => JSON.stringify(p)).join(', '),
    })),
  };
}

export async function ask(
  pool: Pool,
  asker: Asker,
  args: { principal: Principal; processKey: string; question: string; now?: Date },
): Promise<AskResult> {
  if (args.principal.kind !== 'actor') throw new Error('the copilot answers to signed-in members');
  const tenantId = args.principal.tenantId;
  const now = args.now ?? new Date();

  await enforceRateLimit(pool, args.principal.actorId, tenantId);

  const bp = await inTransaction(pool, (client) => blueprintFor(client, tenantId, args.processKey));

  const started = Date.now();
  let proposal: Proposal;
  try {
    const out = await asker.propose(args.question, planContext(bp));
    proposal = out.proposal;
    var tokens = { input: out.inputTokens, output: out.outputTokens };
  } catch (err) {
    const runId = await recordRun(pool, {
      tenantId,
      actorId: args.principal.actorId,
      processKey: args.processKey,
      question: args.question,
      reading: null,
      plan: {},
      action: null,
      diagnostics: [],
      targets: [],
      digest: null,
      status: 'failed',
      asker,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    throw Object.assign(new Error(`the copilot could not turn that into a plan: ${String(err)}`), { runId });
  }

  // The model may name a different process than the one asked about. It does
  // not get to choose: the caller's process is the scope.
  const plan = QueryPlan.parse({ ...proposal.query, processKey: args.processKey });
  const action = proposal.action ?? null;

  const outcome = await runPlan(pool, { principal: args.principal, plan, action, now });

  const runId = await recordRun(pool, {
    tenantId,
    actorId: args.principal.actorId,
    processKey: args.processKey,
    question: args.question,
    reading: proposal.reading,
    plan,
    action,
    diagnostics: outcome.diagnostics,
    targets: outcome.preview
      ? [
          ...outcome.preview.eligible.map((e) => ({ ...e, decision: 'eligible' as const })),
          ...outcome.preview.refused.map((r) => ({ ...r, decision: 'refused' as const })),
          ...outcome.preview.skipped.map((s) => ({ ...s, decision: 'skipped' as const })),
        ]
      : [],
    digest: outcome.preview?.digest ?? null,
    status: !outcome.ok ? 'refused' : outcome.preview ? 'previewed' : 'answered',
    asker,
    latencyMs: Date.now() - started,
    inputTokens: tokens?.input,
    outputTokens: tokens?.output,
    error: null,
  });

  return {
    runId,
    reading: proposal.reading,
    plan,
    action,
    diagnostics: outcome.diagnostics,
    ok: outcome.ok,
    rows: outcome.rows,
    preview: outcome.preview,
    audit: {
      provider: asker.name,
      model: asker.model,
      promptVersion: asker.promptVersion,
      latencyMs: Date.now() - started,
    },
  };
}

/**
 * §6.4's rate limit, on the asking rather than the sending.
 *
 * A limit on records per action is the obvious one and is enforced in the
 * preview. This is the other half: a loop that asks twenty questions a minute
 * is either a mistake or someone probing the plan language, and both are worth
 * stopping cheaply.
 */
async function enforceRateLimit(pool: Pool, actorId: string, tenantId: string): Promise<void> {
  const { rows } = await pool.query<{ count: number }>(
    `select count(*)::int as count from copilot_run
      where tenant_id = $1 and actor_id = $2 and created_at > now() - interval '1 hour'`,
    [tenantId, actorId],
  );
  if ((rows[0]?.count ?? 0) >= RATE_LIMIT_PER_HOUR) {
    throw new Error(`the copilot is limited to ${RATE_LIMIT_PER_HOUR} questions an hour; try again shortly`);
  }
}

async function recordRun(
  pool: Pool,
  args: {
    tenantId: string;
    actorId: string;
    processKey: string;
    question: string;
    reading: string | null;
    plan: unknown;
    action: unknown;
    diagnostics: Diagnostic[];
    targets: unknown[];
    digest: string | null;
    status: string;
    asker: Asker;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
    error: string | null;
  },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into copilot_run
       (tenant_id, actor_id, process_key, question, reading, plan, action_plan, diagnostics,
        targets, plan_digest, status, provider, model, prompt_version, input_tokens,
        output_tokens, latency_ms, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     returning id`,
    [
      args.tenantId,
      args.actorId,
      args.processKey,
      args.question,
      args.reading,
      JSON.stringify(args.plan),
      args.action ? JSON.stringify(args.action) : null,
      JSON.stringify(args.diagnostics),
      JSON.stringify(args.targets),
      args.digest,
      args.status,
      args.asker.name,
      args.asker.model,
      args.asker.promptVersion,
      args.inputTokens ?? null,
      args.outputTokens ?? null,
      args.latencyMs,
      args.error,
    ],
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------- executing

/**
 * Performs the action the operator confirmed, and nothing else.
 *
 * The digest is not a formality. Without it, "confirm run X" would act on
 * whatever the query matches at the moment of confirmation, and the operator
 * would have approved a number rather than a set. With it, a stale
 * confirmation is refused and re-previewed instead of silently widening.
 */
export async function confirm(
  pool: Pool,
  args: { principal: Principal; runId: string; digest: string; now?: Date },
): Promise<ExecutionReport> {
  if (args.principal.kind !== 'actor') throw new Error('the copilot answers to signed-in members');
  const now = args.now ?? new Date();
  const tenantId = args.principal.tenantId;

  const { rows } = await pool.query<{
    id: string;
    actor_id: string;
    process_key: string;
    plan: QueryPlan;
    action_plan: ActionPlan | null;
    targets: { instanceId: string; reference: string; decision: string }[];
    plan_digest: string | null;
    status: string;
  }>(
    `select id, actor_id, process_key, plan, action_plan, targets, plan_digest, status
       from copilot_run where id = $1 and tenant_id = $2`,
    [args.runId, tenantId],
  );
  const run = rows[0];
  if (!run) throw new Error('no such copilot run');
  if (!run.action_plan) throw new Error('that question did not propose an action');
  if (run.status === 'executed') throw new Error('that plan has already been carried out');

  // The person who confirms must be the person who previewed. Otherwise a
  // preview becomes a stored capability that somebody else can spend.
  if (run.actor_id !== args.principal.actorId) {
    throw new AuthorizationError('operate', 'a plan is confirmed by the person who previewed it');
  }
  if (!run.plan_digest || run.plan_digest !== args.digest) {
    throw new Error('the plan changed since it was previewed — look at it again before confirming');
  }

  const eligible = run.targets.filter((t) => t.decision === 'eligible') as {
    instanceId: string;
    reference: string;
    decision: string;
    to?: string[];
    via?: string;
  }[];
  const engine = new Engine(pool);
  const action = run.action_plan;
  const report: ExecutionReport = {
    runId: run.id,
    kind: action.kind,
    attempted: eligible.length,
    sent: [],
    skipped: [],
    failed: [],
  };
  const why = `bulk action ${run.id.slice(0, 8)}`;
  let loaded: Blueprint | null = null;
  const latestBlueprint = async () =>
    (loaded ??= await inTransaction(pool, (c) => blueprintFor(c, tenantId, run.process_key)));
  /** Reassigned tasks, by record, for the one email each new assignee gets. */
  const handedOver: { instanceId: string; reference: string }[] = [];

  for (const target of eligible) {
    if (action.kind === 'set_answer') {
      try {
        const field = (await latestBlueprint()).data.fields.find((f) => f.key === action.field)!;
        let stale: string | null = null;
        const outcome = await engine.updateRecord({
          principal: args.principal,
          instanceId: target.instanceId,
          patch: {},
          // Worked out again inside the lock, from the record as it is now.
          patchFrom: (data) => {
            const next = nextAnswer(field, action, data[action.field]);
            if ('skip' in next) {
              stale = next.skip;
              return null;
            }
            return { [action.field]: next.value } as never;
          },
          now,
        });
        if (outcome.saved) report.sent.push({ instanceId: target.instanceId, reference: target.reference, to: target.to ?? [] });
        else {
          report.skipped.push({
            instanceId: target.instanceId,
            reference: target.reference,
            reason: stale ?? (outcome.refused?.length ? 'your roles can no longer change it' : 'not saved'),
          });
        }
      } catch (err) {
        report.failed.push({
          instanceId: target.instanceId,
          reference: target.reference,
          reason: err instanceof AuthorizationError ? err.reason : err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // Each is re-authorized inside the engine call, not trusted from the
    // preview: a role can be removed between the two, and the preview is
    // evidence of what was true then, not permission for now.
    if (action.kind === 'assign') {
      try {
        const outcome = await engine.reassignTask({
          principal: args.principal,
          instanceId: target.instanceId,
          taskKey: action.task,
          to: action.to.trim(),
          reason: why,
          now,
        });
        if (outcome.performed) {
          report.sent.push({ instanceId: target.instanceId, reference: target.reference, to: [action.to.trim()] });
          handedOver.push({ instanceId: target.instanceId, reference: target.reference });
        }
        else report.skipped.push({ instanceId: target.instanceId, reference: target.reference, reason: outcome.reason ?? 'no effect' });
      } catch (err) {
        report.failed.push({
          instanceId: target.instanceId,
          reference: target.reference,
          reason: err instanceof AuthorizationError ? err.reason : err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    if (action.kind === 'change_state') {
      try {
        const outcome = await engine.fireManual({
          principal: args.principal,
          instanceId: target.instanceId,
          transitionKey: target.via ?? '',
          now,
        });
        if (outcome.applied) report.sent.push({ instanceId: target.instanceId, reference: target.reference, to: target.to ?? [] });
        else report.skipped.push({ instanceId: target.instanceId, reference: target.reference, reason: outcome.reason ?? 'no effect' });
      } catch (err) {
        report.failed.push({
          instanceId: target.instanceId,
          reference: target.reference,
          reason: err instanceof AuthorizationError ? err.reason : err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    try {
      // Re-authorized at execution, not trusted from the preview: a role can
      // be removed between the two, and the preview is evidence of what was
      // true then, not permission for now.
      const outcome = await engine.runActionOnce({
        principal: args.principal,
        instanceId: target.instanceId,
        action: {
          key: `copilot_${run.id.slice(0, 8)}`,
          do: 'send_email',
          template: (run.action_plan as { template: string }).template,
        },
        // Keyed on the run, so confirming twice sends once — the same
        // mechanism the workflow's own actions use, not a second one.
        idempotencyKey: `copilot:${run.id}`,
        reason: `copilot run ${run.id.slice(0, 8)}`,
        now,
      });
      if (outcome.performed) report.sent.push({ instanceId: target.instanceId, reference: target.reference, to: outcome.recipients });
      else report.skipped.push({ instanceId: target.instanceId, reference: target.reference, reason: outcome.reason ?? 'no effect' });
    } catch (err) {
      report.failed.push({
        instanceId: target.instanceId,
        reference: target.reference,
        reason: err instanceof AuthorizationError ? err.reason : err instanceof Error ? err.message : String(err),
      });
    }
  }

  // A move, or an edit that fires a "record updated" step, queues that step's
  // own actions. Delivered now, so the report is not the only thing that happened.
  if ((action.kind === 'change_state' || action.kind === 'set_answer') && report.sent.length) {
    await engine.drain(now, 'bulk', tenantId);
  }

  if (action.kind === 'assign' && handedOver.length) {
    report.notified = await tellNewAssignee(pool, {
      tenantId,
      actorId: args.principal.actorId,
      runId: run.id,
      processKey: run.process_key,
      taskKey: action.task,
      to: action.to.trim(),
      records: handedOver,
    });
  }

  await pool.query(
    `update copilot_run
        set status = $1, result = $2, confirmed_by = $3, confirmed_at = $4
      where id = $5`,
    [
      report.failed.length ? 'executed' : 'executed',
      JSON.stringify(report),
      `actor:${args.principal.actorId}`,
      now,
      run.id,
    ],
  );

  return report;
}

export interface BulkOptions {
  templates: { key: string; name: string }[];
  tasks: { key: string; name: string }[];
  /** States the process lets somebody move a record into by hand. */
  moveTargets: { key: string; name: string }[];
  /** Who a task could go to: members who can operate this process, and its operating roles. */
  assignees: { value: string; label: string }[];
  /** Answers this member's roles may change, and can be set in bulk. */
  fields: BulkField[];
}

interface BulkField {
  key: string;
  label: string;
  type: string;
  choices?: { value: string; label: string }[];
  required: boolean;
  /** For a repeating group: the answers one row is made of. */
  fields?: BulkField[];
}

function bulkField(f: FieldDef): BulkField {
  return {
    key: f.key,
    label: f.label,
    type: f.type,
    choices: f.choices?.map((ch) => ({ value: ch.value, label: ch.label })),
    required: Boolean(f.required),
    fields: f.type === 'repeating_group' ? (f.fields ?? []).map((child) => bulkField(child as FieldDef)) : undefined,
  };
}

/**
 * What the Records page can offer to do to a selection.
 *
 * Only choices that could work: a move target is a state some manual step
 * leads to, and an assignee is a member who could complete the work. The
 * preview still decides per record — this only keeps the menu from offering
 * things that would be refused on every row.
 */
export async function bulkOptions(pool: Pool, principal: Principal, processKey: string): Promise<BulkOptions> {
  if (principal.kind !== 'actor') throw new Error('the copilot answers to signed-in members');
  const tenantId = principal.tenantId;
  return inTransaction(pool, async (client) => {
    const bp = await blueprintFor(client, tenantId, processKey);
    const viewer = await require_(client, { principal, action: 'view', tenantId, processKey, blueprint: bp }, pool);
    const mayEdit = editableFields(bp, viewer.roles);

    const manualTargets = new Set(bp.workflow.transitions.filter((t) => t.trigger.on === 'manual').map((t) => t.to));
    const { rows: members } = await client.query<{ id: string; email: string; display_name: string }>(
      'select id, email, display_name from actor where tenant_id = $1 and active order by display_name',
      [tenantId],
    );
    const assignees: BulkOptions['assignees'] = [];
    for (const m of members) {
      const decision = await authorize(client, {
        principal: { kind: 'actor', tenantId, actorId: m.id },
        action: 'operate',
        tenantId,
        processKey,
        blueprint: bp,
      });
      if (decision.allowed) assignees.push({ value: m.email, label: `${m.display_name} (${m.email})` });
    }
    for (const r of bp.roles) {
      if (r.kind === 'internal' && r.capabilities.includes('operate')) {
        assignees.push({ value: `role:${r.key}`, label: `Anyone who is ${r.name}` });
      }
    }

    return {
      templates: bp.communications.email.map((t) => ({ key: t.key, name: t.name })),
      tasks: bp.workflow.tasks.map((t) => ({ key: t.key, name: t.name })),
      moveTargets: bp.workflow.states.filter((s) => manualTargets.has(s.key)).map((s) => ({ key: s.key, name: s.name })),
      assignees,
      fields: bp.data.fields
        .filter((f) => mayEdit.has(f.key) && BULK_EDITABLE_TYPES.has(f.type) && f.setBy !== 'system')
        .map(bulkField),
    };
  });
}

/**
 * Tells whoever now has the work.
 *
 * One email per person per bulk action, listing every record — not one per
 * record, because reassigning forty tasks should not put forty messages in
 * somebody's inbox. A role is told through the members who hold it on this
 * process. The body names the task, the record references and who handed
 * them over, with a link to each; it carries no answers, because an email is
 * the one copy of a record this system cannot take back.
 *
 * Nobody is told about work they gave themselves.
 */
async function tellNewAssignee(
  pool: Pool,
  args: {
    tenantId: string;
    actorId: string;
    runId: string;
    processKey: string;
    taskKey: string;
    to: string;
    records: { instanceId: string; reference: string }[];
  },
): Promise<{ to: string; tasks: number; sent: boolean; reason?: string }[]> {
  const { rows: ctx } = await pool.query<{ blueprint: Blueprint; by: string; by_email: string }>(
    `select pv.blueprint, a.display_name as by, a.email as by_email
       from process_version pv, actor a
      where pv.tenant_id = $1 and pv.process_key = $2 and a.id = $3
      order by pv.version desc limit 1`,
    [args.tenantId, args.processKey, args.actorId],
  );
  const c = ctx[0];
  if (!c) return [];
  const taskName = c.blueprint.workflow.tasks.find((t) => t.key === args.taskKey)?.name ?? args.taskKey;

  let recipients: string[];
  if (args.to.startsWith('role:')) {
    const { rows } = await pool.query<{ email: string }>(
      `select distinct a.email from membership m join actor a on a.id = m.actor_id
        where m.tenant_id = $1 and m.process_key = $2 and m.role_key = $3 and a.active`,
      [args.tenantId, args.processKey, args.to.slice(5)],
    );
    recipients = rows.map((r) => r.email);
  } else {
    recipients = [args.to];
  }
  recipients = recipients.filter((r) => r.toLowerCase() !== c.by_email.toLowerCase());

  const n = args.records.length;
  const subject = n === 1 ? `${c.by} gave you a task: ${taskName}` : `${c.by} gave you ${n} tasks: ${taskName}`;
  const text = [
    `${c.by} has given you the "${taskName}" task on ${n === 1 ? 'this record' : `these ${n} records`} in ${c.blueprint.name}:`,
    '',
    ...args.records.map((r) => `  ${r.reference}  ${appUrl()}/console?record=${r.instanceId}`),
    '',
    'They are in your work queue in the console.',
  ].join('\n');

  const told: { to: string; tasks: number; sent: boolean; reason?: string }[] = [];
  for (const email of recipients) {
    const result = await sendPlatformMail(pool, {
      kind: 'task_assigned',
      to: email,
      subject,
      text,
      tenantId: args.tenantId,
      actorId: args.actorId,
      idempotencyKey: `task-assigned:${args.runId}:${email.toLowerCase()}`,
    });
    told.push(
      result && result.status !== 'failed'
        ? { to: email, tasks: n, sent: true }
        : { to: email, tasks: n, sent: false, reason: result?.detail ?? 'the email provider refused it' },
    );
  }
  return told;
}

/** What stands in for a model when the console builds the plan itself. */
const CONSOLE: Pick<Asker, 'name' | 'model' | 'promptVersion'> = { name: 'console', model: 'none', promptVersion: 'direct' };

/**
 * A plan the console built — from filters, or from rows somebody ticked.
 *
 * Previewing an action records a run, the same as asking does, because the
 * confirmation is bound to that run: its digest, its target list, and the
 * person who previewed it. Without the record there is nothing to confirm,
 * which is why this path could preview a bulk action and never carry one
 * out. Only runs with an action are recorded — a filter is not an event —
 * and they count against the same hourly limit as questions.
 */
export async function runDirect(
  pool: Pool,
  args: { principal: Principal; plan: QueryPlan; action?: ActionPlan | null; label?: string; now?: Date },
): Promise<{
  runId: string | null;
  rows: MatchedRecord[];
  diagnostics: Diagnostic[];
  ok: boolean;
  preview: ActionPreview | null;
}> {
  if (args.principal.kind !== 'actor') throw new Error('the copilot answers to signed-in members');
  const { actorId, tenantId } = args.principal;
  if (args.action) await enforceRateLimit(pool, actorId, tenantId);

  const started = Date.now();
  const outcome = await runPlan(pool, { principal: args.principal, plan: args.plan, action: args.action, now: args.now });
  if (!args.action) return { runId: null, rows: outcome.rows, diagnostics: outcome.diagnostics, ok: outcome.ok, preview: null };

  const runId = await recordRun(pool, {
    tenantId,
    actorId,
    processKey: args.plan.processKey,
    question: args.label ?? 'bulk action from the console',
    reading: outcome.preview?.summary ?? null,
    plan: args.plan,
    action: args.action,
    diagnostics: outcome.diagnostics,
    targets: outcome.preview
      ? [
          ...outcome.preview.eligible.map((e) => ({ ...e, decision: 'eligible' as const })),
          ...outcome.preview.refused.map((r) => ({ ...r, decision: 'refused' as const })),
          ...outcome.preview.skipped.map((x) => ({ ...x, decision: 'skipped' as const })),
        ]
      : [],
    digest: outcome.preview?.digest ?? null,
    status: !outcome.ok ? 'refused' : 'previewed',
    asker: CONSOLE as Asker,
    latencyMs: Date.now() - started,
    error: null,
  });
  return { runId, rows: outcome.rows, diagnostics: outcome.diagnostics, ok: outcome.ok, preview: outcome.preview };
}

/** The §7.3 record of what was asked and what happened, newest first. */
export async function recentRuns(pool: Pool, principal: Principal, limit = 25) {
  if (principal.kind !== 'actor') throw new Error('the copilot answers to signed-in members');
  const { rows } = await pool.query(
    `select r.id, r.question, r.reading, r.process_key, r.status, r.plan, r.action_plan,
            r.result, r.provider, r.model, r.prompt_version, r.latency_ms, r.error,
            r.created_at, r.confirmed_at, a.display_name as asked_by
       from copilot_run r left join actor a on a.id = r.actor_id
      where r.tenant_id = $1
      order by r.created_at desc limit $2`,
    [principal.tenantId, Math.min(limit, 100)],
  );
  return rows;
}
