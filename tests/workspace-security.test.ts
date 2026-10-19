import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Blueprint } from '../src/blueprint/index.js';
import { createPool } from '../src/runtime/db.js';
import { Engine, appendEventLocked } from '../src/runtime/engine.js';
import { needsWorkspace, resolveSession, setPassword, signIn, startSession } from '../src/runtime/auth.js';
import { listMembers, revokeMemberSessions } from '../src/runtime/workspace.js';
import { InvalidInput } from '../src/runtime/errors.js';

// The four findings of docs/prd-audit-module-1-2026-10-19.md, each pinned so
// it cannot come back. These need a database, like the scenario tests.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test('an administrator cannot sign out a member of another workspace', { skip: !localDatabase }, async () => {
  const pool = createPool();
  try {
    const engine = new Engine(pool);
    const tenantA = await engine.createTenant(`revoke-a-${stamp()}`, { scenario: true });
    const tenantB = await engine.createTenant(`revoke-b-${stamp()}`, { scenario: true });
    const adminA = await engine.createActor(tenantA, 'admin@a.test', 'Admin A', 'admin');
    const memberB = await engine.createActor(tenantB, 'member@b.test', 'Member B', 'operator');
    const memberA = await engine.createActor(tenantA, 'member@a.test', 'Member A', 'operator');
    const sessionB = (await startSession(pool, { actorId: memberB }))!;
    const sessionA = (await startSession(pool, { actorId: memberA }))!;

    // Across tenants: refused as if the member did not exist, and the session lives on.
    await assert.rejects(
      revokeMemberSessions(pool, { principal: { kind: 'actor', tenantId: tenantA, actorId: adminA }, actorId: memberB }),
      InvalidInput,
    );
    assert.ok(await resolveSession(pool, sessionB.token), 'the other tenant\'s session must survive');

    // Within the tenant: the same call signs the member out everywhere.
    const done = await revokeMemberSessions(pool, { principal: { kind: 'actor', tenantId: tenantA, actorId: adminA }, actorId: memberA });
    assert.equal(done.revoked, 1);
    assert.equal(await resolveSession(pool, sessionA.token), null);

    // And it still takes `administer`.
    await assert.rejects(
      revokeMemberSessions(pool, { principal: { kind: 'actor', tenantId: tenantA, actorId: memberA }, actorId: adminA }),
      /administer/,
    );
  } finally { await pool.end(); }
});

test('one email in two workspaces signs in by password, and asks when both fit', { skip: !localDatabase }, async () => {
  const pool = createPool();
  try {
    const engine = new Engine(pool);
    const email = `shared-${stamp()}@example.test`;
    const tenantA = await engine.createTenant(`Alpha ${stamp()}`, { scenario: true });
    const tenantB = await engine.createTenant(`Beta ${stamp()}`, { scenario: true });
    const inA = await engine.createActor(tenantA, email, 'In A', 'operator');
    const inB = await engine.createActor(tenantB, email, 'In B', 'operator');
    await setPassword(pool, inA, 'password-for-alpha-1');
    await setPassword(pool, inB, 'password-for-beta-22');

    // Different passwords: the password picks the workspace, whatever the row order.
    const a = await signIn(pool, { email, password: 'password-for-alpha-1' });
    assert.ok(a && !needsWorkspace(a) && 'actor' in a && a.actor.tenantId === tenantA);
    const b = await signIn(pool, { email, password: 'password-for-beta-22' });
    assert.ok(b && !needsWorkspace(b) && 'actor' in b && b.actor.tenantId === tenantB);
    assert.equal(await signIn(pool, { email, password: 'neither-of-those' }), null);

    // The same password in both: no session until a workspace is named.
    await setPassword(pool, inB, 'password-for-alpha-1');
    const both = await signIn(pool, { email, password: 'password-for-alpha-1' });
    assert.ok(both && needsWorkspace(both));
    assert.deepEqual(both.chooseWorkspace.map((w) => w.tenantId).sort(), [tenantA, tenantB].sort());
    const chosen = await signIn(pool, { email, password: 'password-for-alpha-1', tenantId: tenantB });
    assert.ok(chosen && !needsWorkspace(chosen) && 'actor' in chosen && chosen.actor.tenantId === tenantB);

    // Naming a workspace the password does not open is a plain failure, not a hint.
    await setPassword(pool, inB, 'password-for-beta-22');
    assert.equal(await signIn(pool, { email, password: 'password-for-alpha-1', tenantId: tenantB }), null);
  } finally { await pool.end(); }
});

test('only administrators see device counts and last activity in the member list', { skip: !localDatabase }, async () => {
  const pool = createPool();
  try {
    const engine = new Engine(pool);
    const tenantId = await engine.createTenant(`members-${stamp()}`, { scenario: true });
    const admin = await engine.createActor(tenantId, 'admin@m.test', 'Admin', 'admin');
    const reader = await engine.createActor(tenantId, 'reader@m.test', 'Reader', 'read_only');
    await startSession(pool, { actorId: admin });

    const seenByAdmin = await listMembers(pool, { kind: 'actor', tenantId, actorId: admin });
    const adminRow = seenByAdmin.find((m) => m.id === admin)!;
    assert.equal(adminRow.sessions, 1);
    assert.ok(adminRow.last_seen_at);

    const seenByReader = await listMembers(pool, { kind: 'actor', tenantId, actorId: reader });
    assert.equal(seenByReader.length, 2, 'everyone still sees who works here');
    for (const m of seenByReader) {
      assert.equal(m.sessions, null);
      assert.equal(m.last_seen_at, null);
      assert.equal(m.external_id, null);
      assert.equal(m.identities, null);
      assert.ok(m.email && m.display_name && m.workspace_role);
    }
  } finally { await pool.end(); }
});

test('concurrent record history writes never collide on seq', { skip: !localDatabase }, async () => {
  const bp = Blueprint.parse(JSON.parse(readFileSync('processes/expense-approval.blueprint.json', 'utf8')));
  const submit = bp.tests[0]!.steps.find((step) => step.step === 'submit')!;
  if (submit.step !== 'submit') throw new Error('expected a submit step');
  const pool = createPool();
  try {
    const engine = new Engine(pool);
    const tenantId = await engine.createTenant(`seq-${stamp()}`, { scenario: true });
    const version = await engine.publish(tenantId, bp, 'test');
    const { instanceId } = await engine.submit({ version, answers: submit.answers, now: new Date('2026-10-19T09:00:00Z') });

    // Twenty notes and exports at once. Before the lock this was a coin toss
    // on the (instance_id, seq) unique index.
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendEventLocked(pool, {
      tenantId, instanceId, type: 'record_note_added', payload: { text: `note ${i}` }, actor: 'actor:test', now: new Date(),
    })));
    const { rows } = await pool.query<{ seq: number; n: string }>(
      'select seq, count(*) as n from event where instance_id = $1 group by seq having count(*) > 1', [instanceId],
    );
    assert.deepEqual(rows, []);
    const { rows: notes } = await pool.query<{ n: string }>(
      "select count(*) as n from event where instance_id = $1 and type = 'record_note_added'", [instanceId],
    );
    assert.equal(Number(notes[0]!.n), 20);

    // A record in another tenant cannot be written to by naming its id.
    const other = await engine.createTenant(`seq-other-${stamp()}`, { scenario: true });
    await assert.rejects(
      appendEventLocked(pool, { tenantId: other, instanceId, type: 'record_note_added', payload: {}, actor: 'actor:test', now: new Date() }),
      /no such record/,
    );
  } finally { await pool.end(); }
});
