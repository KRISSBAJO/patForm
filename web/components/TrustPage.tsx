import Link from 'next/link';
import { Footer } from './Footer';
import { Nav } from './Nav';

/**
 * The shell for the pages the footer links to.
 *
 * Those links all pointed at `#reliability` — a marketing section on the home
 * page — while `docs/privacy.md` sat in the repository with the data map, the
 * subprocessor table and an explicit list of what is *not* met. The gap was
 * not the content. It was that nobody outside the repository could read it.
 *
 * Each page ends with what is missing, in the same voice as the rest. A trust
 * page that lists only what is built is the one thing on a trust page that
 * nobody should believe.
 */
export function TrustPage({
  eyebrow,
  title,
  standfirst,
  children,
}: {
  eyebrow: string;
  title: string;
  standfirst: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <Nav />
      <main id="top" className="shell trust">
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="trust__title">{title}</h1>
        <p className="trust__standfirst">{standfirst}</p>
        <div className="trust__body">{children}</div>
        <p className="trust__back">
          <Link href="/">Back to the overview</Link>
        </p>
      </main>
      <Footer />
    </>
  );
}

/** A section with a heading that can be linked to. */
export function TrustSection({
  id,
  heading,
  children,
}: {
  id: string;
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="trust__section">
      <h2>{heading}</h2>
      {children}
    </section>
  );
}

/**
 * What is not built.
 *
 * Its own component so it looks the same on every page and cannot be quietly
 * dropped from one of them.
 */
export function NotMet({ items }: { items: string[] }) {
  return (
    <section className="trust__section trust__notMet">
      <h2>What is not met</h2>
      <p>Named rather than implied.</p>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
