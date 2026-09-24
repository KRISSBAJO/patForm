import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { applyUpgrades, createPool, describeTarget, type Pool } from '../runtime/db.js';
import { changePlatformPerson, grantPlatformOperator, platformAudit, platformIntegrations, platformJobs, platformMail, platformOperators, platformPeople, platformSecurity,
  platformOverview, platformWorkspace, platformWorkspaces, requirePlatformRole,
  renamePlatformWorkspace, retryPlatformJob, revokePlatformApiKey, revokePlatformOperator, revokePlatformSessions,
  setPlatformIntakePaused, setPlatformWebhookActive, platformTrace } from '../runtime/platform-admin.js';
import { Engine } from '../runtime/engine.js';
import { AuthorizationError, requireWorkspaceCapability, WORKSPACE_GRANTS, type Principal } from '../runtime/policy.js';
import type { Capability } from '../blueprint/roles.js';
import {
  devicesFor,
  needsSecondFactor,
  resolveSession,
  revokeAllSessions,
  signIn,
  signOut,
  startSession,
} from '../runtime/auth.js';
import { runRetention } from '../runtime/retention.js';
import { logIfEnabled, requestIdFrom, withTrace } from '../runtime/trace.js';
import { callerFor, limitFor, processKeyFrom, takeIntakeToken } from './intake-limits.js';
import { traceByRequest, traceForInstance } from '../runtime/support.js';
import { dashboard } from '../runtime/metrics.js';
import {
  acceptInvitation,
  changeRole,
  createWorkspace,
  grantableRoles,
  invite,
  inviteMany,
  listInvitations,
  listMembers,
  readInvitation,
  revokeInvitation,
  setMemberActive,
  InvalidInput,
} from '../runtime/workspace.js';
import { requestPasswordReset, resetPassword, sendVerification, verifyEmail } from '../runtime/account.js';
import { DraftConflict } from '../runtime/errors.js';
import { assertScreeningConfigured, issueTicket, screen, TRAP_FIELD } from '../runtime/screening.js';
import { resolveForm } from '../runtime/form-links.js';
import { receiptDownload, receiptStatus, uploadReceipt } from '../runtime/receipt-files.js';
import { assertSecretKeyConfigured } from '../runtime/secret-box.js';
import { isFresh, reauthenticate, stepUpFor } from '../runtime/step-up.js';
import { isEnabled as mfaIsEnabled } from '../runtime/mfa.js';
import { FormLinkError, NotFound } from '../runtime/errors.js';
import { discardHeld, listHeld, releaseHeld } from '../runtime/held.js';
import { resendSkipped, sendingHealth, skippedFor } from '../runtime/delivery-health.js';
import {
  answerChallenge,
  beginEnrolment,
  confirmEnrolment,
  disable as disableMfa,
  regenerateRecoveryCodes,
  statusFor as mfaStatusFor,
} from '../runtime/mfa.js';
import {
  eventsFor,
  ingest,
  lift,
  suppressByHand,
  suppressionsFor,
  verifyRelyKit,
  type ProviderEvent,
} from '../runtime/delivery.js';
import type { WorkspaceRole } from '../runtime/policy.js';
import { installPack, listInstalls, listPacks, publishPack, readPack } from '../runtime/packs.js';
import { assignProcessRole, inviteProcessMember, processSetup } from '../runtime/process-setup.js';
import { authorize, denyRequest, describeRequest, listGrants, OAuthError, parseAuthorizeQuery, registerClient, revokeGrant } from './oauth.js';
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
import { listRecordsPage, type RecordOrder } from './public.js';
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
import { ask, bulkOptions, confirm, recentRuns, runDirect } from '../runtime/copilot.js';
import { askerFor } from '../copilot/ask.js';
import { availableProviders, preferredProvider } from '../ai/index.js';
import { proposeRule } from '../ai/rule.js';
import { Blueprint } from '../blueprint/index.js';
import { QueryPlan, ActionPlan } from '../copilot/plan.js';
import { bundleToCsv, exportRecord } from '../runtime/export.js';
import {
  claimDraft,
  createDraft,
  discardDraft,
  listForBuilder,
  releaseDraft,
  loadDraft as loadProcessDraft,
  openDraft as openProcessDraft,
  publishDraft,
  publishImpact,
  saveDraft as saveProcessDraft,
  testDraft,
  testVersion,
  viewProcess,
  type NewProcess,
  versionHistory,
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

const PORT = Number(process.env.API_PORT ?? process.env.PORT ?? 3310);

interface Ctx {
  engine: Engine;
  pool: Pool;
  principal: Principal;
  actorId: string;
  url: URL;
  /** The signed-in session, where there is one. Absent on the public form routes. */
  session?: { sessionId: string; authenticatedAt: Date };
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

route('GET', /^\/api\/forms\/([a-z0-9_-]+)$/, async ({ pool, url }) => {
  const key = url.pathname.split('/').pop()!;
  const form = await publicForm(pool, key);
  if (!form) throw new HttpError(404, 'no such form');
  // The ticket that says this form was loaded, and when. Signed for the
  // form's public id — one workspace's form — not for whatever the URL said.
  return { ...form, ticket: issueTicket(form.publicId), trap: TRAP_FIELD };
});

route('POST', /^\/api\/forms\/([a-z0-9_-]+)\/check$/, async ({ pool, url }, body) => {
  const key = url.pathname.split('/')[3]!;
  const { answers, pageIndex } = body as { answers?: Answers; pageIndex?: number };
  return checkAnswers(pool, { processKey: key, answers: answers ?? {}, pageIndex });
});

route('POST', /^\/api\/forms\/([a-z0-9_-]+)\/draft$/, async ({ pool, url }, body) => {
  const key = url.pathname.split('/')[3]!;
  const { token, answers, page } = body as { token?: string; answers?: Answers; page?: number };
  return saveDraft(pool, { processKey: key, token, answers: answers ?? {}, page: page ?? 0 });
});

route('GET', /^\/api\/forms\/([a-z0-9_-]+)\/draft$/, async ({ pool, url }) => {
  const token = url.searchParams.get('token');
  if (!token) throw new HttpError(400, 'token is required');
  const draft = await loadDraft(pool, token, url.pathname.split('/')[3]!);
  if (!draft) throw new HttpError(404, 'that link has expired');
  return draft;
});

route('POST', /^\/api\/forms\/([a-z0-9_-]+)\/receipts$/, async ({ pool, url }, body) => {
  const key = url.pathname.split('/')[3]!;
  const { token, fieldKey, filename, base64 } = body as Record<string, string>;
  if (![token, fieldKey, filename, base64].every((value) => typeof value === 'string' && value.length)) {
    throw new HttpError(400, 'draft token, field, filename and file are required');
  }
  return uploadReceipt(pool, { form: key, token: token!, fieldKey: fieldKey!, filename: filename!, base64: base64! });
});

route('GET', /^\/api\/forms\/([a-z0-9_-]+)\/receipts\/([0-9a-f-]{36})$/, async ({ pool, url }) => {
  const parts = url.pathname.split('/');
  const token = url.searchParams.get('token');
  if (!token) throw new HttpError(400, 'draft token is required');
  return receiptStatus(pool, { form: parts[3]!, token, reference: `receipt-file:${parts[5]}` });
});

route('POST', /^\/api\/forms\/([a-z0-9_-]+)\/submit$/, async ({ pool, engine, url }, body) => {
  const key = url.pathname.split('/')[3]!;
  const { token, answers, ticket, trap } = body as { token?: string; answers?: Answers; ticket?: unknown; trap?: unknown };
  const screening = screen({ processKey: (await resolveForm(pool, key)).publicId, ticket, trap });
  const { held, ...result } = await submitForm(pool, { processKey: key, token, answers: answers ?? {}, screening });
  if (held) {
    // The reasons, never the answers: a log line is not where unvetted
    // personal data should end up.
    logIfEnabled('warn', 'intake.held', { process: key, reasons: screening.reasons, elapsedMs: screening.elapsedMs });
    return result;
  }
  // Deliver the receipt before answering, so the confirmation page is not the
  // only evidence the submission worked.
  if (result.ok) await engine.drain(new Date(), 'intake');
  return result;
});

// ------------------------------------------------------------ held intake
//
// What screening kept back. Listing, releasing and discarding each check
// `operate` on the process inside runtime/held.ts.

route('GET', /^\/api\/held$/, async ({ pool, principal }) => ({ held: await listHeld(pool, principal) }));

route('POST', /^\/api\/held\/([0-9a-f-]{36})\/release$/, async ({ pool, engine, principal, url }) => {
  const released = await releaseHeld(pool, { principal, heldId: url.pathname.split('/')[3]! });
  // Its receipt and its first approval request go now, as they would have.
  await engine.drain(new Date(), 'intake');
  return released;
});

route('POST', /^\/api\/held\/([0-9a-f-]{36})\/discard$/, async ({ pool, principal, url }) =>
  discardHeld(pool, { principal, heldId: url.pathname.split('/')[3]! }),
);

// ------------------------------------------------------------------ builder

route('GET', /^\/api\/builder\/processes$/, async ({ pool, principal }) =>
  listForBuilder(pool, principal),
);

/**
 * Every published version of one process, and what changed at each.
 *
 * Read from `process_version`, which is append-only and refuses UPDATE by
 * trigger — so this is the history rather than a story about it.
 */
route('GET', /^\/api\/builder\/processes\/([A-Za-z0-9_.-]+)\/versions$/, async ({ pool, principal, url }) =>
  versionHistory(pool, principal, decodeURIComponent(url.pathname.split('/')[4]!)),
);

/**
 * A process as the Preview, Versions and Tests pages show it: `?which=draft`,
 * `latest` (the default), or a version number.
 */
route('GET', /^\/api\/builder\/processes\/([A-Za-z0-9_.-]+)\/view$/, async ({ pool, principal, url }) => {
  const raw = url.searchParams.get('which') ?? 'latest';
  const which = raw === 'draft' || raw === 'latest' ? raw : Number(raw);
  if (typeof which === 'number' && !(Number.isInteger(which) && which > 0)) {
    throw new HttpError(400, 'which is draft, latest, or a version number');
  }
  return viewProcess(pool, principal, decodeURIComponent(url.pathname.split('/')[4]!), which);
});

/** Runs one published version's scenarios again, against the engine as it is now. */
route('POST', /^\/api\/builder\/processes\/([A-Za-z0-9_.-]+)\/versions\/(\d+)\/test$/, async ({ pool, principal, url }) => {
  const parts = url.pathname.split('/');
  return testVersion(pool, { principal, processKey: decodeURIComponent(parts[4]!), version: Number(parts[6]) });
});

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

route('GET', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/setup$/, async ({ pool, principal, url }) =>
  processSetup(pool, principal, url.pathname.split('/')[4]!),
);

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/setup\/assign$/, async ({ pool, principal, url }, body) => {
  const { roleKey, actorId, assigned } = (body ?? {}) as { roleKey?: string; actorId?: string; assigned?: boolean };
  if (!roleKey || !actorId || typeof assigned !== 'boolean') throw new HttpError(400, 'roleKey, actorId and assigned are required');
  return assignProcessRole(pool, { principal, draftId: url.pathname.split('/')[4]!, roleKey, actorId, assigned });
});

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/setup\/invite$/, async ({ pool, principal, url }, body) => {
  const { roleKey, email } = (body ?? {}) as { roleKey?: string; email?: string };
  if (!roleKey || !email) throw new HttpError(400, 'roleKey and email are required');
  return inviteProcessMember(pool, { principal, draftId: url.pathname.split('/')[4]!, roleKey, email });
});

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/save$/, async ({ pool, principal, url }, body) => {
  const draftId = url.pathname.split('/')[4]!;
  const { blueprint, baseRevision } = body as { blueprint?: unknown; baseRevision?: unknown };
  if (!blueprint) throw new HttpError(400, 'blueprint is required');
  // Required, not defaulted. A save that does not say what it was made
  // against is exactly the last-write-wins this exists to stop.
  if (!Number.isInteger(baseRevision)) throw new HttpError(400, 'baseRevision is required');
  return saveProcessDraft(pool, { principal, draftId, blueprint, baseRevision: baseRevision as number });
});

