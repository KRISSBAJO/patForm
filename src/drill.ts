import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { Blueprint } from './blueprint/index.js';
import { readFileSync } from 'node:fs';
import { createPool, describeTarget } from './runtime/db.js';
import { Engine, type VersionRow } from './runtime/engine.js';
import { suppressDelivery } from './runtime/email.js';

/**
 * The recovery drill.
 *
 * §20.2's recovery gate: *"Backup restoration and job replay exercises succeed
 * in a non-production environment."* §10.4 puts numbers on it — recovery point
 * objective 15 minutes, recovery time objective 4 hours, restore drill
 * quarterly — and a target nobody has measured is a wish.
 *
 * Four things are proved here, and the last two are the ones that are easy to
 * assume and wrong:
 *
 *   1. A backup can actually be taken. Not assumed: checked, because the
 *      obvious command on this machine could not.
 *   2. The restore is faithful, by digest rather than by eyeballing counts.
 *   3. The safeguards survive it. A restored database where `event` accepts an
 *      UPDATE is an audit hole that no row count would show.
 *   4. Replaying jobs after a restore does not repeat work the backup knew
 *      about — and *does* repeat work it did not. The second half is the RPO
 *      window, and it is not only lost data: it is external effects the
 *      restored system has no memory of having caused.
 *
 * Nothing here touches the source database. The restore goes to a scratch
 * database that is dropped at the end, and delivery is suppressed before any
 * replay, because a drill that emails customers is an incident.
 */

const exec = promisify(execFile);

const RPO_MINUTES = 15;
const RTO_HOURS = 4;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

interface Step {
  name: string;
  passed: boolean;
  detail: string;
  seconds?: number;
}

const steps: Step[] = [];

function record(name: string, passed: boolean, detail: string, seconds?: number): void {
  steps.push({ name, passed, detail, seconds });
  const mark = passed ? `${GREEN}pass${OFF}` : `${RED}FAIL${OFF}`;
  const timing = seconds !== undefined ? ` ${DIM}(${seconds.toFixed(1)}s)${OFF}` : '';
  console.log(`\n  ${mark}  ${BOLD}${name}${OFF}${timing}`);
  console.log(`        ${DIM}${detail}${OFF}`);
}

// ------------------------------------------------------------------- tools

interface Tools {
  dump: string[];
  restore: string[];
  psql: string[];
  how: string;
}

/**
 * Finds a pg_dump that can actually read this server.
 *
 * pg_dump refuses a server newer than itself, which is the correct behaviour
 * and a surprising one to meet during an incident. This machine has 16.4 on
 * PATH against a 17.11 server, so the obvious command produces no backup at
 * all — the failure that makes a backup policy worthless is usually this one,
 * not a disk.
 *
 * The container's own binaries are tried as a fallback because they match by
 * construction. That only helps a local Postgres; against Renviq the answer is
 * a matching client on the machine that runs the drill, and the message says
 * so rather than leaving somebody to guess.
 */
async function findTools(serverMajor: number): Promise<Tools> {
  const candidates: { dump: string[]; restore: string[]; psql: string[]; how: string }[] = [];

  if (process.env.PG_BIN) {
    candidates.push({
      dump: [join(process.env.PG_BIN, 'pg_dump')],
      restore: [join(process.env.PG_BIN, 'pg_restore')],
      psql: [join(process.env.PG_BIN, 'psql')],
      how: `PG_BIN=${process.env.PG_BIN}`,
    });
  }
  candidates.push({ dump: ['pg_dump'], restore: ['pg_restore'], psql: ['psql'], how: 'pg_dump on PATH' });

  const container = process.env.PG_CONTAINER ?? 'patform-pg';
  candidates.push({
    dump: ['docker', 'exec', '-i', container, 'pg_dump'],
    restore: ['docker', 'exec', '-i', container, 'pg_restore'],
    psql: ['docker', 'exec', '-i', container, 'psql'],
    how: `pg_dump inside the "${container}" container`,
  });

  const tried: string[] = [];
  for (const c of candidates) {
    try {
      const { stdout } = await exec(c.dump[0]!, [...c.dump.slice(1), '--version']);
      const major = Number(/(\d+)\./.exec(stdout)?.[1] ?? 0);
      if (major >= serverMajor) return c;
      tried.push(`${c.how}: version ${major}, server is ${serverMajor}`);
    } catch {
      tried.push(`${c.how}: not available`);
    }
  }

  throw new Error(
    `No usable pg_dump for a PostgreSQL ${serverMajor} server.\n` +
      tried.map((t) => `      ${t}`).join('\n') +
      `\n\n      pg_dump refuses a server newer than itself. Install client tools of at least ` +
      `version ${serverMajor}, or set PG_BIN to a directory that has them.`,
  );
}

