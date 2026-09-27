export interface GuidedRule { key: string; from: string; to: string; trigger: Record<string, unknown>; actions: Record<string, unknown>[]; }
export function ruleProblems(rule: GuidedRule, states: { key: string; type: string }[], existing: GuidedRule[]): string[] {
  const problems: string[] = [];
  const source = states.find(s => s.key === rule.from);
  if (!source) problems.push('Choose a starting status.');
  if (!states.some(s => s.key === rule.to)) problems.push('Choose a next status.');
  if (source?.type === 'terminal') problems.push('Finished records cannot start an automation. Choose a status before final closure.');
  if (rule.trigger.on === 'submission' && source?.type !== 'initial') problems.push('Form submitted is available only from the initial status.');
  if (rule.trigger.on === 'manual' && (!Array.isArray(rule.trigger.by) || !rule.trigger.by.length)) problems.push('Choose at least one role authorized to use this action.');
  if (rule.trigger.on === 'timer' && (!Number.isFinite(Number(rule.trigger.afterHoursInState)) || Number(rule.trigger.afterHoursInState) <= 0)) problems.push('Set a positive reminder delay.');
  if (rule.trigger.on === 'timer' && existing.some(t => t.from === rule.from && t.trigger.on === 'timer')) problems.push('This status already has a timer. Edit its existing reminder instead.');
  if (existing.some(t => t.from === rule.from && t.to === rule.to && JSON.stringify(t.trigger) === JSON.stringify(rule.trigger) && !('when' in t))) problems.push('A rule with this route and trigger already exists. Review the existing rule first.');
  const triggerReference = ({approval_decided:'approval',task_completed:'task',inbound_webhook:'event'} as Record<string,string>)[String(rule.trigger.on)];
  if (triggerReference && !rule.trigger[triggerReference]) problems.push(`Choose the ${triggerReference} that starts this rule.`);
  if (rule.trigger.on === 'tasks_completed' && (!Array.isArray(rule.trigger.tasks) || rule.trigger.tasks.length < 2)) problems.push('Choose at least two tasks to wait for.');
  const actionKeys = rule.actions.map(action => action.key).filter(Boolean);
  if (new Set(actionKeys).size !== actionKeys.length) problems.push('Give each additional action a distinct key.');
  for (const action of rule.actions) {
    const required = ({send_email:'template',request_approval:'approval',create_task:'task',generate_document:'document',set_reference:'field',set_state:'state',call_webhook:'event'} as Record<string,string>)[String(action.do)];
    if (required && !action[required]) problems.push(`Choose the ${required} for this action.`);
  }
  return [...new Set(problems)];
}
