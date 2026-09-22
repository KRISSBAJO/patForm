import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { Blueprint } from './blueprint/index.js';
import { DATA_CLASS_RANK, type DataClass } from './blueprint/index.js';
import { availableProviders, blueprintSchema, generateBlueprint, providerFor, type ProviderName } from './ai/index.js';
import type { GenerationOutcome } from './ai/pipeline.js';
import { suppressDelivery } from './runtime/email.js';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

interface Expectation {
  compiles?: boolean;
  terminalSuccess?: boolean;
  allTestKinds?: boolean;
  minStates?: number;
  minApprovals?: number;
  hasDocuments?: number;
  hasIdentityFields?: boolean;
  hasCalculatedField?: boolean;
  hasThresholdRouting?: boolean;
  blockingTasksAwaited?: boolean;
  slaBackedByTimer?: boolean;
  hasGateBeforeCompletion?: boolean;
  sensitivityCeilingAtLeast?: DataClass;
  noRestrictedInEmail?: boolean;
  noRestrictedInWebhook?: boolean;
  fieldsClassifiedAtLeast?: { match: string; atLeast: DataClass; why: string }[];
  shouldNotCollectFileFor?: { match: string; why: string };
  mustNotContainText?: { match: string; why: string }[];
  critical?: boolean;
}

interface EvalCase {
  key: string;
  source: string;
  description: string;
  expect: Expectation;
}

interface Check {
  name: string;
  passed: boolean;
  /**
   * A control check protects authorization or prevents data loss. Section 7.4
   * tolerates zero failures in this class, unlike ordinary omissions.
   */
  control: boolean;
  detail?: string;
}

interface CaseResult {
  key: string;
  decision: GenerationOutcome['decision'];
  repairs: number;
  checks: Check[];
  costUsd?: number;
  durationMs: number;
}

// ---------------------------------------------------------------- assertions

/** Every task some transition waits for, alone or as part of a join. */
function awaitedTasks(bp: Blueprint): Set<string> {
  const out = new Set<string>();
  for (const t of bp.workflow.transitions) {
    if (t.trigger.on === 'task_completed') out.add(t.trigger.task);
    if (t.trigger.on === 'tasks_completed') for (const k of t.trigger.tasks) out.add(k);
  }
  return out;
}

