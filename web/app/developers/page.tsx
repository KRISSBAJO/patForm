import type { Metadata } from 'next';
import Link from 'next/link';
import { NotMet, TrustPage, TrustSection } from '@/components/TrustPage';

export const metadata: Metadata = {
  title: 'Developers — Patform',
  description: 'The REST API, signed webhooks, and getting your data back out.',
};

export default function DevelopersPage() {
  return (
    <TrustPage
      eyebrow="DEVELOPERS"
      title="The API, webhooks and export"
      standfirst="A versioned REST API, webhooks you can verify, and an export that does not need us to read it."
    >
      <TrustSection id="api" heading="REST API">
        <p>
          Everything lives under <code>/v1</code>, served separately from the console so an
          integration cannot accidentally reach an endpoint meant for a signed-in person. The schema
          is published as OpenAPI 3.1 at <code>/openapi.json</code>, generated from the same
          definitions the server routes with.
        </p>
        <ul>
          <li>
            <strong>Scoped keys.</strong> A key carries the permissions it was created with, and
            they are intersected with the role it acts as — so a key cannot outlive the permissions
            of the person who made it.
          </li>
          <li>
            <strong>Cursor pagination.</strong> Not offset. A record created while you page does not
            make you skip one or read one twice. The console browses records through the same
            pagination, so one behaviour is tested twice rather than two behaviours once.
          </li>
          <li>
            <strong>Idempotency keys</strong> on writes. Retrying a create after a timeout returns
            the original result instead of making a second record.
          </li>
          <li>
            <strong>Fields you may not read are absent</strong>, and the response names them in an{' '}
            <code>omitted_fields</code> list, so an integration can tell the difference between a
            field that is empty and one it is not allowed to see.
          </li>
          <li>
            <strong>OAuth 2.0 with PKCE</strong> for applications acting on behalf of a person.
            Refresh tokens rotate, and re-use of a spent one revokes the whole grant.
          </li>
        </ul>
      </TrustSection>

      <TrustSection id="webhooks" heading="Webhooks">
        <p>
          Events are signed with HMAC-SHA256 over the timestamp and the exact request body, in the
          header layout Stripe uses — so an existing verification routine works unchanged.
        </p>
        <ul>
          <li>
            The timestamp is inside the signed string <em>and</em> checked against a tolerance, so a
            captured request cannot be replayed tomorrow.
          </li>
          <li>
            Rotating a secret signs with both for an overlap, so a consumer that has not redeployed
            keeps working.
          </li>
          <li>
            Failed deliveries retry with backoff and then stop, and a dead-lettered delivery can be
            replayed from the console once the endpoint is fixed.
          </li>
          <li>
            Payloads carry only the fields the process explicitly names, and a process that names a
            restricted field does not publish.
          </li>
          <li>Slack and Microsoft Teams endpoints post a card instead, carrying a reference rather than the answers.</li>
        </ul>
      </TrustSection>

      <TrustSection id="export" heading="Getting your data out">
        <p>
          Records, answers, files, the process schema and the full audit history export in standard
          formats. An export is reproducible — the same record exported twice produces the same
          checksum — which is what makes it usable as evidence rather than just as a copy.
        </p>
        <p>
          Values you were not allowed to see are withheld rather than silently blanked, and listed,
          so an export never misrepresents itself as complete.
        </p>
        <p>
          It runs on managed PostgreSQL with no proprietary database layer, so the underlying data
          is readable without us.
        </p>
      </TrustSection>

      <NotMet
        items={[
          'No published SDKs. The OpenAPI document is the contract; there is no generated client.',
          'No sandbox environment. There is one set of keys against real data.',
          'Webhook delivery is at-least-once and unordered. Consumers have to be idempotent, and the event id is what to key on.',
          'No GraphQL, no bulk endpoints, and no streaming.',
        ]}
      />

      <p className="trust__aside">
        How access is decided is on the <Link href="/security">security page</Link>.
      </p>
    </TrustPage>
  );
}