// The editing lease. `claim` also renews; the builder calls it every forty
// seconds while the draft is open, and `release` when the tab goes away.
route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/claim$/, async ({ pool, principal, url }, body) => {
  const { takeOver } = (body ?? {}) as { takeOver?: boolean };
  return claimDraft(pool, { principal, draftId: url.pathname.split('/')[4]!, takeOver: takeOver === true });
});

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/release$/, async ({ pool, principal, url }) =>
  releaseDraft(pool, { principal, draftId: url.pathname.split('/')[4]! }),
);

/**
 * A sentence becomes one automation rule.
 *
 * Returns a proposal and never writes: the reading goes back with the
 * transition, somebody accepts it in the builder, and the ordinary save path
 * stores it like any other edit. Same boundary as the copilot — the model
 * proposes, the compiler decides, a person applies.
 */
route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/rule$/, async ({ pool, principal, url }, body) => {
  const { sentence } = body as { sentence?: string };
  if (!sentence?.trim()) throw new HttpError(400, 'sentence is required');

  const available = availableProviders();
  if (!available.length) {
    throw new HttpError(503, 'no AI provider is configured — set DEEPSEEK_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY');
  }

  // Read through the same permission-checked path the builder uses, so this
  // cannot reach a draft the caller could not open.
  const draft = await loadProcessDraft(pool, principal, url.pathname.split('/')[4]!);
  const parsed = Blueprint.safeParse(draft.blueprint);
  if (!parsed.success) {
    throw new HttpError(400, 'this draft does not parse yet — fix the errors before asking for a rule');
  }

  return proposeRule(preferredProvider(), { sentence, blueprint: parsed.data });
});

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/test$/, async ({ pool, principal, url }) =>
  testDraft(pool, { principal, draftId: url.pathname.split('/')[4]! }),
);

