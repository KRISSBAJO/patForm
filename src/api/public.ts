import { createHash } from 'node:crypto';
import type { Blueprint } from '../blueprint/index.js';
import { inTransaction, type Pool } from './../runtime/db.js';
import { redact, require_, visibleFields, type Principal } from '../runtime/policy.js';
import type { Capability } from '../blueprint/roles.js';

/**
 * The public API, §11.1.
 *
 * Separate from the console's API rather than sharing its routes, because the
 * two have different obligations and pretending otherwise is how a console
 * convenience becomes a published contract. The console's endpoints can change
 * with the page that calls them; these are versioned under `/v1` and somebody
 * else's build depends on them.
 *
 * Five principles from §11.1, and the one that changed existing behaviour:
 *
 * **"Field-level permissions reflected in API responses; hidden data is
 * omitted rather than masked ambiguously."** The console shows `[redacted]`,
 * which is right on a screen — a person should see that something is there and
 * that they cannot see it. It is wrong in JSON, where a consumer writing
 * `record.data.bank_account` would get the literal string `"[redacted]"` and
 * store it, compare it, or pay it. So the API omits the key and lists what it
 * omitted, which is unambiguous in both directions.
 *
 * **Cursor pagination**, not offset. An offset over a table that is being
 * written to skips and repeats rows, and a caller paging through a process
 * during business hours is exactly that case.
 *
 * **Idempotency keys for mutations**, stored rather than held in memory, so the
 * guarantee survives a restart.
 *
 * **Consistent errors** with a stable `type`, and a request id on every one.
 *
 * **Rate limits with informative headers**, so a caller can back off before
 * being refused rather than after.
 */

export const API_VERSION = 'v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const apiErrors = {
  unauthorized: (m: string) => new ApiError(401, 'unauthorized', m),
  forbidden: (m: string, detail?: Record<string, unknown>) => new ApiError(403, 'forbidden', m, detail),
  notFound: (m: string) => new ApiError(404, 'not_found', m),
  validation: (m: string, detail?: Record<string, unknown>) => new ApiError(422, 'validation_error', m, detail),
  conflict: (m: string) => new ApiError(409, 'conflict', m),
  rateLimited: (retryAfter: number) =>
    new ApiError(429, 'rate_limited', 'Too many requests.', { retry_after_seconds: retryAfter }),
};

// ---------------------------------------------------------------- pagination

/**
 * A cursor is the ordering key, not a page number.
 *
 * Encoded rather than raw so that a caller does not build one by hand and
 * discover later that the ordering changed. It is not secret and is not
 * treated as such — it is opaque, which is a different promise.
 */
export function encodeCursor(value: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed?.createdAt !== 'string' || typeof parsed?.id !== 'string') throw new Error();
    return parsed;
  } catch {
    throw apiErrors.validation('cursor is not one this API issued');
  }
}

export interface Page<T> {
  data: T[];
  /** Null when there is nothing after this page. */
  next_cursor: string | null;
  has_more: boolean;
}

// ------------------------------------------------------------- idempotency

/**
 * §11.1's idempotency for mutations.
 *
 * The stored answer is keyed on the request body's hash as well as the key. A
 * caller who reuses a key with a different body has a bug, and replaying the
 * first answer would hide it behind a success — so that is a 409 naming the
 * problem, which is what Stripe and RelyKit both do and for the same reason.
 */
export async function withIdempotency<T>(
  pool: Pool,
  args: { tenantId: string; key: string | undefined; body: unknown },
  run: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  if (!args.key) {
    const fresh = await run();
    return { ...fresh, replayed: false };
  }
  if (args.key.length > 255) throw apiErrors.validation('Idempotency-Key must be at most 255 characters.');

  const requestHash = createHash('sha256').update(JSON.stringify(args.body ?? null)).digest('hex');

  const { rows: existing } = await pool.query<{ request_hash: string; status: number; response: T }>(
    'select request_hash, status, response from api_idempotency where tenant_id = $1 and key = $2',
    [args.tenantId, args.key],
  );
  if (existing[0]) {
    if (existing[0].request_hash !== requestHash) {
      throw apiErrors.conflict('This Idempotency-Key was already used with a different request body.');
    }
    return { status: existing[0].status, body: existing[0].response, replayed: true };
  }

  const result = await run();

  /*
   * `on conflict do nothing` rather than a plain insert: two concurrent
   * requests carrying the same key both reach here, and the loser must not
   * fail. It has already done the work — which is the honest limitation of
   * doing this outside the mutation's own transaction, and the reason the
   * effects underneath have their own idempotency keys (ADR-0002).
   */
  await pool.query(
    `insert into api_idempotency (tenant_id, key, request_hash, status, response)
     values ($1, $2, $3, $4, $5) on conflict (tenant_id, key) do nothing`,
    [args.tenantId, args.key, requestHash, result.status, JSON.stringify(result.body)],
  );

  return { ...result, replayed: false };
}

