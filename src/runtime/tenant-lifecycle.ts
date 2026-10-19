/**
 * Workspace export and closure (PRD 17.3).
 *
 * Export: every record the workspace owns, its process definitions and
 * versions, its attachments, and a machine-readable manifest with a SHA-256
 * per file. Secrets are left out — password and token hashes, sealed bank
 * numbers, signing secrets — because they are useless outside Patform and
 * dangerous in a download. The archive is a .tar.gz in the workspace's S3
 * bucket, downloadable by an owner through a short link for seven days.
 *
 * Closure, in order:
 *   1. An owner asks, typing the workspace name. An export starts.
 *   2. The owner suspends the workspace once the export is ready (or waives
 *      it): other members are signed out and deactivated, API keys revoked,
 *      webhooks and intake stopped. Owners stay, to download and to cancel.
 *   3. After the waiting period a site owner approves deletion. Any legal
 *      hold, active or released but not reviewed, blocks it.
 *   4. The worker deletes the workspace's rows table by table and its files,
 *      then records a certificate. The workspace row stays, renamed, so the
 *      certificate has something to point at. Backups expire on their own
 *      schedule and are not edited; the certificate says so.
 * Until step 4 starts, the owner can cancel and everyone is restored.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { inTransaction, type Client, type Pool } from './db.js';
import { InvalidInput } from './errors.js';
import { type Principal } from './policy.js';
import { recordWorkspaceAudit } from './authority.js';
import { objectStore } from './object-store.js';
import { auditPlatform, requirePlatformRole } from './platform-admin.js';

const UUID = /^[0-9a-f-]{36}$/;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const CLOSURE_WAIT_DAYS = Math.max(0, Number(process.env.WORKSPACE_CLOSURE_WAIT_DAYS ?? 14));
const EXPORT_DAYS = 7;

/** Never part of a workspace's data: the site's own tables and the closure records themselves. */
const KEEP = new Set(['tenant', 'tenant_export', 'tenant_closure', 'platform_admin_audit', 'platform_operator', 'platform_deployment', 'platform_worker_heartbeat']);
/** Exported never: credentials and live tokens. Still deleted on closure. */
const NOT_EXPORTED = new Set(['credential', 'mfa_enrolment', 'mfa_recovery_code', 'mfa_challenge', 'auth_token', 'oauth_token', 'oauth_authorization', 'session', 'resume_token', 'api_idempotency']);
const SECRET_COLUMN = /(password|secret|_hash$|sealed|private_key)/;

// ----------------------------------------------------------------- scope

export interface Scoped { table: string; where: string; via: string }
/**
 * Every table holding this workspace's rows, with the condition that picks
 * them: its own tenant_id, or a foreign key into a table already in scope.
 * Worked out from the database's own constraints, so new tables are covered
 * without anyone remembering to add them here.
 */
export async function workspaceTables(client: Client | Pool): Promise<Scoped[]> {
  const { rows: tables } = await client.query<{ table_name: string; has_tenant: boolean }>(
    `select t.table_name, exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'tenant_id') as has_tenant
       from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE'`);
  const { rows: fks } = await client.query<{ child: string; col: string; parent: string; pcol: string }>(
    `select cl.relname as child, a.attname as col, pl.relname as parent, pa.attname as pcol
       from pg_constraint con join pg_class cl on cl.oid = con.conrelid join pg_class pl on pl.oid = con.confrelid
       join pg_namespace n on n.oid = cl.relnamespace
       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
       join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = con.confkey[1]
      where con.contype = 'f' and n.nspname = 'public' and array_length(con.conkey, 1) = 1`);
  const scoped = new Map<string, Scoped>();
  for (const t of tables) if (t.has_tenant && !KEEP.has(t.table_name)) scoped.set(t.table_name, { table: t.table_name, where: `tenant_id = $1`, via: 'tenant_id' });
  for (let changed = true; changed;) {
    changed = false;
    for (const t of tables) {
      if (scoped.has(t.table_name) || KEEP.has(t.table_name)) continue;
      const fk = fks.find((f) => f.child === t.table_name && scoped.has(f.parent) && f.parent !== t.table_name);
      if (!fk) continue;
      const parent = scoped.get(fk.parent)!;
      scoped.set(t.table_name, { table: t.table_name, where: `"${fk.col}" in (select "${fk.pcol}" from "${fk.parent}" where ${parent.where})`, via: `${fk.col} → ${fk.parent}` });
      changed = true;
    }
  }
  return [...scoped.values()].sort((a, b) => a.table.localeCompare(b.table));
}

