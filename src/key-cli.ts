import { createPool, describeTarget } from './runtime/db.js';
import { issueApiKey, listApiKeys, revokeApiKey } from './api/keys.js';
import { WORKSPACE_GRANTS } from './runtime/policy.js';
import type { Capability } from './blueprint/roles.js';

/**
 * Issuing and revoking API keys, §11.1.
 *
 *   npm run keys -- list --as <actor-id>
 *   npm run keys -- issue "CI pipeline" --as <actor-id> --scopes view,submit
 *   npm run keys -- revoke <key-id> --as <actor-id>
 *
 * The key is printed once. There is nowhere to look it up afterwards, which is
 * the point: only its hash is stored, so a key readable from the database is a
 * key every administrator holds.
 *
 * Scopes are intersected with the issuer's own workspace capabilities here and
 * again on every request. Somebody who can only `view` cannot leave behind a
 * key that can `submit`.
 */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(): never {
  console.error(`usage:
  npm run keys -- list --as <actor-id>
  npm run keys -- issue "<name>" --as <actor-id> --scopes view,submit
  npm run keys -- revoke <key-id> --as <actor-id>`);
  process.exit(2);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const actorId = flag('as');
  if (!command || !actorId) usage();

  const pool = createPool(4);
  const { rows } = await pool.query<{ tenant_id: string; display_name: string; workspace_role: keyof typeof WORKSPACE_GRANTS; active: boolean }>(
    'select tenant_id, display_name, workspace_role, active from actor where id = $1',
    [actorId],
  );
  const actor = rows[0];
  if (!actor || !actor.active) {
    console.error(`\n  No active actor ${actorId}.\n`);
    process.exit(2);
  }

  console.log(`\n${BOLD}API keys${OFF} ${DIM}- ${describeTarget()}, as ${actor.display_name} (${actor.workspace_role})${OFF}`);

  if (command === 'list') {
    const keys = await listApiKeys(pool, actor.tenant_id);
    if (!keys.length) console.log(`\n  ${DIM}None issued.${OFF}`);
    for (const k of keys as Record<string, string>[]) {
      const state = k.revoked_at ? `${RED}revoked${OFF}` : `${GREEN}active${OFF}`;
      console.log(`\n  ${BOLD}${k.name}${OFF}  ${state}`);
      console.log(`    ${DIM}${k.key_prefix}…  ${k.id}${OFF}`);
      console.log(`    ${DIM}scopes ${(k.scopes as unknown as string[]).join(', ')}${OFF}`);
      console.log(`    ${DIM}created by ${k.created_by}, last used ${k.last_used_at ?? 'never'}${OFF}`);
    }
  } else if (command === 'issue') {
    const name = process.argv[3];
    const scopes = (flag('scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean) as Capability[];
    if (!name || name.startsWith('--') || !scopes.length) usage();

    // A key cannot be broader than the person creating it.
    const granted = WORKSPACE_GRANTS[actor.workspace_role] as readonly Capability[];
    const tooBroad = scopes.filter((s) => !granted.includes(s));
    if (tooBroad.length) {
      console.error(`\n  ${RED}You do not hold ${tooBroad.join(', ')}, so you cannot grant it.${OFF}`);
      console.error(`  ${DIM}Your role "${actor.workspace_role}" grants: ${granted.join(', ')}${OFF}\n`);
      process.exit(2);
    }

    const issued = await issueApiKey(pool, { tenantId: actor.tenant_id, actorId, name, scopes });
    console.log(`\n  ${GREEN}Issued.${OFF} ${DIM}${issued.id}${OFF}`);
    console.log(`\n  ${BOLD}${issued.key}${OFF}`);
    console.log(`\n  ${YELLOW}This is the only time it is shown. Only its hash is stored.${OFF}\n`);
  } else if (command === 'revoke') {
    const id = process.argv[3];
    if (!id) usage();
    const done = await revokeApiKey(pool, { tenantId: actor.tenant_id, id });
    console.log(done ? `\n  ${GREEN}Revoked.${OFF}\n` : `\n  ${YELLOW}No active key with that id here.${OFF}\n`);
  } else {
    usage();
  }

  await pool.end();
}

main().catch((err) => {
  console.error(`\n${RED}${err instanceof Error ? err.message : String(err)}${OFF}\n`);
  process.exit(1);
});
