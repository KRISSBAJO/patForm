'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Trend, WhereItSits, type Point, type Standing } from './Charts';

/**
 * The three nav items that used to say "Not built yet".
 *
 * **Dashboard** is §13.1's nine metrics. The design decision that matters is
 * what it does with a number it will not show: a suppressed rate prints the
 * reason in place of the figure rather than a dash, because a dash reads as
 * zero and this one means "too few people to say without identifying them".
 *
 * **Records** is the browse view, paged by cursor. It shares the public API's
 * pagination rather than adding an offset query for the console's convenience,
 * so one behaviour is tested twice instead of two behaviours once.
 *
 * **Automation health** is where deliverability lives: the addresses this
 * deployment has stopped writing to, and why. A suppression list nobody can
 * see is a silent change in behaviour.
 */

async function call<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

// ------------------------------------------------------------------ metrics

interface Measurement {
  key: string;
  name: string;
  unit: string;
  value: number | null;
  of: number | null;
  percentiles?: { p50: number; p75: number; p95: number } | null;
  suppressed: string | null;
  definition: string;
}

interface DashboardData {
  processName: string;
  versions: number[];
  from: string;
  to: string;
  metricsVersion: string;
  minCohort: number;
  metrics: Measurement[];
  declared: { key: string; name: string; computed: boolean }[];
  standing: Standing[];
  series: Point[];
  bucketDays: number;
}

function formatted(m: Measurement): string {
  if (m.value === null) return '—';
  if (m.unit === 'percent') return `${m.value}%`;
  if (m.unit === 'hours') return m.value < 48 ? `${m.value}h` : `${Math.round(m.value / 24)}d`;
  return String(m.value);
}

