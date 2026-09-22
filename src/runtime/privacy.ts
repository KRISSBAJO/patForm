import type { Blueprint, Field } from '../blueprint/index.js';
import { inTransaction, type Client, type Pool } from './db.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';

/**
 * The privacy gate, §20.2: *"Data map, retention behavior, subprocessors,
 * privacy terms, and deletion workflow reviewed."*
 *
 * Two of those five are code rather than prose.
 *
 * **The data map is derived, not written.** A hand-maintained record of what
 * personal data a system holds is accurate on the day it is written and wrong
 * by the next publish — and being wrong is worse than being absent, because
 * somebody relies on it. Everything it needs is already declared: the
 * compiler knows every field, its classification, why it was collected, who
 * may see it, where it is sent, and how long it is kept. So the map is
 * computed from the published versions actually in the database.
 *
 * **Erasure is not retention.** Retention deletes by *age*, per process,
 * whole records. A privacy request deletes by *person*, across every process,
 * and immediately runs into the thing that makes it interesting: a person can
 * appear in somebody else's record. The hiring manager named on a new hire's
 * form is a data subject in a record that is not theirs. Erasing them must not
 * delete the new hire.
 *
 * So this distinguishes two ways of appearing in a record, and treats them
 * differently — see `findSubject`.
 */

// -------------------------------------------------------------- the data map

export interface FieldMap {
  key: string;
  label: string;
  type: string;
  classification: string;
  /** Who supplies it. */
  setBy: string;
  required: boolean;
  /** §12.1 data minimisation: why this is held at all. */
  collectionReason: string | null;
  /** Roles that may never see it. */
  hiddenFrom: string[];
  /** Where a value can leave the record. */
  leaves: string[];
}

export interface ProcessMap {
  processKey: string;
  processName: string;
  version: number;
  /** What the process is for, in the customer's words — §12's purpose limitation. */
  purpose: string;
  respondents: string;
  sensitivityCeiling: string;
  retention: { days: number | null; action: string };
  liveRecords: number;
  fields: FieldMap[];
  /** Fields whose combination identifies one person. */
  identity: string[];
  /** Classifications present, counted, so over-collection is visible at a glance. */
  byClassification: Record<string, number>;
  /** Anything the map itself wants reviewed. */
  notes: string[];
}

function flatten(fields: Field[], out: Field[] = []): Field[] {
  for (const f of fields) {
    out.push(f);
    if (f.fields) flatten(f.fields, out);
  }
  return out;
}

/**
 * Where a field's value can leave the record it was collected into.
 *
 * This is the column a reviewer reads first, and the one a written data map
 * always gets wrong, because a template changes and the document does not.
 * Every route here is resolved from the blueprint: a placeholder in an email
 * body, a document mapping, a webhook payload, a CSV export, an approval's
 * context, or a party addressed by that field.
 */
