import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, GetObjectTaggingCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { inTransaction, type Client, type Pool } from './db.js';
import { resolveForm } from './form-links.js';
import { InvalidInput, NotFound } from './errors.js';
import { flattenFields, type Blueprint, type Field } from '../blueprint/index.js';
import { editableFields, require_, type Principal } from './policy.js';
import { recordDetail } from './console-queries.js';

const PREFIX = 'finance/receipts/';
const MAX_BYTES = 5 * 1024 * 1024;
const REFERENCE = /^receipt-file:([0-9a-f-]{36})$/;
const EVIDENCE_FIELDS = new Set(['receipt_reference', 'invoice_evidence_reference']);
const BUCKET = process.env.AWS_S3_BUCKET;
const REGION = process.env.AWS_REGION;
const storage = BUCKET && REGION ? new S3Client({ region: REGION }) : null;

function config() {
  if (!storage || !BUCKET) throw new InvalidInput('Receipt upload storage is not configured. Enter an existing document reference instead.');
  return { storage, bucket: BUCKET };
}

function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }

export function referencedFileIds(answers: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const id = REFERENCE.exec(value)?.[1];
      if (id) ids.add(id);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(answers);
  return [...ids];
}

function evidenceField(bp: Blueprint, key: string) {
  return flattenFields(bp.data.fields).some(({ field }) => field.key === key && field.setBy !== 'operator' &&
    (field.type === 'file' || EVIDENCE_FIELDS.has(key)));
}

function sniff(bytes: Buffer): string | null {
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  return null;
}

