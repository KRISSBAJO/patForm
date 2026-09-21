import { Mark } from './icons';

const COLUMNS = [
  { head: 'Platform', links: [['#how', 'How it works'], ['#packs', 'Process packs'], ['#reliability', 'Reliability']] },
  { head: 'Developers', links: [['#how', 'API'], ['#how', 'Webhooks'], ['#how', 'Data export']] },
  { head: 'Company', links: [['#lighthouse', 'Lighthouse program'], ['#lighthouse', 'Contact']] },
  { head: 'Trust', links: [['#reliability', 'Security'], ['#reliability', 'Privacy'], ['#reliability', 'Subprocessors']] },
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
          <a href="#how">How it works</a>
          <a href="#packs">Process packs</a>
          <a href="#reliability">Reliability</a>
          <a href="#reliability">Security</a>
          <a href="#lighthouse">Contact</a>
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
