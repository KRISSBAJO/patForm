import { Burger, Mark } from './icons';

const LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#reliability', label: 'Reliability' },
  { href: '#packs', label: 'Process packs' },
  { href: '#ai', label: 'Where AI sits' },
];

export function Nav() {
  return (
    <header className="nav">
      <div className="shell nav__inner">
        <a className="wordmark" href="#top" style={{ color: 'var(--green)' }}>
          <Mark size={24} />
          <span style={{ color: 'var(--ink)' }}>Patform</span>
        </a>

        <nav className="nav__links" aria-label="Sections">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>

        <div className="nav__actions">
          <a href="#lighthouse" style={{ fontSize: 15, color: 'var(--ink-soft)' }}>
            Sign in
          </a>
          <a className="btn btn--primary btn--sm" href="#lighthouse">
            Talk to us
          </a>
        </div>

        <button type="button" className="nav__menu" aria-label="Open menu" style={{ color: 'var(--ink)' }}>
          <Burger />
        </button>
      </div>
    </header>
  );
}
