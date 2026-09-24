# Free staging deployment

This staging setup uses one Render Free web service for the API and worker,
Vercel Hobby for the Next.js app, and a **new empty Renviq database**. It is for
synthetic data and internal testing. Do not connect the existing `patform` or
`launch-validation` database. The staging site currently uses `patforms.com`
at the owner's request. Do not put customer data on this free deployment.

## Database

1. Create a separate Renviq database named `patform-staging` within the existing
   account's included capacity. Save its connection URL as `DATABASE_URL` in a
   local `.env` file. Do not commit or print that URL.
2. On first start, the staging service initializes the schema if the database
   has no public tables or other public relations. It leaves existing schemas
   alone. The same guarded operation is available manually with
   `npm run db:init-empty -- --confirm-empty-staging-db`. Do not use `npm run seed`:
   it drops the schema.
3. Create a staging workspace through `/signup` after the site is deployed.
   Use test accounts and test records only.

Staging startup publishes the 122 generated process packs and three hand-built
reference packs into the catalogue. It compares each with the current built-in
version before publishing, so restarts do not create duplicate versions or
change an installed process. The development `npm run seed` is never used in
staging: it drops the database and creates fictional accounts and records.

## Render

Deploy the `render.yaml` Blueprint from this repository on the Free instance.
Set `DATABASE_URL` to the separate staging database URL. Render generates
`MFA_ENCRYPTION_KEY` and `FORM_TICKET_SECRET`; preserve both across deployments
so existing MFA enrolments and open forms remain valid. Set `APP_URL` and
`CONSOLE_ORIGIN` to the eventual Vercel staging URL, including `https://`.
The staging database's self-signed TLS certificate is pinned in
`certs/renviq-staging.pem`. If Renviq rotates it, replace the pin only after
verifying the new certificate through the database operator; a changed
certificate deliberately stops staging rather than silently trusting it.

The combined service runs the API and worker while it is awake. Render Free
spins down after idle time. Approvals still exist in the database, but email,
webhook delivery, reminders, and due timers **do not run while asleep**. They
resume when an HTTP request wakes the service. Render Free also blocks outbound
SMTP ports 25, 465, and 587. Do not configure SMTP for this staging setup.

## Email

Render must use the RelyKit HTTP provider for real staging email. In the
`patform-staging-api` service Environment page, set `EMAIL_PROVIDER=relykit`,
`MAIL_FROM=noreply@renviq.com`, and `RELYKIT_API_KEY` to a dedicated staging
key from RelyKit. The `renviq.com` sending domain is verified in the RelyKit
account. Never put the key in this document, source control, or chat. Save and
redeploy after changing the environment.

Without `EMAIL_PROVIDER`, the app's default console provider prints messages
to Render's logs and no email reaches the recipient. After the deployment is
live, use the console's **Send the link again** action for an unverified test
account, then confirm the message appears in RelyKit's email activity and is
delivered. If it does not, inspect the Render application logs and RelyKit's
message details before requesting another resend.

For bounce and complaint handling, add an active RelyKit delivery webhook at
`https://patform-staging-api.onrender.com/api/webhooks/relykit` and set Render's
`RELYKIT_WEBHOOK_SECRET` to **that endpoint's** signing secret. A disabled
localhost webhook cannot report delivery outcomes to staging. Check a webhook
attempt in RelyKit after a test message; the API must accept its signature.

## Receipt storage

Finance receipt uploads use S3. Set `AWS_REGION`, `AWS_S3_BUCKET`, and AWS
credentials with access to the staging bucket on Render. The bucket must remain
private and encrypted. GuardDuty Malware Protection must tag uploaded objects
with `GuardDutyMalwareScanStatus`; until an upload is tagged
`NO_THREATS_FOUND`, the form will not accept its receipt reference. Test with a
synthetic PDF in a Finance process and confirm it changes from scanning to
ready before submitting the form.

## Vercel

Import this repository into the personal Hobby account as `patform-staging`.
Set the Root Directory to `web`, Framework Preset to Next.js, and Build Command
to `npx next build` so Vercel uses its normal `.next` output directory. Set the
server-side environment variable `API_URL` to the Render service HTTPS URL.
Deploy the project. Set Render's `APP_URL` and `CONSOLE_ORIGIN` to
`https://patforms.com` and redeploy the Render service. The default Vercel
address remains available for checks while custom-domain DNS propagates.

## Domain

The Vercel project has `patforms.com` connected to Production and
`www.patforms.com` configured as a temporary redirect to the apex. At GoDaddy,
the apex A record points to `216.198.79.1` and the `www` CNAME points to
`cca4c78da1e9d3dd.vercel-dns-017.com.`. These targets came from Vercel's
project-specific domain instructions. Recheck those instructions before any
future DNS change. DNS and HTTPS certificate issuance can take time to settle.

## Check

Open `/api/health` on the Render URL and check for `{"ok":true}`. Open the
Vercel URL, create a test workspace, install a simple template, publish it,
submit a synthetic request, and approve it in the console. Confirm the event
trail shows the submission and decision. Do not use live payment providers,
real contact details, or customer data in staging.

## Site administration

`/platform` is separate from each customer's console. It shows workspace and
process counts, worker heartbeat, failed jobs, request traces, email delivery summaries,
service starts, and the platform admin audit. It never returns form answers,
email bodies, or raw failure text. Operators can retry failed jobs and revoke
sessions; platform owners can grant and revoke site roles. Every write is
recorded in `platform_admin_audit` and asks for a recent password and MFA code.

To bootstrap the two staging owners requested by the operator, set Render's
`PLATFORM_BOOTSTRAP_EMAILS` to
`krissbajo@gmail.com,krissbajo@logaxp.com` and redeploy. A matching account
must already be active, email verified, and have a credential. Missing accounts
are skipped, so create and verify the second account first or redeploy after it
exists. If one email matches multiple workspace accounts, startup stops rather
than picking one. Before `/platform` opens, each owner must turn on two-step
verification under **Your account**. The supplied example password is not used
as a seed credential; existing passwords remain unchanged. Remove the
bootstrap setting after both grants have been confirmed, so later accounts
cannot gain site access through it.
