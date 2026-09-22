import { createHash, randomBytes } from 'node:crypto';
import type { Blueprint } from '../blueprint/index.js';
import { validateAnswers, visibleFields, type Answers, type FieldError } from '../blueprint/answers.js';
import { withCalculatedFields } from './expr.js';
import { inTransaction, type Client, type Pool } from './db.js';
import { Engine } from './engine.js';
import { issueResumeToken } from './auth.js';

/**
 * The respondent side: the public form, its draft, and its submission.
 *
 * §21 puts this at P0 with the blunt reason — "value cannot exist without
 * trustworthy intake". Everything behind it was built and proven first, so
 * what happens here is narrow on purpose: render a published version, keep a
 * draft, validate, hand the answers to the engine.
 *
 * Two things this deliberately does NOT do:
 *
 *   - A draft is not an instance. A process that counts half-filled forms as
 *     cases reports nonsense, and somebody who abandons one should not become
 *     a record for an operator to chase.
 *   - The browser gets constraint *values*, never the rules. `validateAnswers`
 *     is the only implementation; the renderer turns those values into native
 *     HTML attributes. One source of truth, two enforcers.
 */

const DRAFT_DAYS = 30;

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

// ------------------------------------------------------------------- schema

export interface PublicField {
  key: string;
  type: string;
  label: string;
  help?: string;
  required: boolean;
  choices?: { value: string; label: string }[];
  constraints?: Record<string, unknown>;
  fields?: PublicField[];
  /** Serialised so the browser can hide a section without asking the server. */
  default?: unknown;
}

export interface PublicForm {
  processKey: string;
  processName: string;
  version: number;
  showProgress: boolean;
  saveAndResume: boolean;
  confirmation: { message: string; showStatusLink: boolean };
  /**
   * What the respondent sees at the top.
   *
   * Public by necessity — it is the header of a page a stranger loads — and
   * safe by construction: a title, a tagline, two image URLs and a hex
   * colour, none of which say anything about the process's internals.
   */
  branding?: {
    title?: string;
    tagline?: string;
    logoUrl?: string;
    bannerUrl?: string;
    accent?: string;
    footer?: string;
  };
  pages: {
    key: string;
    title: string;
    description?: string;
    visibleWhen?: unknown;
    sections: {
      key: string;
      title?: string;
      description?: string;
      visibleWhen?: unknown;
      /** Field key to width, so two short answers can share a line. */
      widths?: Record<string, string>;
      fields: PublicField[];
    }[];
  }[];
}

function publicField(field: Blueprint['data']['fields'][number]): PublicField {
  return {
    key: field.key,
    type: field.type,
    label: field.label,
    help: field.help,
    required: Boolean(field.required),
    choices: field.choices,
    constraints: field.constraints as Record<string, unknown> | undefined,
    default: field.default,
    fields: field.fields?.map(publicField),
  };
}

/**
 * The published form, as a respondent may see it.
 *
 * Only the experience and the fields it places. Roles, workflow, approvals,
 * messages, documents, classifications and the operator-set fields all stay
 * server-side — a public endpoint that returned the whole blueprint would
 * hand a stranger the process's internal design and its data classifications.
 */
export async function publicForm(pool: Pool, processKey: string): Promise<PublicForm | null> {
  const { rows } = await pool.query<{ blueprint: Blueprint; version: number }>(
    `select blueprint, version from process_version
      where process_key = $1 order by version desc limit 1`,
    [processKey],
  );
  if (!rows.length) return null;
  const bp = rows[0]!.blueprint;

  const byKey = new Map(bp.data.fields.map((f) => [f.key, f]));

  return {
    processKey: bp.key,
    processName: bp.name,
    version: rows[0]!.version,
    showProgress: bp.experience.showProgress,
    saveAndResume: bp.experience.saveAndResume,
    confirmation: bp.experience.confirmation,
    branding: bp.experience.branding,
    pages: bp.experience.pages.map((page) => ({
      key: page.key,
      title: page.title,
      description: page.description,
      visibleWhen: page.visibleWhen,
      sections: page.sections.map((section) => ({
        key: section.key,
        title: section.title,
        description: section.description,
        visibleWhen: section.visibleWhen,
        widths: section.widths,
        fields: section.fields.map((key) => publicField(byKey.get(key)!)),
      })),
    })),
  };
}

// -------------------------------------------------------------------- drafts

