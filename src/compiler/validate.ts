import type { Blueprint } from '../blueprint/index.js';
import {
  DATA_CLASS_RANK,
  VALUE_KIND,
  fieldsInCalc,
  fieldsInExpr,
  flattenFields,
  placeholdersIn,
  type Action,
  type Expr,
  type Field,
  type Party,
  type Transition,
} from '../blueprint/index.js';
import { Diagnostics } from './diagnostics.js';

type ValueKind = (typeof VALUE_KIND)[keyof typeof VALUE_KIND];

const REQUIRED_TEST_KINDS = [
  'happy_path',
  'rejection',
  'missing_data',
  'timeout',
  'duplicate',
  'permission',
] as const;

const CHOICE_TYPES = new Set(['single_choice', 'multi_choice', 'dropdown', 'matrix']);

/**
 * The process compiler. It decides whether a blueprint is something the runtime
 * can execute safely, which is the boundary the product document draws in
 * section 7.1: the model proposes, this disposes.
 *
 * Errors block publication (BLD-04, BLD-07). Warnings are surfaced in review
 * but do not block, because a process that stalls is a business decision while
 * a process that leaks data is not.
 */
export function validate(bp: Blueprint): Diagnostics {
  const d = new Diagnostics();

  // ---------------------------------------------------------------- indexes
  const allFields = flattenFields(bp.data.fields);
  const fieldByKey = new Map<string, Field>();
  for (const { path, field } of allFields) {
    if (fieldByKey.has(field.key)) {
      d.error(
        'REF001',
        `data.fields.${path}`,
        `Duplicate field key "${field.key}".`,
        'Field keys must be unique across the whole process, including inside repeating groups.',
      );
    }
    fieldByKey.set(field.key, field);
  }

  const roleByKey = new Map(bp.roles.map((r) => [r.key, r]));
  const stateByKey = new Map(bp.workflow.states.map((s) => [s.key, s]));
  const approvalByKey = new Map(bp.workflow.approvals.map((a) => [a.key, a]));
  const taskByKey = new Map(bp.workflow.tasks.map((t) => [t.key, t]));
  const emailByKey = new Map(bp.communications.email.map((e) => [e.key, e]));
  const docByKey = new Map(bp.outputs.documents.map((x) => [x.key, x]));

  duplicateKeys(d, bp.roles, 'roles', 'role');
  duplicateKeys(d, bp.workflow.states, 'workflow.states', 'state');
  duplicateKeys(d, bp.workflow.transitions, 'workflow.transitions', 'transition');
  duplicateKeys(d, bp.workflow.approvals, 'workflow.approvals', 'approval');
  duplicateKeys(d, bp.workflow.tasks, 'workflow.tasks', 'task');
  duplicateKeys(d, bp.communications.email, 'communications.email', 'email template');
  duplicateKeys(d, bp.outputs.documents, 'outputs.documents', 'document');
  duplicateKeys(d, bp.tests, 'tests', 'test');

  const requireField = (key: string, at: string, why: string): Field | undefined => {
    const f = fieldByKey.get(key);
    if (!f) {
      d.error('REF002', at, `${why} refers to unknown field "${key}".`, 'Add the field, or correct the key.');
    }
    return f;
  };

  /*
   * Which repeating group each question belongs to, if any.
   *
   * A condition that names a row question directly — `line_amount > 200`
   * outside any quantifier — used to compile, because the key exists, and
   * then read nothing at runtime: there is no top-level answer called
   * `line_amount`, only one per row. So it was silently false on every
   * record. Now it has to go through `any` or `all` over its group.
   */
  const groupOf = new Map<string, string>();
  for (const { path, field } of allFields) {
    const parts = path.split('.');
    if (parts.length > 1) groupOf.set(field.key, parts[parts.length - 2]!);
  }

  const checkExpr = (expr: Expr, at: string, initialScope: Set<string> = new Set()): void => {
    const operand = (o: unknown, scope: Set<string>): void => {
      if (!o || typeof o !== 'object' || !('field' in o)) return;
      const key = (o as { field: string }).field;
      const f = requireField(key, at, 'Condition');
      const group = groupOf.get(key);
      if (f && group && !scope.has(group)) {
        const g = fieldByKey.get(group);
        d.error(
          'RPT001',
          at,
          `"${f.label}" is a question inside "${g?.label ?? group}", so there is one answer per row, not one for the record.`,
          `Use "any" or "all" over ${group} — for example, any row where ${key} is more than a value.`,
        );
      }
    };

    const walk = (e: Expr, scope: Set<string>): void => {
      switch (e.op) {
        case 'and':
        case 'or':
          e.operands.forEach((x) => walk(x, scope));
          return;
        case 'not':
          walk(e.operand, scope);
          return;
        case 'any':
        case 'all': {
          const g = requireField(e.over, at, 'Condition');
          if (g && g.type !== 'repeating_group') {
            d.error(
              'RPT002',
              at,
              `"${g.label}" is a ${g.type.replace(/_/g, ' ')}, not a list of rows, so "${e.op}" has nothing to look through.`,
              'Point it at a repeating group, or compare the answer directly.',
            );
          }
          const outer = groupOf.get(e.over);
          if (g && outer && !scope.has(outer)) {
            d.error(
              'RPT001',
              at,
              `"${g.label}" sits inside another group, "${fieldByKey.get(outer)?.label ?? outer}".`,
              `Look through ${outer} first, with "any" or "all", and put this condition inside it.`,
            );
          }
          walk(e.where, new Set(scope).add(e.over));
          // A condition inside a quantifier that never reads the row gives the
          // same answer for every row: "any" is then just "there is a row".
          if (g?.type === 'repeating_group' && !fieldsInExpr(e.where).some((k) => groupOf.get(k) === e.over)) {
            d.warn(
              'RPT003',
              at,
              `The condition inside "${e.op}" over "${g.label}" never looks at a row, so it is the same for every row.`,
              `Compare one of ${g.label}'s own questions, or move the condition outside.`,
            );
          }
          return;
        }
        case 'in':
        case 'not_in':
          operand(e.left, scope);
          e.right.forEach((r) => operand(r, scope));
          return;
        case 'is_empty':
        case 'is_present':
          operand(e.left, scope);
          return;
        default:
          operand(e.left, scope);
          operand(e.right, scope);
      }
    };

    walk(expr, initialScope);
    typeCheckExpr(d, expr, at, fieldByKey);
  };

  /**
   * An approver must actually be able to approve.
   *
   * checkParty only asks whether the role exists. A role that exists but does
   * not hold `approve` is refused by the policy engine at runtime, so the
   * approval never clears and the record waits in that state until somebody
   * notices — which is the same failure as an approval nobody was assigned,
   * arrived at by a route that reads fine in review.
   *
   * Respondents are worse: authorize() refuses the `approve` action for a
   * respondent principal before it looks at any role at all, so the capability
   * on the role would not save it even if it were granted.
   */
  const checkApprover = (p: Party, at: string, approvalKey: string): void => {
    if (!('role' in p)) return;
    const role = roleByKey.get(p.role);
    if (!role) return; // already reported by checkParty
    if (role.kind === 'respondent') {
      d.error(
        'SEC009',
        at,
        `Approval "${approvalKey}" names respondent role "${role.key}" as an approver.`,
        'Respondents are outside the workspace and may never approve. Name an internal role.',
      );
      return;
    }
    if (!role.capabilities.includes('approve')) {
      d.error(
        'SEC009',
        at,
        `Approval "${approvalKey}" names role "${role.key}", which does not have the "approve" capability.`,
        `Add "approve" to role "${role.key}", or name a role that already has it.`,
      );
    }
  };

  const checkParty = (p: Party, at: string, what: string): void => {
    if ('role' in p && !roleByKey.has(p.role)) {
      d.error('REF008', at, `${what} refers to unknown role "${p.role}".`);
    }
    if ('field' in p) {
      const f = requireField(p.field, at, what);
      if (f && f.type !== 'email') {
        d.error(
          'REF008',
          at,
          `${what} points at field "${p.field}", which is a ${f.type} and cannot receive mail.`,
          'Use an email field, or address the message to a role.',
        );
      }
    }
  };

  // ------------------------------------------------------------------ intent
  if (!roleByKey.has(bp.intent.owner)) {
    d.error('REF012', 'intent.owner', `Unknown owner role "${bp.intent.owner}".`);
  }
  const completion = stateByKey.get(bp.intent.completionState);
  if (!completion) {
    d.error('REF012', 'intent.completionState', `Unknown state "${bp.intent.completionState}".`);
  } else if (completion.type !== 'terminal' || completion.outcome !== 'success') {
    d.error(
      'FLOW006',
      'intent.completionState',
      `"${completion.key}" is named as the completion state but is not a terminal state with outcome "success".`,
      'Completion rate and cycle time are measured against this state, so it has to be a successful ending.',
    );
  }

  // ------------------------------------------------------- data and identity
  for (const { path, field } of allFields) {
    const at = `data.fields.${path}`;

    if (field.requiredWhen) checkExpr(field.requiredWhen, `${at}.requiredWhen`,
      new Set(path.split('.').slice(0, -1)));

    if (DATA_CLASS_RANK[field.classification] > DATA_CLASS_RANK[bp.intent.sensitivityCeiling]) {
      d.error(
        'SEC001',
        at,
        `Field "${field.key}" is classified ${field.classification}, above this process's ceiling of ${bp.intent.sensitivityCeiling}.`,
        'Raise the ceiling deliberately, drop the field, or collect a less sensitive value.',
      );
    }
    if (field.classification === 'restricted' && !field.collectionReason) {
      d.warn(
        'SEC007',
        at,
        `Restricted field "${field.key}" has no stated collection reason.`,
        'Record why this is needed, or stop collecting it.',
      );
    }
    if (CHOICE_TYPES.has(field.type) && !field.choices?.length) {
      d.error('TYPE003', at, `Field "${field.key}" is a ${field.type} but declares no choices.`);
    }
    if (field.type === 'calculated') {
      if (!field.compute) {
        d.error('TYPE004', at, `Calculated field "${field.key}" has no compute expression.`);
      } else {
        const calc = field.compute;
        if ('op' in calc && (calc.op === 'sum' || calc.op === 'count')) {
          if (calc.where) checkExpr(calc.where, `${at}.compute.where`, new Set([calc.over]));
        }
        for (const ref of fieldsInCalc(field.compute)) {
          if (ref === field.key) {
            d.error('TYPE005', at, `Calculated field "${field.key}" refers to itself.`);
            continue;
          }
          const src = requireField(ref, at, `Calculation for "${field.key}"`);
          if (src && !['number', 'list'].includes(VALUE_KIND[src.type])) {
            d.error(
              'TYPE004',
              at,
              `Calculation for "${field.key}" uses "${ref}", which is a ${src.type}.`,
              'Arithmetic needs a number, currency, rating, or repeating group.',
            );
          }
        }
      }
    }
    if (field.type === 'repeating_group' && !field.fields?.length) {
      d.error('TYPE003', at, `Repeating group "${field.key}" contains no fields.`);
    }
  }
  detectCalcCycles(d, allFields);

  for (const key of bp.data.identity ?? []) {
    requireField(key, 'data.identity', 'Duplicate identity');
  }
  if (!bp.data.identity?.length) {
    d.warn(
      'OPS007',
      'data.identity',
      'No identity fields declared, so the runtime cannot recognise a duplicate submission.',
      'Name the fields that together identify the same person or request.',
    );
  }

  // -------------------------------------------------------------- experience
  const placed = new Set<string>();
  for (const [pi, page] of bp.experience.pages.entries()) {
    if (page.visibleWhen) checkExpr(page.visibleWhen, `experience.pages[${pi}].visibleWhen`);
    for (const [si, section] of page.sections.entries()) {
      const at = `experience.pages[${pi}].sections[${si}]`;
      if (section.visibleWhen) checkExpr(section.visibleWhen, `${at}.visibleWhen`);
      for (const key of section.fields) {
        requireField(key, at, 'Section');
        if (placed.has(key)) {
          d.error('REF003', at, `Field "${key}" appears on more than one page or section.`);
        }
        placed.add(key);
      }
    }
  }
  for (const { path, field } of allFields) {
    // Nested fields live inside their group; hidden and calculated fields are
    // never rendered; and operator or system fields are filled in during the
    // process rather than on the intake form. None of these need a page.
    const nested = path.includes('.');
    if (nested || field.type === 'hidden' || field.type === 'calculated') continue;
    if (field.setBy === 'operator' || field.setBy === 'system') continue;
    if (placed.has(field.key)) continue;
    if (field.required) {
      d.error(
        'REF003',
        `data.fields.${path}`,
        `Required field "${field.key}" is not on any page, so it can never be answered.`,
      );
    } else {
      d.warn('REF003', `data.fields.${path}`, `Field "${field.key}" is not on any page and will never be collected.`);
    }
  }

  // ------------------------------------------------------------------- roles
  for (const [ri, role] of bp.roles.entries()) {
    const at = `roles[${ri}]`;
    for (const key of role.hiddenFields ?? []) requireField(key, at, `Role "${role.key}" hiddenFields`);
    for (const key of role.editableFields ?? []) requireField(key, at, `Role "${role.key}" editableFields`);
    /*
     * A capability with nothing to use it on.
     *
     * `editableFields` absent means "may change nothing", which is the safe
     * reading of an omission — and combined with the `edit` capability it is
     * a permission the blueprint appears to grant and the runtime refuses
     * every time. Found by a proof that edited a record as the one role
     * holding `edit` and silently changed nothing.
     */
    if (role.capabilities.includes('edit') && !(role.editableFields ?? []).length) {
      d.warn(
        'SEC012',
        at,
        `Role "${role.key}" may edit, and no field is listed as editable, so it can change nothing.`,
        'List the fields it may change, or drop the edit capability so the blueprint stops implying one.',
      );
    }
    const overlap = (role.editableFields ?? []).filter((k) => (role.hiddenFields ?? []).includes(k));
    if (overlap.length) {
      d.error('SEC008', at, `Role "${role.key}" may edit fields it cannot see: ${overlap.join(', ')}.`);
    }
    if (role.kind === 'respondent') {
      const privileged = role.capabilities.filter((c) => c === 'operate' || c === 'administer');
      if (privileged.length) {
        d.error(
          'SEC006',
          at,
          `Respondent role "${role.key}" is granted ${privileged.join(' and ')}.`,
          'Respondents are outside the workspace and must not hold operator rights.',
        );
      }
    }
  }
  /*
   * A restricted field every role can read.
   *
   * SEC007 asks why a restricted field is collected; this asks who can see it,
   * which is the other half and the one a data map exposes. The finding that
   * prompted it: a workplace-adjustment field, correctly classified
   * restricted, correctly justified, and visible to the IT operator setting up
   * a laptop — nobody had decided that, it was simply never narrowed.
   *
   * A warning rather than an error, because sometimes it is right: a process
   * whose only internal role is HR has nobody to hide it from. Warnings do
   * not block a publish, and this one should be answered rather than obeyed.
   */
  for (const { path, field } of allFields) {
    if (field.classification !== 'restricted') continue;
    const internal = bp.roles.filter((r) => r.kind === 'internal');
    const hides = internal.filter((r) => (r.hiddenFields ?? []).includes(field.key));
    if (internal.length > 1 && hides.length === 0) {
      d.warn(
        'SEC010',
        path,
        `Restricted field "${field.key}" is hidden from none of the ${internal.length} internal roles.`,
        'Decide who needs it. A restricted field readable by everyone is restricted in name only.',
      );
    }
  }

  /*
   * BLD-02's assumptions and open decisions, surfaced rather than stored.
   *
   * A warning, never an error. An assumption is a statement and a missing
   * decision is a question; neither is a fault, and blocking a publish over
   * one would teach people to write "none" in the field. What warnings do is
   * make publishing with them unanswered a choice somebody made.
   *
   * A `blocking` decision is the one exception the author themselves declared,
   * and it still warns — because the compiler refusing to publish on the
   * strength of a model's own judgement about its own uncertainty is the wrong
   * authority in the wrong place.
   */
  for (const [i, assumption] of (bp.intent.assumptions ?? []).entries()) {
    if (assumption.confirmed) continue;
    d.warn(
      'BLD001',
      `intent.assumptions[${i}]`,
      `Assumed: ${assumption.statement}`,
      `Affects ${assumption.affects}. Confirm it or change it before this goes in front of respondents.`,
    );
  }

  for (const [i, decision] of (bp.intent.openDecisions ?? []).entries()) {
    d.warn(
      'BLD002',
      `intent.openDecisions[${i}]`,
      `${decision.importance === 'blocking' ? 'Needs an answer' : 'Undecided'}: ${decision.question}`,
      `For now: ${decision.provisionally}`,
    );
  }

  for (const { path, field } of allFields) {
    if (field.type !== 'file') continue;
    const at = `data.fields.${path}`;
    const accept = field.constraints?.accept ?? ['application/pdf', 'image/png', 'image/jpeg'];
    if (accept.some((type) => !['application/pdf', 'image/png', 'image/jpeg'].includes(type)) ||
      (field.constraints?.maxSizeMb ?? 5) > 5) {
      d.error('SEC013', at, `File field "${field.key}" exceeds the supported upload types or 5 MB size limit.`,
        'Use PDF, PNG or JPEG and a maximum file size of 5 MB.');
    }
  }

  if (bp.workflow.approvals.length && !bp.roles.some((r) => r.capabilities.includes('approve'))) {
    d.error('SEC005', 'roles', 'The process has approvals but no role may approve.');
  }

  /*
   * Separation of duties, and the thing it depends on.
   *
   * A control that bars "the submitter" and has to guess which address that
   * is reads as enforced in review and bars the wrong person at runtime. The
   * blueprint has to say.
   */
  const submitterField = bp.data.submitterField;

  if (submitterField) {
    const field = fieldByKey.get(submitterField);
    if (!field) {
      d.error('REF014', 'data.submitterField', `No field called "${submitterField}".`);
    } else if (field.type !== 'email') {
      d.error(
        'REF014',
        'data.submitterField',
        `"${submitterField}" is a ${field.type}, and the submitter is identified by an address.`,
        'Point it at an email field the respondent fills in.',
      );
    } else if ((field.setBy ?? 'respondent') !== 'respondent') {
      d.warn(
        'SEC009',
        'data.submitterField',
        `"${submitterField}" is set by ${field.setBy}, not by the respondent.`,
        'The submitter is whoever filled the form in; an operator-set address is somebody else.',
      );
    }
  }

  for (const [ai, approval] of bp.workflow.approvals.entries()) {
    if (!approval.notTheSubmitter) continue;
    if (!submitterField) {
      d.error(
        'SEC010',
        `workflow.approvals[${ai}]`,
        `Approval "${approval.key}" bars the submitter, but the process never says which field holds their address.`,
        'Set data.submitterField. Without it the runtime would guess, and a fraud control that guesses is worse than none.',
      );
    }
    /*
     * An approval addressed only to the submitter and barred from them can
     * never be decided. Worth an error rather than a shrug: the record would
     * route correctly, sit in a waiting state, and refuse every person who
     * tried — including the only one it names.
     */
    const onlySubmitter =
      approval.approvers.length > 0 &&
      approval.approvers.every(
        (p) => ('submitter' in p) || ('field' in p && p.field === submitterField),
      );
    if (onlySubmitter) {
      d.error(
        'SEC011',
        `workflow.approvals[${ai}]`,
        `Approval "${approval.key}" is addressed only to the submitter and also bars them, so nobody can ever decide it.`,
        'Address it to somebody else as well, or drop the bar.',
      );
    }
  }

  // ---------------------------------------------------------------- workflow
  const initial = bp.workflow.states.filter((s) => s.type === 'initial');
  if (initial.length !== 1) {
    d.error('FLOW001', 'workflow.states', `A process needs exactly one initial state; found ${initial.length}.`);
  }
  if (!bp.workflow.states.some((s) => s.type === 'terminal')) {
    d.error('FLOW002', 'workflow.states', 'No terminal state, so no record can ever finish.');
  }
  for (const [si, state] of bp.workflow.states.entries()) {
    if (state.type === 'terminal' && !state.outcome) {
      d.error(
        'FLOW008',
        `workflow.states[${si}]`,
        `Terminal state "${state.key}" does not say whether it is a success, rejection, cancellation, or expiry.`,
      );
    }
    if (state.type !== 'terminal' && state.outcome) {
      d.error('FLOW008', `workflow.states[${si}]`, `Non-terminal state "${state.key}" declares an outcome.`);
    }
  }

  const outgoing = new Map<string, typeof bp.workflow.transitions>();
  for (const t of bp.workflow.transitions) {
    const list = outgoing.get(t.from) ?? [];
    list.push(t);
    outgoing.set(t.from, list);
  }

  /*
   * A quorum that cannot be met is a record that can never leave its state.
   * People named by address can be counted, so "three of these two" is an
   * error. A role cannot be counted from here — it is however many people
   * hold it on the day — so a quorum that leans on one is a warning that says
   * how many it needs.
   */
  const checkQuorum = (approval: (typeof bp.workflow.approvals)[number], at: string): void => {
    if (approval.mode === 'majority') {
      if (approval.required !== undefined) {
        d.error(
          'APR001',
          at,
          `Approval "${approval.key}" is a majority vote and also sets required.`,
          'A majority is more than half of whoever may vote; remove required, or make it a quorum.',
        );
      }
      if (approval.allowRequestChanges) {
        d.error(
          'APR004',
          at,
          `Approval "${approval.key}" is a vote but allows a request for changes.`,
          'A vote is yes or no: one voter sending it back would settle what the others were still deciding. Set allowRequestChanges to false.',
        );
      }
      const roles = approval.approvers.filter((p) => 'role' in p).map((p) => (p as { role: string }).role);
      const people = new Set(approval.approvers.filter((p) => !('role' in p)).map((p) => JSON.stringify(p))).size;
      if (roles.length) {
        d.warn(
          'APR003',
          at,
          `Approval "${approval.key}" is a vote among everybody holding ${roles.join(', ')} when it is asked.`,
          'The number who may vote, and so the number needed, is counted then and kept for that record.',
        );
      } else if (people <= 2) {
        d.warn(
          'APR005',
          at,
          `Approval "${approval.key}" is a vote among ${people} ${people === 1 ? 'person' : 'people'}, which needs ${people === 1 ? 'that person' : 'both'} to approve.`,
          people === 1 ? 'Say "single" instead.' : 'Say "sequential" or a quorum of 2, which mean the same and read more plainly.',
        );
      }
      return;
    }
    if (approval.mode !== 'quorum') {
      if (approval.required !== undefined) {
        d.error('APR001', at, `Approval "${approval.key}" sets required, which only a quorum uses.`, 'Set mode to "quorum", or remove required.');
      }
      return;
    }
    if (approval.required === undefined) {
      d.error('APR001', at, `Approval "${approval.key}" is a quorum but does not say how many must approve.`, 'Set required to 2 or more.');
      return;
    }
    const roles = approval.approvers.filter((p) => 'role' in p);
    const people = new Set(approval.approvers.filter((p) => !('role' in p)).map((p) => JSON.stringify(p))).size;
    if (!roles.length && people < approval.required) {
      d.error(
        'APR002',
        at,
        `Approval "${approval.key}" needs ${approval.required} people to approve but names only ${people}.`,
        'It could never be met, and every record would wait in this state for ever.',
      );
    } else if (roles.length && people < approval.required) {
      d.warn(
        'APR003',
        at,
        `Approval "${approval.key}" needs ${approval.required} different people; it depends on enough of them holding ${roles
          .map((p) => (p as { role: string }).role)
          .join(', ')}.`,
      );
    }
  };

  const checkAction = (action: Action, at: string, transition: Transition): void => {
    switch (action.do) {
      case 'set_reference': {
        const field = requireField(action.field, at, 'Generated reference');
        if (field && (field.setBy !== 'system' || field.type !== 'short_text')) {
          d.error('TYPE004', at, `Generated reference "${action.field}" must be a system-set short text field.`);
        }
        return;
      }
      case 'set_state':
        if (!stateByKey.has(action.state)) d.error('REF006', at, `Unknown state "${action.state}".`);
        return;
      case 'assign':
        checkParty(action.to, at, 'Assignment');
        return;
      case 'create_task': {
        const task = taskByKey.get(action.task);
        if (!task) d.error('REF006', at, `Unknown task "${action.task}".`);
        else checkParty(task.assignee, at, `Task "${task.key}" assignee`);
        return;
      }
      case 'request_approval': {
        const approval = approvalByKey.get(action.approval);
        if (!approval) {
          d.error('REF006', at, `Unknown approval "${action.approval}".`);
          return;
        }
        approval.approvers.forEach((party) => {
          checkParty(party, at, `Approval "${approval.key}" approver`);
          checkApprover(party, at, approval.key);
        });
        for (const key of approval.contextFields ?? []) requireField(key, at, `Approval "${approval.key}" context`);
        if (approval.mode === 'sequential' && approval.approvers.length < 2) {
          d.warn('OPS003', at, `Approval "${approval.key}" is sequential but has only one approver.`);
        }
        checkQuorum(approval, at);
        return;
      }
      case 'send_email': {
        const tpl = emailByKey.get(action.template);
        if (!tpl) {
          d.error('REF006', at, `Unknown email template "${action.template}".`);
          return;
        }
        tpl.to.forEach((p) => checkParty(p, at, `Template "${tpl.key}" recipient`));
        tpl.cc.forEach((p) => checkParty(p, at, `Template "${tpl.key}" cc`));
        if (tpl.replyTo) checkParty(tpl.replyTo, at, `Template "${tpl.key}" reply-to`);
        if (tpl.skipWhen) checkExpr(tpl.skipWhen, `${at}.skipWhen`);
        for (const key of tpl.attachments) {
          if (!docByKey.has(key)) d.error('REF011', at, `Template "${tpl.key}" attaches unknown document "${key}".`);
        }
        // Telling someone their own answers back is not a disclosure. Telling
        // a third party is, so the confidential check depends on who receives
        // the message rather than on the placeholder alone.
        const selfAddressedOnly =
          tpl.cc.length === 0 && tpl.to.length > 0 && tpl.to.every((p) => 'submitter' in p);

        for (const ph of [...placeholdersIn(tpl.subject), ...placeholdersIn(tpl.body)]) {
          if (ph === 'decision_reason') {
            if (!selfAddressedOnly || transition.trigger.on !== 'approval_decided' ||
              transition.trigger.decision === 'approved') {
              d.error('SEC014', at, `Template "${tpl.key}" may include the decision reason only in a rejection or changes-requested email to the submitter alone.`);
            }
            continue;
          }
          const f = requireField(ph, at, `Template "${tpl.key}"`);
          if (!f) continue;
          if (f.classification === 'restricted') {
            d.error(
              'SEC002',
              at,
              `Template "${tpl.key}" puts restricted field "${ph}" into an email body.`,
              'Restricted values must not leave the platform in a message, even to the person they describe.',
            );
          } else if (f.classification === 'confidential' && !selfAddressedOnly) {
            d.warn(
              'SEC002',
              at,
              `Template "${tpl.key}" sends confidential field "${ph}" to someone other than the person it describes.`,
              'Confirm the recipient is entitled to see it, or reference the record instead of inlining the value.',
            );
          }
        }
        if (tpl.class === 'marketing') {
          d.warn('OPS004', at, `Template "${tpl.key}" is marketing class, which is out of scope for MVP.`);
        }
        return;
      }
      case 'generate_document': {
        const doc = docByKey.get(action.document);
        if (!doc) {
          d.error('REF006', at, `Unknown document "${action.document}".`);
          return;
        }
        for (const [placeholder, key] of Object.entries(doc.mapping)) {
          requireField(key, at, `Document "${doc.key}" placeholder "${placeholder}"`);
        }
        return;
      }
      case 'call_webhook':
        for (const key of action.includeFields) {
          const f = requireField(key, at, 'Webhook payload');
          if (f?.classification === 'restricted') {
            d.error('SEC003', at, `Webhook "${action.event}" would send restricted field "${key}" off-platform.`);
          }
        }
        if (!bp.outputs.webhookEvents.includes(action.event)) {
          d.warn(
            'REF013',
            at,
            `Webhook event "${action.event}" is not declared in outputs.webhookEvents.`,
            'Consumers subscribe to the declared list, so an undeclared event is invisible to them.',
          );
        }
        return;
      case 'wait':
        return;
    }
  };

  const seenActionKeys = new Set<string>();
  for (const [ti, t] of bp.workflow.transitions.entries()) {
    const at = `workflow.transitions[${ti}]`;
    if (!stateByKey.has(t.from)) d.error('REF005', at, `Transition "${t.key}" leaves unknown state "${t.from}".`);
    if (!stateByKey.has(t.to)) d.error('REF005', at, `Transition "${t.key}" enters unknown state "${t.to}".`);
    if (t.when) checkExpr(t.when, `${at}.when`);

    const from = stateByKey.get(t.from);
    if (from?.type === 'terminal') {
      d.error(
        'FLOW004',
        at,
        `Transition "${t.key}" leaves terminal state "${t.from}".`,
        'A finished record must stay finished; add a separate state if it can reopen.',
      );
    }
    if (t.trigger.on === 'submission' && from && from.type !== 'initial') {
      d.error('FLOW009', at, `Submission transition "${t.key}" must leave the initial state.`);
    }
    if (t.trigger.on === 'approval_decided' && !approvalByKey.has(t.trigger.approval)) {
      d.error('REF007', at, `Trigger refers to unknown approval "${t.trigger.approval}".`);
    }
    if (t.trigger.on === 'task_completed' && !taskByKey.has(t.trigger.task)) {
      d.error('REF007', at, `Trigger refers to unknown task "${t.trigger.task}".`);
    }
    if (t.trigger.on === 'tasks_completed') {
      for (const key of t.trigger.tasks) {
        if (!taskByKey.has(key)) d.error('REF007', at, `Join refers to unknown task "${key}".`);
      }
      // A set with a repeat is a join of fewer tasks than it appears to be,
      // and it would satisfy itself early if the runtime counted rows rather
      // than distinct keys. It counts distinct keys; this is still a mistake
      // worth naming rather than silently tolerating.
      if (new Set(t.trigger.tasks).size !== t.trigger.tasks.length) {
        d.error('BLOCK005', at, `Join "${t.key}" names the same task more than once.`);
      }
    }
    /*
     * A timer is measured one way or the other, never both and never neither.
     *
     * The schema cannot say this — a discriminated union member carries no
     * refinement — so it is said here, which is where this codebase says that
     * sort of thing anyway.
     */
    if (t.trigger.on === 'timer') {
      const byState = typeof t.trigger.afterHoursInState === 'number';
      const byDate = Boolean(t.trigger.relativeTo);

      if (byState && byDate) {
        d.error(
          'TIME001',
          at,
          `Timer "${t.key}" is measured both from the state and from "${t.trigger.relativeTo}".`,
          'Pick one. Two clocks on one deadline is two different days.',
        );
      } else if (!byState && !byDate) {
        d.error(
          'TIME001',
          at,
          `Timer "${t.key}" says neither how long after arriving nor what date it hangs off.`,
          'Set afterHoursInState, or relativeTo with offsetHours.',
        );
      }

      if (byDate) {
        const field = fieldByKey.get(t.trigger.relativeTo!);
        if (!field) {
          d.error('REF015', at, `Timer "${t.key}" hangs off "${t.trigger.relativeTo}", which is not a field.`);
        } else if (field.type !== 'date') {
          d.error(
            'REF015',
            at,
            `Timer "${t.key}" hangs off "${t.trigger.relativeTo}", which is a ${field.type}.`,
            'A deadline needs a date to measure from.',
          );
        } else if (!field.required && (field.setBy ?? 'respondent') === 'respondent') {
          /*
           * A warning rather than an error. A timer on an optional date does
           * not fire until somebody fills the date in, which is correct
           * behaviour and sometimes exactly what was wanted — but it is also
           * how a deadline silently never happens, so it is said out loud.
           */
          d.warn(
            'TIME002',
            at,
            `Timer "${t.key}" hangs off "${t.trigger.relativeTo}", which the respondent may leave blank.`,
            'Until somebody fills it in there is no deadline. Make the field required if the deadline is not optional.',
          );
        }
        if (typeof t.trigger.offsetHours !== 'number') {
          d.error(
            'TIME001',
            at,
            `Timer "${t.key}" hangs off a date and does not say how far from it.`,
            'Set offsetHours — negative for before the date, positive for after.',
          );
        }
      }
    }
    if (t.trigger.on === 'manual') {
      for (const roleKey of t.trigger.by) {
        if (!roleByKey.has(roleKey)) d.error('REF007', at, `Manual trigger refers to unknown role "${roleKey}".`);
      }
    }
    if (t.from === t.to && t.trigger.on !== 'timer' && t.trigger.on !== 'manual' && !t.when) {
      d.error(
        'FLOW007',
        at,
        `Transition "${t.key}" loops "${t.from}" onto itself with no condition.`,
        'This would re-fire its actions forever. Add a condition, a timer, or a different target state.',
      );
    }

    for (const [ai, action] of t.actions.entries()) {
      const aat = `${at}.actions[${ai}]`;
      const composite = `${t.key}.${action.key}`;
      if (seenActionKeys.has(composite)) {
        d.error(
          'OPS001',
          aat,
          `Duplicate action key "${action.key}" in transition "${t.key}".`,
          'Action keys form the idempotency key, so two actions sharing one would collapse into a single run.',
        );
      }
      seenActionKeys.add(composite);
      checkAction(action, aat, t);
    }
  }

  // An unguarded submission transition always matches, so a second one beside
  // it makes the route depend on declaration order. Guards that merely might
  // overlap cannot be proved apart without a solver, and are left alone.
  const submissions = bp.workflow.transitions.filter((t) => t.trigger.on === 'submission');
  if (submissions.length > 1) {
    const unguarded = submissions.filter((t) => !t.when);
    if (unguarded.length) {
      d.error(
        'FLOW011',
        'workflow.transitions',
        `Submission transition "${unguarded[0]!.key}" has no condition but competes with ${
          submissions.length - 1
        } other submission transition(s).`,
        'An unconditional route always matches, so which one runs would depend on declaration order. Give it a condition.',
      );
    }
  }

  // ------------------------------------------------------- reachability walk
  const start = initial[0];
  if (start) {
    const reachable = new Set<string>([start.key]);
    const queue = [start.key];
    while (queue.length) {
      const current = queue.shift()!;
      for (const t of outgoing.get(current) ?? []) {
        if (!reachable.has(t.to) && stateByKey.has(t.to)) {
          reachable.add(t.to);
          queue.push(t.to);
        }
      }
    }
    for (const [si, state] of bp.workflow.states.entries()) {
      if (!reachable.has(state.key)) {
        d.error('FLOW003', `workflow.states[${si}]`, `State "${state.key}" cannot be reached from "${start.key}".`);
      }
    }
    if (completion && !reachable.has(completion.key)) {
      d.error('FLOW006', 'intent.completionState', `No path reaches the completion state "${completion.key}".`);
    }
  }

  for (const [si, state] of bp.workflow.states.entries()) {
    const exits = outgoing.get(state.key) ?? [];
    if (state.type !== 'terminal' && !exits.length) {
      d.error(
        'FLOW005',
        `workflow.states[${si}]`,
        `State "${state.key}" has no way out and is not terminal, so records will stall there permanently.`,
      );
    }
    if (state.slaHours && !exits.some((t) => t.trigger.on === 'timer')) {
      d.warn(
        'OPS006',
        `workflow.states[${si}]`,
        `State "${state.key}" declares an SLA of ${state.slaHours}h but nothing fires when it passes.`,
        'Add a timer transition to remind, escalate, or expire.',
      );
    }
    if (state.type === 'waiting') {
      const canUnblock = exits.some((t) =>
        ['approval_decided', 'task_completed', 'timer', 'manual', 'inbound_webhook', 'record_updated'].includes(
          t.trigger.on,
        ),
      );
      if (!canUnblock) {
        d.warn('FLOW010', `workflow.states[${si}]`, `Waiting state "${state.key}" has nothing that can release it.`);
      }
    }
  }

  // ------------------------------------------------------------ orphan check
  const used = {
    approvals: new Set<string>(),
    tasks: new Set<string>(),
    emails: new Set<string>(),
    docs: new Set<string>(),
  };
  for (const t of bp.workflow.transitions) {
    for (const a of t.actions) {
      if (a.do === 'request_approval') used.approvals.add(a.approval);
      if (a.do === 'create_task') used.tasks.add(a.task);
      if (a.do === 'send_email') used.emails.add(a.template);
      if (a.do === 'generate_document') used.docs.add(a.document);
    }
  }
  for (const tpl of bp.communications.email) for (const doc of tpl.attachments) used.docs.add(doc);

  // A blocking task only blocks if something waits for it. A task created and
  // then never awaited is a control that looks present in review and does
  // nothing at runtime, which is worse than not having it.
  const awaited = new Set<string>();
  for (const t of bp.workflow.transitions) {
    if (t.trigger.on === 'task_completed') awaited.add(t.trigger.task);
    if (t.trigger.on === 'tasks_completed') for (const k of t.trigger.tasks) awaited.add(k);
  }
  for (const [i, task] of bp.workflow.tasks.entries()) {
    if (!used.tasks.has(task.key)) continue;
    for (const key of task.requiredFields) {
      const at = `workflow.tasks[${i}].requiredFields`;
      const field = requireField(key, at, `Task "${task.key}" completion`);
      if (!field) continue;
      if (field.setBy !== 'operator' || !['short_text', 'long_text'].includes(field.type)) {
        d.error('TASK001', at, `Task "${task.key}" requires "${key}", which must be an operator text field.`);
      }
      if ('role' in task.assignee) {
        const role = roleByKey.get(task.assignee.role);
        if (role && (!role.capabilities.includes('edit') || !role.editableFields?.includes(key))) {
          d.error('TASK002', at, `Task "${task.key}" requires "${key}", but ${role.name} cannot edit it.`);
        }
      }
    }
    if (task.blocking && !awaited.has(task.key)) {
      d.error(
        'BLOCK001',
        `workflow.tasks[${i}]`,
        `Task "${task.key}" is marked blocking, but no transition waits for it to be completed.`,
        'Add a transition triggered by its completion, or mark the task non-blocking so the process does not claim a control it has not got.',
      );
    }
  }
  const declaredTasks = new Set(bp.workflow.tasks.map((t) => t.key));

  for (const [ti, t] of bp.workflow.transitions.entries()) {
    const waitsFor =
      t.trigger.on === 'task_completed'
        ? [t.trigger.task]
        : t.trigger.on === 'tasks_completed'
          ? t.trigger.tasks
          : [];
    if (!waitsFor.length) continue;

    for (const key of waitsFor) {
      // REF007 above already reports a task the workflow does not define.
      if (!declaredTasks.has(key)) continue;
      if (!used.tasks.has(key)) {
        d.error(
          'BLOCK002',
          `workflow.transitions[${ti}]`,
          `Transition "${t.key}" waits for task "${key}", which no transition ever creates.`,
          'The record would wait forever for a task that never appears.',
        );
      }
    }

    /*
     * A join must name every blocking task that can be open in the state it
     * leaves — otherwise the record completes with work outstanding, which is
     * the one thing naming the set costs you over inferring it.
     *
     * "Can be open here" is read as: created by a transition that arrives at
     * this state, or by a transition that loops within it. That is a
     * structural reading and not a reachability proof, which is the right
     * trade — it is cheap, it has no false negatives for the fan-out shape
     * this exists for, and a false positive is fixed by naming the task.
     */
    if (t.trigger.on !== 'tasks_completed') continue;
    const named = new Set(t.trigger.tasks);
    const arrivingHere = bp.workflow.transitions.filter((o) => o.to === t.from);
    for (const other of arrivingHere) {
      for (const a of other.actions) {
        if (a.do !== 'create_task' || named.has(a.task)) continue;
        const task = bp.workflow.tasks.find((x) => x.key === a.task);
        if (!task?.blocking) continue;
        d.error(
          'BLOCK003',
          `workflow.transitions[${ti}]`,
          `Transition "${t.key}" joins ${t.trigger.tasks.length} tasks, but "${a.task}" is also created in "${t.from}" and blocks.`,
          `Add "${a.task}" to the join, or mark it non-blocking if the record may genuinely leave without it.`,
        );
      }
    }
  }

  // "The current assignee" is only a real address if something assigns the
  // record. Without an assign action the message has nowhere to go, and a
  // reminder that silently reaches nobody is the worst kind of reminder.
  const assignsSomewhere = bp.workflow.transitions.some((t) => t.actions.some((a) => a.do === 'assign'));
  if (!assignsSomewhere) {
    for (const tpl of bp.communications.email) {
      const addressed = [...tpl.to, ...tpl.cc].some((p) => 'assignee' in p);
      if (addressed) {
        d.error(
          'ASSIGN001',
          `communications.email`,
          `Template "${tpl.key}" is addressed to the current assignee, but no transition ever assigns the record.`,
          'Assign the record before sending, or address the message to a role or an email field.',
        );
      }
    }
    for (const [i, task] of bp.workflow.tasks.entries()) {
      if ('assignee' in task.assignee) {
        d.error(
          'ASSIGN001',
          `workflow.tasks[${i}]`,
          `Task "${task.key}" is assigned to the current assignee, but no transition ever assigns the record.`,
        );
      }
    }
  }

  orphans(d, bp.workflow.approvals, used.approvals, 'workflow.approvals', 'Approval');
  orphans(d, bp.workflow.tasks, used.tasks, 'workflow.tasks', 'Task');
  orphans(d, bp.communications.email, used.emails, 'communications.email', 'Email template');
  orphans(d, bp.outputs.documents, used.docs, 'outputs.documents', 'Document');

  // ----------------------------------------------------------------- outputs
  for (const [mi, metric] of bp.outputs.dashboard.metrics.entries()) {
    if (metric.state && !stateByKey.has(metric.state)) {
      d.error('REF013', `outputs.dashboard.metrics[${mi}]`, `Metric refers to unknown state "${metric.state}".`);
    }
  }
  if (!bp.outputs.dashboard.metrics.some((m) => m.kind === 'completion_rate')) {
    d.warn(
      'OPS005',
      'outputs.dashboard',
      'No completion-rate metric, so the dashboard cannot show whether the process is working.',
    );
  }
  for (const key of bp.outputs.exportFields) {
    const f = requireField(key, 'outputs.exportFields', 'Export');
    if (f && DATA_CLASS_RANK[f.classification] >= DATA_CLASS_RANK.confidential) {
      d.warn('SEC004', 'outputs.exportFields', `Export includes ${f.classification} field "${key}".`);
    }
  }

  // ------------------------------------------------------------------- tests
  const kinds = new Set(bp.tests.map((t) => t.kind));
  for (const kind of REQUIRED_TEST_KINDS) {
    if (!kinds.has(kind)) {
      d.error(
        'TEST001',
        'tests',
        `No "${kind}" scenario.`,
        'Section 7.2 requires all six scenario kinds before a version can be published.',
      );
    }
  }
  for (const [ti, test] of bp.tests.entries()) {
    const at = `tests[${ti}]`;
    for (const step of test.steps) {
      if (step.step === 'decide') {
        if (!approvalByKey.has(step.approval)) d.error('TEST002', at, `Unknown approval "${step.approval}".`);
        if (!roleByKey.has(step.as)) d.error('TEST002', at, `Unknown role "${step.as}".`);
      }
      if (step.step === 'complete_task') {
        const task = taskByKey.get(step.task);
        const role = roleByKey.get(step.as);
        if (!task) d.error('TEST002', at, `Unknown task "${step.task}".`);
        if (!role) d.error('TEST002', at, `Unknown role "${step.as}".`);
        // Scenario actors receive only a workspace operator grant. Supplying
        // task answers also needs process-level edit rights for every field.
        // Checking this before the expensive scenario run gives AI a precise
        // permission error instead of a cascade of unopened-task failures.
        const answers = Object.keys(step.answers ?? {});
        if (!step.expectDenied && answers.length) {
          if (task) for (const key of answers) {
            if (!task.requiredFields.includes(key)) {
              d.error('TEST004', at, `Task "${task.key}" cannot collect "${key}" in this scenario.`,
                `Add "${key}" to the task's requiredFields or remove it from the scenario answer.`);
            }
          }
          if (role && (!role.capabilities.includes('edit') || answers.some((key) => !role.editableFields?.includes(key)))) {
            d.error('TEST004', at, `Role "${role.key}" cannot edit the answers supplied when completing task "${step.task}".`,
              `Grant the role edit and list ${answers.join(', ')} in its editableFields, or have the task collect no answers.`);
          }
        }
      }
      if (step.step === 'manual') {
        const transition = bp.workflow.transitions.find((item) => item.key === step.transition);
        if (!transition || transition.trigger.on !== 'manual') d.error('TEST002', at, `Unknown manual step "${step.transition}".`);
        if (!roleByKey.has(step.as)) d.error('TEST002', at, `Unknown role "${step.as}".`);
      }
      if (step.step === 'attempt' && !roleByKey.has(step.as)) {
        d.error('TEST002', at, `Unknown role "${step.as}".`);
      }
      if (step.step === 'submit') {
        for (const key of Object.keys(step.answers)) requireField(key, at, 'Test answer');
      }
    }
    if (test.expect.state && !stateByKey.has(test.expect.state)) {
      d.error('TEST003', at, `Expects unknown state "${test.expect.state}".`);
    }
    for (const key of test.expect.emails ?? []) {
      if (!emailByKey.has(key)) d.error('TEST003', at, `Expects unknown email template "${key}".`);
    }
    for (const key of test.expect.documents ?? []) {
      if (!docByKey.has(key)) d.error('TEST003', at, `Expects unknown document "${key}".`);
    }
    for (const key of test.expect.openTasks ?? []) {
      if (!taskByKey.has(key)) d.error('TEST003', at, `Expects unknown task "${key}".`);
    }
  }

  return d;
}

