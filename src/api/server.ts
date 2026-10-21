import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { applyUpgrades, createPool, describeTarget, type Pool } from '../runtime/db.js';
import { changePlatformPerson, grantPlatformOperator, platformAudit, platformIntegrations, platformJobs, platformMail, platformOperators, platformPeople, platformSecurity,
  platformOverview, platformWorkspace, platformWorkspaces, requirePlatformRole,
  renamePlatformWorkspace, retryPlatformJob, revokePlatformApiKey, revokePlatformOperator, revokePlatformSessions,
  setPlatformIntakePaused, setPlatformWebhookActive, platformTrace } from '../runtime/platform-admin.js';
import { Engine } from '../runtime/engine.js';
import { addRecordNote, recordDocument } from '../runtime/console-queries.js';
import { shareRecord } from '../runtime/share-record.js';
import { pushConfig, removeSubscription, saveSubscription, testPush } from '../runtime/push.js';
import { beginAssertion, beginRegistration, finishAssertion, finishRegistration, hasPasskeys, listPasskeys, removePasskey } from '../runtime/passkeys.js';
import { goHome } from '../runtime/go.js';
import { createView, deleteView, listViews, type Schedule, type ViewParams } from '../runtime/saved-views.js';
import { isPublicApiPath, publicHandler } from './public-server.js';
import { aiDraftStatus, applyAiRevision, queueAiDraft, queueAiRevision } from '../runtime/ai-drafts.js';
import { AuthorizationError, authorize as authorizeProcess, requireWorkspaceCapability, WORKSPACE_GRANTS, type Principal } from '../runtime/policy.js';
import type { Capability } from '../blueprint/roles.js';
import {
  devicesFor,
  needsSecondFactor,
  needsWorkspace,
  resolveSession,
  revokeAllSessions,
  signIn,
  signOut,
  startSession,
} from '../runtime/auth.js';
import { runRetention } from '../runtime/retention.js';
import { importDirectory } from '../runtime/directory-import.js';
import { createLegalEntity, createOrgUnit, orgChart, reportingHistory, setManager, setMemberPlacement, updateOrgUnit } from '../runtime/org.js';
import { addRate, advanceMovements, disburseAdvance, expenseSummary, exportPaid, listAdvances, listBudgets, listExports, listRates, listSettlements, moveSettlement, myBeneficiary, readExpenseSettings, recordAdvanceReturn, revealBeneficiary, reviewLines, saveBeneficiary, saveBudget, settlementLines, updateExpenseSettings, verifyBeneficiary } from '../runtime/expenses.js';
import { addQuote, approveOrder, cancelOrder, createAgreement, createOrder, createVendor, enterInvoice, exportInvoices, listAgreements, listInvoices, listOrders, listQuotes, listRequisitions, listVendors, openQuotes, orderDetail, payInvoice, procurementSummary, readProcurementSettings, receiveGoods, returnGoods, revealVendorBank, reviewInvoice, reviseOrder, saveVendorBank, selectQuote, setQuoteDeadline, setVendorStatus, updateProcurementSettings, updateVendor, vendorHistory, verifyVendorBank } from '../runtime/procurement.js';
import { allowance, cancelPaymentRun, createPaymentRun, expenseReport, listCategories, listRateCards, paymentRun, paymentRunBankFile, saveCategory, saveRateCard, searchAdvances, searchClaims, searchMyClaims, searchPaymentRuns, settlePaymentRun } from '../runtime/expenses-depth.js';
import { adoptTemplate, approvalsOverview, evidenceLink, listEvidence, listPolicies, savePolicy, setPolicyActive, simulatePolicy, uploadEvidence } from '../runtime/approvals.js';
import { searchCases, searchDocuments, searchHiring, searchHolidays, searchLeave, searchReconciliation, searchUpcoming } from '../runtime/hr-lists.js';
import { addEmployeeEvent, adjustLeave, documentFileLink, listBranches, saveBranch, searchEmployees, setEmployeeBranch, employeeDetail, employeeFileLink, leaveCalendar, leaveLedger, myProfile, orgTree, removeEmployeeFile, setEmployeeFileVisibility, updateProfile, uploadDocumentFile, uploadEmployeeFile } from '../runtime/hr-records.js';
import { acknowledgeDocument, addCaseNote, addCertification, cancelLeave, completeTask, createDocument, decideLeave, decideProbation, exceptTask, hrSummary, leaveToApprove, listCaseNotes, listCases, listCompensation, listDocuments, listEmployees, listHiring, listHolidays, listLeaveTypes, listReconciliations, listTeams, listTemplates, myDocuments, myLeave, myTasks, readHrSettings, requestLeave, resolveReconciliation, saveHoliday, saveLeaveType, saveTemplate, sendDocument, setCompensation, setEntitlement, setTeamMember, startOffboarding, startOnboarding, startProbationReview, startTransfer, updateEmployee, updateHrSettings, upcoming, urgentTermination } from '../runtime/hr.js';
import * as apr from '../runtime/appraisals.js';
import * as ga from '../runtime/general-approvals.js';
import { goalFileLink, uploadGoalFile } from '../runtime/goal-files.js';
import * as ops from '../runtime/ops.js';
import * as gov from '../runtime/gov.js';
import * as mtg from '../runtime/meetings.js';
import * as life from '../runtime/tenant-lifecycle.js';
import * as esign from '../runtime/esign.js';
import { opsPhotoLink, uploadOpsPhoto } from '../runtime/ops-files.js';
import { enabledModules, listModules, setModule, updateWorkspaceSettings, workspaceSettings } from '../runtime/modules.js';
import { createDelegation, createGrant, listAuthority, revokeDelegation, revokeGrant as revokeAuthorityGrant, workspaceAudit } from '../runtime/authority.js';
import { logIfEnabled, requestIdFrom, withTrace } from '../runtime/trace.js';
import { callerFor, limitFor, processKeyFrom, takeIntakeToken } from './intake-limits.js';
import { traceByRequest, traceForInstance } from '../runtime/support.js';
import { dashboard } from '../runtime/metrics.js';
import { answerSummary } from '../runtime/summaries.js';
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
  revokeMemberSessions,
  setMemberActive,
  InvalidInput,
} from '../runtime/workspace.js';
import { requestPasswordReset, resetPassword, sendVerification, verifyEmail } from '../runtime/account.js';
import { DraftConflict } from '../runtime/errors.js';
import { assertScreeningConfigured, issueTicket, screen, TRAP_FIELD } from '../runtime/screening.js';
import { resolveForm } from '../runtime/form-links.js';
import { receiptDownload, receiptStatus, taskFileStatus, uploadReceipt, uploadTaskFile } from '../runtime/receipt-files.js';
import { brandAssetUrl, uploadBrandAsset } from '../runtime/brand-assets.js';
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
import { browseFields, listRecordsPage, type RecordOrder } from './public.js';
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
import { ask, bulkOptions, confirm, readRun, recentRuns, runDirect } from '../runtime/copilot.js';
import { askerFor } from '../copilot/ask.js';
import { availableProviders, preferredProvider } from '../ai/index.js';
import { proposeRule } from '../ai/rule.js';
import { recordUsage } from '../runtime/ai-usage.js';
import { Blueprint } from '../blueprint/index.js';
import { QueryPlan, ActionPlan } from '../copilot/plan.js';
import { XLSX_TYPE, bundleToCsv, exportProcessCsv, exportProcessXlsx, exportRecord, exportWorkspace } from '../runtime/export.js';
import {
  claimDraft,
  createDraft,
  discardDraft,
  fieldHistory,
  listForBuilder,
  releaseDraft,
  loadDraft as loadProcessDraft,
  openDraft as openProcessDraft,
  publishDraft,
  publishImpact,
  saveDraft as saveProcessDraft,
  testDraft,
  testVersion,
  tryFieldValue,
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

route('POST', /^\/api\/forms\/([a-z0-9_-]+)\/submit$/, async ({ pool, engine, url, principal }, body) => {
  const key = url.pathname.split('/')[3]!;
  const { token, answers, ticket, trap } = body as { token?: string; answers?: Answers; ticket?: unknown; trap?: unknown };
  const screening = principal.kind === 'actor' ? undefined : screen({ processKey: (await resolveForm(pool, key)).publicId, ticket, trap });
  const { held, ...result } = await submitForm(pool, { processKey: key, token, answers: answers ?? {}, screening, principal });
  if (held) {
    // The reasons, never the answers: a log line is not where unvetted
    // personal data should end up.
    logIfEnabled('warn', 'intake.held', { process: key, reasons: screening?.reasons, elapsedMs: screening?.elapsedMs });
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

route('POST', /^\/api\/builder\/create$/, async ({ pool, principal }, body) => {
  const input = body as NewProcess;
  // Older builder clients still call this route. Keep AI work out of the
  // request so a slow provider cannot turn the response into a gateway error.
  if (input.description?.trim()) return queueAiDraft(pool, principal, input);
  return createDraft(pool, { principal, input });
});
route('POST', /^\/api\/builder\/ai-jobs$/, async ({ pool, principal }, body) =>
  queueAiDraft(pool, principal, body as NewProcess),
);
route('GET', /^\/api\/builder\/ai-jobs\/[0-9a-f-]{36}$/, async ({ pool, principal, url }) =>
  aiDraftStatus(pool, principal, url.pathname.split('/')[4]!),
);
route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/improve$/, async ({ pool, principal, url }, body) =>
  queueAiRevision(pool, principal, url.pathname.split('/')[4]!, (body as { request?: string })?.request ?? '', (body as { repair?: boolean })?.repair === true, (body as {staff?:unknown})?.staff ?? {}, (body as {baseRevision?:unknown})?.baseRevision),
);
route('POST', /^\/api\/builder\/ai-jobs\/([0-9a-f-]{36})\/apply$/, async ({ pool, principal, url }) =>
  applyAiRevision(pool, principal, url.pathname.split('/')[4]!),
);

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/discard$/, async ({ pool, principal, url }) =>
  discardDraft(pool, { principal, draftId: url.pathname.split('/')[4]! }),
);

route('GET', /^\/api\/builder\/drafts\/([0-9a-f-]{36})$/, async ({ pool, principal, url }) =>
  loadProcessDraft(pool, principal, url.pathname.split('/').pop()!),
);

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/brand-assets$/, async ({ pool, principal, url }, body) => {
  const { kind, base64 } = body as { kind?: string; base64?: string };
  return uploadBrandAsset(pool, principal, { draftId: url.pathname.split('/')[4]!, kind: kind ?? '', base64: base64 ?? '' });
});

route('GET', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/fields\/([A-Za-z0-9_.-]+)\/history$/, async ({ pool, principal, url }) => {
  const parts = url.pathname.split('/');
  return fieldHistory(pool, principal, parts[4]!, decodeURIComponent(parts[6]!));
});

route('POST', /^\/api\/builder\/drafts\/([0-9a-f-]{36})\/fields\/([A-Za-z0-9_.-]+)\/validate$/, async ({ pool, principal, url }, body) => {
  const parts = url.pathname.split('/');
  return tryFieldValue(pool, principal, parts[4]!, decodeURIComponent(parts[6]!), (body as { value?: unknown })?.value);
});

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

  const who = principal.kind === 'actor' ? { tenantId: principal.tenantId, actorId: principal.actorId } : {};
  return proposeRule(preferredProvider(), { sentence, blueprint: parsed.data }, {
    onUsage: (usage) => recordUsage(pool, { ...who, purpose: 'rule' }, usage),
  });
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
  const who = principal.kind === 'actor' ? { tenantId: principal.tenantId, actorId: principal.actorId } : {};
  return ask(pool, askerFor(preferredProvider(), (usage) => recordUsage(pool, { ...who, purpose: 'ask' }, usage)), { principal, processKey, question });
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

route('GET', /^\/api\/copilot\/runs$/, async ({ pool, principal, url }) => {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '10');
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new HttpError(400, 'page must be between 1 and 1,000,000; pageSize must be between 1 and 50');
  }
  const query = url.searchParams.get('q')?.trim() ?? '';
  if (query.length > 120) throw new HttpError(400, 'search must be 120 characters or fewer');
  const status = url.searchParams.get('status') ?? '';
  if (status && !['answered', 'previewed', 'executed', 'issues'].includes(status)) {
    throw new HttpError(400, 'unknown run status');
  }
  return recentRuns(pool, principal, {
    processKey: url.searchParams.get('process') ?? undefined,
    query: query || undefined,
    status: status || undefined,
    page,
    pageSize,
    summary: url.searchParams.get('summary') === '1',
  });
});