// -------------------------------------------------------------- serialising

export interface PublicRecord {
  id: string;
  reference: string;
  process_key: string;
  process_version: number;
  state: string;
  state_name: string;
  outcome: string | null;
  created_at: string;
  state_entered_at: string;
  completed_at: string | null;
  data: Record<string, unknown>;
  /**
   * §11.1: hidden data is omitted rather than masked. Naming what was omitted
   * is the other half — a consumer that sees no `bank_account` key cannot
   * otherwise tell whether the field is absent, empty, or not theirs to read.
   */
  omitted_fields: string[];
}

export function toPublicRecord(
  bp: Blueprint,
  version: number,
  roles: string[],
  row: {
    id: string;
    process_key: string;
    state: string;
    data: Record<string, unknown>;
    outcome: string | null;
    created_at: Date;
    state_entered_at: Date;
    completed_at: Date | null;
  },
): PublicRecord {
  const masked = redact(bp, roles, row.data);
  const data: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(masked)) {
    if (value === '[redacted]') omitted.push(key);
    else data[key] = value;
  }

  const state = bp.workflow.states.find((s) => s.key === row.state);
  return {
    id: row.id,
    reference: row.id.slice(0, 8).toUpperCase(),
    process_key: row.process_key,
    process_version: version,
    state: row.state,
    state_name: state?.name ?? row.state,
    outcome: row.outcome,
    created_at: row.created_at.toISOString(),
    state_entered_at: row.state_entered_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
    data,
    omitted_fields: omitted,
  };
}

// ------------------------------------------------------------------ reading

/**
 * Records, paged by cursor and filtered explicitly.
 *
 * "Explicit filtering" in §11.1 means named parameters the server understands,
 * not a query language — the same boundary the copilot's plan draws, for the
 * same reason. A filter this does not recognise is refused rather than ignored,
 * because silently returning everything when a caller asked for a subset is how
 * an integration leaks.
 */
/**
 * The orders a page of records may be read in.
 *
 * A fixed set rather than a column name from the caller: an order is part of
 * the cursor's meaning, and a cursor issued under one order is nonsense under
 * another. Each of these has its own comparison below.
 */
export const RECORD_ORDERS = ['newest', 'oldest', 'reference'] as const;
export type RecordOrder = (typeof RECORD_ORDERS)[number];

