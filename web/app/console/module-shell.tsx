'use client';

import { useEffect, type ReactNode } from 'react';

/**
 * A module as its own place.
 *
 * Expenses, Procurement, HR, Appraisals, Assets & IT and Compliance used to
 * be one page each with a row of tabs across the top. Each is now an area:
 * when you enter it, the rail becomes that module's rail (its sections,
 * with counts), the header carries its colour, and one button takes you
 * back to Patform. The module's own view keeps its state and its rules;
 * the rail only tells it which section to show and learns which sections
 * exist, so nothing about who may see what moves.
 *
 * The colours are deliberately few and quiet: enough to know where you are
 * from the corner of your eye, not a rainbow.
 */

export interface Section { id: string; name: string; count: number | null }

/** What a module view receives from the shell. All optional: without it, the view draws its own tabs. */
export interface ModuleShell {
  section?: string;
  onSection?: (id: string) => void;
  onSections?: (sections: Section[]) => void;
}

export interface Area {
  key: string;
  name: string;
  blurb: string;
  colour: string;
  deep: string;
  tint: string;
  icon: ReactNode;
}

const svg = (d: string) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

export const MODULE_AREAS: Record<string, Area> = {
  expenses: { key: 'expenses', name: 'Expenses', blurb: 'Claims, advances, budgets, payments', colour: '#b4620a', deep: '#7a4206', tint: '#fbf3e8', icon: svg('M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M7 14h4M14 14h3') },
  procurement: { key: 'procurement', name: 'Procurement', blurb: 'Requests, suppliers, orders, invoices', colour: '#1f5fa8', deep: '#143f70', tint: '#eaf1fa', icon: svg('M4 8h16l-1.5 11H5.5zM9 8V6a3 3 0 0 1 6 0v2M9 12v1a3 3 0 0 0 6 0v-1') },
  hr: { key: 'hr', name: 'HR', blurb: 'People, leave, documents, cases', colour: '#7a3e9d', deep: '#512a68', tint: '#f4edf8', icon: svg('M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.3 3-5.5 6.5-5.5s6.5 2.2 6.5 5.5M16.5 10.5a3 3 0 1 0 0-6M21.5 19.5c0-2.6-1.8-4.4-4.5-5') },
  appraisals: { key: 'appraisals', name: 'Appraisals', blurb: 'Goals, reviews, calibration', colour: '#0e7c7b', deep: '#0a5554', tint: '#e8f4f4', icon: svg('M12 3l2.4 5 5.6.8-4 3.9.9 5.6-4.9-2.6-4.9 2.6.9-5.6-4-3.9 5.6-.8zM4 21h16') },
  operations: { key: 'operations', name: 'Assets & IT', blurb: 'Assets, access, tickets, maintenance', colour: '#475569', deep: '#2f3a48', tint: '#eef1f5', icon: svg('M4 5h16a1 1 0 0 1 1 1v9H3V6a1 1 0 0 1 1-1zM2 18h20M9 15v3M15 15v3M10 9h4') },
  meetings: { key: 'meetings', name: 'Meetings', blurb: 'Boards, votes, minutes, resolutions', colour: '#5b4bb7', deep: '#3d3280', tint: '#efedf9', icon: svg('M4 6h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM3 11h18M8 4v4M16 4v4M8 15h3') },
  sign: { key: 'sign', name: 'Patform Sign', blurb: 'Send, sign, seal, verify', colour: '#14663f', deep: '#0f4e30', tint: '#eaf3ed', icon: svg('M4 19h16M5 15l9.5-9.5a2 2 0 0 1 2.8 2.8L7.8 17.8 4 19zM13 7l3 3') },
  compliance: { key: 'compliance', name: 'Compliance', blurb: 'Contracts, policies, controls, audits', colour: '#8a3a34', deep: '#5e2621', tint: '#f8eeec', icon: svg('M12 3l7 2.5v5.5c0 4.6-3 8-7 10-4-2-7-5.4-7-10V5.5zM9 12l2 2 4-4.5') },
};


/*
 * One small mark per section. Sections are named by the modules, so the
 * icon is picked by the section id (with a few synonyms); anything new
 * falls back to a dot rather than to nothing.
 */
