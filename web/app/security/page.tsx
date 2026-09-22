import type { Metadata } from 'next';
import Link from 'next/link';
import { NotMet, TrustPage, TrustSection } from '@/components/TrustPage';

export const metadata: Metadata = {
  title: 'Security — Patform',
  description: 'How access is decided, what cannot be edited, and what happens when things fail.',
};

export default function SecurityPage() {
  return (
    <TrustPage
      eyebrow="TRUST"
      title="Security"
      standfirst="How access is decided, what cannot be changed after the fact, and what we have actually tested rather than intended."
    >
      <TrustSection id="access" heading="Permission is decided by the runtime, not by the screen">
        <p>
          Every action checks the permission model before it runs. The console hides what you cannot
          do, but hiding is a convenience — the same request made directly is refused by the same
          check, and the refusal is written to the audit trail with who asked and what for.
        </p>
        <ul>
          <li>Deny by default. A capability nobody was granted is held by nobody.</li>
          <li>
            Permission reaches individual fields. A role can be allowed to see a record and not one
            column of it, and a field hidden from a role is absent from what the API returns rather
            than hidden in the browser.
          </li>
          <li>
            A workspace role never grants the ability to approve. Approving is granted per process,
            by name, and somebody cannot approve their own submission.
          </li>
          <li>
            A respondent following a resume link is scoped to one record. Without that scope the
            link would open every record in the workspace.
          </li>
        </ul>
      </TrustSection>

      <TrustSection id="credentials" heading="Credentials">
        <ul>
          <li>Passwords are hashed with scrypt. A sign-in for an unknown address does the same work as a real one, so response time does not reveal whether an account exists.</li>
          <li>
            Sessions are opaque tokens; only a hash is stored, so a dump of the session table cannot
            be replayed as a login.
          </li>
          <li>
            Invitation, verification and reset links are single-use, expire, and are stored only as
            hashes. Spending a reset link signs the account out everywhere else.
          </li>
          <li>
            A password reset answers identically for an address with an account and one without.
            Anything that varied would let a stranger enumerate who works here.
          </li>
          <li>Deactivating a member revokes their live sessions in the same transaction.</li>
        </ul>
      </TrustSection>

      <TrustSection id="integrity" heading="What cannot be changed after the fact">
        <ul>
          <li>
            A published process version cannot be edited — not by an administrator, not by a support
            engineer, not by a migration script. The database refuses the write. A finished record
            keeps the rules it was decided under.
          </li>
          <li>
            History is appended, never overwritten. A correction is a new entry beside the old one.
          </li>
          <li>
            Every action carries a key tied to the occurrence that caused it, so a retried job does
            not send a second email or generate a second document.
          </li>
          <li>
            Generated documents are stored with a checksum, and an export is reproducible: the same
            record exported twice produces the same checksum.
          </li>
        </ul>
      </TrustSection>

      <TrustSection id="tested" heading="What has been tested, not intended">
        <p>
          The claims above are each backed by an executable proof that runs against a real database
          and fails the build if it stops holding. The current run is twenty-three of them.
        </p>
        <p>
          Recovery is a drill rather than a document: it takes a backup, destroys the database,
          restores it, and replays the jobs that were in flight — then reports what was lost inside
          the recovery window, including messages that had already reached real inboxes and will be
          sent again when the work is redone.
        </p>
        <p>
          Accessibility is checked the same way, across seventeen flows on every run. The findings
          and the gaps are in the repository rather than summarised here.
        </p>
      </TrustSection>

      <NotMet
        items={[
          'No multi-factor authentication yet. It is the last unmet row in the authentication requirements.',
          'No SSO provider is wired up. The identity model accommodates one — external identities match on the provider’s subject, never the email address — but nothing is connected.',
          'No uploaded-file malware scanning. Files are recorded as metadata; the bytes are not scanned.',
          'No penetration test, and no third-party audit or certification.',
          'No point-in-time recovery. Restores go to the last backup, and the drill reports exactly what that costs.',
          'The effect log lives in the same database as the data it describes.',
        ]}
      />

      <p className="trust__aside">
        Privacy, the data map and erasure are on the <Link href="/privacy">privacy page</Link>; who
        processes what is on <Link href="/subprocessors">subprocessors</Link>.
      </p>
    </TrustPage>
  );
}
