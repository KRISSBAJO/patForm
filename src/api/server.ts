import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createPool, describeTarget, type Pool } from '../runtime/db.js';
import { Engine } from '../runtime/engine.js';
import { AuthorizationError, type Principal } from '../runtime/policy.js';

/**
 * The operator console's API.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  THIS SERVER HAS NO AUTHENTICATION. It reads `x-actor-id` and believes it.
 *
 *  That is identification, not authentication: anyone who can reach this port
 *  can claim to be anyone in the workspace. It is fine for a console running
 *  against a local database and completely unfit for anything reachable by
 *  another person. §12.1's authentication row — password hashing, verified
 *  email, MFA, session and device management — is not built.
 *
 *  What IS real is everything past that header. The policy engine still checks
 *  tenancy, membership, capability, named approvers, task assignment and field
 *  scope on every call, and still records refusals. Swapping this header for a
 *  session cookie changes this file and nothing below it.
 * ────────────────────────────────────────────────────────────────────────────
 */

const PORT = Number(process.env.API_PORT ?? 3310);

interface Ctx {
  engine: Engine;
  pool: Pool;
  principal: Principal;
  actorId: string;
  url: URL;
}

type Handler = (ctx: Ctx, body: unknown) => Promise<unknown>;

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];

function route(method: string, pattern: RegExp, handler: Handler): void {
  routes.push({ method, pattern, handler });
}

// ------------------------------------------------------------------ seats

/**
 * Lists the workspace's members so the console can offer them as seats.
 *
 * This endpoint is unauthenticated on purpose and exists ONLY because there is
 * no sign-in yet: it is the picker that stands in for a login screen. It must
 * be deleted the moment real authentication lands — it hands out actor ids,
 * which are the only thing this API currently checks.
 */
route('GET', /^\/api\/seats$/, async ({ pool }) => {
  const { rows } = await pool.query<{
    id: string;
    display_name: string;
    workspace_role: string;
    role_key: string | null;
  }>(
    `select a.id, a.display_name, a.workspace_role,
            (select m.role_key from membership m where m.actor_id = a.id limit 1) as role_key
       from actor a where a.active order by a.created_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.display_name,
    role: r.role_key ?? 'no process role',
    workspace: r.workspace_role,
  }));
});

// ------------------------------------------------------------------ session

route('GET', /^\/api\/session$/, async ({ engine, actorId }) => {
  const actor = await engine.actor(actorId);
  if (!actor) throw new HttpError(401, 'unknown actor');
  const processes = await engine.processesFor(actor.tenant_id, actorId);
  return { actor, processes };
});

// --------------------------------------------------------------- my work

route('GET', /^\/api\/work$/, async ({ engine, principal, actorId, url }) => {
  const processKey = url.searchParams.get('process');
  if (!processKey) throw new HttpError(400, 'process is required');
  return engine.myWork({ principal, actorId, processKey });
});

// --------------------------------------------------------------- records

route('GET', /^\/api\/records$/, async ({ engine, principal, url }) => {
  const processKey = url.searchParams.get('process');
  if (!processKey) throw new HttpError(400, 'process is required');
  return engine.listRecords({
    principal,
    processKey,
    state: url.searchParams.get('state') ?? undefined,
    limit: Number(url.searchParams.get('limit') ?? 50),
  });
});

route('GET', /^\/api\/records\/([0-9a-f-]{36})$/, async ({ engine, principal, url }) => {
  const id = url.pathname.split('/').pop()!;
  return engine.recordDetail(principal, id);
});

route('POST', /^\/api\/records\/([0-9a-f-]{36})\/decide$/, async ({ engine, principal, url }, body) => {
  const id = url.pathname.split('/')[3]!;
  const { approvalKey, decision, reason } = body as {
    approvalKey: string;
    decision: 'approved' | 'rejected' | 'changes_requested';
    reason?: string;
  };
  if (!approvalKey || !decision) throw new HttpError(400, 'approvalKey and decision are required');
  const result = await engine.decide({ instanceId: id, approvalKey, decision, principal, reason, now: new Date() });
  await engine.drain(new Date(), 'api');
  return result;
});

route(
  'POST',
  /^\/api\/records\/([0-9a-f-]{36})\/tasks\/([a-z0-9_]+)\/complete$/,
  async ({ engine, principal, url }) => {
    const [, , , id, , taskKey] = url.pathname.split('/');
    const result = await engine.completeTask({ instanceId: id!, taskKey: taskKey!, principal, now: new Date() });
    await engine.drain(new Date(), 'api');
    return result;
  },
);

// ----------------------------------------------------------- automation

route('GET', /^\/api\/automation$/, async ({ engine, principal, url }) => {
  const processKey = url.searchParams.get('process');
  if (!processKey) throw new HttpError(400, 'process is required');
  return engine.automationHealth({ principal, processKey });
});

route('POST', /^\/api\/automation\/(\d+)\/replay$/, async ({ engine, principal, url }) => {
  const outboxId = Number(url.pathname.split('/')[3]);
  return engine.replayAction({ principal, outboxId, now: new Date() });
});

// ------------------------------------------------------------------ plumbing

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // The console is served from another origin in development.
    'access-control-allow-origin': process.env.CONSOLE_ORIGIN ?? 'http://localhost:3210',
    'access-control-allow-headers': 'content-type, x-actor-id',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

async function main(): Promise<void> {
  const pool = createPool(12);
  const engine = new Engine(pool);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

      if (req.method === 'OPTIONS') return send(res, 204, {});
      if (url.pathname === '/api/health') return send(res, 200, { ok: true });

      try {
        if (url.pathname === '/api/seats' && req.method === 'GET') {
          const match = routes.find((r) => r.pattern.test('/api/seats'));
          return send(res, 200, await match!.handler({ engine, pool, principal: { kind: 'system', reason: 'worker' }, actorId: '', url }, {}));
        }

        const actorId = req.headers['x-actor-id'];
        if (typeof actorId !== 'string' || !actorId) {
          throw new HttpError(401, 'x-actor-id header is required');
        }
        const actor = await engine.actor(actorId);
        if (!actor) throw new HttpError(401, 'unknown actor');

        const principal: Principal = { kind: 'actor', tenantId: actor.tenant_id, actorId };
        const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
        if (!match) throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);

        const body = req.method === 'POST' ? await readBody(req) : {};
        const result = await match.handler({ engine, pool, principal, actorId, url }, body);
        send(res, 200, result);
      } catch (err) {
        if (err instanceof AuthorizationError) {
          // The reason is deliberately returned: an operator who cannot act
          // needs to know whether to ask for access or ask someone else.
          return send(res, 403, { error: 'refused', action: err.action, reason: err.reason });
        }
        if (err instanceof HttpError) return send(res, err.status, { error: err.message });
        console.error(err);
        send(res, 500, { error: 'internal error' });
      }
    })();
  });

  server.listen(PORT, () => {
    console.log(`\n  Patform console API  http://localhost:${PORT}`);
    console.log(`  database             ${describeTarget()}`);
    console.log(`\n  \x1b[33mNo authentication: this server believes the x-actor-id header.`);
    console.log(`  Local use only.\x1b[0m\n`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
