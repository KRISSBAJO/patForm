import type { Pool } from './db.js';
import { createDraft, loadDraft, saveDraft, type NewProcess } from './builder.js';
import { InvalidInput, NotFound } from './errors.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';
import { Blueprint } from '../blueprint/index.js';
import { validate } from '../compiler/validate.js';
import { availableProviders, blueprintSchema, generateBlueprint, providerFor } from '../ai/index.js';
import type { GenerationOutcome } from '../ai/pipeline.js';
import { runScenarios, type ScenarioResult } from './scenarios.js';

/** Queue AI generation outside the short-lived web request. The worker owns the expensive model calls. */
export async function queueAiDraft(pool: Pool, principal: Principal, input: NewProcess) {
  if (principal.kind !== 'actor') throw new InvalidInput('Sign in to create a process.');
  if (!/^[a-z][a-z0-9_]{2,}$/.test(input.key ?? '')) throw new InvalidInput('Use a key of at least three lowercase letters, digits or underscores.');
  if (typeof input.description !== 'string' || input.description.trim().length < 20 || input.description.length > 8000)
    throw new InvalidInput('Describe the process in 20–8,000 characters.');
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 120))
    throw new InvalidInput('Keep the process name under 120 characters.');
  await requireWorkspaceCapability(pool, principal, 'administer', input.key);
  const clash = await pool.query(`select 1 from process_version where tenant_id = $1 and process_key = $2
    union all select 1 from process_draft where tenant_id = $1 and process_key = $2 and published_as is null`,
  [principal.tenantId, input.key]);
  if (clash.rows.length) throw new InvalidInput(`A process named ${input.key} already exists. Choose a different key.`);
  const queued = await pool.query<{ id: string }>(`insert into ai_draft_job
    (tenant_id, actor_id, process_key, process_name, description)
    values ($1, $2, $3, $4, $5) on conflict do nothing returning id`,
  [principal.tenantId, principal.actorId, input.key, input.name?.trim() || null, input.description.trim()]);
  if (!queued.rows[0]) throw new InvalidInput('This process is already being drafted. Wait for it to finish.');
  return { jobId: queued.rows[0].id, status: 'queued' };
}

/** Revise the selected draft without changing it until the owner accepts the proposal. */
export async function queueAiRevision(pool: Pool, principal: Principal, draftId: string, request: string) {
  if (principal.kind !== 'actor') throw new InvalidInput('Sign in to revise a process.');
  if (typeof request !== 'string' || request.trim().length < 20 || request.length > 8000)
    throw new InvalidInput('Describe the changes in 20–8,000 characters.');
  const draft = await loadDraft(pool, principal, draftId);
  const source = Blueprint.safeParse(draft.blueprint);
  if (!source.success) throw new InvalidInput('Fix the draft shape before asking AI to revise it.');
  if (!availableProviders().length) throw new InvalidInput('No AI provider is configured.');
  const queued = await pool.query<{ id: string }>(`insert into ai_draft_job
    (tenant_id, actor_id, process_key, process_name, description, source_draft_id, source_revision, source_blueprint)
    values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing returning id`,
  [principal.tenantId, principal.actorId, draft.processKey,
    draft.processName, request.trim(), draft.id, draft.revision, JSON.stringify(source.data)]);
  if (!queued.rows[0]) throw new InvalidInput('An AI revision is already running for this process.');
  return { jobId: queued.rows[0].id, status: 'queued' };
}

export async function aiDraftStatus(pool: Pool, principal: Principal, jobId: string) {
  if (principal.kind !== 'actor') throw new NotFound('Draft job not found.');
  const result = await pool.query(`select j.id, j.process_key, j.process_name, j.status, j.stage, j.draft_id, j.error,
    j.source_draft_id, j.source_revision, j.source_blueprint, j.proposal, j.review, j.applied_at,
    j.created_at, j.started_at, j.completed_at, j.note, j.progress
    from ai_draft_job j where j.id = $1 and j.tenant_id = $2 and j.actor_id = $3`,
  [jobId, principal.tenantId, principal.actorId]);
  if (!result.rows[0]) throw new NotFound('Draft job not found.');
  if (result.rows[0].source_draft_id) await loadDraft(pool, principal, result.rows[0].source_draft_id);
  else await requireWorkspaceCapability(pool, principal, 'administer', result.rows[0].process_key);
  return result.rows[0];
}

export async function applyAiRevision(pool: Pool, principal: Principal, jobId: string) {
  if (principal.kind !== 'actor') throw new InvalidInput('Sign in to revise a process.');
  const job = await aiDraftStatus(pool, principal, jobId);
  if (!job.source_draft_id || !job.proposal || job.status !== 'ready') throw new InvalidInput('No revision proposal is ready.');
  if (job.applied_at) throw new InvalidInput('This proposal was already applied.');
  const result = await saveDraft(pool, { principal, draftId: job.source_draft_id,
    blueprint: job.proposal, baseRevision: job.source_revision });
  await pool.query('update process_draft set ai_review_required = true where id = $1 and tenant_id = $2',
    [job.source_draft_id, principal.tenantId]);
  await pool.query('update ai_draft_job set applied_at = now() where id = $1 and tenant_id = $2',
    [jobId, principal.tenantId]);
  return { draftId: job.source_draft_id, ...result };
}

