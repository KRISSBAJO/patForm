import { writeFileSync } from 'node:fs';
import { createPool, describeTarget } from './runtime/db.js';
import { suppressDelivery } from './runtime/email.js';
import { dataMap, eraseSubject, findSubject } from './runtime/privacy.js';
import type { Principal } from './runtime/policy.js';

/**
 * The privacy tools, §20.2's privacy gate.
 *
 *   npm run data-map -- --as <actor-id>
 *   npm run erase -- <email> --as <actor-id> [--apply] --reason "..."
 *
 * Both take a principal and go through the same authorization as everything
 * else. A privacy tool that runs as the database owner is a privacy hazard:
 * the point of an erasure record is that it names who did it.
 *
 * `erase` previews by default. Deleting somebody's data is the one operation
 * where "are you sure" is not a dark pattern, and the preview runs the real
 * thing and rolls it back, so the numbers are measured rather than guessed.
 */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

const CLASS_COLOUR: Record<string, string> = {
  public: DIM,
  internal: '',
  confidential: YELLOW,
  restricted: RED,
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function principalFor(pool: ReturnType<typeof createPool>): Promise<{ principal: Principal; name: string }> {
  const actorId = flag('as');
  if (!actorId) {
    console.error('\n  --as <actor-id> is required: these tools show and remove what that person may.\n');
    process.exit(2);
  }
  const { rows } = await pool.query<{ tenant_id: string; display_name: string; workspace_role: string }>(
    'select tenant_id, display_name, workspace_role from actor where id = $1',
    [actorId],
  );
  if (!rows[0]) {
    console.error(`\n  No actor ${actorId}.\n`);
    process.exit(2);
  }
  return {
    principal: { kind: 'actor', tenantId: rows[0].tenant_id, actorId },
    name: `${rows[0].display_name} (${rows[0].workspace_role})`,
  };
}

async function showDataMap(): Promise<void> {
  const pool = createPool(4);
  const { principal, name } = await principalFor(pool);

  console.log(`\n${BOLD}Data map${OFF} ${DIM}- ${describeTarget()}, as ${name}${OFF}`);
  console.log(`${DIM}Derived from the published versions in the database, not maintained by hand.${OFF}`);

  const maps = await dataMap(pool, principal);
  if (!maps.length) console.log(`\n  ${YELLOW}No published processes in this workspace.${OFF}`);

  for (const m of maps) {
    console.log(`\n${BOLD}${m.processName}${OFF} ${DIM}${m.processKey} v${m.version}, ${m.liveRecords} record(s)${OFF}`);
    console.log(`  ${DIM}Purpose${OFF}    ${m.purpose}`);
    console.log(`  ${DIM}Subjects${OFF}   ${m.respondents}`);
    console.log(
      `  ${DIM}Retention${OFF}  ${m.retention.days ? `${m.retention.days} days after completion, then ${m.retention.action}` : m.retention.action}`,
    );
    console.log(
      `  ${DIM}Ceiling${OFF}    ${m.sensitivityCeiling}  ${DIM}(${Object.entries(m.byClassification).map(([k, v]) => `${v} ${k}`).join(', ')})${OFF}`,
    );
    if (m.identity.length) console.log(`  ${DIM}Identity${OFF}   ${m.identity.join(', ')}`);

    console.log('');
    for (const f of m.fields) {
      const colour = CLASS_COLOUR[f.classification] ?? '';
      console.log(
        `  ${colour}${f.classification.slice(0, 4).toUpperCase().padEnd(5)}${OFF} ${f.label.slice(0, 40).padEnd(42)} ${DIM}${f.key}${OFF}`,
      );
      if (f.collectionReason) console.log(`        ${DIM}why: ${f.collectionReason}${OFF}`);
      else if (f.classification === 'confidential' || f.classification === 'restricted') {
        console.log(`        ${RED}why: not recorded${OFF}`);
      }
      if (f.hiddenFrom.length) console.log(`        ${DIM}hidden from: ${f.hiddenFrom.join(', ')}${OFF}`);
      for (const route of f.leaves) console.log(`        ${DIM}→ ${route}${OFF}`);
    }

    if (m.notes.length) {
      console.log(`\n  ${YELLOW}For review${OFF}`);
      for (const note of m.notes) console.log(`    ${YELLOW}·${OFF} ${note}`);
    }
  }

  const out = flag('out');
  if (out) {
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), processes: maps }, null, 2) + '\n');
    console.log(`\n${DIM}Written to ${out}${OFF}`);
  }
  console.log('');
  await pool.end();
}

async function erase(): Promise<void> {
  // Erasure touches the outbox and the delivery log. Nothing should leave.
  suppressDelivery('an erasure run must not send anything');

  const email = process.argv[3];
  if (!email || !email.includes('@')) {
    console.error('\n  usage: npm run erase -- someone@example.com --as <actor-id> [--apply] --reason "..."\n');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  const reason = flag('reason');
  if (apply && !reason) {
    console.error('\n  --reason is required when applying. An erasure with no stated reason is not auditable.\n');
    process.exit(2);
  }

  const pool = createPool(4);
  const { principal, name } = await principalFor(pool);

  console.log(`\n${BOLD}Privacy request${OFF} ${DIM}- ${describeTarget()}, as ${name}${OFF}`);
  console.log(`${BOLD}Subject${OFF}  ${email}`);
  console.log(apply ? `${RED}${BOLD}Applying. This cannot be undone.${OFF}` : `${DIM}Preview only. Add --apply to carry it out.${OFF}`);

  const appearances = await findSubject(pool, { principal, email });
  if (!appearances.length) {
    console.log(`\n  ${GREEN}Nothing found. This workspace holds no record naming that address.${OFF}\n`);
    await pool.end();
    return;
  }

  console.log(`\n  ${BOLD}Found in ${appearances.length} record(s)${OFF}`);
  for (const a of appearances) {
    const mark = a.role === 'subject' ? `${RED}subject${OFF}` : `${DIM}mentioned${OFF}`;
    console.log(`    ${a.reference}  ${a.processName.padEnd(22)} ${a.state.padEnd(22)} ${mark}  ${DIM}via ${a.via.join(', ')}${OFF}`);
    if (a.blocked) console.log(`      ${YELLOW}not erased: ${a.blocked}${OFF}`);
  }

  const result = await eraseSubject(pool, { principal, email, preview: !apply, reason: reason ?? 'preview' });

  console.log(`\n  ${BOLD}${apply ? 'Removed' : 'Would remove'}${OFF}`);
  console.log(`    ${result.deleted.instances} record(s) this person is the subject of, with ${result.deleted.events} event(s)`);
  console.log(`    ${result.redacted.fields} field(s) across ${result.redacted.instances} record(s) where they are only named`);
  if (result.blocked.length) {
    console.log(`\n  ${YELLOW}${result.blocked.length} left alone${OFF}`);
    for (const b of result.blocked) console.log(`    ${b.reference}  ${b.blocked}`);
    console.log(`  ${DIM}Run again once these complete, or cancel them first.${OFF}`);
  }

  console.log(`\n  ${DIM}Live data only. Backups taken before now still hold this person until they expire —`);
  console.log(`  that is a retention schedule, not a delete, and the subject should be told so.${OFF}\n`);

  await pool.end();
}

// The npm script supplies the subcommand, so argv[2] is `map` or `erase` and
// everything after it is the user's.
const command = process.argv[2];
const main = command === 'erase' ? erase : showDataMap;

main().catch((err) => {
  console.error(`\n${RED}${err instanceof Error ? err.message : String(err)}${OFF}\n`);
  process.exit(1);
});
