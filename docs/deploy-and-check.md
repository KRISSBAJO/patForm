# Deploying and checking Patform — for whoever (or whatever) does it next

Read `docs/staging-deployment.md` first: database, Render, Vercel, email and
the receipt bucket are set up there and nothing here replaces it. This note
covers what was added on 19 October 2026 (the ten PRD modules, Patform Sign
and the connectors) and how to prove each piece works on staging without
touching a customer's data. Staging holds made-up data only.

## How the pieces are deployed

- **API and worker** run on Render from `render.yaml`. Both read the same
  environment. The worker must be running: reminders, maintenance jobs,
  contract renewals, scheduled retention, DocuSign polling, exports,
  workspace closures and signing reminders all happen in its minute sweep.
- **Web** runs on Vercel from `web/`. Its `/api/*` route proxies to the Render
  API (`API_URL`), passing PDFs through byte for byte. The signer's public
  pages (`/sign/<link>`, `/sign/verify`) and the offline field page
  (`/field.html`) live here too.
- **Database changes** are applied by the API at boot from
  `src/runtime/upgrades.sql` (idempotent). A boot that fails with a
  constraint error means a rule in `upgrades.sql` disagrees with rows already
  present; fix the rule, do not edit rows. `npm test` never applies upgrades.
- **Files** (receipts, photos, contract documents, signed PDFs, exports) go
  to `AWS_S3_BUCKET`, private, with GuardDuty malware scanning on. A file is
  shown only after its object is tagged `GuardDutyMalwareScanStatus =
  NO_THREATS_FOUND`. Without the tag, uploads sit at "still being checked".

## Environment: what to set on Render

`.env.example` documents every setting. The ones that decide whether a
feature exists at all:

| Setting | Needed for | If missing |
| --- | --- | --- |
| `AWS_REGION`, `AWS_S3_BUCKET` + AWS credentials | receipts, photos, documents, signed PDFs, exports | those uploads are refused with a plain reason |
| `TRUST_PROXY` | the caller's IP for rate limits and the signing record | leave at `0` until the actual forwarding chain is verified on staging; then set only the verified number of trusted hops. An incorrect value can record a proxy or spoofed address. |
| `APP_URL` | every link in email (signing links, exports) | links point at localhost |
| `MFA_ENCRYPTION_KEY` | sealing connector secrets, signing links, bank details | secrets sealed with the public dev key: **never in production** |
| `MS365_CLIENT_ID/SECRET` | Microsoft 365 access connector | Setup says the server is missing them |
| `GOOGLE_WORKSPACE_SA_EMAIL/CLIENT_ID/PRIVATE_KEY` | Google Workspace access connector | as above |
| `DOCUSIGN_*` | DocuSign (optional; Patform Sign does not need it) | Setup says so |
| `SIGN_SEAL_P12_BASE64`, `SIGN_SEAL_PASSPHRASE` | certificate seal on signed PDFs | PDFs are sealed by fingerprint only (still verifiable) |
| `SIGN_TSA_URL` | trusted time stamp in the seal | defaults to DigiCert (free); `none` turns it off |
| `SMS_PROVIDER` + Termii or Twilio keys | signing codes by text message | text-message codes are refused at send time, never faked |
| `COMPANIES_HOUSE_API_KEY` | UK company register checks | check reported as not available |
| `WORKSPACE_CLOSURE_WAIT_DAYS` | wait between suspending and deleting a workspace | 14 |
| `OBJECT_STORE` | **local trials only** (`memory`) | leave unset; the API refuses it in production |

Keep `.env` out of git (it is ignored). Paste private keys on one line with
`\n` for the line breaks.

## Checks after a deploy, in order

Each check is a few minutes with a made-up workspace. "Setup" means the
tab of that name inside the module's page in the console.

1. **Boot**: Render's API log shows "upgrades applied" and no constraint
   error; the worker log shows its first sweep.
2. **Modules**: Settings → Modules & workspace. Switch on Expenses,
   Procurement, HR, Appraisals, Assets & IT, Contracts. Each gains a nav item.
3. **Files**: Assets & IT → Assets → open one → add a photo. It should say
   "uploaded" and, within about a minute, open through View. If it stays
   at "still being checked", GuardDuty is not tagging the bucket.
4. **Offline field page**: open `/field.html` on a phone with a maintenance
   job due; turn off data; finish the job; turn data on. The job shows as
   done in the console. (`docs/prd-audit-module-1-2026-10-19.md`, Module 9.)
5. **Access connectors** (only where keys are set): Assets & IT → Setup → add
   a system of kind Microsoft 365 or Google Workspace → Test connection. It
   names every mapped group or says exactly what is missing.
6. **Contracts and reviews**: Compliance → Contracts → new contract with a
   value above the Finance threshold → Send for review. Approve as legal;
   New version with a changed value cancels the approvals (acceptance 1).
7. **Patform Sign, end to end**: Compliance → Signatures → Send a PDF for
   signature → two signers, one of them you. Place boxes, Send. Open the
   emailed link in a private window: code, consent, sign. When both have
   signed, download the copy and drop it on `/sign/verify`: "Genuine",
   both signers listed, and — if a seal certificate is set — "Digital seal
   intact" with "time stamped … by DigiCert". Change one character of the
   PDF with a hex editor and drop it again: "Not a match".
8. **Signing by text message** (only with `SMS_PROVIDER`): send to yourself
   with "Confirm by: text-message code"; the text arrives, the email does
   not carry a code, and the certificate page says "by text message".
9. **Company signing**: three signers under one company, "2 of 3". The
   first two sign; the third's link says "no longer needed". With
   `COMPANIES_HOUSE_API_KEY` set, give a real UK company number: the sender
   sees "Companies House lists … as active" and the certificate names who
   was and was not listed.
10. **Export and closure**: Settings → Modules & workspace → Export the
    workspace (ready within a sweep; download works) → Close this
    workspace… → suspend → **Cancel closing**, and confirm every member is
    back. Do not approve a deletion on a workspace anyone needs.
11. **Legal hold vs retention**: Compliance → Legal holds → place a hold on
    a process key → Scheduled retention on for that key. After the sweep
    the hold shows "N record(s) kept from deletion". Release, then have a
    different owner clear it.
12. **Auditor**: invite someone with the Auditor role; grant them an
    engagement for seven days; sign in as them: only "My engagements"
    exists, and `/api/members` answers 400.

## Things that bit us, so you can spot them fast

- A new workspace role (`pre_hire`, `auditor`) must be added to **every**
  copy of the `workspace_role` check in `upgrades.sql`, or the API will not
  boot once such a person exists.
- The `title` column exists on both `sign_recipient` and `sign_envelope`;
  joins must alias one of them.
- A wrong-code strike must be committed before the refusal is thrown, or
  the lock never closes (`esign.ts`, `verifyCode`).
- Codes go in email bodies only; subjects are logged.
- The C: drive on the dev machine fills up; `npm install --cache E:/claude-work/npmcache`.

## Running the tests

`npm test` needs `DATABASE_URL` pointing at localhost (container
`patform-pg`, port 15432) and `.env` loaded; tests skip themselves otherwise.
Two tests call out: the time-stamp test reaches DigiCert (skips its stamp
checks if unreachable); nothing else needs the network. Everything that
touches a bucket uses an in-memory store in tests. 316 tests as of
19 October 2026.
