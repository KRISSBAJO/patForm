/**
 * Turning stored values into something a person reads.
 *
 * All of this is display only. Every one of these values is stored as what it
 * is — a boolean, a role key, an ISO date — and that is right: a record's data
 * should not carry the words an English-speaking console happens to use. The
 * translation belongs here, at the edge.
 */

/**
 * Who a task is assigned to.
 *
 * The runtime stores `role:hr_admin`, which is a correct assignment and not a
 * sentence. The role key is kept rather than prettified into "HR Admin",
 * because that is a name this page would be inventing — the key is what the
 * process actually says.
 */
export function who(assignee: string | null | undefined): string {
  if (!assignee) return 'nobody yet';
  if (assignee.startsWith('role:')) return `the ${assignee.slice(5)} role`;
  if (assignee.startsWith('user:')) return assignee.slice(5);
  if (assignee.startsWith('actor:')) return assignee.slice(6);
  return assignee;
}

/**
 * One answer, as the person who gave it would recognise it.
 *
 * A yes/no field stores a boolean and was rendering as `true`. A list stores
 * an array and was rendering with commas already, which is right.
 */
export function answer(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    const parts = value.map((v) => answer(v)).filter((v): v is string => v !== null);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
