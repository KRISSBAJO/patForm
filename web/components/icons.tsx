/**
 * Inline stroke icons. They inherit the surrounding colour through
 * `stroke="currentColor"`, so one set works on paper, on ink and on green.
 */

type IconProps = { size?: number; className?: string };

export function Mark({ size = 26 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M7 13.2L11 17L19 9"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ArrowRight({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Clock({ size = 17 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8.5 4.8v4l2.4 1.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function BrokenLink({ size = 20 }: IconProps) {
  return (
    <svg width={size} height="12" viewBox="0 0 20 12" fill="none" aria-hidden="true">
      <path d="M0 6h9M11 6h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function FlowArrow({ size = 14 }: IconProps) {
  return (
    <svg width={size} height="10" viewBox="0 0 14 10" fill="none" aria-hidden="true">
      <path d="M0 5h13M9.5 1.5L13 5l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DownArrow() {
  return (
    <svg width="16" height="22" viewBox="0 0 16 22" fill="none" aria-hidden="true">
      <path d="M8 0v18M3 13l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Tick() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true" style={{ marginTop: 1, flexShrink: 0 }}>
      <circle cx="8.5" cy="8.5" r="7.2" fill="var(--green-pale)" />
      <path d="M5.2 8.7l2.4 2.4 4.2-4.6" stroke="var(--green)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Warn() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true" style={{ marginTop: 1, flexShrink: 0 }}>
      <circle cx="8.5" cy="8.5" r="7.2" fill="var(--ochre-pale)" />
      <path d="M8.5 4.8v4.4M8.5 11.6v.6" stroke="var(--ochre-text)" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function Burger() {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" fill="none" aria-hidden="true">
      <path d="M0 1h20M0 7h20M0 13h20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Paperclip() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M7.5 1.5H3.5a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4.5L7.5 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

/* --------------------------------------------- the eight "what gets built" icons */

const card = { width: 22, height: 22, viewBox: '0 0 22 22', fill: 'none', 'aria-hidden': true } as const;
const S = { stroke: 'var(--green)', strokeWidth: 1.5 } as const;

export function IconData() {
  return (
    <svg {...card}>
      <rect x="2.5" y="3.5" width="17" height="15" rx="2.5" {...S} />
      <path d="M2.5 8.5h17M8.5 8.5v10" {...S} />
    </svg>
  );
}

export function IconForm() {
  return (
    <svg {...card}>
      <rect x="3.5" y="2.5" width="15" height="17" rx="2.5" {...S} />
      <path d="M7 8h8M7 12h8M7 16h4" {...S} strokeLinecap="round" />
    </svg>
  );
}

export function IconWorkflow() {
  return (
    <svg {...card}>
      <circle cx="5" cy="5" r="2.5" {...S} />
      <circle cx="17" cy="11" r="2.5" {...S} />
      <circle cx="5" cy="17" r="2.5" {...S} />
      <path d="M7.2 6.2l7.6 3.6M14.8 12.2l-7.6 3.6" {...S} />
    </svg>
  );
}

export function IconMessages() {
  return (
    <svg {...card}>
      <path d="M3 6.5A2.5 2.5 0 015.5 4h11A2.5 2.5 0 0119 6.5v9a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 013 15.5v-9z" {...S} />
      <path d="M3.5 6l7.5 6 7.5-6" {...S} strokeLinecap="round" />
    </svg>
  );
}

export function IconDocuments() {
  return (
    <svg {...card}>
      <path d="M12.5 2.5H6.5a2 2 0 00-2 2v13a2 2 0 002 2h9a2 2 0 002-2V7.5l-5-5z" {...S} strokeLinejoin="round" />
      <path d="M12.5 2.5v5h5" {...S} strokeLinejoin="round" />
    </svg>
  );
}

export function IconDashboard() {
  return (
    <svg {...card}>
      <path d="M3 18.5h16" {...S} strokeLinecap="round" />
      <rect x="4.5" y="11" width="3.5" height="6" rx="1" {...S} />
      <rect x="10" y="7" width="3.5" height="10" rx="1" {...S} />
      <rect x="15.5" y="3.5" width="3.5" height="13.5" rx="1" {...S} />
    </svg>
  );
}

export function IconPermissions() {
  return (
    <svg {...card}>
      <circle cx="8" cy="7" r="3" {...S} />
      <path d="M3 18c0-2.8 2.2-5 5-5s5 2.2 5 5" {...S} strokeLinecap="round" />
      <path d="M14.5 5.5a3 3 0 010 5.6M16.5 13.5c1.6.8 2.6 2.4 2.6 4.3" {...S} strokeLinecap="round" />
    </svg>
  );
}

export function IconTests() {
  return (
    <svg {...card}>
      <path d="M4 11.5l4.5 4.5L18 6" stroke="var(--green-mint)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