route('GET', /^\/api\/copilot\/runs\/([0-9a-f-]{36})$/, async ({ pool, principal, url }) => {
  const run = await readRun(pool, principal, url.pathname.split('/').pop()!);
  if (!run) throw new HttpError(404, 'question not found');
  return run;
});

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

// What people answered, added up: counts per choice, totals and averages.
route('GET', /^\/api\/dashboard\/([a-z0-9_]+)\/answers$/, async ({ pool, principal, url }) =>
  answerSummary(pool, {
    principal,
    processKey: url.pathname.split('/')[3]!,
    days: url.searchParams.has('days') ? Number(url.searchParams.get('days')) : undefined,
  }),
);

route('GET', /^\/api\/dashboard\/([a-z0-9_]+)$/, async ({ pool, principal, url }) =>
  dashboard(pool, {
    principal,
    processKey: url.pathname.split('/').pop()!,
    days: Number(url.searchParams.get('days') ?? 30),
  }),
);

// Every record of a process as one CSV: a row each, a column per answer.
route('GET', /^\/api\/browse\/([a-z0-9_]+)\/export$/, async ({ pool, principal, url }) => {
  const args = {
    principal,
    processKey: url.pathname.split('/')[3]!,
    filters: {
      completed: url.searchParams.has('completed') ? url.searchParams.get('completed') === 'true' : undefined,
      query: url.searchParams.get('q') ?? undefined,
      answer:
        url.searchParams.get('field') && url.searchParams.has('value')
          ? { field: url.searchParams.get('field')!, value: url.searchParams.get('value')! }
          : undefined,
    },
  };
  if (url.searchParams.get('format') === 'xlsx') return { contentType: XLSX_TYPE, ...(await exportProcessXlsx(pool, args)) };
  return { contentType: 'text/csv', ...(await exportProcessCsv(pool, args)) };
});

// Push notifications for this device. See runtime/push.ts.
route('GET', /^\/api\/push\/config$/, async () => pushConfig());
route('POST', /^\/api\/push\/subscribe$/, async ({ pool, principal }, body) => {
  const { subscription, userAgent } = body as { subscription?: unknown; userAgent?: string };
  if (!subscription || typeof subscription !== 'object') throw new HttpError(400, 'a subscription is required');
  return saveSubscription(pool, principal, { subscription: subscription as Record<string, unknown>, userAgent });
});
route('POST', /^\/api\/push\/unsubscribe$/, async ({ pool, principal }, body) => {
  const { endpoint } = body as { endpoint?: string };
  if (!endpoint) throw new HttpError(400, 'which device?');
  return removeSubscription(pool, principal, endpoint);
});
route('POST', /^\/api\/push\/test$/, async ({ pool, principal }) => testPush(pool, principal));

// Saved views of the Records page, and the reports scheduled from them.
route('GET', /^\/api\/views\/([a-z0-9_]+)$/, async ({ pool, principal, url }) =>
  listViews(pool, principal, url.pathname.split('/')[3]!),
);
route('POST', /^\/api\/views\/([a-z0-9_]+)$/, async ({ pool, principal, url }, body) => {
  const { name, params, schedule, format } = body as { name?: string; params?: ViewParams; schedule?: Schedule | null; format?: 'csv' | 'xlsx' };
  if (typeof name !== 'string') throw new HttpError(400, 'a name is required');
  return createView(pool, principal, { processKey: url.pathname.split('/')[3]!, name, params: params ?? {}, schedule: schedule ?? null, format });
});
route('POST', /^\/api\/views\/([a-z0-9_]+)\/delete$/, async ({ pool, principal }, body) => {
  const { id } = body as { id?: string };
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'which view?');
  return deleteView(pool, principal, id);
});

// The whole workspace as one workbook, a sheet per process. Administrators.
route('GET', /^\/api\/export\/workspace$/, async ({ pool, principal }) => ({ contentType: XLSX_TYPE, ...(await exportWorkspace(pool, { principal })) }));

// The columns the Records page may show and the answers it may filter by.
route('GET', /^\/api\/browse\/([a-z0-9_]+)\/fields$/, async ({ pool, principal, url }) =>
  browseFields(pool, { principal, processKey: url.pathname.split('/')[3]! }),
);

