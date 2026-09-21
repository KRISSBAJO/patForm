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

  const checkExpr = (expr: Expr, at: string): void => {
    for (const key of fieldsInExpr(expr)) requireField(key, at, 'Condition');
    typeCheckExpr(d, expr, at, fieldByKey);
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
    // Nested fields live inside their group, and hidden or calculated fields
    // are never rendered, so none of these need a place on a page.
    const nested = path.includes('.');
    if (nested || field.type === 'hidden' || field.type === 'calculated') continue;
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
  if (bp.workflow.approvals.length && !bp.roles.some((r) => r.capabilities.includes('approve'))) {
    d.error('SEC005', 'roles', 'The process has approvals but no role may approve.');
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

  const checkAction = (action: Action, at: string): void => {
    switch (action.do) {
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
        approval.approvers.forEach((p) => checkParty(p, at, `Approval "${approval.key}" approver`));
        for (const key of approval.contextFields ?? []) requireField(key, at, `Approval "${approval.key}" context`);
        if (approval.mode === 'sequential' && approval.approvers.length < 2) {
          d.warn('OPS003', at, `Approval "${approval.key}" is sequential but has only one approver.`);
        }
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
      checkAction(action, aat);
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
  const awaited = new Set(
    bp.workflow.transitions
      .filter((t) => t.trigger.on === 'task_completed')
      .map((t) => (t.trigger as { task: string }).task),
  );
  for (const [i, task] of bp.workflow.tasks.entries()) {
    if (!used.tasks.has(task.key)) continue;
    if (task.blocking && !awaited.has(task.key)) {
      d.error(
        'BLOCK001',
        `workflow.tasks[${i}]`,
        `Task "${task.key}" is marked blocking, but no transition waits for it to be completed.`,
        'Add a transition triggered by its completion, or mark the task non-blocking so the process does not claim a control it has not got.',
      );
    }
  }
  for (const [ti, t] of bp.workflow.transitions.entries()) {
    if (t.trigger.on !== 'task_completed') continue;
    if (!used.tasks.has(t.trigger.task)) {
      d.error(
        'BLOCK002',
        `workflow.transitions[${ti}]`,
        `Transition "${t.key}" waits for task "${t.trigger.task}", which no transition ever creates.`,
        'The record would wait forever for a task that never appears.',
      );
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
        if (!taskByKey.has(step.task)) d.error('TEST002', at, `Unknown task "${step.task}".`);
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
