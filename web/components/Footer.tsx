import { Mark } from './icons';

/*
 * Every link in the Developers and Trust columns used to point at
 * marketing sections on the home page while the
 * repository held a data map, a subprocessor table and an explicit list of
 * what is not met. The content existed; nobody outside the repository could
 * read it.
 *
 * The anchors that remain are anchors on purpose: they go to a section of the
 * home page that exists and says what the label says.
 */
const COLUMNS = [
  { head: 'Platform', links: [['/#demo', 'How it works'], ['/#packs', 'Process packs'], ['/reliability', 'Reliability'], ['/signup', 'Create a workspace']] },
  { head: 'Developers', links: [['/developers#api', 'API'], ['/developers#webhooks', 'Webhooks'], ['/developers#export', 'Data export']] },
  { head: 'Company', links: [['/#lighthouse', 'Lighthouse program'], ['/console', 'Sign in']] },
  { head: 'Trust', links: [['/security', 'Security'], ['/privacy', 'Privacy'], ['/subprocessors', 'Subprocessors']] },
] as const;

export function Footer() {
  return (
    <footer className="footer">
      <div className="shell">
        <div className="footer__grid">
          <div className="footer__brandCol">
            <div className="footer__brand" style={{ color: 'var(--green-mint)' }}>
              <Mark size={22} />
              <span style={{ color: 'var(--on-dark-1)' }}>Patform</span>
            </div>
            <p className="footer__blurb">
              A process platform for operational teams. Built by LogaXP, on Renviq managed PostgreSQL.
            </p>
          </div>

          <div className="footer__cols">
            {COLUMNS.map((column) => (
              <div className="footer__col" key={column.head}>
                <span className="footer__colHead">{column.head.toUpperCase()}</span>
                {column.links.map(([href, label]) => (
                  <a key={label} href={href}>
                    {label}
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* On a phone the four columns collapse to one honest row of links. */}
        <div className="footer__links">
          <a href="/#demo">How it works</a>
          <a href="/#packs">Process packs</a>
          <a href="/reliability">Reliability</a>
          <a href="/security">Security</a>
          <a href="/privacy">Privacy</a>
        </div>

        <div className="footer__base">
          <p>&copy; 2026 LogaXP Ltd.</p>
          <p className="footer__disclaimer">
            We do not claim compliance we have not earned. Ask us what we hold.
          </p>
        </div>
      </div>
    </footer>
  );
}
