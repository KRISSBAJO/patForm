# Privacy

**Gate:** §20.2 — *"Data map, retention behavior, subprocessors, privacy terms, and deletion workflow reviewed."*

Reviewed 2026-09-21. Two of the five are code; three are this document.

---

## 1. The data map

**Derived, not written.** `npm run data-map -- --as <actor-id>` computes it from the published versions actually in the database.

A hand-maintained data map is correct on the day it is written and wrong by the next publish, and being wrong is worse than being absent because somebody relies on it. Everything it needs is already declared — the compiler knows every field, its classification, why it was collected, who may see it, where it can go, and how long it is kept. So the map is a query, not a document.

For each process it reports the purpose in the customer's own words, who the subjects are, the retention period and what happens at the end, the sensitivity ceiling, and per field: classification, who supplies it, the stated collection reason, which roles it is hidden from, and **every route by which a value can leave the record** — an email placeholder, a document mapping, a webhook payload, a CSV export, an approval's context panel, or a party addressed by that field.

That last column is the one a written data map always gets wrong, because a template changes and the document does not.

### What it found on its first run

Six confidential fields recorded no reason for being collected, and one restricted field — a workplace-adjustment disclosure — was **hidden from nobody**, so every role in the process including the IT operator setting up a laptop could read it. Nobody had decided that; it had simply never been narrowed.

Both are fixed in the reference blueprint, and the second is now a compiler warning (`SEC010`) so it cannot recur silently. It is a warning rather than an error because sometimes it is right: a process whose only internal role is HR has nobody to hide anything from.

### Lawful basis and minimisation

Patform is a **processor**. The customer operating a workspace is the controller and decides the lawful basis for each process; the platform's job is to make that decision visible and enforceable:

- `intent.outcome` states the purpose, and the compiler requires it.
- `sensitivityCeiling` caps what a process may hold, and a field classified above it will not compile.
- `collectionReason` is where minimisation is recorded, and the data map flags a confidential or restricted field without one.
- `hiddenFields` narrows who sees what, enforced by the runtime on every read (ADR-0007), not by the interface.

---

## 2. Retention behaviour

Built. `npm run retention`, and [ADR-0007](adr/0007-authorization-in-the-runtime.md).

- The period comes from the **published blueprint**, not from an argument, so nobody deletes faster than the process promised.
- It runs from `completed_at`; a record still running is never touched.
- A `retention_run` row is written **before** the delete, in the same transaction, so the account of what was removed outlives the data.
- `event` is append-only by trigger. Retention bypasses it with a transaction-local setting that reverts at commit and is invisible to every other connection — one door, not a general exemption.
- `preview: true` runs the whole thing and rolls back, which is the only honest way to answer "what would this delete?".
- It requires `administer`. An operator is refused.

**A process with no `retentionDays` is kept forever**, and the data map says so in plain words rather than leaving a blank.

---

## 3. Subprocessors

Everywhere customer data goes, and what goes there.

| Subprocessor | Purpose | What reaches them | Where |
|---|---|---|---|
| **Renviq** (LogaXP) | The database. Every record, every event, every generated document. | All of it, including restricted fields. | Stated by Renviq. |
| **RelyKit** (LogaXP) → **AWS SES** | Transactional email. | Recipient addresses, subject, body, and any attached document. The compiler refuses to publish a template that puts a restricted field in a body (`SEC002`), so what reaches them is bounded by what compiles. | SES region per RelyKit's configuration. |
| **Anthropic** or **OpenAI** | Blueprint generation, and the operational copilot. | **The process schema, never its contents.** See below. | Provider's stated regions. |
| The customer's own webhook endpoints | `call_webhook` actions. | Only the fields the blueprint's `includeFields` names, and the compiler refuses restricted ones (`SEC003`). | Wherever the customer points it. |

### The AI boundary, stated precisely

This is the row people ask about, so it is worth being exact.

**Blueprint generation** sends the customer's description of their process. That is business text they typed, not anybody's personal data.

**The operational copilot** sends the *schema* — state keys, field keys and labels, task and approval names, email template names. It does not send a single answer. The model produces a typed query plan; a deterministic compiler resolves it and runs the query. The model never sees the rows that come back.

