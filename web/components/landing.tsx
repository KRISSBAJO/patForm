'use client';

/**
 * The landing page's moving parts.
 *
 * Everything here tells one story: a single record travelling through a
 * company, and the platform that carries it. The motion is the story, not
 * decoration — the orbit in the hero is the modules sharing an engine, the
 * scroll-driven chapter is a real hiring request's week, the signature draws
 * itself because that is what Patform Sign does.
 *
 * Two rules hold throughout. With `prefers-reduced-motion`, everything is
 * drawn in its finished state and nothing moves. And every hook touches the
 * DOM through CSS variables or data attributes rather than re-rendering the
 * tree on scroll, so a long page stays smooth on a phone.
 */

import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { ArrowRight, Tick, Warn, DownArrow } from '@/components/icons';
import { CountUp, InView, Typewriter } from '@/components/motion';

const nth = (i: number) => ({ '--i': i }) as CSSProperties;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ------------------------------------------------------------------ data */

const MODULES = [
  { key: 'core', name: 'Forms & workflow', fact: 'Describe a process once. Form, approvals and records are built together.', tag: 'Always on' },
  { key: 'expenses', name: 'Expenses', fact: 'Claims, advances and budgets that hold the money at approval.' },
  { key: 'procurement', name: 'Procurement', fact: 'Sealed quotes, orders, receipts and three-way matched invoices.' },
  { key: 'hr', name: 'HR', fact: 'Onboarding to offboarding, with access ready on day one.' },
  { key: 'appraisals', name: 'Goals & appraisals', fact: 'Cycles, peer feedback and calibration. A rating never changes pay by itself.' },
  { key: 'ops', name: 'Assets & IT', fact: 'Asset register, access, tickets, maintenance and change requests.' },
  { key: 'gov', name: 'Contracts & compliance', fact: 'Contract reviews, renewals, policies, audits and legal holds.' },
  { key: 'sign', name: 'Patform Sign', fact: 'Built-in e-signature with a certificate seal and trusted time stamp.', tag: 'New' },
] as const;

const TICKER = [
  'One engine', 'Eight modules', 'One history', 'Separation of duties', 'Step-up re-auth', 'Append-only records', 'Legal holds', 'Built-in e-signature', 'Trusted time stamps', 'Microsoft 365', 'Google Workspace', 'Offline field checklists', 'Three-way matching', 'Sealed quotes', 'Scoped auditors', 'Retention schedules',
];

/*
 * The story. One request's week, told as the chapters a reader scrolls past
 * while the panel beside them keeps up. Each chapter names the module that
 * did the work and the fact a sceptic would ask about.
 */
const CHAPTERS = [
  { module: 'Forms & workflow', title: 'Monday, 09:12. A hiring request arrives.', copy: 'One form. It lands on the right desk with its deadline attached.', record: { state: 'Awaiting approval', line: 'Senior analyst · Lagos · ₦14.4m' }, log: 'Submitted · routed to Finance' },
  { module: 'Expenses', title: 'The budget holds the money first.', copy: 'Approval places a hold. Nobody can spend the same naira twice.', record: { state: 'Approved · funds held', line: 'Hold ₦1.2m · Laptop & setup' }, log: 'Approved · hold placed' },
  { module: 'Procurement', title: 'Three quotes. Nobody sees a price early.', copy: 'Quotes stay sealed until the deadline, then open together.', record: { state: 'Order placed', line: 'PO-1037 · SparkleCo Ltd' }, log: 'Quotes opened 3/3 · PO issued' },
  { module: 'Assets & IT', title: 'The laptop arrives and becomes an asset.', copy: 'Goods receipt is the only door into the register.', record: { state: 'In custody', line: 'LAP-0219 · assigned to new hire' }, log: 'Received · tagged · handed out' },
  { module: 'HR', title: 'Day one. Access is already there.', copy: 'Counted as granted only when Microsoft 365 confirms it.', record: { state: 'Started', line: 'Access confirmed by Microsoft 365' }, log: 'Day one · 4 systems live' },
  { module: 'Patform Sign', title: 'The contract is signed and sealed.', copy: 'A code by text, a certificate seal, a trusted time stamp.', record: { state: 'Completed', line: 'Sealed · 2 of 3 directors' }, log: 'Signed · sealed · verifiable' },
  { module: 'Contracts & compliance', title: 'Months later, the auditor sees exactly this.', copy: 'Read-only, in scope, until a date. Every look is logged.', record: { state: 'Under engagement', line: 'Auditor · FY26 H1 · read-only' }, log: 'Engagement opened' },
] as const;

