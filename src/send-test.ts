import { readFileSync } from 'node:fs';
import { Blueprint } from './blueprint/index.js';
import { createPool, describeTarget } from './runtime/db.js';
import { Engine } from './runtime/engine.js';
import { emailProviderFromEnv, mailFrom } from './runtime/email.js';
import type { Principal } from './runtime/policy.js';

/**
 * Drives one onboarding record all the way through, to a real address, using
 * whatever provider the environment names.
 *
 * It exists because everything up to here was proved against a fake provider,
 * and "the delivery path works" is a claim only a real inbox can settle. It
 * takes the recipient as an argument rather than reading one from anywhere,
 * so running it is always a deliberate act.
 */

async function main(): Promise<void> {
  const to = process.argv[2];
  if (!to || !to.includes('@')) {
    console.error('usage: npm run send-test -- someone@example.com');
    process.exit(2);
  }

  const provider = emailProviderFromEnv();
  const pool = createPool(4);
  const engine = new Engine(pool, provider);

  console.log(`\n  database   ${describeTarget()}`);
  console.log(`  provider   ${provider.name}`);
  console.log(`  from       ${mailFrom('People Team')}`);
  console.log(`  to         ${to}\n`);

  if (provider.name === 'console') {
    console.log('  EMAIL_PROVIDER is not set, so nothing will actually be sent.\n');
  }

  const bp = Blueprint.parse(
    JSON.parse(readFileSync('processes/employee-onboarding.blueprint.json', 'utf8')),
  );

  const tenantId = await engine.createTenant(`send-test ${new Date().toISOString()}`);
  const version = await engine.publish(tenantId, bp, 'send-test');

  const manager = await engine.createActor(tenantId, 'manager@patform.test', 'Priya Raman', 'approver');
  await engine.grant({ tenantId, actorId: manager, processKey: bp.key, roleKey: 'hiring_manager' });
  const hr = await engine.createActor(tenantId, 'hr@patform.test', 'Sam Boateng', 'approver');
  await engine.grant({ tenantId, actorId: hr, processKey: bp.key, roleKey: 'hr_approver' });
  const it = await engine.createActor(tenantId, 'it@patform.test', 'Ini Etim', 'operator');
  await engine.grant({ tenantId, actorId: it, processKey: bp.key, roleKey: 'it_operator' });

  const as = (actorId: string): Principal => ({ kind: 'actor', tenantId, actorId });
  const now = new Date();

  // The manager's address has to be the recipient's too, or the approval would
  // name somebody who cannot be reached.
  const { instanceId } = await engine.submit({
    version,
    answers: {
      full_name: 'Test Starter',
      preferred_name: 'Test',
      personal_email: to,
      phone: '+44 7700 900100',
      address: '1 Example Street, London',
      start_date: '2026-11-02',
      department: 'operations',
      job_title: 'Operations Analyst',
      employment_type: 'employee',
      manager_email: 'manager@patform.test',
      emergency_contact_name: 'A Contact',
      emergency_contact_phone: '+44 7700 900999',
      national_id: 'QQ123456C',
      bank_account: '12-34-56 / 12345678',
      id_document: 'right-to-work.pdf',
      equipment_needs: ['laptop', 'monitor'],
      policy_ack: true,
    },
    now,
  });
  await engine.drain(now, 'proof', tenantId);
  console.log(`  submitted  ${instanceId.slice(0, 8).toUpperCase()}`);

  await engine.decide({
    instanceId,
    approvalKey: 'manager_approval',
    decision: 'approved',
    principal: as(manager),
    reason: 'Confirmed headcount.',
    now,
  });
  await engine.drain(now, 'proof', tenantId);

  await engine.decide({
    instanceId,
    approvalKey: 'hr_approval',
    decision: 'approved',
    principal: as(hr),
    reason: 'Right to work verified.',
    now,
  });
  await engine.drain(now, 'proof', tenantId);

  await engine.completeTask({ instanceId, taskKey: 'issue_equipment', principal: as(it), now });
  await engine.drain(now, 'proof', tenantId);
  await engine.completeTask({ instanceId, taskKey: 'create_accounts', principal: as(it), now });
  await engine.drain(now, 'proof', tenantId);

  const { rows: docs } = await pool.query<{ filename: string; byte_size: number; checksum: string }>(
    'select filename, byte_size, checksum from document where instance_id = $1',
    [instanceId],
  );
  const { rows: sent } = await pool.query<{
    template_key: string;
    recipients: string[];
    status: string;
    provider_message_id: string | null;
    failure: string | null;
  }>(
    `select template_key, recipients, status, provider_message_id, failure
       from email_log where instance_id = $1 order by id`,
    [instanceId],
  );

  console.log(`  state      ${(await engine.instance(instanceId)).state}\n`);
  console.log('  Documents');
  for (const d of docs) {
    console.log(`    ${d.filename}  ${d.byte_size} bytes  ${d.checksum.slice(0, 12)}`);
  }
  console.log('\n  Delivery log');
  for (const e of sent) {
    const mark = e.status === 'failed' ? 'FAILED ' : e.status.padEnd(7);
    console.log(`    ${mark} ${e.template_key.padEnd(20)} -> ${e.recipients.join(', ')}`);
    if (e.provider_message_id) console.log(`            ${e.provider_message_id}`);
    if (e.failure) console.log(`            ${e.failure}`);
  }
  console.log('');

  await pool.end();
  process.exit(sent.some((e) => e.status === 'failed') ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
