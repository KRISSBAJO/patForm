import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createPool, describeTarget, type Pool } from '../runtime/db.js';
import { Engine } from '../runtime/engine.js';
import { AuthorizationError, requireWorkspaceCapability, WORKSPACE_GRANTS, type Principal } from '../runtime/policy.js';
import type { Capability } from '../blueprint/roles.js';
import {
  devicesFor,
  resolveSession,
  revokeAllSessions,
  signIn,
  signOut,
} from '../runtime/auth.js';
import { runRetention } from '../runtime/retention.js';
import { logIfEnabled, requestIdFrom, withTrace } from '../runtime/trace.js';
import { traceByRequest, traceForInstance } from '../runtime/support.js';
import { dashboard } from '../runtime/metrics.js';
import { authorize, listGrants, registerClient, revokeGrant } from './oauth.js';
import {
  completeRotation,
  listDeliveries,
  listEndpoints,
  registerEndpoint,
  replayDelivery,
  rotateSecret,
} from '../runtime/webhooks.js';
import { applyImport, planImport } from '../runtime/import.js';
import { dataMap } from '../runtime/privacy.js';
import { issueApiKey, listApiKeys, revokeApiKey } from './keys.js';
import { listRecordsPage } from './public.js';
import {
  checkAnswers,
  loadDraft,
  publicForm,
  respondentStatus,
  respondentUpdate,
  saveDraft,
  submitForm,
} from '../runtime/intake.js';
import type { Answers } from '../blueprint/answers.js';
import { ask, confirm, recentRuns, runPlan } from '../runtime/copilot.js';
import { askerFor } from '../copilot/ask.js';
import { availableProviders, providerFor } from '../ai/index.js';
import { QueryPlan, ActionPlan } from '../copilot/plan.js';
import { bundleToCsv, exportRecord } from '../runtime/export.js';
import {
  createDraft,
  discardDraft,
  listForBuilder,
  loadDraft as loadProcessDraft,
  openDraft as openProcessDraft,
  publishDraft,
  publishImpact,
  saveDraft as saveProcessDraft,
  testDraft,
  type NewProcess,
} from '../runtime/builder.js';

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

// ---------------------------------------------------------- public intake
//
// These routes are the only ones a stranger may reach. They serve a published
// form, keep a draft, validate, and submit. Nothing here reads a record: the
// status page needs a resume token, handled in the resume branch below.

route('GET', /^\/api\/forms\/([a-z0-9_]+)$/, async ({ pool, url }) => {
  const key = url.pathname.split('/').pop()!;
  const form = await publicForm(pool, key);
  if (!form) throw new HttpError(404, 'no such form');
  return form;
});

route('POST', /^\/api\/forms\/([a-z0-9_]+)\/check$/, async ({ pool, url }, body) => {
  const key = url.pathname.split('/')[3]!;
  const { answers, pageIndex } = body as { answers?: Answers; pageIndex?: number };
  return checkAnswers(pool, { processKey: key, answers: answers ?? {}, pageIndex });
});

route('POST', /^\/api\/forms\/([a-z0-9_]+)\/draft$/, async ({ pool, url }, body) => {
  const key = url.pathname.split('/')[3]!;
  const { token, answers, page } = body as { token?: string; answers?: Answers; page?: number };
  return saveDraft(pool, { processKey: key, token, answers: answers ?? {}, page: page ?? 0 });
});

route('GET', /^\/api\/forms\/([a-z0-9_]+)\/draft$/, async ({ pool, url }) => {
  const token = url.searchParams.get('token');
  if (!token) throw new HttpError(400, 'token is required');
  const draft = await loadDraft(pool, token);
  if (!draft) throw new HttpError(404, 'that link has expired');
  return draft;
});

route('POST', /^\/api\/forms\/([a-z0-9_]+)\/submit$/, async ({ pool, engine, url }, body) => {
  const key = url.pathname.split('/')[3]!;
  const { token, answers } = body as { token?: string; answers?: Answers };
  const result = await submitForm(pool, { processKey: key, token, answers: answers ?? {} });
  // Deliver the receipt before answering, so the confirmation page is not the
  // only evidence the submission worked.
  if (result.ok) await engine.drain(new Date(), 'intake');
  return result;
});

// ------------------------------------------------------------------ builder

