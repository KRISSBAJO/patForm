'use client';

import { useState, type InputHTMLAttributes, type Ref } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  inputRef?: Ref<HTMLInputElement>;
  description?: string;
};

export function PasswordInput({ inputRef, description = 'password', className = '', ...props }: Props) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="cs__passwordField">
      <input
        {...props}
        ref={inputRef}
        className={`cs__input ${className}`.trim()}
        type={visible ? 'text' : 'password'}
      />
      <button
        type="button"
        className="cs__passwordToggle"
        aria-label={`${visible ? 'Hide' : 'Show'} ${description}`}
        aria-pressed={visible}
        aria-controls={props.id}
        title={`${visible ? 'Hide' : 'Show'} ${description}`}
        onClick={() => setVisible((was) => !was)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
          {!visible && <path d="M3 21 21 3" />}
        </svg>
      </button>
    </div>
  );
}
