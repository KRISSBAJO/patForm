'use client';

/**
 * The two questions the console could not answer.
 *
 * *"How do records get created?"* and *"how does an organization bring people
 * in?"* Both were fully built and neither was reachable: thirty of the
 * seventy-two console endpoints had nothing in the interface calling them,
 * including every one of `members`, `invitations` and `forms`. An operator
 * could approve a record that arrived and had no way to find out how it
 * arrived, or to let anybody else in.
 *
 * That is the ninth instance in this project of a control present in review
 * and absent at runtime, and the largest — it is most of the product.
 */

import { useCallback, useEffect, useState } from 'react';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
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
 * Icons for the actions.
 *
 * A row of five text buttons reads as a wall; an icon gives each one a shape
 * to recognise before the label is read. They sit *beside* the labels rather
 * than replacing them — an icon-only button is a guessing game, and `aria-
 * hidden` keeps the icon out of the accessible name so nothing is announced
 * twice.
 */
function Icon({ name }: { name: 'copy' | 'form' | 'list' | 'edit' | 'check' | 'link' | 'people' }) {
  const p = {
    width: 15,
    height: 15,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'mg__icon',
  };
  switch (name) {
    case 'copy':
      return (
        <svg {...p}>
          <rect x="7" y="7" width="10" height="10" rx="1.8" />
          <path d="M13 7V4.8A1.8 1.8 0 0 0 11.2 3H4.8A1.8 1.8 0 0 0 3 4.8v6.4A1.8 1.8 0 0 0 4.8 13H7" />
        </svg>
      );
    case 'check':
      return (
        <svg {...p}>
          <path d="M4 10.6 8.2 15 16 5.6" />
        </svg>
      );
    case 'form':
      return (
        <svg {...p}>
          <rect x="3.6" y="2.6" width="12.8" height="14.8" rx="1.8" />
          <path d="M6.8 7h6.4M6.8 10.2h6.4M6.8 13.4h3.6" />
        </svg>
      );
    case 'list':
      return (
        <svg {...p}>
          <path d="M6.6 5.4h10M6.6 10h10M6.6 14.6h10" />
          <path d="M3.4 5.4h.01M3.4 10h.01M3.4 14.6h.01" />
        </svg>
      );
    case 'edit':
      return (
        <svg {...p}>
          <path d="M12.6 3.4a2.4 2.4 0 0 1 3.4 3.4l-8.2 8.2-4.2 1 1-4.2 8-8.4Z" />
        </svg>
      );
    case 'link':
      return (
        <svg {...p}>
          <path d="M8.6 11.4 6.4 13.6a2.8 2.8 0 0 0 4 4l2.2-2.2" />
          <path d="M11.4 8.6l2.2-2.2a2.8 2.8 0 0 0-4-4L7.4 4.6" />
          <path d="M7.8 12.2l4.4-4.4" />
        </svg>
      );
    case 'people':
      return (
        <svg {...p}>
          <circle cx="7.6" cy="7" r="2.7" />
          <path d="M2.8 16.2c0-2.5 2.1-4.2 4.8-4.2s4.8 1.7 4.8 4.2" />
          <path d="M13.2 5.1a2.7 2.7 0 0 1 0 5.2" />
        </svg>
      );
  }
}