route('GET', /^\/api\/builder\/processes$/, async ({ pool, principal }) =>
  listForBuilder(pool, principal),
);

route('POST', /^\/api\/builder\/open$/, async ({ pool, principal }, body) => {
  const { processKey } = body as { processKey?: string };
  if (!processKey) throw new HttpError(400, 'processKey is required');
  return openProcessDraft(pool, { principal, processKey });
});

route('POST', /^\/api\/builder\/create$/, async ({ pool, principal }, body) =>
  createDraft(pool, { principal, input: body as NewProcess }),
);

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/discard$/, async ({ pool, principal, url }) =>
  discardDraft(pool, { principal, draftId: url.pathname.split('/')[4]! }),
);

route('GET', /^\/api\/builder\/drafts\/([0-9a-f-]{36})$/, async ({ pool, principal, url }) =>
  loadProcessDraft(pool, principal, url.pathname.split('/').pop()!),
);

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/save$/, async ({ pool, principal, url }, body) => {
  const draftId = url.pathname.split('/')[4]!;
  const { blueprint } = body as { blueprint?: unknown };
  if (!blueprint) throw new HttpError(400, 'blueprint is required');
  return saveProcessDraft(pool, { principal, draftId, blueprint });
});

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/test$/, async ({ pool, principal, url }) =>
  testDraft(pool, { principal, draftId: url.pathname.split('/')[4]! }),
);

route('GET', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/impact$/, async ({ pool, principal, url }) =>
  publishImpact(pool, { principal, draftId: url.pathname.split('/')[4]! }),
);

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/publish$/, async ({ pool, principal, url }) =>
  publishDraft(pool, { principal, draftId: url.pathname.split('/')[4]! }),
);


// ------------------------------------------------------------------ copilot
//
// §20.1 step 9. Asking costs a model call and is rate limited; running a plan
// directly does not, which is how the console's own filters reach the same
// permission-filtered path without a provider configured at all.

route('POST', /^\/api\/copilot\/ask$/, async ({ pool, principal }, body) => {
  const { processKey, question } = body as { processKey?: string; question?: string };
  if (!processKey || !question?.trim()) throw new HttpError(400, 'processKey and question are required');

  const available = availableProviders();
  if (!available.length) {
    throw new HttpError(503, 'no AI provider is configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY');
  }
  return ask(pool, askerFor(providerFor(available[0]!)), { principal, processKey, question });
});

route('POST', /^\/api\/copilot\/run$/, async ({ pool, principal }, body) => {
  const { plan, action } = body as { plan?: unknown; action?: unknown };
  const parsed = QueryPlan.safeParse(plan);
  if (!parsed.success) throw new HttpError(400, `that is not a query plan: ${parsed.error.issues[0]?.message}`);
  const parsedAction = action ? ActionPlan.safeParse(action) : null;
  if (parsedAction && !parsedAction.success) {
    throw new HttpError(400, `that is not an action plan: ${parsedAction.error.issues[0]?.message}`);
  }
  const outcome = await runPlan(pool, { principal, plan: parsed.data, action: parsedAction?.data ?? null });
  return { rows: outcome.rows, diagnostics: outcome.diagnostics, ok: outcome.ok, preview: outcome.preview };
});

route('POST', /^\/api\/copilot\/confirm$/, async ({ pool, principal }, body) => {
  const { runId, digest } = body as { runId?: string; digest?: string };
  if (!runId || !digest) throw new HttpError(400, 'runId and digest are required');
  return confirm(pool, { principal, runId, digest });
});

route('GET', /^\/api\/copilot\/runs$/, async ({ pool, principal }) => recentRuns(pool, principal));

// ------------------------------------------------------------------- export
//
// §20.1 step 11. `?format=csv` returns a spreadsheet; the default is the JSON
// bundle, which is the one that round-trips.

route('GET', /^\/api\/records\/([0-9a-f-]{36})\/export$/, async ({ pool, principal, url }) => {
  const instanceId = url.pathname.split('/')[3]!;
  const bundle = await exportRecord(pool, { principal, instanceId });
  if (url.searchParams.get('format') === 'csv') {
    return { filename: `${bundle.record.reference}-export.csv`, contentType: 'text/csv', body: bundleToCsv(bundle) };
  }
  return bundle;
});


