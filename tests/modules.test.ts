import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { InvalidInput } from '../src/runtime/errors.js';
import { MODULES, categoryAvailable, enabledModules, listModules, setModule, updateWorkspaceSettings, workspaceSettings } from '../src/runtime/modules.js';
import { listPacks } from '../src/runtime/packs.js';
import { workspaceAudit } from '../src/runtime/authority.js';
import type { Principal } from '../src/runtime/policy.js';

// PRD ORG-01: which modules a workspace has on, and the settings they share.
const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test('every pack category is either claimed by one module or part of the platform', () => {
  const claimed = new Map<string, string>();
  for (const m of MODULES) for (const c of m.categories) {
    assert.ok(!claimed.has(c), `${c} is claimed by both ${claimed.get(c)} and ${m.key}`);
    claimed.set(c, m.key);
  }
  const core = new Set(MODULES.filter((m) => m.core).map((m) => m.key));
  assert.equal(categoryAvailable('Church', core), true, 'an unclaimed category is always on the shelf');
  assert.equal(categoryAvailable('Finance', core), false);
  assert.equal(categoryAvailable('Finance', new Set([...core, 'expenses'])), true);
});

test('modules switch on and off per workspace, hide their templates, and never switch the platform off', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const tenantId = await engine.createTenant(`modules-${stamp()}`, { scenario: true });
    const ownerId = await engine.createActor(tenantId, `owner-${stamp()}@mod.test`, 'Owner', 'owner');
    const owner: Principal = { kind: 'actor', tenantId, actorId: ownerId };
    const readerId = await engine.createActor(tenantId, `reader-${stamp()}@mod.test`, 'Reader', 'read_only');
    const reader: Principal = { kind: 'actor', tenantId, actorId: readerId };

    // A new workspace has only the platform.
    const before = await listModules(pool, owner);
    assert.deepEqual(before.filter((m) => m.enabled).map((m) => m.key), ['platform']);
    const shelfBefore = await listPacks(pool, { principal: owner });
    assert.equal(shelfBefore.some((p) => p.category === 'Finance'), false, 'Finance templates are off the shelf');
    assert.equal(shelfBefore.some((p) => p.category === 'Church'), true, 'platform templates are always there');

    // Switching on needs administer; the platform cannot go off.
    await assert.rejects(setModule(pool, reader, 'expenses', { enabled: true }), /administer/);
    await assert.rejects(setModule(pool, owner, 'platform', { enabled: false }), /always on/);
    await assert.rejects(setModule(pool, owner, 'nonsense', { enabled: true }), InvalidInput);

    await setModule(pool, owner, 'expenses', { enabled: true, plan: 'pilot' });
    assert.ok((await enabledModules(pool, tenantId)).has('expenses'));
    const shelfAfter = await listPacks(pool, { principal: owner });
    assert.equal(shelfAfter.some((p) => p.category === 'Finance'), true);
    assert.equal(shelfAfter.some((p) => p.category === 'Procurement'), false);
    const listed = (await listModules(pool, reader)).find((m) => m.key === 'expenses')!;
    assert.equal(listed.enabled, true);
    assert.equal(listed.changedBy, 'Owner');
    assert.equal(listed.plan, 'pilot');

    // Off again: hidden, not deleted, and both changes are in the audit.
    await setModule(pool, owner, 'expenses', { enabled: false });
    assert.equal((await listPacks(pool, { principal: owner })).some((p) => p.category === 'Finance'), false);
    const actions = (await workspaceAudit(pool, owner)).map((r: { action: string }) => r.action);
    assert.deepEqual(actions.filter((a) => a.startsWith('module.')).sort(), ['module.disabled', 'module.enabled']);

    // Another workspace is unaffected.
    const otherTenant = await engine.createTenant(`modules-other-${stamp()}`, { scenario: true });
    assert.deepEqual([...(await enabledModules(pool, otherTenant))], ['platform']);
  } finally { await pool.end(); }
});

test('workspace settings validate the time zone, currency and locale', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const engine = new Engine(pool);
    const tenantId = await engine.createTenant(`settings-${stamp()}`, { scenario: true });
    const ownerId = await engine.createActor(tenantId, `owner-${stamp()}@mod.test`, 'Owner', 'owner');
    const owner: Principal = { kind: 'actor', tenantId, actorId: ownerId };

    const initial = await workspaceSettings(pool, owner);
    assert.equal(initial.timezone, 'Europe/London');
    assert.equal(initial.defaultCurrency, 'GBP');

    const saved = await updateWorkspaceSettings(pool, owner, { name: 'Lagos Logistics', timezone: 'Africa/Lagos', defaultCurrency: 'ngn', locale: 'en-NG' });
    assert.equal(saved.name, 'Lagos Logistics');
    assert.equal(saved.timezone, 'Africa/Lagos');
    assert.equal(saved.defaultCurrency, 'NGN');
    assert.equal(saved.locale, 'en-NG');

    await assert.rejects(updateWorkspaceSettings(pool, owner, { timezone: 'Mars/Olympus' }), /timezone/);
    await assert.rejects(updateWorkspaceSettings(pool, owner, { defaultCurrency: 'NAIRA' }), /defaultCurrency/);
    await assert.rejects(updateWorkspaceSettings(pool, owner, { locale: '!!' }), /locale/);
    await assert.rejects(updateWorkspaceSettings(pool, owner, {}), /nothing to change/);
    assert.equal((await workspaceSettings(pool, owner)).timezone, 'Africa/Lagos', 'a refused change leaves the old value');
  } finally { await pool.end(); }
});