route('GET', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/impact$/, async ({ pool, principal, url }) =>
  publishImpact(pool, { principal, draftId: url.pathname.split('/')[4]! }),
);

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/publish$/, async ({ pool, principal, url }, body) => {
  const { revision } = (body ?? {}) as { revision?: unknown };
  if (!Number.isInteger(revision)) throw new HttpError(400, 'revision is required — publish what you reviewed');
  return publishDraft(pool, { principal, draftId: url.pathname.split('/')[4]!, revision: revision as number });
});


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
    throw new HttpError(503, 'no AI provider is configured — set DEEPSEEK_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY');
  }
  return ask(pool, askerFor(preferredProvider()), { principal, processKey, question });
});

route('POST', /^\/api\/copilot\/run$/, async ({ pool, principal }, body) => {
  const { plan, action, label } = body as { plan?: unknown; action?: unknown; label?: string };
  const parsed = QueryPlan.safeParse(plan);
  if (!parsed.success) throw new HttpError(400, `that is not a query plan: ${parsed.error.issues[0]?.message}`);
  const parsedAction = action ? ActionPlan.safeParse(action) : null;
  if (parsedAction && !parsedAction.success) {
    throw new HttpError(400, `that is not an action plan: ${parsedAction.error.issues[0]?.message}`);
  }
  return runDirect(pool, {
    principal,
    plan: parsed.data,
    action: parsedAction?.data ?? null,
    label: typeof label === 'string' ? label.slice(0, 200) : undefined,
  });
});

route('POST', /^\/api\/copilot\/confirm$/, async ({ pool, principal }, body) => {
  const { runId, digest } = body as { runId?: string; digest?: string };
  if (!runId || !digest) throw new HttpError(400, 'runId and digest are required');
  return confirm(pool, { principal, runId, digest });
});

route('GET', /^\/api\/copilot\/runs$/, async ({ pool, principal }) => recentRuns(pool, principal));

// What the Records page may offer to do to a selection. See bulkOptions.
route('GET', /^\/api\/bulk\/options$/, async ({ pool, principal, url }) => {
  const processKey = url.searchParams.get('process');
  if (!processKey) throw new HttpError(400, 'process is required');
  return bulkOptions(pool, principal, processKey);
});

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
    query: url.searchParams.get('q') ?? undefined,
    order: (url.searchParams.get('order') as RecordOrder | null) ?? undefined,
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
  const { url, description, events, includeFields, kind } = body as {
    url?: string; description?: string; events?: string[]; includeFields?: string[];
    kind?: 'http' | 'slack' | 'teams';
  };
  if (!url) throw new HttpError(400, 'url is required');
  // The secret is returned once, here. It is not readable afterwards.
  return registerEndpoint(pool, { principal, url, description, events, includeFields, kind });
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

/*
 * The consent screen's questions. It passes the integration's query string
 * through untouched; every check the grant makes is made here first, so the
 * screen is only ever drawn for a request that would work if allowed.
 */
route('GET', /^\/api\/oauth\/consent$/, async ({ pool, principal, actorId, url }) => {
  if (principal.kind !== 'actor') throw new HttpError(401, 'sign in first');
  return describeRequest(pool, { tenantId: principal.tenantId, actorId, request: parseAuthorizeQuery(url.searchParams) });
});

route('POST', /^\/api\/oauth\/deny$/, async ({ pool, principal }, body) => {
  if (principal.kind !== 'actor') throw new HttpError(401, 'sign in first');
  const { query } = body as { query?: string };
  return denyRequest(pool, { tenantId: principal.tenantId, request: parseAuthorizeQuery(new URLSearchParams(query ?? '')) });
});

// The consent decision itself, posted by the consent screen at /oauth/authorize.
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


// -------------------------------------------------------------------- packs
//
// §1.2's differentiator: a pack carries schema, workflow, messages, documents,
// dashboard and policy defaults, not a form. Installing produces a draft, so
// §1.3's "review before publish" still applies to something we wrote.

route('GET', /^\/api\/packs$/, async ({ pool, principal, url }) =>
  listPacks(pool, {
    principal,
    category: url.searchParams.get('category') ?? undefined,
    search: url.searchParams.get('q') ?? undefined,
  }),
);

route('GET', /^\/api\/packs\/([0-9a-f-]{36})$/, async ({ pool, principal, url }) =>
  readPack(pool, { principal, packId: url.pathname.split('/').pop()! }),
);

route('POST', /^\/api\/packs\/([0-9a-f-]{36})\/install$/, async ({ pool, principal, url }, body) => {
  const { processKey, name } = body as { processKey?: string; name?: string };
  if (!processKey) throw new HttpError(400, 'processKey is required');
  return installPack(pool, { principal, packId: url.pathname.split('/')[3]!, processKey, name });
});

route('GET', /^\/api\/packs\/installed$/, async ({ pool, principal }) => listInstalls(pool, principal));

// Publishing a workspace's own process as a pack, for its own reuse.
route('POST', /^\/api\/packs$/, async ({ pool, principal }, body) => {
  const { packKey, name, summary, category, audience, blueprint } = body as Record<string, never>;
  if (!packKey || !name || !summary || !category || !blueprint) {
    throw new HttpError(400, 'packKey, name, summary, category and blueprint are required');
  }
  return publishPack(pool, { principal, packKey, name, summary, category, audience, blueprint });
});


