'use client';

/**
 * The two things nine numbers cannot say.
 *
 * A dashboard of single values answers "how is it doing" and leaves both
 * follow-up questions unanswered: *where* is the work sitting, and *which
 * way* is it going. A completion rate of 71% is the same 71% whether it was
 * 40% last month or 95%.
 *
 * Drawn as inline SVG rather than with a charting library. These are two
 * simple shapes, and a dependency that renders them would be larger than the
 * rest of this console's client code put together.
 *
 * Both are counts. A rate split into weekly buckets is exactly the disclosure
 * `MIN_COHORT` exists to prevent — "two of this week's three were rejected"
 * is a sentence about three identifiable people — so the trend deliberately
 * charts how many arrived and how many finished, which says nothing about
 * any of them.
 */

export interface Standing {
  state: string;
  name: string;
  count: number;
  oldestHours: number;
  slaHours: number | null;
  overdue: boolean;
}

export interface Point {
  bucket: string;
  label: string;
  arrived: number;
  finished: number;
}

function hours(h: number): string {
  if (h < 1) return 'under an hour';
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Where the open records are, now.
 *
 * Every non-terminal state appears, including the empty ones. A queue that
 * disappears when it clears changes the shape of the picture between visits,
 * and "nothing is waiting here" is worth seeing.
 */
export function WhereItSits({ standing }: { standing: Standing[] }) {
  const total = standing.reduce((n, s) => n + s.count, 0);
  const most = Math.max(1, ...standing.map((s) => s.count));

  return (
    <section className="ch">
      <header className="ch__head">
        <h3 className="ch__title">Where the open records are</h3>
        <span className="ch__note">{total === 0 ? 'nothing open' : `${total} open right now`}</span>
      </header>

      {total === 0 ? (
        <p className="ch__empty">Nothing is in flight. Every record has reached an end.</p>
      ) : (
        <ul className="ch__bars">
          {standing.map((s) => (
            <li className="ch__bar" key={s.state}>
              <span className="ch__barName">{s.name}</span>
              <span className="ch__barTrack">
                <span
                  className="ch__barFill"
                  data-overdue={s.overdue ? 'true' : undefined}
                  style={{ width: `${(s.count / most) * 100}%` }}
                />
              </span>
              <span className="ch__barCount">{s.count}</span>
              <span className="ch__barAge">
                {s.count === 0 ? (
                  '—'
                ) : (
                  <>
                    oldest {hours(s.oldestHours)}
                    {s.slaHours !== null && (
                      <span className={s.overdue ? 'ch__past' : 'ch__within'}>
                        {s.overdue ? ` · past ${hours(s.slaHours)}` : ` · limit ${hours(s.slaHours)}`}
                      </span>
                    )}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const W = 720;
const H = 150;
const PAD_L = 28;
const PAD_B = 22;
const PAD_T = 10;

/**
 * Arrivals against completions.
 *
 * Two columns per bucket rather than a line: with a handful of buckets a line
 * implies a continuous quantity that these are not — nothing "arrived" at
 * half past Tuesday's bar. The gap between the pairs is the point, because a
 * process where arrivals outrun completions has a backlog whatever its
 * completion rate says.
 */
export function Trend({ series, bucketDays }: { series: Point[]; bucketDays: number }) {
  const most = Math.max(1, ...series.flatMap((p) => [p.arrived, p.finished]));
  const per = bucketDays === 1 ? 'day' : bucketDays === 7 ? 'week' : 'month';

  const totalArrived = series.reduce((n, p) => n + p.arrived, 0);
  const totalFinished = series.reduce((n, p) => n + p.finished, 0);

  if (!series.length) return null;

  const slot = (W - PAD_L) / series.length;
  const barW = Math.max(3, Math.min(14, (slot - 6) / 2));
  const y = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - v / most);

  // At most six labels, whatever the bucket count, so they never collide.
  const labelEvery = Math.max(1, Math.ceil(series.length / 6));

  return (
    <section className="ch">
      <header className="ch__head">
        <h3 className="ch__title">Arriving and finishing, per {per}</h3>
        <span className="ch__note">
          {totalArrived} in, {totalFinished} out
          {totalArrived > totalFinished && <span className="ch__past"> · the backlog grew</span>}
        </span>
      </header>

      <div className="ch__plotWrap">
        <svg
          className="ch__plot"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Per ${per} over the period: ${series
            .map((p) => `${p.label}, ${p.arrived} arrived and ${p.finished} finished`)
            .join('; ')}.`}
        >
          {/* Three gridlines and their values. More would be decoration. */}
          {[0, Math.round(most / 2), most].map((v) => (
            <g key={v}>
              <line x1={PAD_L} x2={W} y1={y(v)} y2={y(v)} className="ch__grid" />
              <text x={PAD_L - 6} y={y(v) + 3.5} className="ch__axis" textAnchor="end">
                {v}
              </text>
            </g>
          ))}

          {series.map((p, i) => {
            const x = PAD_L + i * slot + (slot - barW * 2 - 2) / 2;
            const floor = y(0);
            return (
              <g key={p.bucket}>
                <rect
                  x={x}
                  y={y(p.arrived)}
                  width={barW}
                  height={Math.max(0, floor - y(p.arrived))}
                  className="ch__in"
                  rx="1.5"
                />
                <rect
                  x={x + barW + 2}
                  y={y(p.finished)}
                  width={barW}
                  height={Math.max(0, floor - y(p.finished))}
                  className="ch__out"
                  rx="1.5"
                />
                {i % labelEvery === 0 && (
                  <text x={x + barW} y={H - 6} className="ch__axis" textAnchor="middle">
                    {p.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <p className="ch__key">
        <span className="ch__keyItem">
          <span className="ch__swatch ch__swatch--in" /> arrived
        </span>
        <span className="ch__keyItem">
          <span className="ch__swatch ch__swatch--out" /> finished
        </span>
        <span className="ch__keyNote">Counts, not rates — a percentage of one week's three records describes them.</span>
      </p>
    </section>
  );
}
