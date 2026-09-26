# Accessibility

**Gate:** §20.2 — *"Core builder, respondent, approval, and operator flows meet WCAG 2.2 AA target."*

Audited 2026-09-21 with axe-core 4.10.2 against `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`, plus manual checks for the criteria axe cannot test.

## Result

| Flow | Automated | Manual |
|---|---|---|
| Respondent form, page 1 | 0 violations | pass |
| Respondent form, validation errors shown | 0 violations | 6 announced errors |
| Console sign-in, and its error state | 0 violations | pass |
| Operator queue ("My work") | 0 violations | pass |
| Approval and record panel | 0 violations | pass |
| Ask (operational query) | 0 violations | pass |
| Builder | 0 violations | pass |
| Builder dialogs (test, publish, new process) | 0 violations | one known gap, below |

Re-run it with `npm run a11y`.

## What the automated pass found

Two violations, both only in the signed-in console, which is why running axe on
a login page and declaring victory is worth nothing:

- **`aria-allowed-attr`, critical.** Panel headings were
  `<button aria-selected="true">`. `aria-selected` requires `role="tab"`, so
  this was invalid ARIA — and the elements were buttons that did nothing, which
  made them keyboard stops with no action and left the headings out of the
  document outline. They are `<h2>` now.
- **`color-contrast`, serious.** Two labels in the sidebar's account block.

## What it could not find, and what that cost

This is the part worth reading. axe passed the sign-in page, the respondent
form and the builder on the first run. None of the following was reported.