route('GET', /^\/api\/browse\/([a-z0-9_]+)$/, async ({ pool, principal, url }) =>
  listRecordsPage(pool, {
    principal,
    processKey: url.pathname.split('/').pop()!,
    state: url.searchParams.get('state') ?? undefined,
    completed: url.searchParams.has('completed') ? url.searchParams.get('completed') === 'true' : undefined,
    query: url.searchParams.get('q') ?? undefined,
    answer:
      url.searchParams.get('field') && url.searchParams.has('value')
        ? { field: url.searchParams.get('field')!, value: url.searchParams.get('value')! }
        : undefined,
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

// ---- directory import (ORG-09): check every row first, save only a clean file.
route('POST', /^\/api\/directory\/import$/, async ({ pool, principal }, body) =>
  importDirectory(pool, principal, (body ?? {}) as { rows?: unknown; dryRun?: unknown; sendInvitations?: unknown }),
);

// ---- the organisation directory (PRD Module 1, ORG-02). Reads for every
// member; writes need `administer`, checked inside org.ts.
route('GET', /^\/api\/org$/, async ({ pool, principal }) => orgChart(pool, principal));
route('POST', /^\/api\/org\/entities$/, async ({ pool, principal }, body) =>
  createLegalEntity(pool, principal, (body ?? {}) as { name?: unknown; code?: unknown }),
);
route('POST', /^\/api\/org\/units$/, async ({ pool, principal }, body) =>
  createOrgUnit(pool, principal, (body ?? {}) as Record<string, unknown>),
);
route('POST', /^\/api\/org\/units\/([0-9a-f-]{36})$/, async ({ pool, principal, url }, body) =>
  updateOrgUnit(pool, principal, url.pathname.split('/')[4]!, (body ?? {}) as Record<string, unknown>),
);
route('GET', /^\/api\/members\/([0-9a-f-]{36})\/reporting$/, async ({ pool, principal, url }) =>
  reportingHistory(pool, principal, url.pathname.split('/')[3]!),
);
route('POST', /^\/api\/members\/([0-9a-f-]{36})\/manager$/, async ({ pool, principal, url }, body) =>
  setManager(pool, principal, url.pathname.split('/')[3]!, (body ?? {}) as Record<string, unknown>),
);
route('POST', /^\/api\/members\/([0-9a-f-]{36})\/placement$/, async ({ pool, principal, url }, body) =>
  setMemberPlacement(pool, principal, url.pathname.split('/')[3]!, (body ?? {}) as Record<string, unknown>),
);

// ---- approval authority (PRD ORG-05 to ORG-07). Grants and delegations;
// creating either needs a fresh sign-in (see runtime/step-up.ts).
route('GET', /^\/api\/authority$/, async ({ pool, principal }) => listAuthority(pool, principal));
route('POST', /^\/api\/authority\/grants$/, async ({ pool, principal }, body) =>
  createGrant(pool, principal, (body ?? {}) as Record<string, unknown>),
);
route('POST', /^\/api\/authority\/grants\/([0-9a-f-]{36})\/revoke$/, async ({ pool, principal, url }, body) =>
  revokeAuthorityGrant(pool, principal, url.pathname.split('/')[4]!, (body as { reason?: unknown } | null)?.reason),
);
route('POST', /^\/api\/authority\/delegations$/, async ({ pool, principal }, body) =>
  createDelegation(pool, principal, (body ?? {}) as Record<string, unknown>),
);
route('POST', /^\/api\/authority\/delegations\/([0-9a-f-]{36})\/revoke$/, async ({ pool, principal, url }) =>
  revokeDelegation(pool, principal, url.pathname.split('/')[4]!),
);
route('GET', /^\/api\/audit$/, async ({ pool, principal, url }) =>
  workspaceAudit(pool, principal, Number(url.searchParams.get('limit') ?? 200)),
);

// ---- Expenses (PRD Module 5). Every route refuses when the module is off.
// Reading and recording payments needs `operate`; changing the policy needs `administer`.
route('GET', /^\/api\/expenses\/categories$/, async ({ pool, principal }) => listCategories(pool, principal));
route('POST', /^\/api\/expenses\/categories$/, async ({ pool, principal }, b) => saveCategory(pool, principal, hb(b)));
route('GET', /^\/api\/expenses\/rate-cards$/, async ({ pool, principal }) => listRateCards(pool, principal));
route('POST', /^\/api\/expenses\/rate-cards$/, async ({ pool, principal }, b) => saveRateCard(pool, principal, hb(b)));
route('GET', /^\/api\/expenses\/allowance$/, async ({ pool, principal, url }) => allowance(pool, principal, url.searchParams));
route('GET', /^\/api\/expenses\/runs$/, async ({ pool, principal, url }) => searchPaymentRuns(pool, principal, url.searchParams));
route('POST', /^\/api\/expenses\/runs$/, async ({ pool, principal }, b) => createPaymentRun(pool, principal, hb(b)));
route('GET', /^\/api\/expenses\/runs\/([0-9a-f-]{36})$/, async ({ pool, principal, url }) => paymentRun(pool, principal, hid(url, 4)));
route('GET', /^\/api\/expenses\/runs\/([0-9a-f-]{36})\/bank-file$/, async ({ pool, principal, url }) => paymentRunBankFile(pool, principal, hid(url, 4)));
route('POST', /^\/api\/expenses\/runs\/([0-9a-f-]{36})\/pay$/, async ({ pool, principal, url }, b) => settlePaymentRun(pool, principal, hid(url, 4), hb(b)));
route('POST', /^\/api\/expenses\/runs\/([0-9a-f-]{36})\/cancel$/, async ({ pool, principal, url }) => cancelPaymentRun(pool, principal, hid(url, 4)));
route('GET', /^\/api\/expenses\/report$/, async ({ pool, principal, url }) => expenseReport(pool, principal, url.searchParams));
route('GET', /^\/api\/expenses\/claims\/search$/, async ({ pool, principal, url }) => searchClaims(pool, principal, url.searchParams));
route('GET', /^\/api\/expenses\/advances\/search$/, async ({ pool, principal, url }) => searchAdvances(pool, principal, url.searchParams));
route('GET', /^\/api\/expenses\/mine\/search$/, async ({ pool, principal, url }) => searchMyClaims(pool, principal, url.searchParams));
route('GET', /^\/api\/expenses\/summary$/, async ({ pool, principal }) => expenseSummary(pool, principal));
route('GET', /^\/api\/expenses\/settings$/, async ({ pool, principal }) => readExpenseSettings(pool, principal));
route('POST', /^\/api\/expenses\/settings$/, async ({ pool, principal }, body) =>
  updateExpenseSettings(pool, principal, (body ?? {}) as Record<string, unknown>),
);
route('GET', /^\/api\/expenses\/settlements$/, async ({ pool, principal, url }) =>
  listSettlements(pool, principal, url.searchParams.get('status') ?? undefined),
);
route('POST', /^\/api\/expenses\/settlements\/([0-9a-f-]{36})$/, async ({ pool, principal, url }, body) =>
  moveSettlement(pool, principal, url.pathname.split('/')[4]!, (body ?? {}) as Record<string, unknown>),
);
route('GET', /^\/api\/expenses\/settlements\/([0-9a-f-]{36})\/lines$/, async ({ pool, principal, url }) =>
  settlementLines(pool, principal, url.pathname.split('/')[4]!),
);
route('POST', /^\/api\/expenses\/settlements\/([0-9a-f-]{36})\/lines$/, async ({ pool, principal, url }, body) =>
  reviewLines(pool, principal, url.pathname.split('/')[4]!, (body ?? {}) as { lines?: unknown }),
);
route('POST', /^\/api\/expenses\/settlements\/([0-9a-f-]{36})\/verify-bank$/, async ({ pool, principal, url }) =>
  verifyBeneficiary(pool, principal, url.pathname.split('/')[4]!),
);
route('POST', /^\/api\/expenses\/settlements\/([0-9a-f-]{36})\/bank$/, async ({ pool, principal, url }) =>
  revealBeneficiary(pool, principal, url.pathname.split('/')[4]!),
);
route('GET', /^\/api\/expenses\/bank$/, async ({ pool, principal }) => myBeneficiary(pool, principal));
route('POST', /^\/api\/expenses\/bank$/, async ({ pool, principal }, body) =>
  saveBeneficiary(pool, principal, (body ?? {}) as Record<string, unknown>),
);
route('GET', /^\/api\/expenses\/rates$/, async ({ pool, principal }) => listRates(pool, principal));
route('POST', /^\/api\/expenses\/rates$/, async ({ pool, principal }, body) =>
  addRate(pool, principal, (body ?? {}) as Record<string, unknown>),
);
route('GET', /^\/api\/expenses\/budgets$/, async ({ pool, principal }) => listBudgets(pool, principal));
route('POST', /^\/api\/expenses\/budgets$/, async ({ pool, principal }, body) =>
  saveBudget(pool, principal, (body ?? {}) as Record<string, unknown>),
);
route('GET', /^\/api\/expenses\/exports$/, async ({ pool, principal }) => listExports(pool, principal));
route('POST', /^\/api\/expenses\/exports$/, async ({ pool, principal }, body) =>
  exportPaid(pool, principal, (body ?? {}) as Record<string, unknown>),
);
route('GET', /^\/api\/expenses\/advances$/, async ({ pool, principal }) => listAdvances(pool, principal));
route('GET', /^\/api\/expenses\/advances\/([0-9a-f-]{36})\/movements$/, async ({ pool, principal, url }) =>
  advanceMovements(pool, principal, url.pathname.split('/')[4]!),
);
route('POST', /^\/api\/expenses\/advances\/([0-9a-f-]{36})\/disburse$/, async ({ pool, principal, url }, body) =>
  disburseAdvance(pool, principal, url.pathname.split('/')[4]!, (body ?? {}) as Record<string, unknown>),
);
route('POST', /^\/api\/expenses\/advances\/([0-9a-f-]{36})\/return$/, async ({ pool, principal, url }, body) =>
  recordAdvanceReturn(pool, principal, url.pathname.split('/')[4]!, (body ?? {}) as Record<string, unknown>),
);

// ---- Procurement (PRD Module 6). Every route refuses when the module is off.
const pid = (url: URL, i: number) => url.pathname.split('/')[i]!;
const obj = (b: unknown) => (b ?? {}) as Record<string, unknown>;
route('GET', /^\/api\/procurement\/summary$/, async ({ pool, principal }) => procurementSummary(pool, principal));
route('GET', /^\/api\/procurement\/settings$/, async ({ pool, principal }) => readProcurementSettings(pool, principal));
route('POST', /^\/api\/procurement\/settings$/, async ({ pool, principal }, b) => updateProcurementSettings(pool, principal, obj(b)));
route('GET', /^\/api\/procurement\/vendors$/, async ({ pool, principal }) => listVendors(pool, principal));
route('POST', /^\/api\/procurement\/vendors$/, async ({ pool, principal }, b) => createVendor(pool, principal, obj(b)));
route('POST', /^\/api\/procurement\/vendors\/([0-9a-f-]{36})$/, async ({ pool, principal, url }, b) => updateVendor(pool, principal, pid(url, 4), obj(b)));
route('POST', /^\/api\/procurement\/vendors\/([0-9a-f-]{36})\/status$/, async ({ pool, principal, url }, b) => setVendorStatus(pool, principal, pid(url, 4), obj(b)));
route('GET', /^\/api\/procurement\/vendors\/([0-9a-f-]{36})\/history$/, async ({ pool, principal, url }) => vendorHistory(pool, principal, pid(url, 4)));
route('POST', /^\/api\/procurement\/vendors\/([0-9a-f-]{36})\/bank$/, async ({ pool, principal, url }, b) => saveVendorBank(pool, principal, pid(url, 4), obj(b)));
route('POST', /^\/api\/procurement\/vendors\/([0-9a-f-]{36})\/bank\/verify$/, async ({ pool, principal, url }) => verifyVendorBank(pool, principal, pid(url, 4)));
route('POST', /^\/api\/procurement\/vendors\/([0-9a-f-]{36})\/bank\/reveal$/, async ({ pool, principal, url }) => revealVendorBank(pool, principal, pid(url, 4)));
route('GET', /^\/api\/procurement\/agreements$/, async ({ pool, principal }) => listAgreements(pool, principal));
route('POST', /^\/api\/procurement\/agreements$/, async ({ pool, principal }, b) => createAgreement(pool, principal, obj(b)));
route('GET', /^\/api\/procurement\/requests$/, async ({ pool, principal }) => listRequisitions(pool, principal));
route('GET', /^\/api\/procurement\/requests\/([0-9a-f-]{36})\/quotes$/, async ({ pool, principal, url }) => listQuotes(pool, principal, pid(url, 4)));
route('POST', /^\/api\/procurement\/requests\/([0-9a-f-]{36})\/quotes$/, async ({ pool, principal, url }, b) => addQuote(pool, principal, pid(url, 4), obj(b)));
route('POST', /^\/api\/procurement\/requests\/([0-9a-f-]{36})\/deadline$/, async ({ pool, principal, url }, b) => setQuoteDeadline(pool, principal, pid(url, 4), obj(b)));
route('POST', /^\/api\/procurement\/requests\/([0-9a-f-]{36})\/open-quotes$/, async ({ pool, principal, url }) => openQuotes(pool, principal, pid(url, 4)));
route('POST', /^\/api\/procurement\/requests\/([0-9a-f-]{36})\/select$/, async ({ pool, principal, url }, b) => selectQuote(pool, principal, pid(url, 4), obj(b)));
route('GET', /^\/api\/procurement\/orders$/, async ({ pool, principal }) => listOrders(pool, principal));
route('POST', /^\/api\/procurement\/orders$/, async ({ pool, principal }, b) => createOrder(pool, principal, obj(b)));
route('GET', /^\/api\/procurement\/orders\/([0-9a-f-]{36})$/, async ({ pool, principal, url }) => orderDetail(pool, principal, pid(url, 4)));
route('POST', /^\/api\/procurement\/orders\/([0-9a-f-]{36})\/revise$/, async ({ pool, principal, url }, b) => reviseOrder(pool, principal, pid(url, 4), obj(b)));
route('POST', /^\/api\/procurement\/orders\/([0-9a-f-]{36})\/approve$/, async ({ pool, principal, url }) => approveOrder(pool, principal, pid(url, 4)));
route('POST', /^\/api\/procurement\/orders\/([0-9a-f-]{36})\/cancel$/, async ({ pool, principal, url }, b) => cancelOrder(pool, principal, pid(url, 4), obj(b)));
route('POST', /^\/api\/procurement\/orders\/([0-9a-f-]{36})\/receive$/, async ({ pool, principal, url }, b) => receiveGoods(pool, principal, pid(url, 4), obj(b)));
route('POST', /^\/api\/procurement\/orders\/([0-9a-f-]{36})\/return$/, async ({ pool, principal, url }, b) => returnGoods(pool, principal, pid(url, 4), obj(b)));
route('GET', /^\/api\/procurement\/invoices$/, async ({ pool, principal }) => listInvoices(pool, principal));
route('POST', /^\/api\/procurement\/invoices$/, async ({ pool, principal }, b) => enterInvoice(pool, principal, obj(b)));
route('POST', /^\/api\/procurement\/invoices\/([0-9a-f-]{36})\/review$/, async ({ pool, principal, url }, b) => reviewInvoice(pool, principal, pid(url, 4), obj(b)));
route('POST', /^\/api\/procurement\/invoices\/([0-9a-f-]{36})\/pay$/, async ({ pool, principal, url }, b) => payInvoice(pool, principal, pid(url, 4), obj(b)));
route('POST', /^\/api\/procurement\/invoices\/export$/, async ({ pool, principal }) => exportInvoices(pool, principal));

// ---- HR (PRD Module 7). Every route refuses when the module is off; who may
// do what is decided in runtime/hr.ts.
const hb = (b: unknown) => (b ?? {}) as Record<string, unknown>;
const hid = (url: URL, i: number) => url.pathname.split('/')[i]!;
route('GET', /^\/api\/hr\/summary$/, async ({ pool, principal }) => hrSummary(pool, principal));
route('GET', /^\/api\/hr\/settings$/, async ({ pool, principal }) => readHrSettings(pool, principal));
route('POST', /^\/api\/hr\/settings$/, async ({ pool, principal }, b) => updateHrSettings(pool, principal, hb(b)));
route('GET', /^\/api\/hr\/teams$/, async ({ pool, principal }) => listTeams(pool, principal));
route('POST', /^\/api\/hr\/teams$/, async ({ pool, principal }, b) => setTeamMember(pool, principal, hb(b)));
route('GET', /^\/api\/hr\/templates$/, async ({ pool, principal }) => listTemplates(pool, principal));
route('POST', /^\/api\/hr\/templates$/, async ({ pool, principal }, b) => saveTemplate(pool, principal, hb(b)));
route('GET', /^\/api\/hr\/employees$/, async ({ pool, principal }) => listEmployees(pool, principal));
route('POST', /^\/api\/hr\/employees\/([0-9a-f-]{36})$/, async ({ pool, principal, url }, b) => updateEmployee(pool, principal, hid(url, 4), hb(b)));
route('GET', /^\/api\/hr\/employees\/([0-9a-f-]{36})\/pay$/, async ({ pool, principal, url }) => listCompensation(pool, principal, hid(url, 4)));
route('POST', /^\/api\/hr\/employees\/([0-9a-f-]{36})\/pay$/, async ({ pool, principal, url }, b) => setCompensation(pool, principal, hid(url, 4), hb(b)));
route('POST', /^\/api\/hr\/employees\/([0-9a-f-]{36})\/certifications$/, async ({ pool, principal, url }, b) => addCertification(pool, principal, hid(url, 4), hb(b)));
route('GET', /^\/api\/hr\/cases$/, async ({ pool, principal, url }) => listCases(pool, principal, { status: url.searchParams.get('status') ?? undefined }));
route('POST', /^\/api\/hr\/cases\/onboarding$/, async ({ pool, principal }, b) => startOnboarding(pool, principal, hb(b)));
route('POST', /^\/api\/hr\/cases\/offboarding$/, async ({ pool, principal }, b) => startOffboarding(pool, principal, hb(b)));
route('POST', /^\/api\/hr\/cases\/urgent-termination$/, async ({ pool, principal }, b) => urgentTermination(pool, principal, hb(b)));
route('POST', /^\/api\/hr\/cases\/transfer$/, async ({ pool, principal }, b) => startTransfer(pool, principal, hb(b)));
route('POST', /^\/api\/hr\/cases\/probation$/, async ({ pool, principal }, b) => startProbationReview(pool, principal, hb(b)));
route('POST', /^\/api\/hr\/cases\/([0-9a-f-]{36})\/probation-decision$/, async ({ pool, principal, url }, b) => decideProbation(pool, principal, hid(url, 4), hb(b)));
route('GET', /^\/api\/hr\/cases\/([0-9a-f-]{36})\/notes$/, async ({ pool, principal, url }) => listCaseNotes(pool, principal, hid(url, 4)));
route('POST', /^\/api\/hr\/cases\/([0-9a-f-]{36})\/notes$/, async ({ pool, principal, url }, b) => addCaseNote(pool, principal, hid(url, 4), hb(b)));
route('GET', /^\/api\/hr\/tasks\/mine$/, async ({ pool, principal }) => myTasks(pool, principal));
route('POST', /^\/api\/hr\/tasks\/([0-9a-f-]{36})\/complete$/, async ({ pool, principal, url }, b) => completeTask(pool, principal, hid(url, 4), hb(b)));
route('POST', /^\/api\/hr\/tasks\/([0-9a-f-]{36})\/except$/, async ({ pool, principal, url }, b) => exceptTask(pool, principal, hid(url, 4), hb(b)));
route('GET', /^\/api\/hr\/leave\/types$/, async ({ pool, principal }) => listLeaveTypes(pool, principal));
route('POST', /^\/api\/hr\/leave\/types$/, async ({ pool, principal }, b) => saveLeaveType(pool, principal, hb(b)));
route('GET', /^\/api\/hr\/leave\/holidays$/, async ({ pool, principal }) => listHolidays(pool, principal));
route('POST', /^\/api\/hr\/leave\/holidays$/, async ({ pool, principal }, b) => saveHoliday(pool, principal, hb(b)));
route('GET', /^\/api\/hr\/leave\/mine$/, async ({ pool, principal }) => myLeave(pool, principal));
route('POST', /^\/api\/hr\/leave$/, async ({ pool, principal }, b) => requestLeave(pool, principal, hb(b)));
route('GET', /^\/api\/hr\/leave\/to-approve$/, async ({ pool, principal }) => leaveToApprove(pool, principal));
route('POST', /^\/api\/hr\/leave\/([0-9a-f-]{36})\/decide$/, async ({ pool, principal, url }, b) => decideLeave(pool, principal, hid(url, 4), hb(b)));
route('POST', /^\/api\/hr\/leave\/([0-9a-f-]{36})\/cancel$/, async ({ pool, principal, url }) => cancelLeave(pool, principal, hid(url, 4)));
route('POST', /^\/api\/hr\/leave\/entitlements$/, async ({ pool, principal }, b) => setEntitlement(pool, principal, hb(b)));
route('GET', /^\/api\/hr\/documents$/, async ({ pool, principal }) => listDocuments(pool, principal));
route('POST', /^\/api\/hr\/documents$/, async ({ pool, principal }, b) => createDocument(pool, principal, hb(b)));
route('POST', /^\/api\/hr\/documents\/([0-9a-f-]{36})\/send$/, async ({ pool, principal, url }, b) => sendDocument(pool, principal, hid(url, 4), hb(b)));
route('GET', /^\/api\/hr\/documents\/mine$/, async ({ pool, principal }) => myDocuments(pool, principal));
route('POST', /^\/api\/hr\/documents\/requests\/([0-9a-f-]{36})\/acknowledge$/, async ({ pool, principal, url }) => acknowledgeDocument(pool, principal, hid(url, 5)));
route('GET', /^\/api\/hr\/reconciliation$/, async ({ pool, principal }) => listReconciliations(pool, principal));
route('POST', /^\/api\/hr\/reconciliation\/([0-9a-f-]{36})$/, async ({ pool, principal, url }, b) => resolveReconciliation(pool, principal, hid(url, 4), hb(b)));
route('GET', /^\/api\/hr\/upcoming$/, async ({ pool, principal, url }) => upcoming(pool, principal, Number(url.searchParams.get('days') ?? 60)));
route('GET', /^\/api\/hr\/branches$/, async ({ pool, principal }) => listBranches(pool, principal));
route('POST', /^\/api\/hr\/branches$/, async ({ pool, principal }, b) => saveBranch(pool, principal, hb(b)));
route('POST', /^\/api\/hr\/employees\/([0-9a-f-]{36})\/branch$/, async ({ pool, principal, url }, b) => setEmployeeBranch(pool, principal, hid(url, 4), hb(b)));
route('GET', /^\/api\/approvals\/policies$/, async ({ pool, principal }) => listPolicies(pool, principal));
route('POST', /^\/api\/approvals\/policies$/, async ({ pool, principal }, b) => savePolicy(pool, principal, hb(b)));
route('POST', /^\/api\/approvals\/policies\/([0-9a-f-]{36})\/active$/, async ({ pool, principal, url }, b) => setPolicyActive(pool, principal, hid(url, 4), hb(b).active !== false));
route('POST', /^\/api\/approvals\/templates\/adopt$/, async ({ pool, principal }, b) => adoptTemplate(pool, principal, hb(b)));
route('POST', /^\/api\/approvals\/simulate$/, async ({ pool, principal }, b) => simulatePolicy(pool, principal, hb(b)));
route('GET', /^\/api\/approvals\/overview$/, async ({ pool, principal }) => approvalsOverview(pool, principal));
route('GET', /^\/api\/records\/([0-9a-f-]{36})\/approvals\/([a-z0-9_]+)\/evidence$/, async ({ pool, principal, url }) => listEvidence(pool, principal, hid(url, 3), hid(url, 5)));
route('POST', /^\/api\/records\/([0-9a-f-]{36})\/approvals\/([a-z0-9_]+)\/evidence\/files$/, async ({ pool, principal, url }, b) => uploadEvidence(pool, principal, hid(url, 3), hid(url, 5), hb(b)));
route('GET', /^\/api\/approvals\/evidence\/([0-9a-f-]{36})\/link$/, async ({ pool, principal, url }) => evidenceLink(pool, principal, hid(url, 4)));
route('GET', /^\/api\/general-approvals\/types$/, async ({ pool, principal }) => ga.listTypes(pool, principal));
route('POST', /^\/api\/general-approvals\/types$/, async ({ pool, principal }, b) => ga.saveType(pool, principal, hb(b)));
route('GET', /^\/api\/general-approvals\/requests$/, async ({ pool, principal, url }) => ga.listRequests(pool, principal, url.searchParams.get('scope') ?? 'mine'));
route('POST', /^\/api\/general-approvals\/requests$/, async ({ pool, principal }, b) => ga.createRequest(pool, principal, hb(b)));
route('GET', /^\/api\/general-approvals\/requests\/([0-9a-f-]{36})$/, async ({ pool, principal, url }) => ga.requestDetail(pool, principal, hid(url, 4)));
route('POST', /^\/api\/general-approvals\/requests\/([0-9a-f-]{36})$/, async ({ pool, principal, url }, b) => ga.editRequest(pool, principal, hid(url, 4), hb(b)));
route('POST', /^\/api\/general-approvals\/requests\/([0-9a-f-]{36})\/submit$/, async ({ pool, principal, url }) => ga.submitRequest(pool, principal, hid(url, 4)));
route('POST', /^\/api\/general-approvals\/requests\/([0-9a-f-]{36})\/decide$/, async ({ pool, principal, url }, b) => ga.decideRequest(pool, principal, hid(url, 4), hb(b)));
route('POST', /^\/api\/general-approvals\/requests\/([0-9a-f-]{36})\/share$/, async ({ pool, principal, url }, b) => ga.setRequestShare(pool, principal, hid(url, 4), hb(b)));
route('POST', /^\/api\/general-approvals\/requests\/([0-9a-f-]{36})\/files$/, async ({ pool, principal, url }, b) => ga.uploadFile(pool, principal, hid(url, 4), hb(b)));
route('GET', /^\/api\/general-approvals\/requests\/([0-9a-f-]{36})\/files\/([0-9a-f-]{36})$/, async ({ pool, principal, url }) => ga.fileLink(pool, principal, hid(url, 4), hid(url, 6)));
route('GET', /^\/api\/hr\/cases\/search$/, async ({ pool, principal, url }) => searchCases(pool, principal, url.searchParams));
route('GET', /^\/api\/hr\/leave\/search$/, async ({ pool, principal, url }) => searchLeave(pool, principal, url.searchParams));
route('GET', /^\/api\/hr\/hiring\/search$/, async ({ pool, principal, url }) => searchHiring(pool, principal, url.searchParams));
route('GET', /^\/api\/hr\/upcoming\/search$/, async ({ pool, principal, url }) => searchUpcoming(pool, principal, url.searchParams));
route('GET', /^\/api\/hr\/reconciliation\/search$/, async ({ pool, principal, url }) => searchReconciliation(pool, principal, url.searchParams));
route('GET', /^\/api\/hr\/leave\/holidays\/search$/, async ({ pool, principal, url }) => searchHolidays(pool, principal, url.searchParams));
route('GET', /^\/api\/hr\/documents\/search$/, async ({ pool, principal, url }) => searchDocuments(pool, principal, url.searchParams));
route('GET', /^\/api\/hr\/employees\/search$/, async ({ pool, principal, url }) => searchEmployees(pool, principal, url.searchParams));
route('GET', /^\/api\/hr\/me$/, async ({ pool, principal }) => myProfile(pool, principal));
route('GET', /^\/api\/hr\/org$/, async ({ pool, principal }) => orgTree(pool, principal));
route('GET', /^\/api\/hr\/employees\/([0-9a-f-]{36})$/, async ({ pool, principal, url }) => employeeDetail(pool, principal, hid(url, 4)));
route('POST', /^\/api\/hr\/employees\/([0-9a-f-]{36})\/profile$/, async ({ pool, principal, url }, b) => updateProfile(pool, principal, hid(url, 4), hb(b)));
route('POST', /^\/api\/hr\/employees\/([0-9a-f-]{36})\/events$/, async ({ pool, principal, url }, b) => addEmployeeEvent(pool, principal, hid(url, 4), hb(b)));
route('POST', /^\/api\/hr\/employees\/([0-9a-f-]{36})\/files$/, async ({ pool, principal, url }, b) => uploadEmployeeFile(pool, principal, hid(url, 4), hb(b)));
route('GET', /^\/api\/hr\/files\/([0-9a-f-]{36})\/link$/, async ({ pool, principal, url }) => employeeFileLink(pool, principal, hid(url, 4)));
route('POST', /^\/api\/hr\/files\/([0-9a-f-]{36})\/visibility$/, async ({ pool, principal, url }, b) => setEmployeeFileVisibility(pool, principal, hid(url, 4), hb(b)));
route('POST', /^\/api\/hr\/files\/([0-9a-f-]{36})\/remove$/, async ({ pool, principal, url }) => removeEmployeeFile(pool, principal, hid(url, 4)));
route('POST', /^\/api\/hr\/documents\/([0-9a-f-]{36})\/files$/, async ({ pool, principal, url }, b) => uploadDocumentFile(pool, principal, hid(url, 4), hb(b)));
route('GET', /^\/api\/hr\/documents\/([0-9a-f-]{36})\/link$/, async ({ pool, principal, url }) => documentFileLink(pool, principal, hid(url, 4)));
route('GET', /^\/api\/hr\/leave\/calendar$/, async ({ pool, principal, url }) => leaveCalendar(pool, principal, url.searchParams.get('month') ?? new Date().toISOString().slice(0, 7)));
route('GET', /^\/api\/hr\/leave\/ledger$/, async ({ pool, principal, url }) => leaveLedger(pool, principal, url.searchParams.get('employee'), Number(url.searchParams.get('year') ?? new Date().getUTCFullYear())));
route('POST', /^\/api\/hr\/leave\/adjust$/, async ({ pool, principal }, b) => adjustLeave(pool, principal, hb(b)));
route('GET', /^\/api\/hr\/hiring$/, async ({ pool, principal }) => listHiring(pool, principal));

// ---- Goals, appraisals and development (PRD Module 8). Who may see and do
// what is decided in runtime/appraisals.ts.
const A = '([0-9a-f-]{36})';
const ar = (re: string) => new RegExp(`^/api/appraisals/${re}$`);
route('GET', ar('summary'), async ({ pool, principal }) => apr.appraisalSummary(pool, principal));
route('GET', ar('templates'), async ({ pool, principal }) => apr.listTemplates(pool, principal));
route('POST', ar('templates'), async ({ pool, principal }, b) => apr.saveTemplate(pool, principal, hb(b)));
route('POST', ar(`templates/${A}/publish`), async ({ pool, principal, url }) => apr.publishTemplate(pool, principal, hid(url, 4)));
route('GET', ar('cycles'), async ({ pool, principal }) => apr.listCycles(pool, principal));
route('POST', ar('cycles'), async ({ pool, principal }, b) => apr.createCycle(pool, principal, hb(b)));
route('POST', ar(`cycles/${A}/launch`), async ({ pool, principal, url }) => apr.launchCycle(pool, principal, hid(url, 4)));
route('GET', ar(`cycles/${A}/calibration`), async ({ pool, principal, url }) => apr.calibrationView(pool, principal, hid(url, 4)));
route('GET', ar(`cycles/${A}/report`), async ({ pool, principal, url }) => apr.cycleReport(pool, principal, hid(url, 4)));
route('POST', ar(`cycles/${A}/publish`), async ({ pool, principal, url }, b) => apr.publishCycle(pool, principal, hid(url, 4), hb(b)));
route('POST', ar(`participants/${A}/reviewer`), async ({ pool, principal, url }, b) => apr.assignReviewer(pool, principal, hid(url, 4), hb(b)));
route('POST', ar(`participants/${A}/peer`), async ({ pool, principal, url }, b) => apr.addPeerReviewer(pool, principal, hid(url, 4), hb(b)));
route('POST', ar(`participants/${A}/calibrate`), async ({ pool, principal, url }, b) => apr.adjustScore(pool, principal, hid(url, 4), hb(b)));
route('POST', ar(`participants/${A}/acknowledge`), async ({ pool, principal, url }) => apr.acknowledgeResult(pool, principal, hid(url, 4)));
route('POST', ar(`participants/${A}/appeal`), async ({ pool, principal, url }, b) => apr.appealResult(pool, principal, hid(url, 4), hb(b)));
route('GET', ar('reviews/mine'), async ({ pool, principal }) => apr.myAssignments(pool, principal));
route('GET', ar(`reviews/${A}`), async ({ pool, principal, url }) => apr.assessmentForm(pool, principal, hid(url, 4)));
route('POST', ar(`reviews/${A}`), async ({ pool, principal, url }, b) => apr.saveAssessment(pool, principal, hid(url, 4), hb(b)));
route('GET', ar('results/mine'), async ({ pool, principal }) => apr.myResults(pool, principal));
route('GET', ar('appeals'), async ({ pool, principal }) => apr.listAppeals(pool, principal));
route('POST', ar(`appeals/${A}/reviewer`), async ({ pool, principal, url }, b) => apr.assignAppealReviewer(pool, principal, hid(url, 4), hb(b)));
route('POST', ar(`appeals/${A}/decide`), async ({ pool, principal, url }, b) => apr.decideAppeal(pool, principal, hid(url, 4), hb(b)));
route('GET', ar('recommendations'), async ({ pool, principal }) => apr.listRecommendations(pool, principal));
route('POST', ar(`recommendations/${A}/decide`), async ({ pool, principal, url }, b) => apr.decideRecommendation(pool, principal, hid(url, 4), hb(b)));
route('GET', ar('goals'), async ({ pool, principal, url }) => apr.listGoals(pool, principal, { ownerId: url.searchParams.get('owner') ?? undefined }));
route('GET', ar('goals/team'), async ({ pool, principal }) => apr.teamGoals(pool, principal));
route('POST', ar('goals'), async ({ pool, principal }, b) => apr.createGoal(pool, principal, hb(b)));
route('GET', ar(`goals/${A}`), async ({ pool, principal, url }) => apr.goalDetail(pool, principal, hid(url, 4)));
route('POST', ar(`goals/${A}`), async ({ pool, principal, url }, b) => apr.updateGoal(pool, principal, hid(url, 4), hb(b)));
route('POST', ar(`goals/${A}/submit`), async ({ pool, principal, url }) => apr.submitGoal(pool, principal, hid(url, 4)));
route('POST', ar(`goals/${A}/decide`), async ({ pool, principal, url }, b) => apr.decideGoal(pool, principal, hid(url, 4), hb(b)));
route('POST', ar(`goals/${A}/steps`), async ({ pool, principal, url }, b) => apr.addGoalStep(pool, principal, hid(url, 4), hb(b)));
route('POST', ar(`goals/${A}/steps/${A}`), async ({ pool, principal, url }, b) => apr.updateGoalStep(pool, principal, hid(url, 4), hid(url, 6), hb(b)));
route('POST', ar(`goals/${A}/completion`), async ({ pool, principal, url }, b) => apr.decideGoalCompletion(pool, principal, hid(url, 4), hb(b)));
route('POST', ar(`goals/${A}/files`), async ({ pool, principal, url }, b) => uploadGoalFile(pool, principal, hid(url, 4), hb(b)));
route('GET', ar(`goals/${A}/files/${A}`), async ({ pool, principal, url }) => goalFileLink(pool, principal, hid(url, 4), hid(url, 6)));
route('POST', ar(`goals/${A}/approve`), async ({ pool, principal, url }) => apr.approveGoal(pool, principal, hid(url, 4)));
route('POST', ar('goals/revisions/(\d+)/decide'), async ({ pool, principal, url }, b) => apr.decideGoalRevision(pool, principal, hid(url, 5), hb(b)));
route('GET', ar('development'), async ({ pool, principal, url }) => apr.listDevelopment(pool, principal, { employeeId: url.searchParams.get('employee') ?? undefined }));
route('POST', ar('development'), async ({ pool, principal }, b) => apr.addDevelopmentItem(pool, principal, hb(b)));
route('POST', ar(`development/${A}/close`), async ({ pool, principal, url }, b) => apr.completeDevelopmentItem(pool, principal, hid(url, 4), hb(b)));

// ---- Assets, IT and service operations (PRD Module 9). Who may see and do
// what is decided in runtime/ops.ts.
const or = (re: string) => new RegExp(`^/api/ops/${re}$`);
route('GET', or('summary'), async ({ pool, principal }) => ops.opsSummary(pool, principal));
route('GET', or('dashboard'), async ({ pool, principal }) => ops.opsDashboard(pool, principal));
route('GET', or('settings'), async ({ pool, principal }) => ops.readOpsSettings(pool, principal));
route('POST', or('settings'), async ({ pool, principal }, b) => ops.updateOpsSettings(pool, principal, hb(b)));
route('POST', or('teams'), async ({ pool, principal }, b) => ops.setOpsTeamMember(pool, principal, hb(b)));
route('GET', or('assets'), async ({ pool, principal, url }) => ops.listAssets(pool, principal, { status: url.searchParams.get('status') ?? undefined, q: url.searchParams.get('q') ?? undefined }));
route('POST', or('assets'), async ({ pool, principal }, b) => ops.registerAsset(pool, principal, hb(b)));
route('GET', or('assets/awaiting-registration'), async ({ pool, principal }) => ops.awaitingRegistration(pool, principal));
route('GET', or('assets/awaiting-recovery'), async ({ pool, principal }) => ops.awaitingRecovery(pool, principal));
route('GET', or('assets/mine'), async ({ pool, principal }) => ops.myAssets(pool, principal));
route('GET', or(`assets/${A}`), async ({ pool, principal, url }) => ops.assetDetail(pool, principal, hid(url, 4)));
route('POST', or(`assets/${A}`), async ({ pool, principal, url }, b) => ops.updateAsset(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`assets/${A}/assign`), async ({ pool, principal, url }, b) => ops.assignAsset(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`assets/${A}/lift-restriction`), async ({ pool, principal, url }, b) => ops.liftRestriction(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`assignments/${A}/approve`), async ({ pool, principal, url }) => ops.approveAssignment(pool, principal, hid(url, 4)));
route('POST', or(`assignments/${A}/acknowledge`), async ({ pool, principal, url }) => ops.acknowledgeAssignment(pool, principal, hid(url, 4)));
route('POST', or(`assignments/${A}/return`), async ({ pool, principal, url }, b) => ops.returnAsset(pool, principal, hid(url, 4), hb(b)));
route('GET', or('systems'), async ({ pool, principal }) => ops.listSystems(pool, principal));
route('POST', or('systems'), async ({ pool, principal }, b) => ops.saveSystem(pool, principal, hb(b)));
route('POST', or(`systems/${A}/test`), async ({ pool, principal, url }) => ops.testSystemConnector(pool, principal, hid(url, 4)));
route('GET', or('access'), async ({ pool, principal }) => ops.listAccess(pool, principal));
route('POST', or('access'), async ({ pool, principal }, b) => ops.requestAccess(pool, principal, hb(b)));
route('POST', or(`access/${A}/decide`), async ({ pool, principal, url }, b) => ops.decideAccess(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`access/${A}/provisioned`), async ({ pool, principal, url }, b) => ops.confirmProvisioning(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`access/${A}/failed`), async ({ pool, principal, url }, b) => ops.failProvisioning(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`grants/${A}/revoked`), async ({ pool, principal, url }, b) => ops.confirmRevocation(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`grants/${A}/revoke-failed`), async ({ pool, principal, url }, b) => ops.failRevocation(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`grants/${A}/review`), async ({ pool, principal, url }, b) => ops.reviewGrant(pool, principal, hid(url, 4), hb(b)));
route('GET', or('services'), async ({ pool, principal }) => ops.listServiceTypes(pool, principal));
route('POST', or('services'), async ({ pool, principal }, b) => ops.saveServiceType(pool, principal, hb(b)));
route('GET', or('tickets'), async ({ pool, principal, url }) => ops.listTickets(pool, principal, { scope: url.searchParams.get('scope') ?? undefined }));
route('POST', or('tickets'), async ({ pool, principal }, b) => ops.openTicket(pool, principal, hb(b)));
route('GET', or(`tickets/${A}`), async ({ pool, principal, url }) => ops.ticketDetail(pool, principal, hid(url, 4)));
route('POST', or(`tickets/${A}/decide`), async ({ pool, principal, url }, b) => ops.decideTicket(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`tickets/${A}/work`), async ({ pool, principal, url }, b) => ops.workTicket(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`tickets/${A}/requester`), async ({ pool, principal, url }, b) => ops.requesterTicket(pool, principal, hid(url, 4), hb(b)));
route('GET', or('maintenance'), async ({ pool, principal }) => ops.listMaintenance(pool, principal));
route('POST', or('photos'), async ({ pool, principal }, b) => uploadOpsPhoto(pool, principal, hb(b)));
route('GET', or(`photos/${A}`), async ({ pool, principal, url }) => opsPhotoLink(pool, principal, hid(url, 4)));
route('POST', or('maintenance/plans'), async ({ pool, principal }, b) => ops.createPlan(pool, principal, hb(b)));
route('POST', or(`maintenance/jobs/${A}/draft`), async ({ pool, principal, url }, b) => ops.saveJobDraft(pool, principal, hid(url, 5), hb(b)));
route('POST', or(`maintenance/jobs/${A}/complete`), async ({ pool, principal, url }, b) => ops.completeJob(pool, principal, hid(url, 5), hb(b)));
route('GET', or('changes'), async ({ pool, principal }) => ops.listChanges(pool, principal));
route('POST', or('changes'), async ({ pool, principal }, b) => ops.createChange(pool, principal, hb(b)));
route('POST', or(`changes/${A}/decide`), async ({ pool, principal, url }, b) => ops.decideChange(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`changes/${A}/precondition`), async ({ pool, principal, url }, b) => ops.checkPrecondition(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`changes/${A}/start`), async ({ pool, principal, url }) => ops.startChange(pool, principal, hid(url, 4)));
route('POST', or(`changes/${A}/finish`), async ({ pool, principal, url }, b) => ops.finishChange(pool, principal, hid(url, 4), hb(b)));
route('POST', or(`changes/${A}/review`), async ({ pool, principal, url }, b) => ops.reviewEmergencyChange(pool, principal, hid(url, 4), hb(b)));

// ---- Contracts, compliance and audit (PRD Module 10). Who may see and do
// what is decided in runtime/gov.ts; auditors reach only the engagement reads.
const gr = (re: string) => new RegExp(`^/api/gov/${re}$`);
route('GET', gr('dashboard'), async ({ pool, principal }) => gov.govDashboard(pool, principal));
route('GET', gr('settings'), async ({ pool, principal }) => gov.readGovSettings(pool, principal));
route('POST', gr('settings'), async ({ pool, principal }, b) => gov.updateGovSettings(pool, principal, hb(b)));
route('POST', gr('teams'), async ({ pool, principal }, b) => gov.setGovTeamMember(pool, principal, hb(b)));
route('GET', gr('contracts'), async ({ pool, principal }) => gov.listContracts(pool, principal));
route('POST', gr('contracts'), async ({ pool, principal }, b) => gov.createContract(pool, principal, hb(b)));
route('GET', gr(`contracts/${A}`), async ({ pool, principal, url }) => gov.contractDetail(pool, principal, hid(url, 4)));
route('POST', gr(`contracts/${A}/revise`), async ({ pool, principal, url }, b) => gov.reviseContract(pool, principal, hid(url, 4), hb(b)));
route('POST', gr(`contracts/${A}/submit`), async ({ pool, principal, url }) => gov.submitContract(pool, principal, hid(url, 4)));
route('POST', gr(`contracts/${A}/review`), async ({ pool, principal, url }, b) => gov.reviewContract(pool, principal, hid(url, 4), hb(b)));
route('POST', gr(`contracts/${A}/signature`), async ({ pool, principal, url }, b) => gov.sendForSignature(pool, principal, hid(url, 4), hb(b)));
route('POST', gr(`envelopes/${A}`), async ({ pool, principal, url }, b) => gov.updateEnvelope(pool, principal, hid(url, 4), hb(b)));
route('POST', gr('obligations'), async ({ pool, principal }, b) => gov.createObligation(pool, principal, hb(b)));
route('POST', gr(`obligations/${A}/trigger`), async ({ pool, principal, url }, b) => gov.triggerObligation(pool, principal, hid(url, 4), hb(b)));
route('GET', gr('tasks'), async ({ pool, principal, url }) => gov.listTasks(pool, principal, { scope: url.searchParams.get('scope') ?? undefined }));
route('POST', gr(`tasks/${A}/complete`), async ({ pool, principal, url }, b) => gov.completeGovTask(pool, principal, hid(url, 4), hb(b)));
route('GET', gr('policies'), async ({ pool, principal }) => gov.listPolicies(pool, principal));
route('POST', gr('policies'), async ({ pool, principal }, b) => gov.createPolicy(pool, principal, hb(b)));
route('POST', gr(`policies/${A}/versions`), async ({ pool, principal, url }, b) => gov.newPolicyVersion(pool, principal, hid(url, 4), hb(b)));
route('POST', gr(`policy-versions/${A}/approve`), async ({ pool, principal, url }) => gov.approvePolicyVersion(pool, principal, hid(url, 4)));
route('POST', gr(`policy-versions/${A}/publish`), async ({ pool, principal, url }, b) => gov.publishPolicyVersion(pool, principal, hid(url, 4), hb(b)));
route('POST', gr(`policy-versions/${A}/campaign`), async ({ pool, principal, url }, b) => gov.startCampaign(pool, principal, hid(url, 4), hb(b)));
route('GET', gr('acknowledgements/mine'), async ({ pool, principal }) => gov.myAcknowledgements(pool, principal));
route('POST', gr(`campaigns/${A}/acknowledge`), async ({ pool, principal, url }) => gov.acknowledgePolicy(pool, principal, hid(url, 4)));
route('GET', gr('controls'), async ({ pool, principal }) => gov.listControls(pool, principal));
route('POST', gr('controls'), async ({ pool, principal }, b) => gov.saveControl(pool, principal, hb(b)));
route('POST', gr(`controls/${A}/test`), async ({ pool, principal, url }, b) => gov.recordControlTest(pool, principal, hid(url, 4), hb(b)));
route('GET', gr('exceptions'), async ({ pool, principal }) => gov.listExceptions(pool, principal));
route('POST', gr('exceptions'), async ({ pool, principal }, b) => gov.requestException(pool, principal, hb(b)));
route('POST', gr(`exceptions/${A}/decide`), async ({ pool, principal, url }, b) => gov.decideException(pool, principal, hid(url, 4), hb(b)));
route('GET', gr('engagements'), async ({ pool, principal }) => gov.listEngagements(pool, principal));
route('POST', gr('engagements'), async ({ pool, principal }, b) => gov.createEngagement(pool, principal, hb(b)));
route('GET', gr(`engagements/${A}`), async ({ pool, principal, url }) => gov.engagementView(pool, principal, hid(url, 4)));
route('POST', gr(`engagements/${A}`), async ({ pool, principal, url }, b) => gov.updateEngagement(pool, principal, hid(url, 4), hb(b)));
route('GET', gr(`engagements/${A}/records/${A}`), async ({ pool, principal, url }) => gov.engagementRecord(pool, principal, hid(url, 4), hid(url, 6)));
route('POST', gr(`engagements/${A}/auditors`), async ({ pool, principal, url }, b) => gov.grantAuditor(pool, principal, hid(url, 4), hb(b)));
route('POST', gr(`engagements/${A}/auditors/revoke`), async ({ pool, principal, url }, b) => gov.revokeAuditor(pool, principal, hid(url, 4), hb(b)));
route('GET', gr(`engagements/${A}/access-log`), async ({ pool, principal, url }) => gov.auditorLog(pool, principal, hid(url, 4)));
route('POST', gr(`engagements/${A}/requests`), async ({ pool, principal, url }, b) => gov.addEvidenceRequest(pool, principal, hid(url, 4), hb(b)));
route('POST', gr(`engagements/${A}/findings`), async ({ pool, principal, url }, b) => gov.raiseFinding(pool, principal, hid(url, 4), hb(b)));
route('POST', gr(`engagements/${A}/pack`), async ({ pool, principal, url }) => gov.buildEvidencePack(pool, principal, hid(url, 4)));
route('POST', gr(`requests/${A}/evidence`), async ({ pool, principal, url }, b) => gov.submitEvidence(pool, principal, hid(url, 4), hb(b)));
route('POST', gr(`requests/${A}/decide`), async ({ pool, principal, url }, b) => gov.decideEvidence(pool, principal, hid(url, 4), hb(b)));
route('GET', gr('findings/mine'), async ({ pool, principal }) => gov.myFindings(pool, principal));
route('POST', gr(`findings/${A}`), async ({ pool, principal, url }, b) => gov.workFinding(pool, principal, hid(url, 4), hb(b)));
route('GET', gr('holds'), async ({ pool, principal }) => gov.listHolds(pool, principal));
route('POST', gr('holds'), async ({ pool, principal }, b) => gov.createHold(pool, principal, hb(b)));
route('POST', gr(`holds/${A}/release`), async ({ pool, principal, url }, b) => gov.releaseHold(pool, principal, hid(url, 4), hb(b)));
route('POST', gr(`holds/${A}/clear`), async ({ pool, principal, url }, b) => gov.clearHold(pool, principal, hid(url, 4), hb(b)));
route('POST', gr('retention-schedules'), async ({ pool, principal }, b) => gov.setRetentionSchedule(pool, principal, hb(b)));
route('POST', gr('files'), async ({ pool, principal }, b) => gov.uploadGovFile(pool, principal, hb(b)));
route('GET', gr(`files/${A}`), async ({ pool, principal, url }) => gov.govFileLink(pool, principal, hid(url, 4)));
route('POST', gr(`envelopes/${A}/check`), async ({ pool, principal, url }) => gov.checkEnvelopeNow(pool, principal, hid(url, 4)));
route('POST', gr('docusign/test'), async ({ pool, principal }) => gov.testDocusignConnection(pool, principal));

// ---- Patform Sign, the sender's side (signers use the public routes before the session gate).
const sr = (re: string) => new RegExp(`^/api/sign/${re}$`);
route('GET', sr('envelopes'), async ({ pool, principal }) => esign.listEnvelopes(pool, principal));
route('GET', sr('summary'), async ({ pool, principal }) => esign.signSummary(pool, principal));
route('GET', sr('mine'), async ({ pool, principal }) => esign.mySignatures(pool, principal));
route('GET', sr('templates'), async ({ pool, principal }) => esign.listTemplates(pool, principal));
route('POST', sr('templates'), async ({ pool, principal }, b) => esign.saveTemplate(pool, principal, hb(b)));
route('POST', sr(`templates/${A}/delete`), async ({ pool, principal, url }) => esign.deleteTemplate(pool, principal, hid(url, 4)));
route('POST', sr('envelopes'), async ({ pool, principal }, b) => esign.createEnvelope(pool, principal, hb(b)));
route('GET', sr(`envelopes/${A}`), async ({ pool, principal, url }) => esign.envelopeDetail(pool, principal, hid(url, 4)));
route('GET', sr(`envelopes/${A}/document`), async ({ pool, principal, url }) => new RawBody(await esign.envelopeDocument(pool, principal, hid(url, 4)), 'application/pdf'));
route('POST', sr(`envelopes/${A}/fields`), async ({ pool, principal, url }, b) => esign.setFields(pool, principal, hid(url, 4), hb(b)));
route('POST', sr(`envelopes/${A}/send`), async ({ pool, principal, url }) => esign.sendEnvelope(pool, principal, hid(url, 4)));
route('POST', sr(`envelopes/${A}/void`), async ({ pool, principal, url }, b) => esign.voidEnvelope(pool, principal, hid(url, 4), hb(b)));
route('POST', sr(`envelopes/${A}/remind`), async ({ pool, principal, url }) => esign.remindNow(pool, principal, hid(url, 4)));

// ---- workspace export and closure (PRD 17.3): owners only; deletion needs a site owner.
route('GET', /^\/api\/workspace\/exports$/, async ({ pool, principal }) => life.listExports(pool, principal));
route('POST', /^\/api\/workspace\/exports$/, async ({ pool, principal }) => life.requestExport(pool, principal));
route('POST', /^\/api\/workspace\/exports\/([0-9a-f-]{36})\/download$/, async ({ pool, principal, url }) => life.exportLink(pool, principal, hid(url, 4)));
route('GET', /^\/api\/workspace\/closure$/, async ({ pool, principal }) => life.closureStatus(pool, principal));
route('POST', /^\/api\/workspace\/closure$/, async ({ pool, principal }, b) => life.requestClosure(pool, principal, hb(b)));
route('POST', /^\/api\/workspace\/closure\/suspend$/, async ({ pool, principal }, b) => life.suspendWorkspace(pool, principal, hb(b)));
route('POST', /^\/api\/workspace\/closure\/cancel$/, async ({ pool, principal }) => life.cancelClosure(pool, principal));
route('GET', /^\/api\/platform\/closures$/, async ({ pool, actorId }) => life.listClosures(pool, actorId));
route('POST', /^\/api\/platform\/closures\/([0-9a-f-]{36})\/approve$/, async ({ pool, actorId, url }) => life.approveClosure(pool, actorId, hid(url, 4)));

// ---- modules and workspace settings (PRD ORG-01): which shelves are on.
route('GET', /^\/api\/modules$/, async ({ pool, principal }) => listModules(pool, principal));
route('POST', /^\/api\/modules\/([a-z_]+)$/, async ({ pool, principal, url }, body) =>
  setModule(pool, principal, url.pathname.split('/')[3]!, (body ?? {}) as { enabled?: unknown; plan?: unknown }),
);
route('GET', /^\/api\/workspace\/settings$/, async ({ pool, principal }) => workspaceSettings(pool, principal));
route('POST', /^\/api\/workspace\/settings$/, async ({ pool, principal }, body) =>
  updateWorkspaceSettings(pool, principal, (body ?? {}) as Record<string, unknown>),
);

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
  const done = await revokeMemberSessions(pool, { principal, actorId: url.pathname.split('/')[3]! });
  return { revoked: done.revoked };
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
route('GET', /^\/api\/platform\/me$/, async ({ pool, actorId }) => {
  try {
    return { role: await requirePlatformRole(pool, actorId) };
  } catch (err) {
    if (err instanceof AuthorizationError) return { role: null };
    throw err;
  }
});
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
  const [processes, devices, modules] = await Promise.all([
    engine.processesFor(actor.tenant_id, actorId),
    devicesFor(pool, actorId),
    enabledModules(pool, actor.tenant_id),
  ]);
  return { actor, processes, devices, modules: [...modules] };
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

/**
 * Passkeys: a fingerprint or face on this device instead of the password,
 * for the same step-up. Adding or removing one is itself a step-up
 * (step-up.ts). See runtime/passkeys.ts.
 */
route('GET', /^\/api\/account\/passkeys$/, async ({ pool, actorId }) => ({ passkeys: await listPasskeys(pool, actorId) }));
route('POST', /^\/api\/account\/passkeys\/begin$/, async ({ pool, actorId }) => beginRegistration(pool, { actorId }));
route('POST', /^\/api\/account\/passkeys\/finish$/, async ({ pool, actorId }, body) => {
  const { label, response } = body as { label?: unknown; response?: unknown };
  if (!response || typeof response !== 'object') throw new HttpError(400, 'a passkey response is required');
  return finishRegistration(pool, { actorId, label, response: response as Record<string, unknown> });
});
route('POST', /^\/api\/account\/passkeys\/([0-9a-f-]{36})\/remove$/, async ({ pool, actorId, url }) => removePasskey(pool, actorId, hid(url, 4)));
route('POST', /^\/api\/auth\/reauthenticate\/passkey\/begin$/, async ({ pool, actorId, session }) => {
  if (!session) throw new HttpError(401, 'sign in first');
  return beginAssertion(pool, { actorId });
});
route('POST', /^\/api\/auth\/reauthenticate\/passkey\/finish$/, async ({ pool, actorId, session }, body) => {
  if (!session) throw new HttpError(401, 'sign in first');
  const { response } = body as { response?: unknown };
  if (!response || typeof response !== 'object') throw new HttpError(400, 'a passkey response is required');
  return finishAssertion(pool, { actorId, sessionId: session.sessionId, response: response as Record<string, unknown> });
});

// ---- Meetings and resolutions. Who may see and do what is decided in runtime/meetings.ts.
const mr = (re: string) => new RegExp(`^/api/meetings/${re}$`);
route('GET', mr('overview'), async ({ pool, principal }) => mtg.meetingsOverview(pool, principal));
route('GET', mr('settings'), async ({ pool, principal }) => mtg.readMeetingSettings(pool, principal));
route('POST', mr('settings'), async ({ pool, principal }, b) => mtg.updateMeetingSettings(pool, principal, hb(b)));
route('GET', mr('bodies'), async ({ pool, principal }) => mtg.listBodies(pool, principal));
route('POST', mr('bodies'), async ({ pool, principal }, b) => mtg.saveBody(pool, principal, hb(b)));
route('GET', mr(`bodies/${A}`), async ({ pool, principal, url }) => mtg.bodyDetail(pool, principal, hid(url, 4)));
route('POST', mr(`bodies/${A}/members`), async ({ pool, principal, url }, b) => mtg.setBodyMember(pool, principal, hid(url, 4), hb(b)));
route('GET', mr(`bodies/${A}/register`), async ({ pool, principal, url }) => {
  const rows = await mtg.resolutionRegister(pool, principal, hid(url, 4));
  if (url.searchParams.get('format') === 'csv') return { contentType: 'text/csv', body: mtg.registerCsv(rows as Record<string, unknown>[]), headers: { 'content-disposition': 'attachment; filename="resolution-register.csv"' } };
  return rows;
});
route('GET', mr('meetings'), async ({ pool, principal, url }) => mtg.listMeetings(pool, principal, { bodyId: url.searchParams.get('body') ?? undefined, scope: url.searchParams.get('scope') ?? undefined }));
route('POST', mr('meetings'), async ({ pool, principal }, b) => mtg.createMeeting(pool, principal, hb(b)));
route('GET', mr(`meetings/${A}`), async ({ pool, principal, url }) => mtg.meetingDetail(pool, principal, hid(url, 4)));
route('POST', mr(`meetings/${A}`), async ({ pool, principal, url }, b) => mtg.updateMeeting(pool, principal, hid(url, 4), hb(b)));
route('POST', mr(`meetings/${A}/call`), async ({ pool, principal, url }, b) => mtg.callMeeting(pool, principal, hid(url, 4), hb(b)));
route('POST', mr(`meetings/${A}/rsvp`), async ({ pool, principal, url }, b) => mtg.rsvp(pool, principal, hid(url, 4), hb(b)));
route('POST', mr(`meetings/${A}/cancel`), async ({ pool, principal, url }, b) => mtg.cancelMeeting(pool, principal, hid(url, 4), hb(b)));
route('POST', mr(`meetings/${A}/presence`), async ({ pool, principal, url }, b) => mtg.setPresence(pool, principal, hid(url, 4), hb(b)));
route('POST', mr(`meetings/${A}/start`), async ({ pool, principal, url }, b) => mtg.startMeeting(pool, principal, hid(url, 4), hb(b)));
route('POST', mr(`meetings/${A}/minutes`), async ({ pool, principal, url }, b) => mtg.recordMinutes(pool, principal, hid(url, 4), hb(b)));
route('POST', mr(`meetings/${A}/close`), async ({ pool, principal, url }) => mtg.closeMeeting(pool, principal, hid(url, 4)));
route('POST', mr(`meetings/${A}/approve-minutes`), async ({ pool, principal, url }) => mtg.approveMinutes(pool, principal, hid(url, 4)));
route('GET', mr(`meetings/${A}/minutes.pdf`), async ({ pool, principal, url }) => mtg.minutesDocument(pool, principal, hid(url, 4)));
route('GET', mr(`meetings/${A}/invite.ics`), async ({ pool, principal, url }) => mtg.meetingInvite(pool, principal, hid(url, 4)));
route('POST', mr(`meetings/${A}/proxy`), async ({ pool, principal, url }, b) => mtg.appointProxy(pool, principal, hid(url, 4), hb(b)));
route('GET', mr('calendar'), async ({ pool, principal, url }) => mtg.calendar(pool, principal, { from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined }));
route('GET', mr('resolutions'), async ({ pool, principal, url }) => mtg.listResolutions(pool, principal, { bodyId: url.searchParams.get('body') ?? undefined, status: url.searchParams.get('status') ?? undefined }));
route('POST', mr('resolutions'), async ({ pool, principal }, b) => mtg.createResolution(pool, principal, hb(b)));
route('GET', mr(`resolutions/${A}`), async ({ pool, principal, url }) => mtg.resolutionDetail(pool, principal, hid(url, 4)));
route('POST', mr(`resolutions/${A}/open`), async ({ pool, principal, url }, b) => mtg.openResolution(pool, principal, hid(url, 4), hb(b)));
route('POST', mr(`resolutions/${A}/vote`), async ({ pool, principal, url }, b) => mtg.castVote(pool, principal, hid(url, 4), hb(b)));
route('POST', mr(`resolutions/${A}/close`), async ({ pool, principal, url }) => mtg.closeResolution(pool, principal, hid(url, 4)));
route('POST', mr(`resolutions/${A}/withdraw`), async ({ pool, principal, url }, b) => mtg.withdrawResolution(pool, principal, hid(url, 4), hb(b)));
route('POST', mr(`resolutions/${A}/sign`), async ({ pool, principal, url }) => mtg.sendResolutionForSignature(pool, principal, hid(url, 4)));
route('GET', mr('actions'), async ({ pool, principal, url }) => mtg.listActions(pool, principal, { scope: url.searchParams.get('scope') ?? undefined, bodyId: url.searchParams.get('body') ?? undefined }));
route('POST', mr('actions'), async ({ pool, principal }, b) => mtg.createAction(pool, principal, hb(b)));
route('POST', mr(`actions/${A}/close`), async ({ pool, principal, url }, b) => mtg.completeAction(pool, principal, hid(url, 4), hb(b)));

// The phone screen: what needs me, across every module, in one call. See runtime/go.ts.
route('GET', /^\/api\/go$/, async ({ pool, engine, principal, actorId }) => goHome(pool, engine, principal, actorId));

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

route('POST', /^\/api\/records\/([0-9a-f-]{36})\/notes$/, async ({ pool, principal, url }, body) => {
  const id = url.pathname.split('/')[3]!;
  const text = (body as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 2000) {
    throw new HttpError(400, 'Note must contain 1 to 2,000 characters');
  }
  return addRecordNote(pool, principal, id, text);
});

// Send a record to a colleague: a member of this workspace, chosen not typed,
// who reads it under their own roles. See runtime/share-record.ts.
route('POST', /^\/api\/records\/([0-9a-f-]{36})\/share$/, async ({ pool, principal, url }, body) => {
  const { actorId, note } = body as { actorId?: string; note?: string };
  if (!actorId || !/^[0-9a-f-]{36}$/.test(actorId)) throw new HttpError(400, 'choose a person to send it to');
  return shareRecord(pool, { principal, instanceId: url.pathname.split('/')[3]!, recipientActorId: actorId, note });
});

// A document the process generated for this record, as base64 in JSON: the
// console turns it into a download. Small, controlled files; see document table.
route('GET', /^\/api\/records\/([0-9a-f-]{36})\/documents\/([0-9]+)$/, async ({ pool, principal, url }) => {
  const parts = url.pathname.split('/');
  return recordDocument(pool, principal, parts[3]!, Number(parts[5]));
});

route('GET', /^\/api\/records\/([0-9a-f-]{36})\/receipts\/([0-9a-f-]{36})$/, async ({ pool, principal, url }) => {
  const parts = url.pathname.split('/');
  return receiptDownload(pool, principal, parts[3]!, parts[5]!);
});

route('POST', /^\/api\/records\/([0-9a-f-]{36})\/tasks\/([a-z0-9_]+)\/files$/, async ({ pool, principal, url }, body) => {
  const parts = url.pathname.split('/');
  const { fieldKey, filename, base64 } = body as Record<string, string>;
  if (![fieldKey, filename, base64].every(value => typeof value === 'string' && value.length))
    throw new HttpError(400, 'field, filename and file are required');
  return uploadTaskFile(pool, { principal, instanceId: parts[3]!, taskKey: parts[5]!, fieldKey: fieldKey!, filename: filename!, base64: base64! });
});

route('GET', /^\/api\/records\/([0-9a-f-]{36})\/tasks\/([a-z0-9_]+)\/files\/([0-9a-f-]{36})$/, async ({ pool, principal, url }) => {
  const parts = url.pathname.split('/');
  return taskFileStatus(pool, { principal, instanceId: parts[3]!, taskKey: parts[5]!, reference: `receipt-file:${parts[7]}` });
});

route('POST', /^\/api\/records\/([0-9a-f-]{36})\/decide$/, async ({ engine, principal, url }, body) => {
  const id = url.pathname.split('/')[3]!;
  const { approvalKey, decision, reason, signatureName, signatureConfirmed } = body as {
    approvalKey: string;
    decision: 'approved' | 'rejected' | 'changes_requested';
    reason?: string;
    signatureName?: string;
    signatureConfirmed?: boolean;
  };
  if (!approvalKey || !decision) throw new HttpError(400, 'approvalKey and decision are required');
  const result = await engine.decide({ instanceId: id, approvalKey, decision, principal, reason, signatureName, signatureConfirmed, now: new Date() });
  await engine.drain(new Date(), 'api');
  return result;
});

route(
  'POST',
  /^\/api\/records\/([0-9a-f-]{36})\/tasks\/([a-z0-9_]+)\/complete$/,
  async ({ engine, principal, url }, body) => {
    const [, , , id, , taskKey] = url.pathname.split('/');
    const answers = (body as { answers?: Answers } | undefined)?.answers;
    const result = await engine.completeTask({ instanceId: id!, taskKey: taskKey!, principal, answers, verifyFiles: true, now: new Date() });
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

async function readRaw(req: IncomingMessage, maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'request is too large');
    chunks.push(chunk as Buffer);
  }
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

/** A route's answer that is a file, not JSON: a PDF to view or download. */
class RawBody {
  constructor(readonly bytes: Buffer, readonly contentType: string, readonly filename?: string) {}
}
function sendRaw(res: ServerResponse, body: RawBody): void {
  res.writeHead(200, {
    'content-type': body.contentType,
    'content-length': body.bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(body.filename ? { 'content-disposition': `attachment; filename="${body.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"` } : { 'content-disposition': 'inline' }),
  });
  res.end(body.bytes);
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
    'access-control-allow-headers': 'content-type, x-request-id, x-sign-session',
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
  // The public API, on this port too. See public-server.ts.
  const servePublic = publicHandler(pool, engine);

  const server = createServer((req, res) => {
    if (isPublicApiPath((req.url ?? '/').split('?')[0]!)) return servePublic(req, res);
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
        const assetId = /^\/api\/brand-assets\/([0-9a-f-]{36})$/.exec(url.pathname)?.[1];
        if (assetId && req.method === 'GET') {
          res.writeHead(302, { location: await brandAssetUrl(pool, assetId), 'cache-control': 'no-store' });
          return res.end();
        }
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

        /*
         * ---- access connectors calling back (PRD OPS-04, OPS-05)
         *
         * The caller is the target system, not a person, so this sits before
         * the session gate. The signature over the exact bytes, with the
         * system's own secret, is the credential.
         */
        /*
         * ---- Patform Sign, the signer's side. No account: the personal link
         * (only its hash is stored) plus an emailed code, then a short signing
         * session in the x-sign-session header. Public verify takes a file's
         * fingerprint and says only whether it is a sealed copy.
         */
        const signMatch = /^\/api\/sign\/t\/([A-Za-z0-9_-]{30,60})(\/(code|verify|document|consent|sign|decline|final))?$/.exec(url.pathname);
        if (signMatch || (url.pathname === '/api/sign/verify' && req.method === 'POST')) {
          const ctx = { ip: callerFor(req), userAgent: String(req.headers['user-agent'] ?? '') };
          const sess = String(req.headers['x-sign-session'] ?? '') || undefined;
          try {
            if (!signMatch) return send(res, 200, await esign.verifyFingerprint(pool, (await readBody(req, 30 * 1024 * 1024)) as Record<string, unknown>));
            const [, t, , action] = signMatch;
            if (req.method === 'GET' && !action) return send(res, 200, await esign.signerView(pool, t!, sess));
            if (req.method === 'GET' && action === 'document') return sendRaw(res, new RawBody(await esign.signerDocument(pool, t!, sess), 'application/pdf'));
            if (req.method === 'GET' && action === 'final') return sendRaw(res, new RawBody(await esign.finalDocument(pool, t!), 'application/pdf', 'signed.pdf'));
            if (req.method === 'POST') {
              const b = (await readBody(req, 1024 * 1024)) as Record<string, unknown>;
              if (action === 'code') return send(res, 200, await esign.requestCode(pool, t!, ctx));
              if (action === 'verify') return send(res, 200, await esign.verifyCode(pool, t!, b.code, ctx, b.smsCode));
              if (action === 'consent') return send(res, 200, await esign.giveConsent(pool, t!, sess, ctx));
              if (action === 'sign') return send(res, 200, await esign.signDocument(pool, t!, sess, b, ctx));
              if (action === 'decline') return send(res, 200, await esign.declineDocument(pool, t!, sess, b, ctx));
            }
            return send(res, 404, { error: 'not found' });
          } catch (err) {
            if (err instanceof InvalidInput) return send(res, 400, { error: 'invalid', reason: err.message });
            throw err;
          }
        }

        // DocuSign Connect: never trusted, only a prompt to ask DocuSign for the real status.
        if (url.pathname === '/api/gov/docusign/connect' && req.method === 'POST') {
          const raw = await readRaw(req, 1024 * 1024);
          const result = await gov.docusignConnect(pool, raw, String(req.headers['x-docusign-signature-1'] ?? ''));
          return send(res, result.status, { ok: result.status === 200 });
        }
        const connectorMatch = /^\/api\/ops\/connectors\/([0-9a-f-]{36})\/callback$/.exec(url.pathname);
        if (connectorMatch && req.method === 'POST') {
          const raw = await readRaw(req, 64 * 1024);
          const result = await ops.connectorCallback(pool, connectorMatch[1]!, raw, String(req.headers['patform-signature'] ?? ''));
          if (!result.ok && result.status === 401) return send(res, 401, { error: 'signature refused' });
          return send(res, result.status, result);
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
          const { email, password, workspace } = (await readBody(req)) as {
            email?: string; password?: string; workspace?: string;
          };
          if (!email || !password) throw new HttpError(400, 'email and password are required');
          if (workspace !== undefined && !/^[0-9a-f-]{36}$/.test(workspace)) {
            throw new HttpError(400, 'workspace must be an id');
          }
          const result = await signIn(pool, {
            email, password, userAgent: req.headers['user-agent'], tenantId: workspace,
          });
          // One message for every failure, so the response cannot be used to
          // find out which addresses have accounts.
          if (!result) return send(res, 401, { error: 'those details do not match an account' });

          // The same address and password open several workspaces. Nothing is
          // issued until the person says which one they meant.
          if (needsWorkspace(result)) return send(res, 200, result);

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

        // ---- forms may be public or limited to a named workspace role
        if (url.pathname.startsWith('/api/forms/')) {
          const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
          if (!match) throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
          const formRef = processKeyFrom(url.pathname);
          const formTarget = await resolveForm(pool, formRef);
          const { rows: formVersions } = await pool.query<{ blueprint: Blueprint }>(
            `select blueprint from process_version where tenant_id = $1 and process_key = $2
             order by version desc limit 1`, [formTarget.tenantId, formTarget.processKey],
          );
          const published = formVersions[0]?.blueprint;
          if (!published) throw new HttpError(404, 'no such form');
          let formPrincipal: Principal = { kind: 'respondent', tenantId: formTarget.tenantId };
          let formActorId = '';
          if (published.experience.access?.mode === 'workspace') {
            const session = await resolveSession(pool, readCookie(req, SESSION_COOKIE) ?? '');
            if (!session) throw new HttpError(401, 'sign in to open this form');
            if (session.tenantId !== formTarget.tenantId) throw new HttpError(403, 'this form belongs to another workspace');
            formActorId = session.actorId;
            formPrincipal = { kind: 'actor', tenantId: session.tenantId, actorId: session.actorId };
            const policyClient = await pool.connect();
            let decision;
            try {
              decision = await authorizeProcess(policyClient, {
                principal: formPrincipal, action: 'submit', tenantId: session.tenantId,
                processKey: formTarget.processKey, blueprint: published,
              });
            } finally {
              policyClient.release();
            }
            if (!decision.allowed || !decision.roles.includes(published.experience.access.role)) {
              throw new HttpError(403, `only a signed-in ${published.experience.access.role} can open this form`);
            }
          }

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
          return send(
            res,
            200,
            await match.handler({ engine, pool, principal: formPrincipal, actorId: formActorId, url }, body),
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

        const body = req.method === 'POST' ? await readBody(req, url.pathname.endsWith('/brand-assets') ? 4 * 1024 * 1024 + 1024 : url.pathname === '/api/gov/files' ? 28 * 1024 * 1024 : /^\/api\/(appraisals\/goals|general-approvals\/requests)\/[0-9a-f-]+\/files$/.test(url.pathname) ? 14 * 1024 * 1024 : url.pathname.endsWith('/files') || url.pathname === '/api/ops/photos' ? 7 * 1024 * 1024 : Number.MAX_SAFE_INTEGER) : {};

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
            passkey: await hasPasskeys(pool, actorId),
          });
        }

        const result = await match.handler(
          { engine, pool, principal, actorId, url, session: { sessionId: session.sessionId, authenticatedAt: session.authenticatedAt } },
          body,
        );
        if (result instanceof RawBody) return sendRaw(res, result);
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
