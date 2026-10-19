/**
 * Photos for Assets and IT (PRD OPS-07, OPS-09): maintenance findings,
 * hand-outs, returns and tickets.
 *
 * The same rules as receipts: the bytes decide the type, not the name; the
 * object goes to the workspace's S3 bucket under ops/photos/; and a photo is
 * shown only through a short-lived link once the bucket's malware scan has
 * passed it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { GetObjectCommand, GetObjectTaggingCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Pool } from './db.js';
import { InvalidInput, NotFound } from './errors.js';
import type { Principal } from './policy.js';
import { opsInTeam, opsWho } from './ops.js';

const PREFIX = 'ops/photos/';
const MAX_BYTES = 5 * 1024 * 1024;
const UUID = /^[0-9a-f-]{36}$/;

export interface PhotoStore {
  put(key: string, bytes: Buffer, contentType: string, checksum: string): Promise<void>;
  scan(key: string): Promise<'clean' | 'quarantined' | 'scanning'>;
  link(key: string, contentType: string): Promise<string>;
}

function s3Store(): PhotoStore | null {
  const bucket = process.env.AWS_S3_BUCKET; const region = process.env.AWS_REGION;
  if (!bucket || !region) return null;
  const s3 = new S3Client({ region });
  return {
    async put(key, bytes, contentType, checksum) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType, Metadata: { sha256: checksum } }));
    },
    async scan(key) {
      const tags = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
      const status = tags.TagSet?.find((t) => t.Key === 'GuardDutyMalwareScanStatus')?.Value;
      if (status === 'NO_THREATS_FOUND') return 'clean';
      return status ? 'quarantined' : 'scanning';
    },
    async link(key, contentType) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentType: contentType, ResponseContentDisposition: 'inline' }), { expiresIn: 300 });
    },
  };
}

let store: PhotoStore | null | undefined;
function photoStore(): PhotoStore {
  if (store === undefined) store = s3Store();
  if (!store) throw new InvalidInput('Photo storage is not set up for this deployment.');
  return store;
}
/** Tests swap in an in-memory store; production uses S3. */
export function setPhotoStoreForTests(s: PhotoStore | null) { store = s; }

