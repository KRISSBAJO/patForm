'use client';

import './access-state.css';

type Action = { label: string; onClick: () => void };

/** A shared destination for a restricted area, with a reason and a useful next step. */
export function AccessState({ eyebrow = 'ACCESS UPDATE', title, description, steps = [], primary, secondary }: {
  eyebrow?: string;
  title: string;
  description: string;
  steps?: string[];
  primary?: Action;
  secondary?: Action;
}) {
  return <section className="access-state" aria-labelledby="access-state-title">
    <div className="access-state__copy">
      <span className="access-state__eyebrow"><span aria-hidden="true" />{eyebrow}</span>
      <h2 id="access-state-title">{title}</h2>
      <p className="access-state__intro">{description}</p>
      {steps.length > 0 && <div className="access-state__next"><strong>What happens next</strong><ol>{steps.map((step, index) => <li key={step}><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>{step}</li>)}</ol></div>}
      {(primary || secondary) && <div className="access-state__actions">
        {primary && <button type="button" onClick={primary.onClick}>{primary.label}<span aria-hidden="true">↗</span></button>}
        {secondary && <button type="button" className="access-state__secondary" onClick={secondary.onClick}>{secondary.label}</button>}
      </div>}
    </div>
    <div className="access-state__art" aria-hidden="true">
      <svg viewBox="0 0 480 430" fill="none" role="img">
        <ellipse cx="240" cy="373" rx="184" ry="28" fill="#DCE7DE" />
        <circle cx="249" cy="205" r="150" fill="#E5F0E8" />
        <circle cx="348" cy="90" r="35" fill="#D4E9D9" />
        <circle cx="86" cy="184" r="18" fill="#E9CDAE" />
        <rect x="113" y="80" width="247" height="258" rx="24" fill="#164A36" />
        <rect x="122" y="87" width="229" height="242" rx="18" fill="#FFFCF6" />
        <rect x="151" y="111" width="134" height="10" rx="5" fill="#DCE8DE" />
        <rect x="151" y="133" width="93" height="7" rx="3.5" fill="#E7E8DF" />
        <rect x="151" y="175" width="171" height="39" rx="10" fill="#EDF4EC" />
        <rect x="164" y="188" width="16" height="16" rx="8" fill="#2B805A" />
        <path d="m168 196 3 3 5-6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="191" y="190" width="94" height="8" rx="4" fill="#8DB29B" />
        <rect x="151" y="226" width="171" height="39" rx="10" fill="#EDF4EC" />
        <rect x="164" y="239" width="16" height="16" rx="8" fill="#2B805A" />
        <path d="m168 247 3 3 5-6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="191" y="241" width="73" height="8" rx="4" fill="#8DB29B" />
        <rect x="151" y="277" width="171" height="39" rx="10" fill="#F5EBD9" />
        <circle cx="172" cy="296" r="8" fill="#CE9E5A" />
        <path d="M172 292v5l3 2" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
        <rect x="191" y="292" width="106" height="8" rx="4" fill="#BCA785" />
        <g transform="rotate(11 345 282)">
          <rect x="303" y="230" width="91" height="107" rx="17" fill="#225A42" />
          <rect x="318" y="246" width="61" height="69" rx="10" fill="#F7F3E8" />
          <path d="M333 272c0-11 8-19 16-19s16 8 16 19" stroke="#286044" strokeWidth="7" strokeLinecap="round" />
          <rect x="328" y="270" width="42" height="29" rx="6" fill="#286044" />
          <circle cx="349" cy="282" r="4" fill="#F8F3E7" />
        </g>
        <path d="M71 296c12-22 31-34 56-38M396 172c13 7 21 17 25 29" stroke="#6E9D7A" strokeWidth="4" strokeLinecap="round" strokeDasharray="2 11" />
        <circle cx="92" cy="280" r="7" fill="#C89559" />
        <circle cx="415" cy="192" r="7" fill="#2A7655" />
      </svg>
      <span className="access-state__artLabel">YOUR WORKSPACE · ACCESS IN PROGRESS</span>
    </div>
  </section>;
}
