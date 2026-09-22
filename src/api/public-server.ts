import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createPool, describeTarget, type Pool } from '../runtime/db.js';
import { Engine } from '../runtime/engine.js';
import { AuthorizationError, type Principal } from '../runtime/policy.js';
import { logIfEnabled, requestIdFrom, withTrace } from '../runtime/trace.js';
import { resolveApiKey, takeRateTokenShared } from './keys.js';
import {
  API_VERSION,
  ApiError,
  apiErrors,
  getRecord,
  listRecordsPage,
  type RecordOrder,
  SCOPE_FOR,
  withIdempotency,
} from './public.js';
import { dashboard } from '../runtime/metrics.js';
import { applyImport } from '../runtime/import.js';
import { publicForm, submitForm } from '../runtime/intake.js';
import { OPENAPI } from './openapi.js';
import { exchangeCode, OAuthError, refresh, resolveAccessToken } from './oauth.js';
import type { Capability } from '../blueprint/roles.js';

/**
 * The public API server, §11.1.
 *
 * Its own process on its own port, deliberately. The console's API is called
 * by a page that ships with it and can change together with it; this is called
 * by somebody else's build, which cannot. Running them separately means a
 * console route cannot become a public promise by being reachable, and the two
 * can be rate-limited, scaled and taken down independently.
 *
 * Authentication is a scoped API key, never a session cookie. A cookie here
 * would make every public endpoint reachable from a browser carrying a console
 * session, which is CSRF with extra steps.
 */

const PORT = Number(process.env.PUBLIC_API_PORT ?? 3320);
const RATE_LIMIT = Number(process.env.PUBLIC_API_RATE_LIMIT ?? 120);

interface Ctx {
  pool: Pool;
  engine: Engine;
  principal: Principal;
  scopes: Capability[];
  url: URL;
  idempotencyKey: string | undefined;
}

type Handler = (ctx: Ctx, body: unknown) => Promise<{ status?: number; body: unknown }>;

const routes: { method: string; pattern: RegExp; name: string; handler: Handler }[] = [];

function route(method: string, pattern: RegExp, name: string, handler: Handler): void {
  routes.push({ method, pattern, name, handler });
}

/**
 * Every route names the scope it needs, and the check is here rather than in
 * each handler. A handler that forgets is the failure this file exists to make
 * impossible — so an unlisted route is refused rather than allowed.
 */
function requireScope(name: string, scopes: Capability[]): void {
  const needed = SCOPE_FOR[name];
  if (!needed) throw apiErrors.forbidden(`no scope is defined for ${name}`);
  if (!scopes.includes(needed)) {
    throw apiErrors.forbidden(`this key does not carry the "${needed}" scope`, { required: needed, granted: scopes });
  }
}

// ------------------------------------------------------------------- routes

route('GET', /^\/v1\/processes$/, 'GET /processes', async ({ pool, principal }) => {
  if (principal.kind !== 'actor') throw apiErrors.unauthorized('key does not resolve to a member');
  const { rows } = await pool.query<{ process_key: string; name: string; version: number }>(
    `select distinct on (process_key) process_key, blueprint ->> 'name' as name, version
       from process_version where tenant_id = $1 order by process_key, version desc`,
    [principal.tenantId],
  );
  return { body: { data: rows.map((r) => ({ key: r.process_key, name: r.name, version: r.version })) } };
});

route('GET', /^\/v1\/records$/, 'GET /records', async ({ pool, principal, url }) => {
  const processKey = url.searchParams.get('process');
  if (!processKey) throw apiErrors.validation('process is required');

  // Explicit filtering: a parameter this does not recognise is refused rather
  // than ignored. Silently returning everything when a caller asked for a
  // subset is how an integration leaks.
  const known = new Set(['process', 'state', 'completed', 'limit', 'cursor', 'updated_since', 'q', 'order']);
  const unknown = [...url.searchParams.keys()].filter((k) => !known.has(k));
  if (unknown.length) throw apiErrors.validation(`unknown filter: ${unknown.join(', ')}`, { known: [...known] });

  const since = url.searchParams.get('updated_since');
  return {
    body: await listRecordsPage(pool, {
      principal,
      processKey,
      state: url.searchParams.get('state') ?? undefined,
      completed: url.searchParams.has('completed') ? url.searchParams.get('completed') === 'true' : undefined,
      updatedSince: since ? new Date(since) : undefined,
      // Same search and same orders as the console's list, because it is the
      // same function — the console is a client of this API and not a
      // privileged path around it.
      query: url.searchParams.get('q') ?? undefined,
      order: (url.searchParams.get('order') as RecordOrder | null) ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 25),
      cursor: url.searchParams.get('cursor') ?? undefined,
    }),
  };
});

