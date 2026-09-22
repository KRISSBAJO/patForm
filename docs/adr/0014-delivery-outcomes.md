# ADR-0014: A bounce has to change what the system does next

**Status:** accepted
**Date:** 2026-09-22
**Covers:** §6.6 (the delivery log), §12.3 (unauthenticated write paths)

## Context

`email_log.status` reached `sent` and stopped. The schema said so in a comment:

> *§6.6: the log distinguishes queued, sent, delivered where supported,
> bounced, complained and failed. Anything past `sent` arrives by webhook from
> the provider and is not wired yet.*

Everything past `sent` is something the provider learns minutes or hours later
— a remote mail server refusing the address, or somebody pressing the spam
button — and tells us about over a webhook. Without it the console showed
"sent" for a message that bounced an hour ago, and the system kept writing to
a mailbox that does not exist.

## Decision

### Built against RelyKit's actual scheme, read from its source

RelyKit signs with Standard Webhooks: `webhook-id`, `webhook-timestamp` in
unix seconds, and `webhook-signature` carrying `v1,<base64 HMAC-SHA256 of
id.timestamp.body>`. Its event payload is `{ id, type, created_at, data }`
with `data.email_id` holding the message id we already store as
`provider_message_id`.

This is *not* the scheme Patform uses for its own outbound webhooks, which is
Stripe's `t=…,v1=<hex>` over `timestamp.body`. Different directions, different
counterparties. Making them match would mean changing one to something its
counterpart does not speak.

### The raw bytes are what is signed

The route reads the body as text, verifies, and only then parses. Re-serialising
JSON changes key order and whitespace, and the signature is over the exact
bytes that arrived.

The `webhook-id` header is authoritative for the event id, not the body's own
`id`. Otherwise one correctly signed request could be replayed as many
different events by changing nothing but the JSON.

### Always 200 once the signature verifies

Including for an event about a message this deployment never sent — a shared
provider account also carries mail we did not send. A 4xx would make the
provider retry something that can never succeed and eventually disable the
endpoint.

### Redelivery is ordinary traffic, not an attack

The provider retries until it gets a 2xx, so the same event arrives more than
once as a matter of course. `delivery_event.event_id` is unique and the insert
is the guard: the second copy loses the insert and does nothing else. The
status change and the suppression commit in the same transaction as the
insert, so a crash between them cannot leave an event marked handled that was
not.

### Status never moves backwards

A message's state is the worst thing that happened to any of its recipients.
A delivery notification for one recipient arriving after a bounce for another
must not make the message look fine. The ranking is the same one RelyKit uses,
so the two systems agree about what a message's state is.

### Suppression is the only part with teeth

A hard bounce or a complaint adds the address to `suppressed_recipient`, and
both send paths — process mail in the Engine and platform mail — check it
before handing anything to a provider. Recording a bounce and then mailing the
same dead address on the next transition is not handling it; it is keeping a
diary about it while the sending domain's reputation pays for every repeat.

A soft bounce suppresses nobody. A full mailbox is not a dead one.

A blocked send is logged `skipped` with the reason rather than dropped
silently, because the operator looking at a message that never arrived needs
to see why.

### The list is deployment-wide; the view is per tenant

A hard bounce means the mailbox does not exist, which is not a fact about who
was writing to it — so one tenant's bounce protects every tenant. But showing
one tenant every address another has burned would be a contact list with extra
steps, so `suppressionsFor` returns only the addresses that tenant has
actually mailed.

### Lifting is recorded, not deleted

`lifted_at` and `lifted_by` rather than a delete, because *"this bounced in
March and somebody reinstated it in April"* is exactly the history the operator
wants the second time it bounces. A fresh hard bounce clears the lift: the mail
server gets the last word.

## Consequences

- **`RELYKIT_WEBHOOK_SECRET` must be set** or the endpoint answers 503. A
  delivery endpoint that accepts unsigned requests is a way to mark anybody's
  address as bounced.
- **A reset link is never sent to a suppressed address.** Correct, and it is
  the reason `requestPasswordReset` answers identically whether or not anything
  was sent — the caller must not learn that either.
- **The console's third "Not built yet" nav item is now the deliverability
  page.** A suppression list nobody can see is a silent change in behaviour:
  messages stop arriving and the record says `skipped` with no page that
  explains it.
- **Open ends provided.** `email.opened` and `email.clicked` are recorded and
  change nothing; no bounce-rate alerting; and nothing re-sends a message after
  an address is reinstated — the operator has to trigger the work again.
