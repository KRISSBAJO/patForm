import { createHash } from 'node:crypto';
import { isSignature, signatureWords } from '../blueprint/signature.js';
import type { Blueprint } from '../blueprint/index.js';
import { inTransaction, type Client, type Pool } from './db.js';
import { AuthorizationError, redact, require_, requireWorkspaceCapability, visibleFields, type Principal } from './policy.js';
import { xlsx, type Cell } from './xlsx.js';
import { currentRequestId } from './trace.js';
import type { Field } from '../blueprint/data.js';

/**
 * Exporting a record and its audit history.
 *
 * §20.1 step 11: "An administrator exports the record and audit history and
 * then applies the configured retention action." The retention half exists
 * already (retention.ts); this is the other half, and it has to come first —
 * exporting *after* the deletion is not a thing you can do, so the ordering in
 * that sentence is a requirement, not prose.
 *
 * What makes this more than a `select *`:
 *
 * **Redaction still applies.** An export is a read, and §6.4's "sensitive
 * fields can be hidden from roles that otherwise access the record" does not
 * stop being true because the read produces a file. An administrator with
 * `administer` but no process role holding the payroll fields gets the record
 * without them, and the bundle says so rather than silently omitting them —
 * a gap you cannot see is worse than one you can.
 *
 * **The history is the point.** §6.4: "corrections append history; destructive
 * overwriting of audit evidence is prohibited." An export that carried only
 * current values would be a snapshot, and the thing being retained for is
 * usually the sequence: who decided, when, on what grounds, what was sent.
 *
 * **The export is itself an event.** Taking a copy of somebody's personal data
 * out of the system is exactly the act an audit exists to record, and it would
 * be odd for the feature that produces audit evidence to leave none.
 */

export interface ExportBundle {
  exportedAt: string;
  exportedBy: string;
  /** sha256 over the canonical JSON of everything below it. */
  checksum: string;
  record: {
    reference: string;
    instanceId: string;
    processKey: string;
    processName: string;
    version: number;
    state: string;
    stateName: string;
    outcome: string | null;
    createdAt: string;
    completedAt: string | null;
    answers: Record<string, unknown>;
  };
  /** Field keys the exporter's roles are not allowed to see. Named, not hidden. */
  withheld: string[];
  history: {
    seq: number;
    type: string;
    actor: string | null;
    occurredAt: string;
    payload: unknown;
  }[];
  approvals: {
    approvalKey: string;
    name: string;
    approvers: string[];
    status: string;
    decision: string | null;
    decidedBy: string | null;
    decidedAt: string | null;
    reason: string | null;
  }[];
  tasks: {
    taskKey: string;
    name: string;
    assignee: string | null;
    status: string;
    dueAt: string | null;
    completedAt: string | null;
    completedBy: string | null;
  }[];
  messages: {
    templateKey: string;
    recipients: string[];
    subject: string;
    status: string;
    providerMessageId: string | null;
    failure: string | null;
  }[];
  documents: {
    filename: string;
    documentKey: string;
    byteSize: number;
    checksum: string;
    createdAt: string;
  }[];
  /** What the process says about how long this is kept. */
  retention: { days: number | null; dueAt: string | null; action: string };
}

