'use client';

/*
 * Small two-tone illustrations for the console: a scene, not an icon.
 * They are drawn in the current module colour (--mod, --mod-tint, --mod-deep)
 * so every area keeps its own identity, and in plain SVG so they are crisp
 * at any size and cost nothing to load.
 */
export type IllustrationName = 'calendar' | 'vote' | 'actions' | 'register' | 'send' | 'sign' | 'people' | 'verify' | 'templates' | 'inbox';

const T = 'var(--mod-tint, #efedf9)';
const M = 'var(--mod, #5b4bb7)';
const D = 'var(--mod-deep, #3d3280)';
const W = '#fff';

const SCENES: Record<IllustrationName, React.ReactNode> = {
  calendar: <>
    <rect x="8" y="12" width="48" height="44" rx="8" fill={T} />
    <rect x="8" y="12" width="48" height="14" rx="8" fill={M} />
    <rect x="8" y="20" width="48" height="6" fill={M} />
    <rect x="18" y="6" width="4" height="12" rx="2" fill={D} /><rect x="42" y="6" width="4" height="12" rx="2" fill={D} />
    <rect x="16" y="32" width="8" height="8" rx="2" fill={W} /><rect x="28" y="32" width="8" height="8" rx="2" fill={W} /><rect x="40" y="32" width="8" height="8" rx="2" fill={M} />
    <rect x="16" y="44" width="8" height="8" rx="2" fill={W} /><rect x="28" y="44" width="8" height="8" rx="2" fill={W} />
    <circle cx="50" cy="48" r="9" fill={D} /><path d="M46 48l3 3 5-6" stroke={W} strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </>,
  vote: <>
    <rect x="8" y="30" width="48" height="26" rx="6" fill={T} />
    <rect x="8" y="30" width="48" height="8" rx="4" fill={M} />
    <rect x="22" y="26" width="20" height="4" rx="2" fill={D} />
    <rect x="20" y="8" width="24" height="26" rx="3" fill={W} stroke={M} strokeWidth="2" transform="rotate(-8 32 21)" />
    <path d="M27 20l4 4 8-9" stroke={M} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" transform="rotate(-8 32 21)" />
    <rect x="16" y="46" width="14" height="4" rx="2" fill={W} /><rect x="34" y="46" width="14" height="4" rx="2" fill={W} />
  </>,
  actions: <>
    <rect x="14" y="10" width="36" height="46" rx="6" fill={T} />
    <rect x="24" y="6" width="16" height="8" rx="3" fill={D} />
    <circle cx="24" cy="26" r="4" fill={M} /><path d="M22.5 26l1.2 1.2 2.3-2.6" stroke={W} strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <rect x="31" y="24" width="14" height="4" rx="2" fill={W} />
    <circle cx="24" cy="38" r="4" fill={M} /><path d="M22.5 38l1.2 1.2 2.3-2.6" stroke={W} strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <rect x="31" y="36" width="12" height="4" rx="2" fill={W} />
    <circle cx="24" cy="50" r="4" fill={W} stroke={M} strokeWidth="2" /><rect x="31" y="48" width="10" height="4" rx="2" fill={W} />
  </>,
  register: <>
    <path d="M12 12a6 6 0 0 1 6-6h30a4 4 0 0 1 4 4v42a4 4 0 0 1-4 4H18a6 6 0 0 1-6-6z" fill={T} />
    <rect x="12" y="6" width="8" height="50" rx="4" fill={M} />
    <rect x="26" y="16" width="20" height="3" rx="1.5" fill={D} /><rect x="26" y="24" width="20" height="3" rx="1.5" fill={W} /><rect x="26" y="32" width="14" height="3" rx="1.5" fill={W} />
    <circle cx="42" cy="46" r="9" fill={M} /><circle cx="42" cy="46" r="5.5" fill="none" stroke={W} strokeWidth="1.5" /><path d="M39 46l2 2 4-4" stroke={W} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </>,
  send: <>
    <rect x="6" y="22" width="34" height="26" rx="5" fill={T} />
    <path d="M6 27l17 11 17-11" stroke={M} strokeWidth="2.4" fill="none" strokeLinejoin="round" />
    <path d="M30 34L58 18l-8 30-9-9-11 5z" fill={M} />
    <path d="M41 39l17-21-21 17z" fill={D} />
  </>,
  sign: <>
    <rect x="10" y="10" width="40" height="46" rx="6" fill={T} />
    <rect x="18" y="18" width="20" height="3" rx="1.5" fill={W} /><rect x="18" y="26" width="24" height="3" rx="1.5" fill={W} /><rect x="18" y="34" width="14" height="3" rx="1.5" fill={W} />
    <path d="M18 47c5-7 8-7 10-2s5 4 10-4" stroke={D} strokeWidth="2.4" fill="none" strokeLinecap="round" />
    <path d="M44 20l10 10-14 14-10 0 0-10z" fill={M} /><path d="M44 20l10 10-3 3-10-10z" fill={D} />
    <circle cx="50" cy="50" r="8" fill={M} /><path d="M47 50l2 2 4-4" stroke={W} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </>,
  people: <>
    <circle cx="32" cy="22" r="10" fill={M} /><path d="M14 54c0-10 8-16 18-16s18 6 18 16z" fill={M} />
    <circle cx="14" cy="26" r="7" fill={T} /><path d="M2 52c0-7 5-12 12-12 3 0 5 .8 7 2-4 3-7 7-8 12z" fill={T} />
    <circle cx="50" cy="26" r="7" fill={T} /><path d="M62 52c0-7-5-12-12-12-3 0-5 .8-7 2 4 3 7 7 8 12z" fill={T} />
    <circle cx="32" cy="22" r="10" fill="none" stroke={D} strokeWidth="2" />
  </>,
  verify: <>
    <rect x="12" y="8" width="32" height="42" rx="5" fill={T} />
    <rect x="18" y="16" width="16" height="3" rx="1.5" fill={W} /><rect x="18" y="23" width="20" height="3" rx="1.5" fill={W} /><rect x="18" y="30" width="12" height="3" rx="1.5" fill={W} />
    <circle cx="42" cy="42" r="11" fill={W} stroke={M} strokeWidth="3" /><path d="M50 50l8 8" stroke={M} strokeWidth="4" strokeLinecap="round" />
    <path d="M37 42l3.5 3.5 7-7" stroke={D} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </>,
  templates: <>
    <rect x="18" y="8" width="34" height="24" rx="5" fill={T} />
    <rect x="12" y="18" width="34" height="24" rx="5" fill={M} opacity=".7" />
    <rect x="6" y="28" width="34" height="24" rx="5" fill={M} />
    <circle cx="14" cy="36" r="3" fill={W} /><rect x="20" y="34" width="14" height="3" rx="1.5" fill={W} /><circle cx="14" cy="45" r="3" fill={W} opacity=".7" /><rect x="20" y="43" width="10" height="3" rx="1.5" fill={W} opacity=".7" />
  </>,
  inbox: <>
    <rect x="8" y="14" width="48" height="40" rx="7" fill={T} />
    <path d="M8 36h12l4 6h16l4-6h12" stroke={M} strokeWidth="2.6" fill="none" strokeLinejoin="round" />
    <rect x="20" y="22" width="24" height="3" rx="1.5" fill={W} /><rect x="24" y="29" width="16" height="3" rx="1.5" fill={W} />
    <circle cx="50" cy="16" r="7" fill={D} />
  </>,
};

export function Illustration({ name, size = 56 }: { name: IllustrationName; size?: number }) {
  return <svg className="cs__illus" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">{SCENES[name] ?? SCENES.inbox}</svg>;
}