That is not an accident of implementation, it is the reason the plan language exists ([ADR-0010](adr/0010-the-copilot-and-the-export.md)): the records being queried contain free text that respondents typed, so anything that fed them to a model would be feeding it attacker-controlled input on every question.

**Nothing is sent to any provider unless the customer configures a key.** With none set, generation and the copilot are unavailable and say so.

---

## 4. Privacy terms

Not written. This is a document for a lawyer and a named controller, and drafting one here would be the kind of placeholder somebody later mistakes for advice.

What the terms will have to state, and which the platform can already evidence:

- Patform is a **processor**; the workspace owner is the controller.
- The subprocessor list above, and a commitment to notify before it changes.
- Retention is per process and set by the controller; the platform will not delete faster or slower than the published blueprint says.
- Data is exportable at any time in JSON or CSV, including the full audit history ([ADR-0010](adr/0010-the-copilot-and-the-export.md)), so there is no lock-in on exit.
- Erasure requests are carried out against live data within the workspace, and **backups age out on their own schedule** — see the limitation below.
- Model training: no customer data is used to train any model. Whether a provider retains prompts is the provider's policy, and §7.3 asks that customers be able to configure retention of AI interaction logs, which is not built.

---

## 5. The deletion workflow

**`npm run erase -- <email> --as <actor-id> [--apply] --reason "..."`**

Retention deletes by age. A privacy request deletes by person, and the difference is not scheduling.

### The distinction that makes it hard

**A person can appear in a record that is not about them.** The hiring manager named on a new hire's form is a data subject in somebody else's record. Deleting every record their address appears in would destroy other people's data to satisfy one request; refusing to erase them because their address is in somebody else's form would make the right meaningless.

So every appearance is classified:

- **subject** — the record is about this person. The blueprint already identifies them: the respondent role's own email field, which is the same convention `resolveParty({submitter: true})` uses. Erasure **deletes** the record and its history.
- **mentioned** — they appear in somebody else's record. Erasure **redacts** only the fields that name them, replacing the value with `[erased]` rather than removing the key, so the record still shows that a manager was named and approved. Removing it entirely would make the audit read as though nobody was ever asked.

### The rest of the workflow

- **Previews by default.** `--apply` is required, `--reason` is required with it. The preview runs the real thing and rolls back, so the numbers are measured.
- **A record still running is not erased,** and is listed as blocked with the reason. Deleting a live case removes somebody else's work in progress and leaves approvals pointing at nothing.
- **`erasure_run` is written before the deletion**, carrying the subject, the reason, the counts and who ran it. It is not itself erasable by this procedure.
- **The delivery log is reached too.** `email_log.recipients` holds the address in its own column, outside the record's data, and an erasure that left it there would miss the copy most likely to be read.
- **It requires `administer`.** An operator is refused.

### What it does not reach

**Backups.** The recovery drill proves they exist and restore faithfully ([ADR-0011](adr/0011-the-recovery-drill.md)), which means an erased person remains in every backup taken before the request. §12.1 calls this "backup expiry" and it is a retention schedule, not a delete.

The honest statement to a data subject is that live data is erased now and backup copies age out — not that every trace is gone. The CLI prints exactly that after every run, so nobody has to remember it.

**Documents already delivered.** A PDF attached to an email has left the platform. Erasure removes the stored copy; it cannot recall the one in somebody's inbox.

---

## What is not met

Named rather than implied.

- **Privacy terms are not written** (item 4 above).
- **No data protection impact assessment.** §12.2 is explicit that compliance depends on controls, practice, contracts, evidence, training and audits — not on a feature list.
- **No configurable retention of AI interaction logs** (§7.3). `copilot_run` rows are kept indefinitely and are not covered by any retention period.
- **No subject access request export.** A workspace member can export a record they can see; a data subject asking "what do you hold about me" has no self-serve route, and `findSubject` is the query that would back one.
- **No consent capture or withdrawal.** Where a controller relies on consent, the blueprint has nowhere to record that it was given.
- **Erasure is per workspace.** A person in two workspaces requires two requests, correctly — the controllers are different — but there is no way to find that out.