export function DashboardView({ processKey }: { processKey: string }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await call<DashboardData>(`/api/dashboard/${processKey}?days=${days}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [processKey, days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="cs__panel">
        <div className="cs__empty" role="alert">
          <strong>Refused.</strong>
          <div style={{ marginTop: 6, fontSize: 13 }}>{error}</div>
        </div>
      </div>
    );
  }
  if (!data) return <div className="cs__panel"><div className="cs__empty">Loading…</div></div>;

  const notComputed = data.declared.filter((d) => !d.computed);

  return (
    <div className="cs__panel">
      <div className="cs__panelHead">
        <h2 className="cs__tab">{data.processName}</h2>
        <span className="cs__sort">
          <label htmlFor="dash-days" className="vw__srOnly">
            Period
          </label>
          <select
            id="dash-days"
            className="vw__period"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>last 7 days</option>
            <option value={30}>last 30 days</option>
            <option value={90}>last 90 days</option>
          </select>
        </span>
      </div>

      <div className="vw__metrics">
        {data.metrics.map((m) => (
          <button
            key={m.key}
            className={`vw__metric${m.suppressed ? ' vw__metric--withheld' : ''}`}
            onClick={() => setOpen(open === m.key ? null : m.key)}
            aria-expanded={open === m.key}
          >
            <span className="vw__metricLabel">{m.name}</span>
            <span className="vw__metricValue">{formatted(m)}</span>
            {m.percentiles && (
              <span className="vw__metricMeta">
                p75 {m.percentiles.p75}h · p95 {m.percentiles.p95}h · n={m.of}
              </span>
            )}
            {!m.percentiles && m.of !== null && !m.suppressed && (
              <span className="vw__metricMeta">of {m.of}</span>
            )}
            {/* A suppressed rate says why, where the number would be. A dash
                reads as zero, and this one means something quite different. */}
            {m.suppressed && <span className="vw__metricWithheld">{m.suppressed}</span>}
          </button>
        ))}
      </div>

      {open && (
        <p className="vw__definition" role="status">
          <strong>{data.metrics.find((m) => m.key === open)!.name}.</strong>{' '}
          {data.metrics.find((m) => m.key === open)!.definition}
        </p>
      )}

      {/*
        * Under the numbers, the two questions they leave open: where the work
        * is, and which way it is going. The panel below them was empty, and
        * an empty half-page under nine tiles reads as a dashboard that has
        * not been finished.
        */}
      <WhereItSits standing={data.standing} />
      <Trend series={data.series} bucketDays={data.bucketDays} />

      <p className="vw__footnote">
        {data.from.slice(0, 10)} to {data.to.slice(0, 10)} · version
        {data.versions.length > 1 ? 's' : ''} {data.versions.join(', ')} · definitions{' '}
        <code>{data.metricsVersion}</code> · rates over fewer than {data.minCohort} records are withheld.
        {notComputed.length > 0 && (
          <>
            {' '}
            This process also asks for {notComputed.map((d) => d.name).join(', ')}, which{' '}
            {notComputed.length === 1 ? 'is' : 'are'} not computed yet.
          </>
        )}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ records

interface PublicRecord {
  id: string;
  reference: string;
  state: string;
  state_name: string;
  outcome: string | null;
  created_at: string;
  completed_at: string | null;
  data: Record<string, unknown>;
  omitted_fields: string[];
}

interface Page {
  data: PublicRecord[];
  next_cursor: string | null;
  has_more: boolean;
}

export function RecordsView({
  processKey,
  onOpenRecord,
}: {
  processKey: string;
  onOpenRecord: (id: string) => void;
}) {
  const [rows, setRows] = useState<PublicRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('all');
  const [order, setOrder] = useState<'newest' | 'oldest' | 'reference'>('newest');
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * A pause before searching.
   *
   * Each keystroke here is a round trip and a fresh cursor — the server has
   * to do the searching, because searching the twenty-five rows that happen
   * to be loaded would report "nothing matches" about a set of eight hundred.
   */
  useEffect(() => {
    const t = setTimeout(() => setQuery(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);

  const load = useCallback(
    async (next?: string) => {
      setBusy(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '25', order });
        if (next) params.set('cursor', next);
        if (filter === 'open') params.set('completed', 'false');
        if (filter === 'done') params.set('completed', 'true');
        if (query) params.set('q', query);
        const page = await call<Page>(`/api/browse/${processKey}?${params}`);
        // Appending on "load more", replacing on any change to the query: a
        // cursor is only meaningful against the query that produced it, and
        // that now includes the order and the search text.
        setRows((current) => (next ? [...current, ...page.data] : page.data));
        setCursor(page.next_cursor);
        setHasMore(page.has_more);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [processKey, filter, order, query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="cs__panel">
      <div className="cs__panelHead">
        <h2 className="cs__tab">Records</h2>
        <span className="cs__sort">
          {busy ? 'searching…' : `${rows.length}${hasMore ? '+' : ''} shown`}
        </span>
      </div>

      {/*
        * Searching, filtering and ordering all happen on the server, against
        * every record rather than the page that is loaded. The search reaches
        * the reference and the answers this role may see — never the hidden
        * ones, which would answer "which record contains this value" without
        * showing it.
        */}
      <div className="wk__controls">
        <div className="wk__search">
          <Icon name="search" />
          <input
            className="wk__searchInput"
            type="search"
            value={typed}
            placeholder="Search the reference or any answer you can see"
            aria-label="Search records"
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>

        <label className="wk__pick">
          <span className="cs__srOnly">Show</span>
          <Icon name="filter" />
          <select className="wk__select" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">Everything</option>
            <option value="open">Still running</option>
            <option value="done">Finished</option>
          </select>
        </label>

        <label className="wk__pick">
          <span className="cs__srOnly">Order</span>
          <Icon name="sort" />
          <select className="wk__select" value={order} onChange={(e) => setOrder(e.target.value as typeof order)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="reference">By reference</option>
          </select>
        </label>
      </div>

      {error && (
        <div className="cs__empty" role="alert">
          <strong>Refused.</strong>
          <div style={{ marginTop: 6, fontSize: 13 }}>{error}</div>
        </div>
      )}

      <table className="vw__table">
        <thead>
          <tr>
            <th>Reference</th>
            <th>State</th>
            <th>Opened</th>
            <th>Finished</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <button className="ask__ref" onClick={() => onOpenRecord(r.id)}>
                  <code>{r.reference}</code>
                  <span className="ask__srOnly"> — open this record</span>
                </button>
              </td>
              <td>
                {r.state_name}
                {r.outcome && <span className="vw__outcome">{r.outcome}</span>}
              </td>
              <td>{r.created_at.slice(0, 10)}</td>
              <td>{r.completed_at ? r.completed_at.slice(0, 10) : '—'}</td>
            </tr>
          ))}
          {!rows.length && !busy && (
            <tr>
              <td colSpan={4} className="ask__empty">
                {query || filter !== 'all' ? (
                  <>
                    Nothing matches that.{' '}
                    <button
                      type="button"
                      className="cs__linkBtn cs__linkBtn--onLight"
                      onClick={() => {
                        setTyped('');
                        setFilter('all');
                      }}
                    >
                      Clear the filters
                    </button>
                  </>
                ) : (
                  'No records yet. They arrive when somebody submits the form.'
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="vw__more">
        {hasMore ? (
          <button className="cs__btn" onClick={() => void load(cursor ?? undefined)} disabled={busy}>
            {busy ? 'Loading…' : 'Load more'}
          </button>
        ) : (
          <span className="vw__footnote">
            {rows.length} record{rows.length === 1 ? '' : 's'}
            {query || filter !== 'all' ? ' matching' : ''} — that is all of them.
          </span>
        )}
        {rows[0]?.omitted_fields.length ? (
          <span className="vw__footnote">
            {rows[0].omitted_fields.length} field{rows[0].omitted_fields.length === 1 ? '' : 's'} withheld from your
            roles.
          </span>
        ) : null}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- deliverability

interface Suppressed {
  email: string;
  reason: 'hard_bounce' | 'complaint' | 'manual';
  detail: string | null;
  created_at: string;
  lifted_at: string | null;
}

const WHY: Record<Suppressed['reason'], string> = {
  hard_bounce: 'The mail server said this address does not exist.',
  complaint: 'Somebody here pressed the spam button.',
  manual: 'Blocked by an operator.',
};

/**
 * The third nav item that said "Not built yet".
 *
 * It shows the addresses this deployment has stopped writing to, because a
 * suppression list nobody can see is a silent change in behaviour: messages
 * stop arriving and the record says "skipped" with no page that explains it.
 *
 * Reinstating is deliberately a little uncomfortable — the reason is spelled
 * out next to the button, and a fresh bounce overrules it anyway. The common
 * case is a typo that has since been corrected, and the second-commonest is
 * somebody assuming the list is wrong because they cannot see why it is right.
 */
export function HealthView({ canAdminister }: { canAdminister: boolean }) {
  const [rows, setRows] = useState<Suppressed[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [health, setHealth] = useState<SendingHealth | null>(null);
  /** The address whose missed messages are open, after reinstating it. */
  const [missed, setMissed] = useState<string | null>(null);

  useEffect(() => {
    call<SendingHealth>('/api/delivery/health')
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const body = await call<{ suppressed: Suppressed[] }>('/api/delivery/suppressed');
      setRows(body.suppressed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reinstate = async (email: string) => {
    setBusy(email);
    setNote(null);
    try {
      const res = await fetch('/api/delivery/suppressed/lift', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
      setNote(`${email} will be written to again.`);
      setMissed(canAdminister ? email : null);
      await load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="cs__panel">
        <div className="cs__empty" role="alert">
          <strong>Refused.</strong>
          <div style={{ marginTop: 6, fontSize: 13 }}>{error}</div>
        </div>
      </div>
    );
  }
  if (!rows) {
    return (
      <div className="cs__panel">
        <div className="cs__empty">Loading…</div>
      </div>
    );
  }

  const live = rows.filter((r) => !r.lifted_at);
  const past = rows.filter((r) => r.lifted_at);

  return (
    <>
    {health && <SendingHealthPanel health={health} />}
    <div className="cs__panel">
      <div className="cs__panelHead">
        <h2 className="cs__tab">Addresses we have stopped writing to</h2>
        <span className="cs__sort">{live.length} active</span>
      </div>

      {/* The change announced, not just rendered. */}
      {note && (
        <p className="vw__note" role="status">
          {note}
        </p>
      )}

      {!live.length ? (
        <div className="cs__empty">
          {past.length
            ? 'Nothing is suppressed right now. Hard bounces and spam complaints land here.'
            : 'Nothing is suppressed. Hard bounces and spam complaints land here, and this workspace has had neither.'}
        </div>
      ) : (
        <table className="vw__table">
          <caption className="vw__srOnly">
            Suppressed recipients, with the reason and when it happened
          </caption>
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col">Why</th>
              <th scope="col">Since</th>
              {canAdminister && <th scope="col">Action</th>}
            </tr>
          </thead>
          <tbody>
            {live.map((row) => (
              <tr key={row.email}>
                <td style={{ overflowWrap: 'anywhere' }}>{row.email}</td>
                <td>
                  {WHY[row.reason]}
                  {row.detail && <div className="vw__detail">{row.detail}</div>}
                </td>
                <td>{new Date(row.created_at).toLocaleDateString()}</td>
                {canAdminister && (
                  <td>
                    <button
                      type="button"
                      className="cs__btn"
                      disabled={busy === row.email}
                      onClick={() => void reinstate(row.email)}
                    >
                      {busy === row.email ? 'Reinstating…' : 'Reinstate'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {missed && <MissedMessages email={missed} onClose={() => setMissed(null)} />}

      {past.length > 0 && (
        <>
          <p className="vw__note">
            {past.length} {past.length === 1 ? 'address was' : 'addresses were'} reinstated earlier.
            A fresh bounce puts one straight back — the mail server gets the last word.
          </p>
          {canAdminister && (
            <ul className="mm__past">
              {past.map((row) => (
                <li key={row.email}>
                  <span style={{ overflowWrap: 'anywhere' }}>{row.email}</span>
                  <button type="button" className="mm__link" onClick={() => setMissed(row.email)}>
                    What it missed
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
    </>
  );
}

interface SendingHealth {
  windowDays: number;
  sent: number;
  bounced: number;
  complained: number;
  bounceRate: number;
  complaintRate: number;
  level: 'ok' | 'watch' | 'act' | 'too_few';
  thresholds: { bounce: { watch: number; act: number }; complaint: { watch: number; act: number } };
}

const HEALTH_WORDS: Record<SendingHealth['level'], string> = {
  ok: 'Healthy',
  watch: 'Watch',
  act: 'Act now',
  too_few: 'Too few sent to judge',
};

/**
 * What the email provider will judge the account by, from this workspace's
 * share of it.
 *
 * Shown as two rates against the point where the provider starts reviewing,
 * because a bare "2.4%" means nothing to somebody who does not already know
 * that 5% is where it gets serious.
 */
function SendingHealthPanel({ health }: { health: SendingHealth }) {
  const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;
  const rows = [
    {
      label: 'Hard bounces',
      count: health.bounced,
      rate: health.bounceRate,
      watch: health.thresholds.bounce.watch,
      act: health.thresholds.bounce.act,
      digits: 1,
    },
    {
      label: 'Spam complaints',
      count: health.complained,
      rate: health.complaintRate,
      watch: health.thresholds.complaint.watch,
      act: health.thresholds.complaint.act,
      digits: 2,
    },
  ];
  return (
    <div className="cs__panel" style={{ marginBottom: 16 }}>
      <div className="cs__panelHead">
        <h2 className="cs__tab">Sending health</h2>
        <span className={`sh__level sh__level--${health.level}`}>{HEALTH_WORDS[health.level]}</span>
      </div>
      <p className="vw__note">
        {health.sent} {health.sent === 1 ? 'message' : 'messages'} sent in the last {health.windowDays} days.
        {health.level === 'too_few'
          ? ' Too few for a rate to mean anything yet.'
          : ' The email provider reviews an account at the thresholds below, and a paused account stops every message — including password resets.'}
      </p>
      <dl className="sh__rates">
        {rows.map((r) => (
          <div key={r.label} className="sh__rate">
            <dt>{r.label}</dt>
            <dd>
              <strong>{pct(r.rate, r.digits)}</strong> <span className="sh__count">({r.count})</span>
              <div
                className="sh__bar"
                role="img"
                aria-label={`${pct(r.rate, r.digits)} against a review threshold of ${pct(r.act, r.digits)}`}
              >
                <span
                  className={`sh__fill${r.rate >= r.act ? ' sh__fill--act' : r.rate >= r.watch ? ' sh__fill--watch' : ''}`}
                  style={{ width: `${Math.min(100, (r.rate / r.act) * 100)}%` }}
                />
              </div>
              <span className="sh__threshold">
                watch at {pct(r.watch, r.digits)} · reviewed at {pct(r.act, r.digits)}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

interface Skipped {
  logId: string;
  reference: string;
  processName: string;
  template: string;
  subject: string;
  skippedAt: string;
  recordFinished: boolean;
  resentAt: string | null;
}

/**
 * The messages an address missed while it was blocked, and a way to send them.
 *
 * Nothing is ticked for a record that has finished: "your approval is
 * waiting" about an approval given last week is worse than no email. Each
 * one is rendered from the record as it is now, not as it was, and the list
 * says so.
 */
function MissedMessages({ email, onClose }: { email: string; onClose: () => void }) {
  const [rows, setRows] = useState<Skipped[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    const body = await call<{ skipped: Skipped[] }>(`/api/delivery/skipped?email=${encodeURIComponent(email)}`);
    setRows(body.skipped);
    setChosen(new Set(body.skipped.filter((s) => !s.resentAt && !s.recordFinished).map((s) => s.logId)));
  }, [email]);

  useEffect(() => {
    void load().catch((err) => setResult(err instanceof Error ? err.message : String(err)));
  }, [load]);

  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const body = await post<{ results: { logId: string; sent: boolean; reason?: string }[] }>('/api/delivery/resend', {
        email,
        logIds: [...chosen],
      });
      const sent = body.results.filter((r) => r.sent).length;
      const failed = body.results.filter((r) => !r.sent);
      setResult(
        `${sent} sent to ${email}.` +
          (failed.length ? ` ${failed.length} not sent: ${[...new Set(failed.map((f) => f.reason))].join('; ')}.` : ''),
      );
      await load();
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const open = rows?.filter((r) => !r.resentAt) ?? [];

  return (
    <section className="mm" aria-labelledby="mm-title">
      <div className="mm__head">
        <h3 id="mm-title">What {email} missed</h3>
        <button type="button" className="mm__link" onClick={onClose}>
          Close
        </button>
      </div>
      {!rows ? (
        <p className="vw__note">Loading…</p>
      ) : !rows.length ? (
        <p className="vw__note">Nothing. No message from this workspace was held back from this address.</p>
      ) : (
        <>
          <p className="vw__note">
            These were not sent while the address was blocked. Sending one now uses the record as it is today, not as it
            was — so a reminder about a record that has since finished is left unticked.
          </p>
          <ul className="mm__list">
            {rows.map((r) => (
              <li key={r.logId} className="mm__item">
                <label className="mm__check">
                  <input
                    type="checkbox"
                    disabled={Boolean(r.resentAt) || busy}
                    checked={chosen.has(r.logId)}
                    onChange={(e) =>
                      setChosen((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(r.logId);
                        else next.delete(r.logId);
                        return next;
                      })
                    }
                  />
                  <span>
                    <strong>{r.template}</strong> — {r.processName} {r.reference}
                    <span className="mm__meta">
                      {' '}
                      skipped {new Date(r.skippedAt).toLocaleDateString()}
                      {r.recordFinished ? ' · record has finished' : ''}
                      {r.resentAt ? ` · sent again ${new Date(r.resentAt).toLocaleDateString()}` : ''}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {open.length > 0 && (
            <button
              type="button"
              className="cs__btn cs__btn--primary"
              disabled={busy || chosen.size === 0}
              onClick={() => void send()}
              style={{ margin: '0 18px 16px' }}
            >
              {busy ? 'Sending…' : `Send ${chosen.size} now`}
            </button>
          )}
        </>
      )}
      {result && (
        <p className="vw__note vw__note--done" role="status">
          {result}
        </p>
      )}
    </section>
  );
}

// --------------------------------------------------- two-step verification

interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  recoveryCodesLeft: number;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(parsed.reason ?? parsed.error ?? `HTTP ${res.status}`);
  return parsed as T;
}

/**
 * Turning the second factor on, and off.
 *
 * Built at the same time as the factor itself rather than after it. An
 * enrolment endpoint with no screen is a feature nobody can use, and a sign-in
 * that demands a code from an account that had no way to set one up is a
 * lockout — which is this project's most repeated failure wearing a new hat.
 *
 * The secret is shown as text rather than a QR image on purpose: generating a
 * QR needs a dependency, and every authenticator app accepts a typed key. The
 * `otpauth://` link is there for a phone that can open it directly.
 */
export function SecurityView() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await call<MfaStatus>('/api/account/mfa'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <div className="cs__panel">
        <div className="cs__empty">Loading…</div>
      </div>
    );
  }

  // ---- the codes, shown once
  if (codes) {
    return (
      <div className="cs__panel">
        <div className="cs__panelHead">
          <h2 className="cs__tab">Save your recovery codes</h2>
        </div>
        <p className="vw__note" role="status">
          Each one works once, and they are the only way back in if you lose your phone. We cannot
          show them again — we only keep hashes, so a copy of our database is not a set of working
          codes.
        </p>
        <ul className="vw__codes">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <p className="vw__note">
          <button
            type="button"
            className="cs__btn"
            onClick={() => {
              void navigator.clipboard?.writeText(codes.join('\n'));
              setNote('Copied.');
            }}
          >
            Copy all
          </button>{' '}
          <button
            type="button"
            className="cs__btn cs__btn--primary"
            onClick={() => {
              setCodes(null);
              setNote(null);
              void load();
            }}
          >
            I have saved them
          </button>
        </p>
        {note && (
          <p className="vw__note" role="status">
            {note}
          </p>
        )}
      </div>
    );
  }

  // ---- mid-enrolment
  if (setup) {
    return (
      <div className="cs__panel">
        <div className="cs__panelHead">
          <h2 className="cs__tab">Set up two-step verification</h2>
        </div>
        <p className="vw__note" style={{ marginBottom: 0 }}>
          Add this key to an authenticator app, then type the code it shows. Nothing changes until
          you do — an account that switched on before you proved the app had the key would be an
          account you could not sign into.
        </p>
        <p className="vw__secret">{setup.secret}</p>
        <p className="vw__note" style={{ marginTop: 0 }}>
          <a href={setup.uri} style={{ textDecoration: 'underline', color: 'var(--green-deep)' }}>
            Open in an authenticator app
          </a>
        </p>

        <form
          className="vw__inline"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const done = await post<{ recoveryCodes: string[] }>('/api/account/mfa/confirm', { code });
              setSetup(null);
              setCode('');
              setCodes(done.recoveryCodes);
            });
          }}
        >
          <label className="cs__label" htmlFor="enrol-code">
            Code from your app
          </label>
          <input
            id="enrol-code"
            className="cs__input"
            type="text"
            autoComplete="one-time-code"
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          {error && (
            <p className="cs__loginError" role="alert">
              {error}
            </p>
          )}
          <div className="vw__actions">
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy}>
              {busy ? 'Checking…' : 'Turn it on'}
            </button>
            <button type="button" className="cs__btn" onClick={() => setSetup(null)}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    );
  }

  // ---- on, or off
  return (
    <div className="cs__panel">
      <div className="cs__panelHead">
        <h2 className="cs__tab">Two-step verification</h2>
        <span className="cs__sort">{status.enabled ? 'on' : 'off'}</span>
      </div>

      {note && (
        <p className="vw__note" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="vw__note" role="alert" style={{ color: 'var(--red-text)' }}>
          {error}
        </p>
      )}

      {status.enabled ? (
        <>
          <p className="vw__note">
            Signing in asks for a code from your authenticator app as well as your password.{' '}
            <strong>{status.recoveryCodesLeft}</strong> recovery{' '}
            {status.recoveryCodesLeft === 1 ? 'code is' : 'codes are'} unused.
          </p>
          <form
            className="vw__inline"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const done = await post<{ recoveryCodes: string[] }>('/api/account/mfa/recovery-codes', {
                  password,
                });
                setPassword('');
                setCodes(done.recoveryCodes);
              });
            }}
          >
            <label className="cs__label" htmlFor="mfa-password">
              Your password
            </label>
            <input
              id="mfa-password"
              className="cs__input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              aria-describedby="mfa-password-hint"
            />
            <p id="mfa-password-hint" className="vw__note" style={{ margin: '6px 0 0' }}>
              Both of these need your password rather than a code. Somebody holding your phone but
              not your password is exactly who should not be able to turn this off.
            </p>
            <div className="vw__actions">
              <button type="submit" className="cs__btn" disabled={busy || !password}>
                New recovery codes
              </button>
              <button
                type="button"
                className="cs__btn"
                disabled={busy || !password}
                onClick={() =>
                  void run(async () => {
                    await post('/api/account/mfa/disable', { password });
                    setPassword('');
                    setNote('Two-step verification is off.');
                    await load();
                  })
                }
              >
                Turn it off
              </button>
            </div>
          </form>
        </>
      ) : (
        <>
          <p className="vw__note">
            Add a code from an authenticator app to your password. It is the one change here that
            makes a stolen password insufficient on its own.
          </p>
          <p className="vw__note">
            <button
              type="button"
              className="cs__btn cs__btn--primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setSetup(await post<{ secret: string; uri: string }>('/api/account/mfa/begin', {}));
                })
              }
            >
              {status.pending ? 'Continue setting it up' : 'Set it up'}
            </button>
          </p>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ held intake

