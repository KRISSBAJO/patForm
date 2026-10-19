/**
 * Ready-made connectors for Microsoft 365 and Google Workspace (PRD OPS-04,
 * OPS-05).
 *
 * Access is modelled as group membership: each role of a system maps to a
 * group in the customer's directory. Giving access adds the person to the
 * group; removing it takes them out. When the person is leaving (HR removed
 * their access, or they were deactivated) and the workspace asked for it,
 * the account is also suspended and signed out everywhere.
 *
 * Credentials are split the way SaaS connections usually are:
 *   - Patform's own app identity lives in the environment
 *     (MS365_CLIENT_ID / MS365_CLIENT_SECRET for a multi-tenant Entra app;
 *     GOOGLE_WORKSPACE_SA_EMAIL / GOOGLE_WORKSPACE_SA_PRIVATE_KEY for a
 *     service account with domain-wide delegation).
 *   - Each workspace says which directory: its Entra tenant ID after an
 *     admin consents, or its Google admin to act as after a super admin
 *     grants the delegation. One workspace can never reach another's
 *     directory, because the directory is chosen per system, by its admin.
 *
 * A driver answers "done" or "failed" for an answer that will not change
 * on retry (missing permission, unknown person, outside the domain), and
 * throws for anything worth retrying (rate limits, 5xx, network).
 */
import { createSign } from 'node:crypto';

export type ConnectorKind = 'webhook' | 'microsoft365' | 'google_workspace';
export interface DirectoryConfig {
  /** Microsoft: the customer's Entra tenant ID (a GUID or a verified domain). */
  tenantId?: string;
  /** Google: the admin account the service account acts as. */
  adminEmail?: string;
  /** Email domains this directory owns; anyone else is refused. */
  domains?: string[];
  /** Role → group: an Entra group object ID, or a Google group email. */
  roleGroups: Record<string, string>;
  /** Suspend the account and sign it out when the person is leaving. */
  suspendOnLeave?: boolean;
}
export type DriverResult = { status: 'done'; reference?: string } | { status: 'failed'; error: string };
export interface DriverJob { kind: 'provision' | 'revoke'; email: string; role: string; leaving?: boolean }

/** A failure worth retrying; anything else thrown is treated the same way. */
export class Transient extends Error {}

type Fetch = typeof fetch;
const tokens = new Map<string, { token: string; until: number }>();
export function clearTokenCacheForTests() { tokens.clear(); }

async function read(res: Response): Promise<{ status: number; body: Record<string, unknown> & { error?: unknown } }> {
  const raw = await res.text().catch(() => '');
  let body: Record<string, unknown> = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { message: raw.slice(0, 300) }; }
  return { status: res.status, body };
}
function retryable(status: number) { return status === 429 || status >= 500; }
function errorText(body: Record<string, unknown>): string {
  const e = body.error as { message?: string; code?: string } | string | undefined;
  if (typeof e === 'string') return `${e}${body.error_description ? `: ${String(body.error_description)}` : ''}`;
  return e?.message ?? (typeof body.message === 'string' ? body.message : 'no detail');
}
const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

