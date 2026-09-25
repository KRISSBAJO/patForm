'use client';

/**
 * The console's small icons.
 *
 * One stroke weight, one grid, one colour — `currentColor`, so an icon inside
 * a button is whatever that button is and cannot drift from it. Every one of
 * these sits beside a word rather than replacing it: an icon-only control is
 * a memory test, and this is a page where somebody approves things.
 *
 * `aria-hidden`, always. The button's text is the accessible name; an icon
 * that also announces itself reads the label twice. Icon-only buttons provide
 * their own accessible label and title at the call site.
 */

export type IconName =
  | 'open'
  | 'approve'
  | 'reject'
  | 'done'
  | 'back'
  | 'export'
  | 'table'
  | 'trail'
  | 'hide'
  | 'search'
  | 'sort'
  | 'filter'
  | 'copy'
  | 'note'
  | 'account'
  | 'logout';

export function Icon({ name }: { name: IconName }) {
  const p = {
    className: 'cs__icon',
    width: 15,
    height: 15,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (name) {
    case 'copy':
      return <svg {...p}><rect x="5.2" y="4.8" width="8" height="8.2" rx="1.2" /><path d="M10.7 4.8V3.7a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6.2a1 1 0 0 0 1 1h1.7" /></svg>;
    case 'note':
      return <svg {...p}><path d="M3 2.5h10v8.2L10.2 13H3z" /><path d="M5.2 5.2h5.5M5.2 7.7h5.5M10.2 13v-2.3H13" /></svg>;
    case 'account':
      return (
        <svg {...p}>
          <circle cx="8" cy="5.2" r="2.4" />
          <path d="M3.3 13.3c.4-2.4 2.1-3.7 4.7-3.7s4.3 1.3 4.7 3.7" />
        </svg>
      );
    case 'logout':
      return (
        <svg {...p}>
          <path d="M7.2 2.7H4.1a1 1 0 0 0-1 1v8.6a1 1 0 0 0 1 1h3.1" />
          <path d="M7.3 8h6M10.8 5.4 13.4 8l-2.6 2.6" />
        </svg>
      );
    case 'open':
      return (
        <svg {...p}>
          <path d="M9.4 2.6h4v4M13.4 2.6 7.6 8.4" />
          <path d="M11.4 9.6v3a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V5.6a1 1 0 0 1 1-1h3" />
        </svg>
      );
    case 'approve':
      return (
        <svg {...p}>
          <path d="M2.8 8.4 6.2 11.8 13.2 4.8" />
        </svg>
      );
    case 'reject':
      return (
        <svg {...p}>
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      );
    case 'done':
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.8" />
          <path d="M5.4 8.2 7.2 10l3.4-3.6" />
        </svg>
      );
    case 'back':
      return (
        <svg {...p}>
          <path d="M13 8H3.2M7 3.8 2.8 8 7 12.2" />
        </svg>
      );
    case 'export':
      return (
        <svg {...p}>
          <path d="M8 10.4V2.6M5.2 5.4 8 2.6l2.8 2.8" />
          <path d="M2.8 10.8v1.6a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-1.6" />
        </svg>
      );
    case 'table':
      return (
        <svg {...p}>
          <rect x="2.4" y="3" width="11.2" height="10" rx="1.2" />
          <path d="M2.4 6.4h11.2M6.4 6.4V13" />
        </svg>
      );
    case 'trail':
      return (
        <svg {...p}>
          <circle cx="4.4" cy="4" r="1.6" />
          <circle cx="4.4" cy="12" r="1.6" />
          <path d="M4.4 5.6v4.8M7.6 4h5.2M7.6 12h5.2" />
        </svg>
      );
    case 'hide':
      return (
        <svg {...p}>
          <path d="M2.4 8s2.4-4.2 5.6-4.2S13.6 8 13.6 8s-2.4 4.2-5.6 4.2S2.4 8 2.4 8Z" />
          <path d="M2.6 2.6l10.8 10.8" />
        </svg>
      );
    case 'search':
      return (
        <svg {...p}>
          <circle cx="7.2" cy="7.2" r="4.2" />
          <path d="M10.4 10.4 13.4 13.4" />
        </svg>
      );
    case 'sort':
      return (
        <svg {...p}>
          <path d="M4.4 2.8v10.4M2.2 11l2.2 2.2L6.6 11" />
          <path d="M11.6 13.2V2.8M9.4 5l2.2-2.2L13.8 5" />
        </svg>
      );
    case 'filter':
      return (
        <svg {...p}>
          <path d="M2.6 3.6h10.8L9.4 8.2v4.2l-2.8 1.2V8.2z" />
        </svg>
      );
  }
}
