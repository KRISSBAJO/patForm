import type { Blueprint } from '../blueprint/index.js';
import { answerText } from '../blueprint/display.js';
import { isSignature, type SignatureValue } from '../blueprint/signature.js';
import { inTransaction, type Pool } from './db.js';
import { Engine, appendEvent } from './engine.js';
import { authorize, redact, require_, type Principal } from './policy.js';
import { HOLD_REASON_WORDS, type HoldReason } from './screening.js';

/**
 * The queue screening puts things in, and the two ways out of it.
 *
 * A held submission is not a record. Releasing one makes it a record by the
 * same path any submission takes — validation, duplicate detection, the
 * submission transition, the receipt — so a released submission cannot
 * behave differently from one that was never held. Discarding one clears its
 * answers and keeps the fact that somebody decided.
 *
 * Deciding needs `operate` on the process, the same capability that works
 * its records: whoever handles the applications is who can tell a real one
 * from a fake, and they see the answers through the same field-level
 * redaction they see a record through.
 */

/** How long a held submission is kept, decided or not. */
export const HELD_DAYS = 30;

export interface HeldRow {
  id: string;
  reference: string;
  processKey: string;
  processName: string;
  receivedAt: string;
  reasons: string[];
  /** Seconds from loading the form to submitting it, when that is known. */
  seconds: number | null;
  /** Answers as this member's roles may see them, in words. */
  answers: {
    label: string;
    value: string;
    /** Long text, which the page lays out on its own line. */
    long?: boolean;
    /** A signature, so the page can show it rather than describe it. */
    signature?: SignatureValue;
  }[];
}

type Actor = Extract<Principal, { kind: 'actor' }>;

function actorOf(principal: Principal): Actor {
  if (principal.kind !== 'actor') throw new Error('held submissions are for signed-in members');
  return principal;
}


/** Every open held submission this member may decide, newest first. */
export async function listHeld(pool: Pool, principal: Principal): Promise<HeldRow[]> {
  const actor = actorOf(principal);
  const { rows } = await pool.query<{
    id: string;
    process_key: string;
    answers: Record<string, unknown>;
    reasons: HoldReason[];
    elapsed_ms: number | null;
    received_at: Date;
    blueprint: Blueprint;
  }>(
    `select h.id, h.process_key, h.answers, h.reasons, h.elapsed_ms, h.received_at, pv.blueprint
       from held_submission h join process_version pv on pv.id = h.process_version_id
      where h.tenant_id = $1 and h.resolved_at is null
      order by h.received_at desc
      limit 200`,
    [actor.tenantId],
  );

  const out: HeldRow[] = [];
  const client = await pool.connect();
  try {
    for (const row of rows) {
      const decision = await authorize(client, {
        principal: actor,
        action: 'operate',
        tenantId: actor.tenantId,
        processKey: row.process_key,
        blueprint: row.blueprint,
      });
      if (!decision.allowed) continue;
      const visible = redact(row.blueprint, decision.roles, row.answers);
      out.push({
        id: row.id,
        reference: row.id.slice(0, 8).toUpperCase(),
        processKey: row.process_key,
        processName: row.blueprint.name,
        receivedAt: row.received_at.toISOString(),
        reasons: row.reasons.map((r) => HOLD_REASON_WORDS[r] ?? r),
        seconds: row.elapsed_ms === null ? null : Math.round(row.elapsed_ms / 100) / 10,
        answers: row.blueprint.data.fields
          .filter((f) => f.key in visible)
          .map((f) => {
            const value = visible[f.key];
            return {
              label: f.label,
              value: answerText(f, value),
              ...(f.type === 'long_text' ? { long: true } : {}),
              ...(isSignature(value) ? { signature: value } : {}),
            };
          }),
      });
    }
  } finally {
    client.release();
  }
  return out;
}

async function loadOpen(pool: Pool, actor: Actor, heldId: string) {
  const { rows } = await pool.query<{
    id: string;
    process_key: string;
    process_version_id: string;
    answers: Record<string, unknown>;
    reasons: HoldReason[];
    draft_token_hash: string | null;
    resolution: string | null;
    released_as: string | null;
    version: number;
    blueprint: Blueprint;
  }>(
    `select h.id, h.process_key, h.process_version_id, h.answers, h.reasons, h.draft_token_hash,
            h.resolution, h.released_as, pv.version, pv.blueprint
       from held_submission h join process_version pv on pv.id = h.process_version_id
      where h.id = $1 and h.tenant_id = $2`,
    [heldId, actor.tenantId],
  );
  const row = rows[0];
  if (!row) throw new Error('no such held submission');

  const client = await pool.connect();
  try {
    await require_(
      client,
      { principal: actor, action: 'operate', tenantId: actor.tenantId, processKey: row.process_key, blueprint: row.blueprint },
      pool,
    );
  } finally {
    client.release();
  }
  return row;
}