export async function uploadReceipt(pool: Pool, args: { form: string; token: string; fieldKey: string; filename: string; base64: string }) {
  const { storage: s3, bucket } = config();
  if (!args.token || !args.filename || !args.base64 || args.base64.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) throw new InvalidInput('Choose a PDF, PNG or JPEG up to 5 MB.');
  const bytes = Buffer.from(args.base64, 'base64');
  const contentType = sniff(bytes);
  if (!contentType || bytes.length === 0 || bytes.length > MAX_BYTES) throw new InvalidInput('Choose a PDF, PNG or JPEG up to 5 MB.');
  const form = await resolveForm(pool, args.form);
  const { rows } = await pool.query<{ draft_id: string; blueprint: Blueprint }>(
    `select d.id as draft_id, pv.blueprint from draft d
      join process_version pv on pv.id = d.process_version_id
     where d.token_hash = $1 and d.tenant_id = $2 and pv.process_key = $3
       and d.expires_at > now() and d.submitted_instance_id is null`,
    [tokenHash(args.token), form.tenantId, form.processKey],
  );
  const draft = rows[0];
  if (!draft || !evidenceField(draft.blueprint, args.fieldKey)) throw new InvalidInput('This draft cannot accept that receipt.');
  const declared = flattenFields(draft.blueprint.data.fields).find(({ field }) => field.key === args.fieldKey)?.field;
  if (declared?.type === 'file' && (
    (declared.constraints?.accept?.length && !declared.constraints.accept.includes(contentType)) ||
    bytes.length > (declared.constraints?.maxSizeMb ?? 5) * 1024 * 1024
  )) throw new InvalidInput('This file does not match the field’s allowed type or size.');
  const id = randomUUID();
  const key = `${PREFIX}${form.tenantId}/${id}`;
  const checksum = createHash('sha256').update(bytes).digest('hex');
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType, Metadata: { sha256: checksum } }));
  await pool.query(
    `insert into file (id, tenant_id, draft_id, field_key, filename, content_type, byte_size, checksum, storage_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, form.tenantId, draft.draft_id, args.fieldKey, args.filename.slice(0, 200), contentType, bytes.length, checksum, key],
  );
  return { reference: `receipt-file:${id}`, filename: args.filename.slice(0, 200), status: 'scanning' };
}

async function scanStatus(key: string): Promise<'clean' | 'quarantined' | 'scanning'> {
  const { storage: s3, bucket } = config();
  const tags = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
  const status = tags.TagSet?.find((tag) => tag.Key === 'GuardDutyMalwareScanStatus')?.Value;
  if (status === 'NO_THREATS_FOUND') return 'clean';
  if (status && status !== 'NO_THREATS_FOUND') return 'quarantined';
  return 'scanning';
}

export async function receiptStatus(pool: Pool, args: { form: string; token: string; reference: string }) {
  const id = REFERENCE.exec(args.reference)?.[1];
  if (!id) throw new InvalidInput('Invalid receipt reference.');
  const form = await resolveForm(pool, args.form);
  const { rows } = await pool.query<{ storage_key: string; scan_status: string; filename: string; content_type: string }>(
    `select f.storage_key, f.scan_status, f.filename, f.content_type from file f
      join draft d on d.id = f.draft_id join process_version pv on pv.id = d.process_version_id
     where f.id = $1 and f.tenant_id = $2 and d.token_hash = $3 and pv.process_key = $4 and d.expires_at > now()`,
    [id, form.tenantId, tokenHash(args.token), form.processKey],
  );
  if (!rows[0]) throw new NotFound('No receipt belongs to this draft.');
  const status = await scanStatus(rows[0].storage_key);
  if (status !== rows[0].scan_status) await pool.query('update file set scan_status = $2 where id = $1', [id, status === 'scanning' ? 'unscanned' : status]);
  const { storage: s3, bucket } = config();
  const previewUrl = status === 'clean' && rows[0].content_type.startsWith('image/')
    ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: rows[0].storage_key,
        ResponseContentType: rows[0].content_type, ResponseContentDisposition: 'inline' }), { expiresIn: 90 })
    : null;
  return { status, filename: rows[0].filename, previewUrl };
}

/** A task upload belongs to one record and one declared answer, never to a reusable public-form token. */
export async function uploadTaskFile(pool: Pool, args: { principal: Principal; instanceId: string; taskKey: string; fieldKey: string; filename: string; base64: string }) {
  const { storage: s3, bucket } = config();
  if (args.principal.kind !== 'actor' || !args.filename || !args.base64 || args.base64.length > Math.ceil(MAX_BYTES * 4 / 3) + 8)
    throw new InvalidInput('Choose a PDF, PNG or JPEG up to 5 MB.');
  const bytes = Buffer.from(args.base64, 'base64');
  const contentType = sniff(bytes);
  if (!contentType || !bytes.length || bytes.length > MAX_BYTES) throw new InvalidInput('Choose a PDF, PNG or JPEG up to 5 MB.');
  const client = await pool.connect();
  let tenantId: string;
  try {
    const { rows } = await client.query<{ tenant_id: string; process_key: string; process_version_id: string }>(
      'select tenant_id, process_key, process_version_id from instance where id = $1', [args.instanceId]);
    const instance = rows[0];
    if (!instance) throw new NotFound('No such record.');
    const version = await client.query<{ blueprint: Blueprint }>('select blueprint from process_version where id = $1', [instance.process_version_id]);
    const bp = version.rows[0]?.blueprint;
    if (!bp) throw new NotFound('No such process version.');
    const task = await client.query<{ assignee: string | null }>(
      "select assignee from task where instance_id = $1 and task_key = $2 and status = 'open' order by id limit 1", [args.instanceId, args.taskKey]);
    const declared = bp.workflow.tasks.find(t => t.key === args.taskKey);
    if (!task.rows[0] || !declared?.requiredFields.includes(args.fieldKey)) throw new InvalidInput('This task does not collect that file.');
    const operate = await require_(client, { principal: args.principal, action: 'operate', tenantId: instance.tenant_id,
      processKey: instance.process_key, blueprint: bp, instanceId: args.instanceId,
      task: { assignee: task.rows[0].assignee, completableBy: declared.completableBy ?? 'assignee' } }, pool);
    const edit = await require_(client, { principal: args.principal, action: 'edit', tenantId: instance.tenant_id,
      processKey: instance.process_key, blueprint: bp, instanceId: args.instanceId }, pool);
    const item = flattenFields(bp.data.fields).find(({ field }) => field.key === args.fieldKey);
    const groupKey = item?.path.includes('.') ? item.path.split('.')[0] : undefined;
    if (!item || item.field.type !== 'file' || item.field.setBy === 'system' || !editableFields(bp, edit.roles).has(args.fieldKey) ||
        !operate.roles.some(roleKey => { const role = bp.roles.find(r => r.key === roleKey);
          return role && !role.hiddenFields?.includes(args.fieldKey) && (!groupKey || !role.hiddenFields?.includes(groupKey)); }))
      throw new InvalidInput('You cannot upload this task evidence.');
    if ((item.field.constraints?.accept?.length && !item.field.constraints.accept.includes(contentType)) ||
        bytes.length > (item.field.constraints?.maxSizeMb ?? 5) * 1024 * 1024)
      throw new InvalidInput('This file does not match the field’s allowed type or size.');
    tenantId = instance.tenant_id;
  } finally { client.release(); }
  const id = randomUUID();
  const key = `${PREFIX}${tenantId}/${id}`;
  const checksum = createHash('sha256').update(bytes).digest('hex');
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType, Metadata: { sha256: checksum } }));
  await pool.query(`insert into file (id, tenant_id, instance_id, field_key, filename, content_type, byte_size, checksum, storage_key)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, tenantId, args.instanceId, args.fieldKey, args.filename.slice(0, 200), contentType, bytes.length, checksum, key]);
  return { reference: `receipt-file:${id}`, filename: args.filename.slice(0, 200), status: 'scanning' };
}