// ------------------------------------------------------------------ people
//
// IAM-01 and IAM-04. The workspace-creation and invitation-acceptance routes
// are above, before the session gate, because neither caller has a session.

route('GET', /^\/api\/members$/, async ({ pool, principal }) => listMembers(pool, principal));

route('GET', /^\/api\/members\/grantable$/, async ({ pool, principal, actorId }) => {
  const { rows } = await pool.query<{ workspace_role: WorkspaceRole }>(
    'select workspace_role from actor where id = $1',
    [actorId],
  );
  // What this person may hand out, so the interface cannot offer a role the
  // server will refuse.
  return { roles: grantableRoles(rows[0]!.workspace_role) };
});

route('POST', /^\/api\/members\/([0-9a-f-]{36})\/deactivate$/, async ({ pool, principal, url }) =>
  setMemberActive(pool, { principal, actorId: url.pathname.split('/')[3]!, active: false }),
);

route('POST', /^\/api\/members\/([0-9a-f-]{36})\/reactivate$/, async ({ pool, principal, url }) =>
  setMemberActive(pool, { principal, actorId: url.pathname.split('/')[3]!, active: true }),
);

route('POST', /^\/api\/members\/([0-9a-f-]{36})\/role$/, async ({ pool, principal, url }, body) => {
  const { workspaceRole } = body as { workspaceRole?: WorkspaceRole };
  if (!workspaceRole) throw new HttpError(400, 'workspaceRole is required');
  return changeRole(pool, { principal, actorId: url.pathname.split('/')[3]!, workspaceRole });
});

route('POST', /^\/api\/members\/([0-9a-f-]{36})\/revoke-sessions$/, async ({ pool, principal, url }) => {
  await requireWorkspaceCapability(pool, principal, 'administer', 'members');
  return { revoked: await revokeAllSessions(pool, url.pathname.split('/')[3]!) };
});

route('GET', /^\/api\/invitations$/, async ({ pool, principal }) => listInvitations(pool, principal));

/**
 * Many invitations at once: `dryRun` checks every row and sends nothing, which
 * is what the invite page shows before Send; without it, the ready rows go.
 */
route('POST', /^\/api\/invitations\/bulk$/, async ({ pool, principal }, body) => {
  const { rows, message, dryRun } = body as { rows?: { email?: unknown; role?: unknown }[]; message?: string; dryRun?: boolean };
  if (!Array.isArray(rows)) throw new HttpError(400, 'rows is required');
  return inviteMany(pool, {
    principal,
    rows: rows.map((r) => ({ email: String(r.email ?? ''), role: String(r.role ?? '') })),
    message: typeof message === 'string' ? message.slice(0, 1000) : undefined,
    dryRun: dryRun === true,
  });
});

route('POST', /^\/api\/invitations$/, async ({ pool, principal }, body) => {
  const { email, workspaceRole, processRoles, message } = body as {
    email?: string; workspaceRole?: WorkspaceRole;
    processRoles?: { processKey: string; roleKey: string }[]; message?: string;
  };
  if (!email || !workspaceRole) throw new HttpError(400, 'email and workspaceRole are required');
  const sent = await invite(pool, { principal, email, workspaceRole, processRoles, message });
  /*
   * The token does not come back.
   *
   * It used to, because there was no invitation email and somebody had to
   * carry the link by hand. Now that the mail goes out, returning it as well
   * would mean any member who can invite could mint a working link for an
   * address without the owner of that address ever seeing it. `delivered`
   * says whether the mail left, which is the part the console needs.
   */
  return { id: sent.id, expiresAt: sent.expiresAt, delivered: sent.delivered };
});

/**
 * Resend your own verification link.
 *
 * Only your own: an endpoint that sends verification mail to an arbitrary
 * actor id is a way to make this system mail a stranger on demand. The
 * throttle in `sendVerification` limits how often even this works.
 */
route('POST', /^\/api\/account\/resend-verification$/, async ({ pool, actorId }) => {
  const result = await sendVerification(pool, { actorId });
  return { sent: result.sent, reason: result.reason ?? null };
});

// --------------------------------------------------------------- delivery
//
// §6.6's delivery log, from the other end. Reading is `report`; changing who
// this deployment is willing to write to is `administer`.

route('GET', /^\/api\/delivery\/suppressed$/, async ({ pool, principal }) => {
  await requireWorkspaceCapability(pool, principal, 'report', 'delivery');
  if (principal.kind !== 'actor') throw new HttpError(403, 'signed-in members only');
  // Scoped to addresses this tenant has mailed. The list itself is
  // deployment-wide, because a dead mailbox is not a fact about who wrote to
  // it — but handing one tenant another's contacts would be.
  return { suppressed: await suppressionsFor(pool, principal.tenantId) };
});

route('POST', /^\/api\/delivery\/suppressed\/lift$/, async ({ pool, principal, actorId }, body) => {
  await requireWorkspaceCapability(pool, principal, 'administer', 'delivery');
  if (principal.kind !== 'actor') throw new HttpError(403, 'signed-in members only');
  const { email } = body as { email?: string };
  if (!email) throw new HttpError(400, 'email is required');
  /*
   * Only an address this workspace has written to. The list is
   * deployment-wide and the reading was already scoped this way; the lift was
   * not, so one workspace could reinstate an address another had burned
   * without ever being able to see it.
   */
  const mine = (await suppressionsFor(pool, principal.tenantId)).some(
    (s: { email: string }) => s.email === email.trim().toLowerCase(),
  );
  if (!mine) throw new HttpError(404, 'this workspace has not written to that address');
  return lift(pool, { email, actorId });
});

/**
 * This workspace's share of the sending account's health: hard bounces and
 * complaints against what it sent, over the window the provider judges by.
 */
route('GET', /^\/api\/delivery\/health$/, async ({ pool, principal }) => {
  await requireWorkspaceCapability(pool, principal, 'report', 'delivery');
  if (principal.kind !== 'actor') throw new HttpError(403, 'signed-in members only');
  return sendingHealth(pool, { tenantId: principal.tenantId });
});

/** What an address missed while it was suppressed. */
route('GET', /^\/api\/delivery\/skipped$/, async ({ pool, principal, url }) => {
  await requireWorkspaceCapability(pool, principal, 'administer', 'delivery');
  if (principal.kind !== 'actor') throw new HttpError(403, 'signed-in members only');
  const email = url.searchParams.get('email');
  if (!email) throw new HttpError(400, 'email is required');
  return { skipped: await skippedFor(pool, { tenantId: principal.tenantId, email }) };
});

