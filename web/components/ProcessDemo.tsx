'use client';

import { useState } from 'react';
import Link from 'next/link';

const steps = [
  { title: 'Describe', detail: 'Tell PatForm what needs to happen.' },
  { title: 'Draft', detail: 'Review the form and workflow together.' },
  { title: 'Approve', detail: 'The right person gets the next action.' },
  { title: 'Outcome', detail: 'Follow the work through to completion.' },
] as const;

const route = ['Intake', 'Manager', 'Equipment', 'HR notified'] as const;

export function ProcessDemo() {
  const [active, setActive] = useState(0);

  return <section className="processDemo" id="demo" aria-labelledby="process-demo-title">
    <div className="shell">
      <div className="processDemo__intro">
        <div><span className="eyebrow">A GUIDED PRODUCT EXAMPLE</span><h2 id="process-demo-title">From one description to a finished outcome.</h2></div>
        <p>Explore a sample employee onboarding process. This is an illustrative walkthrough; your own process is editable before it goes live.</p>
      </div>
      <div className="processDemo__frame">
        <div className="processDemo__tabs" role="group" aria-label="Process example stages">
          {steps.map((step, index) => <button key={step.title} type="button" aria-pressed={active === index} className={active === index ? 'is-active' : ''} onClick={() => setActive(index)}><span>{String(index + 1).padStart(2, '0')}</span><strong>{step.title}</strong></button>)}
        </div>
        <div className="processDemo__body">
          <div className="processDemo__copy">
            <span className="processDemo__kicker">{String(active + 1).padStart(2, '0')} / 04 · {steps[active].title}</span>
            <h3>{steps[active].detail}</h3>
            <p>{[
              'Start with the work in plain language. Include what people submit, who makes decisions, and what should happen afterward.',
              'The proposal includes fields, states, assignments, notifications, and checks. You can inspect and change every part.',
              'A submitted record moves to an assigned task. The reviewer sees the context, deadline, and available decisions.',
              'The record keeps its decisions and history. The team sees what arrived, what needs action, and what is late.',
            ][active]}</p>
            <button type="button" className="processDemo__next" onClick={() => setActive((active + 1) % steps.length)}>{active === 3 ? 'Start again' : `Next: ${steps[active + 1].title}`} <span aria-hidden="true">→</span></button>
          </div>
          <div className="processDemo__screen" role="region" aria-label={`${steps[active].title} example`}>
            <div className="processDemo__screenBar"><span className="processDemo__screenMark">✳</span><strong>PatForm</strong><span>Employee onboarding</span><i>EXAMPLE</i></div>
            {active === 0 && <div className="processDemo__mock"><small>DESCRIBE YOUR PROCESS</small><div className="processDemo__prompt">When a new employee joins, collect their details and documents. Ask their manager to approve the request, assign equipment, and notify HR when onboarding is complete.</div><div className="processDemo__route"><div className="processDemo__routeHead"><strong>Route preview</strong><span>Illustrative example</span></div><div className="processDemo__routeSteps" aria-label="Example route: intake, manager review, equipment, HR notified"><span className="processDemo__routeLine" aria-hidden="true"><i/></span>{route.map((name, index) => <span className="processDemo__routeStop" key={name}><span className={index === 0 ? 'is-start' : ''} aria-hidden="true"/><small>{name}</small></span>)}</div></div><div className="processDemo__mockFoot"><span>New starter intake</span><button type="button" className="processDemo__mockButton" onClick={() => setActive(1)}>View draft →</button></div></div>}
            {active === 1 && <div className="processDemo__mock"><small>PRIVATE DRAFT · READY TO REVIEW</small><div className="processDemo__draft"><div><strong>Form</strong><span>Personal details</span><span>Start date and role</span><span>Required documents</span></div><div><strong>Workflow</strong><span>Manager review</span><span>Equipment request</span><span>HR confirmation</span></div></div><div className="processDemo__check">✓ &nbsp;Questions and workflow checked before publishing</div></div>}
            {active === 2 && <div className="processDemo__mock"><small>MY WORK · NEEDS YOU</small><div className="processDemo__task"><span className="processDemo__taskIcon">AO</span><div><strong>Amara Okafor</strong><span>New starter · Manager review</span></div><b>Due today</b></div><div className="processDemo__taskInfo"><span>Start date</span><strong>12 October</strong><span>Requested equipment</span><strong>Laptop and access</strong></div><div className="processDemo__taskActions"><span>Manager decision</span><button type="button" onClick={() => setActive(3)}>See approved outcome →</button></div></div>}
            {active === 3 && <div className="processDemo__mock"><small>PROCESS OVERVIEW</small><div className="processDemo__metrics"><div><span>ARRIVED</span><strong>24</strong></div><div><span>NEEDS YOU</span><strong>3</strong></div><div><span>LATE</span><strong>2</strong></div></div><div className="processDemo__timeline"><div><b>✓</b><span>Submitted</span><small>Amara Okafor</small></div><div><b>✓</b><span>Manager approved</span><small>Decision recorded</small></div><div><b>•</b><span>Equipment underway</span><small>Next action assigned</small></div></div></div>}
          </div>
        </div>
      </div>
      <div className="processDemo__end"><span>Want to build one for your team?</span><Link href="/builder/new">Start with your own process <span aria-hidden="true">→</span></Link></div>
    </div>
  </section>;
}