// ------------------------------------------------------------------ export

/** A minimal POSIX tar writer: enough for data files and attachments. */
function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  let path = name; let prefix = '';
  if (Buffer.byteLength(path) > 100) { const cut = path.lastIndexOf('/', 154); prefix = path.slice(0, cut); path = path.slice(cut + 1).slice(-100); }
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  header.write('        ', 148); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0; for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);

async function ownerOf(pool: Pool | Client, principal: Principal) {
  if (principal.kind !== 'actor') throw new InvalidInput('signed-in members only');
  const { rows } = await pool.query<{ workspace_role: string; active: boolean; email: string }>('select workspace_role, active, email from actor where id = $1 and tenant_id = $2', [principal.actorId, principal.tenantId]);
  if (!rows[0]?.active || rows[0].workspace_role !== 'owner') throw new InvalidInput('only a workspace owner can export or close the workspace');
  return { tenantId: principal.tenantId, actorId: principal.actorId, email: rows[0].email };
}

export async function requestExport(pool: Pool, principal: Principal) {
  const w = await ownerOf(pool, principal);
  const { rows: busy } = await pool.query(`select 1 from tenant_export where tenant_id = $1 and status in ('queued', 'running')`, [w.tenantId]);
  if (busy[0]) throw new InvalidInput('an export is already being prepared');
  const { rows } = await pool.query<{ id: string }>(`insert into tenant_export (tenant_id, requested_by) values ($1, $2) returning id`, [w.tenantId, w.actorId]);
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'workspace.export_requested', targetId: rows[0]!.id });
  return { id: rows[0]!.id, status: 'queued' };
}

export async function listExports(pool: Pool, principal: Principal) {
  const w = await ownerOf(pool, principal);
  const { rows } = await pool.query(`select id, reason, status, sha256, byte_size, error, created_at, ready_at, expires_at, manifest->'totals' as totals from tenant_export where tenant_id = $1 order by created_at desc limit 20`, [w.tenantId]);
  return rows;
}

export async function exportLink(pool: Pool, principal: Principal, exportId: string) {
  const w = await ownerOf(pool, principal);
  if (!UUID.test(exportId)) throw new InvalidInput('no such export');
  const { rows } = await pool.query<{ status: string; storage_key: string; expires_at: Date }>('select status, storage_key, expires_at from tenant_export where id = $1 and tenant_id = $2', [exportId, w.tenantId]);
  const e = rows[0];
  if (!e || e.status !== 'ready') throw new InvalidInput('that export is not ready');
  if (e.expires_at < new Date()) throw new InvalidInput('that export has expired; make a new one');
  await recordWorkspaceAudit(pool, { tenantId: w.tenantId, actorId: w.actorId, action: 'workspace.export_downloaded', targetId: exportId });
  return { url: await objectStore().link(e.storage_key, { contentType: 'application/gzip', filename: `workspace-export-${exportId}.tar.gz`, seconds: 300 }) };
}

