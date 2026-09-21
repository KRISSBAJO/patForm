import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createPool, describeTarget, type Pool } from '../runtime/db.js';
import { Engine } from '../runtime/engine.js';
import { AuthorizationError, type Principal } from '../runtime/policy.js';
import {
  devicesFor,
  resolveResumeToken,
  resolveSession,
  revokeAllSessions,
  signIn,
  signOut,
} from '../runtime/auth.js';
import { runRetention } from '../runtime/retention.js';

/**
 * The operator console's API.
 *
 * Authentication is a session cookie: `POST /api/auth/login` checks a scrypt
 * hash and issues an opaque token whose SHA-256 is what the database stores.
 * The cookie is HttpOnly, SameSite=Lax and — outside development — Secure, so
 * script on the page cannot read it and another site cannot ride it.
 *
 * It used to read an `x-actor-id` header and believe it, which meant anyone
 * who could reach this port could be anyone. That header is gone, and so is
 * the `/api/seats` endpoint that listed actor ids to choose from: with the
 * header trusted, that endpoint was a list of usable credentials.
 *
 * Still not built, and named here rather than implied by silence: email
 * verification, MFA, OAuth/OIDC, and password reset.
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

// ------------------------------------------------------------------ session

route('GET', /^\/api\/session$/, async ({ engine, pool, actorId }) => {
  const actor = await engine.actor(actorId);
  if (!actor) throw new HttpError(401, 'unknown actor');
  const [processes, devices] = await Promise.all([
    engine.processesFor(actor.tenant_id, actorId),
    devicesFor(pool, actorId),
  ]);
  return { actor, processes, devices };
});

/** §6.1 IAM-04: revoke sessions. Signing out everywhere is its own control. */
route('POST', /^\/api\/session\/revoke-all$/, async ({ pool, actorId }) => {
  const revoked = await revokeAllSessions(pool, actorId);
  return { revoked };
});

// -------------------------------------------------------------- retention

route('POST', /^\/api\/retention$/, async ({ engine, pool, principal, actorId }, body) => {
  const { processKey, preview } = body as { processKey?: string; preview?: boolean };
  if (!processKey) throw new HttpError(400, 'processKey is required');
  const actor = await engine.actor(actorId);
  if (!actor) throw new HttpError(401, 'unknown actor');
  return runRetention(pool, {
    principal,
    tenantId: actor.tenant_id,
    processKey,
    preview: preview !== false,
  });
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

const SESSION_COOKIE = 'patform_session';
const RESUME_COOKIE = 'patform_resume';
const SECURE = process.env.NODE_ENV === 'production';

function cookie(name: string, value: string, expires: Date): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`,
  ];
  if (SECURE) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function send(res: ServerResponse, status: number, payload: unknown, cookies: string[] = []): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // The console is served from another origin in development.
    'access-control-allow-origin': process.env.CONSOLE_ORIGIN ?? 'http://localhost:3210',
    'access-control-allow-headers': 'content-type, x-actor-id',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-credentials': 'true',
    ...(cookies.length ? { 'set-cookie': cookies } : {}),
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
        // ---- login and logout are the only routes before authentication
        if (url.pathname === '/api/auth/login' && req.method === 'POST') {
          const { email, password } = (await readBody(req)) as { email?: string; password?: string };
          if (!email || !password) throw new HttpError(400, 'email and password are required');
          const result = await signIn(pool, { email, password, userAgent: req.headers['user-agent'] });
          // One message for every failure, so the response cannot be used to
          // find out which addresses have accounts.
          if (!result) return send(res, 401, { error: 'those details do not match an account' });
          return send(
            res,
            200,
            { actor: result.actor },
            [cookie(SESSION_COOKIE, result.token, result.expiresAt)],
          );
        }

        if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
          const token = readCookie(req, SESSION_COOKIE);
          if (token) await signOut(pool, token);
          return send(res, 200, { ok: true }, [cookie(SESSION_COOKIE, '', new Date(0))]);
        }

        // ---- a respondent's resume link scopes them to one record
        const resume = url.searchParams.get('resume') ?? readCookie(req, RESUME_COOKIE);
        if (resume) {
          const scope = await resolveResumeToken(pool, resume);
          if (!scope) throw new HttpError(401, 'that link has expired');
          const principal: Principal = { kind: 'respondent', ...scope };
          const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
          if (!match) throw new HttpError(404, 'not available on a resume link');
          const result = await match.handler({ engine, pool, principal, actorId: '', url }, {});
          return send(res, 200, result);
        }

        const session = await resolveSession(pool, readCookie(req, SESSION_COOKIE) ?? '');
        if (!session) throw new HttpError(401, 'sign in first');

        const actorId = session.actorId;
        const principal: Principal = { kind: 'actor', tenantId: session.tenantId, actorId };
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
