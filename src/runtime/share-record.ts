import { recordDetail } from './console-queries.js';
import type { Pool } from './db.js';
import { appUrl, sendPlatformMail } from './platform-mail.js';
import { AuthorizationError, type Principal } from './policy.js';

/**
 * Sending a record to a colleague.
 *
 * "Can you look at this one" is the commonest thing said about a record, and
 * it was said outside the system: a screenshot, a forwarded acknowledgement,
 * a reference typed into a chat. This sends the record itself, by email,
 * with a note, and it is built to be safe to use casually:
 *
 * - **Only to a member of this workspace.** An address is not typed; a
 *   person is chosen. Personal data does not leave the tenancy by this door.
 * - **As the recipient may see it.** The answers in the mail are rendered
 *   under the *recipient's* roles, not the sender's, so forwarding cannot
 *   hand somebody a field their own role hides. A recipient who cannot open
 *   the record at all is refused, and the sender is told why.
 * - **On the record.** The send is an event in the record's history, with
 *   who sent it to whom, the same as an export.
 */
export interface ShareResult {
  to: string;
  sent: boolean;
  reason?: string;
}

export async function shareRecord(
  pool: Pool,
  args: { principal: Principal; instanceId: string; recipientActorId: string; note?: string },
): Promise<ShareResult> {
  const me = args.principal;
  if (me.kind !== 'actor') throw new Error('a record is sent by a signed-in member');
  const tenantId = me.tenantId;

  // The sender's own right to the record, checked first: no reading it on
  // somebody else's behalf.
  const mine = await recordDetail(pool, args.principal, args.instanceId);

  const { rows: people } = await pool.query<{ id: string; email: string; display_name: string; active: boolean }>(
    'select id, email, display_name, active from actor where tenant_id = $1 and id = any($2::uuid[])',
    [tenantId, [args.recipientActorId, me.actorId]],
  );
  const recipient = people.find((p) => p.id === args.recipientActorId);
  const sender = people.find((p) => p.id === me.actorId);
  if (!recipient || !recipient.active) throw new Error('choose a current member of this workspace');
  if (recipient.id === me.actorId) throw new Error('that is you');

  // What the recipient will read is what the recipient may read.
  let theirs: Awaited<ReturnType<typeof recordDetail>>;
  try {
    theirs = await recordDetail(pool, { kind: 'actor', tenantId, actorId: recipient.id }, args.instanceId);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      throw new Error(`${recipient.display_name} cannot open this record, so it was not sent. Give them a role on ${mine.processName} first.`);
    }
    throw err;
  }

  const note = (args.note ?? '').trim().slice(0, 2000);
  const by = sender?.display_name ?? 'A colleague';
  const lines = theirs.fields
    .filter((f) => f.value !== null && f.value !== undefined && f.value !== '' && f.value !== '[redacted]')
    .map((f) => `  ${f.label}: ${f.text ?? (typeof f.value === 'object' ? '(see the record)' : String(f.value))}`);
  const hidden = theirs.fields.length - lines.length;
  const link = `${appUrl()}/console?record=${args.instanceId}`;

  const text = [
    `${by} sent you ${theirs.processName} record ${theirs.reference}.`,
    ...(note ? ['', `"${note}"`] : []),
    '',
    `Open it: ${link}`,
    '',
    `Stage: ${theirs.stateName}`,
    ...(lines.length ? ['', 'What it says:', ...lines] : []),
    ...(hidden > 0 ? ['', `${hidden} ${hidden === 1 ? 'field is' : 'fields are'} not shown to your role.`] : []),
  ].join('\n');

  const now = new Date();
  const result = await sendPlatformMail(pool, {
    kind: 'record_shared',
    to: recipient.email,
    subject: `${by} sent you ${theirs.processName} ${theirs.reference}`,
    text,
    tenantId,
    actorId: me.actorId,
    idempotencyKey: `record-shared:${args.instanceId}:${recipient.id}:${now.getTime()}`,
  });
  const sent = Boolean(result && result.status !== 'failed');

  await pool.query(
    `insert into event (tenant_id, instance_id, seq, type, payload, actor, occurred_at)
     values ($1, $2, (select coalesce(max(seq), 0) + 1 from event where instance_id = $2), 'record_shared', $3, $4, $5)`,
    [tenantId, args.instanceId, JSON.stringify({ to: recipient.email, toName: recipient.display_name, note: note || null, sent }), `actor:${me.actorId}`, now],
  );

  return sent
    ? { to: recipient.email, sent: true }
    : { to: recipient.email, sent: false, reason: result?.detail ?? 'the email provider refused it' };
}
