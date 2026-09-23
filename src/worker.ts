import { applyUpgrades, createPool, describeTarget } from './runtime/db.js';
import { deliverBatch } from './runtime/webhooks.js';
import { Engine, newWorkerId } from './runtime/engine.js';
import { sweepExpiredTokens } from './runtime/retention.js';
import { sweepHeld } from './runtime/held.js';
import { checkSendingHealth } from './runtime/delivery-health.js';

/**
 * The durable worker §10.1 asks for: "Queue-backed workers for email,
 * documents, webhooks, AI jobs, scans, imports, and exports."
 *
 * Until this existed, the outbox was only drained when an API request happened
 * to do it, and `fireDueTimers` was only called by tests. In other words every
 * reminder, every SLA escalation and every "close this after fourteen days"
 * would simply never fire in production — the timer rows would sit in the
 * table, due, forever. A process whose deadlines depend on somebody opening
 * the console is not a process.
 *
 * Several of these can run at once. The claim statements use FOR UPDATE SKIP
 * LOCKED, so workers share the queue without coordinating (ADR-0002).
 */

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1000);
const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? 5000);
const BATCH = Number(process.env.WORKER_BATCH ?? 25);
/** Housekeeping is cheap and rare; once a minute is plenty. */
const SWEEP_EVERY_MS = 60_000;

async function main(): Promise<void> {
  const pool = createPool(8);
  await applyUpgrades(pool);
  const engine = new Engine(pool);
  const id = newWorkerId();

  let running = true;
  let lastSweep = 0;
  const totals = { actions: 0, timers: 0, webhooks: 0, errors: 0 };

  const stop = (signal: string) => {
    if (!running) return;
    running = false;
    console.log(`\n  ${signal} — finishing the current batch, then stopping.`);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  console.log(`\n  Patform worker  ${id}`);
  console.log(`  database        ${describeTarget()}`);
  console.log(`  polling         every ${POLL_MS}ms busy, ${IDLE_MS}ms idle, ${BATCH} per batch\n`);

  while (running) {
    const now = new Date();
    let did = 0;

    try {
      did += await engine.runOutbox(id, now, BATCH);
      totals.actions += did;

      const fired = await engine.fireDueTimers(now, BATCH);
      totals.timers += fired;
      did += fired;

      // §11.2's delivery. Same loop as the outbox rather than a second
      // process: a webhook that only leaves when somebody opens a page is the
      // fault the worker was built to fix, one layer along.
      const hooks = await deliverBatch(pool, { workerId: id, batch: BATCH, now });
      totals.webhooks += hooks.delivered;
      did += hooks.claimed;
      if (hooks.deadLettered) {
        console.log(`  ${now.toISOString()}  ${hooks.deadLettered} webhook(s) gave up and went to the dead letter`);
      }

      if (fired) console.log(`  ${now.toISOString()}  fired ${fired} timer(s)`);

      if (now.getTime() - lastSweep > SWEEP_EVERY_MS) {
        const swept = await sweepExpiredTokens(pool);
        const held = await sweepHeld(pool);
        lastSweep = now.getTime();
        if (swept) console.log(`  ${now.toISOString()}  swept ${swept} expired token(s)`);
        if (held) console.log(`  ${now.toISOString()}  deleted ${held} held submission(s) past thirty days`);

        // The rate the provider judges the account by. Quiet unless it
        // crosses a threshold or recovers; see delivery-health.ts.
        const sending = await checkSendingHealth(pool, now);
        if (sending.change) {
          const h = sending.health;
          console.log(
            `  ${now.toISOString()}  sending health ${sending.change}: ${h.level} — ` +
              `${h.bounced} hard bounce(s), ${h.complained} complaint(s) in ${h.sent} sent over ${h.windowDays} days` +
              (process.env.OPS_ALERT_EMAIL ? '' : ' (OPS_ALERT_EMAIL is not set, so nobody was emailed)'),
          );
        }
      }
    } catch (err) {
      // A worker that dies on one bad row stops every process in the
      // workspace. Log it, back off, keep going — the row itself already
      // carries its own error and retry schedule.
      totals.errors++;
      console.error(`  ${new Date().toISOString()}  worker error:`, err instanceof Error ? err.message : err);
      await sleep(IDLE_MS);
      continue;
    }

    // Busy-poll while there is work, back off when there is not.
    await sleep(did ? POLL_MS : IDLE_MS);
  }

  console.log(
    `\n  Stopped. ${totals.actions} action(s) delivered, ${totals.timers} timer(s) fired, ${totals.errors} error(s).\n`,
  );
  await pool.end();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