/** Builds one queued export. The worker calls this; tests call it directly. */
export async function buildExport(pool: Pool, exportId: string) {
  const { rows } = await pool.query<{ tenant_id: string; name: string }>(
    `update tenant_export x set status = 'running' from tenant t where t.id = x.tenant_id and x.id = $1 and x.status = 'queued' returning x.tenant_id, t.name`, [exportId]);
  if (!rows[0]) return null;
  const { tenant_id: tenantId, name } = rows[0];
  try {
    const store = objectStore();
    const parts: Buffer[] = [];
    const tableEntries: { name: string; rows: number; file: string; sha256: string; via: string }[] = [];
    const scope = await workspaceTables(pool);
    for (const t of scope) {
      if (NOT_EXPORTED.has(t.table)) continue;
      const { rows: data } = await pool.query(`select * from "${t.table}" where ${t.where}`, [tenantId]);
      const clean = data.map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => !SECRET_COLUMN.test(k))));
      const body = Buffer.from(JSON.stringify(clean, null, 1));
      const file = `data/${t.table}.json`;
      parts.push(tarEntry(file, body));
      tableEntries.push({ name: t.table, rows: clean.length, file, sha256: sha(body), via: t.via });
    }
    // Process definitions, each version as its own file.
    const { rows: versions } = await pool.query<{ process_key: string; version: number; blueprint: unknown }>('select process_key, version, blueprint from process_version where tenant_id = $1 order by process_key, version', [tenantId]);
    const definitions: { file: string; sha256: string }[] = [];
    for (const v of versions) {
      const body = Buffer.from(JSON.stringify(v.blueprint, null, 2));
      const file = `definitions/${safeName(v.process_key)}-v${v.version}.json`;
      parts.push(tarEntry(file, body)); definitions.push({ file, sha256: sha(body) });
    }
    // Attachments: receipts, photos, contract and policy documents. Only files that passed the malware scan.
    const attachments: { file: string; source: string; sha256: string | null; bytes: number; skipped?: string }[] = [];
    const sources: { table: string; sql: string }[] = [
      { table: 'file', sql: `select id, filename, storage_key, scan_status from file where tenant_id = $1` },
      { table: 'ops_photo', sql: `select id, filename, storage_key, scan_status from ops_photo where tenant_id = $1` },
      { table: 'gov_file', sql: `select id, filename, storage_key, scan_status from gov_file where tenant_id = $1` },
    ];
    for (const src of sources) {
      const { rows: files } = await pool.query<{ id: string; filename: string; storage_key: string; scan_status: string }>(src.sql, [tenantId]);
      for (const f of files) {
        const file = `attachments/${src.table}/${f.id}-${safeName(f.filename)}`;
        if (f.scan_status === 'quarantined') { attachments.push({ file, source: `${src.table}:${f.id}`, sha256: null, bytes: 0, skipped: 'failed the malware check' }); continue; }
        try {
          const bytes = await store.get(f.storage_key);
          parts.push(tarEntry(file, bytes)); attachments.push({ file, source: `${src.table}:${f.id}`, sha256: sha(bytes), bytes: bytes.length });
        } catch (err) { attachments.push({ file, source: `${src.table}:${f.id}`, sha256: null, bytes: 0, skipped: `could not be read: ${err instanceof Error ? err.message : String(err)}` }); }
      }
    }
    const manifest = {
      format: 'patform-workspace-export', version: 1, workspace: { id: tenantId, name }, generated_at: new Date().toISOString(),
      tables: tableEntries, definitions, attachments,
      totals: { tables: tableEntries.length, rows: tableEntries.reduce((a, t) => a + t.rows, 0), attachments: attachments.filter((a) => !a.skipped).length },
      left_out: { tables: [...NOT_EXPORTED], columns: 'any column holding a password, token hash, secret, sealed value or private key' },
      relationships: 'Rows keep their ids and foreign-key columns; data/*.json files can be joined on them. "via" says how each table belongs to the workspace.',
    };
    const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2));
    const archive = gzipSync(Buffer.concat([tarEntry('manifest.json', manifestBody), ...parts, Buffer.alloc(1024)]));
    const key = `exports/${tenantId}/${exportId}.tar.gz`;
    await store.put(key, archive, 'application/gzip', { sha256: sha(archive) });
    await pool.query(`update tenant_export set status = 'ready', storage_key = $2, manifest = $3, sha256 = $4, byte_size = $5, ready_at = now(), expires_at = now() + make_interval(days => $6) where id = $1`,
      [exportId, key, JSON.stringify(manifest), sha(archive), archive.length, EXPORT_DAYS]);
    return { id: exportId, sha256: sha(archive), manifest };
  } catch (err) {
    await pool.query(`update tenant_export set status = 'failed', error = $2 where id = $1`, [exportId, err instanceof Error ? err.message : String(err)]);
    throw err;
  }
}

/** The worker's half: build what is queued, delete what has expired. */
export async function runExports(pool: Pool) {
  const { rows } = await pool.query<{ id: string }>(`select id from tenant_export where status = 'queued' order by created_at limit 2`);
  for (const r of rows) await buildExport(pool, r.id).catch((err) => console.error('export failed:', err instanceof Error ? err.message : err));
  const { rows: old } = await pool.query<{ id: string; storage_key: string }>(`select id, storage_key from tenant_export where status = 'ready' and expires_at < now()`);
  for (const e of old) {
    await objectStore().remove(e.storage_key).catch(() => undefined);
    await pool.query(`update tenant_export set status = 'expired' where id = $1`, [e.id]);
  }
  return rows.length;
}

