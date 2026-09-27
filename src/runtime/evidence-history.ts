import type { Blueprint, Field } from '../blueprint/index.js';
import { redact, type WorkspaceRole } from './policy.js';

const FILE_REFERENCE = /^receipt-file:([0-9a-f-]{36})$/;

type ChangeEvent = { type: string; payload: unknown; occurred_at: Date | string };

/** Earlier file answers are reconstructed from immutable task update events. */
export function earlierEvidence(
  blueprint: Blueprint,
  roles: string[],
  workspaceRole: WorkspaceRole | undefined,
  current: Record<string, unknown>,
  events: ChangeEvent[],
) {
  const currentIds = new Set<string>();
  const collect = (fields: Field[], values: Record<string, unknown>, at: string, into: { id: string; field: string; row: number | null }[]) => {
    for (const field of fields) {
      const value = values[field.key];
      if (value === '[redacted]') continue;
      if (field.type === 'repeating_group' && Array.isArray(value)) {
        value.forEach((row, index) => {
          if (row && typeof row === 'object' && !Array.isArray(row)) {
            const nested = collect(field.fields ?? [], row as Record<string, unknown>, `${at}${field.label} / `, []);
            nested.forEach((item) => into.push({ ...item, row: index + 1 }));
          }
        });
      } else if (field.type === 'file') {
        for (const ref of Array.isArray(value) ? value : [value]) {
          const id = typeof ref === 'string' ? FILE_REFERENCE.exec(ref)?.[1] : undefined;
          if (id) into.push({ id, field: `${at}${field.label}`, row: null });
        }
      }
    }
    return into;
  };
  const currentVisible = redact(blueprint, roles, current, workspaceRole);
  collect(blueprint.data.fields, currentVisible, '', []).forEach((item) => currentIds.add(item.id));
  const seen = new Set<string>();
  const history: { id: string; field: string; row: number | null; at: string; task: string | null }[] = [];
  for (const event of events) {
    if (event.type !== 'record_updated' || !event.payload || typeof event.payload !== 'object') continue;
    const payload = event.payload as { previous?: Record<string, unknown>; task?: string };
    if (!payload.previous || typeof payload.previous !== 'object') continue;
    const visible = redact(blueprint, roles, payload.previous, workspaceRole);
    for (const item of collect(blueprint.data.fields, visible, '', [])) {
      if (currentIds.has(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      history.push({ ...item, at: new Date(event.occurred_at).toISOString(), task: payload.task ?? null });
    }
  }
  return history;
}
