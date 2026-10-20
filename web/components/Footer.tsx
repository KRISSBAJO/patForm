import { Mark } from './icons';

const PRIMARY_LINKS = [
  ['/#story', 'How it works'],
  ['/#modules', 'Modules'],
  ['/#sign', 'Patform Sign'],
  ['/reliability', 'Reliability'],
  ['/signup', 'Create a workspace'],
] as const;

const UTILITY_LINKS = [
  ['/developers#api', 'API'],
  ['/developers#webhooks', 'Webhooks'],
  ['/developers#export', 'Data export'],
  ['/security', 'Security'],
  ['/privacy', 'Privacy'],
  ['/subprocessors', 'Subprocessors'],
] as const;

export function Footer() {
  return (
    <footer className="footer">
      <div className="shell">
        <div className="footer__main">
          <a className="footer__brand" href="/#top" aria-label="Patform home">
            <Mark size={30} />
            <span>Patform</span>
          </a>
          <nav className="footer__nav" aria-label="Footer navigation">
            {PRIMARY_LINKS.map(([href, label]) => <a href={href} key={href}>{label}</a>)}
          </nav>
        </div>
        <div className="footer__bottom">
          <p>© 2026 LogaXP Ltd.</p>
          <p className="footer__compliance">We do not claim compliance we have not earned. Ask us what we hold.</p>
          <nav className="footer__utility" aria-label="Technical and trust links">
            {UTILITY_LINKS.map(([href, label]) => <a href={href} key={href}>{label}</a>)}
          </nav>
        </div>
      </div>
    </footer>
  );
}