// ----------------------------------------------------------------- closure

export async function closureStatus(pool: Pool, principal: Principal) {
  const w = await ownerOf(pool, principal);
  const { rows } = await pool.query(`select c.*, x.status as export_status from tenant_closure c left join tenant_export x on x.id = c.export_id where c.tenant_id = $1 order by c.created_at desc limit 1`, [w.tenantId]);
  const holds = await pool.query<{ n: number }>(`select count(*)::int as n from legal_hold where tenant_id = $1 and status in ('active', 'released')`, [w.tenantId]);
  return { closure: rows[0] ?? null, legalHolds: holds.rows[0]!.n, waitDays: CLOSURE_WAIT_DAYS };
}

export async function requestClosure(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await ownerOf(pool, principal);
  const reason = text(body.reason, 2000);
  if (!reason) throw new InvalidInput('say why the workspace is closing');
  const { rows: t } = await pool.query<{ name: string; is_scenario: boolean }>('select name, is_scenario from tenant where id = $1', [w.tenantId]);
  if (text(body.confirmName, 200) !== t[0]!.name) throw new InvalidInput('type the workspace name exactly to confirm');
  const { rows: ops } = await pool.query(`select 1 from platform_operator p join actor a on a.id = p.actor_id where a.tenant_id = $1 and p.revoked_at is null`, [w.tenantId]);
  if (ops[0]) throw new InvalidInput('a site administrator belongs to this workspace; their site access must move first');
  return inTransaction(pool, async (client) => {
    const { rows: open } = await client.query(`select 1 from tenant_closure where tenant_id = $1 and status not in ('closed', 'cancelled')`, [w.tenantId]);
    if (open[0]) throw new InvalidInput('a closure is already in progress');
    const { rows: x } = await client.query<{ id: string }>(`insert into tenant_export (tenant_id, requested_by, reason) values ($1, $2, 'closure') returning id`, [w.tenantId, w.actorId]);
    const { rows } = await client.query<{ id: string }>(`insert into tenant_closure (tenant_id, requested_by, requested_by_email, reason, export_id) values ($1, $2, $3, $4, $5) returning id`,
      [w.tenantId, w.actorId, w.email, reason, x[0]!.id]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'workspace.closure_requested', targetId: rows[0]!.id, detail: { reason } });
    return { id: rows[0]!.id, exportId: x[0]!.id };
  });
}

/** Step 2: everyone but the owners leaves; keys, webhooks and intake stop. */
export async function suspendWorkspace(pool: Pool, principal: Principal, body: Record<string, unknown>) {
  const w = await ownerOf(pool, principal);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; status: string; export_id: string | null; export_status: string | null }>(
      `select c.id, c.status, c.export_id, x.status as export_status from tenant_closure c left join tenant_export x on x.id = c.export_id where c.tenant_id = $1 and c.status = 'requested' for update of c`, [w.tenantId]);
    const c = rows[0];
    if (!c) throw new InvalidInput('there is no closure waiting to be suspended');
    const waive = body.waiveExport === true;
    if (c.export_status !== 'ready' && !waive) throw new InvalidInput('the export is not ready yet; wait for it, or say you do not need it');
    const { rows: members } = await client.query<{ id: string }>(`select id from actor where tenant_id = $1 and active and workspace_role <> 'owner'`, [w.tenantId]);
    const ids = members.map((m) => m.id);
    await client.query(`update actor set active = false where id = any($1::uuid[])`, [ids]);
    await client.query(`update session set revoked_at = now() where revoked_at is null and actor_id in (select id from actor where tenant_id = $1 and workspace_role <> 'owner')`, [w.tenantId]);
    await client.query(`update api_key set revoked_at = now() where revoked_at is null and actor_id in (select id from actor where tenant_id = $1)`, [w.tenantId]);
    const { rows: hooks } = await client.query<{ id: string }>(`update webhook_endpoint set active = false where tenant_id = $1 and active returning id`, [w.tenantId]);
    await client.query(`update tenant set intake_paused_at = coalesce(intake_paused_at, now()), intake_pause_reason = 'workspace closing' where id = $1`, [w.tenantId]);
    await client.query(`update tenant_closure set status = 'suspended', suspended_at = now(), export_waived = $2, suspended_actors = $3, progress = progress || $4::jsonb, waiting_until = now() + make_interval(days => $5) where id = $1`,
      [c.id, waive, JSON.stringify(ids), JSON.stringify({ webhooks: hooks.map((h) => h.id) }), CLOSURE_WAIT_DAYS]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'workspace.suspended', targetId: c.id, detail: { members: ids.length, webhooks: hooks.length, exportWaived: waive } });
    return { id: c.id, status: 'suspended', membersSuspended: ids.length, deletableAfter: new Date(Date.now() + CLOSURE_WAIT_DAYS * 86400000).toISOString() };
  });
}

