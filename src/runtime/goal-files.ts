/** Private goal evidence in the workspace S3 bucket. Files are released only after malware scanning. */
import { createHash, randomUUID } from 'node:crypto';
import { GetObjectCommand, GetObjectTaggingCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Pool } from './db.js';
import { InvalidInput } from './errors.js';
import type { Principal } from './policy.js';
import { goalDetail } from './appraisals.js';

const MAX_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f-]{36}$/;
function store() {
  const bucket = process.env.AWS_S3_BUCKET; const region = process.env.AWS_REGION;
  if (!bucket || !region) throw new InvalidInput('Evidence storage is not configured for this deployment.');
  return { bucket, s3: new S3Client({ region }) };
}
function sniff(bytes: Buffer) {
  if (bytes.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export async function uploadGoalFile(pool: Pool, principal: Principal, goalId: string, body: Record<string, unknown>) {
  if (principal.kind !== 'actor') throw new InvalidInput('sign in to upload evidence');
  const detail = await goalDetail(pool, principal, goalId);
  if (!['draft', 'submitted', 'approved', 'completion_requested'].includes(String(detail.goal.status))) throw new InvalidInput('this goal is closed');
  const stepId = typeof body.stepId === 'string' && UUID.test(body.stepId) ? body.stepId : null;
  const step = stepId ? detail.steps.find((item) => item.id === stepId) : null;
  if (stepId && !step) throw new InvalidInput('choose a step in this goal');
  if (!detail.viewer.own && !detail.viewer.manager && (!step || step.assignee_id !== principal.actorId)) throw new InvalidInput('only the assigned person can attach evidence to this step');
  const filename = typeof body.filename === 'string' ? body.filename.trim().slice(0, 180) : '';
  const base64 = typeof body.base64 === 'string' ? body.base64 : '';
  if (!filename || !base64 || base64.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) throw new InvalidInput('Choose a PDF, JPEG, PNG or WebP file up to 10 MB.');
  const bytes = Buffer.from(base64, 'base64');
  const contentType = sniff(bytes);
  if (!contentType || !bytes.length || bytes.length > MAX_BYTES) throw new InvalidInput('Choose a PDF, JPEG, PNG or WebP file up to 10 MB.');
  const id = randomUUID(); const key = `goals/evidence/${principal.tenantId}/${goalId}/${id}`;
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const { bucket, s3 } = store();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType, Metadata: { sha256: checksum } }));
  await pool.query(`insert into goal_file (id, tenant_id, goal_id, step_id, filename, content_type, byte_size, sha256, storage_key, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, principal.tenantId, goalId, stepId, filename, contentType, bytes.length, checksum, key, principal.actorId]);
  await pool.query(`insert into goal_event (tenant_id, goal_id, actor_id, kind, detail) values ($1,$2,$3,'file_uploaded',$4)`,
    [principal.tenantId, goalId, principal.actorId, JSON.stringify({ stepId, fileId: id, filename })]);
  return { id, filename, status: 'scanning' };
}

export async function goalFileLink(pool: Pool, principal: Principal, goalId: string, fileId: string) {
  if (principal.kind !== 'actor') throw new InvalidInput('sign in to view evidence');
  await goalDetail(pool, principal, goalId);
  const { rows } = await pool.query<{ storage_key: string; content_type: string; filename: string }>(
    `select storage_key, content_type, filename from goal_file where id = $1 and goal_id = $2 and tenant_id = $3`, [fileId, goalId, principal.tenantId]);
  const file = rows[0];
  if (!file) throw new InvalidInput('no such evidence file');
  const { bucket, s3 } = store();
  const tags = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: file.storage_key }));
  const scan = tags.TagSet?.find((tag) => tag.Key === 'GuardDutyMalwareScanStatus')?.Value;
  if (scan !== 'NO_THREATS_FOUND') return { status: scan ? 'quarantined' : 'scanning', url: null };
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: file.storage_key, ResponseContentType: file.content_type, ResponseContentDisposition: 'inline' }), { expiresIn: 300 });
  return { status: 'ready', url, filename: file.filename };
}