function runChecks(bp: Blueprint | undefined, expect: Expectation, outcome: GenerationOutcome): Check[] {
  const checks: Check[] = [];
  const add = (name: string, passed: boolean, control = false, detail?: string) =>
    checks.push({ name, passed, control, detail });

  if (expect.compiles !== undefined) {
    const errors = outcome.diagnostics.filter((d) => d.severity === 'error');
    add(
      'compiles within one repair',
      outcome.decision === 'publishable',
      false,
      outcome.decision === 'publishable' ? undefined : `${outcome.decision}: ${errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join(' | ')}`,
    );
  }

  if (!bp) return checks;

  const serialized = JSON.stringify(bp);
  const fields = bp.data.fields;

  /**
   * A yes/no confirmation labelled "I confirm my bank account is correct"
   * cannot hold an account number, so classifying it "internal" is right.
   * Matching label prose flagged exactly that and produced a false control
   * failure — and a control gate that cries wolf gets switched off. Only
   * field types that can carry the value are considered, and the key carries
   * more weight than the label.
   */
  const CANNOT_HOLD_A_VALUE = new Set(['yes_no', 'signature_ack', 'content', 'section']);
  const holdsValue = (f: (typeof fields)[number]) => !CANNOT_HOLD_A_VALUE.has(f.type);
  const fieldText = (f: (typeof fields)[number]) => `${f.key} ${f.label}`.toLowerCase();

  if (expect.terminalSuccess) {
    const completion = bp.workflow.states.find((s) => s.key === bp.intent.completionState);
    add('has a reachable successful ending', completion?.outcome === 'success');
  }

  if (expect.allTestKinds) {
    const kinds = new Set(bp.tests.map((t) => t.kind));
    const missing = ['happy_path', 'rejection', 'missing_data', 'timeout', 'duplicate', 'permission'].filter(
      (k) => !kinds.has(k as never),
    );
    add('declares all six scenario kinds', missing.length === 0, false, missing.join(', ') || undefined);
  }

  if (expect.minStates !== undefined) {
    add(`models at least ${expect.minStates} states`, bp.workflow.states.length >= expect.minStates, false, `found ${bp.workflow.states.length}`);
  }

  if (expect.minApprovals !== undefined) {
    add(`has at least ${expect.minApprovals} approvals`, bp.workflow.approvals.length >= expect.minApprovals, false, `found ${bp.workflow.approvals.length}`);
  }

  if (expect.hasDocuments !== undefined) {
    add(`generates at least ${expect.hasDocuments} document`, bp.outputs.documents.length >= expect.hasDocuments, false, `found ${bp.outputs.documents.length}`);
  }

  if (expect.hasIdentityFields) {
    add('names fields that identify a duplicate', Boolean(bp.data.identity?.length));
  }

  if (expect.hasCalculatedField) {
    add('computes a total rather than asking for one', fields.some((f) => f.type === 'calculated'));
  }

  if (expect.hasThresholdRouting) {
    const routesOnAmount = bp.workflow.transitions.some((t) => {
      const text = JSON.stringify(t.when ?? {});
      return /"(gt|gte|lt|lte)"/.test(text) && /"literal":\s*\d/.test(text);
    });
    add('routes on a numeric threshold', routesOnAmount);
  }

  if (expect.blockingTasksAwaited) {
    // A task joined with others is awaited just as much as one waited for
    // alone. Counting only `task_completed` would report a clean fan-out as an
    // orphaned control.
    const awaited = awaitedTasks(bp);
    const orphaned = bp.workflow.tasks.filter((t) => t.blocking && !awaited.has(t.key)).map((t) => t.key);
    add('every blocking task is actually waited for', orphaned.length === 0, true, orphaned.join(', ') || undefined);
  }

  if (expect.slaBackedByTimer) {
    const timerStates = new Set(
      bp.workflow.transitions.filter((t) => t.trigger.on === 'timer').map((t) => t.from),
    );
    const unenforced = bp.workflow.states.filter((s) => s.slaHours && !timerStates.has(s.key)).map((s) => s.key);
    add('every SLA has something that fires when it passes', unenforced.length === 0, false, unenforced.join(', ') || undefined);
  }

  if (expect.hasGateBeforeCompletion) {
    // A task joined with others is awaited just as much as one waited for
    // alone. Counting only `task_completed` would report a clean fan-out as an
    // orphaned control.
    const awaited = awaitedTasks(bp);
    const realGate = bp.workflow.tasks.some((t) => t.blocking && awaited.has(t.key));
    add('the external check is a real gate, not a note', realGate && bp.workflow.approvals.length > 0, true);
  }

  if (expect.sensitivityCeilingAtLeast) {
    const ok = DATA_CLASS_RANK[bp.intent.sensitivityCeiling] >= DATA_CLASS_RANK[expect.sensitivityCeilingAtLeast];
    add(`sensitivity ceiling is at least ${expect.sensitivityCeilingAtLeast}`, ok, true, `declared ${bp.intent.sensitivityCeiling}`);
  }

  if (expect.noRestrictedInEmail) {
    const restricted = new Set(fields.filter((f) => f.classification === 'restricted').map((f) => f.key));
    const leaks: string[] = [];
    for (const tpl of bp.communications.email) {
      for (const key of restricted) {
        if (`${tpl.subject} ${tpl.body}`.includes(`{{${key}}}`)) leaks.push(`${tpl.key} → ${key}`);
      }
    }
    add('no restricted value in an email body', leaks.length === 0, true, leaks.join(', ') || undefined);
  }

  if (expect.noRestrictedInWebhook) {
    const restricted = new Set(fields.filter((f) => f.classification === 'restricted').map((f) => f.key));
    const leaks: string[] = [];
    for (const t of bp.workflow.transitions) {
      for (const a of t.actions) {
        if (a.do !== 'call_webhook') continue;
        for (const key of a.includeFields) if (restricted.has(key)) leaks.push(`${a.event} → ${key}`);
      }
    }
    add('no restricted value in a webhook payload', leaks.length === 0, true, leaks.join(', ') || undefined);
  }

  // The check the compiler structurally cannot make: a model that labels a
  // bank account "internal" produces a blueprint that compiles and leaks.
  for (const rule of expect.fieldsClassifiedAtLeast ?? []) {
    const pattern = new RegExp(rule.match, 'i');
    const matched = fields.filter((f) => holdsValue(f) && pattern.test(fieldText(f)));
    const under = matched.filter((f) => DATA_CLASS_RANK[f.classification] < DATA_CLASS_RANK[rule.atLeast]);
    add(
      `fields matching /${rule.match}/ are at least ${rule.atLeast}`,
      matched.length > 0 && under.length === 0,
      true,
      matched.length === 0
        ? 'no field matched, so the process did not collect it at all'
        : under.map((f) => `${f.key} is ${f.classification}`).join(', ') || undefined,
    );
  }

  if (expect.shouldNotCollectFileFor) {
    const pattern = new RegExp(expect.shouldNotCollectFileFor.match, 'i');
    const stored = fields.filter((f) => f.type === 'file' && pattern.test(fieldText(f))).map((f) => f.key);
    add('records the check by reference instead of storing the evidence', stored.length === 0, true, stored.join(', ') || undefined);
  }

  for (const rule of expect.mustNotContainText ?? []) {
    const pattern = new RegExp(rule.match, 'i');
    add(`blueprint contains nothing matching /${rule.match}/`, !pattern.test(serialized), true, rule.why);
  }

  return checks;
}

