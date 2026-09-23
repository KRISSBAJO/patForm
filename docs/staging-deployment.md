# Free staging deployment

This staging setup uses one Render Free web service for the API and worker,
Vercel Hobby for the Next.js app, and a **new empty Renviq database**. It is for
synthetic data and internal testing. Do not connect the existing `patform` or
`launch-validation` database. Leave `patforms.com` unassigned until the
production launch.

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

## Render

Deploy the `render.yaml` Blueprint from this repository on the Free instance.
Set `DATABASE_URL` to the separate staging database URL. Render generates
`MFA_ENCRYPTION_KEY` and `FORM_TICKET_SECRET`; preserve both across deployments
so existing MFA enrolments and open forms remain valid. Set `APP_URL` and
`CONSOLE_ORIGIN` to the eventual Vercel staging URL, including `https://`.

The combined service runs the API and worker while it is awake. Render Free
spins down after idle time. Approvals still exist in the database, but email,
webhook delivery, reminders, and due timers **do not run while asleep**. They
resume when an HTTP request wakes the service. Render Free also blocks outbound
SMTP ports 25, 465, and 587. Do not configure SMTP for this staging setup.

## Vercel

Import this repository into the personal Hobby account as `patform-staging`.
Set the Root Directory to `web`, Framework Preset to Next.js, and Build Command
to `npx next build` so Vercel uses its normal `.next` output directory. Set the
server-side environment variable `API_URL` to the Render service HTTPS URL.
Deploy the project. Then set Render's `APP_URL` and `CONSOLE_ORIGIN` to the
resulting Vercel URL and redeploy the Render service.

## Check

Open `/api/health` on the Render URL and check for `{"ok":true}`. Open the
Vercel URL, create a test workspace, install a simple template, publish it,
submit a synthetic request, and approve it in the console. Confirm the event
trail shows the submission and decision. Do not use live payment providers,
real contact details, or customer data in staging.
