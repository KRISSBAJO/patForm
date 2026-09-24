import Link from 'next/link';
import { Footer } from '@/components/Footer';
import { Nav } from '@/components/Nav';

const principles = [
  { number: '01', title: 'Actions are safe to retry', body: 'Messages, documents and payment handoffs carry an identity tied to the event that caused them. A failed attempt can be retried without treating it as a new decision.' },
  { number: '02', title: 'Decisions keep their rules', body: 'Each completed record remains connected to the published process version used at the time. New changes do not rewrite an earlier decision.' },
  { number: '03', title: 'History is added, not overwritten', body: 'Corrections, approvals, comments and changes remain in the record, so a team can inspect how an outcome was reached.' },
  { number: '04', title: 'Your data can leave with you', body: 'Responses, files, schemas and audit history can be exported in standard formats. The process should remain understandable outside PatForm.' },
];

export default function ReliabilityPage() {
  return <><Nav /><main className="reliabilityPage"><section className="shell reliabilityPage__hero"><span className="eyebrow">RELIABILITY AT PATFORM</span><h1>Work needs to stay right after it starts moving.</h1><p>Drafting a process is only the beginning. The harder job is keeping every action, decision and record understandable when people change the process or something fails.</p><Link className="btn btn--secondary" href="/#demo">See a process in action →</Link></section><section className="shell reliabilityPage__list" aria-label="Reliability principles">{principles.map(item=><article key={item.number}><span>{item.number}</span><div><h2>{item.title}</h2><p>{item.body}</p></div></article>)}</section><section className="shell reliabilityPage__end"><h2>Review the process before it goes live.</h2><p>PatForm checks the draft, and you decide when to publish it.</p><Link className="btn btn--primary" href="/signup">Create a workspace →</Link></section></main><Footer /></>;
}
