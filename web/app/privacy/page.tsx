import type { Metadata } from 'next';
import Link from 'next/link';
import { NotMet, TrustPage, TrustSection } from '@/components/TrustPage';

export const metadata: Metadata = {
  title: 'Privacy — Patform',
  description: 'What Patform holds, where it goes, how long it is kept, and how it is erased.',
};

export default function PrivacyPage() {
  return (
    <TrustPage
      eyebrow="TRUST"
      title="Privacy"
      standfirst="What we hold, where it goes, how long it stays, and what happens when somebody asks for it to be removed."
    >
      <TrustSection id="data-map" heading="The data map is derived, not written">
        <p>
          Every process declares its fields, each with a data classification and — for anything
          classified restricted — a reason it is collected at all. The map of what a workspace holds
          is computed from the <em>published</em> version of each process rather than maintained by
          hand, so it cannot drift from what the system actually does.
        </p>
        <p>
          It also traces where each value goes: which emails quote it, which documents contain it,
          which webhook payloads carry it off the platform. On the reference onboarding process one
          field reaches eleven destinations, one of which leaves the platform entirely.
        </p>
        <p>
          A workspace member with reporting permission can run it against their own workspace.
          Somebody without is refused.
        </p>
      </TrustSection>

      <TrustSection id="minimisation" heading="The compiler refuses some things outright">
        <ul>
          <li>
            A restricted field in an email body, a webhook payload, or a document that leaves the
            platform is a compile error, not a warning. The process does not publish.
          </li>
          <li>
            A restricted field with no stated reason for collecting it is a compile error.
          </li>
          <li>
            Every process declares the highest data class it may hold. A field above that ceiling is
            a compile error — so a health-adjacent field cannot arrive by accident inside a routine
            form.
          </li>
        </ul>
      </TrustSection>

      <TrustSection id="retention" heading="Retention comes from the published process">
        <ul>
          <li>The period is read from the published blueprint, so nobody deletes faster than the process promised.</li>
          <li>It runs from completion. A record still in progress is never touched.</li>
          <li>
            The account of what was removed is written <strong>before</strong> the deletion, in the
            same transaction — so the record of what happened outlives the data.
          </li>
          <li>
            A dry run executes the whole thing and rolls it back, which is the only honest way to
            answer “what would this delete?”
          </li>
          <li>
            A process that declares no retention period is kept indefinitely, and the data map says
            so in plain words rather than leaving a blank.
          </li>
        </ul>
      </TrustSection>

      <TrustSection id="erasure" heading="Erasure distinguishes a subject from a mention">
        <p>
          Somebody can be the <em>subject</em> of a record — it is about them — or merely{' '}
          <em>mentioned</em> in one, as the manager who approved it. Erasing a subject removes the
          record and its history. Erasing a mention redacts the value in place, so the audit trail
          still shows that a manager was asked and answered, without naming them.
        </p>
        <p>
          A record still running is left alone, and the request says so. Erasure requires
          administrative permission; an operator is refused.
        </p>
        <p>
          Erasure is per workspace. A person in two workspaces needs two requests — correctly, since
          the controllers are different — and there is no way for them to discover that.
        </p>
      </TrustSection>

      <TrustSection id="ai" heading="What reaches a model, exactly">
        <p>
          <strong>Designing a process</strong> sends the description somebody typed. That is business
          text, not anybody&rsquo;s personal data.
        </p>
        <p>
          <strong>The operational copilot</strong> sends the <em>schema</em> — state names, field
          names and labels, task and approval names. It does not send a single answer. The model
          produces a typed query plan; a deterministic compiler resolves that plan and runs the
          query. The model never sees the rows that come back.
        </p>
        <p>
          That is the reason the plan language exists rather than a convenience: the records being
          queried contain free text that respondents typed, so anything that fed them to a model
          would be feeding it attacker-controlled input on every question.
        </p>
        <p>
          <strong>Nothing is sent to any model provider unless a key is configured.</strong> With
          none set, both features are unavailable and say so.
        </p>
        <p>
          The full list of who processes what is on the{' '}
          <Link href="/subprocessors">subprocessors page</Link>.
        </p>
      </TrustSection>

      <NotMet
        items={[
          'Privacy terms are not written.',
          'No data protection impact assessment. Compliance depends on controls, practice, contracts, evidence, training and audits — not on a feature list.',
          'AI interaction logs have no retention period. They are kept indefinitely.',
          'No subject access export. A member can export a record they can see; a data subject asking what is held about them has no self-serve route.',
          'No consent capture or withdrawal. Where a controller relies on consent, a process has nowhere to record that it was given.',
        ]}
      />
    </TrustPage>
  );
}