// ------------------------------------------------------------------ digest

/**
 * A content digest of every table.
 *
 * Row counts are the usual check and they are not enough: a restore that
 * silently dropped a jsonb column, or reordered an array, or lost timezone
 * information, has the same counts. Hashing the rendered rows catches all of
 * that, and comparing per table says *which* one is wrong rather than that
 * something is.
 */
async function digest(client: Client): Promise<Record<string, { rows: number; md5: string }>> {
  const { rows: tables } = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`,
  );

  const out: Record<string, { rows: number; md5: string }> = {};
  for (const { table_name } of tables) {
    // Ordering by the rendered row rather than by a key: not every table has
    // a sortable primary key, and a digest that depends on physical order
    // would report a false difference after any restore.
    const { rows } = await client.query<{ n: string; h: string | null }>(
      `select count(*)::text as n, md5(coalesce(string_agg(r, '|' order by r), '')) as h
         from (select t::text as r from "${table_name}" t) s`,
    );
    out[table_name] = { rows: Number(rows[0]!.n), md5: rows[0]!.h ?? '' };
  }
  return out;
}

function compare(before: Awaited<ReturnType<typeof digest>>, after: typeof before) {
  const differences: string[] = [];
  for (const [table, b] of Object.entries(before)) {
    const a = after[table];
    if (!a) {
      differences.push(`${table} is missing from the restore`);
      continue;
    }
    if (a.rows !== b.rows) differences.push(`${table}: ${b.rows} rows became ${a.rows}`);
    else if (a.md5 !== b.md5) differences.push(`${table}: same ${b.rows} rows, different contents`);
  }
  for (const table of Object.keys(after)) {
    if (!(table in before)) differences.push(`${table} appeared in the restore and was not in the source`);
  }
  return differences;
}

// -------------------------------------------------------------------- main

function urlWithDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function main(): Promise<void> {
  // Before anything else. A drill replays an outbox, and an outbox sends
  // email; a recovery exercise that mails customers is an incident.
  suppressDelivery('a recovery drill replays jobs that already ran');

  const sourceUrl = process.env.DATABASE_URL!;
  if (!sourceUrl) throw new Error('DATABASE_URL is not set');

  const scratchName = `patform_drill_${Date.now().toString(36)}`;
  const workDir = join(tmpdir(), scratchName);
  mkdirSync(workDir, { recursive: true });
  const dumpFile = join(workDir, 'backup.dump');

  console.log(`\n${BOLD}Recovery drill${OFF} ${DIM}- ${describeTarget()}${OFF}`);
  console.log(`${DIM}§20.2 recovery gate. Targets from §10.4: RPO ${RPO_MINUTES} minutes, RTO ${RTO_HOURS} hours.${OFF}`);

  const source = new Client({ connectionString: sourceUrl });
  await source.connect();
  const { rows: version } = await source.query<{ v: string; num: string }>(
    "select version() as v, current_setting('server_version_num') as num",
  );
  const serverMajor = Math.floor(Number(version[0]!.num) / 10000);
  console.log(`${DIM}${version[0]!.v.split(',')[0]}${OFF}`);

  // ---- 1. can a backup be taken at all
  let tools: Tools;
  try {
    tools = await findTools(serverMajor);
    record('A backup can be taken', true, `Using ${tools.how}, against a PostgreSQL ${serverMajor} server.`);
  } catch (err) {
    record('A backup can be taken', false, err instanceof Error ? err.message : String(err));
    await source.end();
    return report(1);
  }

  /*
   * Work for the replay to act on, created before the backup is taken.
   *
   * The first version of this drill passed while replaying nothing: the queue
   * happened to be empty, so "no duplicated effects" was true and meant
   * nothing. A gate that reports success without checking anything is the
   * failure this project keeps finding, and a recovery drill is the worst
   * place to have one.
   *
   * Two records, for the two things that can be in a backup:
   *
   *   pending    submitted and never drained, so its outbox rows are still
   *              waiting. After a restore these must actually run.
   *   replayed   drained, then its outbox rows marked undelivered again —
   *              the crash window where the effect happened but the queue
   *              never learned. After a restore these must NOT run twice,
   *              and the only thing standing in the way is that the
   *              idempotency ledger was inside the backup.
   */
  const pool = createPool(4);
  const engine = new Engine(pool);
  const bp = Blueprint.parse(
    JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json', 'utf8')),
  );
  const drillTenant = await reuseDrillTenant(pool, engine);
  const drillVersion = await drillVersionFor(pool, engine, drillTenant, bp);

  // The order is load-bearing. `drain` empties the whole outbox, not one
  // record's — so the record that must still be waiting at backup time has to
  // be submitted after the drain, or the drill quietly delivers it and then
  // proves that replaying nothing repeats nothing.
  const replayed = await engine.submit({
    version: drillVersion,
    answers: completeFor(bp, 'replayed@example.test'),
    now: new Date(),
  });
  await engine.drain(new Date(), 'drill');
  /*
   * `available_at` matters as much as `done_at`.
   *
   * A claim pushes the row's availability 30 seconds out — the visibility
   * timeout that stops two workers taking the same job. Clearing `done_at`
   * without clearing that left the row invisible, and the drill reported the
   * replay as incomplete when nothing had been offered to it.
   *
   * It is also what a real recovery looks like: rows held by a worker that no
   * longer exists come back only after the timeout elapses, so a restore does
   * not resume instantly even once the database is up. That is part of the
   * RTO, not separate from it.
   */
  await pool.query(
    `update outbox
        set done_at = null, claimed_by = null, claimed_at = null, available_at = now() - interval '1 minute'
      where instance_id = $1`,
    [replayed.instanceId],
  );

  const pending = await engine.submit({
    version: drillVersion,
    answers: completeFor(bp, 'pending@example.test'),
    now: new Date(),
  });
  /*
   * Held back so a live worker cannot deliver it before the backup is taken.
   *
   * The first version of this assumed nothing else was running. A worker was,
   * and it drained the record between the digest and the dump — so the drill
   * reported that the restore differed from the source and that the replay had
   * finished nothing, when in truth it had simply raced. A drill that only
   * passes on a quiet machine is not a drill.
   *
   * Pushing `available_at` out is the same mechanism a scheduled action uses,
   * so nothing special is being done to the queue: the row is genuinely
   * undelivered in the backup, and the restored copy pulls it back to now.
   */
  await pool.query(
    "update outbox set available_at = now() + interval '1 hour' where instance_id = $1 and done_at is null",
    [pending.instanceId],
  );

  /*
   * One snapshot, read twice.
   *
   * pg_dump takes a consistent snapshot of its own. Computing the comparison
   * digest in a separate connection reads a *different* moment, so any write
   * in between shows up as the restore disagreeing with the source — which is
   * what a live worker draining the queue looked like.
   *
   * `pg_export_snapshot` is the fix and the technique worth knowing: open a
   * repeatable-read transaction, publish its snapshot id, and hand it to
   * pg_dump. Both then see exactly the same database. The transaction has to
   * stay open until the dump finishes, because the snapshot dies with it.
   */
  await source.query('begin isolation level repeatable read');
  const { rows: snap } = await source.query<{ id: string }>('select pg_export_snapshot() as id');
  const snapshotId = snap[0]!.id;
  const before = await digest(source);
  const totalRows = Object.values(before).reduce((a, t) => a + t.rows, 0);

  // ---- 2. take it
  const dumpStarted = Date.now();
  await exec(tools.dump[0]!, [
    ...tools.dump.slice(1),
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    `--snapshot=${snapshotId}`,
    `--file=${inContainer(tools) ? '/tmp/backup.dump' : dumpFile}`,
    `--dbname=${toolUrl(tools, sourceUrl)}`,
  ]);
  if (inContainer(tools)) {
    await exec('docker', ['cp', `${process.env.PG_CONTAINER ?? 'patform-pg'}:/tmp/backup.dump`, dumpFile]);
  }
  const dumpSeconds = (Date.now() - dumpStarted) / 1000;
  const dumpBytes = statSync(dumpFile).size;
  await source.query('commit'); // releases the snapshot

  record(
    'The backup completes inside the recovery point objective',
    dumpSeconds * 60 < RPO_MINUTES * 60,
    `${(dumpBytes / 1024).toFixed(0)} KB covering ${totalRows} rows across ${Object.keys(before).length} tables. ` +
      `A backup taking longer than the ${RPO_MINUTES}-minute RPO cannot be run often enough to meet it.`,
    dumpSeconds,
  );

  // ---- 3. work that happens after the backup, which the backup cannot know
  //         about. This is the RPO window, made concrete.
  const afterBackup = await engine.submit({
    version: drillVersion,
    answers: completeFor(bp, 'after-backup@example.test'),
    now: new Date(),
  });
  await engine.drain(new Date(), 'drill');
  const { rows: sentAfterBackup } = await pool.query<{ count: number }>(
    'select count(*)::int as count from email_log where instance_id = $1',
    [afterBackup.instanceId],
  );

  // ---- 4. restore into a scratch database
  const adminUrl = urlWithDatabase(sourceUrl, 'postgres');
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database "${scratchName}"`);
  const scratchUrl = urlWithDatabase(sourceUrl, scratchName);

  const restoreStarted = Date.now();
  if (inContainer(tools)) {
    await exec('docker', ['cp', dumpFile, `${process.env.PG_CONTAINER ?? 'patform-pg'}:/tmp/restore.dump`]);
  }
  await exec(tools.restore[0]!, [
    ...tools.restore.slice(1),
    '--no-owner',
    '--no-privileges',
    `--dbname=${toolUrl(tools, scratchUrl)}`,
    inContainer(tools) ? '/tmp/restore.dump' : dumpFile,
  ]);
  const restoreSeconds = (Date.now() - restoreStarted) / 1000;

  const restored = new Client({ connectionString: scratchUrl });
  await restored.connect();

  record(
    'The restore completes inside the recovery time objective',
    restoreSeconds < RTO_HOURS * 3600,
    `Restored into a scratch database. The RTO is ${RTO_HOURS} hours end to end, which has to cover noticing, ` +
      `deciding, provisioning and cutover — not just this.`,
    restoreSeconds,
  );

  // ---- 5. is it the same database
  const after = await digest(restored);
  const differences = compare(before, after);
  record(
    'The restored database is the same database',
    differences.length === 0,
    differences.length
      ? `${differences.length} difference(s): ${differences.slice(0, 5).join('; ')}`
      : `Every one of ${Object.keys(before).length} tables matched on row count and on a content hash of its rows — ` +
        `not just counts, which would miss a dropped column or a lost timezone.`,
  );

  // ---- 6. do the safeguards survive
  const guards = await checkGuards(restored);
  record(
    'The safeguards survive the restore',
    guards.every((g) => g.held),
    guards.map((g) => `${g.what}: ${g.held ? 'held' : `LOST — ${g.detail}`}`).join('. ') +
      '. A restored database that accepts an edit to a published version or to an event is an audit hole ' +
      'no row count would show.',
  );

  // ---- 7. job replay against the restored database
  const replayPool = createPool(4, scratchUrl);
  const replayEngine = new Engine(replayPool);

  const count = async (sql: string, params: unknown[] = []): Promise<number> => {
    const { rows } = await replayPool.query<{ count: number }>(sql, params);
    return rows[0]!.count;
  };

  const queued = await count(
    'select count(*)::int as count from outbox where instance_id = any($1::uuid[]) and done_at is null',
    [[pending.instanceId, replayed.instanceId]],
  );
  const pendingBefore = await count('select count(*)::int as count from email_log where instance_id = $1', [
    pending.instanceId,
  ]);
  const replayedBefore = await count('select count(*)::int as count from email_log where instance_id = $1', [
    replayed.instanceId,
  ]);

  // The restored copy is where the held-back row becomes due. In a real
  // recovery this is simply time passing.
  await replayPool.query(
    "update outbox set available_at = now() - interval '1 minute' where instance_id = $1 and done_at is null",
    [pending.instanceId],
  );

  await replayEngine.drain(new Date(), 'drill-replay');

  const pendingAfter = await count('select count(*)::int as count from email_log where instance_id = $1', [
    pending.instanceId,
  ]);
  const replayedAfter = await count('select count(*)::int as count from email_log where instance_id = $1', [
    replayed.instanceId,
  ]);
  const dupes = await count(
    `select count(*)::int as count from (
       select action_run_id from email_log group by action_run_id having count(*) > 1
     ) d`,
  );
  // Scoped to the drill's own records. A tenant can legitimately hold an
  // outbox row that stays undelivered forever — the seeded workspace has a
  // webhook that has exhausted its attempts — and "the queue is empty" is not
  // what a successful replay means. "Everything replayable was replayed" is.
  const stillQueued = await count(
    'select count(*)::int as count from outbox where instance_id = any($1::uuid[]) and done_at is null',
    [[pending.instanceId, replayed.instanceId]],
  );

  // A row the replay could not finish is worth naming, not just counting.
  const { rows: leftovers } = await replayPool.query<{ transition_key: string; attempts: number; last_error: string | null }>(
    `select transition_key, attempts, last_error from outbox
      where instance_id = any($1::uuid[]) and done_at is null`,
    [[pending.instanceId, replayed.instanceId]],
  );
  const leftoverNote = leftovers.length
    ? ` Left undelivered: ${leftovers.map((l) => `${l.transition_key} after ${l.attempts} attempt(s)${l.last_error ? ` — ${l.last_error.slice(0, 60)}` : ''}`).join('; ')}.`
    : '';

  // Both halves have to be true, and a pass with nothing queued is not a pass.
  const ranTheUnfinished = queued > 0 && pendingAfter > pendingBefore;
  const repeatedNothing = replayedAfter === replayedBefore && dupes === 0;

  record(
    'Replaying jobs after a restore finishes the unfinished and repeats nothing else',
    ranTheUnfinished && repeatedNothing && stillQueued === 0,
    `${queued} of the drill's outbox row(s) were undelivered in the backup; ${queued - stillQueued} were completed by the replay. ` +
      `The record that had never been drained went from ${pendingBefore} to ${pendingAfter} message(s) — the work ` +
      `actually ran, rather than the queue being empty and the check being vacuous. ` +
      `The record whose effects had already happened but whose queue rows were marked undelivered — the crash ` +
      `window — stayed at ${replayedAfter} message(s) and produced ${dupes} duplicate(s), because the idempotency ` +
      `ledger was inside the backup too. A restore replays the queue, not the work.${leftoverNote}`,
  );

  // ---- 8. and what it does not know about
  const { rows: survived } = await restored.query<{ count: number }>(
    'select count(*)::int as count from instance where id = $1',
    [afterBackup.instanceId],
  );
  record(
    'The recovery point window is measured, not assumed',
    survived[0]!.count === 0,
    `A record submitted after the backup is absent from the restore, along with the ${sentAfterBackup[0]!.count} ` +
      `message(s) it had already sent. That is the RPO working as designed, and it is worth stating plainly: ` +
      `the window is not only lost data. Those messages reached real inboxes, and the restored system has no ` +
      `memory of having sent them — so it will send them again when the work is redone. Anything with an ` +
      `external effect inside the window happens twice.`,
  );

  // ---- clean up
  await restored.end();
  await replayPool.end();
  await removeDrillTenant(pool, drillTenant);
  await pool.end();
  await admin.query(`drop database "${scratchName}" with (force)`);
  await admin.end();
  await source.end();
  rmSync(workDir, { recursive: true, force: true });

  writeFileSync(
    'docs/recovery-drill.json',
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        target: describeTarget(),
        server: version[0]!.v.split(',')[0],
        tooling: tools.how,
        objectives: { rpoMinutes: RPO_MINUTES, rtoHours: RTO_HOURS },
        measured: { backupSeconds: dumpSeconds, restoreSeconds, backupBytes: dumpBytes, rows: totalRows },
        steps,
      },
      null,
      2,
    ) + '\n',
  );

  report(steps.filter((s) => !s.passed).length);
}

