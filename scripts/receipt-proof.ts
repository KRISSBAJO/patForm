/** Optional live integration proof: PROOF_DATABASE_URL and AWS env vars required. */
import { Blueprint } from '../src/blueprint/index.js';
import { CATALOGUE } from '../src/packs/catalogue.js';
import { buildBlueprint } from '../src/packs/generate.js';
import { createPool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { suppressDelivery } from '../src/runtime/email.js';
import { saveDraft } from '../src/runtime/intake.js';
import { checkReceiptReferences, drainReceiptDeletions, receiptStatus, uploadReceipt } from '../src/runtime/receipt-files.js';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

if (!process.env.PROOF_DATABASE_URL) throw new Error('PROOF_DATABASE_URL is required');
suppressDelivery('receipt proof sends no email');
const pool = createPool(4, process.env.PROOF_DATABASE_URL);
let uploadedReference: string | null = null;
let passed = false;
try {
  const spec = CATALOGUE.find((item) => item.key === 'expense_claim')!;
  const bp = Blueprint.parse(buildBlueprint(spec));
  const engine = new Engine(pool);
  const tenantId = await engine.createTenant('Receipt proof');
  await engine.publish(tenantId, bp, 'receipt-proof');
  const { rows } = await pool.query<{ public_id: string }>('select public_id from public_form where tenant_id = $1 and process_key = $2', [tenantId, bp.key]);
  const form = rows[0]!.public_id;
  const draft = await saveDraft(pool, { processKey: form, answers: {}, page: 0 });
  const uploaded = await uploadReceipt(pool, {
    form, token: draft.token, fieldKey: 'receipt_reference', filename: 'proof.pdf',
    base64: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF').toString('base64'),
  });
  uploadedReference = uploaded.reference;
  const forged = await checkReceiptReferences(pool, { tenantId, processKey: bp.key, token: 'forged', answers: { receipt_reference: uploaded.reference } });
  if (!forged) throw new Error('a forged draft token was accepted');
  let state = 'scanning';
  for (let attempt = 0; attempt < 20 && state === 'scanning'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    state = (await receiptStatus(pool, { form, token: draft.token, reference: uploaded.reference })).status;
  }
  if (state !== 'clean') throw new Error(`GuardDuty scan did not clear the proof document: ${state}`);
  const accepted = await checkReceiptReferences(pool, { tenantId, processKey: bp.key, token: draft.token, answers: { receipt_reference: uploaded.reference } });
  if (accepted) throw new Error(accepted.message);
  const { rows: stored } = await pool.query<{ storage_key: string }>('select storage_key from file where id = $1', [uploaded.reference.slice('receipt-file:'.length)]);
  const signed = await getSignedUrl(new S3Client({ region: process.env.AWS_REGION }), new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: stored[0]!.storage_key }), { expiresIn: 60 });
  const downloaded = await fetch(signed);
  if (!downloaded.ok || !(await downloaded.text()).startsWith('%PDF-')) throw new Error('signed receipt download failed');
  passed = true;
} finally {
  if (uploadedReference) {
    const id = uploadedReference.slice('receipt-file:'.length);
    await pool.query('insert into file_deletion (storage_key) select storage_key from file where id = $1 on conflict do nothing', [id]);
    await pool.query('delete from file where id = $1', [id]);
    await drainReceiptDeletions(pool);
  }
  await pool.end();
  if (passed) console.log('Receipt upload, scan, draft ownership and S3 cleanup passed.');
}
