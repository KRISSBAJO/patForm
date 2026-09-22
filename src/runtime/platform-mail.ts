/**
 * Mail that belongs to an account rather than to a record.
 *
 * Invitations, email verification, password resets. Three messages, and the
 * only three the platform itself sends — everything else in this system is
 * sent *by a process*, on behalf of a tenant, as the effect of an action.
 *
 * That distinction is why this does not reuse `email_log`. That table requires
 * a non-null `instance_id` and a non-null `action_run_id`, which is what makes
 * "every process email is traceable to the action that sent it" a guarantee
 * rather than an aspiration. Making both nullable so these three could squeeze
 * in would have quietly turned that guarantee into a convention. They get
 * their own log instead, and the constraint stays worth having.
 *
 * What is shared is the provider: the same `EmailProvider` that sends process
 * mail sends this, so a suppressed run suppresses these too, and there is one
 * place where delivery can go wrong rather than two.
 */

import type { Pool, Client } from './db.js';
import { emailProviderFromEnv, mailFrom, type DeliveryResult } from './email.js';
import { logIfEnabled } from './trace.js';
import { blockedRecipients } from './delivery.js';

export type PlatformMailKind = 'invitation' | 'verify_email' | 'password_reset';

/**
 * Where the links point.
 *
 * A link to the wrong host is the failure mode here, and it is silent: the
 * email arrives, looks right, and the token cannot be spent. So this reads one
 * name, and the default is the dev console rather than anything plausible
 * enough to be mistaken for production.
 */
export function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3210').replace(/\/+$/, '');
}

export interface PlatformMail {
  kind: PlatformMailKind;
  to: string;
  subject: string;
  text: string;
  tenantId?: string | null;
  actorId?: string | null;
  /** Stable per-send, so a provider-side retry is deduplicated like any other. */
  idempotencyKey: string;
}

/**
 * Sends and logs, and never throws.
 *
 * Deliberate: every caller here is in the middle of something the user asked
 * for — creating a workspace, inviting a colleague — and a provider being down
 * is not a reason to fail that. The send is recorded as failed and the
 * operator can resend. The one thing that would be worse than an undelivered
 * invitation is a workspace that half exists because the invitation failed.
 */
export async function sendPlatformMail(pool: Pool, mail: PlatformMail): Promise<DeliveryResult | null> {
  /*
   * An address the provider has told us not to write to.
   *
   * Recorded as `skipped` rather than silently dropped, because the operator
   * looking at an invitation that never arrived needs to see why. This also
   * means a reset link is never sent to a hard-bounced address — which is
   * correct, and is the reason the reset endpoint answers identically whether
   * or not anything was sent: the caller must not learn that either.
   */
  const blocked = await blockedRecipients(pool, [mail.to]);
  if (blocked.size) {
    const reason = blocked.get(mail.to.trim().toLowerCase())!;
    await pool.query(
      `insert into platform_email
         (tenant_id, actor_id, kind, recipient, subject, status, provider, failure)
       values ($1, $2, $3, $4, $5, 'skipped', 'none', $6)`,
      [mail.tenantId ?? null, mail.actorId ?? null, mail.kind, mail.to, mail.subject, `suppressed: ${reason}`],
    );
    logIfEnabled('warn', 'platform_mail', { kind: mail.kind, status: 'skipped', reason });
    return { providerMessageId: null, status: 'failed', detail: `suppressed: ${reason}` };
  }

  const provider = emailProviderFromEnv();
  let result: DeliveryResult | null = null;
  let failure: string | null = null;

  try {
    result = await provider.send({
      from: mailFrom('Patform'),
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      idempotencyKey: mail.idempotencyKey,
      tags: { kind: mail.kind },
    });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  await pool.query(
    `insert into platform_email
       (tenant_id, actor_id, kind, recipient, subject, status, provider, provider_message_id, failure)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      mail.tenantId ?? null,
      mail.actorId ?? null,
      mail.kind,
      mail.to,
      mail.subject,
      failure ? 'failed' : (result?.status ?? 'failed'),
      provider.name,
      result?.providerMessageId ?? null,
      failure ?? result?.detail ?? null,
    ],
  );

  // The address is not logged. A structured log line is the one place these
  // three messages would leak who is signing up for what.
  logIfEnabled(failure ? 'warn' : 'info', 'platform_mail', {
    kind: mail.kind,
    status: failure ? 'failed' : (result?.status ?? 'failed'),
  });

  return result;
}

/**
 * How many of this kind went to this address recently.
 *
 * The throttle for password resets and verification resends. Counting the log
 * rather than keeping a counter means it cannot drift from what was actually
 * sent, and it survives a restart.
 */
export async function sentRecently(
  pool: Pool | Client,
  args: { recipient: string; kind: PlatformMailKind; withinMinutes: number },
): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `select count(*)::int as count from platform_email
      where lower(recipient) = lower($1) and kind = $2
        and sent_at > now() - make_interval(mins => $3)`,
    [args.recipient, args.kind, args.withinMinutes],
  );
  return rows[0]?.count ?? 0;
}

// --------------------------------------------------------------- templates
//
// Plain text, and short. Each says who it is from, what it is for, what to do,
// when it stops working, and what to do if it was not them — which is the line
// that turns a stolen-address incident into a report instead of a breach.

export function invitationMail(args: {
  to: string;
  token: string;
  workspaceName: string;
  invitedBy: string;
  workspaceRole: string;
  message?: string;
  expiresAt: string;
}): { subject: string; text: string } {
  const link = `${appUrl()}/join/${args.token}`;
  const note = args.message?.trim() ? `\n${args.invitedBy} added a note:\n\n  ${args.message.trim()}\n` : '';
  return {
    subject: `${args.invitedBy} invited you to ${args.workspaceName}`,
    text: `${args.invitedBy} has invited you to join ${args.workspaceName} on Patform as a ${args.workspaceRole}.
${note}
Set up your account here:

  ${link}

The link works once, and expires ${new Date(args.expiresAt).toUTCString()}.

If you were not expecting this, you can ignore it — nothing happens until you follow the link.`,
  };
}

export function verificationMail(args: { to: string; token: string; expiresAt: string }): {
  subject: string;
  text: string;
} {
  const link = `${appUrl()}/verify/${args.token}`;
  return {
    subject: 'Confirm your email address',
    text: `Confirm that this address belongs to you:

  ${link}

The link works once, and expires ${new Date(args.expiresAt).toUTCString()}.

Until it is confirmed, this account cannot invite anybody else into its workspace.

If you did not create a Patform account, somebody typed your address by mistake. You can ignore this — the account cannot do anything with your address.`,
  };
}

export function resetMail(args: { to: string; token: string; expiresAt: string }): {
  subject: string;
  text: string;
} {
  const link = `${appUrl()}/reset/${args.token}`;
  return {
    subject: 'Reset your Patform password',
    text: `Somebody asked to reset the password for this address.

  ${link}

The link works once, and expires ${new Date(args.expiresAt).toUTCString()}.

Using it will also sign this account out everywhere else.

If it was not you, you do not need to do anything — your current password still works and nobody has been told whether this address has an account.`,
  };
}
