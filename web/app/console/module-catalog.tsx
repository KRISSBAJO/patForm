import { MODULE_AREAS } from './module-shell';

const formsIcon = <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>;

/** Every module stays discoverable, including those this workspace has not switched on. */
export const CONSOLE_MODULES = [
  { id: 'assets', enabledBy: 'assets', view: 'operations', name: MODULE_AREAS.operations.name, blurb: MODULE_AREAS.operations.blurb, area: MODULE_AREAS.operations },
  { id: 'compliance', enabledBy: 'contracts', view: 'compliance', name: MODULE_AREAS.compliance.name, blurb: MODULE_AREAS.compliance.blurb, area: MODULE_AREAS.compliance },
  { id: 'expenses', enabledBy: 'expenses', view: 'expenses', name: MODULE_AREAS.expenses.name, blurb: MODULE_AREAS.expenses.blurb, area: MODULE_AREAS.expenses },
  { id: 'forms', enabledBy: 'platform', view: 'work', name: 'Forms & workflow', blurb: 'My work, forms, records and processes', area: { colour: '#176941', deep: '#104e31', tint: '#e9f3eb', icon: formsIcon } },
  { id: 'appraisals', enabledBy: 'appraisals', view: 'appraisals', name: MODULE_AREAS.appraisals.name, blurb: MODULE_AREAS.appraisals.blurb, area: MODULE_AREAS.appraisals },
  { id: 'hr', enabledBy: 'hr', view: 'hr', name: MODULE_AREAS.hr.name, blurb: MODULE_AREAS.hr.blurb, area: MODULE_AREAS.hr },
  { id: 'attendance', enabledBy: 'attendance', view: 'attendance', name: MODULE_AREAS.attendance.name, blurb: MODULE_AREAS.attendance.blurb, area: MODULE_AREAS.attendance },
  { id: 'meetings', enabledBy: 'meetings', view: 'meetings', name: MODULE_AREAS.meetings.name, blurb: MODULE_AREAS.meetings.blurb, area: MODULE_AREAS.meetings },
  { id: 'general_approvals', enabledBy: 'general_approvals', view: 'general_approvals', name: MODULE_AREAS.general_approvals.name, blurb: MODULE_AREAS.general_approvals.blurb, area: MODULE_AREAS.general_approvals },
  { id: 'procurement', enabledBy: 'procurement', view: 'procurement', name: MODULE_AREAS.procurement.name, blurb: MODULE_AREAS.procurement.blurb, area: MODULE_AREAS.procurement },
  { id: 'sign', enabledBy: 'contracts', view: 'sign', name: MODULE_AREAS.sign.name, blurb: MODULE_AREAS.sign.blurb, area: MODULE_AREAS.sign },
] as const;

export type ConsoleModule = (typeof CONSOLE_MODULES)[number];
export function moduleIsEnabled(module: ConsoleModule, enabled: string[]) {
  return module.enabledBy === 'platform' || enabled.includes(module.enabledBy);
}
