import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { importDirectory } from '../src/runtime/directory-import.js';
import { orgChart, setManager } from '../src/runtime/org.js';
import { acceptInvitation, invite } from '../src/runtime/workspace.js';
import { workspaceAudit } from '../src/runtime/authority.js';
import type { Principal } from '../src/runtime/policy.js';

// PRD ORG-09: a directory from a spreadsheet, checked row by row, saved only when clean.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function workspace(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`import-${stamp()}`, { scenario: true });
  const adminId = await engine.createActor(tenantId, `admin-${stamp()}@import.test`, 'Ada Admin', 'admin');
  await pool.query('update actor set email_verified_at = now() where id = $1', [adminId]);
  return { tenantId, adminId, admin: { kind: 'actor', tenantId, actorId: adminId } as Principal };
}
const s = stamp();
const e = (name: string) => `${name}-${s}@import.test`;

test('a clean file is checked, then saved: people, nested units, entities, titles and managers', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    const rows = [
      { email: e('ceo'), name: 'Chidi Ceo', role: 'approver', unit: 'Head office', title: 'Chief executive', entity: 'Alpha Ltd' },
      { email: e('ops'), name: 'Ola Ops', unit: 'Operations', manager: e('ceo'), title: 'Head of operations', entity: 'Alpha Ltd' },
      { email: e('lagos'), name: 'Lara Lagos', unit: 'Operations > Lagos', manager: e('ops'), title: 'Branch lead' },
      { email: e('driver').toUpperCase(), name: 'Dayo Driver', unit: 'Operations / Lagos / Fleet', manager: e('lagos'), title: 'Driver' },
      { email: e('fin'), name: 'Fola Finance', role: 'operator', unit: 'Finance', manager: e('ceo') },
    ];

    // Check first: nothing is saved.
    const check = await importDirectory(pool, w.admin, { rows, dryRun: true });
    assert.equal(check.applied, false);
    assert.equal(check.summary.errors, 0, JSON.stringify(check.rows.filter((r) => r.errors.length)));
    assert.equal(check.summary.create, 5);
    assert.deepEqual(check.summary.unitsToCreate.sort(), ['Finance', 'Head office', 'Operations', 'Operations > Lagos', 'Operations > Lagos > Fleet']);
    assert.deepEqual(check.summary.entitiesToCreate, ['Alpha Ltd']);
    assert.equal((await orgChart(pool, w.admin)).people.length, 1, 'a check saves nothing');
    assert.ok(!('_ctx' in check), 'internal state never leaves the server');

    // Save.
    const done = await importDirectory(pool, w.admin, { rows, dryRun: false });
    assert.equal(done.applied, true);
    const chart = await orgChart(pool, w.admin);
    const person = (email: string) => chart.people.find((p) => p.email === email)!;
    assert.equal(chart.people.length, 6);
    assert.equal(person(e('driver')).manager!.email, e('lagos'), 'emails are matched without regard to case');
    assert.equal(person(e('lagos')).manager!.email, e('ops'));
    assert.equal(person(e('ops')).position_title, 'Head of operations');
    const fleet = chart.units.find((u) => u.name === 'Fleet')!;
    const lagos = chart.units.find((u) => u.id === fleet.parent_id)!;
    assert.equal(lagos.name, 'Lagos');
    assert.equal(chart.units.find((u) => u.id === lagos.parent_id)!.name, 'Operations');
    assert.equal(person(e('driver')).org_unit_id, fleet.id);
    assert.ok(chart.entities.some((x) => x.name === 'Alpha Ltd'));
    const { rows: roles } = await pool.query<{ email: string; workspace_role: string; provisioned_by: string }>(
      'select email, workspace_role, provisioned_by from actor where tenant_id = $1 and provisioned_by = $2', [w.tenantId, 'import']);
    assert.equal(roles.length, 5);
    assert.equal(roles.find((r) => r.email === e('fin'))!.workspace_role, 'operator');
    assert.equal(roles.find((r) => r.email === e('ops'))!.workspace_role, 'read_only', 'no role given means read only');
    assert.ok((await workspaceAudit(pool, w.admin)).some((r: { action: string }) => r.action === 'directory.imported'));

    // The same file again changes nothing.
    const again = await importDirectory(pool, w.admin, { rows, dryRun: true });
    assert.equal(again.summary.unchanged, 5);
    assert.equal(again.summary.unitsToCreate.length, 0);

    // An update: new title and a new manager; a role in the file is ignored for existing people.
    const upd = await importDirectory(pool, w.admin, { rows: [{ email: e('lagos'), unit: 'Lagos', title: 'Branch manager', manager: e('ceo'), role: 'owner' }], dryRun: false });
    assert.equal(upd.rows[0]!.action, 'update');
    assert.ok(upd.rows[0]!.warnings.some((x) => x.includes("never changes an existing member's role")));
    const after = (await orgChart(pool, w.admin)).people.find((p) => p.email === e('lagos'))!;
    assert.equal(after.position_title, 'Branch manager');
    assert.equal(after.manager!.email, e('ceo'));
    const { rows: still } = await pool.query<{ workspace_role: string }>('select workspace_role from actor where tenant_id = $1 and email = $2', [w.tenantId, e('lagos')]);
    assert.equal(still[0]!.workspace_role, 'read_only');
  } finally { await pool.end(); }
});

