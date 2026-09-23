/**
 * Does every pack do what its category promises?
 *
 * The compiler checks that a blueprint is coherent. It cannot check that a
 * Health & safety process records *when* something happened, or that a
 * grievance is seen within a day, because those are not properties of a
 * blueprint — they are properties of a **kind of work**, and the compiler has
 * no opinion about kinds of work.
 *
 * So this is the second gate, and it is the one that makes "we do not miss
 * any form" mean something. A category declares the controls it insists on;
 * this checks every pack in that category actually carries them, and fails
 * the build when one does not.
 *
 * Each control is checked against the *generated blueprint*, not against the
 * spec that produced it. Checking the spec would only prove the author wrote
 * something down; checking the output proves it survived generation.
 */

import type { Blueprint } from '../blueprint/index.js';
import { CONTROL_MEANS, rulesFor, type CategoryRules, type Control } from './rules.js';

export interface Finding {
  control: Control;
  ok: boolean;
  /** What was actually found, so a failure says more than "no". */
  detail: string;
}

function has(bp: Blueprint, control: Control, rules: CategoryRules): Finding {
  switch (control) {
    /*
     * A record whose only date is "when it was submitted" cannot answer the
     * first question anybody asks about an incident: when did it happen. The
     * two are days apart in exactly the cases that matter.
     */
    case 'records_when': {
      const dates = bp.data.fields.filter((f) => f.type === 'date' || f.type === 'time');
      return {
        control,
        ok: dates.length > 0,
        detail: dates.length
          ? `asks for ${dates.map((d) => d.label).join(', ')}`
          : 'has no date or time field, so the only timestamp is when it was submitted',
      };
    }

    /*
     * A restricted field visible to every role is a restricted field in name
     * only. The compiler warns (SEC010); here it is a failure, because in
     * these categories it is the whole point.
     */
    case 'restricted_hidden': {
      const restricted = bp.data.fields.filter((f) => f.classification === 'restricted');
      if (!restricted.length) {
        return { control, ok: true, detail: 'holds nothing restricted' };
      }
      const hidden = new Set(bp.roles.flatMap((r) => r.hiddenFields ?? []));
      const exposed = restricted.filter((f) => !hidden.has(f.key));
      return {
        control,
        ok: exposed.length === 0,
        detail: exposed.length
          ? `${exposed.map((f) => f.label).join(', ')} visible to every role`
          : `${restricted.length} restricted field(s), each hidden from at least one role`,
      };
    }

    case 'decided_quickly': {
      const first = bp.workflow.states.find((s) => s.key === 'review_1');
      const sla = first?.slaHours ?? Infinity;
      return {
        control,
        ok: sla <= rules.decideWithinHours,
        detail: `first decision has ${sla === Infinity ? 'no limit' : `${sla}h`}, category allows ${rules.decideWithinHours}h`,
      };
    }

    case 'kept_long_enough': {
      const days = bp.intent.retentionDays;
      const floor = rules.retentionFloorDays ?? 0;
      return {
        control,
        // No retention period means kept forever, which clears any floor.
        ok: days === undefined || days === null || days >= floor,
        detail:
          days === undefined || days === null
            ? 'kept indefinitely'
            : `kept ${days} days, floor is ${floor}`,
      };
    }

    case 'two_person_decision': {
      /*
       * Two decisions is not two people.
       *
       * This counted approvals, which two approvals addressed to the same
       * role satisfies, and which the person who submitted the record
       * satisfies on their own if they hold that role. Both of those are one
       * person deciding twice, which is the thing the control exists to stop.
       */
      const approvals = bp.workflow.approvals;
      const parties = new Set(approvals.flatMap((a) => a.approvers.map((p) => JSON.stringify(p))));
      const submitterBarred = approvals.every((a) => a.notTheSubmitter);

      const reasons: string[] = [];
      // A quorum of two or more is two people by construction: one vote each.
      // A vote among three or more named people needs at least two of them. A
      // vote among a role's holders does not count: the role may have one.
      const quorum = approvals.some(
        (a) =>
          (a.mode === 'quorum' && (a.required ?? 0) >= 2) ||
          (a.mode === 'majority' && a.approvers.every((p) => !('role' in p)) && a.approvers.length >= 3),
      );
      if (!quorum && approvals.length < 2) reasons.push(`only ${approvals.length} approval`);
      if (!quorum && parties.size < 2) reasons.push('every approval is addressed to the same party');
      if (!submitterBarred) reasons.push('the submitter is not barred from deciding');

      return {
        control,
        ok: reasons.length === 0,
        detail: reasons.length
          ? reasons.join('; ')
          : `${approvals.length} approvals across ${parties.size} parties, submitter barred from all`,
      };
    }

    /*
     * The control this whole layer exists for: something undecided has to
     * move on its own. Checked as a real path — a timer out of the first
     * review, into a state that is not terminal, which itself has a way out.
     */
    case 'escalates': {
      const out = bp.workflow.transitions.filter((t) => t.from === 'review_1' && t.trigger.on === 'timer');
      if (!out.length) {
        return { control, ok: false, detail: 'nothing happens when nobody decides' };
      }
      const target = out[0]!.to;
      const targetState = bp.workflow.states.find((s) => s.key === target);
      const onward = bp.workflow.transitions.filter((t) => t.from === target && t.to !== target);
      return {
        control,
        ok: targetState?.type !== 'terminal' && onward.length > 0,
        detail:
          targetState?.type === 'terminal'
            ? `an undecided record goes straight to "${target}" rather than to somebody`
            : `escalates to "${target}" after ${out[0]!.trigger.on === 'timer' ? (out[0]!.trigger as { afterHoursInState: number }).afterHoursInState : '?'}h, which has ${onward.length} way(s) out`,
      };
    }

    case 'asks_for_evidence': {
      const evidence = bp.data.fields.filter(
        (f) => f.type === 'file' || f.type === 'yes_no' || f.type === 'url',
      );
      return {
        control,
        ok: evidence.length > 0,
        detail: evidence.length ? `asks for ${evidence.length} piece(s) of evidence` : 'takes it on trust',
      };
    }
  }
}

/**
 * The one thing a generator must not be trusted about.
 *
 * Entering a state cancels the previous occupancy's timers and schedules the
 * new ones, so **two timers leaving the same state means the shorter one
 * restarts the longer one every time it fires** — and the longer one never
 * arrives. That is not a warning in the compiler because it is a property of
 * the runtime rather than of the blueprint, and it is silent: the process
 * looks complete and a record waits forever.
 *
 * Checked here for every pack, because it is exactly the fault this
 * generator shipped with.
 */
export function timerConflicts(bp: Blueprint): string[] {
  const byState = new Map<string, string[]>();
  for (const t of bp.workflow.transitions) {
    if (t.trigger.on !== 'timer') continue;
    byState.set(t.from, [...(byState.get(t.from) ?? []), t.key]);
  }
  return [...byState.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(
      ([state, keys]) =>
        `"${state}" has ${keys.length} timers (${keys.join(', ')}) — the shortest restarts the rest, so the others never fire`,
    );
}

export function auditPack(bp: Blueprint, category: string): { findings: Finding[]; conflicts: string[] } {
  const rules = rulesFor(category);
  return {
    findings: rules.requires.map((control) => has(bp, control, rules)),
    conflicts: timerConflicts(bp),
  };
}

export function describeControl(control: Control): string {
  return CONTROL_MEANS[control];
}
