'use client';

/**
 * What is inside a pack.
 *
 * The first version was a definition list of counts — eight rows of "14
 * fields", "7 states". Counts answer *how much*, and the only question
 * somebody has here is *what happens*. So this leads with the path a record
 * takes, drawn, and puts the numbers underneath where they belong.
 *
 * Then it was a modal, which was the wrong container for the same reason the
 * gallery stopped being one: this is a screenful of reading that somebody
 * compares against another pack, sends to a colleague, and comes back to.
 * None of that survives a dialog. It has its own page now, and this file
 * holds only the contents of it — `PackBody` — so nothing about the layout
 * had to be rewritten to move it.
 */

import type { Pack } from './PackCard';

const CEILING: Record<string, string> = {
  public: 'nothing sensitive',
  internal: 'internal information',
  confidential: 'personal details',
  restricted: 'sensitive personal data',
};

export function PackBody({ pack }: { pack: Pack }) {
  const c = pack.contents;
  // Same reason as the card: a pack published before previews existed still
  // has to open rather than throw.
  const preview = c.preview ?? { flow: [], askedFor: [], deciders: [] };
  const years = c.policy.retentionDays ? Math.round(c.policy.retentionDays / 365) : null;

  return (
    <>
          {/* The audience line is in the page header, above the title's rule.
              It was here as well, so the page opened by saying the same
              sentence twice. */}
          <p className="pd__summary">{pack.summary}</p>

          <section className="pd__section">
            <h3>What happens to a record</h3>
            {/* The path, drawn. Labelled as a list for a screen reader,
                because the arrows are decoration and the order is the point. */}
            <ol className="pd__flow">
              {preview.flow.map((s, i) => (
                <li key={i} className={`pd__step pd__step--${s.kind}`}>
                  <span className="pd__stepDot" aria-hidden="true" />
                  <span className="pd__stepName">{s.name}</span>
                  <span className="pd__stepKind">
                    {s.kind === 'initial'
                      ? 'the form'
                      : s.kind === 'active'
                        ? 'waiting on somebody'
                        : s.kind === 'success'
                          ? 'finished'
                          : s.kind}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <div className="pd__cols">
            <section className="pd__section">
              <h3>What it asks for</h3>
              <ul className="pd__list">
                {preview.askedFor.map((label) => (
                  <li key={label}>{label}</li>
                ))}
                {c.fields > preview.askedFor.length && (
                  <li className="pd__more">and {c.fields - preview.askedFor.length} more</li>
                )}
              </ul>
            </section>

            <section className="pd__section">
              <h3>Who decides</h3>
              <ul className="pd__list">
                {preview.deciders.length ? (
                  preview.deciders.map((d) => <li key={d}>{d}</li>)
                ) : (
                  <li>Nobody — it completes on submission.</li>
                )}
              </ul>
              <h3 className="pd__subhead">Who is involved</h3>
              <ul className="pd__list">
                {c.roles.map((r) => (
                  <li key={r.key}>
                    {r.name}
                    {r.kind === 'respondent' && <span className="pd__tag">fills the form in</span>}
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/*
            * The part that makes this a process rather than a form.
            *
            * The category enforces it — the escalation path, the retention
            * floor, the threshold tier — and the build fails if a pack in
            * that category does not carry it. Worth saying on the page,
            * because it is the reason to take a pack rather than draw a form.
            */}
          {c.guarantees && (
            <section className="pd__section pd__guarantee">
              <h3>What {pack.category} enforces</h3>
              <p className="pd__says">{c.guarantees.says}</p>
              <ul className="pd__checks">
                {c.guarantees.controls.map((control) => (
                  <li key={control}>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 10.6 8.2 15 16 5.6" />
                    </svg>
                    {control}
                  </li>
                ))}
              </ul>
              <p className="pd__note" style={{ marginTop: 12 }}>
                Every pack in this category is checked against these before it can ship. A pack that
                stops carrying one fails the build rather than reaching you.
              </p>
            </section>
          )}

          <section className="pd__section">
            <h3>What comes with it</h3>
            <div className="pd__counts">
              <span>
                <strong>{c.fields}</strong> questions
              </span>
              <span>
                <strong>{c.states}</strong> states
              </span>
              <span>
                <strong>{c.emails}</strong> message templates
              </span>
              <span>
                <strong>{c.tasks}</strong> tasks
              </span>
              <span>
                <strong>{c.metrics}</strong> dashboard measures
              </span>
              <span>
                <strong>{c.scenarios}</strong> test scenarios
              </span>
            </div>
          </section>

          <section className="pd__section pd__policy">
            <h3>Data and retention</h3>
            <p>
              Holds up to <strong>{CEILING[c.policy.sensitivityCeiling] ?? c.policy.sensitivityCeiling}</strong>.
              {c.policy.restrictedFields > 0 && (
                <>
                  {' '}
                  {c.policy.restrictedFields} field{c.policy.restrictedFields === 1 ? ' is' : 's are'}{' '}
                  restricted — the compiler refuses to put any of them in an email, a webhook or a
                  document that leaves the platform.
                </>
              )}{' '}
              {years
                ? `Records are deleted ${years} year${years === 1 ? '' : 's'} after they finish.`
                : 'Records are kept indefinitely — nothing deletes them.'}
            </p>
            <p className="pd__note">
              {/* §1.2's sentence, which is the whole argument for a pack. */}
              A form template gives you fields. This gives you the approvals, the reminders, the
              permissions and the retention as well — and the compiler checks all of it before it
              can go live.
            </p>
          </section>
    </>
  );
}