export interface DraftState {
  token: string;
  answers: Answers;
  page: number;
  submittedInstanceId: string | null;
}

async function latestVersion(client: Client, processKey: string) {
  const { rows } = await client.query<{ id: string; tenant_id: string; blueprint: Blueprint }>(
    `select id, tenant_id, blueprint from process_version
      where process_key = $1 order by version desc limit 1`,
    [processKey],
  );
  if (!rows.length) throw new Error(`no published version of "${processKey}"`);
  return rows[0]!;
}

/** Creates a draft, or updates the one the token names. Autosave calls this. */
export async function saveDraft(
  pool: Pool,
  args: { processKey: string; token?: string; answers: Answers; page: number },
): Promise<DraftState> {
  return inTransaction(pool, async (client) => {
    const version = await latestVersion(client, args.processKey);

    if (args.token) {
      const { rows } = await client.query<{ id: string; submitted_instance_id: string | null }>(
        `update draft set answers = $1, page = $2, updated_at = now()
          where token_hash = $3 and submitted_instance_id is null and expires_at > now()
          returning id, submitted_instance_id`,
        [JSON.stringify(args.answers), args.page, sha256(args.token)],
      );
      if (rows.length) {
        return { token: args.token, answers: args.answers, page: args.page, submittedInstanceId: null };
      }
      // Expired, already submitted, or forged. Start a new draft rather than
      // silently writing into somebody else's.
    }

    const token = newToken();
    await client.query(
      `insert into draft (tenant_id, process_version_id, token_hash, answers, page, expires_at)
       values ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
      [version.tenant_id, version.id, sha256(token), JSON.stringify(args.answers), args.page, DRAFT_DAYS],
    );
    return { token, answers: args.answers, page: args.page, submittedInstanceId: null };
  });
}

export async function loadDraft(pool: Pool, token: string): Promise<DraftState | null> {
  const { rows } = await pool.query<{
    answers: Answers;
    page: number;
    submitted_instance_id: string | null;
  }>(
    `select answers, page, submitted_instance_id from draft
      where token_hash = $1 and expires_at > now()`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    token,
    answers: row.answers,
    page: row.page,
    submittedInstanceId: row.submitted_instance_id,
  };
}

// ---------------------------------------------------------------- validation

export interface CheckResult {
  errors: FieldError[];
  /** Field keys the respondent is actually being asked, given their answers. */
  visible: string[];
  /** Calculated fields, so a total can be shown while typing. */
  computed: Answers;
}

export async function checkAnswers(
  pool: Pool,
  args: { processKey: string; answers: Answers; pageIndex?: number },
): Promise<CheckResult> {
  const client = await pool.connect();
  try {
    const version = await latestVersion(client, args.processKey);
    const bp = version.blueprint;
    const withTotals = withCalculatedFields(bp.data.fields, args.answers);

    // Checking one page at a time means "next" complains about what is on the
    // screen, not about a question three pages away.
    const scope =
      args.pageIndex === undefined
        ? undefined
        : (bp.experience.pages[args.pageIndex]?.sections.flatMap((s) => s.fields) ?? []);

    const computed = Object.fromEntries(
      bp.data.fields.filter((f) => f.type === 'calculated').map((f) => [f.key, withTotals[f.key]]),
    );

    return {
      errors: validateAnswers(bp, withTotals, { scope }),
      visible: [...visibleFields(bp, withTotals)],
      computed,
    };
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------------- submit

export interface SubmitResult {
  ok: boolean;
  errors?: FieldError[];
  instanceId?: string;
  duplicate?: boolean;
  resumeToken?: string;
  confirmation?: { message: string; showStatusLink: boolean };
}

/**
 * Validates, then hands the answers to the engine. The engine is still the
 * thing that decides whether a record exists — this only decides whether the
 * form was filled in.
 */
export async function submitForm(
  pool: Pool,
  args: { processKey: string; token?: string; answers: Answers; now?: Date },
): Promise<SubmitResult> {
  const now = args.now ?? new Date();
  const engine = new Engine(pool);

  const client = await pool.connect();
  let version: Awaited<ReturnType<typeof latestVersion>>;
  try {
    version = await latestVersion(client, args.processKey);
  } finally {
    client.release();
  }

  const bp = version.blueprint;
  const answers = withCalculatedFields(bp.data.fields, args.answers);

  const errors = validateAnswers(bp, answers, { now });
  if (errors.length) return { ok: false, errors };

  const result = await engine.submit({
    version: { id: version.id, tenant_id: version.tenant_id, process_key: bp.key, version: 0, blueprint: bp },
    answers,
    now,
    principal: { kind: 'respondent', tenantId: version.tenant_id },
  });

  if (result.rejected) {
    // The engine re-checks required fields. Reaching here means the two
    // disagreed, which is worth surfacing rather than hiding.
    return {
      ok: false,
      errors: result.rejected.map((field) => ({ field, message: 'This is required.' })),
    };
  }

  await inTransaction(pool, async (tx) => {
    if (args.token) {
      await tx.query(
        `update draft set submitted_instance_id = $1, updated_at = now() where token_hash = $2`,
        [result.instanceId, sha256(args.token)],
      );
      // Files uploaded against the draft now belong to the record.
      await tx.query(
        `update file set instance_id = $1
          where draft_id = (select id from draft where token_hash = $2)`,
        [result.instanceId, sha256(args.token)],
      );
    }
  });

  // A duplicate reuses the existing record, so it needs a link to it too.
  const resumeToken =
    result.resumeToken ??
    (await inTransaction(pool, (tx) =>
      issueResumeToken(tx, { tenantId: version.tenant_id, instanceId: result.instanceId }),
    ));

  return {
    ok: true,
    instanceId: result.instanceId,
    duplicate: result.duplicate,
    resumeToken,
    confirmation: bp.experience.confirmation,
  };
}

// -------------------------------------------------------------------- status

/**
 * §6.3's optional respondent status page, and §20.1 step 6: when an approver
 * asks for changes, the respondent updates only the fields their role may
 * edit. The policy engine already enforces that; this is the first thing that
 * uses it.
 */
export async function respondentStatus(pool: Pool, resumeToken: string) {
  const engine = new Engine(pool);
  const { rows } = await pool.query<{ tenant_id: string; instance_id: string }>(
    `select tenant_id, instance_id from resume_token
      where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [sha256(resumeToken)],
  );
  const scope = rows[0];
  if (!scope) return null;

  const instance = await engine.recordFor(
    { kind: 'respondent', tenantId: scope.tenant_id, instanceId: scope.instance_id },
    scope.instance_id,
  );

  const { rows: versions } = await pool.query<{ blueprint: Blueprint }>(
    'select blueprint from process_version where id = $1',
    [instance.process_version_id],
  );
  const bp = versions[0]!.blueprint;
  const state = bp.workflow.states.find((s) => s.key === instance.state);

  // What the respondent may change, from the blueprint's respondent role.
  const respondentRole = bp.roles.find((r) => r.kind === 'respondent');
  const editable = new Set(respondentRole?.editableFields ?? []);

  const { rows: pending } = await pool.query<{ reason: string | null; decided_at: Date }>(
    `select reason, decided_at from approval_request
      where instance_id = $1 and decision = 'changes_requested'
      order by decided_at desc limit 1`,
    [scope.instance_id],
  );

  return {
    reference: scope.instance_id.slice(0, 8).toUpperCase(),
    processName: bp.name,
    // The public label exists so a respondent is not shown an internal state
    // name like "with_safety_lead".
    status: state?.publicLabel ?? state?.name ?? instance.state,
    finished: Boolean(instance.completed_at),
    outcome: instance.outcome,
    changesRequested: pending[0]?.reason ?? null,
    editableFields: bp.data.fields
      .filter((f) => editable.has(f.key))
      .map((f) => ({ ...publicField(f), value: instance.data[f.key] ?? null })),
  };
}

/** The clarification loop: a respondent updating only what their role may edit. */
export async function respondentUpdate(
  pool: Pool,
  args: { resumeToken: string; patch: Answers; now?: Date },
): Promise<{ saved: boolean; advanced: boolean; refused?: string[] }> {
  const engine = new Engine(pool);
  const { rows } = await pool.query<{ tenant_id: string; instance_id: string }>(
    `select tenant_id, instance_id from resume_token
      where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [sha256(args.resumeToken)],
  );
  const scope = rows[0];
  if (!scope) throw new Error('that link has expired');

  return engine.updateRecord({
    instanceId: scope.instance_id,
    patch: args.patch,
    principal: { kind: 'respondent', tenantId: scope.tenant_id, instanceId: scope.instance_id },
    now: args.now ?? new Date(),
  });
}
