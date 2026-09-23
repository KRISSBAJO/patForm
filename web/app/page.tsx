import Link from 'next/link';
import { Footer } from '@/components/Footer';
import { Nav } from '@/components/Nav';
import {
  ArrowRight,
  BrokenLink,
  Clock,
  DownArrow,
  FlowArrow,
  IconDashboard,
  IconData,
  IconDocuments,
  IconForm,
  IconMessages,
  IconPermissions,
  IconTests,
  IconWorkflow,
  Paperclip,
  Tick,
  Warn,
} from '@/components/icons';

const TOOLCHAIN = ['Form tool', 'Spreadsheet', 'Email threads', 'Shared drive', 'E-signature', 'Calendar'];

const BUILT = [
  { Icon: IconData, title: 'Data model', copy: 'Typed fields, constraints, and a sensitivity class on every one of them.' },
  { Icon: IconForm, title: 'The form', copy: 'Pages, branching, save and resume, and an accessible respondent experience.' },
  { Icon: IconWorkflow, title: 'The workflow', copy: 'States, approvals, tasks, timers and exception paths — inspectable, not implied.' },
  { Icon: IconMessages, title: 'The messages', copy: 'Who gets told what, when, and a delivery log that says whether it landed.' },
  { Icon: IconDocuments, title: 'The documents', copy: 'Packets and certificates, generated once, stored with a checksum and a version.' },
  { Icon: IconDashboard, title: 'The dashboard', copy: 'Intake, cycle time, what is aging and what failed — defined once, versioned.' },
  { Icon: IconPermissions, title: 'The permissions', copy: 'Who may submit, see, edit, approve and report — down to individual fields.' },
];

const RELIABILITY = [
  {
    title: 'Actions run once, even when everything retries',
    copy: 'Every email, document and payment hand-off carries a key tied to the occurrence that caused it. A reminder that should fire twice does. A delivery retried three times does not.',
  },
  {
    title: 'A finished record keeps the rules it was decided under',
    copy: 'Published versions cannot be edited — not by an admin, not by a support engineer, not by a migration script. Change the process tomorrow and last year’s decision still reads correctly.',
  },
  {
    title: 'History is added to, never overwritten',
    copy: 'A correction is a new entry beside the old one. When someone asks why a decision was made, the answer is in the record rather than in somebody’s memory.',
  },
  {
    title: 'Your data leaves as easily as it arrived',
    copy: 'Responses, files, schemas and audit history export in standard formats. Built on managed PostgreSQL, with no proprietary database layer to unpick.',
  },
];

const QUEUE = [
  { id: 'ONB-2291', name: 'Amara Okafor', stage: 'Compliance review', badge: '6H', tone: 'waiting' },
  { id: 'ONB-2288', name: 'Daniel Wu', stage: 'Manager review', badge: '3D LATE', tone: 'late' },
  { id: 'ONB-2285', name: 'Rachel Osei', stage: 'Equipment & accounts', badge: 'ON TRACK', tone: 'ok' },
] as const;