function sniff(bytes: Buffer): string | null {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

type Target = { column: 'job_id' | 'assignment_id' | 'ticket_id' | 'asset_id'; id: string; assetId: string | null };

/** Who may attach a photo to what: the team doing the job, IT or Facilities for assets, the requester or team for a ticket. */
async function resolveTarget(pool: Pool, principal: Principal, body: Record<string, unknown>): Promise<{ tenantId: string; actorId: string; target: Target }> {
  const w = await opsWho(pool, principal);
  const pick = (k: string) => (typeof body[k] === 'string' && UUID.test(body[k] as string) ? (body[k] as string) : null);
  const jobId = pick('jobId'); const ticketId = pick('ticketId'); const assignmentId = pick('assignmentId'); const assetId = pick('assetId');
  if (jobId) {
    const { rows } = await pool.query<{ team: string; asset_id: string; status: string }>(
      `select p.team, j.asset_id, j.status from maintenance_job j join maintenance_plan p on p.id = j.plan_id where j.id = $1 and j.tenant_id = $2`, [jobId, w.tenantId]);
    if (!rows[0]) throw new InvalidInput('no such job');
    if (!opsInTeam(w, rows[0].team)) throw new InvalidInput(`this is a job for the ${rows[0].team.toUpperCase()} team`);
    if (rows[0].status !== 'open') throw new InvalidInput('this job is already done');
    return { tenantId: w.tenantId, actorId: w.actorId, target: { column: 'job_id', id: jobId, assetId: rows[0].asset_id } };
  }
  if (ticketId) {
    const { rows } = await pool.query<{ team: string; requester_id: string; asset_id: string | null }>('select team, requester_id, asset_id from ticket where id = $1 and tenant_id = $2', [ticketId, w.tenantId]);
    if (!rows[0] || !(rows[0].requester_id === w.actorId || opsInTeam(w, rows[0].team))) throw new InvalidInput('no such ticket');
    return { tenantId: w.tenantId, actorId: w.actorId, target: { column: 'ticket_id', id: ticketId, assetId: rows[0].asset_id } };
  }
  if (!w.staff) throw new InvalidInput('only the IT or Facilities team can do this');
  if (assignmentId) {
    const { rows } = await pool.query<{ asset_id: string }>(`select s.asset_id from asset_assignment s join asset a on a.id = s.asset_id where s.id = $1 and a.tenant_id = $2`, [assignmentId, w.tenantId]);
    if (!rows[0]) throw new InvalidInput('no such hand-out');
    return { tenantId: w.tenantId, actorId: w.actorId, target: { column: 'assignment_id', id: assignmentId, assetId: rows[0].asset_id } };
  }
  if (assetId) {
    const { rows } = await pool.query('select 1 from asset where id = $1 and tenant_id = $2', [assetId, w.tenantId]);
    if (!rows[0]) throw new InvalidInput('no such asset');
    return { tenantId: w.tenantId, actorId: w.actorId, target: { column: 'asset_id', id: assetId, assetId } };
  }
  throw new InvalidInput('say what the photo is for');
}

export async function uploadOpsPhoto(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const filename = typeof body.filename === 'string' ? body.filename.trim().slice(0, 200) : '';
  const base64 = typeof body.base64 === 'string' ? body.base64 : '';
  if (!filename || !base64 || base64.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) throw new InvalidInput('Choose a JPEG, PNG or WebP photo up to 5 MB.');
  const bytes = Buffer.from(base64, 'base64');
  const contentType = sniff(bytes);
  if (!contentType || !bytes.length || bytes.length > MAX_BYTES) throw new InvalidInput('Choose a JPEG, PNG or WebP photo up to 5 MB.');
  const { tenantId, actorId, target } = await resolveTarget(pool, principal, body);
  const s = photoStore();
  const id = randomUUID();
  const key = `${PREFIX}${tenantId}/${id}`;
  const checksum = createHash('sha256').update(bytes).digest('hex');
  await s.put(key, bytes, contentType, checksum);
  const link = (c: Target['column']) => (target.column === c ? target.id : null);
  await pool.query(
    `insert into ops_photo (id, tenant_id, asset_id, job_id, assignment_id, ticket_id, filename, content_type, byte_size, checksum, storage_key, uploaded_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, tenantId, target.assetId, link('job_id'), link('assignment_id'), link('ticket_id'), filename, contentType, bytes.length, checksum, key, actorId]);
  return { id, reference: `ops-photo:${id}`, filename, status: 'scanning' as const };
}

/** A short-lived link, only once the scan has passed. */
export async function opsPhotoLink(pool: Pool, principal: Principal, photoId: string) {
  const w = await opsWho(pool, principal);
  if (!UUID.test(photoId)) throw new NotFound('No such photo.');
  const { rows } = await pool.query<{ storage_key: string; content_type: string; filename: string; scan_status: string; requester_id: string | null; team: string | null }>(
    `select p.storage_key, p.content_type, p.filename, p.scan_status, t.requester_id, t.team
       from ops_photo p left join ticket t on t.id = p.ticket_id where p.id = $1 and p.tenant_id = $2`, [photoId, w.tenantId]);
  const p = rows[0];
  if (!p || !(w.staff || (p.requester_id && p.requester_id === w.actorId))) throw new NotFound('No such photo.');
  const s = photoStore();
  const status = await s.scan(p.storage_key);
  const stored = status === 'scanning' ? 'unscanned' : status;
  if (stored !== p.scan_status) await pool.query('update ops_photo set scan_status = $2 where id = $1', [photoId, stored]);
  if (status === 'scanning') throw new InvalidInput('The photo is still being checked for malware. Try again in a minute.');
  if (status === 'quarantined') throw new InvalidInput('The photo did not pass its malware check and cannot be shown.');
  return { url: await s.link(p.storage_key, p.content_type), filename: p.filename };
}
