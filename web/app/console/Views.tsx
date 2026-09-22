'use client';

import { useCallback, useEffect, useState } from 'react';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next?: string) => {
      setBusy(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '25' });
        if (next) params.set('cursor', next);
        if (filter === 'open') params.set('completed', 'false');
        if (filter === 'done') params.set('completed', 'true');
        const page = await call<Page>(`/api/browse/${processKey}?${params}`);
        // Appending on "load more", replacing on a filter change: the cursor
        // is only meaningful against the query that produced it.
        setRows((current) => (next ? [...current, ...page.data] : page.data));
        setCursor(page.next_cursor);
        setHasMore(page.has_more);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [processKey, filter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="cs__panel">
      <div className="cs__panelHead">
        <h2 className="cs__tab">Records</h2>
        <span className="cs__sort">
          <label htmlFor="rec-filter" className="vw__srOnly">
            Show
          </label>
          <select
            id="rec-filter"
            className="vw__period"
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
          >
            <option value="all">everything</option>
            <option value="open">still running</option>
            <option value="done">finished</option>
          </select>
        </span>
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
                Nothing here.
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
            {rows.length} record{rows.length === 1 ? '' : 's'} — that is all of them.
          </span>
        )}
        {rows[0]?.omitted_fields.length ? (
          <span className="vw__footnote">
            {rows[0].omitted_fields.length} field(s) withheld from your roles.
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
          Nothing is suppressed. Hard bounces and spam complaints land here, and this workspace has
          had neither.
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

      {past.length > 0 && (
        <p className="vw__note">
          {past.length} {past.length === 1 ? 'address was' : 'addresses were'} reinstated earlier.
          A fresh bounce puts one straight back — the mail server gets the last word.
        </p>
      )}
    </div>
  );
}
