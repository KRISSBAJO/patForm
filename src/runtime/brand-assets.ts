import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Pool } from './db.js';
import type { Principal } from './policy.js';
import { loadDraft } from './builder.js';
import { InvalidInput, NotFound } from './errors.js';

const MAX_BYTES = 3 * 1024 * 1024;
const bucket = process.env.AWS_S3_BUCKET;
const region = process.env.AWS_REGION;
const storage = bucket && region ? new S3Client({ region }) : null;

function client() {
  if (!storage || !bucket) throw new InvalidInput('Image storage is not configured.');
  return { storage, bucket };
}

function imageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export async function uploadBrandAsset(pool: Pool, principal: Principal, args: { draftId: string; kind: string; base64: string }) {
  if (args.kind !== 'logo' && args.kind !== 'banner') throw new InvalidInput('Choose a logo or banner.');
  if (!args.base64 || args.base64.length > Math.ceil(MAX_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(args.base64)) {
    throw new InvalidInput('Choose a PNG, JPEG or WebP image up to 3 MB.');
  }
  const bytes = Buffer.from(args.base64, 'base64');
  const contentType = imageType(bytes);
  if (!contentType || bytes.length === 0 || bytes.length > MAX_BYTES) throw new InvalidInput('Choose a PNG, JPEG or WebP image up to 3 MB.');
  const draft = await loadDraft(pool, principal, args.draftId);
  if (!draft || principal.kind !== 'actor') throw new NotFound('Draft not found.');
  const active = await pool.query('select 1 from process_draft where id = $1 and tenant_id = $2 and published_as is null', [args.draftId, principal.tenantId]);
  if (!active.rowCount) throw new InvalidInput('Open a new draft before changing its images.');
  const { storage: s3, bucket: name } = client();
  const id = randomUUID();
  const key = `brand-assets/${principal.tenantId}/${id}`;
  await s3.send(new PutObjectCommand({ Bucket: name, Key: key, Body: bytes, ContentType: contentType, CacheControl: 'public, max-age=3600' }));
  try {
    await pool.query('insert into brand_asset (id, tenant_id, draft_id, kind, storage_key, content_type, byte_size) values ($1,$2,$3,$4,$5,$6,$7)',
      [id, principal.tenantId, args.draftId, args.kind, key, contentType, bytes.length]);
  } catch (error) {
    await s3.send(new DeleteObjectCommand({ Bucket: name, Key: key })).catch(() => {});
    throw error;
  }
  return { url: `/api/brand-assets/${id}` };
}

export async function brandAssetUrl(pool: Pool, id: string): Promise<string> {
  const { rows } = await pool.query<{ storage_key: string }>('select storage_key from brand_asset where id = $1', [id]);
  if (!rows[0]) throw new NotFound('Image not found.');
  const { storage: s3, bucket: name } = client();
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: name, Key: rows[0].storage_key }), { expiresIn: 60 });
}
