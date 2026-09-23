'use client';

/**
 * The twenty-six endpoints nothing called.
 *
 * API keys, webhooks and their deliveries, OAuth clients and grants, CSV
 * import, the data map, retention, and the copilot's history. Each was built,
 * proved and documented, and none of them had a screen — which `npm run
 * reachable` now counts rather than leaving somebody to notice.
 *
 * They are grouped by the question being asked rather than by the module they
 * came from: *what is connected to us*, and *what do we do with the data*.
 * A settings area organised by implementation is a settings area nobody can
 * navigate.
 */

import { useCallback, useEffect, useState } from 'react';
import { postJson } from './stepup';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

/** Asks the person to confirm it is them when an action needs a recent sign-in; see stepup.tsx. */
const post = postJson;

function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="cs__panel st__panel">
      <div className="cs__panelHead">
        <h2 className="cs__tab">{title}</h2>
        {aside !== undefined && <span className="cs__sort">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

function useFeed<T>(path: string, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      setData(await get<T>(path));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [path, enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, reload: load };
}

function Empty({ what, why }: { what: string; why: string }) {
  return (
    <div className="cs__empty">
      <strong>{what}</strong>
      <div style={{ marginTop: 6, fontSize: 13 }}>{why}</div>
    </div>
  );
}

// ------------------------------------------------------------- integrations

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  rotating: boolean;
  dead_letters: number;
}

interface Delivery {
  id: number;
  event_name: string;
  status: string;
  attempts: number;
  response_status: number | null;
  last_error: string | null;
  url: string | null;
  created_at: string;
}

interface Grant {
  id: string;
  client_name: string;
  scopes: string[];
  granted_by: string;
  created_at: string;
  revoked_at: string | null;
}

/*
 * What a key may do, in the names the server actually checks.
 *
 * This list used to be `records:read`, `records:write`, `processes:read` and
 * `events:read` — names that exist nowhere on the server, which scopes keys by
 * capability. Every one failed the "no broader than you" check, so no key
 * could be created from this page at all. Found testing the step-up prompt,
 * which confirmed correctly and then watched the retried request fail.
 */
const SCOPES: { value: string; label: string }[] = [
  { value: 'view', label: 'Read processes and records' },
  { value: 'edit', label: 'Create records and import them' },
  { value: 'report', label: 'Read metrics' },
];

