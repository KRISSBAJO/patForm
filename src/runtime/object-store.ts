/**
 * The workspace file store: the S3 bucket receipts and photos already use.
 *
 * One small interface so contracts, signed copies and workspace exports all
 * go through the same rules — put, read back, check the bucket's malware
 * scan, hand out a short-lived link, delete — and so tests can swap in an
 * in-memory store.
 */
import { DeleteObjectCommand, GetObjectCommand, GetObjectTaggingCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { InvalidInput } from './errors.js';

export interface ObjectStore {
  put(key: string, bytes: Buffer, contentType: string, meta?: Record<string, string>): Promise<void>;
  get(key: string): Promise<Buffer>;
  scan(key: string): Promise<'clean' | 'quarantined' | 'scanning'>;
  link(key: string, opts: { contentType?: string; filename?: string; seconds?: number }): Promise<string>;
  remove(key: string): Promise<void>;
}

function s3(): ObjectStore | null {
  const bucket = process.env.AWS_S3_BUCKET; const region = process.env.AWS_REGION;
  if (!bucket || !region) return null;
  const client = new S3Client({ region });
  return {
    async put(key, bytes, contentType, meta) { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType, Metadata: meta })); },
    async get(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await out.Body!.transformToByteArray());
    },
    async scan(key) {
      const tags = await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
      const status = tags.TagSet?.find((t) => t.Key === 'GuardDutyMalwareScanStatus')?.Value;
      if (status === 'NO_THREATS_FOUND') return 'clean';
      return status ? 'quarantined' : 'scanning';
    },
    async link(key, opts) {
      const disposition = opts.filename ? `attachment; filename="${opts.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"` : 'inline';
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentType: opts.contentType, ResponseContentDisposition: disposition }), { expiresIn: opts.seconds ?? 300 });
    },
    async remove(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}

let current: ObjectStore | null | undefined;
/** OBJECT_STORE=memory keeps files in this process only, for local trials; never in production. */
function fromEnv(): ObjectStore | null {
  if (process.env.OBJECT_STORE === 'memory') {
    if (process.env.NODE_ENV === 'production') throw new Error('OBJECT_STORE=memory is for local trials only');
    return memoryObjectStore().store;
  }
  return s3();
}
export function objectStore(): ObjectStore {
  if (current === undefined) current = fromEnv();
  if (!current) throw new InvalidInput('File storage is not set up for this deployment (AWS_S3_BUCKET and AWS_REGION).');
  return current;
}
export function hasObjectStore(): boolean { if (current === undefined) current = fromEnv(); return Boolean(current); }
/** Tests swap in an in-memory store. */
export function setObjectStoreForTests(s: ObjectStore | null | undefined) { current = s; }

/** An in-memory store for tests: objects in a map, scan results chosen by the test. */
export function memoryObjectStore() {
  const objects = new Map<string, { bytes: Buffer; type: string }>();
  const scans = new Map<string, 'clean' | 'quarantined' | 'scanning'>();
  const store: ObjectStore = {
    async put(key, bytes, type) { objects.set(key, { bytes, type }); },
    async get(key) { const o = objects.get(key); if (!o) throw new Error(`no object ${key}`); return o.bytes; },
    async scan(key) { return scans.get(key) ?? 'clean'; },
    async link(key) { return `https://bucket.test/${key}?signed=1`; },
    async remove(key) { objects.delete(key); },
  };
  return { store, objects, scans };
}
