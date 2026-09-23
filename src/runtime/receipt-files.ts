import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, GetObjectTaggingCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { inTransaction, type Client, type Pool } from './db.js';
import { resolveForm } from './form-links.js';
import { InvalidInput, NotFound } from './errors.js';
import type { Blueprint } from '../blueprint/index.js';
import type { Principal } from './policy.js';
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

function evidenceField(bp: Blueprint, key: string) {
  return EVIDENCE_FIELDS.has(key) && bp.data.fields.some((f) => f.key === key && f.setBy !== 'operator');
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
  const { rows } = await pool.query<{ storage_key: string; scan_status: string; filename: string }>(
    `select f.storage_key, f.scan_status, f.filename from file f
      join draft d on d.id = f.draft_id join process_version pv on pv.id = d.process_version_id
     where f.id = $1 and f.tenant_id = $2 and d.token_hash = $3 and pv.process_key = $4 and d.expires_at > now()`,
    [id, form.tenantId, tokenHash(args.token), form.processKey],
  );
  if (!rows[0]) throw new NotFound('No receipt belongs to this draft.');
  const status = await scanStatus(rows[0].storage_key);
  if (status !== rows[0].scan_status) await pool.query('update file set scan_status = $2 where id = $1', [id, status === 'scanning' ? 'unscanned' : status]);
  return { status, filename: rows[0].filename };
}

/** A caller may type any reference, but a receipt-file reference must be a clean object on this exact draft. */
export async function checkReceiptReferences(pool: Pool, args: { tenantId: string; processKey: string; token?: string; answers: Record<string, unknown> }) {
  for (const fieldKey of EVIDENCE_FIELDS) {
    const value = args.answers[fieldKey];
    if (typeof value !== 'string' || !value.startsWith('receipt-file:')) continue;
    const id = REFERENCE.exec(value)?.[1];
    if (!id || !args.token) return { field: fieldKey, message: 'Upload the receipt again.' };
    const { rows } = await pool.query<{ storage_key: string }>(
      `select f.storage_key from file f join draft d on d.id = f.draft_id
         join process_version pv on pv.id = d.process_version_id
        where f.id = $1 and f.field_key = $2 and f.tenant_id = $3
          and d.token_hash = $4 and pv.process_key = $5 and d.expires_at > now()`,
      [id, fieldKey, args.tenantId, tokenHash(args.token), args.processKey],
    );
    if (!rows[0]) return { field: fieldKey, message: 'Upload the receipt again.' };
    const status = await scanStatus(rows[0].storage_key);
    if (status !== 'clean') return { field: fieldKey, message: status === 'scanning' ? 'The receipt is still being scanned. Try again shortly.' : 'The receipt could not pass its security scan. Upload a different file.' };
    await pool.query('update file set scan_status = $2 where id = $1', [id, 'clean']);
  }
  return null;
}

export async function receiptDownload(pool: Pool, principal: Principal, instanceId: string, fileId: string) {
  if (principal.kind === 'system') throw new NotFound('No receipt is visible on this record.');
  // recordDetail applies the process view policy and redacts fields for this actor.
  const detail = await recordDetail(pool, principal, instanceId);
  const field = detail.fields.find((f) => typeof f.value === 'string' && f.value === `receipt-file:${fileId}`);
  if (!field) throw new NotFound('No receipt is visible on this record.');
  const { rows } = await pool.query<{ storage_key: string; filename: string; scan_status: string }>(
    'select storage_key, filename, scan_status from file where id = $1 and instance_id = $2 and tenant_id = $3 and field_key = $4',
    [fileId, instanceId, principal.tenantId, field.key],
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