function reference(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Builds the bundle.
 *
 * `administer` rather than `view`, deliberately. Reading one record on screen
 * and taking the whole file including every decision and every message are
 * different acts with different blast radii, and §20.1 step 11 says
 * administrator for a reason.
 */
export async function exportRecord(
  pool: Pool,
  args: { principal: Principal; instanceId: string; now?: Date },
): Promise<ExportBundle> {
  const now = args.now ?? new Date();

  const bundle = await inTransaction(pool, async (client) => {
    const instance = await loadInstance(client, args.instanceId);
    const { rows: versions } = await client.query<{ blueprint: Blueprint; version: number }>(
      'select blueprint, version from process_version where id = $1',
      [instance.process_version_id],
    );
    const bp = versions[0]!.blueprint;

    const decision = await require_(
      client,
      {
        principal: args.principal,
        action: 'administer',
        tenantId: instance.tenant_id,
        processKey: instance.process_key,
        blueprint: bp,
        instanceId: instance.id,
      },
      pool,
    );

    // redact() substitutes the string "[redacted]" rather than removing the
    // key, which is right on screen — the reader should see that something is
    // there — and wrong in an export, where a literal "[redacted]" in a value
    // column reads as data. So the placeholders are lifted out into `withheld`
    // and the answers carry only what this role may actually see.
    const redacted = redact(bp, decision.roles, instance.data, decision.workspaceRole);
    const withheld: string[] = [];
    const visible: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(redacted)) {
      if (value === '[redacted]') withheld.push(key);
      else visible[key] = value;
    }

    const state = bp.workflow.states.find((s) => s.key === instance.state);

    // Sequential, not Promise.all. A pg client is one connection and one
    // statement at a time; issuing five at once on the same client is a
    // deprecation warning today and a lost query later. The parallelism would
    // have been imaginary anyway.
    const history = await
      client.query<{ seq: number; type: string; actor: string | null; occurred_at: Date; payload: unknown }>(
        'select seq, type, actor, occurred_at, payload from event where instance_id = $1 order by seq',
        [instance.id],
      );
    const approvals = await
      client.query<{
        approval_key: string;
        approvers: string[];
        status: string;
        decision: string | null;
        decided_by: string | null;
        decided_at: Date | null;
        reason: string | null;
      }>(
        `select approval_key, approvers, status, decision, decided_by, decided_at, reason
           from approval_request where instance_id = $1 order by id`,
        [instance.id],
      );
    const tasks = await
      client.query<{
        task_key: string;
        assignee: string | null;
        status: string;
        due_at: Date | null;
        completed_at: Date | null;
        completed_by: string | null;
      }>(
        `select task_key, assignee, status, due_at, completed_at, completed_by
           from task where instance_id = $1 order by id`,
        [instance.id],
      );
    const messages = await
      client.query<{
        template_key: string;
        recipients: string[];
        subject: string;
        status: string;
        provider_message_id: string | null;
        failure: string | null;
      }>(
        `select template_key, recipients, subject, status, provider_message_id, failure
           from email_log where instance_id = $1 order by id`,
        [instance.id],
      );
    const documents = await
      client.query<{
        filename: string;
        document_key: string;
        byte_size: number;
        checksum: string;
        created_at: Date;
      }>(
        `select filename, document_key, byte_size, checksum, created_at
           from document where instance_id = $1 order by id`,
        [instance.id],
      );

    const retentionDays = bp.intent.retentionDays ?? null;
    const anchor = instance.completed_at ?? instance.created_at;

    const body = {
      record: {
        reference: reference(instance.id),
        instanceId: instance.id,
        processKey: instance.process_key,
        processName: bp.name,
        version: versions[0]!.version,
        state: instance.state,
        stateName: state?.name ?? instance.state,
        outcome: instance.outcome,
        createdAt: instance.created_at.toISOString(),
        completedAt: iso(instance.completed_at),
        answers: visible,
      },
      withheld,
      history: history.rows.map((e) => ({
        seq: e.seq,
        type: e.type,
        actor: e.actor,
        occurredAt: e.occurred_at.toISOString(),
        payload: e.payload,
      })),
      approvals: approvals.rows.map((a) => ({
        approvalKey: a.approval_key,
        name: bp.workflow.approvals.find((x) => x.key === a.approval_key)?.name ?? a.approval_key,
        approvers: a.approvers,
        status: a.status,
        decision: a.decision,
        decidedBy: a.decided_by,
        decidedAt: iso(a.decided_at),
        reason: a.reason,
      })),
      tasks: tasks.rows.map((t) => ({
        taskKey: t.task_key,
        name: bp.workflow.tasks.find((x) => x.key === t.task_key)?.name ?? t.task_key,
        assignee: t.assignee,
        status: t.status,
        dueAt: iso(t.due_at),
        completedAt: iso(t.completed_at),
        completedBy: t.completed_by,
      })),
      messages: messages.rows.map((m) => ({
        templateKey: m.template_key,
        recipients: m.recipients,
        subject: m.subject,
        status: m.status,
        providerMessageId: m.provider_message_id,
        failure: m.failure,
      })),
      documents: documents.rows.map((doc) => ({
        filename: doc.filename,
        documentKey: doc.document_key,
        byteSize: doc.byte_size,
        checksum: doc.checksum,
        createdAt: doc.created_at.toISOString(),
      })),
      retention: {
        days: retentionDays,
        dueAt: retentionDays ? new Date(anchor.getTime() + retentionDays * 86_400_000).toISOString() : null,
        // Retention is a deletion, not an archive. Saying so on the export is
        // the only place anyone reads it at the moment it matters.
        action: retentionDays ? 'delete the record and its history' : 'kept indefinitely — no retention period is set',
      },
    };

    return { body, tenantId: instance.tenant_id, instanceId: instance.id };
  });

  const exportedBy = args.principal.kind === 'actor' ? `actor:${args.principal.actorId}` : args.principal.kind;

  /*
   * The checksum covers the record's substance, not the log of who has copied
   * it.
   *
   * Two things pulled against each other here. Recording each export as an
   * event is right — taking a copy of somebody's personal data is exactly what
   * an audit is for — but it also means the second export's history contains
   * the first export's event, so no two exports of an unchanged record would
   * ever hash the same, and the checksum would be useless for the one thing it
   * is for: checking a file you were handed against the system that made it.
   *
   * So `record_exported` entries are carried in the bundle, where a reader can
   * see who took a copy and when, and left out of the digest. Nothing about
   * the record itself is excluded.
   */
  const checksum = createHash('sha256')
    .update(
      JSON.stringify({
        ...bundle.body,
        history: bundle.body.history.filter((e) => e.type !== 'record_exported'),
      }),
    )
    .digest('hex');

  // Appended after the read commits, on its own statement: the export is a
  // fact about the record whether or not anything else succeeds, and it must
  // not be able to roll back with a caller's transaction.
  await pool.query(
    `insert into event (tenant_id, instance_id, seq, type, payload, actor, occurred_at)
     values ($1, $2, (select coalesce(max(seq), 0) + 1 from event where instance_id = $2), 'record_exported', $3, $4, $5)`,
    [
      bundle.tenantId,
      bundle.instanceId,
      JSON.stringify({ checksum, withheld: bundle.body.withheld, events: bundle.body.history.length }),
      exportedBy,
      now,
    ],
  );

  return { exportedAt: now.toISOString(), exportedBy, checksum, ...bundle.body };
}