export async function taskFileStatus(pool: Pool, args: { principal: Principal; instanceId: string; taskKey: string; reference: string }) {
  const id = REFERENCE.exec(args.reference)?.[1];
  if (!id || args.principal.kind !== 'actor') throw new InvalidInput('Invalid file reference.');
  const { rows } = await pool.query<{ field_key: string; storage_key: string; filename: string }>(
    'select field_key, storage_key, filename from file where id = $1 and instance_id = $2 and tenant_id = $3',
    [id, args.instanceId, args.principal.tenantId]);
  if (!rows[0]) throw new NotFound('No file belongs to this record.');
  const client = await pool.connect();
  try {
    const instance = await client.query<{ process_key: string; process_version_id: string }>(
      'select process_key, process_version_id from instance where id = $1 and tenant_id = $2', [args.instanceId, args.principal.tenantId]);
    if (!instance.rows[0]) throw new NotFound('No such record.');
    const version = await client.query<{ blueprint: Blueprint }>('select blueprint from process_version where id = $1', [instance.rows[0].process_version_id]);
    const bp = version.rows[0]?.blueprint;
    const declared = bp?.workflow.tasks.find(t => t.key === args.taskKey);
    const task = await client.query<{ assignee: string | null }>(
      "select assignee from task where instance_id = $1 and task_key = $2 and status = 'open' order by id limit 1", [args.instanceId, args.taskKey]);
    if (!bp || !declared?.requiredFields.includes(rows[0].field_key) || !task.rows[0]) throw new NotFound('No file belongs to this task.');
    await require_(client, { principal: args.principal, action: 'operate', tenantId: args.principal.tenantId,
      processKey: instance.rows[0].process_key, blueprint: bp, instanceId: args.instanceId,
      task: { assignee: task.rows[0].assignee, completableBy: declared.completableBy ?? 'assignee' } }, pool);
  } finally { client.release(); }
  const status = await scanStatus(rows[0].storage_key);
  return { status, filename: rows[0].filename };
}