const CONTROLS = [
  { n: '01', title: 'Someone other than', copy: 'Whoever adds a supplier cannot approve it.' },
  { n: '02', title: 'Prove it is still you', copy: 'Pay, bank details and budgets ask for the password again.' },
  { n: '03', title: 'History that cannot be edited', copy: 'Every decision is a row with an actor and a time.' },
  { n: '04', title: 'Each team sees its own facts', copy: 'IT sees the laptop task, not the salary.' },
  { n: '05', title: 'Deletion that respects a hold', copy: 'Retention skips anything under a legal hold.' },
  { n: '06', title: 'Settings, not code', copy: 'Limits and checks are pages an admin changes.' },
] as const;

const CONNECTS = ['Microsoft 365', 'Google Workspace', 'Amazon S3 + malware scan', 'DigiCert time stamps', 'Companies House', 'Termii', 'Twilio', 'DocuSign (optional)', 'Slack', 'Microsoft Teams', 'Webhooks', 'REST API + OAuth'];

/* ------------------------------------------------------------- utilities */

/** A thin line at the top of the page that fills as the reader scrolls. */
function Progress() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      el.style.setProperty('--p', String(max > 0 ? window.scrollY / max : 0));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(paint); };
    paint();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); cancelAnimationFrame(frame); };
  }, []);
  return <div ref={ref} className="lp-progress" aria-hidden="true" />;
}

/** Hands the pointer position to CSS as --mx/--my, in 0..1, for glows and parallax. */
function usePointerVars<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const onMove = (e: RPointerEvent<T>) => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', String((e.clientX - r.left) / r.width));
    el.style.setProperty('--my', String((e.clientY - r.top) / r.height));
  };
  const onLeave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--mx', '0.5');
    el.style.setProperty('--my', '0.5');
  };
  return { ref, onPointerMove: onMove, onPointerLeave: onLeave };
}

/** A card that tilts toward the pointer. */
function Tilt({ className, children, style }: { className?: string; children: ReactNode; style?: CSSProperties }) {
  const p = usePointerVars<HTMLDivElement>();
  return <div {...p} className={`lp-tilt ${className ?? ''}`} style={style}>{children}</div>;
}

/** A button that leans toward the pointer while it is near. */
function Magnet({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const onMove = (e: RPointerEvent<HTMLAnchorElement>) => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    el.style.setProperty('--tx', `${dx * 0.18}px`);
    el.style.setProperty('--ty', `${dy * 0.28}px`);
  };
  const onLeave = () => { ref.current?.style.setProperty('--tx', '0px'); ref.current?.style.setProperty('--ty', '0px'); };
  const external = href.startsWith('#');
  return external
    ? <a ref={ref} href={href} className={`lp-magnet ${className}`} onPointerMove={onMove} onPointerLeave={onLeave}>{children}</a>
    : <Link ref={ref} href={href} className={`lp-magnet ${className}`} onPointerMove={onMove} onPointerLeave={onLeave}>{children}</Link>;
}

/** A headline whose words rise into place one after another. */
function Rise({ text, as: Tag = 'h1', className }: { text: string; as?: 'h1' | 'h2'; className?: string }) {
  const words = text.split(' ');
  return (
    <Tag className={`lp-rise ${className ?? ''}`} aria-label={text}>
      {words.map((w, i) => (
        <span className="lp-rise__w" key={`${w}-${i}`} aria-hidden="true" style={nth(i)}>
          <span>{w}</span>
        </span>
      ))}
    </Tag>
  );
}

/** A hash that resolves out of noise when it comes into view. */
function Scramble({ text, delay = 0 }: { text: string; delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    const glyphs = '0123456789abcdef';
    let timer = 0; let frame = 0;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      timer = window.setTimeout(() => {
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / 1400);
          const settled = Math.floor(t * text.length);
          let out = '';
          for (let i = 0; i < text.length; i++) {
            const c = text[i]!;
            out += i < settled || c === ' ' || c === '…' ? c : glyphs[Math.floor(Math.random() * glyphs.length)];
          }
          setShown(out);
          if (t < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      }, delay);
    }, { threshold: 0.2 });
    io.observe(el);
    return () => { io.disconnect(); window.clearTimeout(timer); cancelAnimationFrame(frame); };
  }, [text, delay]);
  return <span ref={ref}><span aria-hidden="true">{shown}</span><span className="sr-only">{text}</span></span>;
}

