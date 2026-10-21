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
import { emailProviderFromEnv, mailFrom, type Attachment, type DeliveryResult } from './email.js';
import { logIfEnabled } from './trace.js';
import { blockedRecipients } from './delivery.js';

export type PlatformMailKind = 'invitation' | 'verify_email' | 'password_reset' | 'delivery_alert' | 'task_assigned' | 'record_shared' | 'scheduled_report'
  | 'signature_request' | 'signature_code' | 'signature_completed' | 'signature_declined' | 'signature_reminder' | 'signature_not_needed'
  | 'meeting_notice' | 'meeting_reminder' | 'meeting_minutes' | 'resolution_vote' | 'action_assigned' | 'action_reminder' | 'approval_reminder' | 'approval_escalated' | 'approval_requested';

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
  html?: string;
  tenantId?: string | null;
  actorId?: string | null;
  /** Stable per-send, so a provider-side retry is deduplicated like any other. */
  idempotencyKey: string;
  /** A scheduled report's file. Nothing else here carries one. */
  attachments?: Attachment[];
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
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.attachments?.length ? { attachments: mail.attachments } : {}),
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

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function invitationMail(args: {
  to: string;
  token: string;
  workspaceName: string;
  invitedBy: string;
  workspaceRole: string;
  message?: string;
  expiresAt: string;
}): { subject: string; text: string; html: string } {
  const link = `${appUrl()}/join/${args.token}`;
  const note = args.message?.trim() ? `\n${args.invitedBy} added a note:\n\n  ${args.message.trim()}\n` : '';
  const workspace = escapeHtml(args.workspaceName);
  const sender = escapeHtml(args.invitedBy);
  const role = escapeHtml(args.workspaceRole.replace(/_/g, ' '));
  const safeLink = escapeHtml(link);
  const safeNote = args.message?.trim() ? `<div style="margin:24px 0;padding:16px 18px;background:#f4f7f2;border-radius:12px;color:#364b3c;white-space:pre-wrap">${escapeHtml(args.message.trim())}</div>` : '';
  const expires = escapeHtml(new Date(args.expiresAt).toUTCString());
  return {
    subject: `${args.invitedBy} invited you to ${args.workspaceName}`,
    text: `${args.invitedBy} has invited you to join ${args.workspaceName} on Patform as a ${args.workspaceRole}.
${note}
Set up your account here:

  ${link}

The link works once, and expires ${new Date(args.expiresAt).toUTCString()}.

If you were not expecting this, you can ignore it — nothing happens until you follow the link.`,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join ${workspace} on Patform</title></head><body style="margin:0;padding:0;background:#f5f6f2;font-family:Arial,Helvetica,sans-serif;color:#18241e"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f5f6f2"><tr><td align="center" style="padding:32px 16px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border:1px solid #dce5dc;border-radius:18px"><tr><td style="padding:32px 34px"><div style="font-size:17px;font-weight:700;color:#17623e;letter-spacing:-.02em">☑ Patform</div><div style="margin-top:28px;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#578168">Workspace invitation</div><h1 style="margin:10px 0 14px;font-family:Georgia,serif;font-size:30px;line-height:1.17;color:#152a1d">You're invited to ${workspace}</h1><p style="margin:0;font-size:16px;line-height:1.6;color:#425248">${sender} invited you to join ${workspace} as ${role}. Set up your account to see your work and onboarding tasks.</p>${safeNote}<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px"><tr><td bgcolor="#17623e" style="border-radius:9px"><a href="${safeLink}" style="display:inline-block;padding:15px 24px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700">Accept invitation →</a></td></tr></table><p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#66766c">This link works once and expires ${expires}.</p><div style="height:1px;background:#e5ebe4;margin:28px 0 20px"></div><p style="margin:0;font-size:12px;line-height:1.6;color:#6a766d">If you were not expecting this invitation, you can ignore this email. The link points to Patform; check that your browser opens <strong>${escapeHtml(new URL(appUrl()).hostname)}</strong> before entering a password.</p></td></tr></table><p style="max-width:560px;margin:20px 0 0;font-size:11px;color:#7a877e">Patform · Work in one place</p></td></tr></table></body></html>`,
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