/** Called before a task can commit file references, including references hidden in repeating rows. */
export async function checkTaskFileReferences(client: Client, instanceId: string, bp: Blueprint, requiredFields: string[], answers: Record<string, unknown>) {
  for (const key of requiredFields) {
    const item = flattenFields(bp.data.fields).find(({ field }) => field.key === key);
    if (!item || item.field.type !== 'file') continue;
    const groupKey = item.path.includes('.') ? item.path.split('.')[0] : undefined;
    const value = groupKey && Array.isArray(answers[groupKey])
      ? (answers[groupKey] as Record<string, unknown>[]).flatMap(row => Array.isArray(row[key]) ? row[key] as unknown[] : [row[key]]) : answers[key];
    for (const ref of Array.isArray(value) ? value : [value]) {
      const id = typeof ref === 'string' ? REFERENCE.exec(ref)?.[1] : undefined;
      if (!id) throw new InvalidInput(`Upload ${item.field.label} before completing this task.`);
      const { rows } = await client.query<{ storage_key: string }>(
        'select storage_key from file where id = $1 and instance_id = $2 and field_key = $3', [id, instanceId, key]);
      if (!rows[0]) throw new InvalidInput(`Upload ${item.field.label} to this record.`);
      const status = await scanStatus(rows[0].storage_key);
      if (status !== 'clean') throw new InvalidInput(status === 'scanning' ? 'The file is still being scanned. Try again shortly.' : 'The file did not pass its security scan. Upload another.');
      await client.query("update file set scan_status = 'clean' where id = $1", [id]);
    }
  }
}

/** File answers must be clean objects on this exact draft; legacy reference fields may still hold external IDs. */
export async function checkReceiptReferences(pool: Pool, args: { tenantId: string; processKey: string; token?: string; answers: Record<string, unknown> }) {
  const { rows: versions } = await pool.query<{ blueprint: Blueprint }>(
    `select blueprint from process_version where tenant_id = $1 and process_key = $2 order by version desc limit 1`,
    [args.tenantId, args.processKey],
  );
  const bp = versions[0]?.blueprint;
  if (!bp) return { field: '_', message: 'This form is no longer available.' };
  const references: { fieldKey: string; path: string; value: unknown; file: boolean }[] = [];
  const collect = (field: Field, value: unknown, path: string) => {
    if (field.type === 'repeating_group' && Array.isArray(value)) {
      value.forEach((row, index) => {
        if (row && typeof row === 'object' && !Array.isArray(row))
          for (const child of field.fields ?? []) collect(child, (row as Record<string, unknown>)[child.key], `${path}[${index}].${child.key}`);
      });
    } else if (field.type === 'file' || EVIDENCE_FIELDS.has(field.key)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) if (item !== null && item !== undefined && item !== '')
        references.push({ fieldKey: field.key, path, value: item, file: field.type === 'file' });
    }
  };
  for (const field of bp.data.fields) collect(field, args.answers[field.key], field.key);
  for (const { fieldKey, path, value, file } of references) {
    if (typeof value !== 'string' || !REFERENCE.test(value)) {
      if (file) return { field: path, message: 'Upload the actual file before submitting.' };
      continue;
    }
    const id = REFERENCE.exec(value)?.[1];
    if (!id || !args.token) return { field: path, message: 'Upload the receipt again.' };
    const { rows } = await pool.query<{ storage_key: string }>(
      `select f.storage_key from file f join draft d on d.id = f.draft_id
         join process_version pv on pv.id = d.process_version_id
        where f.id = $1 and f.field_key = $2 and f.tenant_id = $3
          and d.token_hash = $4 and pv.process_key = $5 and d.expires_at > now()`,
      [id, fieldKey, args.tenantId, tokenHash(args.token), args.processKey],
    );
    if (!rows[0]) return { field: path, message: 'Upload the receipt again.' };
    const status = await scanStatus(rows[0].storage_key);
    if (status !== 'clean') return { field: path, message: status === 'scanning' ? 'The file is still being scanned. Try again shortly.' : 'The file could not pass its security scan. Upload a different file.' };
    await pool.query('update file set scan_status = $2 where id = $1', [id, 'clean']);
  }
  return null;
}

