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
import { postJson } from './stepup';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

/** Asks the person to confirm it is them when an action needs a recent sign-in; see stepup.tsx. */
const post = postJson;

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
  /** When any of their sessions was last used; null if they have never signed in. */
  last_seen_at: string | null;
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

export function PeopleView({ canAdminister, onInvite }: { canAdminister: boolean; onInvite: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [grantable, setGrantable] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [showInactive, setShowInactive] = useState(false);
  const [tab, setTab] = useState<'members' | 'waiting'>('members');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState('');
  const [page, setPage] = useState(1);

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
  if (!members) return <PanelSkeleton rows={5} />;

  const open = invitations.filter((i) => !i.accepted_at && !i.revoked_at && new Date(i.expires_at) > new Date());
  const active = members.filter((m) => m.active);
  const inactive = members.length - active.length;
  const roles = [...new Set(members.map((m) => m.workspace_role))];
  const q = query.trim().toLowerCase();
  const shown = members.filter(
    (m) =>
      (showInactive || m.active) &&
      (roleFilter === 'all' || m.workspace_role === roleFilter) &&
      (!q || m.display_name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)),
  );
  const selected = members.find((m) => m.id === selectedId);
  const pageSize = 12;
  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = shown.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const waiting = open;

  return (
    <div className="pp2">
      <section className="pp__head">
        <div>
          <span className="pp2__eyebrow">WORKSPACE DIRECTORY</span>
          <h2 className="pp__title">People & access</h2>
          <p>Find teammates, review access, and manage invitations in one place.</p>
        </div>
        {canAdminister && (
          <button type="button" className="cs__btn cs__btn--primary pp__invite" onClick={onInvite}>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <circle cx="8" cy="7" r="3" />
              <path d="M2.5 16.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5M15.5 6v5M13 8.5h5" />
            </svg>
            Invite people
          </button>
        )}
      </section>

      <section className="pp2__overview" aria-label="People overview">
        <div><span>Active members</span><strong>{active.length}</strong><small>Can sign in to this workspace</small></div>
        {canAdminister && <button type="button" onClick={() => { setSelectedId(null); setTab('waiting'); }}><span>Pending invitations</span><strong>{open.length}</strong><small>Waiting to join <span aria-hidden="true">→</span></small></button>}
        <div><span>Deactivated</span><strong>{inactive}</strong><small>Access is turned off</small></div>
      </section>

      {note && (
        <p className="pp__note" role="status">
          {note}
        </p>
      )}

      {selected ? (
        <section className="pp2__detail" aria-label={`Profile for ${selected.display_name}`}>
          <button type="button" className="pp2__back" onClick={() => setSelectedId(null)}>← All people</button>
          <div className="pp2__profile">
            <span className="pp__avatar" aria-hidden="true">{initials(selected.display_name)}</span>
            <div><span className="pp2__eyebrow">MEMBER PROFILE</span><h3>{selected.display_name}</h3><p>{selected.email}</p></div>
            <span className={`pp2__status${selected.active ? '' : ' pp2__status--off'}`}>{selected.active ? 'Active' : 'Deactivated'}</span>
          </div>
          <div className="pp2__detailGrid">
            <div className="pp2__detailSection">
              <h4>Workspace access</h4>
              <p>The workspace role controls what this person can see and manage.</p>
              {canAdminister && selected.provisioned_by !== 'scim' ? <>
                <label htmlFor="pp2-role">Role</label>
                <div className="pp2__roleEdit"><select id="pp2-role" value={selectedRole} disabled={busy === selected.id} onChange={(e) => setSelectedRole(e.target.value)}>
                  {[...new Set([...grantable, selected.workspace_role])].map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
                </select><button type="button" className="cs__btn cs__btn--primary" disabled={busy === selected.id || selectedRole === selected.workspace_role} onClick={() => void act(selected.id, async () => { await post(`/api/members/${selected.id}/role`, { workspaceRole: selectedRole }); return `${selected.display_name} is now ${roleName(selectedRole)}.`; })}>Save role</button></div>
              </> : <div className="pp2__value">{roleName(selected.workspace_role)}{selected.provisioned_by === 'scim' && <small>Managed by your directory</small>}</div>}
            </div>
            <div className="pp2__detailSection">
              <h4>Sign-in activity</h4>
              <p>Last active {lastSeen(selected.last_seen_at).toLowerCase()}.</p>
              <div className="pp2__value">{selected.sessions} signed-in {selected.sessions === 1 ? 'device' : 'devices'}</div>
              {canAdminister && selected.sessions > 0 && <button type="button" className="cs__btn" disabled={busy === selected.id} onClick={() => void act(selected.id, async () => { const done = await post<{ revoked: number }>(`/api/members/${selected.id}/revoke-sessions`); return `Signed ${selected.display_name} out of ${done.revoked} session(s).`; })}>Sign out devices</button>}
            </div>
          </div>
          {canAdminister && selected.provisioned_by !== 'scim' && <div className="pp2__accessAction"><div><strong>{selected.active ? 'Deactivate access' : 'Restore access'}</strong><p>{selected.active ? 'They will be signed out and unable to use this workspace.' : 'They will be able to sign in again.'}</p></div><button type="button" className="cs__btn" disabled={busy === selected.id} onClick={() => void act(selected.id, async () => { await post(`/api/members/${selected.id}/${selected.active ? 'deactivate' : 'reactivate'}`); return selected.active ? `${selected.display_name} is deactivated, and their sessions are revoked.` : `${selected.display_name} can sign in again.`; })}>{selected.active ? 'Deactivate' : 'Reactivate'}</button></div>}
        </section>
      ) : <div className="cs__panel pp2__directory">
        <div className="pp__tabs" role="tablist" aria-label="People in this workspace">
          <button
            type="button"
            role="tab"
            id="pp-tab-members"
            aria-selected={tab === 'members'}
            aria-controls="pp-panel"
            className="pp__tab"
            onClick={() => setTab('members')}
          >
            Members <span className="pp__count">{active.length}</span>
          </button>
          {canAdminister && (
            <button
              type="button"
              role="tab"
              id="pp-tab-waiting"
              aria-selected={tab === 'waiting'}
              aria-controls="pp-panel"
              className="pp__tab"
              onClick={() => setTab('waiting')}
            >
              Waiting to accept <span className="pp__count">{open.length}</span>
            </button>
          )}
          <span className="cs__sort pp__shown">{tab === 'members' ? `${shown.length} ${shown.length === 1 ? 'person' : 'people'}` : `${waiting.length} ${waiting.length === 1 ? 'invitation' : 'invitations'}`}</span>
        </div>

        <div id="pp-panel" role="tabpanel" aria-labelledby={tab === 'waiting' ? 'pp-tab-waiting' : 'pp-tab-members'}>
        {tab === 'waiting' ? (
          waiting.length ? (
          <ul className="pp__invites">
            {waiting.map((i) => {
              const days = Math.max(0, Math.ceil((new Date(i.expires_at).getTime() - Date.now()) / 86_400_000));
              return (
                <li key={i.id} className="pp__invitation">
                  <span className="pp__avatar pp__avatar--pending" aria-hidden="true">
                    {initials(i.email)}
                  </span>
                  <span className="pp__who">
                    <span className="pp__name">{i.email}</span>
                    <span className="pp__meta">
                      {roleName(i.workspace_role)} · invited by {i.invited_by} · expires {days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="cs__btn"
                    disabled={busy === i.id}
                    onClick={() =>
                      void act(i.id, async () => {
                        await post(`/api/invitations/${i.id}/revoke`);
                        return `The invitation to ${i.email} is revoked. That link no longer works.`;
                      })
                    }
                  >
                    Revoke
                  </button>
                </li>
              );
            })}
          </ul>
          ) : (
            <div className="cs__empty pp__empty">
              <strong>Nobody is waiting.</strong>
              <div style={{ marginTop: 6, fontSize: 13 }}>Invitations that have not been accepted yet show here until they are used, revoked, or expire.</div>
              <button type="button" className="cs__btn cs__btn--primary" style={{ marginTop: 14 }} onClick={onInvite}>
                Invite people
              </button>
            </div>
          )
        ) : (
        <>
        <div className="wk__controls pp2__controls">
          <div className="wk__search">
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" className="mg__icon">
              <circle cx="9" cy="9" r="5.5" />
              <path d="m13.2 13.2 3.6 3.6" />
            </svg>
            <input
              className="wk__searchInput"
              type="search"
              value={query}
              placeholder="Search by name or email"
              aria-label="Search people"
              onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            />
          </div>
          <label className="wk__pick">
            <span className="cs__srOnly">Role</span>
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" className="mg__icon">
              <path d="M3.5 5h13M6 10h8M8.5 15h3" />
            </svg>
            <select className="wk__select" value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}>
              <option value="all">Every role</option>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {roleName(r)}
                </option>
              ))}
            </select>
          </label>
          {inactive > 0 && (
            <label className="pp__toggle">
              <input type="checkbox" checked={showInactive} onChange={(e) => { setShowInactive(e.target.checked); setPage(1); }} />
              Show deactivated
            </label>
          )}
        </div>

        <div className="pp2__list" role="list" aria-label="Workspace members">
          {pageRows.map((m) => (
            <div role="listitem" key={m.id}><button type="button" className={`pp2__personRow${m.active ? '' : ' pp2__personRow--off'}`} onClick={() => { setSelectedId(m.id); setSelectedRole(m.workspace_role); }}>
              <span className="pp__avatar" aria-hidden="true">{initials(m.display_name)}</span>
              <span className="pp2__identity"><strong>{m.display_name}</strong><small>{m.email}</small></span>
              <span className="pp2__roleBadge">{roleName(m.workspace_role)}</span>
              <span className="pp2__lastSeen">{m.active ? lastSeen(m.last_seen_at) : 'Deactivated'}</span>
              <span className="pp2__rowArrow" aria-hidden="true">→</span>
            </button></div>
          ))}
          {!shown.length && <div className="pp2__noResults">No people match your search or filters.</div>}
        </div>
        {pageCount > 1 && <div className="pp2__pager"><span>Page {currentPage} of {pageCount}</span><button type="button" className="cs__btn" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button><button type="button" className="cs__btn" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>Next</button></div>}
        </>
        )}
        </div>
      </div>}
    </div>
  );
}