export async function listRecordsPage(
  pool: Pool,
  args: {
    principal: Principal;
    processKey: string;
    state?: string;
    updatedSince?: Date;
    completed?: boolean;
    /** Free text, matched against the reference and the answers this caller may see. */
    query?: string;
    order?: RecordOrder;
    limit: number;
    cursor?: string;
  },
): Promise<Page<PublicRecord>> {
  return inTransaction(pool, async (client) => {
    if (args.principal.kind !== 'actor') throw apiErrors.unauthorized('an API key acts as a member');
    const tenantId = args.principal.tenantId;

    const { rows: versions } = await client.query<{ blueprint: Blueprint }>(
      `select blueprint from process_version
        where tenant_id = $1 and process_key = $2 order by version desc limit 1`,
      [tenantId, args.processKey],
    );
    if (!versions[0]) throw apiErrors.notFound(`no published process "${args.processKey}"`);
    const bp = versions[0].blueprint;

    const decision = await require_(
      client,
      { principal: args.principal, action: 'view', tenantId, processKey: args.processKey, blueprint: bp },
      pool,
    );

    if (args.state && !bp.workflow.states.some((s) => s.key === args.state)) {
      throw apiErrors.validation(`"${args.state}" is not a state of this process`, {
        states: bp.workflow.states.map((s) => s.key),
      });
    }

    const params: unknown[] = [tenantId, args.processKey];
    const where = ['i.tenant_id = $1', 'i.process_key = $2'];
    const push = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    if (args.state) where.push(`i.state = ${push(args.state)}`);
    if (args.updatedSince) where.push(`i.state_entered_at >= ${push(args.updatedSince)}`);
    if (args.completed !== undefined) {
      where.push(args.completed ? 'i.completed_at is not null' : 'i.completed_at is null');
    }
    const order: RecordOrder = args.order ?? 'newest';
    if (!RECORD_ORDERS.includes(order)) {
      throw apiErrors.validation(`"${order}" is not an order`, { orders: [...RECORD_ORDERS] });
    }

    /*
     * Searching, without disclosing what it searched.
     *
     * The text is matched against the reference and against the answers this
     * caller is allowed to see — never the hidden ones. Matching a hidden
     * field would answer "which records contain this value" without showing
     * the value, and a handful of guesses turns that into the value itself.
     * So the visible keys are computed first and the match is restricted to
     * them, in SQL, before any row is returned.
     */
    const q = args.query?.trim();
    if (q) {
      const visible = visibleFields(bp, decision.roles);
      /*
       * `!` as the escape character rather than a backslash. Either works in
       * Postgres; this one survives being read, copied and pasted, which a
       * doubled backslash inside a template literal inside a shell heredoc
       * repeatedly has not.
       */
      const safe = q.replace(/[%_!]/g, (m) => `!${m}`);
      where.push(
        `(i.id::text ilike ${push(`${safe}%`)} escape '!'
          or exists (
            select 1 from jsonb_each_text(i.data) kv
             where kv.key = any(${push(visible)}::text[]) and kv.value ilike ${push(`%${safe}%`)} escape '!'))`,
      );
    }

    if (args.cursor) {
      const c = decodeCursor(args.cursor);
      // Strictly after the cursor, tie-broken by id, so a row created in the
      // same millisecond is neither skipped nor repeated. Which way "after"
      // runs is the order's business, not the cursor's.
      if (order === 'reference') where.push(`i.id > ${push(c.id)}`);
      else if (order === 'oldest') {
        where.push(`(i.created_at, i.id) > (${push(new Date(c.createdAt))}, ${push(c.id)})`);
      } else where.push(`(i.created_at, i.id) < (${push(new Date(c.createdAt))}, ${push(c.id)})`);
    }

    const orderBy =
      order === 'reference'
        ? 'i.id asc'
        : order === 'oldest'
          ? 'i.created_at asc, i.id asc'
          : 'i.created_at desc, i.id desc';

    const limit = Math.min(Math.max(args.limit, 1), 100);
    const { rows } = await client.query<{
      id: string;
      process_key: string;
      state: string;
      data: Record<string, unknown>;
      outcome: string | null;
      created_at: Date;
      state_entered_at: Date;
      completed_at: Date | null;
      version: number;
    }>(
      `select i.id, i.process_key, i.state, i.data, i.outcome, i.created_at, i.state_entered_at,
              i.completed_at, pv.version
         from instance i join process_version pv on pv.id = i.process_version_id
        where ${where.join(' and ')}
        order by ${orderBy}
        limit ${limit + 1}`,
      params,
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      data: page.map((r) => toPublicRecord(bp, r.version, decision.roles, r)),
      next_cursor: hasMore && last ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id }) : null,
      has_more: hasMore,
    };
  });
}

export async function getRecord(
  pool: Pool,
  args: { principal: Principal; instanceId: string },
): Promise<PublicRecord> {
  return inTransaction(pool, async (client) => {
    if (args.principal.kind !== 'actor') throw apiErrors.unauthorized('an API key acts as a member');

    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      process_key: string;
      state: string;
      data: Record<string, unknown>;
      outcome: string | null;
      created_at: Date;
      state_entered_at: Date;
      completed_at: Date | null;
      blueprint: Blueprint;
      version: number;
    }>(
      `select i.*, pv.blueprint, pv.version
         from instance i join process_version pv on pv.id = i.process_version_id
        where i.id = $1 and i.tenant_id = $2`,
      [args.instanceId, args.principal.tenantId],
    );
    const row = rows[0];
    // Not found rather than forbidden: confirming that a record exists in
    // another workspace is itself a disclosure.
    if (!row) throw apiErrors.notFound('no such record');

    const decision = await require_(
      client,
      {
        principal: args.principal,
        action: 'view',
        tenantId: row.tenant_id,
        processKey: row.process_key,
        blueprint: row.blueprint,
        instanceId: row.id,
      },
      pool,
    );

    return toPublicRecord(row.blueprint, row.version, decision.roles, row);
  });
}

/**
 * The scope a key must carry for each operation.
 *
 * Creating a record is `edit`, not `submit`. `submit` is the *respondent's*
 * capability — no workspace role holds it, because a member is not the person
 * the form is about. An API key creating records on a workspace's behalf is
 * doing what an operator does, which is the same reasoning the CSV importer
 * already used. The scope-intersection check is what surfaced it: a key could
 * never have been issued with `submit`, so the endpoint was unreachable.
 */
export const SCOPE_FOR: Record<string, Capability> = {
  'GET /processes': 'view',
  'GET /records': 'view',
  'GET /records/:id': 'view',
  'POST /records': 'edit',
  'GET /metrics': 'report',
  'POST /imports': 'edit',
};