// -------------------------------------------------------------- diagnostics
//
// §20.2 supportability: "support can diagnose a failed instance without direct
// database modification". These are the reads that make a psql prompt
// unnecessary rather than forbidden.

route('GET', /^\/api\/records\/([0-9a-f-]{36})\/trace$/, async ({ pool, principal, url }) =>
  traceForInstance(pool, { principal, instanceId: url.pathname.split('/')[3]! }),
);

route('GET', /^\/api\/trace\/([\w.:-]{8,64})$/, async ({ pool, principal, url }) =>
  traceByRequest(pool, { principal, requestId: decodeURIComponent(url.pathname.split('/').pop()!) }),
);


// ----------------------------------------------------------- dashboard etc
//
// The console's own reads. The public, versioned equivalents are in public.ts
// and mounted under /v1 — kept apart so a console convenience does not become
// a published contract by accident.

route('GET', /^\/api\/dashboard\/([a-z0-9_]+)$/, async ({ pool, principal, url }) =>
  dashboard(pool, {
    principal,
    processKey: url.pathname.split('/').pop()!,
    days: Number(url.searchParams.get('days') ?? 30),
  }),
);

route('GET', /^\/api\/browse\/([a-z0-9_]+)$/, async ({ pool, principal, url }) =>
  listRecordsPage(pool, {
    principal,
    processKey: url.pathname.split('/').pop()!,
    state: url.searchParams.get('state') ?? undefined,
    completed: url.searchParams.has('completed') ? url.searchParams.get('completed') === 'true' : undefined,
    limit: Number(url.searchParams.get('limit') ?? 25),
    cursor: url.searchParams.get('cursor') ?? undefined,
  }),
);

route('GET', /^\/api\/data-map$/, async ({ pool, principal }) => dataMap(pool, principal));

// ------------------------------------------------------------------ import

route('POST', /^\/api\/import\/([a-z0-9_]+)\/plan$/, async ({ pool, principal, url }, body) => {
  const { csv } = body as { csv?: string };
  if (!csv) throw new HttpError(400, 'csv is required');
  return planImport(pool, { principal, processKey: url.pathname.split('/')[3]!, csv });
});

route('POST', /^\/api\/import\/([a-z0-9_]+)\/apply$/, async ({ pool, engine, principal, url }, body) => {
  const { csv, partial } = body as { csv?: string; partial?: boolean };
  if (!csv) throw new HttpError(400, 'csv is required');
  const result = await applyImport(pool, { principal, processKey: url.pathname.split('/')[3]!, csv, partial });
  if (result.created.length) await engine.drain(new Date(), 'import');
  return result;
});

// ---------------------------------------------------------------- api keys

route('GET', /^\/api\/keys$/, async ({ pool, principal }) => {
  await requireWorkspaceCapability(pool, principal, 'administer', 'api-keys');
  return listApiKeys(pool, principal.kind === 'actor' ? principal.tenantId : '');
});

route('POST', /^\/api\/keys$/, async ({ pool, principal, actorId }, body) => {
  await requireWorkspaceCapability(pool, principal, 'administer', 'api-keys');
  const { name, scopes } = body as { name?: string; scopes?: string[] };
  if (!name || !scopes?.length) throw new HttpError(400, 'name and scopes are required');
  // The key cannot be broader than the person creating it. Intersected here
  // and again on every request, so a scope cannot outlive the authority it
  // came from.
  const granted = WORKSPACE_GRANTS[
    (await pool.query<{ workspace_role: keyof typeof WORKSPACE_GRANTS }>(
      'select workspace_role from actor where id = $1',
      [actorId],
    )).rows[0]!.workspace_role
  ] as readonly Capability[];
  const tooBroad = scopes.filter((s) => !granted.includes(s as Capability));
  if (tooBroad.length) {
    throw new HttpError(403, `you cannot grant a key ${tooBroad.join(', ')} — you do not hold it yourself`);
  }
  if (principal.kind !== 'actor') throw new HttpError(401, 'sign in first');
  return issueApiKey(pool, { tenantId: principal.tenantId, actorId, name, scopes: scopes as Capability[] });
});

route('POST', /^\/api\/keys\/([0-9a-f-]{36})\/revoke$/, async ({ pool, principal, url }) => {
  await requireWorkspaceCapability(pool, principal, 'administer', 'api-keys');
  if (principal.kind !== 'actor') throw new HttpError(401, 'sign in first');
  return { revoked: await revokeApiKey(pool, { tenantId: principal.tenantId, id: url.pathname.split('/')[3]! }) };
});