/* ------------------------------------------------------------------ hero */

function Orbit() {
  const p = usePointerVars<HTMLDivElement>();
  const ring = MODULES.filter((m) => m.key !== 'core');
  return (
    <div {...p} className="lp-orbit" aria-hidden="true">
      <div className="lp-orbit__glow" />
      <div className="lp-orbit__ring lp-orbit__ring--outer" />
      <div className="lp-orbit__ring lp-orbit__ring--inner" />
      <div className="lp-orbit__core">
        <span className="lp-orbit__coreLabel">One record</span>
        <strong>HR-2041</strong>
        <span className="lp-orbit__coreMeta">Hiring request</span>
      </div>
      {ring.map((m, i) => (
        <div className="lp-orbit__node" key={m.key} style={{ '--a': `${(360 / ring.length) * i}deg`, ...nth(i) } as CSSProperties}>
          <b><span>{m.name}</span></b>
        </div>
      ))}
      <div className="lp-orbit__packet lp-orbit__packet--a" />
      <div className="lp-orbit__packet lp-orbit__packet--b" />
      <div className="lp-orbit__event lp-orbit__event--1"><Tick /> Approved · funds held</div>
      <div className="lp-orbit__event lp-orbit__event--2"><Tick /> Access confirmed</div>
      <div className="lp-orbit__event lp-orbit__event--3"><Tick /> Sealed · time-stamped</div>
    </div>
  );
}

function Hero() {
  return (
    <section className="lp-hero" id="top">
      <div className="lp-hero__bg" aria-hidden="true">
        <span className="lp-grid" />
      </div>
      <div className="shell lp-hero__grid">
        <div className="lp-hero__copy">
          <div className="pill lp-fade" style={nth(0)}>
            <span className="pill__dot" aria-hidden="true" />
            <span className="pill__text">Eight modules · one engine · built-in e-signature</span>
          </div>
          <Rise text="Run the company. Not the paperwork." />
          <p className="lp-hero__sub lp-fade" style={nth(6)}>
            Expenses, purchasing, people, contracts and signatures. One engine, one history.
          </p>
          <div className="lp-hero__cta lp-fade" style={nth(7)}>
            <Magnet href="/signup" className="btn btn--primary lp-btn--lg">Create a workspace <ArrowRight /></Magnet>
            <Magnet href="#story" className="btn btn--secondary lp-btn--lg">Watch one record&apos;s week</Magnet>
          </div>
          <div className="lp-hero__proof lp-fade" style={nth(8)}>
            <span><strong>0</strong> per-envelope fees</span>
            <span><strong>300+</strong> automated tests</span>
            <span><strong>1</strong> history for everything</span>
          </div>
        </div>
        <Orbit />
      </div>
      <a href="#ticker" className="lp-hero__down" aria-label="Scroll to the next section"><DownArrow /></a>
    </section>
  );
}

function Ticker() {
  const items = [...TICKER, ...TICKER];
  return (
    <div className="lp-ticker" id="ticker" aria-hidden="true">
      <div className="lp-ticker__track">
        {items.map((t, i) => <span key={`${t}-${i}`}>{t}<i /></span>)}
      </div>
    </div>
  );
}