const roleName = (r: string) => r.replace(/_/g, ' ');

function initials(name: string): string {
  const base = name.includes('@') ? name.split('@')[0]!.replace(/[._-]+/g, ' ') : name;
  const parts = base.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : (parts[0]?.[1] ?? ''))).toUpperCase();
}

function lastSeen(at: string | null): string {
  if (!at) return 'Never signed in';
  const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  if (minutes < 2) return 'Just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleDateString();
}

/** A panel's shape while it loads, instead of the word "Loading". */
export function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="cs__panel sk" aria-busy="true" aria-label="Loading">
      <div className="sk__line sk__line--title" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk__row">
          <div className="sk__dot" />
          <div className="sk__line" style={{ width: `${55 - i * 6}%` }} />
        </div>
      ))}
    </div>
  );
}

// --------------------------------------------------------------- processes

interface ProcessRow {
  process_key: string;
  name: string;
  version: number;
  open_records: number;
  roles: string[];
  /** Made when the process is first published, so every row here has one. */
  public_id: string;
}

/**
 * Where records come from.
 *
 * The answer was in the product the whole time — a published process serves a
 * public form at its own link, `/f/<id>`, and a submission to it creates the record — and
 * the console never said so or linked to it. Somebody could approve records
 * all day without ever seeing where they arrive from.
 */