async function loadInstance(client: Client, instanceId: string) {
  const { rows } = await client.query<{
    id: string;
    tenant_id: string;
    process_key: string;
    process_version_id: string;
    state: string;
    data: Record<string, unknown>;
    outcome: string | null;
    created_at: Date;
    completed_at: Date | null;
  }>('select * from instance where id = $1', [instanceId]);
  if (!rows[0]) throw new Error('no such record');
  return rows[0];
}

/**
 * The same bundle as CSV, for the §5.1 "filters, exports" line and for anyone
 * who has to put this in front of a regulator who uses a spreadsheet.
 *
 * Two sheets' worth of data do not fit one CSV, so this emits sections with
 * their own header rows rather than pretending the record and its history have
 * the same shape. Excel copes; so does a person.
 */
export function bundleToCsv(bundle: ExportBundle): string {
  const out: string[] = [];
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    // A drawn signature is an image; a spreadsheet cell gets who signed and how.
    const text = isSignature(value)
      ? signatureWords(value)
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
    // A leading =, +, - or @ is executed as a formula by spreadsheet software.
    // Prefixing an apostrophe is the standard defence against somebody typing
    // a payload into a form field and having it run on an auditor's machine.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const row = (...cells: unknown[]) => out.push(cells.map(cell).join(','));

  row('Record');
  row('Reference', 'Process', 'Version', 'State', 'Outcome', 'Created', 'Completed', 'Exported by', 'Checksum');
  row(
    bundle.record.reference,
    bundle.record.processName,
    bundle.record.version,
    bundle.record.stateName,
    bundle.record.outcome,
    bundle.record.createdAt,
    bundle.record.completedAt,
    bundle.exportedBy,
    bundle.checksum,
  );
  out.push('');

  row('Answers');
  row('Field', 'Value');
  for (const [key, value] of Object.entries(bundle.record.answers)) row(key, value);
  for (const key of bundle.withheld) row(key, '(withheld: not visible to the exporting role)');
  out.push('');

  row('Audit history');
  row('Seq', 'Type', 'Actor', 'Occurred at', 'Detail');
  for (const e of bundle.history) row(e.seq, e.type, e.actor, e.occurredAt, e.payload);
  out.push('');

  row('Approvals');
  row('Approval', 'Approvers', 'Status', 'Decision', 'Decided by', 'Decided at', 'Reason');
  for (const a of bundle.approvals) {
    row(a.name, a.approvers.join('; '), a.status, a.decision, a.decidedBy, a.decidedAt, a.reason);
  }
  out.push('');

  row('Tasks');
  row('Task', 'Assignee', 'Status', 'Due', 'Completed at', 'Completed by');
  for (const t of bundle.tasks) row(t.name, t.assignee, t.status, t.dueAt, t.completedAt, t.completedBy);
  out.push('');

  row('Messages');
  row('Template', 'Recipients', 'Subject', 'Status', 'Provider id', 'Failure');
  for (const m of bundle.messages) {
    row(m.templateKey, m.recipients.join('; '), m.subject, m.status, m.providerMessageId, m.failure);
  }
  out.push('');

  row('Documents');
  row('Filename', 'Document', 'Bytes', 'Checksum', 'Created');
  for (const doc of bundle.documents) row(doc.filename, doc.documentKey, doc.byteSize, doc.checksum, doc.createdAt);
  out.push('');

  row('Retention');
  row('Period (days)', 'Due', 'Action');
  row(bundle.retention.days, bundle.retention.dueAt, bundle.retention.action);

  return out.join('\n');
}