/** Cancel before deletion starts: everyone suspended comes back, webhooks and intake resume. API keys stay revoked. */
export async function cancelClosure(pool: Pool, principal: Principal) {
  const w = await ownerOf(pool, principal);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; status: string; suspended_actors: string[]; progress: { webhooks?: string[] } }>(
      `select id, status, suspended_actors, progress from tenant_closure where tenant_id = $1 and status in ('requested', 'suspended', 'approved') for update`, [w.tenantId]);
    const c = rows[0];
    if (!c) throw new InvalidInput('there is no closure to cancel');
    await client.query(`update actor set active = true where id = any($1::uuid[]) and tenant_id = $2`, [c.suspended_actors, w.tenantId]);
    await client.query(`update webhook_endpoint set active = true where id = any($1::uuid[]) and tenant_id = $2`, [c.progress.webhooks ?? [], w.tenantId]);
    await client.query(`update tenant set intake_paused_at = null, intake_pause_reason = null where id = $1 and intake_pause_reason = 'workspace closing'`, [w.tenantId]);
    await client.query(`update tenant_closure set status = 'cancelled', cancelled_by = $2, cancelled_at = now() where id = $1`, [c.id, w.actorId]);
    await recordWorkspaceAudit(client, { tenantId: w.tenantId, actorId: w.actorId, action: 'workspace.closure_cancelled', targetId: c.id, detail: { restored: c.suspended_actors.length } });
    return { id: c.id, status: 'cancelled', restored: c.suspended_actors.length, note: 'API keys revoked at suspension stay revoked; issue new ones.' };
  });
}

// ------------------------------------------------------------- site owner

export async function listClosures(pool: Pool, actorId: string) {
  await requirePlatformRole(pool, actorId, 'viewer');
  const { rows } = await pool.query(
    `select c.id, c.tenant_id, t.name as workspace, c.status, c.reason, c.requested_by_email, c.created_at, c.suspended_at, c.waiting_until, c.approved_at, c.closed_at, c.export_waived, c.certificate,
            x.status as export_status, (select count(*)::int from legal_hold h where h.tenant_id = c.tenant_id and h.status in ('active', 'released')) as legal_holds
       from tenant_closure c join tenant t on t.id = c.tenant_id left join tenant_export x on x.id = c.export_id order by c.created_at desc limit 100`);
  return rows;
}

/** Step 3: a site owner approves deletion, after the wait, with no legal hold in the way. */
export async function approveClosure(pool: Pool, actorId: string, closureId: string) {
  await requirePlatformRole(pool, actorId, 'owner');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ tenant_id: string; status: string; waiting_until: Date | null }>('select tenant_id, status, waiting_until from tenant_closure where id = $1 for update', [closureId]);
    const c = rows[0];
    if (!c) throw new InvalidInput('no such closure');
    if (c.status !== 'suspended') throw new InvalidInput('only a suspended workspace can be approved for deletion');
    if (c.waiting_until && c.waiting_until > new Date()) throw new InvalidInput(`the waiting period ends ${c.waiting_until.toISOString().slice(0, 10)}`);
    const { rows: h } = await client.query<{ n: number }>(`select count(*)::int as n from legal_hold where tenant_id = $1 and status in ('active', 'released')`, [c.tenant_id]);
    if (h[0]!.n) throw new InvalidInput(`${h[0]!.n} legal hold(s) cover this workspace; deletion is blocked until they are released and reviewed`);
    await client.query(`update tenant_closure set status = 'approved', approved_by = $2, approved_at = now() where id = $1`, [closureId, actorId]);
    await auditPlatform(client as unknown as Pool, actorId, 'workspace.deletion_approved', c.tenant_id, closureId);
    return { id: closureId, status: 'approved' };
  });
}

