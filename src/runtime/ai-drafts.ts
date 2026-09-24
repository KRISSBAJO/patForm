import type { Pool } from './db.js';
import { createDraft, type NewProcess } from './builder.js';
import { InvalidInput, NotFound } from './errors.js';
import { requireWorkspaceCapability, type Principal } from './policy.js';

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

export async function aiDraftStatus(pool: Pool, principal: Principal, jobId: string) {
  if (principal.kind !== 'actor') throw new NotFound('Draft job not found.');
  const result = await pool.query(`select j.id, j.process_key, j.status, j.draft_id, j.error,
    j.created_at, j.started_at, j.completed_at
    from ai_draft_job j where j.id = $1 and j.tenant_id = $2 and j.actor_id = $3`,
  [jobId, principal.tenantId, principal.actorId]);
  if (!result.rows[0]) throw new NotFound('Draft job not found.');
  await requireWorkspaceCapability(pool, principal, 'administer', result.rows[0].process_key);
  return result.rows[0];
}

export async function processNextAiDraft(pool: Pool): Promise<boolean> {
  const claimed = await pool.query<{ id: string; tenant_id: string; actor_id: string; process_key: string; process_name: string | null; description: string }>(
    `update ai_draft_job j set status = 'running', started_at = now(), attempts = attempts + 1, error = null
     where j.id = (select id from ai_draft_job
       where status = 'queued' or (status = 'running' and started_at < now() - interval '30 minutes')
       order by created_at for update skip locked limit 1)
     returning j.id, j.tenant_id, j.actor_id, j.process_key, j.process_name, j.description`,
  );
  const job = claimed.rows[0];
  if (!job) return false;
  try {
    const draft = await createDraft(pool, { principal: { kind: 'actor', tenantId: job.tenant_id, actorId: job.actor_id },
      input: { key: job.process_key, name: job.process_name ?? undefined, description: job.description } });
    await pool.query(`update ai_draft_job set status = 'ready', draft_id = $2, completed_at = now(), description = ''
      where id = $1`, [job.id, draft.id]);
  } catch (error) {
    const message = error instanceof InvalidInput ? error.message : 'AI generation could not finish. Please try again.';
    await pool.query(`update ai_draft_job set status = 'failed', error = $2, completed_at = now(), description = ''
      where id = $1`, [job.id, message.slice(0, 500)]);
    console.error('AI draft job failed:', job.id, error instanceof Error ? error.message : String(error));
  }
  return true;
}
