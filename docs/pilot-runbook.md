# Running an Expenses pilot

Plain steps to put the Expenses module in front of one real company.
Written 19 October 2026, after the module and the staff import were built.

## First: decide where the pilot runs

The current staging setup (Render Free, Vercel Hobby, a new Renviq
database) says in [staging-deployment.md](staging-deployment.md): **do not
put customer data on it.** Three reasons, all real for a pilot:

1. **It sleeps.** Render Free stops after idle time. While it is asleep,
   reminders, escalations and emails do not run. A pilot company would see
   approvals stall overnight.
2. **No backups are set up.** Losing a pilot company's claims and bank
   details would end the pilot and the relationship.
3. **Vercel Hobby is for non-commercial use.**

So the choice is:

| Option | What it costs | When to pick it |
|---|---|---|
| **A. Rehearse on staging first, with made-up data** | Nothing | This week. Do the whole pilot setup below with test people, to find problems before a customer does. |
| **B. A small paid setup for the real pilot** | Roughly $30–50 a month: Render Starter for the API and a separate always-on worker, Vercel Pro (or serve the console from Render), and a database with daily backups and point-in-time restore | Before the first real company's data goes in. |

My advice: **A now, B before the first real login.** Option B is a
decision about money and accounts, so it is yours.

## Things only you can do

These need your accounts or secret keys. I cannot enter secrets into
hosting dashboards.

- **Check the deployed version.** Sign in at `https://patforms.com/platform`
  and look at the latest deployment. It should be `41e05e8` or later. If
  not, open the Render dashboard for `patform-staging-api` and press
  *Manual Deploy → Deploy latest commit*. Start-up applies the database
  changes and loads the new Expense claim and Cash advance templates.
- **Encryption key.** Already handled: `render.yaml` has Render generate
  `MFA_ENCRYPTION_KEY`. It now also protects bank details. **Never change
  or delete it** on a live system: anything it sealed (two-step secrets,
  bank account numbers) would become unreadable. For option B, generate a
  new one there the same way and keep a copy in your password manager.
- **Email.** Set `EMAIL_PROVIDER=relykit` and a staging `RELYKIT_API_KEY`
  (see the staging guide), or invitations and approval emails only go to
  the logs.
- **Receipt uploads.** Optional for a pilot. Staff can type a receipt
  reference instead. Uploads need the S3 settings in the staging guide.

## Setting up the pilot company (about an hour)

Do this once on staging with made-up people (option A), then again for
the real company.

1. **Create the workspace.** Sign up at `/signup` as the company's owner
   and confirm the email link (invitations wait for it).
2. **Workspace settings.** Settings → *Modules & workspace*: set the name,
   time zone (for example `Africa/Lagos`), currency (`NGN`) and language
   (`en-NG`). Switch **Expenses** on.
3. **Import the staff.** People → *Import from a spreadsheet*. Ask the
   company for one CSV: `email, name, unit, manager, title`. Use their HR
   list; the manager column is each person's manager's email. Press
   *Check the file*, fix what it names, then import. Leave *Email an
   invitation* ticked when you are ready for people to sign in.
4. **Give Finance their access.** On People, set the finance team's role
   to **Operator** (they record payments) and one finance lead to
   **Admin** (they change the policy). Everyone else stays *Read only*,
   which is enough to submit claims.
5. **Install the two templates.** Builder → *New process* → *Templates*, category Finance:
   **Expense claim** and **Cash advance**. Publish each.
6. **Give people their process roles.** For each process: line managers
   → *Line manager*; the finance team → *Finance approver* and *Finance
   operations*. Staff need nothing extra. Approvals go to each person's
   manager from the import, and to the line-manager group only when
   someone has no manager on file.
7. **Set the policy.** Expenses → *Policy and rates*: auto-approve limit,
   manager limit, single-item limit, receipt threshold, categories,
   account codes, and exchange rates for any foreign currency. Expenses
   → *Budgets* if they want budgets per cost centre.
8. **Staff add their bank details.** Expenses → *My bank details*. Finance
   checks them before paying.

## What to watch in the first two weeks

- Claims stuck waiting: the manager is missing or wrong in the import.
- "No exchange rate on file": add the rate.
- Payments recorded as failed: a bank detail problem; ask the person to
  update them, then check again.
- Anything people ask for twice. That is the next thing to build.

## After the pilot

Procurement (PRD Module 6) is next. It reuses the approvals, limits,
budgets and payments the pilot will have tested.

## Rehearsal script (option A)

Use [pilot-rehearsal-staff.csv](pilot-rehearsal-staff.csv) in step 3. Its
addresses are `+` versions of one Gmail address, so every invitation
arrives in one inbox and you can sign in as each person. Use a separate
private browser window per person: a window holds one sign-in.

Settings for the rehearsal (step 7), in NGN: approve automatically up to
**20,000**; manager alone up to **200,000**; any single item over
**100,000** goes to Finance; receipt needed over **5,000**; add a rate
**1 USD = 1,500 NGN**. Budgets: cost centre **ops**, this month,
**300,000**, *Refuse claims it cannot cover*.

Who is who: Chioma (admin, top), Fola (Finance, operator), Ola (head of
operations), Lara (Lagos lead, reports to Ola), Dayo (reports to Lara),
Sam (reports to Ola). In step 6 give Lara and Ola *Line manager*, and
Fola *Finance approver* and *Finance operations*, on both processes.

| # | Do this | You should see |
|---|---|---|
| 1 | Dayo claims a 12,000 taxi, cost centre ops | Approved at once. Fola's Expenses page: *Approved, not paid yet*. |
| 2 | Dayo claims a 60,000 hotel and a 15,000 dinner | Goes to **Lara**, not anyone else. Lara approves; it is owed. |
| 3 | Sam claims one 150,000 item | Goes to **Ola**, then to **Fola** because the item is over 100,000. |
| 4 | Dayo claims 60, currency USD | Shown as 90,000 NGN at 1,500. Change the rate to 1,600 afterwards: the claim stays at 1,500. |
| 5 | Dayo claims 80,000 (ops budget is nearly used) | Refused: *the ops budget has … left*. |
| 6 | Fola reviews Dayo's hotel claim, cuts the dinner to 10,000 with a reason | *To pay* drops by 5,000; the claim as submitted is unchanged. |
| 7 | Dayo adds bank details; Fola *Check bank details* → *Show full details* → *These details are correct* → *Record payment* | Paid. Try paying before checking: refused. |
| 8 | Dayo changes his bank details while another claim is unpaid | That claim says *changed — check again*; payment refused until Fola checks. |
| 9 | Sam requests a 100,000 advance; Ola approves; Fola *Record pay-out* | *Paid out, to be retired*, retire-by date shown. |
| 10 | Sam claims 70,000 quoting the advance reference (ADV-…) | Nothing to pay; advance shows 30,000 *still held*. Fola records 30,000 *Money returned*: *Retired*. |
| 11 | Fola, Exports → *Export CSV* | A CSV of paid claims with account codes and no bank numbers; the batch is listed. |
| 12 | Lara submits a claim, then tries to approve it herself | Refused: the submitter may not approve. |
| 13 | Import the same CSV again | *Everything checks out: 0 to add … unchanged*. Nothing duplicated. |

Write down anything confusing, slow or wrong, with the row number. That
list is what we fix before a real company sees it.
