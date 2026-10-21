import type { Pool } from './db.js';
import type { Engine } from './engine.js';
import type { Principal } from './policy.js';
import type { Blueprint } from '../blueprint/index.js';
import { processesFor, type WorkSummary } from './console-queries.js';
import { enabledModules } from './modules.js';
import { leaveToApprove, myLeave } from './hr.js';
import { myMeetingActions } from './meetings.js';
import { flattenFields } from '../blueprint/index.js';

/**
 * The phone screen, in one call.
 *
 * On a phone a person wants five things: what needs them, a receipt they
 * can snap now, leave, and nothing else. This gathers those from the
 * modules that are on, across every process they hold a role in, so the
 * screen draws in one round trip and says plainly when a module is off.
 *
 * It widens nothing: every list here comes from the same functions the
 * console uses, under the same principal.
 */

export interface GoApproval {
  processKey: string;
  processName: string;
  instanceId: string;
  reference: string;
  approvalKey: string;
  approvalName: string;
  stateName: string;
  waitingHours: number;
  late: boolean;
  summary: string;
  signatureRequired: boolean;
}

export interface GoTask {
  processKey: string;
  processName: string;
  instanceId: string;
  reference: string;
  taskKey: string;
  taskName: string;
  late: boolean;
  summary: string;
}

export interface CaptureTarget {
  processKey: string;
  name: string;
  publicId: string;
  fieldKey: string;
  fieldLabel: string;
}

export interface GoHome {
  approvals: GoApproval[];
  tasks: GoTask[];
  late: number;
  capture: CaptureTarget[];
  actions: { id: string; number: number; title: string; body: string; due_on: string | null; late: boolean }[];
  start: { processKey: string; name: string; publicId: string }[];
  leave: null | {
    toApprove: { id: string; who: string; type: string; start: string; end: string; days: number; reason: string | null }[];
    mine: { balances: { type: string; left: number | null; unlimited: boolean }[]; requests: { id: string; type: string; start_date: string; end_date: string; days: number; status: string }[] } | null;
  };
}

const MAX_PROCESSES = 20;

/** Fields a phone can fill with a photo: file fields, or the evidence names receipts use. */
function captureField(bp: Blueprint): { key: string; label: string } | null {
  for (const { field } of flattenFields(bp.data.fields)) {
    if (field.setBy === 'operator' || field.setBy === 'system') continue;
    if (field.type === 'file' || /receipt|evidence|attachment/.test(field.key)) return { key: field.key, label: field.label };
  }
  return null;
}

export async function goHome(pool: Pool, engine: Engine, principal: Principal, actorId: string): Promise<GoHome> {
  if (principal.kind !== 'actor') throw new Error('sign in first');
  const processes = (await processesFor(pool, principal.tenantId, actorId)).slice(0, MAX_PROCESSES);
  const approvals: GoApproval[] = [];
  const tasks: GoTask[] = [];
  const capture: CaptureTarget[] = [];
  const start: GoHome['start'] = [];

  const { rows: latest } = await pool.query<{ process_key: string; blueprint: Blueprint }>(
    `select distinct on (process_key) process_key, blueprint from process_version where tenant_id = $1 order by process_key, version desc`,
    [principal.tenantId],
  );
  const blueprints = new Map(latest.map((r) => [r.process_key, r.blueprint]));

  // A phone should not wait for twenty process queries one after another.
  // Keep concurrency bounded so an active workspace does not exhaust the API pool.
  const works: (WorkSummary | null)[] = [];
  for (let i = 0; i < processes.length; i += 4) {
    works.push(...await Promise.all(processes.slice(i, i + 4).map(async (p) => {
      try { return await engine.myWork({ principal, actorId, processKey: p.process_key }); }
      catch { return null; } // No view right on this process.
    })));
  }
  for (const [index, p] of processes.entries()) {
    const work = works[index];
    if (!work) continue;
    for (const a of work.approvals) {
      approvals.push({
        processKey: p.process_key, processName: p.name, instanceId: a.instanceId, reference: a.reference,
        approvalKey: a.approvalKey, approvalName: a.approvalName, stateName: a.stateName, waitingHours: a.waitingHours,
        late: a.late, summary: a.summary, signatureRequired: Boolean((a as { signatureRequired?: boolean }).signatureRequired),
      });
    }
    for (const t of work.tasks) {
      tasks.push({ processKey: p.process_key, processName: p.name, instanceId: t.instanceId, reference: t.reference, taskKey: t.taskKey, taskName: t.taskName, late: t.late, summary: t.summary });
    }
    const bp = blueprints.get(p.process_key);
    const access = bp?.experience.access;
    const mayOpen = Boolean(bp && p.public_id && (!access || access.mode === 'public' || p.roles.includes(access.role)));
    if (bp && p.public_id && mayOpen) {
      start.push({ processKey: p.process_key, name: p.name, publicId: p.public_id });
      const field = captureField(bp);
      if (field) capture.push({ processKey: p.process_key, name: p.name, publicId: p.public_id, fieldKey: field.key, fieldLabel: field.label });
    }
  }
  approvals.sort((a, b) => Number(b.late) - Number(a.late) || b.waitingHours - a.waitingHours);
  tasks.sort((a, b) => Number(b.late) - Number(a.late));

  let leave: GoHome['leave'] = null;
  const modules = await enabledModules(pool, principal.tenantId);
  if (modules.has('hr')) {
    let toApprove: NonNullable<GoHome['leave']>['toApprove'] = [];
    let mine: NonNullable<GoHome['leave']>['mine'] = null;
    try {
      const rows = await leaveToApprove(pool, principal);
      toApprove = rows.map((r) => ({ id: r.id, who: r.employee_name, type: r.type, start: r.start_date, end: r.end_date, days: Number(r.days), reason: r.reason }));
    } catch { /* not an approver of anyone's leave, or not allowed in: nothing to show */ }
    try {
      const m = await myLeave(pool, principal);
      mine = {
        balances: m.balances.map((b) => ({ type: b.name, left: b.left ?? null, unlimited: Boolean(b.unlimited) })),
        requests: (m.requests as { id: string; type: string; start_date: string; end_date: string; days: number; status: string }[]).slice(0, 5)
          .map((r) => ({ id: r.id, type: r.type, start_date: r.start_date, end_date: r.end_date, days: Number(r.days), status: r.status })),
      };
    } catch { /* pre-hire, or no employee record yet */ }
    leave = { toApprove, mine };
  }

  let actions: GoHome['actions'] = [];
  if (modules.has('meetings')) { try { actions = await myMeetingActions(pool, principal); } catch { /* no bodies yet */ } }
  return { approvals, tasks, late: approvals.filter((a) => a.late).length + tasks.filter((t) => t.late).length + actions.filter((a) => a.late).length, capture, start, leave, actions };
}