export function connectorEnv() {
  return {
    ms: { clientId: process.env.MS365_CLIENT_ID ?? '', clientSecret: process.env.MS365_CLIENT_SECRET ?? '' },
    google: {
      email: process.env.GOOGLE_WORKSPACE_SA_EMAIL ?? '',
      clientId: process.env.GOOGLE_WORKSPACE_SA_CLIENT_ID ?? '',
      // Hosts store the key on one line with \n; turn those back into newlines.
      key: (process.env.GOOGLE_WORKSPACE_SA_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    },
  };
}

/** Checks what an admin typed in Setup; returns the problems, empty when fine. */
export function checkConfig(kind: ConnectorKind, cfg: DirectoryConfig, roles: string[]): string[] {
  const problems: string[] = [];
  if (kind === 'microsoft365' && !/^([0-9a-f-]{36}|[a-z0-9.-]+\.[a-z]{2,})$/i.test(cfg.tenantId ?? '')) problems.push('give the Microsoft tenant ID (a GUID) or its primary domain');
  if (kind === 'google_workspace' && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(cfg.adminEmail ?? '')) problems.push('give the Google admin email Patform acts as');
  if (kind === 'google_workspace' && !(cfg.domains ?? []).length) problems.push('give the Google Workspace domain');
  for (const r of roles) if (!cfg.roleGroups[r]) problems.push(`map the role "${r}" to a group`);
  for (const [r, g] of Object.entries(cfg.roleGroups)) {
    if (kind === 'microsoft365' && !/^[0-9a-f-]{36}$/i.test(g)) problems.push(`"${r}": a Microsoft group is its object ID (a GUID)`);
    if (kind === 'google_workspace' && !/^[^@\s]+@[^@\s]+$/.test(g)) problems.push(`"${r}": a Google group is its email address`);
  }
  return problems;
}

// ------------------------------------------------------------- Microsoft

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function msToken(cfg: DirectoryConfig, doFetch: Fetch): Promise<string> {
  const env = connectorEnv().ms;
  if (!env.clientId || !env.clientSecret) throw new ConfigMissing('MS365_CLIENT_ID and MS365_CLIENT_SECRET are not set on the server');
  const cacheKey = `ms:${cfg.tenantId}`;
  const hit = tokens.get(cacheKey);
  if (hit && hit.until > Date.now() + 60_000) return hit.token;
  const res = await doFetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId ?? '')}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const r = await read(res);
  if (retryable(r.status)) throw new Transient(`Microsoft sign-in: HTTP ${r.status}`);
  if (r.status !== 200 || typeof r.body.access_token !== 'string') throw new Refused(`Microsoft refused Patform's sign-in (${errorText(r.body)}). Has an admin of this tenant consented to the Patform app?`);
  tokens.set(cacheKey, { token: r.body.access_token, until: Date.now() + Number(r.body.expires_in ?? 3600) * 1000 });
  return r.body.access_token;
}

class Refused extends Error {}
class ConfigMissing extends Error {}

