import type { Blueprint } from '../blueprint/index.js';
import { inTransaction, type Pool } from './db.js';
import { require_, visibleFields, type Principal } from './policy.js';

/**
 * What people answered, added up.
 *
 * The dashboard measures how a process runs: how many came in, how long they
 * took, where they sit. It said nothing about what was in them. A treasurer
 * wants the total claimed this quarter; a volunteer coordinator wants how
 * many said Saturday; a trainer wants the average rating. This is that: for
 * every choice question, a count per answer; for every number, the total,
 * the average and the range. Over the same period as the dashboard, under
 * the same rules:
 *
 * - `report`, because it is an aggregate over everybody's records;
 * - a field this caller's roles may not see is not summarised, and is named
 *   as withheld rather than quietly missing;
 * - nothing below the minimum cohort, because a count of one against a
 *   choice is somebody's answer with a step removed.
 */
export interface ChoiceSummary {
  key: string;
  label: string;
  type: string;
  /** Records that answered this question at all. */
  answered: number;
  buckets: { value: string; label: string; count: number }[];
  /** Answers beyond the top buckets, added together. */
  more: number;
}

export interface NumberSummary {
  key: string;
  label: string;
  type: string;
  count: number;
  sum: number;
  mean: number;
  min: number;
  max: number;
  currencyCode?: string;
}

export interface AnswerSummary {
  from: string;
  to: string;
  records: number;
  minCohort: number;
  choices: ChoiceSummary[];
  numbers: NumberSummary[];
  withheld: string[];
}

const CHOICE = new Set(['single_choice', 'dropdown', 'yes_no', 'multi_choice']);
const NUMBER = new Set(['number', 'currency', 'rating', 'calculated']);
const MIN_COHORT = 5;
const TOP = 8;

export async function answerSummary(
  pool: Pool,
  args: { principal: Principal; processKey: string; days?: number; now?: Date },
): Promise<AnswerSummary> {
  const days = args.days ?? 30;
  const now = args.now ?? new Date();
  const from = new Date(now.getTime() - days * 86_400_000);

  return inTransaction(pool, async (client) => {
    if (args.principal.kind === 'system') throw new Error('system principals do not read summaries');
    const tenantId = args.principal.tenantId;

    const { rows: versions } = await client.query<{ blueprint: Blueprint }>(
      `select blueprint from process_version
        where tenant_id = $1 and process_key = $2 order by version desc limit 1`,
      [tenantId, args.processKey],
    );
    if (!versions[0]) throw new Error(`no published version of "${args.processKey}"`);
    const bp = versions[0].blueprint;

    const decision = await require_(
      client,
      { principal: args.principal, action: 'report', tenantId, processKey: args.processKey, blueprint: bp },
      pool,
    );

    const visible = new Set(visibleFields(bp, decision.roles, decision.workspaceRole));
    const candidates = bp.data.fields.filter((f) => CHOICE.has(f.type) || NUMBER.has(f.type));
    const withheld = candidates.filter((f) => !visible.has(f.key)).map((f) => f.key);
    const fields = candidates.filter((f) => visible.has(f.key));

    const { rows } = await client.query<{ data: Record<string, unknown> }>(
      `select data from instance
        where tenant_id = $1 and process_key = $2 and created_at >= $3 and created_at <= $4`,
      [tenantId, args.processKey, from, now],
    );
    const base = { from: from.toISOString(), to: now.toISOString(), records: rows.length, minCohort: MIN_COHORT, withheld };
    if (rows.length < MIN_COHORT) return { ...base, choices: [], numbers: [] };

    const blank = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

    const choices: ChoiceSummary[] = [];
    for (const f of fields) {
      if (!CHOICE.has(f.type)) continue;
      const counts = new Map<string, number>();
      let answered = 0;
      for (const r of rows) {
        const v = r.data[f.key];
        if (blank(v)) continue;
        answered++;
        for (const x of Array.isArray(v) ? v : [v]) {
          const k = String(x);
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
      if (!answered) continue;
      const label = (v: string) =>
        f.type === 'yes_no'
          ? v === 'true' ? 'Yes' : v === 'false' ? 'No' : v
          : f.choices?.find((c) => String(c.value) === v)?.label ?? v;
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      choices.push({
        key: f.key,
        label: f.label,
        type: f.type,
        answered,
        buckets: sorted.slice(0, TOP).map(([value, count]) => ({ value, label: label(value), count })),
        more: sorted.slice(TOP).reduce((n, [, c]) => n + c, 0),
      });
    }

    const numbers: NumberSummary[] = [];
    for (const f of fields) {
      if (!NUMBER.has(f.type)) continue;
      const values: number[] = [];
      for (const r of rows) {
        const v = r.data[f.key];
        if (blank(v)) continue;
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isFinite(n)) values.push(n);
      }
      if (!values.length) continue;
      const sum = values.reduce((a, b) => a + b, 0);
      const code = f.constraints?.currencyCode;
      numbers.push({
        key: f.key,
        label: f.label,
        type: f.type,
        count: values.length,
        sum: round(sum),
        mean: round(sum / values.length),
        min: Math.min(...values),
        max: Math.max(...values),
        ...(typeof code === 'string' ? { currencyCode: code } : {}),
      });
    }

    return { ...base, choices, numbers };
  });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
