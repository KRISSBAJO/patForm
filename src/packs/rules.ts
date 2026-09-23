/**
 * What a category guarantees, regardless of who wrote the pack.
 *
 * The packs were honest starting points and nothing more: every one declared
 * "the approval chain is a reasonable guess" as an open decision. That is fine
 * for a form and not fine for a process, because the part worth having is not
 * the questions — it is **who decides, by when, what happens when nobody does,
 * and what is watched afterwards.**
 *
 * So the domain rules live here rather than in each pack. A pack says what it
 * is about; its category says how it must behave. Three things follow:
 *
 * 1. **Nothing can be missed.** `npm run packs:check` audits every pack
 *    against its category's controls and fails the build. A Health & safety
 *    pack that does not record when something happened is not a warning, it
 *    is a broken build.
 * 2. **Rules apply by construction, not by review.** The escalation chain,
 *    the retention floor and the threshold approvals are generated from these
 *    rules, so a new pack in a category cannot forget them.
 * 3. **Changing a rule changes every pack in that category**, which is the
 *    only way eighty-eight of them stay consistent.
 */

/** A control a category insists on. Each one is checked, not asserted. */
export type Control =
  | 'records_when'
  | 'restricted_hidden'
  | 'decided_quickly'
  | 'kept_long_enough'
  | 'two_person_decision'
  | 'escalates'
  | 'asks_for_evidence';

export interface Threshold {
  /*
   * No field name.
   *
   * The first version named one — `amount` — and six of the seven Finance
   * packs call theirs something else: `estimated_cost`, `invoice_amount`,
   * `refund_amount`. A rule that matches a name matches whichever pack
   * happened to use it, which is worse than no rule because it looks like
   * one. The tier attaches to the pack's **money field**, whatever it is
   * called, and to nothing if the pack asks for no money.
   */
  over: number;
  approval: { key: string; name: string; byRole: string; dueInHours: number };
  /** Said on the pack, so an installer knows the number is a default. */
  because: string;
}

export interface CategoryRules {
  /** Hours the first decision has before anybody is chased. */
  decideWithinHours: number;
  /** Who is told when it is not decided in time. */
  escalateTo: string;
  /** Hours the escalation has before the record closes itself. */
  escalationHours: number;
  /**
   * Nothing in this category may be kept for less than this.
   *
   * Applied, not merely checked — a pack declaring less is raised to the
   * floor, because a statutory period is not a preference.
   */
  retentionFloorDays: number | null;
  /** An extra approval when a value crosses a line. */
  threshold?: Threshold;
  requires: Control[];
  /** What the dashboard watches for this kind of work. */
  monitors: { key: string; name: string; kind: string }[];
  /**
   * What the category promises, in one sentence, shown on every pack in it.
   *
   * Retention is stated as a floor — "at least five years" — because that is
   * what `retentionFloorDays` is. A pack may keep records longer, and some
   * should: a baptism register is kept permanently, and the sentence said
   * "kept five years" directly above a panel saying "kept indefinitely". Two
   * true statements that read as a contradiction are a page nobody trusts.
   */
  says: string;
}

const WATCH_BASICS = [
  { key: 'received', name: 'Received', kind: 'intake' },
  { key: 'cycle_time', name: 'Time from start to finish', kind: 'cycle_time' },
  { key: 'aging', name: 'Waiting the longest', kind: 'stage_aging' },
];

const WATCH_DECISIONS = [{ key: 'approval_time', name: 'Time waiting on a decision', kind: 'approval_time' }];
const WATCH_COMPLETION = [{ key: 'completion', name: 'Finished', kind: 'completion_rate' }];
const WATCH_ABANDONMENT = [{ key: 'abandoned', name: 'Given up on', kind: 'abandonment' }];
const WATCH_AUTOMATION = [
  { key: 'automation_failures', name: 'Automation that failed', kind: 'automation_failure_rate' },
];

/**
 * A default that applies where a category has no stronger opinion.
 *
 * Deliberately not permissive: three days to decide, a week for the
 * escalation, three years kept, and an escalation path that exists. A
 * category with nothing special about it still gets a process.
 */
export const DEFAULT_RULES: CategoryRules = {
  decideWithinHours: 72,
  escalateTo: 'department_head',
  escalationHours: 168,
  retentionFloorDays: 1095,
  requires: ['escalates', 'restricted_hidden'],
  monitors: [...WATCH_BASICS, ...WATCH_COMPLETION],
  says: 'Decisions are chased after three days and escalated after a week.',
};