/** Sends the ones somebody chose, now that the address is reinstated. */
route('POST', /^\/api\/delivery\/resend$/, async ({ pool, engine, principal, actorId }, body) => {
  await requireWorkspaceCapability(pool, principal, 'administer', 'delivery');
  if (principal.kind !== 'actor') throw new HttpError(403, 'signed-in members only');
  const { email, logIds } = body as { email?: string; logIds?: unknown };
  if (!email) throw new HttpError(400, 'email is required');
  if (!Array.isArray(logIds) || !logIds.length || !logIds.every((id) => /^\d+$/.test(String(id)))) {
    throw new HttpError(400, 'choose at least one message');
  }
  const results = await resendSkipped(pool, engine.email, {
    tenantId: principal.tenantId,
    actorId,
    email,
    logIds: logIds.map(String),
  });
  return { results };
});

route('POST', /^\/api\/delivery\/suppressed$/, async ({ pool, principal }, body) => {
  await requireWorkspaceCapability(pool, principal, 'administer', 'delivery');
  const { email, detail } = body as { email?: string; detail?: string };
  if (!email) throw new HttpError(400, 'email is required');
  await suppressByHand(pool, { email, detail: detail ?? 'blocked by an operator' });
  return { email, reason: 'manual' };
});

/** The timeline for one message: everything the provider has said about it. */
route('GET', /^\/api\/delivery\/messages\/([^/]+)$/, async ({ pool, principal, url }) => {
  await requireWorkspaceCapability(pool, principal, 'report', 'delivery');
  const messageId = decodeURIComponent(url.pathname.split('/')[4]!);
  return { events: await eventsFor(pool, messageId) };
});

route('POST', /^\/api\/invitations\/([0-9a-f-]{36})\/revoke$/, async ({ pool, principal, url }) =>
  revokeInvitation(pool, { principal, invitationId: url.pathname.split('/')[3]! }),
);

// ------------------------------------------------------------------ session

// A separate operator boundary: customer workspace roles never grant these routes.
route('GET', /^\/api\/platform\/me$/, async ({ pool, actorId }) =>
  ({ role: await requirePlatformRole(pool, actorId) }));
route('GET', /^\/api\/platform\/overview$/, async ({ pool, actorId }) => {
  await requirePlatformRole(pool, actorId);
  return platformOverview(pool);
});
route('GET', /^\/api\/platform\/workspaces$/, async ({ pool, actorId, url }) => {
  await requirePlatformRole(pool, actorId);
  return platformWorkspaces(pool, (url.searchParams.get('q') ?? '').slice(0, 100),
    Math.min(1000, Math.max(1, Number(url.searchParams.get('page')) || 1)),
    url.searchParams.get('scope') === 'tests' ? 'tests' : url.searchParams.get('scope') === 'all' ? 'all' : 'customers');
});
route('GET', /^\/api\/platform\/people$/, async ({ pool, actorId, url }) => {
  await requirePlatformRole(pool, actorId);
  const status = url.searchParams.get('status');
  return platformPeople(pool, (url.searchParams.get('q') ?? '').slice(0, 100),
    Math.min(1000, Math.max(1, Number(url.searchParams.get('page')) || 1)),
    status === 'active' || status === 'inactive' ? status : 'all');
});
route('GET', /^\/api\/platform\/integrations$/, async ({ pool, actorId, url }) => {
  await requirePlatformRole(pool, actorId);
  return platformIntegrations(pool, (url.searchParams.get('q') ?? '').slice(0, 100),
    Math.min(1000, Math.max(1, Number(url.searchParams.get('page')) || 1)));
});
route('GET', /^\/api\/platform\/security$/, async ({ pool, actorId }) => {
  await requirePlatformRole(pool, actorId);
  return platformSecurity(pool);
});
route('GET', /^\/api\/platform\/workspaces\/[0-9a-f-]{36}$/, async ({ pool, actorId, url }) => {
  await requirePlatformRole(pool, actorId);
  const detail = await platformWorkspace(pool, url.pathname.split('/')[4]!);
  if (!detail) throw new HttpError(404, 'workspace not found');
  return detail;
});
route('POST', /^\/api\/platform\/workspaces\/[0-9a-f-]{36}\/rename$/, async ({ pool, actorId, url }, body) => {
  await requirePlatformRole(pool, actorId, 'operator');
  const b = body as { name?: string; reason?: string };
  if (typeof b.name !== 'string' || typeof b.reason !== 'string') throw new InvalidInput('name and reason are required');
  return renamePlatformWorkspace(pool, actorId, url.pathname.split('/')[4]!, b.name, b.reason);
});
route('POST', /^\/api\/platform\/workspaces\/[0-9a-f-]{36}\/intake$/, async ({ pool, actorId, url }, body) => {
  await requirePlatformRole(pool, actorId, 'owner');
  const b = body as { paused?: boolean; reason?: string };
  if (typeof b.paused !== 'boolean' || typeof b.reason !== 'string') throw new InvalidInput('paused and reason are required');
  return setPlatformIntakePaused(pool, actorId, url.pathname.split('/')[4]!, b.paused, b.reason);
});
route('POST', /^\/api\/platform\/workspaces\/[0-9a-f-]{36}\/webhooks\/[0-9a-f-]{36}\/status$/, async ({ pool, actorId, url }, body) => {
  await requirePlatformRole(pool, actorId, 'owner');
  const b = body as { active?: boolean; reason?: string };
  if (typeof b.active !== 'boolean' || typeof b.reason !== 'string') throw new InvalidInput('active and reason are required');
  const parts = url.pathname.split('/');
  return setPlatformWebhookActive(pool, actorId, parts[4]!, parts[6]!, b.active, b.reason);
});
route('POST', /^\/api\/platform\/workspaces\/[0-9a-f-]{36}\/keys\/[0-9a-f-]{36}\/revoke$/, async ({ pool, actorId, url }, body) => {
  await requirePlatformRole(pool, actorId, 'owner');
  const b = body as { reason?: string };
  if (typeof b.reason !== 'string') throw new InvalidInput('reason is required');
  const parts = url.pathname.split('/');
  return revokePlatformApiKey(pool, actorId, parts[4]!, parts[6]!, b.reason);
});
route('POST', /^\/api\/platform\/workspaces\/[0-9a-f-]{36}\/people\/[0-9a-f-]{36}\/access$/, async ({ pool, actorId, url }, body) => {
  await requirePlatformRole(pool, actorId, 'owner');
  const b = body as { active?: boolean; workspaceRole?: string; reason?: string };
  if (typeof b.reason !== 'string' || (b.active !== undefined && typeof b.active !== 'boolean') ||
    (b.workspaceRole !== undefined && typeof b.workspaceRole !== 'string')) throw new InvalidInput('valid access change and reason are required');
  const parts = url.pathname.split('/');
  return changePlatformPerson(pool, actorId, parts[4]!, parts[6]!, { active: b.active, workspaceRole: b.workspaceRole, reason: b.reason });
});
route('GET', /^\/api\/platform\/jobs$/, async ({ pool, actorId, url }) => {
  await requirePlatformRole(pool, actorId);
  return platformJobs(pool, Math.min(1000, Math.max(1, Number(url.searchParams.get('page')) || 1)));
});
route('GET', /^\/api\/platform\/trace\/[\w.:-]{8,64}$/, async ({ pool, actorId, url }) => {
  await requirePlatformRole(pool, actorId);
  return platformTrace(pool, url.pathname.split('/')[4]!);
});
route('GET', /^\/api\/platform\/mail$/, async ({ pool, actorId }) => {
  await requirePlatformRole(pool, actorId);
  return platformMail(pool);
});
route('GET', /^\/api\/platform\/audit$/, async ({ pool, actorId, url }) => {
  await requirePlatformRole(pool, actorId);
  return platformAudit(pool, Math.min(1000, Math.max(1, Number(url.searchParams.get('page')) || 1)));
});
route('GET', /^\/api\/platform\/operators$/, async ({ pool, actorId }) => {
  await requirePlatformRole(pool, actorId, 'owner');
  return platformOperators(pool);
});
route('POST', /^\/api\/platform\/operators$/, async ({ pool, actorId }, body) => {
  await requirePlatformRole(pool, actorId, 'owner');
  const b = body as { email?: string; role?: string };
  if (!b.email || !['owner', 'operator', 'viewer'].includes(b.role ?? '')) throw new InvalidInput('email and role are required');
  return grantPlatformOperator(pool, actorId, b.email, b.role as 'owner' | 'operator' | 'viewer');
});
route('POST', /^\/api\/platform\/operators\/[0-9a-f-]{36}\/revoke$/, async ({ pool, actorId, url }) => {
  await requirePlatformRole(pool, actorId, 'owner');
  return revokePlatformOperator(pool, actorId, url.pathname.split('/')[4]!);
});
route('POST', /^\/api\/platform\/jobs\/\d+\/retry$/, async ({ pool, actorId, url }) => {
  await requirePlatformRole(pool, actorId, 'operator');
  return retryPlatformJob(pool, actorId, Number(url.pathname.split('/')[4]));
});
route('POST', /^\/api\/platform\/people\/[0-9a-f-]{36}\/revoke-sessions$/, async ({ pool, actorId, url }) => {
  await requirePlatformRole(pool, actorId, 'operator');
  return revokePlatformSessions(pool, actorId, url.pathname.split('/')[4]!);
});