route('GET', /^\/v1\/records\/([0-9a-f-]{36})$/, 'GET /records/:id', async ({ pool, principal, url }) => ({
  body: await getRecord(pool, { principal, instanceId: url.pathname.split('/').pop()! }),
}));

route('POST', /^\/v1\/records$/, 'POST /records', async ({ pool, engine, principal, idempotencyKey }, body) => {
  if (principal.kind !== 'actor') throw apiErrors.unauthorized('key does not resolve to a member');
  const { process: processKey, data } = (body ?? {}) as { process?: string; data?: Record<string, unknown> };
  if (!processKey) throw apiErrors.validation('process is required');

  const result = await withIdempotency(pool, { tenantId: principal.tenantId, key: idempotencyKey, body }, async () => {
    const outcome = await submitForm(pool, { processKey, answers: (data ?? {}) as never });
    if (!outcome.ok) {
      throw apiErrors.validation('some answers are not acceptable', { problems: outcome.errors });
    }
    await engine.drain(new Date(), 'public-api');
    return {
      status: 201,
      body: {
        id: outcome.instanceId,
        reference: outcome.instanceId!.slice(0, 8).toUpperCase(),
        duplicate: outcome.duplicate,
      },
    };
  });

  return { status: result.status, body: result.body };
});

route('GET', /^\/v1\/metrics$/, 'GET /metrics', async ({ pool, principal, url }) => {
  const processKey = url.searchParams.get('process');
  if (!processKey) throw apiErrors.validation('process is required');
  return {
    body: await dashboard(pool, { principal, processKey, days: Number(url.searchParams.get('days') ?? 30) }),
  };
});

route('POST', /^\/v1\/imports$/, 'POST /imports', async ({ pool, engine, principal, idempotencyKey }, body) => {
  if (principal.kind !== 'actor') throw apiErrors.unauthorized('key does not resolve to a member');
  const { process: processKey, csv, partial } = (body ?? {}) as { process?: string; csv?: string; partial?: boolean };
  if (!processKey || !csv) throw apiErrors.validation('process and csv are required');

  const result = await withIdempotency(pool, { tenantId: principal.tenantId, key: idempotencyKey, body }, async () => {
    const outcome = await applyImport(pool, { principal, processKey, csv, partial });
    if (outcome.created.length) await engine.drain(new Date(), 'public-api');
    return { status: outcome.applied ? 201 : 422, body: outcome };
  });
  return { status: result.status, body: result.body };
});

// ------------------------------------------------------------------ serving

function send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** The raw body, for the form-encoded token endpoint. */
async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A CSV import is the largest legitimate body; past this it is a mistake
    // or an attack, and either way the answer is the same.
    if (size > 8 * 1024 * 1024) throw apiErrors.validation('request body is too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw apiErrors.validation('request body is not JSON');
  }
}