export const RULES: Record<string, CategoryRules> = {
  /*
   * Health & safety. The clock is the control: a hazard nobody looked at for
   * a week is the thing the inspector asks about, and records outlive the
   * people who wrote them.
   */
  'Health & safety': {
    decideWithinHours: 24,
    escalateTo: 'safety_director',
    escalationHours: 48,
    retentionFloorDays: 3650,
    requires: ['records_when', 'restricted_hidden', 'decided_quickly', 'kept_long_enough', 'escalates'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS, ...WATCH_COMPLETION],
    says: 'Looked at within a day, escalated to a director within two, and kept at least ten years.',
  },

  /*
   * Compliance. Most of these carry a statutory clock that starts when
   * somebody finds out rather than when they get round to it, so the record
   * has to capture the date and the decision window is short.
   */
  Compliance: {
    decideWithinHours: 48,
    escalateTo: 'general_counsel',
    escalationHours: 72,
    retentionFloorDays: 2555,
    requires: ['records_when', 'restricted_hidden', 'decided_quickly', 'kept_long_enough', 'escalates'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS, ...WATCH_COMPLETION, ...WATCH_AUTOMATION],
    says: 'Assessed within two days, escalated to counsel within three, and kept at least seven years.',
  },

  Healthcare: {
    decideWithinHours: 24,
    escalateTo: 'clinical_lead',
    escalationHours: 48,
    retentionFloorDays: 3650,
    requires: ['restricted_hidden', 'decided_quickly', 'kept_long_enough', 'escalates'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS, ...WATCH_ABANDONMENT],
    says: 'Triaged within a day, escalated to a clinical lead, and kept at least ten years.',
  },

  /*
   * Finance. The one category where the amount decides the chain, which is
   * why the threshold lives here rather than in each pack: a workspace that
   * changes its limit changes it once.
   */
  Finance: {
    decideWithinHours: 72,
    escalateTo: 'finance_controller',
    escalationHours: 168,
    retentionFloorDays: 2555,
    threshold: {
      over: 1000,
      approval: {
        key: 'controller',
        name: 'Financial controller',
        byRole: 'finance_controller',
        dueInHours: 120,
      },
      because: 'Anything over a thousand takes a second pair of eyes — change the limit in the builder.',
    },
    requires: ['kept_long_enough', 'escalates', 'restricted_hidden', 'two_person_decision'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS, ...WATCH_COMPLETION],
    says: 'Over a thousand needs a controller as well, and everything is kept at least seven years.',
  },

  People: {
    decideWithinHours: 48,
    escalateTo: 'hr_director',
    escalationHours: 120,
    retentionFloorDays: 2555,
    requires: ['restricted_hidden', 'kept_long_enough', 'escalates'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS, ...WATCH_COMPLETION],
    says: 'First decision due within two days; overdue work escalates to the HR director. Records are kept at least seven years by default.',
  },

  IT: {
    decideWithinHours: 8,
    escalateTo: 'it_manager',
    escalationHours: 24,
    retentionFloorDays: 730,
    requires: ['decided_quickly', 'escalates', 'restricted_hidden'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS, ...WATCH_AUTOMATION],
    says: 'Triaged the same working day and escalated to a manager within one.',
  },

  Customer: {
    decideWithinHours: 24,
    escalateTo: 'customer_director',
    escalationHours: 72,
    retentionFloorDays: 2190,
    requires: ['decided_quickly', 'escalates', 'restricted_hidden'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS, ...WATCH_COMPLETION, ...WATCH_ABANDONMENT],
    says: 'Acknowledged within a day — the deadline a complaints regulator measures.',
  },

  /*
   * Church. A week is right for most of it and wrong for a funeral, which is
   * why the pack keeps its own shorter time where it sets one: the rule is a
   * ceiling on how long something may wait, not a floor.
   */
  Church: {
    decideWithinHours: 168,
    escalateTo: 'senior_minister',
    escalationHours: 336,
    retentionFloorDays: 1825,
    requires: ['restricted_hidden', 'escalates'],
    monitors: [...WATCH_BASICS, ...WATCH_COMPLETION, ...WATCH_ABANDONMENT],
    says: 'First decision due within a week at most; overdue work escalates to the senior minister. Records are kept at least five years by default.',
  },

  Projects: {
    decideWithinHours: 72,
    escalateTo: 'programme_director',
    escalationHours: 168,
    retentionFloorDays: 2555,
    requires: ['escalates', 'kept_long_enough'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS, ...WATCH_COMPLETION],
    says: 'Three days for a decision, then the programme director — nothing sits in a status column.',
  },

  Events: {
    decideWithinHours: 72,
    escalateTo: 'events_director',
    escalationHours: 120,
    retentionFloorDays: 365,
    requires: ['escalates'],
    monitors: [...WATCH_BASICS, ...WATCH_COMPLETION, ...WATCH_ABANDONMENT],
    says: 'Three days to decide and five before it goes to a director — an event has a date.',
  },

  Education: {
    decideWithinHours: 48,
    escalateTo: 'head_of_school',
    escalationHours: 120,
    retentionFloorDays: 1095,
    requires: ['restricted_hidden', 'escalates'],
    monitors: [...WATCH_BASICS, ...WATCH_COMPLETION],
    says: 'First decision due within two days; overdue work escalates to the head of school. Records are kept at least three years by default.',
  },

  Community: {
    decideWithinHours: 120,
    escalateTo: 'trustee_board',
    escalationHours: 336,
    retentionFloorDays: 1825,
    requires: ['escalates', 'restricted_hidden'],
    monitors: [...WATCH_BASICS, ...WATCH_COMPLETION, ...WATCH_ABANDONMENT],
    says: 'Five days, then the trustees — and volunteer records kept at least five years.',
  },

  Facilities: {
    decideWithinHours: 24,
    escalateTo: 'facilities_director',
    escalationHours: 72,
    retentionFloorDays: 1825,
    requires: ['decided_quickly', 'escalates'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS, ...WATCH_COMPLETION],
    says: 'First decision due within a day; overdue work escalates to the facilities director. Set shorter routes for urgent safety faults.',
  },

  Property: {
    decideWithinHours: 48,
    escalateTo: 'property_director',
    escalationHours: 120,
    retentionFloorDays: 2555,
    requires: ['escalates', 'kept_long_enough'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS, ...WATCH_COMPLETION],
    says: 'Two days, then a director — a repair has a statutory clock behind it.',
  },

  Operations: {
    decideWithinHours: 24,
    escalateTo: 'operations_director',
    escalationHours: 72,
    retentionFloorDays: 1095,
    requires: ['escalates'],
    monitors: [...WATCH_BASICS, ...WATCH_COMPLETION, ...WATCH_AUTOMATION],
    says: 'A day to decide, then a director — operational work does not keep.',
  },

  Legal: {
    decideWithinHours: 120,
    escalateTo: 'general_counsel',
    escalationHours: 240,
    retentionFloorDays: 3650,
    requires: ['escalates', 'kept_long_enough'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS],
    says: 'Five days with legal, then counsel, and contracts kept at least ten years.',
  },

  Procurement: {
    decideWithinHours: 120,
    escalateTo: 'procurement_director',
    escalationHours: 240,
    retentionFloorDays: 2555,
    threshold: {
      over: 5000,
      approval: {
        key: 'procurement_director',
        name: 'Procurement director',
        byRole: 'procurement_director',
        dueInHours: 168,
      },
      because: 'Over five thousand goes to a director — change the limit in the builder.',
    },
    requires: ['escalates', 'kept_long_enough'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS],
    says: 'Over five thousand needs a director, and supplier records are kept at least seven years.',
  },

  Sales: {
    decideWithinHours: 24,
    escalateTo: 'sales_director',
    escalationHours: 72,
    retentionFloorDays: 1825,
    requires: ['escalates'],
    monitors: [...WATCH_BASICS, ...WATCH_COMPLETION, ...WATCH_ABANDONMENT],
    says: 'A day to respond — an enquiry that waits is an enquiry somebody else answered.',
  },

  Communications: {
    decideWithinHours: 8,
    escalateTo: 'comms_director',
    escalationHours: 24,
    retentionFloorDays: 1095,
    requires: ['decided_quickly', 'escalates'],
    monitors: [...WATCH_BASICS, ...WATCH_DECISIONS],
    says: 'Eight hours — a journalist has a deadline whether or not anybody replies.',
  },
};

export function rulesFor(category: string): CategoryRules {
  return RULES[category] ?? DEFAULT_RULES;
}

/** What each control means, for the audit's output and for the pack's page. */
export const CONTROL_MEANS: Record<Control, string> = {
  records_when: 'records when the thing happened, not only when it was reported',
  restricted_hidden: 'keeps every restricted field from at least one role that does not need it',
  decided_quickly: 'gives the first decision no more time than the category allows',
  kept_long_enough: 'keeps records for at least the statutory period',
  two_person_decision: 'needs two people to agree above the threshold',
  escalates: 'tells somebody more senior when nobody decides in time',
  asks_for_evidence: 'asks for the evidence rather than taking it on trust',
};