/**
 * Makes it a record, as though it had just been submitted.
 *
 * Under the version the person filled in, not the latest: the answers were
 * given to that form. Under the held id, so the reference they were shown is
 * the record's. And through `engine.submit`, so a release that matches an
 * existing record by identity is recorded against that record — exactly what
 * would have happened had it never been held.
 *
 * Safe to repeat. If the process dies between the record being made and the
 * hold being marked released, the next release finds the record under its
 * id and finishes the bookkeeping instead of making a second one.
 */
export async function releaseHeld(
  pool: Pool,
  args: { principal: Principal; heldId: string; now?: Date },
): Promise<{ instanceId: string; reference: string; duplicate: boolean }> {
  const actor = actorOf(args.principal);
  const row = await loadOpen(pool, actor, args.heldId);
  if (row.resolution === 'discarded') throw new Error('that submission was discarded');
  if (row.resolution === 'released') {
    return { instanceId: row.released_as!, reference: row.released_as!.slice(0, 8).toUpperCase(), duplicate: false };
  }

  const now = args.now ?? new Date();
  const { rows: already } = await pool.query<{ id: string }>('select id from instance where id = $1', [row.id]);

  let instanceId: string;
  let duplicate = false;
  if (already.length) {
    instanceId = row.id;
  } else {
    const result = await new Engine(pool).submit({
      version: {
        id: row.process_version_id,
        tenant_id: actor.tenantId,
        process_key: row.process_key,
        version: row.version,
        blueprint: row.blueprint,
      },
      answers: row.answers as never,
      now,
      principal: { kind: 'respondent', tenantId: actor.tenantId, label: 'held submission' },
      id: row.id,
    });
    if (result.rejected) {
      // It validated when it arrived; a required field cannot vanish from a
      // published version. Reaching here is a bug, and saying so beats a
      // record half-made.
      throw new Error(`the held answers no longer satisfy the form — missing: ${result.rejected.join(', ')}`);
    }
    instanceId = result.instanceId;
    duplicate = result.duplicate;
  }

  await inTransaction(pool, async (tx) => {
    await tx.query(
      `update held_submission
          set resolved_at = $2, resolved_by = $3, resolution = 'released', released_as = $4
        where id = $1 and resolved_at is null`,
      [row.id, now, actor.actorId, instanceId],
    );
    await appendEvent(tx, {
      tenantId: actor.tenantId,
      instanceId,
      type: 'released_from_hold',
      payload: { heldId: row.id, reasons: row.reasons, duplicate },
      actor: `actor:${actor.actorId}`,
      now,
    });
    if (row.draft_token_hash && !duplicate) {
      await tx.query('update draft set submitted_instance_id = $1, updated_at = now() where token_hash = $2', [
        instanceId,
        row.draft_token_hash,
      ]);
    }
  });

  return { instanceId, reference: instanceId.slice(0, 8).toUpperCase(), duplicate };
}

/**
 * Throws it away. The answers go now; the row that says who decided stays
 * until the sweep, so "where did that application go" has an answer.
 */
export async function discardHeld(
  pool: Pool,
  args: { principal: Principal; heldId: string; now?: Date },
): Promise<{ discarded: boolean }> {
  const actor = actorOf(args.principal);
  const row = await loadOpen(pool, actor, args.heldId);
  if (row.resolution === 'released') throw new Error('that submission was already released as a record');
  const { rowCount } = await pool.query(
    `update held_submission
        set resolved_at = $2, resolved_by = $3, resolution = 'discarded', answers = '{}'::jsonb
      where id = $1 and resolved_at is null`,
    [row.id, args.now ?? new Date(), actor.actorId],
  );
  return { discarded: (rowCount ?? 0) > 0 };
}

/** The worker's sweep. Held answers are unvetted personal data; they do not stay. */
export async function sweepHeld(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from held_submission where received_at < now() - make_interval(days => $1)`,
    [HELD_DAYS],
  );
  return rowCount ?? 0;
}