function routesOut(bp: Blueprint, key: string): string[] {
  const out: string[] = [];
  const placeholder = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`);

  for (const t of bp.communications.email) {
    if (placeholder.test(t.body) || placeholder.test(t.subject)) {
      out.push(`email "${t.name}" (${t.class})`);
    }
    for (const party of [...t.to, ...t.cc]) {
      if (typeof party === 'object' && party && 'field' in party && party.field === key) {
        out.push(`email "${t.name}" is addressed to this field`);
      }
    }
  }

  for (const doc of bp.outputs.documents) {
    const mapping = JSON.stringify(doc);
    if (placeholder.test(mapping) || mapping.includes(`"${key}"`)) out.push(`document "${doc.key}"`);
  }

  for (const transition of bp.workflow.transitions) {
    for (const action of transition.actions ?? []) {
      if (action.do === 'call_webhook' && (action.includeFields ?? []).includes(key)) {
        out.push(`webhook "${action.event}" — leaves the platform`);
      }
    }
  }

  if (bp.outputs.exportFields.includes(key)) out.push('CSV export');

  for (const approval of bp.workflow.approvals) {
    if ((approval.contextFields ?? []).includes(key)) out.push(`shown to approvers of "${approval.name}"`);
  }

  for (const task of bp.workflow.tasks) {
    if (typeof task.assignee === 'object' && 'field' in task.assignee && task.assignee.field === key) {
      out.push(`task "${task.name}" is assigned using this field`);
    }
  }

  return [...new Set(out)];
}

export async function dataMap(pool: Pool, principal: Principal): Promise<ProcessMap[]> {
  await requireWorkspaceCapability(pool, principal, 'report', 'data-map');
  if (principal.kind !== 'actor') throw new Error('unreachable');

  const { rows } = await pool.query<{ blueprint: Blueprint; version: number; process_key: string }>(
    `with latest as (
       select distinct on (process_key) process_key, version, blueprint
         from process_version where tenant_id = $1 order by process_key, version desc
     ) select process_key, version, blueprint from latest order by process_key`,
    [principal.tenantId],
  );

  const maps: ProcessMap[] = [];
  for (const row of rows) {
    const bp = row.blueprint;
    const { rows: counts } = await pool.query<{ count: number }>(
      'select count(*)::int as count from instance where tenant_id = $1 and process_key = $2',
      [principal.tenantId, row.process_key],
    );

    const fields = flatten(bp.data.fields);
    const byClassification: Record<string, number> = {};
    const notes: string[] = [];

    const mapped: FieldMap[] = fields.map((f) => {
      byClassification[f.classification] = (byClassification[f.classification] ?? 0) + 1;
      const hiddenFrom = bp.roles.filter((r) => (r.hiddenFields ?? []).includes(f.key)).map((r) => r.name);

      if ((f.classification === 'restricted' || f.classification === 'confidential') && !f.collectionReason) {
        notes.push(`"${f.label}" is ${f.classification} and records no reason for being collected.`);
      }
      if (f.classification === 'restricted' && !hiddenFrom.length) {
        notes.push(`"${f.label}" is restricted and hidden from nobody — every role in this process can read it.`);
      }

      return {
        key: f.key,
        label: f.label,
        type: f.type,
        classification: f.classification,
        setBy: f.setBy ?? 'respondent',
        required: f.required ?? false,
        collectionReason: f.collectionReason ?? null,
        hiddenFrom,
        leaves: routesOut(bp, f.key),
      };
    });

    if (!bp.intent.retentionDays) {
      notes.push('No retention period is set, so records are kept indefinitely and no deletion job will touch them.');
    }
    if (!bp.data.identity?.length) {
      notes.push('No identity fields are declared, so an erasure request cannot find this person automatically.');
    }

    maps.push({
      processKey: row.process_key,
      processName: bp.name,
      version: row.version,
      purpose: bp.intent.outcome,
      respondents: bp.intent.respondents,
      sensitivityCeiling: bp.intent.sensitivityCeiling,
      retention: {
        days: bp.intent.retentionDays ?? null,
        action: bp.intent.retentionDays
          ? 'the record and its history are deleted'
          : 'kept indefinitely — nothing deletes it',
      },
      liveRecords: counts[0]!.count,
      fields: mapped,
      identity: bp.data.identity ?? [],
      byClassification,
      notes,
    });
  }

  return maps;
}

// ------------------------------------------------------------------ erasure

export interface SubjectAppearance {
  instanceId: string;
  reference: string;
  processKey: string;
  processName: string;
  state: string;
  completed: boolean;
  /**
   * `subject` — the record is about this person, and erasure deletes it.
   * `mentioned` — they appear in somebody else's record, and erasure redacts
   * only the fields that name them.
   */
  role: 'subject' | 'mentioned';
  /** The field keys that carry this person's address. */
  via: string[];
  /** Why it cannot be erased yet, if it cannot. */
  blocked: string | null;
}

export interface ErasureResult {
  email: string;
  preview: boolean;
  deleted: { instances: number; events: number };
  redacted: { instances: number; fields: number };
  blocked: SubjectAppearance[];
  appearances: SubjectAppearance[];
}

/**
 * Every record a person appears in, and how.
 *
 * The distinction is the whole problem. A new hire's record is *about* the new
 * hire; the hiring manager named on it is *mentioned*. Erasing the manager by
 * deleting every record their address appears in would delete other people's
 * records — and refusing to erase them at all because their address is in
 * somebody else's form would make the right meaningless.
 *
 * So: a record is about whoever supplied it, which the blueprint already
 * names through the respondent role's own email field. Everything else is a
 * mention, and a mention is redacted in place rather than deleted.
 */
export async function findSubject(
  pool: Pool,
  args: { principal: Principal; email: string },
): Promise<SubjectAppearance[]> {
  await requireWorkspaceCapability(pool, args.principal, 'administer', 'erasure');
  if (args.principal.kind !== 'actor') throw new Error('unreachable');
  const tenantId = args.principal.tenantId;
  const email = args.email.trim().toLowerCase();

  const { rows } = await pool.query<{
    id: string;
    process_key: string;
    state: string;
    data: Record<string, unknown>;
    completed_at: Date | null;
    blueprint: Blueprint;
  }>(
    `select i.id, i.process_key, i.state, i.data, i.completed_at, pv.blueprint
       from instance i join process_version pv on pv.id = i.process_version_id
      where i.tenant_id = $1
      order by i.created_at`,
    [tenantId],
  );

  const found: SubjectAppearance[] = [];
  for (const row of rows) {
    const bp = row.blueprint;
    const subjectFields = subjectFieldsOf(bp);
    const via: string[] = [];
    let isSubject = false;

    for (const [key, value] of Object.entries(row.data)) {
      if (typeof value !== 'string') continue;
      if (value.trim().toLowerCase() !== email) continue;
      via.push(key);
      if (subjectFields.has(key)) isSubject = true;
    }
    if (!via.length) continue;

    const state = bp.workflow.states.find((s) => s.key === row.state);
    found.push({
      instanceId: row.id,
      reference: row.id.slice(0, 8).toUpperCase(),
      processKey: row.process_key,
      processName: bp.name,
      state: state?.name ?? row.state,
      completed: Boolean(row.completed_at),
      role: isSubject ? 'subject' : 'mentioned',
      via,
      // A record still running is not erased. Deleting a live case removes
      // somebody else's work in progress and leaves approvals pointing at
      // nothing; §12.1's deletion job waits for completion, and so does this.
      blocked: isSubject && !row.completed_at ? 'the record is still running' : null,
    });
  }

  return found;
}

/**
 * The fields that make a record *about* somebody.
 *
 * The respondent role is the person the process collects from, and the email
 * fields they fill in are how they are identified. A field somebody else
 * supplies — a manager's address typed by the new hire — names a different
 * person, so it is a mention however it is classified.
 */
function subjectFieldsOf(bp: Blueprint): Set<string> {
  const declared = new Set(bp.data.identity ?? []);
  const out = new Set<string>();
  for (const f of flatten(bp.data.fields)) {
    if (f.type !== 'email') continue;
    if ((f.setBy ?? 'respondent') !== 'respondent') continue;
    // An identity field is the strongest signal; otherwise the first
    // respondent-supplied email is the submitter's own, which is the same
    // convention `resolveParty({submitter:true})` already uses.
    if (declared.has(f.key) || out.size === 0) out.add(f.key);
  }
  return out;
}

/**
 * Carries out a privacy request.
 *
 * `preview: true` runs the whole thing and rolls back, which is the only
 * honest way to answer "what would this remove?" — the same shape as
 * retention, for the same reason.
 *
 * What it does not reach is stated rather than implied: backups. The recovery
 * drill proves those exist and restore faithfully, which means an erased
 * person is still in every backup taken before the request. §12.1 calls that
 * "backup expiry" and it is a retention schedule, not a delete — the honest
 * statement to a data subject is that live data is erased now and backup
 * copies age out, not that every trace is gone.
 */
export async function eraseSubject(
  pool: Pool,
  args: { principal: Principal; email: string; preview?: boolean; reason: string },
): Promise<ErasureResult> {
  const preview = args.preview ?? true;
  const appearances = await findSubject(pool, { principal: args.principal, email: args.email });
  if (args.principal.kind !== 'actor') throw new Error('unreachable');
  const tenantId = args.principal.tenantId;

  const blocked = appearances.filter((a) => a.blocked);
  const toDelete = appearances.filter((a) => a.role === 'subject' && !a.blocked);
  const toRedact = appearances.filter((a) => a.role === 'mentioned');

  const result: ErasureResult = {
    email: args.email,
    preview,
    deleted: { instances: 0, events: 0 },
    redacted: { instances: 0, fields: 0 },
    blocked,
    appearances,
  };

  if (!toDelete.length && !toRedact.length) return result;

  const run = async (client: Client): Promise<void> => {
    const ids = toDelete.map((a) => a.instanceId);

    /*
     * Count before writing the account, not after.
     *
     * The first version wrote the audit row first — right, since the record of
     * what was removed must outlive the data — and passed 0 for the event
     * count, because the deletion that produces the number had not run yet. So
     * the audit row said "1 record, 0 events" while the operator was told 2
     * events. An account with the wrong number in it is worse than none: it
     * looks authoritative.
     */
    const { rows: eventCount } = await client.query<{ count: number }>(
      'select count(*)::int as count from event where instance_id = any($1::uuid[])',
      [ids],
    );
    result.deleted.events = eventCount[0]!.count;

    await client.query(
      `insert into erasure_run (tenant_id, subject_email, reason, instances_deleted, events_deleted,
                                instances_redacted, fields_redacted, blocked, run_by, ran_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        tenantId,
        args.email,
        args.reason,
        toDelete.length,
        result.deleted.events,
        toRedact.length,
        toRedact.reduce((n, a) => n + a.via.length, 0),
        JSON.stringify(blocked.map((b) => ({ reference: b.reference, reason: b.blocked }))),
        `actor:${args.principal.kind === 'actor' ? args.principal.actorId : 'system'}`,
      ],
    );

    await client.query("set local patform.retention_run = 'on'");

    if (ids.length) {
      for (const table of ['email_log', 'webhook_delivery', 'document', 'task', 'approval_request', 'timer', 'outbox']) {
        await client.query(`delete from ${table} where instance_id = any($1::uuid[])`, [ids]);
      }
      await client.query('delete from action_run where instance_id = any($1::uuid[])', [ids]);
      await client.query('delete from event where instance_id = any($1::uuid[])', [ids]);
      await client.query('delete from resume_token where instance_id = any($1::uuid[])', [ids]);
      const { rowCount } = await client.query('delete from instance where id = any($1::uuid[])', [ids]);
      result.deleted.instances = rowCount ?? 0;
    }

    /*
     * A mention is redacted, not deleted.
     *
     * The value is replaced rather than removed so the record still shows that
     * a manager was named and approved — the audit stays coherent — while the
     * address that identified them is gone. Removing the key entirely would
     * make the record look as though nobody was ever asked.
     */
    for (const appearance of toRedact) {
      for (const key of appearance.via) {
        await client.query(
          `update instance set data = jsonb_set(data, $2::text[], '"[erased]"'::jsonb)
            where id = $1 and data ? $3`,
          [appearance.instanceId, `{${key}}`, key],
        );
        result.redacted.fields++;
      }
      result.redacted.instances++;
    }

    // The delivery log holds the address in its own column, outside the
    // record's data. An erasure that left it there would have missed the
    // copy most likely to be read.
    await client.query(
      `update email_log set recipients = array_replace(recipients, $2, '[erased]')
        where tenant_id = $1 and $2 = any(recipients)`,
      [tenantId, args.email],
    );
  };

  if (preview) {
    // Run it and roll back, so the numbers are measured rather than estimated.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await run(client);
      await client.query('rollback');
    } finally {
      client.release();
    }
  } else {
    await inTransaction(pool, run);
  }

  return result;
}
