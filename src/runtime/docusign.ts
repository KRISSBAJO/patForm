/**
 * DocuSign for contract signature (PRD GOV-03).
 *
 * The split is the usual one for a SaaS integration:
 *   - Patform's own DocuSign app is in the environment: DOCUSIGN_INTEGRATION_KEY,
 *     DOCUSIGN_PRIVATE_KEY (RSA, for the JWT grant), DOCUSIGN_AUTH_SERVER
 *     (account-d.docusign.com for the demo environment, account.docusign.com
 *     for production) and DOCUSIGN_REDIRECT_URI (where the consent page
 *     returns).
 *   - Each workspace names the DocuSign user Patform sends as (their user ID
 *     from Apps and Keys), after that user consents once. Their account and
 *     its API address are looked up, never typed.
 *
 * Patform never trusts a notification's body: a DocuSign Connect call only
 * prompts Patform to ask DocuSign for the envelope's real status. The signed
 * PDF is downloaded from DocuSign and kept with its SHA-256.
 */
import { createSign } from 'node:crypto';

type Fetch = typeof fetch;
export interface DocusignConfig { userId: string; accountId?: string }
export interface Signer { name: string; email: string }
export type RemoteStatus = 'sent' | 'delivered' | 'completed' | 'declined' | 'voided' | 'created' | 'signed';

export class DocusignRefused extends Error {}
export class DocusignTransient extends Error {}

export function docusignEnv() {
  return {
    key: process.env.DOCUSIGN_INTEGRATION_KEY ?? '',
    privateKey: (process.env.DOCUSIGN_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    auth: (process.env.DOCUSIGN_AUTH_SERVER ?? 'account-d.docusign.com').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    redirect: process.env.DOCUSIGN_REDIRECT_URI ?? '',
    connectUrl: process.env.DOCUSIGN_CONNECT_URL ?? '',
  };
}
export const docusignConfigured = () => { const e = docusignEnv(); return Boolean(e.key && e.privateKey); };
export function consentUrl(): string | null {
  const e = docusignEnv();
  if (!e.key || !e.redirect) return null;
  return `https://${e.auth}/oauth/auth?response_type=code&scope=${encodeURIComponent('signature impersonation')}&client_id=${encodeURIComponent(e.key)}&redirect_uri=${encodeURIComponent(e.redirect)}`;
}

const sessions = new Map<string, { token: string; until: number; base: string; accountId: string }>();
export function clearDocusignCacheForTests() { sessions.clear(); }
const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

async function json(res: Response) { const raw = await res.text().catch(() => ''); try { return raw ? JSON.parse(raw) : {}; } catch { return { message: raw.slice(0, 300) }; } }

/** Signs in as the workspace's DocuSign user and finds the account to use. */
async function session(cfg: DocusignConfig, doFetch: Fetch) {
  const env = docusignEnv();
  if (!env.key || !env.privateKey) throw new DocusignRefused('DocuSign is not set up on the server (DOCUSIGN_INTEGRATION_KEY and DOCUSIGN_PRIVATE_KEY)');
  const cacheKey = `${cfg.userId}:${cfg.accountId ?? ''}`;
  const hit = sessions.get(cacheKey);
  if (hit && hit.until > Date.now() + 60_000) return hit;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: env.key, sub: cfg.userId, aud: env.auth, iat: now, exp: now + 3600, scope: 'signature impersonation' }))}`;
  let sig: string;
  try { sig = createSign('RSA-SHA256').update(unsigned).sign(env.privateKey, 'base64url'); } catch { throw new DocusignRefused('DOCUSIGN_PRIVATE_KEY is not a valid private key'); }
  const res = await doFetch(`https://${env.auth}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }).toString(), signal: AbortSignal.timeout(10_000),
  });
  const body = await json(res);
  if (res.status === 429 || res.status >= 500) throw new DocusignTransient(`DocuSign sign-in: HTTP ${res.status}`);
  if (res.status !== 200 || typeof body.access_token !== 'string') {
    if (body.error === 'consent_required') throw new DocusignRefused('The DocuSign user has not consented yet: they must open the consent link in Setup once');
    throw new DocusignRefused(`DocuSign refused Patform's sign-in (${body.error ?? res.status})`);
  }
  const info = await doFetch(`https://${env.auth}/oauth/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` }, signal: AbortSignal.timeout(10_000) });
  const user = await json(info);
  const accounts = (user.accounts ?? []) as { account_id: string; base_uri: string; is_default: boolean }[];
  const account = cfg.accountId ? accounts.find((a) => a.account_id === cfg.accountId) : accounts.find((a) => a.is_default) ?? accounts[0];
  if (!account) throw new DocusignRefused(cfg.accountId ? `the DocuSign user has no account ${cfg.accountId}` : 'the DocuSign user has no account');
  const s = { token: body.access_token as string, until: Date.now() + Number(body.expires_in ?? 3600) * 1000, base: `${account.base_uri.replace(/\/$/, '')}/restapi/v2.1/accounts/${account.account_id}`, accountId: account.account_id };
  sessions.set(cacheKey, s);
  return s;
}

