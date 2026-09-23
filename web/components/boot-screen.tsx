/**
 * What the product looks like while it starts.
 *
 * It was the word "Loading…" in the middle of an empty page, which reads as
 * something that has broken rather than something on its way. This is the
 * shape of the screen that is coming — the same green bar, a rail, the
 * panels — so the page that arrives replaces its own outline instead of
 * appearing out of nothing.
 *
 * The shimmer stops for anybody who has asked for less motion; the outline
 * alone still says "arriving". The label is for screen readers, since the
 * shapes mean nothing to one.
 */
import './boot-screen.css';

export function BootScreen({ where, label = 'Loading' }: { where: 'console' | 'builder'; label?: string }) {
  return (
    <div className={`bt bt--${where}`} role="status" aria-live="polite" aria-busy="true">
      <span className="bt__sr">{label}</span>

      <div className="bt__top" aria-hidden="true">
        <span className="bt__brand">
          <svg width="20" height="20" viewBox="0 0 26 26" fill="none">
            <rect x="1.5" y="1.5" width="23" height="23" rx="6" stroke="currentColor" strokeWidth="1.8" />
            <path
              className="bt__tick"
              d="M7 13.2L11 17L19 9"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Patform
        </span>
        <span className="bt__bar" />
      </div>

      <div className="bt__body" aria-hidden="true">
        <div className="bt__rail">
          {Array.from({ length: where === 'builder' ? 6 : 9 }, (_, i) => (
            <span key={i} className="bt__railItem bt__shine" />
          ))}
        </div>

        <div className="bt__main">
          <span className="bt__title bt__shine" />
          <div className="bt__cards">
            <div className="bt__card">
              <span className="bt__line bt__shine" style={{ width: '38%' }} />
              {[82, 64, 74, 56].map((w, i) => (
                <div key={i} className="bt__row">
                  <span className="bt__dot bt__shine" />
                  <span className="bt__line bt__shine" style={{ width: `${w}%` }} />
                </div>
              ))}
            </div>
            <div className="bt__card bt__card--side">
              <span className="bt__line bt__shine" style={{ width: '52%' }} />
              <span className="bt__line bt__shine" style={{ width: '88%' }} />
              <span className="bt__line bt__shine" style={{ width: '70%' }} />
            </div>
          </div>
        </div>
      </div>

      <p className="bt__caption">{label}…</p>
    </div>
  );
}
