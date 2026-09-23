'use client';

/**
 * Asking "are you sure?" inside the product.
 *
 * The builder and the held queue used the browser's own `confirm()`: a grey
 * box headed "localhost:3210 says", with OK and Cancel, in the browser's
 * styling rather than ours. It named nothing, could not say what the button
 * does ("OK" to throw a draft away), and looked like a warning from the
 * browser rather than a question from the app.
 *
 * `useConfirm` gives a component an `ask()` that returns a promise, so a call
 * site reads the same as it did — `if (!(await ask(...))) return;` — and the
 * dialog renders where the component puts `dialog`. Focus handling comes from
 * `useDialog`: it moves in, stays in, Escape cancels, and focus goes back.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { useDialog } from '../app/useDialog';
import './confirm-dialog.css';

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  /** Says what happens: "Discard the draft", not "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Red for anything that deletes or cannot be undone. */
  tone?: 'danger' | 'default';
}

export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (yes: boolean) => void } | null>(null);

  const ask = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ options, resolve })),
    [],
  );

  const answer = (yes: boolean) => {
    pending?.resolve(yes);
    setPending(null);
  };

  const dialog = pending ? (
    <ConfirmDialog options={pending.options} onAnswer={answer} />
  ) : null;

  return [ask, dialog];
}

function ConfirmDialog({ options, onAnswer }: { options: ConfirmOptions; onAnswer: (yes: boolean) => void }) {
  const box = useDialog(() => onAnswer(false));
  const danger = options.tone === 'danger';

  return (
    <div
      className="cf"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      onMouseDown={(e) => {
        // A click on the backdrop is "no", never "yes".
        if (e.target === e.currentTarget) onAnswer(false);
      }}
    >
      <div className="cf__box" ref={box} tabIndex={-1}>
        <div className={`cf__mark${danger ? ' cf__mark--danger' : ''}`} aria-hidden="true">
          {danger ? (
            <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h12M8 6V4.5h4V6M6 6l.8 10h6.4L14 6" />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="10" cy="10" r="7.5" />
              <path d="M10 6.5v4.5M10 13.6v.1" />
            </svg>
          )}
        </div>
        <h2 id="confirm-title" className="cf__title">
          {options.title}
        </h2>
        <div id="confirm-body" className="cf__body">
          {options.body}
        </div>
        <div className="cf__actions">
          <button type="button" className="cf__btn" onClick={() => onAnswer(false)}>
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={`cf__btn ${danger ? 'cf__btn--danger' : 'cf__btn--primary'}`}
            onClick={() => onAnswer(true)}
          >
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