// ----------------------------------------------------------------- webhooks
//
// §11.2. The endpoints a customer registers, their signing secrets, and every
// attempt made against them.

route('GET', /^\/api\/webhooks$/, async ({ pool, principal }) => listEndpoints(pool, principal));

route('POST', /^\/api\/webhooks$/, async ({ pool, principal }, body) => {
  const { url, description, events, includeFields } = body as {
    url?: string; description?: string; events?: string[]; includeFields?: string[];
  };
  if (!url) throw new HttpError(400, 'url is required');
  // The secret is returned once, here. It is not readable afterwards.
  return registerEndpoint(pool, { principal, url, description, events, includeFields });
});

route('POST', /^\/api\/webhooks\/([0-9a-f-]{36})\/rotate$/, async ({ pool, principal, url }) =>
  rotateSecret(pool, { principal, endpointId: url.pathname.split('/')[3]! }),
);

route('POST', /^\/api\/webhooks\/([0-9a-f-]{36})\/rotate\/complete$/, async ({ pool, principal, url }) =>
  completeRotation(pool, { principal, endpointId: url.pathname.split('/')[3]! }),
);

route('GET', /^\/api\/webhooks\/deliveries$/, async ({ pool, principal, url }) =>
  listDeliveries(pool, {
    principal,
    instanceId: url.searchParams.get('instance') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
  }),
);

route('POST', /^\/api\/webhooks\/deliveries\/(\d+)\/replay$/, async ({ pool, principal, url }) =>
  replayDelivery(pool, { principal, deliveryId: Number(url.pathname.split('/')[4]!) }),
);


// -------------------------------------------------------------------- oauth
//
// The consent step lives here rather than on the public API: authorizing an
// integration is something a signed-in member does, and the session cookie is
// how we know who they are. The token endpoint is on the public API, because
// that is where the client goes afterwards with no session at all.

route('GET', /^\/api\/oauth\/grants$/, async ({ pool, principal }) => {
  await requireWorkspaceCapability(pool, principal, 'administer', 'oauth');
  if (principal.kind !== 'actor') throw new HttpError(401, 'sign in first');
  return listGrants(pool, principal.tenantId);
});

route('POST', /^\/api\/oauth\/grants\/([0-9a-f-]{36})\/revoke$/, async ({ pool, principal, url }) => {
  await requireWorkspaceCapability(pool, principal, 'administer', 'oauth');
  if (principal.kind !== 'actor') throw new HttpError(401, 'sign in first');
  return { revoked: await revokeGrant(pool, { tenantId: principal.tenantId, grantId: url.pathname.split('/')[4]! }) };
});

route('POST', /^\/api\/oauth\/clients$/, async ({ pool, principal }, body) => {
  await requireWorkspaceCapability(pool, principal, 'administer', 'oauth');
  if (principal.kind !== 'actor') throw new HttpError(401, 'sign in first');
  const { name, redirectUris, confidential } = body as {
    name?: string; redirectUris?: string[]; confidential?: boolean;
  };
  if (!name || !redirectUris?.length) throw new HttpError(400, 'name and redirectUris are required');
  return registerClient(pool, { tenantId: principal.tenantId, name, redirectUris, confidential });
});