/**
 * Step 4. Table by table, each in its own transaction, children before the
 * rows they point at (a table whose rows are still referenced is retried on
 * the next pass). History tables are append-only by trigger; each guard lets
 * a DELETE through only when the transaction set patform.workspace_purge,
 * which this does, transaction-locally. Resumable: a crash just continues.
 */
export async function runClosures(pool: Pool) {
  const { rows } = await pool.query<{ id: string; tenant_id: string }>(`update tenant_closure set status = 'deleting' where status in ('approved', 'deleting') returning id, tenant_id`);
  for (const c of rows) await deleteWorkspace(pool, c.id, c.tenant_id);
  return rows.length;
}

async function deleteWorkspace(pool: Pool, closureId: string, tenantId: string) {
  const scope = await workspaceTables(pool);
  // Files first: collect every key while the rows that name them still exist.
  const { rows: keys } = await pool.query<{ storage_key: string }>(
    `select storage_key from file where tenant_id = $1 union all select storage_key from ops_photo where tenant_id = $1 union all select storage_key from gov_file where tenant_id = $1`, [tenantId]);
  let filesDeleted = 0;
  for (const k of keys) { try { await objectStore().remove(k.storage_key); filesDeleted++; } catch { await pool.query('insert into file_deletion (storage_key) values ($1) on conflict do nothing', [k.storage_key]); } }
  const counts: Record<string, number> = {};
  let remaining = scope.map((s) => s);
  for (let pass = 0; pass < 40 && remaining.length; pass++) {
    const next: Scoped[] = [];
    for (const t of remaining) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Transaction-local: lets the append-only guards accept this DELETE and nothing else.
        await client.query("set local patform.workspace_purge = 'on'");
        const r = await client.query(`delete from "${t.table}" where ${t.where}`, [tenantId]);
        await client.query('commit');
        counts[t.table] = (counts[t.table] ?? 0) + (r.rowCount ?? 0);
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        if ((err as { code?: string }).code !== '23503') throw err;
        next.push(t);
      } finally { client.release(); }
    }
    if (next.length === remaining.length) throw new Error(`workspace deletion is stuck on: ${next.map((t) => t.table).join(', ')}`);
    remaining = next;
  }
  const { rows: x } = await pool.query<{ id: string; sha256: string | null; expires_at: Date | null; status: string }>(`select id, sha256, expires_at, status from tenant_export where tenant_id = $1 order by created_at desc limit 1`, [tenantId]);
  const { rows: c } = await pool.query<{ requested_by_email: string; created_at: Date; suspended_at: Date; approved_by: string; approved_at: Date; reason: string; export_waived: boolean }>('select * from tenant_closure where id = $1', [closureId]);
  const certificate = {
    workspace: tenantId, reason: c[0]!.reason, requested_by: c[0]!.requested_by_email, requested_at: c[0]!.created_at, suspended_at: c[0]!.suspended_at,
    deletion_approved_by: c[0]!.approved_by, deletion_approved_at: c[0]!.approved_at, deleted_at: new Date().toISOString(),
    rows_deleted: counts, total_rows: Object.values(counts).reduce((a, n) => a + n, 0), files_deleted: filesDeleted, files_queued: keys.length - filesDeleted,
    export: c[0]!.export_waived ? 'waived by the owner' : x[0] ? { id: x[0].id, sha256: x[0].sha256, available_until: x[0].expires_at } : null,
    backups: 'Database backups are not edited. They expire under the documented backup retention schedule, after which no copy of this workspace remains.',
  };
  await pool.query(`update tenant set name = 'Closed workspace', closed_at = now(), intake_paused_at = coalesce(intake_paused_at, now()), intake_pause_reason = 'closed' where id = $1`, [tenantId]);
  await pool.query(`update tenant_closure set status = 'closed', closed_at = now(), certificate = $2, progress = progress || $3::jsonb where id = $1`, [closureId, JSON.stringify(certificate), JSON.stringify({ counts })]);
  return certificate;
}