test('a file with any bad row is refused whole, and every problem is named on its row', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    const boss = await engine.createActor(w.tenantId, e('boss'), 'Bo Boss', 'approver');
    const deputy = await engine.createActor(w.tenantId, e('deputy'), 'Dee Deputy', 'approver');
    await setManager(pool, w.admin, deputy, { managerId: boss });
    const gone = await engine.createActor(w.tenantId, e('gone'), 'Gone Person', 'read_only');
    await engine.deactivateActor(gone);
    const gone2 = await engine.createActor(w.tenantId, e('gone2'), 'Long Gone', 'read_only');
    await engine.deactivateActor(gone2);
    // Two units called Sales, neither at the top: "Sales" alone is ambiguous.
    await pool.query("insert into org_unit (tenant_id, name) values ($1, 'Retail'), ($1, 'Group')", [w.tenantId]);
    for (const parent of ['Retail', 'Group']) {
      const id = (await pool.query<{ id: string }>('select id from org_unit where tenant_id = $1 and name = $2', [w.tenantId, parent])).rows[0]!.id;
      await pool.query("insert into org_unit (tenant_id, name, parent_id) values ($1, 'Sales', $2)", [w.tenantId, id]);
    }

    const rows = [
      { email: 'not-an-email', name: 'X' },                                   // 2
      { email: e('a'), name: 'Amy', manager: e('a') },                         // 3 self
      { email: e('b'), name: 'Ben', manager: e('nobody') },                    // 4 unknown manager
      { email: e('c'), name: 'Cal', manager: e('d') },                         // 5 loop c→d→c
      { email: e('d'), name: 'Dan', manager: e('c') },                         // 6
      { email: e('c'), name: 'Cal again' },                                    // 7 duplicate
      { email: e('gone'), name: 'Gone Person' },                               // 8 deactivated
      { email: e('new') },                                                     // 9 no name
      { email: e('boss'), manager: e('deputy') },                              // 10 loop through an existing line
      { email: e('s'), name: 'Sam', unit: 'Sales' },                           // 11 ambiguous unit
      { email: e('o'), name: 'Oz', role: 'emperor' },                          // 12 no such role
      { email: e('g'), name: 'Gil', manager: e('gone2') },                     // 13 deactivated manager
      { email: e('fine'), name: 'Fine Person' },                               // 14 fine on its own
    ];
    const check = await importDirectory(pool, w.admin, { rows, dryRun: true });
    const errs = (row: number) => check.rows.find((r) => r.row === row)!.errors.join(' | ');
    assert.match(errs(2), /not an email/);
    assert.match(errs(3), /own manager/);
    assert.match(errs(4), /neither in this file nor in the workspace/);
    assert.match(errs(5), /reporting loop/);
    assert.match(errs(7), /also on row 5/);
    assert.match(errs(8), /deactivated/);
    assert.match(errs(9), /needs a name/);
    assert.match(errs(10), /reporting loop/);
    assert.match(errs(11), /2 units called "Sales"/);
    assert.match(errs(12), /role "emperor" is not one of/);
    assert.match(errs(13), /manager .* is deactivated/);
    assert.equal(errs(14), '');

    // The real run saves nothing while any row is wrong.
    const before = (await orgChart(pool, w.admin)).people.length;
    const refused = await importDirectory(pool, w.admin, { rows, dryRun: false });
    assert.equal(refused.applied, false);
    assert.equal((await orgChart(pool, w.admin)).people.length, before);

    // The same limits as an invitation: a builder cannot hand out admin.
    const builder = await engine.createActor(w.tenantId, e('builder'), 'Bea Builder', 'builder');
    const asBuilder = await importDirectory(pool, { kind: 'actor', tenantId: w.tenantId, actorId: builder }, { rows: [{ email: e('o2'), name: 'Oz', role: 'admin' }], dryRun: true });
    assert.match(asBuilder.rows[0]!.errors.join(' '), /cannot give the "admin" role/);

    // Only administrators may import.
    const reader = await engine.createActor(w.tenantId, e('reader'), 'Reader', 'read_only');
    await assert.rejects(importDirectory(pool, { kind: 'actor', tenantId: w.tenantId, actorId: reader }, { rows: [{ email: e('z'), name: 'Z' }] }), /administer/);
    await assert.rejects(importDirectory(pool, w.admin, { rows: [] }), /at least one row/);
  } finally { await pool.end(); }
});

test('an imported person accepts their invitation and keeps their place in the organisation', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const w = await workspace(pool, engine);
    await importDirectory(pool, w.admin, { rows: [
      { email: e('mgr2'), name: 'Mia Manager' },
      { email: e('new2'), name: 'Nia New', manager: e('mgr2'), unit: 'Support' },
    ], dryRun: false });
    const { rows: before } = await pool.query<{ id: string }>('select id from actor where tenant_id = $1 and email = $2', [w.tenantId, e('new2')]);

    // The invitation goes to someone already in the directory; accepting adopts that row.
    const sent = await invite(pool, { principal: w.admin, email: e('new2'), workspaceRole: 'read_only' });
    await assert.rejects(invite(pool, { principal: w.admin, email: e('new2'), workspaceRole: 'read_only' }), /already has an open invitation/);
    const accepted = await acceptInvitation(pool, { token: sent.token, displayName: 'Nia N.', password: 'a-long-enough-password' });
    assert.equal(accepted.actorId, before[0]!.id, 'the same person, not a second account');
    const chart = await orgChart(pool, w.admin);
    const nia = chart.people.find((p) => p.email === e('new2'))!;
    assert.equal(nia.display_name, 'Nia N.');
    assert.equal(nia.manager!.email, e('mgr2'));
    assert.ok(nia.org_unit_id);
    // Once they have a password, they are an ordinary member: no second invitation.
    await assert.rejects(invite(pool, { principal: w.admin, email: e('new2'), workspaceRole: 'read_only' }), /already in this workspace/);
  } finally { await pool.end(); }
});
