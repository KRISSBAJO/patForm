'use client';

import { useEffect, useRef } from 'react';

/**
 * What a dialog owes a keyboard.
 *
 * `role="dialog" aria-modal="true"` tells a screen reader that everything
 * behind this is unavailable. It does not make it so — the browser will
 * happily tab a sighted keyboard user straight out of the dialog and into the
 * page underneath, which is still rendered, still clickable, and no longer
 * visible to them. That mismatch is the accessibility failure: the markup
 * makes a promise the behaviour does not keep.
 *
 * No automated checker catches it. axe sees the correct attributes and passes.
 *
 * Four things, and each maps to a criterion:
 *
 *   focus moves in     2.4.3 Focus Order — the next thing after opening a
 *                      dialog should be inside it
 *   focus stays in     2.1.2 No Keyboard Trap, read the other way round: the
 *                      trap is fine, leaving without a way back is not
 *   Escape closes      2.1.1 Keyboard — a dialog a mouse can dismiss and a
 *                      keyboard cannot is not operable
 *   focus goes back    2.4.3 again — returning to the control that opened it,
 *                      rather than the top of the document
 */
/**
 * The last thing focused outside a dialog.
 *
 * Reading `document.activeElement` when the dialog mounts is the obvious way
 * to find the opener and it does not work here. The buttons that open these
 * dialogs disable themselves while the request behind them runs — "Publish…"
 * is disabled from the click until the impact summary arrives — and a disabled
 * button drops focus to <body> immediately. By the time the dialog exists the
 * opener is gone, so the dialog dutifully restores focus to nothing.
 *
 * Tracking it continuously means the opener is remembered from before it was
 * disabled. Dialog contents are ignored so that closing one dialog and opening
 * another still returns to the page rather than to a control that no longer
 * exists.
 */
let lastFocusedOutsideDialog: HTMLElement | null = null;

if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target as HTMLElement | null;
      if (!el || el === document.body) return;
      if (el.closest('[role="dialog"]')) return;
      lastFocusedOutsideDialog = el;
    },
    true,
  );
}

export function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);

  /*
   * The handler lives in a ref so the effect runs once.
   *
   * With `onClose` in the dependency array this looked correct and was not:
   * callers pass an inline arrow, so the identity changes on every parent
   * render, the effect tears down and re-runs, and the teardown restores focus
   * to whatever was focused at the start of *that* pass — a control inside the
   * dialog. The dialog then closed leaving focus nowhere useful, which is the
   * failure this hook exists to prevent.
   */
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const live = document.activeElement as HTMLElement | null;
    const opener = live && live !== document.body ? live : lastFocusedOutsideDialog;
    const box = ref.current;
    if (!box) return;

    const focusable = (): HTMLElement[] =>
      [
        ...box.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetParent !== null);

    /*
     * The dialog itself, not its first control.
     *
     * This said "the first control, not the close button" and then focused
     * exactly the close button, because the close button is first in the DOM.
     * Somebody who opened a publish dialog is there to read what it says, and
     * landing on "×" both invites dismissing it and skips the heading. The box
     * carries tabIndex={-1} and is labelled, so focusing it reads the dialog's
     * name and leaves Tab to reach the controls in order.
     */
    box.focus();
    /*
     * And again after the next paint.
     *
     * The dialog mounts while the request that opened it is still marked
     * in-flight, and the parent re-renders the moment that clears. In a real
     * browser the first focus survives it; under the headless run it did not,
     * and focus was found still sitting on the opener — the difference being
     * timing, not behaviour, which means it can happen to a person too.
     * Focusing twice is idempotent and removes the race either way.
     */
    requestAnimationFrame(() => {
      if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus();
    });

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = focusable();
      if (!items.length) return;
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;

      // Wrap at both ends. Without this, Tab past the last control lands in
      // the page behind, which is exactly what aria-modal said was not there.
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Back where they were. A dialog that returns focus to the document
      // makes somebody re-traverse the whole page to carry on. If the opener
      // has since been removed, the main landmark is the next best place — the
      // one thing that must not happen is landing at the top of the document.
      /*
       * Twice: now, and again after the next paint.
       *
       * The opener is often disabled at this instant — it was disabled for the
       * duration of the request that opened the dialog, and React re-enables
       * it in the same commit that unmounts us. `focus()` on a disabled button
       * does nothing and reports nothing, so a single attempt lands on <body>.
       *
       * Deferring instead of trying immediately traded one failure for
       * another: by the next frame React had replaced the header's buttons, so
       * the captured node was detached and the fallback ran every time. Doing
       * both covers each case and costs nothing when the first attempt works.
       */
      const restore = (): boolean => {
        if (opener?.isConnected && !opener.hasAttribute('disabled')) {
          opener.focus();
          return document.activeElement === opener;
        }
        return false;
      };
      const fallback = (): void => {
        // Only when focus is genuinely nowhere. Landing on <body> means the
        // next Tab starts from the top of the document, which for these pages
        // is a sidebar somebody has already been through.
        if (document.activeElement === document.body || !document.activeElement) {
          document.querySelector<HTMLElement>('main[tabindex]')?.focus();
        }
      };

      restore();
      requestAnimationFrame(() => {
        // A second pass, because React may have replaced the opener's DOM node
        // in the same commit that unmounted the dialog — the first focus lands
        // on a button that is about to stop existing.
        if (!restore()) fallback();
      });
    };
    // Deliberately empty: this runs on mount and unmount only. See `close`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ref;
}