interface Held {
  id: string;
  reference: string;
  processKey: string;
  processName: string;
  receivedAt: string;
  reasons: string[];
  seconds: number | null;
  answers: { label: string; value: string }[];
}

/**
 * What screening kept back from the public forms.
 *
 * The words matter more than the buttons here. Somebody opening this has
 * to understand that nothing on it has happened yet — no record, no receipt,
 * no email to the manager address it names — and that releasing one makes
 * all of that happen now. Why each one was held is said in plain terms,
 * because "looks automated" with nothing behind it is a verdict nobody can
 * check.
 */
export function HeldView({ onChanged }: { onChanged: (count: number) => void }) {
  const [rows, setRows] = useState<Held[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const body = await call<{ held: Held[] }>('/api/held');
      setRows(body.held);
      onChanged(body.held.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  const release = async (row: Held) => {
    setBusy(row.id);
    setNote(null);
    try {
      const res = await post<{ reference: string; duplicate: boolean }>(`/api/held/${row.id}/release`, {});
      setNote(
        res.duplicate
          ? `${row.reference} matched a record that already exists (${res.reference}), so it was added to that record's history instead of making a second one.`
          : `${row.reference} is now a record. Its receipt and its first request have gone out, as they would have when it arrived.`,
      );
      await load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const discard = async (row: Held) => {
    if (!confirm(`Discard ${row.reference}? Its answers are deleted now and cannot be recovered.`)) return;
    setBusy(row.id);
    setNote(null);
    try {
      await post(`/api/held/${row.id}/discard`, {});
      setNote(`${row.reference} was discarded and its answers deleted.`);
      await load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="cs__panel">
        <div className="cs__empty" role="alert">
          <strong>Refused.</strong>
          <div style={{ marginTop: 6, fontSize: 13 }}>{error}</div>
        </div>
      </div>
    );
  }
  if (!rows) {
    return (
      <div className="cs__panel">
        <div className="cs__empty">Loading…</div>
      </div>
    );
  }

  return (
    <div className="cs__panel">
      <div className="cs__panelHead">
        <h2 className="cs__tab">Held for a person to check</h2>
        <span className="cs__sort">{rows.length} waiting</span>
      </div>
      <p className="vw__note">
        These came in through a public form and looked automated. <strong>None of them has done anything yet</strong> —
        no record, no receipt, no email to anyone they name. Release one and it becomes a record as if it had just
        arrived. Anything left here is deleted after thirty days.
      </p>

      {note && (
        <p className="vw__note vw__note--done" role="status">
          {note}
        </p>
      )}

      {!rows.length ? (
        <div className="cs__empty">Nothing is held. Every public submission so far looked like a person filled it in.</div>
      ) : (
        <ul className="hd__list">
          {rows.map((row) => {
            const expanded = open.has(row.id);
            const answers = expanded ? row.answers : row.answers.slice(0, 4);
            return (
              <li key={row.id} className="hd__item">
                <div className="hd__head">
                  <span className="hd__ref">{row.reference}</span>
                  <span className="hd__process">{row.processName}</span>
                  <span className="hd__when">{new Date(row.receivedAt).toLocaleString()}</span>
                </div>
                <ul className="hd__why" aria-label="Why it was held">
                  {row.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                  {row.seconds !== null && <li className="hd__whyQuiet">took {row.seconds}s</li>}
                </ul>
                <dl className="hd__answers">
                  {answers.map((a) => (
                    <div key={a.label} className="hd__answer">
                      <dt>{a.label}</dt>
                      <dd>{a.value}</dd>
                    </div>
                  ))}
                </dl>
                {row.answers.length > 4 && (
                  <button
                    type="button"
                    className="hd__more"
                    aria-expanded={expanded}
                    onClick={() =>
                      setOpen((prev) => {
                        const next = new Set(prev);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      })
                    }
                  >
                    {expanded ? 'Show fewer answers' : `Show all ${row.answers.length} answers`}
                  </button>
                )}
                <div className="hd__actions">
                  <button
                    type="button"
                    className="cs__btn cs__btn--primary"
                    disabled={busy !== null}
                    onClick={() => void release(row)}
                  >
                    {busy === row.id ? 'Working…' : 'Release as a record'}
                  </button>
                  <button type="button" className="cs__btn" disabled={busy !== null} onClick={() => void discard(row)}>
                    Discard
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