**The focus ring was invisible on both sidebars.** `:focus-visible` used
`--green` (#14663f) everywhere. Against paper that is 6.42:1; against the dark
sidebar (#131a17) it is **2.53:1**, under WCAG 1.4.11's 3:1 for a focus
indicator. A keyboard user could not see where they were in the console or the
builder navigation. axe does not test focus indicator contrast at all. Fixed
with a `--focus-ring` token that becomes mint on dark surfaces — mint is 10.1:1
there and 1.6:1 on paper, so it is exactly the wrong colour everywhere else,
which is why the ring is scoped rather than simply changed.

**Contrast depends on the surface, not on "the dark one".** `--on-dark-5` and
`--on-dark-6` were checked against `--ink` and passed. The account block uses
`--ink-raised` and the current nav item uses `#23302a`, and on those the same
colours fall to 4.37:1 and 3.70:1. Both tokens now clear 4.5:1 on the lightest
dark surface they land on, so they are safe wherever they are used rather than
wherever they were tested. `--muted-2` was 3.11:1 on paper and is now 4.63:1.

**`aria-modal="true"` made a promise the behaviour did not keep.** The builder's
three dialogs had the correct attributes — axe passed them — and no focus
management whatsoever. Tab walked straight out of the dialog into the page
underneath, which was still rendered and still clickable and no longer visible
to the person using it. Escape did nothing. `app/useDialog.ts` now moves focus
in, wraps it at both ends, closes on Escape, and returns focus to the control
that opened the dialog.

**A table row that only a mouse could use.** The Ask results opened a record on
row click, with no keyboard equivalent — WCAG 2.1.1. The reference is a button
now.

**A placeholder standing in for a label.** The Ask input had
`placeholder="Which records are overdue?"` and no label, so it had no
accessible name and no visible one after the first keystroke.

**No skip link.** Both the console and the builder put a long sidebar before
the thing you came for. 2.4.1 Bypass Blocks.

**Status messages nobody was told about.** 4.1.3. The builder's save state and
its error tally both change on every keystroke without focus moving; the Ask
panel's reading and result arrive the same way. The console's sign-in error was
the worst of them — a screen-reader user submitted the form and heard nothing
at all, which is 3.3.1 Error Identification.

## WCAG 2.2's new criteria

The ones added in 2.2, checked specifically:

| Criterion | Level | Status |
|---|---|---|
| 2.4.11 Focus Not Obscured (Minimum) | AA | Pass. The console and builder headers are static; columns scroll independently, so a focused control is never covered by a sticky element. |
| 2.5.7 Dragging Movements | AA | Pass, vacuously — nothing in any flow requires dragging. |
| 2.5.8 Target Size (Minimum) | AA | Fixed. The builder's "add" control was 19×19 CSS px, under the 24×24 minimum. It keeps its visual size and now has a 24×24 hit area. |
| 3.2.6 Consistent Help | A | Pass. There is no help mechanism to be inconsistent about; when one is added it belongs in the same place on every page. |
| 3.3.7 Redundant Entry | A | Pass. The respondent form autosaves and resumes with its answers, so nothing is asked twice within a session. |
| 3.3.8 Accessible Authentication (Minimum) | AA | Pass. Email and password, `autocomplete` set on both, paste not blocked, no cognitive function test, no CAPTCHA. |

## A manual pass on the public form, 2026-09-25

Not a screen-reader session, and it should not be read as one. The form was
driven in a browser by keyboard and by its accessibility tree — the names,
roles and states a screen reader is given — with focus and live regions
watched at each step. What such a pass finds is what the markup says; what it
cannot find is what NVDA, JAWS or VoiceOver make of it, and those still differ
from the specification and from each other.

Walked: the Northwind budget transfer form, both pages, empty submission,
a page change, the signature, and the confirmation. Found and fixed:

- **The page changed and nothing was said.** Continue left focus on the
  same button, now reading "Submit", on a page with a different title. Focus
  now moves to the page title, and the "Step 2 of 2" text is a polite live
  region.
- **Errors were announced but not reached.** Each error is an alert, so a
  reader heard them, but focus stayed on Continue and the first invalid field
  was somewhere above. Focus now moves to the first field that needs
  attention, and a status line says how many do.
- **Choice questions had no name.** The radiogroup pointed its label at an id
  no element carried, so a reader heard "radio, 1 of 3" without the question.
  Signatures, file lists and repeating groups had the same shape: a visible
  label and no group for it to name. Every such control is a named group now.
- **No main landmark**, and every section was an unnamed region. The form is
  a `main`; a section with a heading is named by it, and one without is a
  plain division rather than a landmark with nothing to say.
- **The document title was the product's slogan.** It is the form's name.
- **The confirmation appeared unannounced.** Its heading takes focus.

The same pass confirmed what was already right: the honeypot is hidden from
assistive technology and out of the tab order; every input is labelled, help
text is attached with `aria-describedby`, required is set on the control; the
signature offers a typed alternative to the canvas and names both.

## A screen-reader session on the public form, 2026-09-25

NVDA 2026.1.1, portable, speech logged; Chromium driven by keyboard through
Playwright while NVDA read it. `scripts/screen-reader-session.mjs` runs it and
merges NVDA's speech log with the steps into one transcript; the full record
is `docs/screen-reader-transcript-2026-09-25.md`. It is a focus-order
session: what NVDA says as Tab moves through the form, when a check fails,
when a page changes, and while answers are saved. NVDA's browse-mode reading
(arrowing through the page) cannot be driven this way, and JAWS and VoiceOver
were not run.

What it confirmed, in NVDA's words: "Your name edit required blank"; "Your
email edit required We write here when anything changes. blank" (help text
attached); on Continue with nothing filled in, "2 answers need attention",
then focus on "Your name edit required invalid entry Your name is required.",
then each alert; on the page change, "Step 2 of 2" and "Budget transfer
heading level 1"; sections as "The two budgets region", "The money region";
the signature as "Sign to agree to this transfer grouping, How to sign
grouping, Type it radio button checked 1 of 2".

What it found that the markup pass had not:

- **"Saved" every few seconds.** The autosave note was a live region, so
  NVDA said "Saving… Saved — you can close this and come back" after nearly
  every keystroke. It is said once now, in one sentence, and the visible note
  goes on updating silently.
- **"invalid entry" on a list nobody had touched.** The native `required`
  attribute makes Chromium report an empty control as invalid, and NVDA said
  so on the first Tab into page 2. Required is now `aria-required`: still
  said as "required", and invalid only when the server has said so.
- **"answer(s)"** read as "answer s". It is "1 answer needs attention" or
  "2 answers need attention".
- **The slogan came back.** The title was set once, and the framework put its
  own back on the next navigation, so the resume link's arrival renamed the
  page to the product's slogan. The route's own title is "Form" until the
  form's name is known, and the name is re-applied on every page.
- **A dev-only button first in the tab order.** In development, the
  framework's dev-tools button sat before the main landmark and took the
  first Tab after a page change. It is turned off, so a preview reads as the
  live form does.

## Known gaps

**Focus restoration after the builder's Test dialog** returns to the page
rather than to the Test button. The button disables itself while scenarios run,
and React replaces its DOM node in the same commit that closes the dialog, so
the captured element is gone by the time focus is restored. Focus lands on the
main landmark rather than the top of the document, so the next Tab is still
useful. The Publish and New process dialogs restore exactly.

**One screen reader, one mode.** NVDA has read the public form in focus
order, above. NVDA's browse mode, JAWS and VoiceOver have not, and each
behaves differently from the specification and from each other. A session
with someone who uses a screen reader daily is still owed; `npm run
sr:session` gives them, or anyone, a transcript to argue with.

**No zoom or reflow testing** (1.4.10, 400% zoom at 320px), and no testing with
Windows High Contrast.

**The landing page is not in scope** of the gate, which names the builder,
respondent, approval and operator flows, and has not been audited.

Automated checking finds perhaps a third of WCAG issues. Every fix above that
mattered most — the invisible focus ring, the dialogs, the unannounced errors —
came from the other two thirds.
