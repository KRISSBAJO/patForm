# Process blueprint schema v0.1

The typed intermediate representation from §7.2 of the product document. The AI proposes one of these; the compiler decides whether it may become a published version.

**Nothing in a blueprint is executable.** There is no code, no expression string, no template language beyond `{{field_key}}` substitution, and no free-form reference. Every link between sections is a declared key the compiler resolves. That is the whole point of the boundary: a model can propose anything, and the worst it can propose is a blueprint that fails to compile.

Source of truth is `src/blueprint/*.ts` (Zod). `schema/blueprint-0.1.json` is generated from it with `npm run schema` and is what a provider's structured-output mode is given.

---

## The ten sections

| Section | Answers | Key rules |
|---|---|---|
| `intent` | What is this process for, and when is it done? | Completion state must be terminal with outcome `success`. Sensitivity ceiling caps every field's classification. |
| `roles` | Who may do what? | Respondent roles may not hold `operate` or `administer`. A role cannot edit a field it cannot see. |
| `data` | What is collected, and how sensitive is it? | Field keys unique across the whole process, including inside repeating groups. `identity` names the fields that detect a duplicate. |
| `experience` | What does the respondent see? | Every required field must appear on exactly one page. Conditions are typed expressions. |
| `workflow` | What happens, and in what order? | One initial state, at least one terminal state, every state reachable, no dead ends, no unconditional self-loops. |
| `communications` | Who gets told what? | Every `{{placeholder}}` resolves to a real field. Recipients are roles, email fields, or the submitter — never a literal string. |
| `outputs` | What does this produce? | Documents map placeholders to real fields. Webhook payload fields are opt-in and cannot carry restricted data. |
| `tests` | How do we know it works? | All six scenario kinds required before publish. |

---

## The expression model

Two separate languages, deliberately.

**`Expr`** produces a boolean and is the only thing allowed in `when`, `visibleWhen`, and `skipWhen`:

```json
{ "op": "and", "operands": [
  { "op": "gt", "left": { "field": "expense_total" }, "right": { "literal": 1000 } },
  { "op": "eq", "left": { "field": "cost_centre" }, "right": { "literal": "eng" } }
]}
```

Operators: `and`, `or`, `not`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `contains`, `is_empty`, `is_present`.

Operands are `{field}`, `{literal}`, or `{context}` where context is `now`, `today`, `actor`, or `current_state`. There is no property access, no indexing, no function call, and no way to write a string that gets evaluated.

**`Calc`** produces a number and appears only in a calculated field's `compute`:

```json
{ "op": "sum", "over": "line_items", "of": "line_amount" }
```

Keeping them apart means a boolean can never appear where a number is expected, and the compiler can type-check comparisons: `gt` against a text field is an error (`TYPE001`), and comparing a choice field against a value it cannot hold is an error (`TYPE002`) rather than a branch that is silently always false.

---

## Diagnostic codes

Errors block publication (BLD-07). Warnings appear in review and do not block, on the principle that **a process that stalls is a business decision; a process that leaks data is not.**

### References — `REF`

| Code | Severity | Fires when |
|---|---|---|
| `REF001` | error | Duplicate key in any collection |
| `REF002` | error | Anything refers to a field that does not exist |
| `REF003` | error / warning | Field on more than one page, or a required field on none (warning if optional) |
| `REF005` | error | Transition leaves or enters an unknown state |
| `REF006` | error | Action refers to an unknown state, task, approval, template, or document |
| `REF007` | error | Trigger refers to an unknown approval, task, or role |
| `REF008` | error | Recipient is an unknown role, or a field that is not an email |
| `REF011` | error | Template attaches an unknown document |
| `REF012` | error | Unknown owner role or completion state |
| `REF013` | error / warning | Metric on an unknown state; webhook event not declared in `outputs` |

### Flow — `FLOW`

| Code | Severity | Fires when |
|---|---|---|
| `FLOW001` | error | Not exactly one initial state |
| `FLOW002` | error | No terminal state |
| `FLOW003` | error | A state cannot be reached from the initial state |
| `FLOW004` | error | A transition leaves a terminal state |
| `FLOW005` | error | A non-terminal state has no way out |
| `FLOW006` | error | Completion state is not a successful terminal state, or is unreachable |
| `FLOW007` | error | A state loops onto itself with no condition and no timer |
| `FLOW008` | error | A terminal state does not declare its outcome |
| `FLOW009` | error | A submission transition does not leave the initial state |
| `FLOW010` | warning | A waiting state has nothing that can release it |