export async function receiptDownload(pool: Pool, principal: Principal, instanceId: string, fileId: string) {
  if (principal.kind === 'system') throw new NotFound('No receipt is visible on this record.');
  // recordDetail applies the process view policy and redacts fields for this actor.
  const detail = await recordDetail(pool, principal, instanceId);
  let fieldKey: string | null = null;
  const ref = `receipt-file:${fileId}`;
  for (const field of detail.fields) {
    if (field.value === ref) fieldKey = field.key;
    if (Array.isArray(field.value)) {
      if (field.value.includes(ref)) fieldKey = field.key;
      for (const row of field.value) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        for (const [key, value] of Object.entries(row)) {
          if (value === ref || (Array.isArray(value) && value.includes(ref))) fieldKey = key;
        }
      }
    }
  }
  // A correction can replace a file answer. Its earlier version remains
  // downloadable only when the same viewer may see that historical field.
  if (!fieldKey && detail.evidenceHistory.some((item) => item.id === fileId)) {
    const { rows: historic } = await pool.query<{ field_key: string }>(
      'select field_key from file where id = $1 and instance_id = $2 and tenant_id = $3',
      [fileId, instanceId, principal.tenantId],
    );
    fieldKey = historic[0]?.field_key ?? null;
  }
  if (!fieldKey) throw new NotFound('No receipt is visible on this record.');
  const { rows } = await pool.query<{ storage_key: string; filename: string; scan_status: string }>(
    'select storage_key, filename, scan_status from file where id = $1 and instance_id = $2 and tenant_id = $3 and field_key = $4',
    [fileId, instanceId, principal.tenantId, fieldKey],
  );
  if (!rows[0]) throw new NotFound('No receipt is attached to this record.');
  if ((await scanStatus(rows[0].storage_key)) !== 'clean') throw new InvalidInput('The receipt has not passed its security scan.');
  const { storage: s3, bucket } = config();
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: rows[0].storage_key, ResponseContentDisposition: `attachment; filename="${rows[0].filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"` }), { expiresIn: 60 });
  return { url };
}

/** Record removal and the object deletion request commit together. The worker retries S3 separately. */
export async function queueReceiptDeletions(client: Client, instanceIds: string[]) {
  if (!instanceIds.length) return;
  await client.query(
    `insert into file_deletion (storage_key)
       select storage_key from file where instance_id = any($1::uuid[])
       on conflict do nothing`, [instanceIds],
  );
  await client.query('delete from file where instance_id = any($1::uuid[])', [instanceIds]);
}

export async function cleanupExpiredReceipts(pool: Pool) {
  await inTransaction(pool, async (client) => {
    await client.query(
      `insert into file_deletion (storage_key)
         select f.storage_key from file f join draft d on d.id = f.draft_id
          where d.expires_at < now() and f.instance_id is null
            and not exists (select 1 from held_submission h where h.draft_token_hash = d.token_hash and h.resolved_at is null)
         on conflict do nothing`,
    );
    await client.query(
      `delete from file f using draft d
        where f.draft_id = d.id and d.expires_at < now() and f.instance_id is null
          and not exists (select 1 from held_submission h where h.draft_token_hash = d.token_hash and h.resolved_at is null)`,
    );
    await client.query(`delete from draft d where d.expires_at < now()
      and not exists (select 1 from held_submission h where h.draft_token_hash = d.token_hash and h.resolved_at is null)`);
  });
}

export async function drainReceiptDeletions(pool: Pool) {
  const { rows } = await pool.query<{ storage_key: string }>(
    'select storage_key from file_deletion order by queued_at limit 25',
  );
  if (!rows.length) return 0;
  const { storage: s3, bucket } = config();
  let deleted = 0;
  for (const row of rows) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: row.storage_key }));
    await pool.query('delete from file_deletion where storage_key = $1', [row.storage_key]);
    deleted++;
  }
  return deleted;
}