// -------------------------------------------------------------------- helpers

function duplicateKeys(d: Diagnostics, items: { key: string }[], at: string, what: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) d.error('REF001', at, `Duplicate ${what} key "${item.key}".`);
    seen.add(item.key);
  }
}

function orphans(
  d: Diagnostics,
  items: { key: string }[],
  used: Set<string>,
  at: string,
  what: string,
): void {
  for (const item of items) {
    if (!used.has(item.key)) {
      d.warn(
        'OPS002',
        at,
        `${what} "${item.key}" is defined but never used by any transition.`,
        'Remove it, or wire it into the workflow.',
      );
    }
  }
}

/** Numeric and date comparisons against a text field are almost always a generation bug. */
function typeCheckExpr(d: Diagnostics, expr: Expr, at: string, fields: Map<string, Field>): void {
  type OperandKind = ValueKind | 'literal_text' | 'literal_number' | 'literal_boolean' | 'unknown';

  const kindOfOperand = (o: unknown): OperandKind => {
    if (typeof o !== 'object' || o === null) return 'unknown';
    if ('field' in o) {
      const f = fields.get((o as { field: string }).field);
      return f ? VALUE_KIND[f.type] : 'unknown';
    }
    if ('literal' in o) {
      const v = (o as { literal: unknown }).literal;
      if (typeof v === 'number') return 'literal_number';
      if (typeof v === 'boolean') return 'literal_boolean';
      return 'literal_text';
    }
    return 'unknown';
  };

  const walk = (e: Expr): void => {
    if (e.op === 'and' || e.op === 'or') {
      e.operands.forEach(walk);
      return;
    }
    if (e.op === 'not') {
      walk(e.operand);
      return;
    }
    if (e.op === 'any' || e.op === 'all') {
      walk(e.where);
      return;
    }
    if (e.op === 'is_empty' || e.op === 'is_present') return;

    const left = kindOfOperand((e as { left: unknown }).left);

    if (e.op === 'gt' || e.op === 'gte' || e.op === 'lt' || e.op === 'lte') {
      const right = kindOfOperand(e.right);
      const ordered = new Set<OperandKind>(['number', 'date', 'time', 'literal_number']);
      for (const [side, kind] of [
        ['left', left],
        ['right', right],
      ] as const) {
        if (kind !== 'unknown' && !ordered.has(kind)) {
          d.error(
            'TYPE001',
            at,
            `Cannot use "${e.op}" on a ${kind.replace('literal_', '')} value (${side} side).`,
            'Ordered comparison needs a number, currency, rating, date, or time.',
          );
        }
      }
      if (left === 'date' && right === 'literal_number') {
        d.error('TYPE001', at, 'Comparing a date against a plain number.');
      }
    }

    if (e.op === 'eq' || e.op === 'ne') {
      const right = kindOfOperand(e.right);
      if (left === 'number' && right === 'literal_text') {
        d.error('TYPE001', at, 'Comparing a number field against a text value.');
      }
      if (left === 'boolean' && right === 'literal_text') {
        d.error('TYPE001', at, 'Comparing a yes/no field against a text value.');
      }
    }

    // A choice compared against a value that is not one of its options can
    // never be true, which is a silent dead branch at runtime.
    const leftOperand = (e as { left?: unknown }).left;
    if (leftOperand && typeof leftOperand === 'object' && 'field' in leftOperand) {
      const f = fields.get((leftOperand as { field: string }).field);
      if (f?.choices?.length) {
        const rights: unknown[] =
          e.op === 'in' || e.op === 'not_in' ? e.right : [(e as { right: unknown }).right];
        for (const r of rights) {
          if (r && typeof r === 'object' && 'literal' in r) {
            const v = (r as { literal: unknown }).literal;
            if (typeof v === 'string' && !f.choices.some((c) => c.value === v)) {
              d.error(
                'TYPE002',
                at,
                `"${v}" is not an option of choice field "${f.key}" (options: ${f.choices
                  .map((c) => c.value)
                  .join(', ')}).`,
              );
            }
          }
        }
      }
    }
  };

  walk(expr);
}

/** Calculated fields that depend on each other in a ring can never be evaluated. */
function detectCalcCycles(d: Diagnostics, all: { path: string; field: Field }[]): void {
  const deps = new Map<string, string[]>();
  for (const { field } of all) {
    if (field.type === 'calculated' && field.compute) deps.set(field.key, fieldsInCalc(field.compute));
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string, trail: string[]): void => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') {
      d.error(
        'TYPE005',
        'data.fields',
        `Calculated fields form a cycle: ${[...trail.slice(trail.indexOf(key)), key].join(' -> ')}.`,
      );
      return;
    }
    state.set(key, 'visiting');
    for (const next of deps.get(key) ?? []) {
      if (deps.has(next)) visit(next, [...trail, key]);
    }
    state.set(key, 'done');
  };
  for (const key of deps.keys()) visit(key, []);
}
