# ADR-0013: Account recovery gets its own mail, its own log, and one gate

**Status:** accepted
**Date:** 2026-09-22
**Covers:** §6.1 IAM-01 (invitation delivery), §12.1 (verified email, password reset)

## Context

Three things were outstanding and turned out to be one piece of work.
Invitations existed but returned their token to the caller instead of emailing
it. Creating a workspace did not prove anybody owned the address they typed.
And there was no way back in for somebody who forgot a password.

All three are the same mechanism: a single-use token, emailed, spent once. The
question was where it should live.

## Decision

### Platform mail does not reuse `email_log`

`email_log` requires a non-null `instance_id` and a non-null `action_run_id`.
That is what makes "every process email is traceable to the action that sent
it" a guarantee rather than a convention — you cannot write a row without
saying which action run produced it.

Invitations, verification and resets have no instance and no action run.
Making both columns nullable so three messages could fit would have weakened
the guarantee for the several hundred that already fit. They get
`platform_email` instead, and the constraint stays worth having.

What they *do* share is `EmailProvider`. One place where delivery can go wrong,
and `suppressDelivery()` in a harness suppresses these too — which matters,
because the seed and the proofs both create accounts.

### One token table, two purposes

`auth_token` holds both `verify_email` and `password_reset`. They differ in
lifetime (48 hours against 30 minutes) and in what spending them does, and in
nothing else. Two tables would have meant two places to get "single use"
right.

Spending is one statement:

```sql
update auth_token set used_at = now()
 where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
 returning actor_id, sent_to
```

A read-then-write would let two simultaneous uses both win. Only the hash is
stored: the link *is* the credential, so a dump of this table must not be a set
of keys.

### The token records the address it was sent to

`sent_to`, compared against the actor's current address when the token is
spent. Without it: request a verification link, change your address, follow the
link, and an address you never proved anything about is marked verified.

### Verification gates exactly one thing: inviting

Not sign-in, not publishing, not submitting. The abuse worth stopping is
creating a workspace under a colleague's address and sending invitations that
arrive under their name — the one thing a fresh sign-up does that reaches a
third party. Everything else works while the mail is in flight, because a
sign-up that can do nothing until an email arrives is how a pilot loses its
first user.

Two consequences follow from stating the gate this narrowly:

- **Accepting an invitation verifies the address.** They followed a link that
  was emailed to it, which is precisely what a verification link proves.
  Asking twice would be ceremony.
- **Spending a reset link verifies it too**, for the same reason.

### Reset says the same thing to everybody

`requestPasswordReset` returns `{ accepted: true }` for an address with an
account, one without, a deactivated member, and a throttled address alike. The
API answers *"If that address has an account, a reset link is on its way."*
Anything that varies — including the timing — is an account-enumeration oracle
(§12.3).

A deactivated member gets nothing at all. A reset would otherwise be the way
back in for somebody an owner deliberately removed.

Spending a reset revokes every session, in the same transaction that sets the
password. A reset is what somebody does when they think an account is
compromised; leaving the attacker's cookie alive would make it a gesture.

### The invitation token no longer comes back over HTTP

It used to, because nothing delivered it. Now that the mail goes out, returning
it as well would let any member who can invite mint a working link for an
address whose owner never sees it. The response says `delivered` instead.

## Consequences

- **Platform mail can fail without failing the thing that triggered it.**
  `sendPlatformMail` never throws; it records `failed` and the operator
  resends. A workspace that half exists because a provider was down would be
  worse than an invitation that has to be sent twice.
- **A new deployment must set `APP_URL`.** The default is the dev console
  rather than anything that looks like production, because a link to a
  plausible-but-wrong host fails silently: the mail arrives, looks right, and
  the token cannot be spent.
- **Seeded accounts are verified on creation.** They were written by an
  operator with a connection string, which is stronger proof than clicking a
  link.
- **`InvalidInput` moved to `runtime/errors.ts`.** Account recovery needs it
  and `workspace.ts` needs account recovery; importing both ways works in ESM
  right up until somebody moves a call to the top level.
- **Bounce handling is now the visible gap.** Sign-up mails whatever address a
  stranger types, and an undeliverable domain costs sending reputation.
  `platform_email` stores the provider's message id, which is half of the
  reconciliation; the webhook that closes it is on the deferral list.