async function call(cfg: DocusignConfig, doFetch: Fetch, method: string, path: string, body?: unknown, raw = false) {
  const s = await session(cfg, doFetch);
  const res = await doFetch(`${s.base}${path}`, {
    method, headers: { authorization: `Bearer ${s.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429 || res.status >= 500) throw new DocusignTransient(`DocuSign ${method} ${path}: HTTP ${res.status}`);
  if (raw) {
    if (!res.ok) throw new DocusignRefused(`DocuSign ${method} ${path}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const out = await json(res);
  if (!res.ok) throw new DocusignRefused(`DocuSign: ${out.message ?? out.errorCode ?? res.status}`);
  return out;
}

/** Sends the document to the signers in order; returns DocuSign's envelope ID. */
export async function sendEnvelope(cfg: DocusignConfig, args: { subject: string; document: Buffer; filename: string; signers: Signer[] }, doFetch: Fetch = fetch): Promise<string> {
  const env = docusignEnv();
  const ext = (args.filename.split('.').pop() ?? 'pdf').toLowerCase();
  const body = {
    emailSubject: args.subject.slice(0, 100),
    documents: [{ documentBase64: args.document.toString('base64'), name: args.filename, fileExtension: ext, documentId: '1' }],
    recipients: { signers: args.signers.map((s, i) => ({ email: s.email, name: s.name, recipientId: String(i + 1), routingOrder: String(i + 1) })) },
    status: 'sent',
    ...(env.connectUrl ? { eventNotification: { url: env.connectUrl, requireAcknowledgment: 'true', includeHMAC: 'true', envelopeEvents: ['delivered', 'completed', 'declined', 'voided'].map((e) => ({ envelopeEventStatusCode: e })) } } : {}),
  };
  const out = await call(cfg, doFetch, 'POST', '/envelopes', body) as { envelopeId?: string };
  if (!out.envelopeId) throw new DocusignRefused('DocuSign did not return an envelope ID');
  return out.envelopeId;
}

export async function envelopeStatus(cfg: DocusignConfig, envelopeId: string, doFetch: Fetch = fetch): Promise<RemoteStatus> {
  const out = await call(cfg, doFetch, 'GET', `/envelopes/${encodeURIComponent(envelopeId)}`) as { status?: string };
  return (out.status ?? 'sent') as RemoteStatus;
}

export async function signedDocument(cfg: DocusignConfig, envelopeId: string, doFetch: Fetch = fetch): Promise<Buffer> {
  return call(cfg, doFetch, 'GET', `/envelopes/${encodeURIComponent(envelopeId)}/documents/combined`, undefined, true) as Promise<Buffer>;
}

export async function voidEnvelope(cfg: DocusignConfig, envelopeId: string, reason: string, doFetch: Fetch = fetch): Promise<void> {
  await call(cfg, doFetch, 'PUT', `/envelopes/${encodeURIComponent(envelopeId)}`, { status: 'voided', voidedReason: reason.slice(0, 200) });
}

/** "Test connection": signs in and reports the account it will send from. */
export async function testDocusign(cfg: DocusignConfig, doFetch: Fetch = fetch) {
  try { const s = await session(cfg, doFetch); return { ok: true, accountId: s.accountId }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}
