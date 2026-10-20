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
            <span className="cs__modDot" aria-hidden="true" />
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
          {s.name}{s.count !== null && s.count > 0 && <span>{s.count}</span>}
        </button>
      ))}
    </div>
  );
}
