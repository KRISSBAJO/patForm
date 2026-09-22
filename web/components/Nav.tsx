'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Burger, Mark } from './icons';

/**
 * The landing page's navigation.
 *
 * Two things here were controls that looked live and were not. "Sign in"
 * pointed at `#lighthouse` — an anchor further down the same page — so the
 * one link a returning customer reaches for scrolled them past a marketing
 * section. And the burger button on narrow screens opened nothing at all: the
 * links it would have revealed are hidden below 900px, so a phone had no
 * navigation whatsoever.
 *
 * Both now go where they say. `Link` rather than `a` for the two in-app
 * destinations, so Next prefetches them and the first click is not a cold
 * page load.
 */

const LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#reliability', label: 'Reliability' },
  { href: '#packs', label: 'Process packs' },
  { href: '#ai', label: 'Where AI sits' },
];

export function Nav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="nav">
      <div className="shell nav__inner">
        <a className="wordmark" href="#top" style={{ color: 'var(--green)' }}>
          <Mark />
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
          <Link href="/console" style={{ fontSize: 15, color: 'var(--ink-soft)' }}>
            Sign in
          </Link>
          <Link className="btn btn--primary btn--sm" href="/signup">
            Create a workspace
          </Link>
        </div>

        <button
          type="button"
          className="nav__menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="nav-menu"
          onClick={() => setOpen((was) => !was)}
          style={{ color: 'var(--ink)' }}
        >
          <Burger />
        </button>
      </div>

      {/*
        * Rendered only when open rather than hidden with CSS, so the links are
        * not in the tab order of a page where nobody can see them.
        */}
      {open && (
        <div className="nav__drawer" id="nav-menu">
          <div className="shell nav__drawerInner">
            {LINKS.map((link) => (
              <a key={link.href} href={link.href} onClick={() => setOpen(false)}>
                {link.label}
              </a>
            ))}
            <Link href="/console" onClick={() => setOpen(false)}>
              Sign in
            </Link>
            <Link className="btn btn--primary" href="/signup" onClick={() => setOpen(false)}>
              Create a workspace
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