interface Install {
  process_key: string;
  draft_id: string;
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
  canAdminister,
}: {
  processes: ProcessRow[];
  onOpenRecord: (id: string) => void;
  canAdminister: boolean;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [installs, setInstalls] = useState<Install[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'name' | 'activity'>('name');
  const [page, setPage] = useState(1);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const pageSize = 15;
  const selectedProcess = processes.find((p) => p.process_key === selected);
  const filtered = processes
    .filter((p) => `${p.name} ${p.process_key} ${p.roles.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sort === 'activity'
      ? b.open_records - a.open_records || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);

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
      {!selectedProcess ? <section className="mg__directory" aria-label="Published processes">
        <div className="mg__directoryIntro">
          <div>
            <p className="mg__eyebrow">WORKSPACE LIBRARY</p>
            <h2>Published processes</h2>
            <p>Find a form, review its records, or change how it works.</p>
          </div>
          <span className="mg__directoryCount">{processes.length} processes</span>
        </div>
        <div className="mg__directoryTools">
          <label className="cs__srOnly" htmlFor="process-search">Search processes</label>
          <input id="process-search" className="cs__input" type="search" placeholder="Search name, key, or role" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
          <label className="cs__srOnly" htmlFor="process-sort">Sort processes</label>
          <select id="process-sort" className="cs__input" value={sort} onChange={(e) => { setSort(e.target.value as 'name' | 'activity'); setPage(1); }}>
            <option value="name">Name A–Z</option>
            <option value="activity">Most open records</option>
          </select>
        </div>
        <div className="mg__directoryResults" aria-live="polite">{filtered.length} {filtered.length === 1 ? 'result' : 'results'}</div>
        {filtered.length ? <div className="mg__directoryList">
          {filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((p) => (
            <button key={p.process_key} type="button" className="mg__directoryItem" onClick={() => { setSelected(p.process_key); setOpen(null); setRecords([]); }}>
              <span className="mg__directoryMark" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
              <span className="mg__directoryIdentity"><strong>{p.name}</strong><small>{p.process_key}</small></span>
              <span className="mg__directoryMeta">Published v{p.version}</span>
              <span className="mg__directoryOpen">{p.open_records} open</span>
              <span className="mg__directoryArrow" aria-hidden="true">→</span>
            </button>
          ))}
        </div> : <div className="mg__directoryEmpty">No processes match your search.</div>}
        {pageCount > 1 && <div className="mg__directoryPages">
          <span>Page {currentPage} of {pageCount}</span>
          <button type="button" className="cs__btn" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
          <button type="button" className="cs__btn" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>Next</button>
        </div>}
      </section> : (() => {
        const p = selectedProcess;
        // Each workspace's form has its own link; the key alone is shared by
        // every workspace that installed the same pack.
        const url = `${origin}/f/${p.public_id}`;
        const from = installs.find((i) => i.process_key === p.process_key);
        return (
          <div className="cs__panel mg__process" key={p.process_key}>
            <button type="button" className="mg__back cs__linkBtn cs__linkBtn--onLight" onClick={() => setSelected(null)}>← All processes</button>
            <div className="cs__panelHead">
              <h2 className="cs__tab">{p.name}</h2>
              <span className="cs__sort">
                v{p.version} · {p.open_records} open
              </span>
            </div>

            <div className="mg__processBody">
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
                {canAdminister && from && <a className="cs__btn" href={`/builder/launch?draft=${from.draft_id}&step=people`}>
                  <Icon name="people" />
                  Manage people
                </a>}
                {canAdminister && <a className="cs__btn" href={`/builder?process=${encodeURIComponent(p.process_key)}`}>
                  <Icon name="edit" />
                  Edit in the builder
                </a>}
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
      })()}
    </>
  );
}