route('GET', /^\/api\/session$/, async ({ engine, pool, actorId }) => {
  const actor = await engine.actor(actorId);
  if (!actor) throw new HttpError(401, 'unknown actor');
  const [processes, devices] = await Promise.all([
    engine.processesFor(actor.tenant_id, actorId),
    devicesFor(pool, actorId),
  ]);
  return { actor, processes, devices };
});

// ------------------------------------------------- two-step verification
//
// Always your own account. An endpoint that enrols or disables a second
// factor for an arbitrary actor id is a way to take one off somebody else.

route('GET', /^\/api\/account\/mfa$/, async ({ pool, actorId }) => mfaStatusFor(pool, actorId));

route('POST', /^\/api\/account\/mfa\/begin$/, async ({ pool, actorId }) =>
  beginEnrolment(pool, { actorId }),
);

route('POST', /^\/api\/account\/mfa\/confirm$/, async ({ pool, actorId }, body) => {
  const { code } = body as { code?: string };
  if (!code) throw new HttpError(400, 'code is required');
  return confirmEnrolment(pool, { actorId, code });
});

route('POST', /^\/api\/account\/mfa\/disable$/, async ({ pool, actorId }, body) => {
  const { password } = body as { password?: string };
  // The password, not a code. Somebody holding the phone but not the password
  // is exactly who should not be able to remove the factor.
  if (!password) throw new HttpError(400, 'password is required');
  await disableMfa(pool, { actorId, password });
  return { enabled: false };
});

route('POST', /^\/api\/account\/mfa\/recovery-codes$/, async ({ pool, actorId }, body) => {
  const { password } = body as { password?: string };
  if (!password) throw new HttpError(400, 'password is required');
  return { recoveryCodes: await regenerateRecoveryCodes(pool, { actorId, password }) };
});

/**
 * Confirm it is you: the password, and the authenticator code when two-step
 * is on. Marks this session fresh for ten minutes. See runtime/step-up.ts.
 */