function PeopleInterlude() {
  return (
    <section className="lp-people" aria-labelledby="lp-people-title">
      <div className="shell">
        <div className="lp-people__frame">
          <div className="lp-people__image" role="img" aria-label="Three colleagues reviewing a hiring request together" />
          <div className="lp-people__copy">
            <span className="eyebrow">Behind every record</span>
            <h2 id="lp-people-title">People make the decisions. Patform carries the work.</h2>
            <p>From the first request to the final signature, everyone works from the same history.</p>
          </div>
          <span className="lp-people__caption mono">One request · one connected journey</span>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- story */

function Story() {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const els = refs.current.filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) { setActive(CHAPTERS.length - 1); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
      }
    }, { rootMargin: '-42% 0px -42% 0px', threshold: 0 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const ch = CHAPTERS[active]!;

  return (
    <section className="lp-story" id="story">
      <div className="shell">
        <div className="sectionHead">
          <span className="eyebrow">01 — One record&apos;s week</span>
          <span className="rule" aria-hidden="true" />
        </div>
        <Rise as="h2" text="One hiring request. Seven modules." className="lp-h2" />
        <p className="section__lede lp-story__lede">Scroll. The record keeps up.</p>
      </div>

      <div className="shell lp-story__grid">
        <div className="lp-story__panelWrap">
          <div className="lp-story__panel" data-step={active}>
            <div className="lp-story__bar">
              <span className="lp-dot" /><span className="lp-dot" /><span className="lp-dot" />
              <span className="mono lp-story__crumb">{ch.module}</span>
            </div>
            <ol className="lp-rail" aria-hidden="true">
              {CHAPTERS.map((c, i) => <li key={c.module} className={i < active ? 'is-done' : i === active ? 'is-now' : ''} style={nth(i)}><span /></li>)}
            </ol>
            <div className="lp-record" key={active}>
              <div className="lp-record__head">
                <span className="mono">HR-2041</span>
                <span className={`badge badge--${active === CHAPTERS.length - 1 ? 'neutral' : active >= 5 ? 'ok' : 'waiting'}`}>{ch.record.state.toUpperCase()}</span>
              </div>
              <strong className="lp-record__title">Hiring request · Senior analyst</strong>
              <span className="lp-record__line">{ch.record.line}</span>
            </div>
            <ul className="lp-log" aria-live="polite">
              {CHAPTERS.slice(0, active + 1).map((c, i) => (
                <li key={c.module} className={i === active ? 'is-new' : ''}>
                  <span className="lp-log__dot" aria-hidden="true" />
                  <span className="lp-log__who">{c.module}</span>
                  <span className="lp-log__what">{c.log}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="lp-story__chapters">
          {CHAPTERS.map((c, i) => (
            <article
              key={c.module}
              className={`lp-chapter ${i === active ? 'is-active' : ''}`}
              data-i={i}
              ref={(el) => { refs.current[i] = el; }}
            >
              <span className="lp-chapter__n mono">{String(i + 1).padStart(2, '0')} / {String(CHAPTERS.length).padStart(2, '0')} · {c.module}</span>
              <h3>{c.title}</h3>
              <p>{c.copy}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- modules */

function Modules() {
  return (
    <section className="lp-modules" id="modules">
      <div className="shell">
        <div className="sectionHead">
          <span className="eyebrow">02 — Switch on what you need</span>
          <span className="rule" aria-hidden="true" />
        </div>
        <Rise as="h2" text="Eight modules. One engine underneath." className="lp-h2" />
        <p className="section__lede">Switch on what you need. Add the next without a migration.</p>
        <InView className="lp-modGrid">
          {MODULES.map((m, i) => (
            <Tilt key={m.key} className={`lp-mod lp-mod--${m.key}`} style={nth(i)}>
              <div className="lp-mod__inner">
                <div className="lp-mod__top">
                  <span className="lp-mod__n mono">{String(i + 1).padStart(2, '0')}</span>
                  {'tag' in m && m.tag ? <span className="chip chip--quiet">{m.tag}</span> : null}
                </div>
                <h3>{m.name}</h3>
                <p>{m.fact}</p>
                <span className="lp-mod__shine" aria-hidden="true" />
              </div>
            </Tilt>
          ))}
        </InView>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ sign */

function Sign() {
  const p = usePointerVars<HTMLElement>();
  return (
    <section {...p} className="lp-sign" id="sign">
      <div className="lp-sign__glow" aria-hidden="true" />
      <div className="shell lp-sign__grid">
        <div className="lp-sign__copy">
          <span className="eyebrow lp-eyebrow--dark">03 — Patform Sign</span>
          <Rise as="h2" text="Sign it here. Prove it anywhere." className="lp-h2 lp-h2--dark" />
          <p className="lp-sign__lede">Send from the same page. The signed copy comes back to the same record. No per-envelope fees.</p>
          <ol className="lp-steps">
            {[
              ['Place the boxes', 'Signers in order or at once. A company can sign through two of three directors.'],
              ['They prove it is them', 'A one-time code by email or text, then consent in words that are kept.'],
              ['The copy proves itself', 'A certificate seal, a trusted time stamp, and a public verify page.'],
            ].map(([t, c], i) => (
              <li key={t} style={nth(i)}><span className="lp-steps__n mono">0{i + 1}</span><div><strong>{t}</strong><p>{c}</p></div></li>
            ))}
          </ol>
          <p className="lp-sign__fine">A simple electronic signature — what most commercial contracts need. Qualified signatures still need a qualified provider.</p>
        </div>

        <InView className="lp-paper">
          <div className="lp-paper__sheet">
            <div className="lp-paper__lines"><span /><span /><span /><span style={{ width: '60%' }} /></div>
            <div className="lp-paper__sigBox">
              <svg viewBox="0 0 320 90" className="lp-sig" aria-hidden="true">
                <path d="M8 62 C 30 10, 48 10, 54 50 C 58 76, 70 70, 82 40 C 92 16, 100 20, 104 46 C 108 70, 120 66, 134 38 C 146 14, 150 24, 156 52 C 160 70, 172 66, 190 44 C 206 24, 222 20, 236 44 C 246 60, 258 58, 272 40 C 284 26, 300 30, 312 46" />
              </svg>
              <span className="lp-paper__sigName">Ade Director · for and on behalf of Acme Ltd</span>
            </div>
            <div className="lp-paper__lines"><span /><span style={{ width: '80%' }} /></div>
            <div className="lp-seal" aria-hidden="true">
              <span className="lp-seal__ring" />
              <span className="lp-seal__text">SEALED · PATFORM SIGN</span>
            </div>
          </div>
          <div className="lp-verify">
            <div className="lp-verify__row" style={nth(0)}><Tick /> Code by text message · verified</div>
            <div className="lp-verify__row" style={nth(1)}><Tick /> Agreed to sign electronically</div>
            <div className="lp-verify__row" style={nth(2)}><Tick /> Digital seal intact · time-stamped by DigiCert</div>
            <div className="lp-verify__hash mono"><Scramble text="sha256 1f1087c2…a0ce — unchanged since signing" delay={2200} /></div>
            <span className="lp-verify__badge">GENUINE</span>
          </div>
        </InView>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- controls */

function Controls() {
  return (
    <section className="lp-controls" id="controls">
      <div className="shell">
        <div className="sectionHead">
          <span className="eyebrow">04 — Controls, built into the engine</span>
          <span className="rule" aria-hidden="true" />
        </div>
        <div className="lp-controls__head">
          <Rise as="h2" text="The rules your auditor asks about, built into the engine." className="lp-h2" />
          <p className="section__lede">Not a certification. Just how it works.</p>
        </div>
        <InView className="lp-ctlList">
          {CONTROLS.map((c, i) => (
            <article className="lp-ctl" key={c.n} style={nth(i)}>
              <span className="lp-ctl__n mono">{c.n}</span>
              <h3>{c.title}</h3>
              <p>{c.copy}</p>
              <span className="lp-ctl__line" aria-hidden="true" />
            </article>
          ))}
        </InView>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- numbers */

function Numbers() {
  return (
    <section className="lp-numbers">
      <div className="shell lp-numbers__grid">
        {[
          { v: 8, suffix: '', label: 'modules, one engine' },
          { v: 300, suffix: '+', label: 'automated tests' },
          { v: 0, suffix: '', label: 'per-envelope fees' },
          { v: 100, suffix: '%', label: 'of decisions on record' },
        ].map((n, i) => (
          <InView className="lp-num" key={n.label} style={nth(i)}>
            <div className="lp-num__v"><CountUp value={n.v} delay={150 * i} />{n.suffix}</div>
            <p>{n.label}</p>
          </InView>
        ))}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- morning */

function Morning() {
  const p = usePointerVars<HTMLElement>();
  return (
    <section {...p} className="lp-morning" id="console">
      <div className="lp-sign__glow" aria-hidden="true" />
      <div className="shell lp-morning__grid">
        <div>
          <span className="eyebrow lp-eyebrow--dark">05 — Every morning</span>
          <Rise as="h2" text="One screen answers four questions." className="lp-h2 lp-h2--dark" />
          <p className="lp-sign__lede">What arrived, what needs you, what is late, what broke. Ask a plain question and get an answer from records you may see.</p>
          <p className="lp-sign__fine">AI proposes; people decide. It never approves a payment or scores a review.</p>
        </div>

        <InView className="window lp-window">
          <div className="window__bar">
            <span className="window__dot" style={{ background: 'var(--red-border)' }} />
            <span className="window__dot" style={{ background: 'var(--ochre-border)' }} />
            <span className="window__dot" style={{ background: '#a9c9b4' }} />
            <span className="mono" style={{ marginLeft: 10, fontSize: 11.5, color: 'var(--muted)' }}>My work · October</span>
          </div>
          <div className="tiles">
            <div className="tile" style={nth(0)}><div className="tile__label">ARRIVED</div><div className="tile__value"><CountUp value={41} delay={250} /></div><div className="tile__meta">this week</div></div>
            <div className="tile tile--needs" style={nth(1)}><div className="tile__label">NEEDS YOU</div><div className="tile__value"><CountUp value={5} delay={350} /></div><div className="tile__meta">approvals and reviews</div></div>
            <div className="tile tile--late" style={nth(2)}><div className="tile__label">LATE</div><div className="tile__value"><CountUp value={2} delay={450} /></div><div className="tile__meta">past their target</div></div>
            <div className="tile" style={nth(3)}><div className="tile__label">FAILED</div><div className="tile__value">0</div><div className="tile__meta">automations</div></div>
          </div>
          <div className="queue">
            {[
              { id: 'CLM-0412', name: 'Amara Okafor', stage: 'Finance review', badge: '6H', tone: 'waiting' },
              { id: 'PO-1037', name: 'SparkleCo Ltd', stage: 'Goods receipt', badge: '3D LATE', tone: 'late' },
              { id: 'PS-1001', name: 'Supply agreement', stage: 'Out for signature', badge: '1 OF 2', tone: 'ok' },
            ].map((row, i) => (
              <div className="queue__row" key={row.id} style={nth(i)}>
                <span className="queue__id">{row.id}</span>
                <span className="queue__name">{row.name}</span>
                <span className="queue__stage">{row.stage}</span>
                <span className={`badge badge--${row.tone}`}>{row.badge}</span>
              </div>
            ))}
          </div>
          <div className="ask">
            <span className="ask__q"><Typewriter text="Which contracts end in the next 90 days, and when is notice due?" delay={1800} /></span>
            <span className="ask__tag">ASK</span>
          </div>
        </InView>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- connects */

function Connects() {
  const rows = [CONNECTS.slice(0, 6), CONNECTS.slice(6)];
  return (
    <section className="lp-connects" id="connects">
      <div className="shell">
        <div className="sectionHead">
          <span className="eyebrow">06 — Works with what you already run</span>
          <span className="rule" aria-hidden="true" />
        </div>
        <Rise as="h2" text="Works with what you already run." className="lp-h2" />
      </div>
      <div className="lp-rows" aria-hidden="true">
        {rows.map((r, i) => (
          <div className={`lp-rows__track ${i % 2 ? 'is-reverse' : ''}`} key={i}>
            {[...r, ...r, ...r].map((c, j) => <span className="lp-conn" key={`${c}-${j}`}>{c}</span>)}
          </div>
        ))}
      </div>
      <ul className="sr-only">{CONNECTS.map((c) => <li key={c}>{c}</li>)}</ul>
    </section>
  );
}

/* ------------------------------------------------------------------- cta */

function Cta() {
  return (
    <section className="lp-cta" id="start">
      <div className="lp-cta__bg" aria-hidden="true"><span className="lp-blob lp-blob--4" /><span className="lp-blob lp-blob--5" /></div>
      <div className="shell lp-cta__inner">
        <span className="eyebrow lp-eyebrow--dark">Lighthouse programme · 8–12 organisations</span>
        <Rise as="h2" text="Bring one process you are tired of running by hand." className="lp-cta__h" />
        <p>We switch on the module that fits and run it beside your current way for a few weeks. You keep the numbers either way.</p>
        <div className="lp-cta__actions">
          <Magnet href="/signup" className="btn btn--primary lp-btn--lg lp-btn--invert">Create a workspace <ArrowRight /></Magnet>
          <Magnet href="/builder/new" className="btn btn--secondary lp-btn--lg lp-btn--ghost">Browse the templates</Magnet>
        </div>
      </div>
    </section>
  );
}

export function Landing() {
  return (
    <main className="lp">
      <Progress />
      <Hero />
      <Ticker />
      <PeopleInterlude />
      <Story />
      <Modules />
      <Sign />
      <Controls />
      <Numbers />
      <Morning />
      <Connects />
      <Cta />
    </main>
  );
}