export default function Home() {
  return (
    <>
      <Nav />

      <main id="top">
        {/* ====================================================== hero */}
        <section className="shell hero">
          <div className="hero__copy">
            <div className="pill">
              <span className="pill__dot" aria-hidden="true" />
              <span className="pill__text">Process platform for operational teams</span>
            </div>

            <h1>Describe the process. Launch the whole operation.</h1>

            <p className="hero__sub">
              The intake form, the approvals, the reminders, the documents and the dashboard — created together from
              one description, then <em>run together</em> for as long as you need them.
            </p>

            <div className="hero__cta">
              <a className="btn btn--primary" href="#lighthouse">
                Join the lighthouse program
              </a>
              <a className="btn btn--secondary" href="#how">
                Watch a process run
                <ArrowRight />
              </a>
            </div>

            <p className="hero__note">
              Eight to twelve organizations. We build your first process with you, not for you to figure out alone.
            </p>
          </div>

          {/*
            * The product, as an object.
            *
            * This was a live record card — real markup, real data, and a
            * rectangle. What it could not show is the thing the product
            * actually claims: that the form, the workflow, the documents and
            * the dashboard are one stack built together, not four tools in a
            * row. A picture can say that in a second.
            *
            * `eager` and `fetchPriority`, because this is the largest element
            * above the fold and lazy-loading it is loading it late. The width
            * and height are the file's own, so nothing below it jumps while
            * it arrives.
            */}
          <div className="hero__art">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/hero-stack.webp"
              srcSet="/hero-stack@half.webp 512w, /hero-stack.webp 1024w"
              sizes="(max-width: 900px) 92vw, 46vw"
              width={1024}
              height={846}
              loading="eager"
              fetchPriority="high"
              alt="One onboarding record shown as a stack of layers: the case and its timeline on top, the workflow that routes it beneath, and the portfolio view it rolls up into below that."
            />
          </div>
        </section>

        {/* =================================================== problem */}
        <section className="band">
          <div className="shell band__grid">
            <div className="band__copy">
              <h2>
                Nobody needs a form.
                <br />
                They need the outcome.
              </h2>
              <p>
                Onboard the employee. Approve the expense. Register the member. Certify the participant. Today that
                outcome is assembled across six tools and a lot of chasing.
              </p>
              <p>
                What you get back is fragmented ownership, duplicated data, missed handoffs — and no trustworthy record
                of why a decision was made.
              </p>
            </div>

            <div className="band__right">
              <div className="toolchain">
                {TOOLCHAIN.map((tool, i) => (
                  <span key={tool} style={{ display: 'contents' }}>
                    <span className="chip">{tool}</span>
                    {i < TOOLCHAIN.length && (
                      <span className="toolchain__arrow" aria-hidden="true">
                        <BrokenLink />
                      </span>
                    )}
                  </span>
                ))}
                <span className="chip chip--warn">Someone chasing it</span>
              </div>

              <blockquote className="pullquote">
                <p>“Where is this one, and who has it?” should not be a question that takes forty minutes to answer.</p>
              </blockquote>
            </div>
          </div>
        </section>

        {/* ===================================================== shift */}
        <section className="shell section" id="how">
          <div className="sectionHead">
            <span className="eyebrow">01 — The shift</span>
            <span className="rule" aria-hidden="true" />
          </div>

          <div className="shift">
            <article className="shiftCard shiftCard--before">
              <span className="shiftCard__tag">EVERY FORM TOOL</span>
              <h3>A form ends at submission.</h3>
              <p>
                You get rows. Everything that makes the rows matter — the routing, the decision, the document, the
                follow-up — is yours to arrange somewhere else.
              </p>
              <div className="shiftCard__dead">
                <span className="chip chip--quiet" style={{ background: 'var(--line-soft)', color: 'var(--muted)' }}>
                  Submitted
                </span>
                <span aria-hidden="true">·</span>
                <span>nothing further</span>
              </div>
            </article>

            <article className="shiftCard shiftCard--here">
              <span className="shiftCard__tag">HERE</span>
              <h3>A submission begins a process.</h3>
              <p>
                The same moment creates a case with a state, an owner, a deadline, an audit trail and a next action. The
                work is in the system, not in someone’s inbox.
              </p>
              <div className="shiftCard__states">
                {['Submitted', 'Approved', 'Provisioned'].map((state) => (
                  <span key={state} style={{ display: 'contents' }}>
                    <span className="chip chip--state">{state}</span>
                    <span style={{ color: 'var(--green)', display: 'flex' }} aria-hidden="true">
                      <FlowArrow />
                    </span>
                  </span>
                ))}
                <span className="chip chip--state chip--done">Done</span>
              </div>
            </article>
          </div>
        </section>

        {/* ================================================== what gets built */}
        <section className="shell section">
          <div className="sectionHead">
            <span className="eyebrow">02 — From one description</span>
            <span className="rule" aria-hidden="true" />
          </div>
          <h2>Seven things get built at once, and they already agree with each other.</h2>

          <div className="cards">
            {BUILT.map(({ Icon, title, copy }) => (
              <article className="card" key={title}>
                <Icon />
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
            <article className="card card--dark">
              <IconTests />
              <h3>And the tests</h3>
              <p>Happy path, rejection, missing data, timeout, duplicate, permission. Run before you publish.</p>
            </article>
          </div>
        </section>

        {/* =================================================== console */}
        <section className="console">
          <div className="shell console__grid">
            <div className="console__copy">
              <span className="eyebrow" style={{ color: 'var(--on-dark-5)' }}>
                03 — After it launches
              </span>
              <h2>The morning screen answers four questions.</h2>
              <p className="console__lede">
                Not a generic analytics dashboard. What arrived, what needs you, what is late, and what broke — before
                anything else competes for your attention.
              </p>

              <div className="console__points">
                {[
                  'Ask a plain question and get an answer drawn from the records you are allowed to see.',
                  'Propose a bulk action and see exactly who it touches before anything is sent.',
                  'Every failed automation is visible, explained, and safe to replay.',
                ].map((point) => (
                  <div className="console__point" key={point}>
                    <span aria-hidden="true" />
                    <p>{point}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="window">
              <div className="window__bar">
                <span className="window__dot" style={{ background: 'var(--red-border)' }} />
                <span className="window__dot" style={{ background: 'var(--ochre-border)' }} />
                <span className="window__dot" style={{ background: '#a9c9b4' }} />
                <span className="mono" style={{ marginLeft: 10, fontSize: 11.5, color: 'var(--muted)' }}>
                  Employee onboarding · September
                </span>
              </div>

              <div className="tiles">
                <div className="tile">
                  <div className="tile__label">ARRIVED</div>
                  <div className="tile__value">24</div>
                  <div className="tile__meta">this month</div>
                </div>
                <div className="tile tile--needs">
                  <div className="tile__label">NEEDS YOU</div>
                  <div className="tile__value">3</div>
                  <div className="tile__meta">approvals waiting</div>
                </div>
                <div className="tile tile--late">
                  <div className="tile__label">LATE</div>
                  <div className="tile__value">2</div>
                  <div className="tile__meta">past their SLA</div>
                </div>
                <div className="tile">
                  <div className="tile__label">FAILED</div>
                  <div className="tile__value">0</div>
                  <div className="tile__meta">automations</div>
                </div>
              </div>

              <div className="queue">
                {QUEUE.map((row) => (
                  <div className="queue__row" key={row.id}>
                    <span className="queue__id">{row.id}</span>
                    <span className="queue__name">{row.name}</span>
                    <span className="queue__stage">{row.stage}</span>
                    <span className={`badge badge--${row.tone}`}>{row.badge}</span>
                  </div>
                ))}
              </div>

              <div className="ask">
                <span style={{ color: 'var(--green-mint)', display: 'flex' }}>
                  <Clock size={16} />
                </span>
                <span className="ask__q">Which onboardings are overdue, and who is holding them up?</span>
                <span className="ask__tag">ASK</span>
              </div>
            </div>
          </div>
        </section>

        {/* =============================================== reliability */}
        <section className="shell section" id="reliability">
          <div className="sectionHead">
            <span className="eyebrow">04 — The unglamorous part</span>
            <span className="rule" aria-hidden="true" />
          </div>

          <div className="reliability__grid">
            <div className="reliability__copy">
              <h2>A duplicated offer letter is worse than no software at all.</h2>
              <p>
                Most of the engineering here is not the drag-and-drop editor. It is making sure that when something goes
                wrong — a crash, a retry, two people clicking at once — the outcome happens exactly once and the record
                says why.
              </p>
              <p>We treat that as a feature, because your trust depends on it.</p>
            </div>

            <div className="rows">
              {RELIABILITY.map((item, i) => (
                <div className="row" key={item.title}>
                  <span className="row__num">{String(i + 1).padStart(2, '0')}</span>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.copy}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ================================================== where AI */}
        <section className="ai" id="ai">
          <div className="shell ai__grid">
            <div className="ai__copy">
              <span className="eyebrow">05 — Where AI sits</span>
              <h2>
                AI proposes.
                <br />
                The platform decides.
              </h2>
              <p>
                Generating questions is table stakes — your existing form tool probably does it already. The difference
                is what happens to the proposal next.
              </p>
              <p>
                Everything a model suggests is checked against the rules before it can run: references resolved,
                permissions verified, unreachable steps rejected, sensitive fields caught. Nothing it writes is
                executable, and nothing reaches your records without a person saying yes.
              </p>
            </div>

            <div className="ai__demo">
              <div className="proposal">
                <span className="proposal__tag">PROPOSED</span>
                <p>Route claims over £1,000 to finance after the manager approves.</p>
              </div>

              <div className="checked__arrow">
                <DownArrow />
                <span>checked before it can run</span>
              </div>

              <div className="checked">
                <div className="checked__row">
                  <Tick />
                  <span>Threshold reads a currency field, not a text one</span>
                </div>
                <div className="checked__row">
                  <Tick />
                  <span>Someone with approval rights actually exists</span>
                </div>
                <div className="checked__row">
                  <Warn />
                  <span>
                    Claims between £100 and £1,000 have no route — <strong>needs your decision</strong>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ==================================================== packs */}
        <section className="shell section" id="packs">
          <div className="sectionHead">
            <span className="eyebrow">06 — Start from a pack</span>
            <span className="rule" aria-hidden="true" />
          </div>
          <h2>Two places we know the work cold.</h2>
          <p className="section__lede">
            A pack is not a form template. It is a working process — the stages, the approvals, the messages, the
            documents and the measures that the job actually needs.
          </p>

          <div className="packs">
            <article className="pack">
              <h3>Church &amp; nonprofit operations</h3>
              <p>High coordination, small teams, real safeguarding obligations.</p>
              <div className="pack__tags">
                {['Worker onboarding', 'Class certification', 'Volunteer registration', 'Benevolence requests', 'Event registration'].map(
                  (tag) => (
                    <span className="chip chip--quiet" key={tag}>
                      {tag}
                    </span>
                  ),
                )}
              </div>
              <p className="pack__claim">
                Safeguarding checks are recorded <strong>by reference</strong>, not stored here. The process waits for
                the check; your platform never holds the certificate.
              </p>
            </article>

            <article className="pack">
              <h3>Employee &amp; contractor onboarding</h3>
              <p>Repeated handoffs, documents, approvals and reminders, every single hire.</p>
              <div className="pack__tags">
                {['New starter intake', 'Policy acknowledgment', 'Equipment requests', 'Offboarding', 'Expense approval'].map(
                  (tag) => (
                    <span className="chip chip--quiet" key={tag}>
                      {tag}
                    </span>
                  ),
                )}
              </div>
              <p className="pack__claim">
                Payroll and right-to-work data is visible to <strong>HR and nobody else</strong> — the hiring manager
                sees the role, not the identification number.
              </p>
            </article>
          </div>

          {/*
            * The section is called "Start from a pack" and had no link in it.
            * Eighty-eight of them sit behind /builder/new and nothing on this
            * page pointed at them — the same shape as the landing page that
            * never reached sign-in.
            */}
          <p className="packs__more">
            <a className="btn btn--secondary" href="/builder/new">
              Browse all 88 packs
              <ArrowRight />
            </a>
            <span className="packs__moreNote">
              Nineteen categories. Each one carries its own approvals, retention floor and escalation path.
            </span>
          </p>
        </section>

        {/* =============================================== lighthouse */}
        <section className="shell lighthouse" id="lighthouse">
          <div className="lighthouse__box">
            <div className="lighthouse__main">
              <span className="lighthouse__tag">LIGHTHOUSE PROGRAM · 8–12 ORGANIZATIONS</span>
              <h2>Bring one process you are tired of running by hand.</h2>
              <p>
                We map what you do now, build the first version with you, and run it alongside your current way for a
                few weeks. You keep the numbers either way: time to launch, cycle time, manual touches, what failed.
              </p>
              {/*
                * "Apply to the program" linked to #lighthouse — the section it
                * is inside — so clicking it did nothing at all. There is no
                * application form and no address to send one to, so it points
                * at the one destination that is real.
                */}
              <div className="lighthouse__actions">
                <Link className="btn btn--primary" href="/signup">
                  Create a workspace
                </Link>
                <a className="btn btn--secondary" href="#how">
                  Read the approach
                </a>
              </div>
            </div>

            <div className="stats">
              <div className="stat">
                <div className="stat__value">30 min</div>
                <p>From describing a process to a live version collecting real submissions.</p>
              </div>
              <div className="stat">
                <div className="stat__value">Paid</div>
                <p>Early and honestly, so we learn what this is actually worth to you.</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