// ------------------------------------------------------------ whole process

/**
 * Every submission of one process, as a table: one row per record, one
 * column per answer. Written out as CSV, as an Excel workbook, or with every
 * process of the workspace as one workbook, a sheet each.
 *
 * The record export above is for a regulator with one case in hand. This is
 * for the treasurer who wants every expense claim of the quarter in Excel, and
 * it is the first thing a small organisation asks for once forms are coming
 * in. It follows the same rules as every other read:
 *
 * - **Capability.** `report` rather than `administer`: an analyst or an
 *   operator may take the sheet, an approver may not. The whole workspace in
 *   one file is `administer`.
 * - **Visibility.** A field this caller's roles may not see is not a column.
 *   The response names those fields, so the gap is visible rather than a
 *   quiet omission, and a cell never carries a "[redacted]" that a formula
 *   would count as data.
 * - **The blueprint's say.** `outputs.exportFields`, when set, is the column
 *   list and its order. When it is empty, every answer field is a column.
 * - **The same filters as the page.** Still running or finished, the search
 *   text, and one answer, matched among visible fields only, exactly as the
 *   Records page matches them, so what is downloaded is what was looked at.
 * - **A record of the taking.** Each export is written to `process_export`
 *   with who, when, how many rows and what was withheld.
 *
 * Values are what a spreadsheet wants: labels for choices, ISO dates, plain
 * numbers, Yes/No, and the rows of a list as JSON. Not the on-screen text,
 * which puts currency symbols and "12 Mar" in cells that then refuse to sum.
 */
export interface ExportFilters {
  completed?: boolean;
  /** Free text, matched against the reference and the visible answers. */
  query?: string;
  /** One answer that must equal a value. */
  answer?: { field: string; value: string };
}

export interface ProcessTable {
  processKey: string;
  processName: string;
  header: string[];
  rows: Cell[][];
  count: number;
  withheld: string[];
  /** True when the sheet stopped at the cap; the newest rows come first. */
  truncated: boolean;
  /** YYYY-MM-DD of the export, for a filename. */
  stamp: string;
  /** "-open", "-finished" or "", for a filename. */
  which: string;
}

export interface ProcessExport {
  filename: string;
  body: string;
  rows: number;
  withheld: string[];
  truncated: boolean;
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const BATCH = 2000;
const CAP = 50_000;

/** One cell for one answer, in the form a spreadsheet handles best. */
export function exportCell(field: Pick<Field, 'type' | 'choices'>, value: unknown): string | number {
  if (value === null || value === undefined || value === '') return '';
  if (isSignature(value)) return signatureWords(value);
  const label = (v: unknown) => field.choices?.find((c) => c.value === v)?.label ?? String(v);
  switch (field.type) {
    case 'single_choice':
    case 'dropdown':
      return label(value);
    case 'multi_choice':
    case 'matrix':
      return Array.isArray(value) ? value.map(label).join('; ') : label(value);
    case 'yes_no':
    case 'signature_ack':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    case 'number':
    case 'currency':
    case 'calculated':
    case 'rating':
      return typeof value === 'number' ? value : Number.isFinite(Number(value)) ? Number(value) : String(value);
    case 'file':
      return Array.isArray(value) ? `${value.length} file${value.length === 1 ? '' : 's'}` : '1 file';
    case 'repeating_group':
      return Array.isArray(value) ? JSON.stringify(value.map(stripRedacted)) : String(value);
    default:
      if (Array.isArray(value)) return value.map(String).join('; ');
      if (typeof value === 'object') return JSON.stringify(stripRedacted(value as Record<string, unknown>));
      return String(value);
  }
}

function stripRedacted(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  return Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([, v]) => v !== '[redacted]'));
}