const SECTION_PATHS: Record<string, string> = {
  overview: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  calendar: 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4',
  meetings: 'M4 5h16v12H4zM9 21h6M12 17v4',
  resolutions: 'M6 3h9l4 4v14H6zM9 12l2 2 4-4',
  actions: 'M4 12l5 5L20 6',
  register: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  bodies: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 2.7-5 6-5s6 2 6 5M14 15c3 0 6 2 6 5',
  setup: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
  rules: 'M4 6h16M4 12h16M4 18h10',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  leave: 'M3 10h18M5 5h14v15H5zM9 3v4M15 3v4M9 14l2 2 4-4',
  documents: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  read: 'M4 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H4zM20 5h-7a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h8z',
  approve: 'M7 12l3 3 7-7M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  cases: 'M3 7h18v13H3zM9 7V5h6v2M3 13h18',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.3 3-5.5 6.5-5.5s6.5 2.2 6.5 5.5M16.5 10.5a3 3 0 1 0 0-6M21.5 19.5c0-2.6-1.8-4.4-4.5-5',
  team: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.3 3-5.5 6.5-5.5s6.5 2.2 6.5 5.5M16.5 10.5a3 3 0 1 0 0-6M21.5 19.5c0-2.6-1.8-4.4-4.5-5',
  hiring: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-6 8-6M19 15v6M16 18h6',
  upcoming: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  reconcile: 'M4 7h12l-3-3M20 17H8l3 3',
  claims: 'M4 4h16v16H4zM4 9h16M8 14h4',
  mine: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M16 15h2',
  advances: 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  budgets: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  exports: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  requests: 'M8 4h8l4 4v12H4V8zM12 11v6M9 14h6',
  orders: 'M4 8h16l-1.5 11H5.5zM9 8V6a3 3 0 0 1 6 0v2',
  invoices: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  suppliers: 'M3 7h11v10H3zM14 10h4l3 3v4h-7zM7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  agreements: 'M7 3h10v18H7zM10 8h4M10 12h4M10 16h2',
  reviews: 'M12 3l2.4 5 5.6.8-4 3.9.9 5.6-4.9-2.6-4.9 2.6.9-5.6-4-3.9 5.6-.8z',
  goals: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  results: 'M4 19l5-6 4 3 7-9M4 21h16',
  development: 'M12 20V8M8 12l4-4 4 4M5 20h14',
  cycles: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  calibration: 'M4 7h16M4 12h16M4 17h16M8 5v4M14 10v4M11 15v4',
  appeals: 'M12 3l8 4v5c0 5-3.4 8.5-8 9.5C7.4 20.5 4 17 4 12V7zM12 8v5M12 16h.01',
  recommendations: 'M7 11v9H3v-9zM7 11l4-8a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2l-1.5 7a2 2 0 0 1-2 2H7',
  templates: 'M4 4h16v6H4zM4 14h7v6H4zM15 14h5v6h-5z',
  equipment: 'M4 5h16v10H4zM2 18h20M10 9h4',
  access: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v3',
  queue: 'M4 6h16M4 12h16M4 18h16M18 4l2 2-2 2',
  assets: 'M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10',
  maintenance: 'M14.7 6.3a4 4 0 0 0 5 5L13 18a2 2 0 0 1-3 3 2 2 0 0 1 0-3l6.7-6.7a4 4 0 0 0-2-5z',
  changes: 'M4 7h13l-3-3M20 17H7l3 3M12 12h.01',
  findings: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  contracts: 'M7 3h10v18H7zM10 8h4M10 12h4M10 16h4',
  signatures: 'M4 19h16M5 15l9.5-9.5a2 2 0 0 1 2.8 2.8L7.8 17.8 4 19z',
  envelopes: 'M3 6h18v12H3zM3 7l9 6 9-6',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  verify: 'M12 3l7 2.5v5.5c0 4.6-3 8-7 10-4-2-7-5.4-7-10V5.5zM9 12l2 2 4-4.5',
  policies: 'M6 3h9l4 4v14H6zM9 10h7M9 14h7M9 18h4',
  controls: 'M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M7 16v4',
  exceptions: 'M12 3l10 18H2zM12 10v4M12 18h.01',
  audits: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3M8 11l2 2 4-4',
  holds: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  engagement: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
};
const SECTION_SYNONYMS: Record<string, string> = { 'my-tasks': 'tasks', sign: 'signatures', queue: 'queue', register: 'register' };

export function SectionIcon({ id }: { id: string }) {
  const key = SECTION_SYNONYMS[id] ?? id;
  const d = SECTION_PATHS[key];
  if (!d) return <span className="cs__modDot" aria-hidden="true" />;
  return <svg className="cs__secIcon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

/** Lives inside a module view: reports its sections to the shell whenever they change. */
export function ShellSync({ sections, onSections }: { sections: Section[]; onSections?: (sections: Section[]) => void }) {
  const key = JSON.stringify(sections);
  useEffect(() => { onSections?.(JSON.parse(key) as Section[]); }, [key, onSections]);
  return null;
}

export function ModuleRail({ area, sections, current, onPick, onBack }: { area: Area; sections: Section[]; current: string | null; onPick: (id: string) => void; onBack: () => void }) {
  return (
    <>
      <button type="button" className="cs__modBack" onClick={onBack}><span aria-hidden="true">‹</span><span className="cs__navText">Back to Patform</span></button>
      <div className="cs__modHead">
        <span className="cs__modIcon">{area.icon}</span>
        <span className="cs__navText"><strong>{area.name}</strong><small>{area.blurb}</small></span>
      </div>
      <nav className="cs__nav cs__nav--module" aria-label={`${area.name} sections`}>
        {sections.length === 0 && <span className="cs__modEmpty">Loading…</span>}
        {sections.map((s) => (
          <button type="button" key={s.id} className="cs__navItem" title={s.name} aria-current={(current ?? sections[0]?.id) === s.id ? 'page' : undefined} onClick={() => onPick(s.id)}>
            <SectionIcon id={s.id} />
            <span className="cs__navText">{s.name}</span>
            {s.count !== null && s.count > 0 && <span className="cs__navCount">{s.count}</span>}
          </button>
        ))}
      </nav>
    </>
  );
}

/** The same sections as a strip above the content, for phones, where the rail is a drawer. */
export function ModuleStrip({ sections, current, onPick }: { sections: Section[]; current: string | null; onPick: (id: string) => void }) {
  if (!sections.length) return null;
  return (
    <div className="cs__modStrip" role="tablist">
      {sections.map((s) => (
        <button type="button" key={s.id} role="tab" aria-selected={(current ?? sections[0]?.id) === s.id} onClick={() => onPick(s.id)}>
          <SectionIcon id={s.id} />{s.name}{s.count !== null && s.count > 0 && <span>{s.count}</span>}
        </button>
      ))}
    </div>
  );
}
