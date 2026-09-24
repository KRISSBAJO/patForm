import type { Client, Pool } from './db.js';
import { AuthorizationError } from './policy.js';

/** A narrow workspace pause: existing records and approvals remain available. */
export async function requireIntakeOpen(db: Pool | Client, tenantId: string, lock = false): Promise<void> {
  const { rows } = await db.query<{ intake_paused_at: Date | null }>(
    `select intake_paused_at from tenant where id = $1${lock ? ' for share' : ''}`, [tenantId],
  );
  if (!rows[0] || rows[0].intake_paused_at) {
    throw new AuthorizationError('submit', 'new submissions are paused for this workspace');
  }
}