/**
 * Takes the drill's own records back out of the source database.
 *
 * The drill has to write to the real database — a backup of work that is not
 * there proves nothing — so it has to clean up after itself. `event` is
 * append-only by trigger, and the bypass is the same transaction-local setting
 * retention uses: it reverts at commit and is invisible to every other
 * connection. Using the same door rather than a second one means there is
 * still exactly one way to delete history.
 */
async function removeDrillTenant(pool: ReturnType<typeof createPool>, tenantId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local patform.retention_run = 'on'");
    const { rows } = await client.query<{ id: string }>('select id from instance where tenant_id = $1', [tenantId]);
    const ids = rows.map((r) => r.id);
    for (const table of ['email_log', 'webhook_delivery', 'document', 'task', 'approval_request', 'timer', 'outbox']) {
      await client.query(`delete from ${table} where instance_id = any($1::uuid[])`, [ids]);
    }
    await client.query('delete from action_run where instance_id = any($1::uuid[])', [ids]);
    await client.query('delete from event where instance_id = any($1::uuid[])', [ids]);
    await client.query('delete from resume_token where instance_id = any($1::uuid[])', [ids]);
    await client.query('delete from instance where tenant_id = $1', [tenantId]);
    // The published version and the tenant stay. `process_version` is immutable
    // by trigger and that invariant is worth more than a tidy table — so the
    // drill reuses one tenant across runs rather than weakening it to get a
    // clean-up it does not need.
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.log(`  ${YELLOW}Could not remove the drill tenant: ${err instanceof Error ? err.message : err}${OFF}`);
    console.log(`  ${DIM}It is named drill:* and holds only example.test addresses.${OFF}`);
  } finally {
    client.release();
  }
}