function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  // The same formula defence as the record export: a leading =, +, - or @
  // would otherwise run on whoever opens the file.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** A table as CSV, with a byte-order mark so Excel reads it as UTF-8. */
export function tableToCsv(table: Pick<ProcessTable, 'header' | 'rows'>): string {
  const lines = [table.header.map(csvCell).join(','), ...table.rows.map((r) => r.map(csvCell).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Tables as a workbook, one sheet each, named after the process. */
export function tablesToXlsx(tables: ProcessTable[]): Buffer {
  return xlsx(tables.map((t) => ({ name: t.processName, rows: [t.header, ...t.rows] })));
}

export async function exportProcessTable(
  pool: Pool,
  args: { principal: Principal; processKey: string; filters?: ExportFilters; now?: Date },
): Promise<ProcessTable> {
  const now = args.now ?? new Date();
  const filters = args.filters ?? {};
  if (args.principal.kind !== 'actor') throw new Error('an export is taken by a signed-in member');
  const tenantId = args.principal.tenantId;
  const actorId = args.principal.actorId;

  const result = await inTransaction(pool, async (client) => {
    const { rows: versions } = await client.query<{ blueprint: Blueprint }>(
      `select blueprint from process_version
        where tenant_id = $1 and process_key = $2 order by version desc limit 1`,
      [tenantId, args.processKey],
    );
    if (!versions[0]) throw new Error(`no published process "${args.processKey}"`);
    const bp = versions[0].blueprint;

    const decision = await require_(
      client,
      { principal: args.principal, action: 'report', tenantId, processKey: args.processKey, blueprint: bp },
      pool,
    );

    const askedFor = bp.outputs.exportFields.length
      ? bp.outputs.exportFields
      : bp.data.fields.filter((f) => f.type !== 'content' && f.type !== 'hidden').map((f) => f.key);
    const visibleKeys = visibleFields(bp, decision.roles, decision.workspaceRole);
    const visible = new Set(visibleKeys);
    const byKey = new Map(bp.data.fields.map((f) => [f.key, f]));
    const columns = askedFor.map((k) => byKey.get(k)).filter((f): f is Field => Boolean(f) && visible.has(f!.key));
    const withheld = askedFor.filter((k) => byKey.has(k) && !visible.has(k));
    const stateName = new Map(bp.workflow.states.map((st) => [st.key, st.name]));

    // The same filters, built the same way, as the Records page.
    const params: unknown[] = [tenantId, args.processKey];
    const where = ['i.tenant_id = $1', 'i.process_key = $2'];
    const push = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    if (filters.completed !== undefined) where.push(filters.completed ? 'i.completed_at is not null' : 'i.completed_at is null');
    if (filters.answer) {
      if (!visible.has(filters.answer.field)) throw new Error(`"${filters.answer.field}" is not a field you can filter by`);
      where.push(`i.data ->> ${push(filters.answer.field)} = ${push(filters.answer.value)}`);
    }
    const q = filters.query?.trim();
    if (q) {
      const safe = q.replace(/[%_!]/g, (m) => `!${m}`);
      where.push(
        `(i.id::text ilike ${push(`${safe}%`)} escape '!'
          or exists (
            select 1 from jsonb_each_text(i.data) kv
             where kv.key = any(${push(visibleKeys)}::text[]) and kv.value ilike ${push(`%${safe}%`)} escape '!'))`,
      );
    }

    const header = ['Reference', 'Stage', 'Outcome', 'Created', 'Completed', ...columns.map((c) => c.label)];
    const out: Cell[][] = [];
    let truncated = false;
    interface Row { id: string; state: string; outcome: string | null; created_at: Date; completed_at: Date | null; data: Record<string, unknown> }
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const pageParams = [...params];
      let page = '';
      if (after !== null) {
        pageParams.push(after.createdAt, after.id);
        page = `and (i.created_at, i.id) < ($${pageParams.length - 1}, $${pageParams.length})`;
      }
      pageParams.push(BATCH);
      const { rows }: { rows: Row[] } = await client.query<Row>(
        `select i.id, i.state, i.outcome, i.created_at, i.completed_at, i.data
           from instance i where ${where.join(' and ')} ${page}
          order by i.created_at desc, i.id desc limit $${pageParams.length}`,
        pageParams,
      );
      for (const r of rows) {
        if (out.length >= CAP) { truncated = true; break; }
        const data = redact(bp, decision.roles, r.data, decision.workspaceRole);
        out.push([
          reference(r.id),
          stateName.get(r.state) ?? r.state,
          r.outcome ?? '',
          r.created_at.toISOString(),
          r.completed_at ? r.completed_at.toISOString() : '',
          ...columns.map((c) => exportCell(c, data[c.key])),
        ]);
      }
      if (truncated || rows.length < BATCH) break;
      const last: Row = rows[rows.length - 1]!;
      after = { createdAt: last.created_at, id: last.id };
    }

    return {
      processKey: args.processKey,
      processName: bp.name,
      header,
      rows: out,
      count: out.length,
      withheld,
      truncated,
      stamp: now.toISOString().slice(0, 10),
      which: filters.completed === undefined ? '' : filters.completed ? '-finished' : '-open',
    };
  });

  // Recorded after the read commits and outside it, like the record export:
  // that a copy was taken is true whether or not anything else succeeds.
  await pool.query(
    `insert into process_export (tenant_id, process_key, actor, rows, withheld, filters, request_id, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, args.processKey, actorId, result.count, result.withheld, JSON.stringify(filters), currentRequestId(), now],
  );

  return result;
}

export async function exportProcessCsv(
  pool: Pool,
  args: { principal: Principal; processKey: string; filters?: ExportFilters; now?: Date },
): Promise<ProcessExport> {
  const t = await exportProcessTable(pool, args);
  return { filename: `${t.processKey}${t.which}-${t.stamp}.csv`, body: tableToCsv(t), rows: t.count, withheld: t.withheld, truncated: t.truncated };
}

export async function exportProcessXlsx(
  pool: Pool,
  args: { principal: Principal; processKey: string; filters?: ExportFilters; now?: Date },
): Promise<{ filename: string; base64: string; rows: number; withheld: string[]; truncated: boolean }> {
  const t = await exportProcessTable(pool, args);
  return {
    filename: `${t.processKey}${t.which}-${t.stamp}.xlsx`,
    base64: tablesToXlsx([t]).toString('base64'),
    rows: t.count,
    withheld: t.withheld,
    truncated: t.truncated,
  };
}

/**
 * The whole workspace in one workbook: a sheet per published process, and a
 * first sheet listing them with their counts. `administer`, because it is
 * everything. A process this administrator's roles cannot report on is
 * listed with the reason rather than silently absent.
 */
export async function exportWorkspace(
  pool: Pool,
  args: { principal: Principal; now?: Date },
): Promise<{ filename: string; base64: string; processes: { key: string; name: string; rows: number; withheld: string[]; skipped?: string }[] }> {
  const now = args.now ?? new Date();
  await requireWorkspaceCapability(pool, args.principal, 'administer', 'workspace-export');
  if (args.principal.kind !== 'actor') throw new Error('an export is taken by a signed-in member');
  const { rows: processes } = await pool.query<{ process_key: string; name: string }>(
    `select distinct on (process_key) process_key, blueprint ->> 'name' as name
       from process_version where tenant_id = $1 order by process_key, version desc`,
    [args.principal.tenantId],
  );
  const tables: ProcessTable[] = [];
  const listed: { key: string; name: string; rows: number; withheld: string[]; skipped?: string }[] = [];
  for (const p of processes) {
    try {
      const t = await exportProcessTable(pool, { principal: args.principal, processKey: p.process_key, now });
      tables.push(t);
      listed.push({ key: p.process_key, name: p.name, rows: t.count, withheld: t.withheld });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        listed.push({ key: p.process_key, name: p.name, rows: 0, withheld: [], skipped: err.reason });
        continue;
      }
      throw err;
    }
  }
  const index: ProcessTable = {
    processKey: '_index',
    processName: 'Processes',
    header: ['Process', 'Key', 'Records', 'Fields withheld', 'Note'],
    rows: listed.map((l) => [l.name, l.key, l.rows, l.withheld.join('; '), l.skipped ?? '']),
    count: listed.length,
    withheld: [],
    truncated: false,
    stamp: now.toISOString().slice(0, 10),
    which: '',
  };
  return {
    filename: `workspace-${now.toISOString().slice(0, 10)}.xlsx`,
    base64: tablesToXlsx([index, ...tables]).toString('base64'),
    processes: listed,
  };
}