function Refused({ error }: { error: string }) {
  return (
    <div className="cs__panel">
      <div className="cs__empty" role="alert">
        <strong>Refused.</strong>
        <div style={{ marginTop: 6, fontSize: 13 }}>{error}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ people

interface Member {
  id: string;
  email: string;
  display_name: string;
  workspace_role: string;
  active: boolean;
  provisioned_by: string;
  sessions: number;
  process_roles: number;
}

interface Invitation {
  id: string;
  email: string;
  workspace_role: string;
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

/** What each workspace role actually lets somebody do, in a sentence. */
const ROLE_MEANS: Record<string, string> = {
  owner: 'Everything, including billing and removing other owners.',
  admin: 'Everything except being the last owner.',
  builder: 'Designs and publishes processes. Cannot approve or operate.',
  operator: 'Runs the work: tasks, records, reports.',
  approver: 'Sees records. Approving is granted per process, not here.',
  analyst: 'Reads records and reports. Changes nothing.',
  read_only: 'Reads records. Nothing else.',
};

export function PeopleView({ canAdminister }: { canAdminister: boolean }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [grantable, setGrantable] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState('read_only');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      setMembers(await get<Member[]>('/api/members'));
      if (canAdminister) {
        const [inv, gr] = await Promise.all([
          get<Invitation[]>('/api/invitations'),
          get<{ roles: string[] }>('/api/members/grantable'),
        ]);
        setInvitations(inv);
        setGrantable(gr.roles);
        setRole((current) => (gr.roles.includes(current) ? current : (gr.roles[0] ?? 'read_only')));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [canAdminister]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, work: () => Promise<string>) => {
    setBusy(key);
    setNote(null);
    try {
      setNote(await work());
      await load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (error) return <Refused error={error} />;
  if (!members) {
    return (
      <div className="cs__panel">
        <div className="cs__empty">Loading…</div>
      </div>
    );
  }

  const open = invitations.filter((i) => !i.accepted_at && !i.revoked_at && new Date(i.expires_at) > new Date());

  return (
    <>
      {canAdminister && (
        <div className="cs__panel" style={{ marginBottom: 18 }}>
          <div className="cs__panelHead">
            <h2 className="cs__tab">Invite somebody</h2>
          </div>
          <form
            className="mg__invite"
            onSubmit={(e) => {
              e.preventDefault();
              void act('invite', async () => {
                const sent = await post<{ delivered: string }>('/api/invitations', {
                  email,
                  workspaceRole: role,
                  message,
                });
                setEmail('');
                setMessage('');
                // `delivered` is what the endpoint returns instead of the
                // token: the link is emailed, and showing it here would let
                // anybody who can invite mint one for an address whose owner
                // never sees it.
                return sent.delivered === 'failed'
                  ? 'The invitation was created but the email did not send. Check deliverability.'
                  : 'Invitation sent. The link works once and expires in seven days.';
              });
            }}
          >
            <div className="mg__field">
              <label className="cs__label" htmlFor="invite-email">
                Their email
              </label>
              <input
                id="invite-email"
                className="cs__input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="mg__field">
              <label className="cs__label" htmlFor="invite-role">
                Role
              </label>
              <select
                id="invite-role"
                className="cs__input"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                aria-describedby="invite-role-hint"
              >
                {grantable.map((r) => (
                  <option key={r} value={r}>
                    {r.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              {/* The list is what the server will accept from THIS person, so
                  the interface cannot offer a role it would refuse. */}
              <p id="invite-role-hint" className="mg__hint">
                {ROLE_MEANS[role] ?? ''}
              </p>
            </div>
            <div className="mg__field mg__field--wide">
              <label className="cs__label" htmlFor="invite-message">
                A note, if you want one (optional)
              </label>
              <input
                id="invite-message"
                className="cs__input"
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
            <div className="mg__actions">
              <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'invite'}>
                {busy === 'invite' ? 'Sending…' : 'Send invitation'}
              </button>
            </div>
          </form>
          {note && (
            <p className="vw__note" role="status">
              {note}
            </p>
          )}
        </div>
      )}

      {open.length > 0 && (
        <div className="cs__panel" style={{ marginBottom: 18 }}>
          <div className="cs__panelHead">
            <h2 className="cs__tab">Waiting to be accepted</h2>
            <span className="cs__sort">{open.length}</span>
          </div>
          <table className="vw__table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Invited by</th>
                <th scope="col">Expires</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {open.map((i) => (
                <tr key={i.id}>
                  <td style={{ overflowWrap: 'anywhere' }}>{i.email}</td>
                  <td>{i.workspace_role.replace(/_/g, ' ')}</td>
                  <td>{i.invited_by}</td>
                  <td>{new Date(i.expires_at).toLocaleDateString()}</td>
                  <td>
                    <button
                      type="button"
                      className="cs__btn"
                      disabled={busy === i.id}
                      onClick={() =>
                        void act(i.id, async () => {
                          await post(`/api/invitations/${i.id}/revoke`);
                          return 'Invitation revoked. That link no longer works.';
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
        </div>
      )}

      <div className="cs__panel">
        <div className="cs__panelHead">
          <h2 className="cs__tab">People</h2>
          <span className="cs__sort">{members.filter((m) => m.active).length} active</span>
        </div>
        <table className="vw__table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Sessions</th>
              {canAdminister && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} style={m.active ? undefined : { opacity: 0.6 }}>
                <th scope="row" style={{ fontWeight: 600 }}>
                  {m.display_name}
                  <span className="mg__sub">{m.email}</span>
                  {/* Said as words, not only as a dimmed row: state carried by
                      opacity alone is state nobody is told about. */}
                  {!m.active && <span className="mg__tag">deactivated</span>}
                  {m.provisioned_by === 'scim' && <span className="mg__tag">managed by your directory</span>}
                </th>
                <td>
                  {canAdminister && m.provisioned_by !== 'scim' ? (
                    <>
                      <label className="vw__srOnly" htmlFor={`role-${m.id}`}>
                        Role for {m.display_name}
                      </label>
                      <select
                        id={`role-${m.id}`}
                        className="cs__input mg__inlineSelect"
                        value={m.workspace_role}
                        disabled={busy === m.id}
                        onChange={(e) =>
                          void act(m.id, async () => {
                            await post(`/api/members/${m.id}/role`, { workspaceRole: e.target.value });
                            return `${m.display_name} is now ${e.target.value.replace(/_/g, ' ')}.`;
                          })
                        }
                      >
                        {[...new Set([...grantable, m.workspace_role])].map((r) => (
                          <option key={r} value={r}>
                            {r.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                    m.workspace_role.replace(/_/g, ' ')
                  )}
                </td>
                <td>{m.sessions}</td>
                {canAdminister && (
                  <td>
                    <div className="mg__rowActions">
                      {m.sessions > 0 && (
                        <button
                          type="button"
                          className="cs__btn"
                          disabled={busy === m.id}
                          onClick={() =>
                            void act(m.id, async () => {
                              const done = await post<{ revoked: number }>(`/api/members/${m.id}/revoke-sessions`);
                              return `Signed ${m.display_name} out of ${done.revoked} session(s).`;
                            })
                          }
                        >
                          Sign out
                        </button>
                      )}
                      <button
                        type="button"
                        className="cs__btn"
                        disabled={busy === m.id || m.provisioned_by === 'scim'}
                        onClick={() =>
                          void act(m.id, async () => {
                            await post(`/api/members/${m.id}/${m.active ? 'deactivate' : 'reactivate'}`);
                            return m.active
                              ? `${m.display_name} is deactivated, and their sessions are revoked.`
                              : `${m.display_name} can sign in again.`;
                          })
                        }
                      >
                        {m.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// --------------------------------------------------------------- processes

interface ProcessRow {
  process_key: string;
  name: string;
  version: number;
  open_records: number;
  roles: string[];
}

/**
 * Where records come from.
 *
 * The answer was in the product the whole time — a published process serves a
 * public form at `/f/<key>`, and a submission to it creates the record — and
 * the console never said so or linked to it. Somebody could approve records
 * all day without ever seeing where they arrive from.
 */
interface Install {
  process_key: string;
  pack_name: string;
  pack_key: string;
  version: number;
  latest_version: number | null;
  installed_at: string;
}

interface RecordRow {
  id: string;
  state: string;
  outcome: string | null;
  created_at: string;
  state_entered_at: string;
}

export function ProcessesView({
  processes,
  onOpenRecord,
}: {
  processes: ProcessRow[];
  onOpenRecord: (id: string) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [installs, setInstalls] = useState<Install[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  useEffect(() => {
    // Which processes came from a pack, and whether the pack has moved on
    // since. An install that is three versions behind is invisible otherwise.
    get<Install[]>('/api/packs/installed')
      .then(setInstalls)
      .catch(() => setInstalls([]));
  }, []);

  const showRecords = async (processKey: string) => {
    if (open === processKey) {
      setOpen(null);
      return;
    }
    setOpen(processKey);
    setRecords([]);
    try {
      setRecords(await get<RecordRow[]>(`/api/records?process=${encodeURIComponent(processKey)}&limit=15`));
    } catch {
      setRecords([]);
    }
  };

  if (!processes.length) {
    return (
      <div className="cs__panel">
        <div className="cs__empty">
          <strong>Nothing published yet.</strong>
          <div style={{ marginTop: 6, fontSize: 13 }}>
            A process is designed in the builder and published from there. Publishing gives it a
            form people can fill in, and every submission becomes a record here.
          </div>
          <p style={{ marginTop: 14 }}>
            <a className="cs__btn cs__btn--primary" href="/builder">
              Open the builder
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="cs__panel" style={{ marginBottom: 18 }}>
        <div className="cs__panelHead">
          <h2 className="cs__tab">How a record starts</h2>
        </div>
        <p className="vw__note" style={{ marginTop: 14 }}>
          Each published process serves a form at its own link. Send that link to whoever fills it
          in — a new starter, a claimant, a supplier — and every submission becomes a record on{' '}
          <strong>My work</strong>, routed by the process&rsquo;s own rules. Nobody needs an account
          to submit one.
        </p>
      </div>

      {processes.map((p) => {
        const url = `${origin}/f/${p.process_key}`;
        const from = installs.find((i) => i.process_key === p.process_key);
        return (
          <div className="cs__panel mg__process" key={p.process_key}>
            <div className="cs__panelHead">
              <h2 className="cs__tab">{p.name}</h2>
              <span className="cs__sort">
                v{p.version} · {p.open_records} open
              </span>
            </div>

            <div className="mg__processBody">
              {/* Facts as chips rather than a sentence: they are scanned, not
                  read, and a sentence makes somebody parse to find one. */}
              <div className="mg__chips">
                <span className="mg__chip">
                  <Icon name="people" />
                  {p.roles.length ? p.roles.join(', ') : 'no role here'}
                </span>
                <span className="mg__chip">
                  <Icon name="list" />
                  {p.open_records} open
                </span>
                <span className="mg__chip">
                  <Icon name="check" />
                  published v{p.version}
                </span>
              </div>

              <label className="cs__label mg__linkLabel" htmlFor={`link-${p.process_key}`}>
                <Icon name="link" />
                Send this link to whoever fills the form in
              </label>
              <div className="mg__linkRow">
                <input
                  id={`link-${p.process_key}`}
                  className="cs__input"
                  readOnly
                  value={url}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  className={`cs__btn${copied === p.process_key ? ' cs__btn--done' : ''}`}
                  onClick={() => {
                    void navigator.clipboard?.writeText(url);
                    setCopied(p.process_key);
                  }}
                >
                  <Icon name={copied === p.process_key ? 'check' : 'copy'} />
                  {copied === p.process_key ? 'Copied' : 'Copy'}
                </button>
              </div>
              {/* A live region, so the copy is announced rather than only
                  appearing next to a button somebody cannot see. */}
              <p className="mg__hint" role="status">
                {copied === p.process_key ? 'Anyone with this link can submit. No account needed.' : ' '}
              </p>

              {from && (
                <p className="mg__hint">
                  Started from the <strong>{from.pack_name}</strong> pack, version {from.version}.
                  {from.latest_version && from.latest_version > from.version
                    ? ` Version ${from.latest_version} is available — installing it opens a draft rather than changing anything live.`
                    : ' That is the current version.'}
                </p>
              )}

              <div className="mg__rowActions">
                <a className="cs__btn cs__btn--primary" href={url} target="_blank" rel="noreferrer">
                  <Icon name="form" />
                  Open the form
                </a>
                <button
                  type="button"
                  className="cs__btn"
                  aria-expanded={open === p.process_key}
                  onClick={() => void showRecords(p.process_key)}
                >
                  <Icon name="list" />
                  {open === p.process_key ? 'Hide records' : 'Show the records'}
                </button>
                <a className="cs__btn" href="/builder">
                  <Icon name="edit" />
                  Edit in the builder
                </a>
              </div>

              {open === p.process_key && (
                <table className="vw__table" style={{ marginTop: 14 }}>
                  <thead>
                    <tr>
                      <th scope="col">Reference</th>
                      <th scope="col">Where it is</th>
                      <th scope="col">Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.length ? (
                      records.map((r) => (
                        <tr key={r.id}>
                          <th scope="row">
                            <button
                              type="button"
                              className="cs__linkBtn cs__linkBtn--onLight"
                              onClick={() => onOpenRecord(r.id)}
                            >
                              {r.id.slice(0, 8).toUpperCase()}
                            </button>
                          </th>
                          <td>{r.outcome ?? r.state}</td>
                          <td>{new Date(r.state_entered_at).toLocaleDateString()}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={3}>Nothing open.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