/**
 * One tenant, reused across runs.
 *
 * A fresh tenant each time would accumulate published versions, which cannot
 * be deleted — correctly, since immutability is the point. Reusing one keeps
 * the source database from growing a row per drill forever.
 */
async function reuseDrillTenant(pool: ReturnType<typeof createPool>, engine: Engine): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("select id from tenant where name = 'drill:recovery'");
  return rows[0]?.id ?? (await engine.createTenant('drill:recovery'));
}

async function drillVersionFor(
  pool: ReturnType<typeof createPool>,
  engine: Engine,
  tenantId: string,
  bp: Blueprint,
): Promise<VersionRow> {
  const { rows } = await pool.query<VersionRow>(
    `select id, tenant_id, process_key, version, blueprint from process_version
      where tenant_id = $1 and process_key = $2 order by version desc limit 1`,
    [tenantId, bp.key],
  );
  return rows[0] ?? engine.publish(tenantId, bp, 'drill');
}

function inContainer(tools: Tools): boolean {
  return tools.dump[0] === 'docker';
}

/**
 * The connection string as the tool will see it.
 *
 * `127.0.0.1:15432` is the port Docker publishes on the *host*. Run pg_dump
 * inside the container and that address is the container's own loopback, where
 * nothing is listening — so the connection is refused by a machine that is
 * running the database perfectly well. Inside, it is the default port on
 * localhost.
 */
