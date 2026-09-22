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

## Known gaps

**Focus restoration after the builder's Test dialog** returns to the page
rather than to the Test button. The button disables itself while scenarios run,
and React replaces its DOM node in the same commit that closes the dialog, so
the captured element is gone by the time focus is restored. Focus lands on the
main landmark rather than the top of the document, so the next Tab is still
useful. The Publish and New process dialogs restore exactly.

**No screen-reader testing.** Everything above is code inspection plus
automated checks. NVDA, JAWS and VoiceOver each behave differently from the
specification and from each other, and a gate claimed without hearing the thing
read aloud is a claim about markup rather than about use.

**No zoom or reflow testing** (1.4.10, 400% zoom at 320px), and no testing with
Windows High Contrast.

**The landing page is not in scope** of the gate, which names the builder,
respondent, approval and operator flows, and has not been audited.

Automated checking finds perhaps a third of WCAG issues. Every fix above that
mattered most — the invisible focus ring, the dialogs, the unannounced errors —
came from the other two thirds.