### Types — `TYPE`

| Code | Severity | Fires when |
|---|---|---|
| `TYPE001` | error | Ordered comparison on a non-ordered value, or a mismatched equality |
| `TYPE002` | error | A choice field compared against a value it cannot hold |
| `TYPE003` | error | Choice field with no choices; empty repeating group |
| `TYPE004` | error | Calculation over a non-numeric field, or a calculated field with no `compute` |
| `TYPE005` | error | A calculated field refers to itself, directly or in a ring |

### Security and privacy — `SEC`

| Code | Severity | Fires when |
|---|---|---|
| `SEC001` | error | A field is classified above the process's sensitivity ceiling |
| `SEC002` | error / warning | Restricted field in an email body (error); confidential field sent to someone other than its subject (warning) |
| `SEC003` | error | Restricted field in a webhook payload |
| `SEC004` | warning | Confidential or restricted field in a CSV export |
| `SEC005` | error | The process has approvals but no role may approve |
| `SEC006` | error | A respondent role is granted `operate` or `administer` |
| `SEC007` | warning | A restricted field has no stated collection reason |
| `SEC008` | error | A role may edit a field it cannot see |

### Operations — `OPS`, `BLOCK`, `ASSIGN`

| Code | Severity | Fires when |
|---|---|---|
| `OPS001` | error | Two actions in one transition share a key, which would collapse their idempotency key |
| `OPS002` | warning | An approval, task, template, or document is defined but never used |
| `OPS003` | warning | A sequential approval with one approver |
| `OPS004` | warning | A marketing-class template, which is out of MVP scope |
| `OPS005` | warning | No completion-rate metric on the dashboard |
| `OPS006` | warning | A state declares an SLA with no timer behind it |
| `OPS007` | warning | No identity fields, so duplicates cannot be detected |
| `BLOCK001` | error | A blocking task that no transition waits for |
| `BLOCK002` | error | A transition waits for a task nothing creates |
| `BLOCK003` | error | A join leaves out a blocking task that can be open in the same state |
| `BLOCK005` | error | A join names the same task more than once |
| `REF014` | error | `data.submitterField` names no field, or one that is not an email |
| `SEC009` | warning | The submitter field is set by an operator, not by the respondent |
| `SEC010` | error | An approval bars the submitter, and nothing says which address is theirs |
| `SEC011` | error | An approval is addressed only to the submitter and also bars them |
| `SEC012` | warning | A role may edit and lists no editable field, so it can change nothing |
| `SEC013` | error | A file field, which would record a name and not a document |
| `TIME001` | error | A timer measured both ways, neither way, or off a date with no offset |
| `TIME002` | warning | A timer hangs off a date the respondent may leave blank |
| `REF015` | error | A timer hangs off something that is not a date field |
| `ASSIGN001` | error | A message or task addressed to the current assignee where nothing assigns |

### Tests — `TEST`

| Code | Severity | Fires when |
|---|---|---|
| `TEST001` | error | A scenario kind is missing |
| `TEST002` | error | A step refers to an unknown approval, task, role, or field |
| `TEST003` | error | An expectation refers to an unknown state, template, document, or task |

---

## Deliberate omissions in v0.1

Documented in full in [failure-cases.md](failure-cases.md), summarised here so nobody assumes they were overlooked:

- No "all blocking tasks complete" trigger, so parallel work is modelled as a false sequence.
- No approval quorum ("any two of four").
- No quantifiers over repeating groups ("any line item over £200").
- Timers are relative to state entry only, never to a date field.
- No way to declare "the approver may not be the submitter".
- Field visibility is per role, not per role and state.

---

## Using it

```bash
npm install
npm test                 # compiler rules, including the broken-example regression suite
npm run check            # compile every process in processes/
npm run schema           # regenerate schema/blueprint-0.1.json for structured output
```

To compile one file:

```bash
npx tsx src/cli.ts processes/employee-onboarding.blueprint.json
```