async function graph(doFetch: Fetch, token: string, method: string, path: string, body?: unknown) {
  const res = await doFetch(`${GRAPH}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
  });
  const r = await read(res);
  if (retryable(r.status)) throw new Transient(`Microsoft Graph ${method} ${path.split('?')[0]}: HTTP ${r.status}`);
  return r;
}

async function msUser(doFetch: Fetch, token: string, email: string): Promise<{ id: string } | null> {
  const direct = await graph(doFetch, token, 'GET', `/users/${encodeURIComponent(email)}?$select=id,accountEnabled`);
  if (direct.status === 200 && typeof direct.body.id === 'string') return { id: direct.body.id };
  if (direct.status === 403) throw new Refused('Microsoft refused reading users: grant the app User.Read.All');
  // The sign-in name may differ from the email; look it up by mail.
  const safe = email.replace(/'/g, "''");
  const found = await graph(doFetch, token, 'GET', `/users?$select=id&$filter=${encodeURIComponent(`mail eq '${safe}' or userPrincipalName eq '${safe}'`)}`);
  const list = (found.body.value as { id: string }[] | undefined) ?? [];
  return list.length === 1 ? { id: list[0]!.id } : null;
}

async function microsoft(job: DriverJob, cfg: DirectoryConfig, doFetch: Fetch): Promise<DriverResult> {
  const group = cfg.roleGroups[job.role];
  if (!group) return { status: 'failed', error: `the role "${job.role}" is not mapped to a Microsoft group` };
  if (cfg.domains?.length && !cfg.domains.includes(domainOf(job.email))) return { status: 'failed', error: `${job.email} is not in ${cfg.domains.join(', ')}` };
  const token = await msToken(cfg, doFetch);
  const user = await msUser(doFetch, token, job.email);
  if (!user) return job.kind === 'revoke' ? { status: 'done', reference: 'no such Microsoft account; nothing to remove' } : { status: 'failed', error: `no Microsoft account for ${job.email}` };
  if (job.kind === 'provision') {
    const r = await graph(doFetch, token, 'POST', `/groups/${group}/members/$ref`, { '@odata.id': `${GRAPH}/directoryObjects/${user.id}` });
    if (r.status === 204 || (r.status === 400 && /already exist/i.test(errorText(r.body)))) return { status: 'done', reference: `entra:${group}:${user.id}` };
    if (r.status === 403) return { status: 'failed', error: 'Microsoft refused: grant the app GroupMember.ReadWrite.All' };
    if (r.status === 404) return { status: 'failed', error: `Microsoft group ${group} not found` };
    return { status: 'failed', error: `Microsoft: ${errorText(r.body)}` };
  }
  const r = await graph(doFetch, token, 'DELETE', `/groups/${group}/members/${user.id}/$ref`);
  if (!(r.status === 204 || r.status === 404)) {
    if (r.status === 403) return { status: 'failed', error: 'Microsoft refused: grant the app GroupMember.ReadWrite.All' };
    return { status: 'failed', error: `Microsoft: ${errorText(r.body)}` };
  }
  if (job.leaving && cfg.suspendOnLeave) {
    const off = await graph(doFetch, token, 'PATCH', `/users/${user.id}`, { accountEnabled: false });
    if (off.status !== 204) return { status: 'failed', error: `removed from the group, but the account was not disabled: ${off.status === 403 ? 'grant the app User.ReadWrite.All' : errorText(off.body)}` };
    const out = await graph(doFetch, token, 'POST', `/users/${user.id}/revokeSignInSessions`);
    if (out.status !== 200 && out.status !== 204) return { status: 'failed', error: `account disabled, but sessions were not revoked: ${errorText(out.body)}` };
    return { status: 'done', reference: `entra:${group}:${user.id}; account disabled and signed out` };
  }
  return { status: 'done', reference: `entra:${group}:${user.id}` };
}

// ---------------------------------------------------------------- Google

const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';
const SCOPES = 'https://www.googleapis.com/auth/admin.directory.group.member https://www.googleapis.com/auth/admin.directory.user';
export const GOOGLE_SCOPES = SCOPES.split(' ');
const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

async function googleToken(cfg: DirectoryConfig, doFetch: Fetch): Promise<string> {
  const env = connectorEnv().google;
  if (!env.email || !env.key) throw new ConfigMissing('GOOGLE_WORKSPACE_SA_EMAIL and GOOGLE_WORKSPACE_SA_PRIVATE_KEY are not set on the server');
  const cacheKey = `g:${cfg.adminEmail}`;
  const hit = tokens.get(cacheKey);
  if (hit && hit.until > Date.now() + 60_000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: env.email, sub: cfg.adminEmail, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))}`;
  let signature: string;
  try { signature = createSign('RSA-SHA256').update(unsigned).sign(env.key, 'base64url'); } catch { throw new ConfigMissing('GOOGLE_WORKSPACE_SA_PRIVATE_KEY is not a valid private key'); }
  const res = await doFetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const r = await read(res);
  if (retryable(r.status)) throw new Transient(`Google sign-in: HTTP ${r.status}`);
  if (r.status !== 200 || typeof r.body.access_token !== 'string') throw new Refused(`Google refused Patform's sign-in (${errorText(r.body)}). Has a super admin granted domain-wide delegation to the Patform service account, and is ${cfg.adminEmail} an admin?`);
  tokens.set(cacheKey, { token: r.body.access_token, until: Date.now() + Number(r.body.expires_in ?? 3600) * 1000 });
  return r.body.access_token;
}

async function gapi(doFetch: Fetch, token: string, method: string, path: string, body?: unknown) {
  const res = await doFetch(`${DIRECTORY}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
  });
  const r = await read(res);
  if (retryable(r.status)) throw new Transient(`Google Directory ${method} ${path}: HTTP ${r.status}`);
  return r;
}

async function google(job: DriverJob, cfg: DirectoryConfig, doFetch: Fetch): Promise<DriverResult> {
  const group = cfg.roleGroups[job.role];
  if (!group) return { status: 'failed', error: `the role "${job.role}" is not mapped to a Google group` };
  if (!(cfg.domains ?? []).includes(domainOf(job.email))) return { status: 'failed', error: `${job.email} is not in ${(cfg.domains ?? []).join(', ')}` };
  const token = await googleToken(cfg, doFetch);
  const g = encodeURIComponent(group); const u = encodeURIComponent(job.email);
  if (job.kind === 'provision') {
    const r = await gapi(doFetch, token, 'POST', `/groups/${g}/members`, { email: job.email, role: 'MEMBER' });
    if (r.status === 200 || r.status === 409) return { status: 'done', reference: `google:${group}:${job.email}` };
    if (r.status === 403) return { status: 'failed', error: 'Google refused: check the delegated scopes and that the admin can manage this group' };
    if (r.status === 404) return { status: 'failed', error: `Google group ${group} or account ${job.email} not found` };
    return { status: 'failed', error: `Google: ${errorText(r.body)}` };
  }
  const r = await gapi(doFetch, token, 'DELETE', `/groups/${g}/members/${u}`);
  if (!(r.status === 204 || r.status === 200 || r.status === 404)) {
    if (r.status === 403) return { status: 'failed', error: 'Google refused: check the delegated scopes' };
    return { status: 'failed', error: `Google: ${errorText(r.body)}` };
  }
  if (job.leaving && cfg.suspendOnLeave) {
    const off = await gapi(doFetch, token, 'PUT', `/users/${u}`, { suspended: true });
    if (off.status !== 200) return { status: 'failed', error: `removed from the group, but the account was not suspended: ${errorText(off.body)}` };
    const out = await gapi(doFetch, token, 'POST', `/users/${u}/signOut`);
    if (out.status !== 204 && out.status !== 200) return { status: 'failed', error: `account suspended, but not signed out: ${errorText(out.body)}` };
    return { status: 'done', reference: `google:${group}:${job.email}; account suspended and signed out` };
  }
  return { status: 'done', reference: `google:${group}:${job.email}` };
}

// ---------------------------------------------------------------- shared

/** Runs one job. Throws Transient (or anything) when worth retrying. */
export async function runDirectoryJob(kind: ConnectorKind, cfg: DirectoryConfig, job: DriverJob, doFetch: Fetch = fetch): Promise<DriverResult> {
  try {
    if (kind === 'microsoft365') return await microsoft(job, cfg, doFetch);
    if (kind === 'google_workspace') return await google(job, cfg, doFetch);
    return { status: 'failed', error: `not a directory connector: ${kind}` };
  } catch (err) {
    if (err instanceof Refused || err instanceof ConfigMissing) return { status: 'failed', error: err.message };
    throw err;
  }
}

/** "Test connection" in Setup: signs in and checks every mapped group exists. */
export async function testDirectory(kind: ConnectorKind, cfg: DirectoryConfig, doFetch: Fetch = fetch): Promise<{ ok: boolean; checks: { what: string; ok: boolean; detail?: string }[] }> {
  const checks: { what: string; ok: boolean; detail?: string }[] = [];
  let token: string;
  try {
    token = kind === 'microsoft365' ? await msToken(cfg, doFetch) : await googleToken(cfg, doFetch);
    checks.push({ what: 'Patform can sign in to the directory', ok: true });
  } catch (err) {
    checks.push({ what: 'Patform can sign in to the directory', ok: false, detail: err instanceof Error ? err.message : String(err) });
    return { ok: false, checks };
  }
  for (const [role, group] of Object.entries(cfg.roleGroups)) {
    try {
      const r = kind === 'microsoft365'
        ? await graph(doFetch, token, 'GET', `/groups/${group}?$select=id,displayName`)
        : await gapi(doFetch, token, 'GET', `/groups/${encodeURIComponent(group)}`);
      const name = String(r.body.displayName ?? r.body.name ?? group);
      checks.push(r.status === 200 ? { what: `role "${role}" → ${name}`, ok: true } : { what: `role "${role}" → ${group}`, ok: false, detail: r.status === 404 ? 'group not found' : r.status === 403 ? 'not allowed to read this group' : errorText(r.body) });
    } catch (err) {
      checks.push({ what: `role "${role}" → ${group}`, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/** What a customer's admin needs to do on their side, shown in Setup. */
export function setupInstructions(kind: ConnectorKind, cfg: Partial<DirectoryConfig>) {
  const env = connectorEnv();
  if (kind === 'microsoft365') {
    return {
      configured: Boolean(env.ms.clientId && env.ms.clientSecret),
      consentUrl: env.ms.clientId && cfg.tenantId ? `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/adminconsent?client_id=${encodeURIComponent(env.ms.clientId)}` : null,
      permissions: ['GroupMember.ReadWrite.All', 'User.Read.All', ...(cfg.suspendOnLeave ? ['User.ReadWrite.All', 'User.RevokeSessions.All'] : [])],
    };
  }
  return { configured: Boolean(env.google.email && env.google.key), clientId: env.google.clientId || null, serviceAccount: env.google.email || null, scopes: GOOGLE_SCOPES };
}