route('POST', /^\/api\/auth\/reauthenticate$/, async ({ pool, actorId, session }, body) => {
  if (!session) throw new HttpError(401, 'sign in first');
  const { password, code } = body as { password?: string; code?: string };
  if (!password) throw new HttpError(400, 'password is required');
  return reauthenticate(pool, { sessionId: session.sessionId, actorId, password, code });
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

route('GET', /^\/api\/records\/([0-9a-f-]{36})\/receipts\/([0-9a-f-]{36})$/, async ({ pool, principal, url }) => {
  const parts = url.pathname.split('/');
  return receiptDownload(pool, principal, parts[3]!, parts[5]!);
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
  async ({ engine, principal, url }, body) => {
    const [, , , id, , taskKey] = url.pathname.split('/');
    const answers = (body as { answers?: Answers } | undefined)?.answers;
    const result = await engine.completeTask({ instanceId: id!, taskKey: taskKey!, principal, answers, now: new Date() });
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

route('POST', /^\/api\/automation\/(-?\d+)\/replay$/, async ({ engine, principal, url }) => {
  const outboxId = Number(url.pathname.split('/')[3]);
  if (outboxId <= 0) throw new HttpError(400, 'This is a failed email send, not a replayable job. Check the address and provider, then submit a new test request.');
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

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req: IncomingMessage, maxBytes = Number.MAX_SAFE_INTEGER): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'request is too large');
    chunks.push(chunk as Buffer);
  }
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

function send(
  res: ServerResponse,
  status: number,
  payload: unknown,
  cookies: string[] = [],
  extra: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // The console is served from another origin in development.
    'access-control-allow-origin': process.env.CONSOLE_ORIGIN ?? 'http://localhost:3210',
    // x-request-id so a caller can supply their own correlation id, and read
    // it back off the response.
    'access-control-allow-headers': 'content-type, x-request-id',
    // A respondent's browser has to be able to read the limit it is being
    // held to, or a 429 is indistinguishable from the form being broken.
    'access-control-expose-headers': 'x-request-id, retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, x-ratelimit-window, x-ratelimit-scope',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-credentials': 'true',
    ...(cookies.length ? { 'set-cookie': cookies } : {}),
    ...extra,
  });
  res.end(body);
}

async function main(): Promise<void> {
  // Refuse to start in production without a ticket key, rather than hold
  // every submission made across the next deploy. See screening.ts.
  assertScreeningConfigured();
  // Nor without a key for two-factor secrets; see secret-box.ts.
  assertSecretKeyConfigured();
  const pool = createPool(12);
  // A database made before a schema change gets it here, without a re-seed.
  await applyUpgrades(pool);
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
        /*
         * Six routes precede authentication, and each has a reason.
         *
         * Sign-in obviously. Creating a workspace, because there is nobody to
         * authenticate yet — IAM-01. Reading and accepting an invitation,
         * because the person following the link is not a member until they
         * do. And the two recovery routes below: somebody who cannot sign in
         * is exactly who needs them.
         */
        if (url.pathname === '/api/workspaces' && req.method === 'POST') {
          const b = (await readBody(req)) as Record<string, string>;
          if (!b.workspaceName || !b.ownerEmail || !b.password) {
            throw new HttpError(400, 'workspaceName, ownerEmail and password are required');
          }
          const created = await createWorkspace(pool, {
            workspaceName: b.workspaceName,
            ownerEmail: b.ownerEmail,
            ownerName: b.ownerName ?? '',
            password: b.password,
          });
          // Signed in immediately: making somebody type the password they just
          // chose, into the form they just left, is a step with no purpose.
          //
          // `startSession` rather than `signIn`, because an account created
          // one statement ago cannot have a second factor and re-verifying a
          // password we just wrote proves nothing.
          const session = await startSession(pool, {
            actorId: created.actorId,
            userAgent: req.headers['user-agent'],
          });
          return send(
            res,
            201,
            { ...created, actor: session?.actor },
            session ? [cookie(SESSION_COOKIE, session.token, session.expiresAt)] : [],
          );
        }

        if (url.pathname.startsWith('/api/invitations/') && url.pathname.endsWith('/preview') && req.method === 'GET') {
          const token = decodeURIComponent(url.pathname.split('/')[3]!);
          return send(res, 200, await readInvitation(pool, token));
        }

        if (url.pathname === '/api/invitations/accept' && req.method === 'POST') {
          const b = (await readBody(req)) as Record<string, string>;
          if (!b.token || !b.password) throw new HttpError(400, 'token and password are required');
          const joined = await acceptInvitation(pool, {
            token: b.token,
            displayName: b.displayName ?? '',
            password: b.password,
          });
          // The address came from the invitation, not from the request body —
          // accepting an invitation must not be a way to choose which account
          // you end up signed in as.
          const session = await startSession(pool, {
            actorId: joined.actorId,
            userAgent: req.headers['user-agent'],
          });
          return send(
            res,
            201,
            { ...joined, actor: session?.actor },
            session ? [cookie(SESSION_COOKIE, session.token, session.expiresAt)] : [],
          );
        }

        /*
         * ---- delivery notifications from the email provider
         *
         * Before the session gate because the caller is RelyKit, not a
         * person. Its signature is the credential, so the raw body is read
         * rather than parsed: re-serialising JSON changes key order and
         * whitespace, and the signature is over the exact bytes.
         *
         * Always 200 once the signature verifies, including for an event
         * about a message this deployment did not send. A 4xx would make the
         * provider retry something that will never succeed, and eventually
         * disable the endpoint.
         */
        if (url.pathname === '/api/webhooks/relykit' && req.method === 'POST') {
          const secret = process.env.RELYKIT_WEBHOOK_SECRET;
          if (!secret) throw new HttpError(503, 'RELYKIT_WEBHOOK_SECRET is not set');

          const raw = await readRaw(req);
          const id = String(req.headers['webhook-id'] ?? '');
          const check = verifyRelyKit({
            secret,
            id,
            timestamp: String(req.headers['webhook-timestamp'] ?? ''),
            body: raw,
            signature: String(req.headers['webhook-signature'] ?? ''),
          });
          if (!check.ok) {
            // One message for every reason. Telling an unauthenticated caller
            // which part of their forgery was wrong is free help.
            logIfEnabled('warn', 'delivery.refused', { reason: check.reason });
            return send(res, 401, { error: 'signature refused' });
          }

          let event: ProviderEvent;
          try {
            event = JSON.parse(raw) as ProviderEvent;
          } catch {
            return send(res, 400, { error: 'body is not valid JSON' });
          }

          const result = await ingest(pool, {
            provider: 'relykit',
            event,
            // The header is authoritative: it is what was signed. The body's
            // own id is data, and a mismatch would let one signed request be
            // replayed as many different events.
            eventId: id,
          });
          return send(res, 200, result);
        }

        // ---- account recovery: reachable by definition without a session
        if (url.pathname === '/api/auth/verify' && req.method === 'POST') {
          const b = (await readBody(req)) as Record<string, string>;
          if (!b.token) throw new HttpError(400, 'token is required');
          const verified = await verifyEmail(pool, b.token);
          return send(res, 200, { email: verified.email });
        }

        if (url.pathname === '/api/auth/forgot' && req.method === 'POST') {
          const b = (await readBody(req)) as Record<string, string>;
          if (!b.email) throw new HttpError(400, 'email is required');
          // The token is deliberately dropped. `requestPasswordReset` returns
          // it for in-process callers; putting it in a response would make the
          // email pointless and the endpoint an account takeover.
          await requestPasswordReset(pool, { email: b.email });
          return send(res, 202, {
            message: 'If that address has an account, a reset link is on its way.',
          });
        }

        if (url.pathname === '/api/auth/reset' && req.method === 'POST') {
          const b = (await readBody(req)) as Record<string, string>;
          if (!b.token || !b.password) throw new HttpError(400, 'token and password are required');
          const done = await resetPassword(pool, { token: b.token, password: b.password });
          return send(res, 200, {
            sessionsRevoked: done.sessionsRevoked,
            message: 'Password changed. Every other session has been signed out.',
          });
        }

        // ---- login and logout are the only routes before authentication
        if (url.pathname === '/api/auth/login' && req.method === 'POST') {
          const { email, password } = (await readBody(req)) as { email?: string; password?: string };
          if (!email || !password) throw new HttpError(400, 'email and password are required');
          const result = await signIn(pool, { email, password, userAgent: req.headers['user-agent'] });
          // One message for every failure, so the response cannot be used to
          // find out which addresses have accounts.
          if (!result) return send(res, 401, { error: 'those details do not match an account' });

          /*
           * A correct password on an account with a second factor. No cookie
           * is set — the point of the factor is that the password alone
           * produces nothing that works anywhere.
           */
          if (needsSecondFactor(result)) {
            return send(res, 200, { mfaRequired: true, challengeToken: result.challengeToken });
          }

          return send(
            res,
            200,
            { actor: result.actor },
            [cookie(SESSION_COOKIE, result.token, result.expiresAt)],
          );
        }

        /** The second step. Only this exchanges a challenge for a session. */
        if (url.pathname === '/api/auth/mfa' && req.method === 'POST') {
          const b = (await readBody(req)) as Record<string, string>;
          if (!b.challengeToken || !b.code) {
            throw new HttpError(400, 'challengeToken and code are required');
          }
          const answered = await answerChallenge(pool, { token: b.challengeToken, code: b.code });
          const session = await startSession(pool, {
            actorId: answered.actorId,
            userAgent: req.headers['user-agent'],
          });
          if (!session) return send(res, 401, { error: 'that account is not active' });
          return send(
            res,
            200,
            {
              actor: session.actor,
              // Surfaced so the console can say how many are left. Somebody
              // who has just spent one is the person most likely to need the
              // next, and least likely to check.
              usedRecoveryCode: answered.usedRecoveryCode,
              recoveryCodesLeft: answered.recoveryCodesLeft,
            },
            [cookie(SESSION_COOKIE, session.token, session.expiresAt)],
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

          /*
           * §12.3. This is the only door with no credential on it, so it is
           * the only one where the budget is the whole defence. Taken before
           * the handler runs and before the body is read: a limiter that
           * parses the request first is a limiter that can be made to do work.
           */
          const limit = limitFor(req.method!, url.pathname);
          let rateHeaders: Record<string, string> = {};
          if (limit) {
            const verdict = await takeIntakeToken(
              callerFor(req),
              processKeyFrom(url.pathname),
              limit,
            );
            rateHeaders = verdict.headers;
            if (!verdict.ok) {
              logIfEnabled('warn', 'intake.rate_limited', {
                path: url.pathname,
                scope: limit.scope,
                retryAfter: verdict.retryAfterSeconds,
              });
              return send(
                res,
                429,
                {
                  error: 'too many requests',
                  reason: `Wait ${verdict.retryAfterSeconds}s and try again.`,
                },
                [],
                rateHeaders,
              );
            }
          }

          const body = req.method === 'POST' ? await readBody(req, url.pathname.endsWith('/receipts') ? 7 * 1024 * 1024 : Number.MAX_SAFE_INTEGER) : {};
          const anonymous: Principal = { kind: 'respondent', tenantId: '' };
          return send(
            res,
            200,
            await match.handler({ engine, pool, principal: anonymous, actorId: '', url }, body),
            [],
            rateHeaders,
          );
        }

        const session = await resolveSession(pool, readCookie(req, SESSION_COOKIE) ?? '');
        if (!session) throw new HttpError(401, 'sign in first');

        const actorId = session.actorId;
        const principal: Principal = { kind: 'actor', tenantId: session.tenantId, actorId };
        const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
        if (!match) throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);

        const body = req.method === 'POST' ? await readBody(req) : {};

        /*
         * Actions that grant access or destroy data ask for a recent sign-in.
         * Checked here, before the handler, so no route can forget to — and
         * answered as a question rather than a refusal: the console asks the
         * person to confirm it is them and then sends the same request again.
         */
        const stepUp = stepUpFor(req.method!, url.pathname, body);
        if (stepUp && !isFresh(session.authenticatedAt)) {
          return send(res, 403, {
            error: 'reauthenticate',
            reason: `Confirm it is you to ${stepUp.what}.`,
            mfa: await mfaIsEnabled(pool, actorId),
          });
        }

        const result = await match.handler(
          { engine, pool, principal, actorId, url, session: { sessionId: session.sessionId, authenticatedAt: session.authenticatedAt } },
          body,
        );
        logIfEnabled('info', 'api.request', {
          method: req.method,
          path: url.pathname,
          status: 200,
          ms: Date.now() - started,
        });
        /*
         * A renewed session needs its cookie reissued, or the row outlives
         * the cookie and the browser forgets a session the database still
         * considers live.
         */
        send(
          res,
          200,
          result,
          session.renewedUntil ? [cookie(SESSION_COOKIE, readCookie(req, SESSION_COOKIE)!, session.renewedUntil)] : [],
        );
      } catch (err) {
        const status =
          err instanceof AuthorizationError
            ? 403
            : err instanceof HttpError
              ? err.status
              : err instanceof DraftConflict
                ? 409
                : err instanceof FormLinkError
                  ? err.kind === 'ambiguous'
                    ? 410
                    : 404
                  : err instanceof OAuthError
                    ? err.status
                : err instanceof InvalidInput
                  ? 400
                  : err instanceof NotFound
                    ? 404
                    : 500;
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
        if (err instanceof FormLinkError) {
          return send(res, err.kind === 'ambiguous' ? 410 : 404, { error: err.message });
        }
        /*
         * An OAuth refusal is the integration's mistake or the member's
         * answer, not an outage. It used to reach the catch-all and come back
         * as "internal error" — so an integration author with a mistyped
         * redirect address was told the server had broken.
         */
        if (err instanceof OAuthError) {
          return send(res, err.status, { error: err.code, reason: err.message });
        }
        if (err instanceof DraftConflict) {
          return send(res, 409, { error: 'conflict', kind: err.kind, reason: err.message, ...err.detail });
        }
        // Something the caller can fix. Reporting it as 500 would say "we
        // broke" when the truth is "that password is too short".
        if (err instanceof InvalidInput) return send(res, 400, { error: err.message });
        if (err instanceof NotFound) return send(res, 404, { error: err.message });
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
