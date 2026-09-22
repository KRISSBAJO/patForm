import type { Metadata } from 'next';
import Link from 'next/link';
import { NotMet, TrustPage, TrustSection } from '@/components/TrustPage';

export const metadata: Metadata = {
  title: 'Subprocessors — Patform',
  description: 'Everywhere customer data goes, and what goes there.',
};

const ROWS = [
  {
    name: 'Renviq',
    owner: 'LogaXP',
    purpose: 'The database. Every record, every event, every generated document.',
    reaches: 'All of it, including restricted fields.',
  },
  {
    name: 'RelyKit → AWS SES',
    owner: 'LogaXP',
    purpose: 'Transactional email.',
    reaches:
      'Recipient addresses, subject, body, and any attached document. A template that puts a restricted field in a body does not compile, so what reaches them is bounded by what publishes.',
  },
  {
    name: 'Anthropic or OpenAI',
    owner: 'Configured by you',
    purpose: 'Designing a process, and the operational copilot.',
    reaches:
      'The process schema, never its contents. Nothing at all unless a key is configured.',
  },
  {
    name: 'Your own webhook endpoints',
    owner: 'You',
    purpose: 'Sending events to systems you run.',
    reaches:
      'Only the fields the process names, and it refuses to name restricted ones.',
  },
];

export default function SubprocessorsPage() {
  return (
    <TrustPage
      eyebrow="TRUST"
      title="Subprocessors"
      standfirst="Everywhere customer data goes, and what goes there. Four entries, two of them ours."
    >
      <TrustSection id="who" heading="Who processes what">
        <div className="trust__tableWrap">
          <table className="trust__table">
            <thead>
              <tr>
                <th scope="col">Subprocessor</th>
                <th scope="col">Purpose</th>
                <th scope="col">What reaches them</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.name}>
                  <th scope="row">
                    {row.name}
                    <span className="trust__owner">{row.owner}</span>
                  </th>
                  <td>{row.purpose}</td>
                  <td>{row.reaches}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </TrustSection>

      <TrustSection id="ai" heading="The row people ask about">
        <p>
          A model receives the <em>shape</em> of a process — state names, field names and labels,
          task and approval names — and never the answers inside it. Asked an operational question,
          the model returns a typed plan; a deterministic compiler resolves that plan and runs the
          query, and the rows that come back do not go to the model.
        </p>
        <p>
          This is why the plan language exists. Records contain free text that respondents typed, so
          feeding them to a model would mean feeding it attacker-controlled input on every question.
        </p>
        <p>
          The longer version is on the <Link href="/privacy">privacy page</Link>.
        </p>
      </TrustSection>

      <NotMet
        items={[
          'No advance-notice commitment. There is no published process for telling customers before a subprocessor is added or changed.',
          'Data residency is inherited rather than chosen. Each subprocessor’s region is whatever it is configured with; there is no per-workspace control.',
          'No signed data processing agreements to publish yet.',
        ]}
      />
    </TrustPage>
  );
}
