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
  { head: 'Platform', links: [['/#story', 'How it works'], ['/#modules', 'Modules'], ['/reliability', 'Reliability'], ['/signup', 'Create a workspace']] },
  { head: 'Developers', links: [['/developers#api', 'API'], ['/developers#webhooks', 'Webhooks'], ['/developers#export', 'Data export']] },
  { head: 'Company', links: [['/#start', 'Lighthouse program'], ['/console', 'Sign in']] },
  { head: 'Trust', links: [['/security', 'Security'], ['/privacy', 'Privacy'], ['/subprocessors', 'Subprocessors']] },
] as const;

export function Footer() {
  return (
    <footer className="footer">
      <div className="shell">
        <div className="footer__grid">
          <div className="footer__brandCol">
            <a className="footer__brand" href="/#top" aria-label="Patform home">
              <Mark size={32} />
              <span>Patform</span>
            </a>
            <p className="footer__statement">Good work deserves<br />a clear path.</p>
            <p className="footer__blurb">
              Forms, decisions, records and signatures that stay connected from the first request to the final outcome.
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

        <div className="footer__base">
          <span>&copy; 2026 LogaXP Ltd.</span>
          <span className="footer__compliance">We do not claim compliance we have not earned. Ask us what we hold.</span>
        </div>
      </div>
      <div className="footer__wordmark" aria-hidden="true">Patform</div>
    </footer>
  );
}
