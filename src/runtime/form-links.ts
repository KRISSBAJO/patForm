import { randomInt } from 'node:crypto';
import type { Client, Pool } from './db.js';
import { FormLinkError } from './errors.js';

/**
 * What a public form link names, and how it is resolved.
 *
 * The link used to be `/f/<process_key>`, and a process key is only unique
 * inside one workspace. Every lookup behind it took the highest version of
 * that key across *all* workspaces — so two workspaces that installed the
 * same pack shared one URL, the one with the higher version number was
 * served, and answers typed into one organisation's form became a record in
 * the other's.
 *
 * Each (workspace, process) now has its own public id, made when the process
 * is first published and kept across versions, so a printed link keeps
 * working when the form changes. It is random rather than readable: sixty
 * bits of it, so a link cannot be guessed and the forms a workspace runs
 * cannot be listed by trying names — the "enumeration on public forms" threat
 * the product document names. A readable alias can be added in front of it;
 * the reverse is not possible once links are printed.
 */

/** Lowercase, with the letters and digits people misread (0/o, 1/l) left out. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Three groups of four. The hyphens are what tell an id from a process key, which never has one. */
export const PUBLIC_ID = /^[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}$/;

const PROCESS_KEY = /^[a-z][a-z0-9_]{2,}$/;

export function newPublicId(): string {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

/** Gives a published process its link, once. Called from `Engine.publish`, inside its transaction. */
export async function ensurePublicForm(client: Client, tenantId: string, processKey: string): Promise<void> {
  await client.query(
    `insert into public_form (tenant_id, process_key, public_id) values ($1, $2, $3)
     on conflict (tenant_id, process_key) do nothing`,
    [tenantId, processKey, newPublicId()],
  );
}

export interface ResolvedForm {
  tenantId: string;
  processKey: string;
  publicId: string;
}

/**
 * Turns what is in the URL into exactly one workspace's process, or refuses.
 *
 * A public id resolves to its one form. A bare process key — the old link —
 * resolves only while exactly one workspace has that key, which keeps links
 * already sent working and cannot serve the wrong workspace: the moment a
 * second one publishes the same key, the old link stops with a message
 * rather than picking.
 */
export async function resolveForm(db: Pool | Client, ref: string): Promise<ResolvedForm> {
  if (PUBLIC_ID.test(ref)) {
    const { rows } = await db.query<{ tenant_id: string; process_key: string }>(
      'select tenant_id, process_key from public_form where public_id = $1',
      [ref],
    );
    if (!rows[0]) throw new FormLinkError('not_found', 'no such form');
    return { tenantId: rows[0].tenant_id, processKey: rows[0].process_key, publicId: ref };
  }

  if (!PROCESS_KEY.test(ref)) throw new FormLinkError('not_found', 'no such form');
  const { rows } = await db.query<{ tenant_id: string; public_id: string }>(
    'select tenant_id, public_id from public_form where process_key = $1 limit 2',
    [ref],
  );
  if (!rows.length) throw new FormLinkError('not_found', 'no such form');
  if (rows.length > 1) {
    throw new FormLinkError(
      'ambiguous',
      'this link is out of date — ask whoever sent it for the current one',
    );
  }
  return { tenantId: rows[0]!.tenant_id, processKey: ref, publicId: rows[0]!.public_id };
}

/** Every public id in one workspace, by process key. */
export async function publicIdsFor(db: Pool | Client, tenantId: string): Promise<Map<string, string>> {
  const { rows } = await db.query<{ process_key: string; public_id: string }>(
    'select process_key, public_id from public_form where tenant_id = $1',
    [tenantId],
  );
  return new Map(rows.map((r) => [r.process_key, r.public_id]));
}