async function main(): Promise<void> {
  const pool = createPool();
  const engine = new Engine(pool);

  const server = createServer((req, res) => {
    const requestId = requestIdFrom(req.headers['x-request-id']);
    res.setHeader('x-request-id', requestId);

    void withTrace({ requestId, source: 'public-api' }, async () => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
      const started = Date.now();

      try {
        if (url.pathname === '/health') return send(res, 200, { ok: true, version: API_VERSION });
        // §11.1 asks for OpenAPI documentation. Served from the API itself so
        // it cannot drift from the deployment it describes.
        if (url.pathname === '/openapi.json') return send(res, 200, OPENAPI);

        /*
         * The token endpoint is before authentication, necessarily: it is how
         * a client gets something to authenticate with. It is form-encoded
         * because that is what the RFC specifies and what every OAuth client
         * library sends.
         */
        if (url.pathname === '/oauth/token' && req.method === 'POST') {
          const form = new URLSearchParams(await readRaw(req));
          try {
            const grantType = form.get('grant_type');
            if (grantType === 'authorization_code') {
              return send(res, 200, await exchangeCode(pool, {
                code: form.get('code') ?? '',
                clientId: form.get('client_id') ?? '',
                clientSecret: form.get('client_secret') ?? undefined,
                redirectUri: form.get('redirect_uri') ?? '',
                codeVerifier: form.get('code_verifier') ?? '',
              }), { 'cache-control': 'no-store' });
            }
            if (grantType === 'refresh_token') {
              return send(res, 200, await refresh(pool, {
                refreshToken: form.get('refresh_token') ?? '',
                clientId: form.get('client_id') ?? '',
                clientSecret: form.get('client_secret') ?? undefined,
              }), { 'cache-control': 'no-store' });
            }
            throw new OAuthError(400, 'unsupported_grant_type',
              'only authorization_code and refresh_token are supported; implicit and password are removed in OAuth 2.1');
          } catch (err) {
            if (err instanceof OAuthError) {
              // The RFC's error shape, not this API's: an OAuth client library
              // is parsing it.
              return send(res, err.status, { error: err.code, error_description: err.message });
            }
            throw err;
          }
        }

        const header = req.headers.authorization ?? '';
        const [scheme, token] = header.split(' ');
        if (scheme !== 'Bearer' || !token) {
          throw apiErrors.unauthorized('Send a credential as "Authorization: Bearer …".');
        }

        /*
         * Two kinds of credential, one header.
         *
         * `pat_live_` is a key somebody's own server holds; `pat_at_` is an
         * access token an installed integration was granted. They differ in
         * how they were obtained and not at all in what the routes do with
         * them, so they resolve to the same shape here and every check
         * downstream is identical.
         */
        const asKey = await resolveApiKey(pool, token);
        const asOAuth = asKey ? null : await resolveAccessToken(pool, token);
        const resolved = asKey
          ? { tenantId: asKey.record.tenantId, actorId: asKey.record.actorId, scopes: asKey.scopes, id: asKey.record.id }
          : asOAuth
            ? { tenantId: asOAuth.tenantId, actorId: asOAuth.actorId, scopes: asOAuth.scopes, id: asOAuth.clientId }
            : null;
        if (!resolved) throw apiErrors.unauthorized('That credential is not valid, has expired, or was revoked.');

        // Tenant- and credential-aware, so ten keys in one workspace do not
        // buy ten times the budget.
        const verdict = await takeRateTokenShared(`${resolved.tenantId}:${resolved.id}`, RATE_LIMIT);
        const rateHeaders = {
          'x-ratelimit-limit': String(verdict.limit),
          'x-ratelimit-remaining': String(verdict.remaining),
          'x-ratelimit-reset': String(Math.ceil(verdict.resetAt / 1000)),
          // Whether the count is shared across processes or local to this one.
          // An integrator debugging a limit that seems too generous deserves
          // to know which they are hitting.
          'x-ratelimit-scope': verdict.shared ? 'shared' : 'process',
        };
        if (!verdict.ok) {
          throw Object.assign(apiErrors.rateLimited(verdict.retryAfterSeconds), { headers: rateHeaders });
        }

        const principal: Principal = {
          kind: 'actor',
          tenantId: resolved.tenantId,
          actorId: resolved.actorId,
        };

        const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
        if (!match) throw apiErrors.notFound(`no route for ${req.method} ${url.pathname}`);
        requireScope(match.name, resolved.scopes);

        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.trim() || undefined;

        const result = await match.handler(
          { pool, engine, principal, scopes: resolved.scopes, url, idempotencyKey },
          body,
        );

        logIfEnabled('info', 'public.request', {
          method: req.method,
          route: match.name,
          status: result.status ?? 200,
          ms: Date.now() - started,
          credentialId: resolved.id,
        });
        send(res, result.status ?? 200, result.body, rateHeaders);
      } catch (err) {
        const status = err instanceof ApiError ? err.status : err instanceof AuthorizationError ? 403 : 500;
        logIfEnabled(status >= 500 ? 'error' : 'warn', 'public.request', {
          method: req.method,
          path: url.pathname,
          status,
          ms: Date.now() - started,
          detail: err instanceof Error ? err.message : String(err),
        });

        /*
         * One error shape, always, with the request id on it. §11.1 asks for
         * consistent errors, and the reason to care is a support conversation:
         * a caller who can quote an id and a type gets an answer in a minute.
         */
        if (err instanceof ApiError) {
          return send(
            res,
            err.status,
            { error: { type: err.type, message: err.message, request_id: requestId, ...err.detail } },
            (err as ApiError & { headers?: Record<string, string> }).headers ?? {},
          );
        }
        if (err instanceof AuthorizationError) {
          return send(res, 403, {
            error: { type: 'forbidden', message: err.reason, action: err.action, request_id: requestId },
          });
        }
        console.error(err);
        send(res, 500, { error: { type: 'internal_error', message: 'Something went wrong.', request_id: requestId } });
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`\n  Patform public API  http://localhost:${PORT}/${API_VERSION}`);
    console.log(`  database            ${describeTarget()}`);
    console.log(`  documentation       http://localhost:${PORT}/openapi.json`);
    console.log(`  rate limit          ${RATE_LIMIT} requests a minute per key\n`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