// -------------------------------------------------------------------- runner

async function main(): Promise<void> {
  suppressDelivery('evaluation runs blueprints that name invented people');
  const available = availableProviders();
  if (!available.length) {
    console.error('No API key is set. Put ANTHROPIC_API_KEY or OPENAI_API_KEY in .env');
    process.exit(2);
  }

  const providerArg = process.argv.indexOf('--provider');
  const providerName = (providerArg >= 0 ? process.argv[providerArg + 1] : available[0]) as ProviderName;
  const onlyArg = process.argv.indexOf('--case');
  const only = onlyArg >= 0 ? process.argv[onlyArg + 1] : undefined;

  const suite = JSON.parse(readFileSync('evals/cases.json', 'utf8')) as { cases: EvalCase[] };
  const wanted = only ? new Set(only.split(',').map((k) => k.trim())) : undefined;
  const cases = wanted ? suite.cases.filter((c) => wanted.has(c.key)) : suite.cases;
  const provider = providerFor(providerName);
  const schema = blueprintSchema();

  console.log(`\n${BOLD}Blueprint generation eval${OFF} ${DIM}· ${provider.name} · ${provider.model} · ${cases.length} case(s)${OFF}\n`);

  const results: CaseResult[] = [];

  for (const testCase of cases) {
    process.stdout.write(`  ${BOLD}${testCase.key.padEnd(24)}${OFF}`);

    let outcome: GenerationOutcome;
    try {
      outcome = await generateBlueprint(provider, schema, { description: testCase.description, maxRepairs: 1 });
    } catch (err) {
      console.log(` ${RED}threw${OFF} ${DIM}${err instanceof Error ? err.message : String(err)}${OFF}`);
      results.push({ key: testCase.key, decision: 'unparseable', repairs: 0, checks: [{ name: 'generation completed', passed: false, control: false }], durationMs: 0 });
      continue;
    }

    const checks = runChecks(outcome.blueprint, testCase.expect, outcome);
    const failed = checks.filter((c) => !c.passed);
    const controlFailed = failed.filter((c) => c.control);

    const mark = controlFailed.length ? `${RED}CONTROL${OFF}` : failed.length ? `${YELLOW}partial${OFF}` : `${GREEN}pass${OFF}`;
    console.log(
      ` ${mark} ${DIM}${outcome.decision} · ${outcome.audit.repairs} repair(s) · ${(outcome.audit.durationMs / 1000).toFixed(1)}s` +
        `${outcome.audit.totalCostUsd !== undefined ? ` · $${outcome.audit.totalCostUsd.toFixed(3)}` : ''}${OFF}`,
    );
    for (const c of failed) {
      console.log(`    ${c.control ? RED : YELLOW}✗${OFF} ${c.name}${c.detail ? ` ${DIM}— ${c.detail}${OFF}` : ''}`);
    }

    results.push({
      key: testCase.key,
      decision: outcome.decision,
      repairs: outcome.audit.repairs,
      checks,
      costUsd: outcome.audit.totalCostUsd,
      durationMs: outcome.audit.durationMs,
    });
  }

  // ----------------------------------------------------------- §7.4 gates
  const total = results.length;
  const compiled = results.filter((r) => r.decision === 'publishable').length;
  const validity = total ? (compiled / total) * 100 : 0;

  const allChecks = results.flatMap((r) => r.checks);
  const omissions = allChecks.filter((c) => !c.passed && !c.control);
  const omissionRate = allChecks.length ? (omissions.length / allChecks.length) * 100 : 0;
  const controlFailures = allChecks.filter((c) => !c.passed && c.control);

  const cost = results.reduce<number | undefined>(
    (acc, r) => (r.costUsd === undefined ? acc : (acc ?? 0) + r.costUsd),
    undefined,
  );

  const gate = (ok: boolean) => (ok ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`);

  console.log(`\n${BOLD}Section 7.4 release gates${OFF}\n`);
  console.log(`  ${gate(validity >= 98)}  Blueprint validity — ${validity.toFixed(0)}% compile after one repair ${DIM}(gate: 98%)${OFF}`);
  console.log(`  ${gate(omissionRate < 2)}  Critical omission rate — ${omissionRate.toFixed(1)}% of expectations missed ${DIM}(gate: under 2%)${OFF}`);
  const controlChecks = allChecks.filter((c) => c.control);
  const controlsEvaluated = controlChecks.length > 0;
  console.log(
    controlsEvaluated
      ? `  ${gate(controlFailures.length === 0)}  Authorization and data-loss controls — ${controlFailures.length} failure(s) of ${controlChecks.length} ${DIM}(gate: zero)${OFF}`
      : `  ${YELLOW}N/A ${OFF}  Authorization and data-loss controls — not evaluated, because no case produced a blueprint to check`,
  );
  if (controlFailures.length) {
    for (const c of controlFailures) console.log(`       ${RED}${c.name}${OFF}${c.detail ? ` ${DIM}— ${c.detail}${OFF}` : ''}`);
  }
  console.log(
    `\n  ${DIM}${total} case(s) · ${(results.reduce((a, r) => a + r.durationMs, 0) / 1000).toFixed(0)}s total` +
      `${cost !== undefined ? ` · $${cost.toFixed(3)}` : ' · cost not configured for this provider'}${OFF}\n`,
  );

  mkdirSync('output', { recursive: true });
  const path = `output/eval-${provider.name}-${Date.now()}.json`;
  writeFileSync(
    path,
    `${JSON.stringify({ provider: provider.name, model: provider.model, ranAt: new Date().toISOString(), validity, omissionRate, controlFailures: controlFailures.length, results }, null, 2)}\n`,
  );
  console.log(`  ${DIM}written to ${path}${OFF}\n`);

  process.exit(validity >= 98 && omissionRate < 2 && controlsEvaluated && controlFailures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
