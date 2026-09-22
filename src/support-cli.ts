import { createPool, describeTarget } from './runtime/db.js';
import { traceByRequest, traceForInstance, type TraceStep } from './runtime/support.js';
import { suppressDelivery } from './runtime/email.js';
import type { Principal } from './runtime/policy.js';

/**
 * The support view, on a terminal.
 *
 * §20.2 supportability asks that support diagnose a failed instance without
 * direct database modification. A console page is the answer for an operator;
 * this is the answer for whoever is on call at 2am with an ssh session and a
 * reference number, and it reads the same data through the same permission
 * checks rather than a convenient side door.
 *
 * It takes a principal, so what it shows is what that person may see. A
 * support tool that bypasses authorization is a psql prompt with better
 * formatting.
 */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

function usage(): never {
  console.error(`usage: npm run support -- <record-id | req_...> --as <actor-id>

  A record id traces one record end to end.
  A request id traces everything one call caused, across every record.

  --as is required: the trace is shown as that person sees it.`);
  process.exit(2);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function printStep(step: TraceStep): void {
  const when = step.occurredAt.replace('T', ' ').slice(0, 19);
  console.log(`\n  ${BOLD}${String(step.seq).padStart(2)}. ${step.type}${OFF}  ${DIM}${when}  event ${step.eventId}${OFF}`);
  console.log(`      ${DIM}request ${step.requestId}${step.actor ? `  by ${step.actor}` : ''}${OFF}`);

  if (step.job) {
    const j = step.job;
    const state = j.doneAt ? `${GREEN}done${OFF}` : j.lastError ? `${RED}failing${OFF}` : `${YELLOW}queued${OFF}`;
    console.log(`      job ${j.id} ${j.transitionKey} - ${state} after ${j.attempts} attempt(s)${j.claimedBy ? `, last claimed by ${j.claimedBy}` : ''}`);
    if (j.lastError) console.log(`      ${RED}${j.lastError}${OFF}`);
    if (!j.doneAt) console.log(`      ${DIM}next attempt at ${j.availableAt.replace('T', ' ').slice(0, 19)}${OFF}`);
  }

  for (const a of step.actions) {
    const mark = a.status === 'done' ? `${GREEN}done${OFF}` : `${RED}${a.status}${OFF}`;
    console.log(`      run ${a.id} ${a.action} - ${mark}, ${a.attempts} attempt(s)${a.performedBy ? ` by ${a.performedBy}` : ''}`);
    console.log(`      ${DIM}key ${a.idempotencyKey}${OFF}`);
    if (a.result) console.log(`      ${DIM}${a.result}${OFF}`);
    if (a.lastError) console.log(`      ${RED}${a.lastError}${OFF}`);
  }
}

async function main(): Promise<void> {
  // Read-only, but it constructs an Engine-shaped world; nothing here should
  // be able to send anything.
  suppressDelivery('the support view is read-only');

  const target = process.argv[2];
  const actorId = flag('as');
  if (!target || target.startsWith('--') || !actorId) usage();

  const pool = createPool(4);
  const { rows } = await pool.query<{ tenant_id: string; display_name: string; workspace_role: string }>(
    'select tenant_id, display_name, workspace_role from actor where id = $1',
    [actorId],
  );
  if (!rows[0]) {
    console.error(`\n  No actor ${actorId}.\n`);
    process.exit(2);
  }
  const principal: Principal = { kind: 'actor', tenantId: rows[0].tenant_id, actorId };

  console.log(`\n${BOLD}Support trace${OFF} ${DIM}- ${describeTarget()}${OFF}`);
  console.log(`${DIM}as ${rows[0].display_name} (${rows[0].workspace_role}) - you see what they see${OFF}`);

  /*
   * A record id is a UUID; anything else is a request id.
   *
   * Matching on a `req_` prefix looked fine and was wrong: §11.1 lets a client
   * send its own correlation id, so the ids support is handed most often are
   * the ones the customer's system chose. Shape is the only reliable test.
   */
  const isRecordId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);

  if (!isRecordId) {
    const trace = await traceByRequest(pool, { principal, requestId: target });
    if (!trace.records.length) {
      console.log(`\n  ${YELLOW}Nothing in this workspace was caused by ${target}.${OFF}`);
      console.log(`  ${DIM}Either the id is wrong, or it belongs to another workspace.${OFF}\n`);
    }
    for (const record of trace.records) {
      console.log(`\n${BOLD}${record.reference}${OFF} ${DIM}${record.instanceId}${OFF}`);
      record.steps.forEach(printStep);
    }
  } else {
    const trace = await traceForInstance(pool, { principal, instanceId: target });
    console.log(`\n${BOLD}${trace.reference}${OFF}  ${trace.processKey}  ${DIM}${trace.instanceId}${OFF}`);
    console.log(`${DIM}${trace.stateName}${trace.outcome ? ` - ${trace.outcome}` : ''}, opened ${trace.createdAt.slice(0, 10)}${OFF}`);
    console.log(`\n  ${BOLD}${trace.diagnosis}${OFF}`);
    trace.steps.forEach(printStep);

    if (trace.stuck.length) {
      console.log(`\n  ${YELLOW}${trace.stuck.length} job(s) still waiting.${OFF}`);
      console.log(`  ${DIM}Replay from the console once the cause is fixed; the idempotency keys stop anything running twice.${OFF}`);
    }
  }

  console.log('');
  await pool.end();
}

main().catch((err) => {
  console.error(`\n${RED}${err instanceof Error ? err.message : String(err)}${OFF}\n`);
  process.exit(1);
});