/** Keep the strongest reviewable result while trying configured providers in order. */
export function revisionCandidate(result: GenerationOutcome): { blueprint: Blueprint; scenarios?: ScenarioResult[]; score: number } | undefined {
  if (result.blueprint) return { blueprint: result.blueprint, scenarios: result.scenarios, score: 1_000_000 };
  if (result.reviewable) return { blueprint: result.reviewable.blueprint,
    scenarios: result.reviewable.scenarios,
    score: 100_000 - result.reviewable.scenarios.filter((item) => !item.passed).length };
  if (result.editable) return { blueprint: result.editable.blueprint,
    score: 10_000 - result.editable.errors.length };
  return undefined;
}

export async function processNextAiDraft(pool: Pool): Promise<boolean> {
  const claimed = await pool.query<{ id: string; tenant_id: string; actor_id: string; process_key: string; process_name: string | null; description: string; source_draft_id: string | null; source_blueprint: unknown }>(
    `update ai_draft_job j set status = 'running', stage = 'generating', started_at = now(), heartbeat_at = now(), attempts = attempts + 1, error = null, note = null, progress = null
     where j.id = (select id from ai_draft_job
       where status = 'queued' or (status = 'running' and coalesce(heartbeat_at, started_at) < now() - interval '90 seconds')
       order by created_at for update skip locked limit 1)
     returning j.id, j.tenant_id, j.actor_id, j.process_key, j.process_name, j.description, j.source_draft_id, j.source_blueprint`,
  );
  const job = claimed.rows[0];
  if (!job) return false;
  // Model calls can take minutes. A live worker refreshes its claim so only
  // interrupted jobs become eligible for another worker after 90 seconds.
  const heartbeat = setInterval(() => {
    void pool.query(`update ai_draft_job set heartbeat_at = now() where id = $1 and status = 'running'`, [job.id])
      .catch((error: unknown) => console.error('AI draft heartbeat failed:', job.id, error));
  }, 20_000);
  try {
    if (job.source_draft_id) {
      const source = Blueprint.parse(job.source_blueprint);
      let best: ReturnType<typeof revisionCandidate>;
      let bestProvider = '';
      let error = 'The AI could not return a usable revision.';
      for (const name of availableProviders()) {
        try {
          const result = await generateBlueprint(providerFor(name), blueprintSchema(), {
            description: job.description, sourceBlueprint: source, pool,
            onProgress: async (stage, note, progress) => { await pool.query('update ai_draft_job set stage = $2, note = coalesce($3, note), progress = coalesce($4::jsonb, progress) where id = $1', [job.id, stage, note ?? null, progress ? JSON.stringify(progress) : null]); },
          });
          const option = revisionCandidate(result);
          if (option && (!best || option.score > best.score)) {
            best = option;
            bestProvider = name;
          }
          if (result.blueprint) break;
          error = `${name} could not make a fully checked revision.`;
        } catch (cause) {
          error = `${name} could not complete generation.`;
          console.warn('AI revision provider failed:', name, cause instanceof Error ? cause.message : String(cause));
        }
      }
      if (!best) throw new InvalidInput(error);
      // The process identity is not part of the change request.
      const proposal = Blueprint.parse({ ...best.blueprint, key: source.key });
      const diagnostics = validate(proposal);
      await pool.query('update ai_draft_job set stage = $2 where id = $1', [job.id, 'checking']);
      const scenarios = diagnostics.publishable
        ? proposal.key === best.blueprint.key && best.scenarios ? best.scenarios : await runScenarios(pool, proposal)
        : [];
      const review = {
        provider: bestProvider,
        diagnostics: diagnostics.items,
        tests: { passed: scenarios.filter((item) => item.passed).length, total: scenarios.length,
          failures: scenarios.filter((item) => !item.passed).map((item) => ({ name: item.test, failures: item.failures })) },
      };
      await pool.query(`update ai_draft_job set status = 'ready', stage = 'saving', proposal = $2, review = $3,
        draft_id = source_draft_id, completed_at = now(), description = '' where id = $1`,
      [job.id, JSON.stringify(proposal), JSON.stringify(review)]);
      return true;
    }
    const draft = await createDraft(pool, { principal: { kind: 'actor', tenantId: job.tenant_id, actorId: job.actor_id },
      jobId: job.id,
      input: { key: job.process_key, name: job.process_name ?? undefined, description: job.description },
      onProgress: async (stage, note, progress) => { await pool.query('update ai_draft_job set stage = $2, note = coalesce($3, note), progress = coalesce($4::jsonb, progress) where id = $1', [job.id, stage, note ?? null, progress ? JSON.stringify(progress) : null]); } });
    await pool.query(`update ai_draft_job set status = 'ready', draft_id = $2, error = $3, completed_at = now(), description = ''
      where id = $1`, [job.id, draft.id, draft.reviewNote ?? null]);
  } catch (error) {
    const message = error instanceof InvalidInput ? error.message : 'AI generation could not finish. Please try again.';
    await pool.query(`update ai_draft_job set status = 'failed', error = $2, completed_at = now(), description = ''
      where id = $1`, [job.id, message.slice(0, 500)]);
    console.error('AI draft job failed:', job.id, error instanceof Error ? error.message : String(error));
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
