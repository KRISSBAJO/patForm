import { readFileSync } from 'node:fs';
import { Blueprint } from './blueprint/index.js';
import { createPool, describeTarget, resetSchema } from './runtime/db.js';
import { Engine } from './runtime/engine.js';
import type { Principal } from './runtime/policy.js';
import { setPassword } from './runtime/auth.js';
import { suppressDelivery } from './runtime/email.js';

/** Every seeded account gets this. It only ever exists in a local database. */
const DEV_PASSWORD = 'patform-dev-password';

/**
 * Fills a local database with a workspace that looks like a Tuesday: records
 * at every stage, one approval that is late, one automation that failed, and
 * people with different roles so the console can be looked at from more than
 * one seat.
 *
 * An empty console proves nothing, and a console where everything is green
 * proves less.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

const PEOPLE = [
  { key: 'joy', email: 'joy@example.test', name: 'Joy Adeleke', role: 'hr_admin', workspace: 'admin' },
  { key: 'priya', email: 'priya@example.test', name: 'Priya Raman', role: 'hiring_manager', workspace: 'approver' },
  { key: 'sam', email: 'sam@example.test', name: 'Sam Boateng', role: 'hr_approver', workspace: 'approver' },
  { key: 'ini', email: 'ini@example.test', name: 'Ini Etim', role: 'it_operator', workspace: 'operator' },
  { key: 'dana', email: 'dana@example.test', name: 'Dana Whitlock', role: 'hiring_manager', workspace: 'read_only' },
] as const;

const HIRES = [
  { name: 'Amara Okafor', title: 'Backend Engineer', dept: 'engineering', daysAgo: 5, reach: 'hr' },
  { name: 'Daniel Wu', title: 'Product Designer', dept: 'engineering', daysAgo: 9, reach: 'manager' },
  { name: 'Rachel Osei', title: 'Finance Analyst', dept: 'finance', daysAgo: 3, reach: 'provisioning' },
  { name: 'Tomi Balogun', title: 'Support Engineer', dept: 'operations', daysAgo: 2, reach: 'provisioning' },
  { name: 'Lena Fischer', title: 'Operations Lead', dept: 'operations', daysAgo: 14, reach: 'complete' },
  { name: 'Marcus Bell', title: 'Data Analyst', dept: 'finance', daysAgo: 11, reach: 'rejected' },
  { name: 'Yusuf Adeyemi', title: 'Platform Engineer', dept: 'engineering', daysAgo: 1, reach: 'manager' },
] as const;

function answersFor(hire: (typeof HIRES)[number], index: number) {
  return {
    full_name: hire.name,
    preferred_name: hire.name.split(' ')[0],
    personal_email: `${hire.name.split(' ')[0]!.toLowerCase()}.${index}@example.test`,
    phone: '+44 7700 900100',
    address: '1 Example Street, London',
    start_date: '2026-11-02',
    department: hire.dept,
    job_title: hire.title,
    employment_type: 'employee',
    manager_email: 'priya@example.test',
    emergency_contact_name: 'A. Contact',
    emergency_contact_phone: '+44 7700 900999',
    national_id: 'QQ123456C',
    bank_account: '12-34-56 / 12345678',
    id_document: 'right-to-work.pdf',
    equipment_needs: ['laptop', 'monitor'],
    policy_ack: true,
  };
}

async function main(): Promise<void> {
  suppressDelivery('seeding fabricates records for example.test addresses');
  const pool = createPool(8);
  const engine = new Engine(pool);

  console.log(`\n  Seeding ${describeTarget()}`);
  await resetSchema(pool);

  const tenantId = await engine.createTenant('Northwind Operations');
  const bp = Blueprint.parse(
    JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json', 'utf8')),
  );
  const version = await engine.publish(tenantId, bp, 'seed');

  const actors = new Map<string, { id: string; principal: Principal }>();
  for (const person of PEOPLE) {
    const id = await engine.createActor(tenantId, person.email, person.name, person.workspace);
    await engine.grant({ tenantId, actorId: id, processKey: bp.key, roleKey: person.role });
    await setPassword(pool, id, DEV_PASSWORD);
    actors.set(person.key, { id, principal: { kind: 'actor', tenantId, actorId: id } });
  }

  const now = Date.now();
  let late = 0;

  for (const [index, hire] of HIRES.entries()) {
    const submittedAt = new Date(now - hire.daysAgo * DAY);
    const { instanceId } = await engine.submit({
      version,
      answers: answersFor(hire, index),
      now: submittedAt,
    });
    await engine.drain(submittedAt);

    if (hire.reach === 'manager') {
      // Left with the manager. Daniel is nine days in, which is late.
      if (hire.daysAgo > 5) late++;
      continue;
    }

    const managerAt = new Date(submittedAt.getTime() + 6 * HOUR);
    await engine.decide({
      instanceId,
      approvalKey: 'manager_approval',
      decision: hire.reach === 'rejected' ? 'rejected' : 'approved',
      principal: actors.get('priya')!.principal,
      reason: hire.reach === 'rejected' ? 'Role was withdrawn.' : 'Confirmed headcount.',
      now: managerAt,
    });
    await engine.drain(managerAt);
    if (hire.reach === 'rejected') continue;
    if (hire.reach === 'hr') continue;

    const hrAt = new Date(managerAt.getTime() + 4 * HOUR);
    await engine.decide({
      instanceId,
      approvalKey: 'hr_approval',
      decision: 'approved',
      principal: actors.get('sam')!.principal,
      reason: 'Right to work verified.',
      now: hrAt,
    });
    await engine.drain(hrAt);
    if (hire.reach === 'provisioning') continue;

    const itAt = new Date(hrAt.getTime() + 20 * HOUR);
    await engine.completeTask({ instanceId, taskKey: 'issue_equipment', principal: actors.get('ini')!.principal, now: itAt });
    await engine.drain(itAt);
    await engine.completeTask({ instanceId, taskKey: 'create_accounts', principal: actors.get('ini')!.principal, now: itAt });
    await engine.drain(itAt);
  }

  // One automation that genuinely failed, so the health panel has something
  // real to show and the replay button has something to do.
  const { rows: failed } = await pool.query<{ id: number }>(
    `update outbox
        set done_at = null,
            last_error = 'HRIS rejected the webhook: 401 Unauthorized',
            attempts = 4,
            available_at = now() + interval '5 minutes'
      where id = (
        select o.id from outbox o
          join instance i on i.id = o.instance_id
         where i.process_key = $1 and o.transition_key = 'submit'
         order by o.id desc limit 1
      )
      returning id`,
    [bp.key],
  );

  const { rows: counts } = await pool.query<{ instances: number; emails: number; tasks: number }>(
    `select (select count(*)::int from instance)   as instances,
            (select count(*)::int from email_log)  as emails,
            (select count(*)::int from task where status = 'open') as tasks`,
  );

  console.log(`\n  Workspace   Northwind Operations`);
  console.log(`  Process     ${bp.name} v${version.version}`);
  console.log(`  Records     ${counts[0]!.instances} (${late} late)`);
  console.log(`  Emails      ${counts[0]!.emails} sent`);
  console.log(`  Open tasks  ${counts[0]!.tasks}`);
  console.log(`  Failures    ${failed.length}\n`);
  console.log(`  Sign in at /console with any of these. Password: ${DEV_PASSWORD}`);

  for (const person of PEOPLE) {
    console.log(`    ${person.email.padEnd(22)} ${person.name.padEnd(16)} ${person.role} / ${person.workspace}`);
  }
  console.log('');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
