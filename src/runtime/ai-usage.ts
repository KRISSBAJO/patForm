import type { Pool } from './db.js';
import type { UsageRecord } from '../ai/pipeline.js';

/**
 * The usage ledger: one row per model call, with tokens, cost and outcome.
 *
 * Written from wherever the platform calls a model, so the site admin can see
 * what each provider is being asked and what it costs, per workspace and per
 * month, without asking the providers — two of the three do not tell an API
 * key what it has spent.
 */
export async function recordUsage(
  pool: Pool,
  who: { tenantId?: string | null; actorId?: string | null; jobId?: string | null; purpose: string },
  usage: UsageRecord,
): Promise<void> {
  try {
    await pool.query(
      `insert into ai_usage (tenant_id, actor_id, job_id, purpose, provider, model, stage, attempt,
                             input_tokens, output_tokens, cost_usd, latency_ms, outcome)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        who.tenantId ?? null,
        who.actorId ?? null,
        who.jobId ?? null,
        who.purpose,
        usage.provider,
        usage.model,
        usage.stage,
        usage.attempt,
        usage.inputTokens ?? null,
        usage.outputTokens ?? null,
        usage.costUsd ?? null,
        usage.latencyMs,
        usage.outcome,
      ],
    );
  } catch (err) {
    // The ledger must never be the reason a draft fails.
    console.warn('ai_usage not recorded:', err instanceof Error ? err.message : String(err));
  }
}