export function IntegrationsView() {
  const keys = useFeed<ApiKey[]>('/api/keys');
  const endpoints = useFeed<Endpoint[]>('/api/webhooks');
  const deliveries = useFeed<Delivery[]>('/api/webhooks/deliveries');
  const grants = useFeed<Grant[]>('/api/oauth/grants');

  const [note, setNote] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ what: string; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<string[]>(['view']);
  const [hookUrl, setHookUrl] = useState('');
  const [hookKind, setHookKind] = useState<'http' | 'slack' | 'teams'>('http');
  const [clientName, setClientName] = useState('');
  const [clientRedirects, setClientRedirects] = useState('');
  const [confidential, setConfidential] = useState(true);

  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id);
    setNote(null);
    try {
      setNote(await work());
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const error = keys.error ?? endpoints.error ?? grants.error;
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

  return (
    <>
      {/*
        * Shown once and never again, for either credential. Both are stored
        * as hashes, so this screen is the only time the value exists outside
        * the caller's own notes.
        */}
      {minted && (
        <div className="cs__panel st__panel st__minted">
          <div className="cs__panelHead">
            <h2 className="cs__tab">Copy your {minted.what} now</h2>
          </div>
          <p className="vw__note" style={{ marginTop: 14 }} role="status">
            We keep only a hash of it, so this cannot be shown again. If you lose it, revoke this
            one and make another.
          </p>
          <p className="st__secret">{minted.value}</p>
          <p className="vw__note">
            <button
              type="button"
              className="cs__btn"
              onClick={() => void navigator.clipboard?.writeText(minted.value)}
            >
              Copy
            </button>{' '}
            <button type="button" className="cs__btn cs__btn--primary" onClick={() => setMinted(null)}>
              I have saved it
            </button>
          </p>
        </div>
      )}

      {note && (
        <p className="st__note" role="status">
          {note}
        </p>
      )}

      <Panel title="API keys" aside={`${keys.data?.filter((k) => !k.revoked_at).length ?? 0} active`}>
        <p className="vw__note" style={{ marginTop: 14 }}>
          For a system calling the public API at <code>/v1</code>. A key carries the permissions it
          was made with, intersected with the role of whoever made it — so it can never do more than
          they can.
        </p>

        <form
          className="mg__invite"
          onSubmit={(e) => {
            e.preventDefault();
            void act('new-key', async () => {
              const made = await post<{ key: string }>('/api/keys', {
                name: keyName,
                scopes: keyScopes,
              });
              setKeyName('');
              setMinted({ what: 'API key', value: made.key });
              await keys.reload();
              return 'Key created.';
            });
          }}
        >
          <div className="mg__field">
            <label className="cs__label" htmlFor="key-name">
              What is it for
            </label>
            <input
              id="key-name"
              className="cs__input"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="HRIS sync"
              required
            />
          </div>
          <div className="mg__field">
            <fieldset className="st__fieldset">
              <legend className="cs__label">What it may do</legend>
              {SCOPES.map((scope) => (
                <label key={scope.value} className="st__check">
                  <input
                    type="checkbox"
                    checked={keyScopes.includes(scope.value)}
                    onChange={(e) =>
                      setKeyScopes((was) =>
                        e.target.checked ? [...was, scope.value] : was.filter((s) => s !== scope.value),
                      )
                    }
                  />
                  {scope.label} <code>{scope.value}</code>
                </label>
              ))}
            </fieldset>
          </div>
          <div className="mg__actions">
            <button
              type="submit"
              className="cs__btn cs__btn--primary"
              disabled={busy === 'new-key' || !keyScopes.length}
            >
              Create key
            </button>
          </div>
        </form>

        {keys.data?.length ? (
          <table className="vw__table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Scopes</th>
                <th scope="col">Last used</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id} className={k.revoked_at ? 'vw__rowOff' : undefined}>
                  <th scope="row">
                    {k.name}
                    <span className="mg__sub">
                      {k.key_prefix}… · made by {k.created_by}
                    </span>
                    {k.revoked_at && <span className="mg__tag">revoked</span>}
                  </th>
                  <td>{k.scopes.join(', ')}</td>
                  <td>{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'never'}</td>
                  <td>
                    {!k.revoked_at && (
                      <button
                        type="button"
                        className="cs__btn"
                        disabled={busy === k.id}
                        onClick={() =>
                          void act(k.id, async () => {
                            await post(`/api/keys/${k.id}/revoke`);
                            await keys.reload();
                            return `"${k.name}" stops working immediately.`;
                          })
                        }
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty what="No keys yet." why="Nothing is calling the API on your behalf." />
        )}
      </Panel>

      <Panel title="Webhook endpoints" aside={`${endpoints.data?.length ?? 0}`}>
        <p className="vw__note" style={{ marginTop: 14 }}>
          Where events go when a record moves. Signed with HMAC-SHA256 over the timestamp and the
          exact body, so the receiver can tell they came from us and cannot be replayed later.
        </p>

        <form
          className="mg__invite"
          onSubmit={(e) => {
            e.preventDefault();
            void act('new-hook', async () => {
              const made = await post<{ secret?: string }>('/api/webhooks', {
                url: hookUrl,
                kind: hookKind,
              });
              setHookUrl('');
              if (made.secret) setMinted({ what: 'signing secret', value: made.secret });
              await endpoints.reload();
              return 'Endpoint added.';
            });
          }}
        >
          <div className="mg__field mg__field--wide">
            <label className="cs__label" htmlFor="hook-url">
              Endpoint URL
            </label>
            <input
              id="hook-url"
              className="cs__input"
              type="url"
              value={hookUrl}
              onChange={(e) => setHookUrl(e.target.value)}
              placeholder="https://example.com/hooks/patform"
              required
            />
          </div>
          <div className="mg__field">
            <label className="cs__label" htmlFor="hook-kind">
              Kind
            </label>
            <select
              id="hook-kind"
              className="cs__input"
              value={hookKind}
              onChange={(e) => setHookKind(e.target.value as typeof hookKind)}
              aria-describedby="hook-kind-hint"
            >
              <option value="http">Your own service</option>
              <option value="slack">Slack</option>
              <option value="teams">Microsoft Teams</option>
            </select>
            <p id="hook-kind-hint" className="mg__hint">
              {hookKind === 'http'
                ? 'A signed JSON payload.'
                : 'A card carrying a reference, not the answers — a channel has a different audience from a record.'}
            </p>
          </div>
          <div className="mg__actions">
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'new-hook'}>
              Add endpoint
            </button>
          </div>
        </form>

        {endpoints.data?.length ? (
          <table className="vw__table">
            <thead>
              <tr>
                <th scope="col">Endpoint</th>
                <th scope="col">Events</th>
                <th scope="col">State</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.data.map((e) => (
                <tr key={e.id}>
                  <th scope="row" style={{ overflowWrap: 'anywhere' }}>
                    {e.url}
                    {e.description && <span className="mg__sub">{e.description}</span>}
                  </th>
                  <td>{e.events.length ? e.events.join(', ') : 'all'}</td>
                  <td>
                    {!e.active && <span className="mg__tag">disabled</span>}
                    {e.rotating && <span className="mg__tag">rotating</span>}
                    {e.dead_letters > 0 && (
                      <span className="mg__tag">{e.dead_letters} dead-lettered</span>
                    )}
                    {e.active && !e.rotating && e.dead_letters === 0 && 'healthy'}
                  </td>
                  <td>
                    <div className="mg__rowActions">
                      {e.rotating ? (
                        <button
                          type="button"
                          className="cs__btn"
                          disabled={busy === e.id}
                          onClick={() =>
                            void act(e.id, async () => {
                              await post(`/api/webhooks/${e.id}/rotate/complete`);
                              await endpoints.reload();
                              return 'The old secret stops verifying now.';
                            })
                          }
                        >
                          Finish rotation
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="cs__btn"
                          disabled={busy === e.id}
                          onClick={() =>
                            void act(e.id, async () => {
                              const done = await post<{ secret: string }>(`/api/webhooks/${e.id}/rotate`);
                              setMinted({ what: 'new signing secret', value: done.secret });
                              await endpoints.reload();
                              // Both secrets sign during the overlap, so a
                              // consumer that has not redeployed keeps working.
                              return 'Both secrets sign until you finish the rotation.';
                            })
                          }
                        >
                          Rotate secret
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty what="No endpoints." why="Nothing outside this workspace is being told when records move." />
        )}
      </Panel>

      <Panel title="Recent deliveries" aside={`${deliveries.data?.length ?? 0}`}>
        {deliveries.data?.length ? (
          <table className="vw__table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Status</th>
                <th scope="col">Attempts</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.data.slice(0, 25).map((d) => (
                <tr key={d.id}>
                  <th scope="row">
                    {d.event_name}
                    <span className="mg__sub">{d.url ?? 'endpoint removed'}</span>
                  </th>
                  <td>
                    {d.status}
                    {d.last_error && <span className="mg__sub">{d.last_error}</span>}
                  </td>
                  <td>{d.attempts}</td>
                  <td>
                    {d.status !== 'delivered' && (
                      <button
                        type="button"
                        className="cs__btn"
                        disabled={busy === `d${d.id}`}
                        onClick={() =>
                          void act(`d${d.id}`, async () => {
                            await post(`/api/webhooks/deliveries/${d.id}/replay`);
                            await deliveries.reload();
                            return 'Queued. The receiver sees the same event id, so a consumer that already handled it should ignore it.';
                          })
                        }
                      >
                        Replay
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty what="Nothing sent yet." why="Deliveries appear here once a record moves." />
        )}
      </Panel>

      <Panel title="Register an application">
        <p className="vw__note" style={{ marginTop: 14 }}>
          For an application that acts <em>as a person</em> rather than as the workspace — it sends
          somebody here to approve it, and gets a token carrying their permissions, not more.
          Redirect URIs are matched exactly, because a prefix match is how an open redirect becomes
          a stolen authorization code.
        </p>
        <form
          className="mg__invite"
          onSubmit={(e) => {
            e.preventDefault();
            void act('new-client', async () => {
              const made = await post<{ clientId: string; clientSecret?: string }>(
                '/api/oauth/clients',
                {
                  name: clientName,
                  redirectUris: clientRedirects.split(/\s+/).filter(Boolean),
                  confidential,
                },
              );
              setClientName('');
              setClientRedirects('');
              if (made.clientSecret) {
                setMinted({ what: 'client secret', value: made.clientSecret });
              }
              return `Client id ${made.clientId}`;
            });
          }}
        >
          <div className="mg__field">
            <label className="cs__label" htmlFor="client-name">
              Application name
            </label>
            <input
              id="client-name"
              className="cs__input"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              required
            />
          </div>
          <div className="mg__field">
            <label className="cs__label" htmlFor="client-kind">
              Can it keep a secret?
            </label>
            <select
              id="client-kind"
              className="cs__input"
              value={confidential ? 'yes' : 'no'}
              onChange={(e) => setConfidential(e.target.value === 'yes')}
              aria-describedby="client-kind-hint"
            >
              <option value="yes">Yes — it runs on a server</option>
              <option value="no">No — it runs in a browser or on a phone</option>
            </select>
            <p id="client-kind-hint" className="mg__hint">
              {confidential
                ? 'It gets a secret, shown once.'
                : 'No secret is issued. Anything shipped to a device cannot hold one, and pretending otherwise is the most common way they leak.'}
            </p>
          </div>
          <div className="mg__field mg__field--wide">
            <label className="cs__label" htmlFor="client-redirects">
              Redirect URIs, one per line
            </label>
            <textarea
              id="client-redirects"
              className="cs__input st__textarea"
              rows={3}
              value={clientRedirects}
              onChange={(e) => setClientRedirects(e.target.value)}
              required
            />
          </div>
          <div className="mg__actions">
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'new-client'}>
              Register
            </button>
          </div>
        </form>
      </Panel>

      <Panel title="Connected applications" aside={`${grants.data?.filter((g) => !g.revoked_at).length ?? 0}`}>
        <p className="vw__note" style={{ marginTop: 14 }}>
          Applications somebody here authorised to act on their behalf. Revoking one stops its
          access immediately — its refresh token cannot mint another.
        </p>
        {grants.data?.filter((g) => !g.revoked_at).length ? (
          <table className="vw__table">
            <thead>
              <tr>
                <th scope="col">Application</th>
                <th scope="col">May do</th>
                <th scope="col">Authorised by</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {grants.data
                .filter((g) => !g.revoked_at)
                .map((g) => (
                  <tr key={g.id}>
                    <th scope="row">{g.client_name}</th>
                    <td>{g.scopes.join(', ')}</td>
                    <td>{g.granted_by}</td>
                    <td>
                      <button
                        type="button"
                        className="cs__btn"
                        disabled={busy === g.id}
                        onClick={() =>
                          void act(g.id, async () => {
                            await post(`/api/oauth/grants/${g.id}/revoke`);
                            await grants.reload();
                            return `${g.client_name} can no longer act for anybody here.`;
                          })
                        }
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <Empty
            what="No applications connected."
            why="Nobody has authorised an outside application to act on their behalf."
          />
        )}
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- the data

interface MapField {
  key: string;
  label: string;
  classification: string;
  collectionReason: string | null;
  hiddenFrom: string[];
  /** Where the value travels, including anywhere it leaves the platform. */
  leaves: string[];
}

interface ProcessMap {
  processKey: string;
  processName: string;
  version: number;
  sensitivityCeiling: string;
  retention: { days: number | null; action: string };
  liveRecords: number;
  fields: MapField[];
  /** What the map itself thinks is wrong — over-collection, missing reasons. */
  notes: string[];
}

export function DataView({ processes }: { processes: { process_key: string; name: string }[] }) {
  const map = useFeed<ProcessMap[]>('/api/data-map');
  const [processKey, setProcessKey] = useState(processes[0]?.process_key ?? '');
  const [csv, setCsv] = useState('');
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: string, work: () => Promise<string>) => {
    setBusy(id);
    setNote(null);
    try {
      setNote(await work());
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {note && (
        <p className="st__note" role="status">
          {note}
        </p>
      )}

      <Panel title="Bring records in from a spreadsheet">
        <p className="vw__note" style={{ marginTop: 14 }}>
          Paste a CSV with a header row. Nothing is created until you have seen what would be —
          the check below runs the whole import and reports it without writing anything.
        </p>
        <div className="st__form">
          <label className="cs__label" htmlFor="import-process">
            Into which process
          </label>
          <select
            id="import-process"
            className="cs__input"
            value={processKey}
            onChange={(e) => setProcessKey(e.target.value)}
          >
            {processes.map((p) => (
              <option key={p.process_key} value={p.process_key}>
                {p.name}
              </option>
            ))}
          </select>

          <label className="cs__label" htmlFor="import-csv" style={{ marginTop: 14 }}>
            The rows
          </label>
          <textarea
            id="import-csv"
            className="cs__input st__textarea"
            rows={7}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder="full_name,personal_email,start_date"
          />

          <div className="mg__rowActions" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="cs__btn"
              disabled={busy === 'plan' || !csv.trim()}
              onClick={() =>
                void run('plan', async () => {
                  const result = await post<Record<string, unknown>>(
                    `/api/import/${processKey}/plan`,
                    { csv },
                  );
                  setPlan(result);
                  return 'Checked. Nothing was written.';
                })
              }
            >
              Check it first
            </button>
            <button
              type="button"
              className="cs__btn cs__btn--primary"
              disabled={busy === 'apply' || !plan}
              onClick={() =>
                void run('apply', async () => {
                  const result = await post<{ created: unknown[] }>(
                    `/api/import/${processKey}/apply`,
                    { csv },
                  );
                  setPlan(null);
                  setCsv('');
                  return `Created ${result.created.length} record(s). They are on My work now.`;
                })
              }
            >
              Import
            </button>
          </div>

          {/* The plan is shown as it came back rather than summarised: the
              point of a dry run is seeing what it actually decided. */}
          {plan && <pre className="st__pre">{JSON.stringify(plan, null, 2)}</pre>}
        </div>
      </Panel>

      <Panel title="What this workspace holds">
        <p className="vw__note" style={{ marginTop: 14 }}>
          Derived from each published process rather than maintained by hand, so it cannot drift
          from what the system actually does. &ldquo;Goes to&rdquo; traces where a value travels —
          including anywhere it leaves the platform.
        </p>
        {map.error && (
          <div className="cs__empty" role="alert">
            {map.error}
          </div>
        )}
        {map.data?.map((p) => (
          <div key={p.processKey} className="st__mapBlock">
            <h3 className="st__mapTitle">
              {p.processName}
              <span className="mg__sub">
                v{p.version} · {p.liveRecords} records · highest class {p.sensitivityCeiling} ·{' '}
                {p.retention.action}
              </span>
            </h3>
            <table className="vw__table">
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Class</th>
                  <th scope="col">Goes to</th>
                </tr>
              </thead>
              <tbody>
                {p.fields.map((f) => (
                  <tr key={f.key}>
                    <th scope="row">
                      {f.label}
                      {f.collectionReason && <span className="mg__sub">{f.collectionReason}</span>}
                    </th>
                    <td>
                      {f.classification}
                      {f.hiddenFrom.length > 0 && (
                        <span className="mg__sub">hidden from {f.hiddenFrom.join(', ')}</span>
                      )}
                    </td>
                    <td>{f.leaves.length ? f.leaves.join(', ') : 'stays here'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* What the map itself flags. Shown rather than left for somebody
                to notice: a restricted field hidden from nobody is the kind of
                thing that only looks wrong when it is written down. */}
            {p.notes.length > 0 && (
              <ul className="st__notes">
                {p.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </Panel>

      <Panel title="Delete what is past its retention">
        <p className="vw__note" style={{ marginTop: 14 }}>
          The period comes from the published process, not from this screen, so nobody deletes
          faster than the process promised. A record still running is never touched, and the
          account of what was removed is written before the deletion.
        </p>
        <div className="mg__rowActions" style={{ padding: '0 18px 18px' }}>
          <button
            type="button"
            className="cs__btn"
            disabled={busy === 'retention-preview'}
            onClick={() =>
              void run('retention-preview', async () => {
                const done = await post<{ deleted: number }>('/api/retention', {
                  processKey,
                  preview: true,
                });
                return `${done.deleted} record(s) would be deleted. Nothing was.`;
              })
            }
          >
            What would this delete?
          </button>
          <button
            type="button"
            className="cs__btn"
            disabled={busy === 'retention-run'}
            onClick={() =>
              void run('retention-run', async () => {
                const done = await post<{ deleted: number }>('/api/retention', { processKey });
                return `${done.deleted} record(s) deleted. The account of it is kept.`;
              })
            }
          >
            Run it
          </button>
        </div>
      </Panel>
    </>
  );
}