function toolUrl(tools: Tools, url: string): string {
  if (!inContainer(tools)) return url;
  const parsed = new URL(url);
  parsed.hostname = 'localhost';
  parsed.port = '5432';
  return parsed.toString();
}

/**
 * The triggers and constraints that make the audit trustworthy.
 *
 * pg_restore does bring triggers across, so this ought to hold. "Ought to" is
 * the reason to check: these are the controls that would be silently absent
 * after a restore done by hand, or by a tool invoked with --disable-triggers,
 * and nobody would notice until an auditor asked.
 */
async function checkGuards(client: Client): Promise<{ what: string; held: boolean; detail: string }[]> {
  const out: { what: string; held: boolean; detail: string }[] = [];

  const refuses = async (what: string, sql: string): Promise<void> => {
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('rollback');
      out.push({ what, held: false, detail: 'the statement was accepted' });
    } catch (err) {
      await client.query('rollback').catch(() => {});
      out.push({ what, held: true, detail: err instanceof Error ? err.message.slice(0, 60) : '' });
    }
  };

  const { rows: anyVersion } = await client.query<{ count: number }>('select count(*)::int as count from process_version');
  if (anyVersion[0]!.count) {
    await refuses('published versions still immutable', "update process_version set blueprint = '{}'::jsonb");
  }
  const { rows: anyEvent } = await client.query<{ count: number }>('select count(*)::int as count from event');
  if (anyEvent[0]!.count) {
    await refuses('event history still append-only', "update event set payload = '{}'::jsonb");
  }

  const { rows: fks } = await client.query<{ count: number }>(
    "select count(*)::int as count from pg_constraint where contype = 'f'",
  );
  out.push({
    what: `${fks[0]!.count} foreign keys present`,
    held: fks[0]!.count > 0,
    detail: 'none found',
  });

  return out;
}

/** Answers that satisfy every required field, so the drill can create real work. */
function completeFor(bp: Blueprint, email: string): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const f of bp.data.fields) {
    if (f.setBy && f.setBy !== 'respondent') continue;
    if (!f.required) continue;
    switch (f.type) {
      case 'email': answers[f.key] = email; break;
      case 'date': answers[f.key] = '2026-11-02'; break;
      case 'number': case 'currency': case 'rating': answers[f.key] = 1; break;
      case 'yes_no': case 'signature_ack': answers[f.key] = true; break;
      case 'single_choice': case 'dropdown': answers[f.key] = f.choices?.[0]?.value ?? 'other'; break;
      case 'multi_choice': answers[f.key] = [f.choices?.[0]?.value ?? 'other']; break;
      default: answers[f.key] = 'drill';
    }
  }
  return answers;
}

function report(failures: number): void {
  console.log(
    failures
      ? `\n${RED}${failures} of ${steps.length} drill steps failed${OFF}\n`
      : `\n${GREEN}all ${steps.length} drill steps passed${OFF}\n`,
  );
  console.log(`${DIM}Evidence written to docs/recovery-drill.json${OFF}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${RED}${err instanceof Error ? err.message : String(err)}${OFF}\n`);
  process.exit(1);
});