// The consent decision itself. A real deployment puts a screen in front of
// this showing the client's name and the scopes; the endpoint is the part that
// must be right either way.
route('POST', /^\/api\/oauth\/authorize$/, async ({ pool, principal, actorId }, body) => {
  if (principal.kind !== 'actor') throw new HttpError(401, 'sign in first');
  const b = body as {
    clientId?: string; redirectUri?: string; scopes?: string[];
    state?: string; codeChallenge?: string; codeChallengeMethod?: string;
  };
  if (!b.clientId || !b.redirectUri || !b.codeChallenge) {
    throw new HttpError(400, 'clientId, redirectUri and codeChallenge are required');
  }
  return authorize(pool, {
    tenantId: principal.tenantId,
    actorId,
    request: {
      clientId: b.clientId,
      redirectUri: b.redirectUri,
      scopes: (b.scopes ?? []) as Capability[],
      state: b.state,
      codeChallenge: b.codeChallenge,
      codeChallengeMethod: b.codeChallengeMethod ?? 'S256',
    },
  });
});

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
    // x-request-id so a caller can supply their own correlation id, and read
    // it back off the response.
    'access-control-allow-headers': 'content-type, x-request-id',
    'access-control-expose-headers': 'x-request-id',
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
    /*
     * One trace per request, opened before anything else.
     *
     * Everything the request causes — events, outbox rows, action runs, and
     * the worker runs that come minutes later — is stamped with this id. The
     * client gets it back in `x-request-id` whether the call succeeded or not,
     * because the id is most useful on the call that failed.
     */
    const requestId = requestIdFrom(req.headers['x-request-id']);
    res.setHeader('x-request-id', requestId);

    void withTrace({ requestId, source: 'api' }, async () => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
      const started = Date.now();

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
        // ---- a resume link: one record, read or clarify, nothing else
        const resume = url.searchParams.get('resume') ?? readCookie(req, RESUME_COOKIE);
        if (resume) {
          if (url.pathname === '/api/status' && req.method === 'GET') {
            const status = await respondentStatus(pool, resume);
            if (!status) throw new HttpError(401, 'that link has expired');
            return send(res, 200, status);
          }
          if (url.pathname === '/api/status/update' && req.method === 'POST') {
            const { patch } = (await readBody(req)) as { patch?: Answers };
            const result = await respondentUpdate(pool, { resumeToken: resume, patch: patch ?? {} });
            if (result.advanced) await engine.drain(new Date(), 'intake');
            return send(res, 200, result);
          }
          throw new HttpError(404, 'a resume link does not reach that');
        }

        // ---- the public form needs no session at all
        if (url.pathname.startsWith('/api/forms/')) {
          const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
          if (!match) throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
          const body = req.method === 'POST' ? await readBody(req) : {};
          const anonymous: Principal = { kind: 'respondent', tenantId: '' };
          return send(res, 200, await match.handler({ engine, pool, principal: anonymous, actorId: '', url }, body));
        }

        const session = await resolveSession(pool, readCookie(req, SESSION_COOKIE) ?? '');
        if (!session) throw new HttpError(401, 'sign in first');

        const actorId = session.actorId;
        const principal: Principal = { kind: 'actor', tenantId: session.tenantId, actorId };
        const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
        if (!match) throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);

        const body = req.method === 'POST' ? await readBody(req) : {};
        const result = await match.handler({ engine, pool, principal, actorId, url }, body);
        logIfEnabled('info', 'api.request', {
          method: req.method,
          path: url.pathname,
          status: 200,
          ms: Date.now() - started,
        });
        send(res, 200, result);
      } catch (err) {
        const status =
          err instanceof AuthorizationError ? 403 : err instanceof HttpError ? err.status : 500;
        logIfEnabled(status >= 500 ? 'error' : 'warn', 'api.request', {
          method: req.method,
          path: url.pathname,
          status,
          ms: Date.now() - started,
          // The message, not the record: §10.1's "tenant-safe support
          // diagnostics" means a log line carries identifiers and text this
          // codebase wrote, never a respondent's answers.
          detail: err instanceof Error ? err.message : String(err),
        });

        if (err instanceof AuthorizationError) {
          // The reason is deliberately returned: an operator who cannot act
          // needs to know whether to ask for access or ask someone else.
          return send(res, 403, { error: 'refused', action: err.action, reason: err.reason });
        }
        if (err instanceof HttpError) return send(res, err.status, { error: err.message });
        console.error(err);
        send(res, 500, { error: 'internal error', requestId });
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`\n  Patform console API  http://localhost:${PORT}`);
    console.log(`  database             ${describeTarget()}`);
    // This line used to say the server believed an `x-actor-id` header. It
    // stopped being true when session cookies went in, and a banner that
    // understates the security posture is as misleading as one that
    // overstates it — somebody reads it and decides what to expose.
    console.log(`  auth                 session cookie, HttpOnly, SameSite=Lax${SECURE ? ', Secure' : ''}`);
    if (!SECURE) {
      const warn = '\u001b[33m';
      const off = '\u001b[0m';
      console.log(`\n  ${warn}Secure is off, so the session cookie travels over plain HTTP.`);
      console.log(`  Set NODE_ENV=production behind TLS before this is reachable from anywhere else.${off}`);
    }
    console.log('');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
