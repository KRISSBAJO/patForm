'use client';

/**
 * Motion that demonstrates the product, not decoration.
 *
 * Three pieces, all of which play once when their section scrolls into view
 * and then rest. Nothing loops. Every one of them shows a state change the
 * platform makes — a case moving through its states, a morning screen
 * filling in, a proposal being checked — because a landing page that fades
 * its cards in on scroll has animated its furniture and said nothing.
 *
 * Two rules are held everywhere here. With `prefers-reduced-motion` set,
 * everything renders in its final state and nothing moves. And the server
 * renders the final state too: the `data-motion` attribute that CSS keys off
 * is only set from an effect, so a page without JavaScript — or one whose
 * observer never fires — shows the finished picture rather than a blank.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

const ROOT_MARGIN = '0px 0px -12% 0px';

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Calls `fn` once, the first time `el` is a fifth visible. */
function onceInView(el: Element, fn: () => void): () => void {
  if (!('IntersectionObserver' in window)) {
    fn();
    return () => {};
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        fn();
      }
    },
    { rootMargin: ROOT_MARGIN, threshold: 0.2 },
  );
  io.observe(el);
  return () => io.disconnect();
}

/**
 * A block that knows whether it has arrived.
 *
 * Renders a plain div carrying `data-motion="pending"` until it scrolls into
 * view and `data-motion="in"` after. The CSS does the rest. The attribute is
 * absent on the server and on the first client render, so hydration matches
 * and a page with no script shows the final state.
 */
export function InView({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'pending' | 'in' | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion()) {
      setPhase('in');
      return;
    }
    setPhase('pending');
    return onceInView(el, () => setPhase('in'));
  }, []);

  return (
    <div ref={ref} className={className} style={style} data-motion={phase}>
      {children}
    </div>
  );
}

/**
 * A number that counts up to its value when it comes into view.
 *
 * The real value is always in the DOM for assistive tech; the counting copy
 * is hidden from it, because "twenty-four" is the fact and "seven, twelve,
 * nineteen, twenty-four" is not.
 */
export function CountUp({ value, delay = 0, duration = 900 }: { value: number; delay?: number; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const el = ref.current;
    if (!el || value === 0 || reducedMotion()) return;
    let frame = 0;
    let timer = 0;
    const stop = onceInView(el, () => {
      timer = window.setTimeout(() => {
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / duration);
          const eased = 1 - Math.pow(1 - t, 3);
          setShown(Math.round(value * eased));
          if (t < 1) frame = requestAnimationFrame(tick);
        };
        setShown(0);
        frame = requestAnimationFrame(tick);
      }, delay);
    });
    return () => {
      stop();
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [value, delay, duration]);

  return (
    <span ref={ref}>
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{value}</span>
    </span>
  );
}

/**
 * A line of text typed out when it comes into view.
 *
 * Same arrangement: the full sentence is in the DOM throughout, the typing
 * is a visual on top of it. The caret is an element with height so the line
 * box does not collapse while the text is still empty.
 */
export function Typewriter({ text, delay = 0, speed = 24 }: { text: string; delay?: number; speed?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    let timer = 0;
    let interval = 0;
    let rest = 0;
    const stop = onceInView(el, () => {
      timer = window.setTimeout(() => {
        let n = 0;
        setShown('');
        setTyping(true);
        interval = window.setInterval(() => {
          n += 1;
          setShown(text.slice(0, n));
          if (n >= text.length) {
            window.clearInterval(interval);
            rest = window.setTimeout(() => setTyping(false), 1200);
          }
        }, speed);
      }, delay);
    });
    return () => {
      stop();
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.clearTimeout(rest);
    };
  }, [text, delay, speed]);

  return (
    <span ref={ref}>
      <span aria-hidden="true">
        {shown}
        {typing && <span className="type__caret" />}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
