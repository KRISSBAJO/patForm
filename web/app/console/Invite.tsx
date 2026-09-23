'use client';

import { useEffect, useRef, useState } from 'react';
import { postJson } from './stepup';

/**
 * Inviting people: one, a pasted list, or a spreadsheet.
 *
 * Three ways in, one way out. However the addresses arrive they become rows,
 * every row is checked by the server before anything is sent — typos,
 * duplicates, people already here, roles this person cannot give — and only
 * then does Send go, with a result for each row. A list is exactly where
 * those mistakes turn up, and finding them after forty emails have gone is
 * finding them too late.
 */

interface Row {
  email: string;
  role: string;
}

interface Checked extends Row {
  status: 'ready' | 'sent' | 'skipped' | 'failed';
  note?: string;
}

type Mode = 'one' | 'list' | 'file';

const ROLE_WORDS: Record<string, string> = {
  owner: 'Everything, including billing and removing other owners.',
  admin: 'Everything except being the last owner.',
  builder: 'Designs and publishes processes. Cannot approve or operate.',
  operator: 'Runs the work: tasks, records, reports.',
  approver: 'Sees records. Approving is granted per process, not here.',
  analyst: 'Reads records and reports. Changes nothing.',
  read_only: 'Reads records. Nothing else.',
};

const EMAIL = /[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/g;
const roleName = (r: string) => r.replace(/_/g, ' ');

/**
 * Addresses out of whatever was pasted.
 *
 * One per line with an optional role after a comma or tab — or a line copied
 * out of an email client, "Ada <ada@x.com>; Ben <ben@y.com>", where the role
 * is the default. Anything that is not an address is left for the check to
 * report rather than silently dropped.
 */
export function parseList(text: string, fallbackRole: string): Row[] {
  const rows: Row[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\t|,/).map((p) => p.trim());
    const found = line.match(EMAIL) ?? [];
    if (found.length === 1 && parts.length >= 2 && !parts[1]!.includes('@') && parts[1]) {
      rows.push({ email: found[0]!, role: parts[1]! });
    } else if (found.length) {
      for (const email of found) rows.push({ email, role: fallbackRole });
    } else {
      rows.push({ email: line, role: fallbackRole });
    }
  }
  return rows;
}

/** A spreadsheet export: a header naming `email` (and `role`) if there is one, otherwise email then role. */
export function parseCsv(text: string, fallbackRole: string): Row[] {
  const table: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) table.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) table.push(row);
  if (!table.length) return [];

  const head = table[0]!.map((c) => c.trim().toLowerCase());
  const emailAt = head.findIndex((c) => c === 'email' || c === 'email address' || c === 'e-mail');
  const roleAt = head.findIndex((c) => c === 'role' || c === 'workspace role');
  const body = emailAt >= 0 ? table.slice(1) : table;
  const e = emailAt >= 0 ? emailAt : 0;
  const r = emailAt >= 0 ? roleAt : 1;
  return body.map((cells) => ({
    email: (cells[e] ?? '').trim(),
    role: (r >= 0 ? (cells[r] ?? '').trim() : '') || fallbackRole,
  }));
}

export function InviteView({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<Mode>('one');
  // What this person may hand out, from the server — the page never offers a role it would refuse.
  const [grantable, setGrantable] = useState<string[]>([]);
  const [role, setRole] = useState('read_only');
  useEffect(() => {
    fetch('/api/members/grantable', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((body: { roles?: string[] }) => {
        const roles = body.roles ?? [];
        setGrantable(roles);
        setRole((current) => (roles.includes(current) ? current : (roles[0] ?? 'read_only')));
      })
      .catch(() => setGrantable([]));
  }, []);
  const [one, setOne] = useState('');
  const [list, setList] = useState('');
  const [fileRows, setFileRows] = useState<Row[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [checked, setChecked] = useState<Checked[] | null>(null);
  const [results, setResults] = useState<Checked[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Anything changed after a check makes that check stale.
  useEffect(() => {
    setChecked(null);
  }, [mode, one, list, fileRows, role]);

  const rows: Row[] =
    mode === 'one' ? (one.trim() ? [{ email: one.trim(), role }] : []) : mode === 'list' ? parseList(list, role) : (fileRows ?? []);

  const readFile = async (file: File) => {
    setProblem(null);
    if (file.size > 512_000) return setProblem('That file is larger than a list of invitations should be — 500 KB at most.');
    const text = await file.text();
    const parsed = parseCsv(text, role);
    setFileName(file.name);
    setFileRows(parsed);
    if (!parsed.length) setProblem('No rows found in that file.');
  };

  const template = () => {
    const csv = 'email,role\nada@example.com,operator\nben@example.com,read_only\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'invitations.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const check = async () => {
    setBusy(true);
    setProblem(null);
    setResults(null);
    try {
      const out = await postJson<{ rows: Checked[] }>('/api/invitations/bulk', { rows, message, dryRun: true });
      setChecked(out.rows);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!checked) return;
    setBusy(true);
    setProblem(null);
    try {
      const ready = checked.filter((r) => r.status === 'ready').map(({ email, role: r }) => ({ email, role: r }));
      const out = await postJson<{ rows: Checked[] }>('/api/invitations/bulk', { rows: ready, message, dryRun: false });
      setResults([...out.rows, ...checked.filter((r) => r.status !== 'ready')]);
      setChecked(null);
      setOne('');
      setList('');
      setFileRows(null);
      setFileName(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const ready = checked?.filter((r) => r.status === 'ready') ?? [];
  const notGoing = checked?.filter((r) => r.status !== 'ready') ?? [];

  return (
    <div className="iv">
      <button type="button" className="iv__back" onClick={onBack}>
        ← People
      </button>

      <div className="cs__panel iv__panel">
        <div className="iv__intro">
          <h2 className="iv__title">Invite people</h2>
          <p className="iv__lede">
            Each person gets an email with a link that works once and expires in seven days. Nothing is sent until you
            have checked the list.
          </p>
        </div>

        <div className="iv__modes" role="tablist" aria-label="How to add people">
          {(
            [
              ['one', 'One person'],
              ['list', 'Paste a list'],
              ['file', 'Upload a spreadsheet'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={mode === key}
              className="iv__mode"
              onClick={() => setMode(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="iv__body">
          <div className="iv__grid">
            <label className="iv__field">
              <span className="cs__label">{mode === 'one' ? 'Role' : 'Role, where a row does not say'}</span>
              <select className="cs__input" value={role} onChange={(e) => setRole(e.target.value)}>
                {grantable.map((r) => (
                  <option key={r} value={r}>
                    {roleName(r)}
                  </option>
                ))}
              </select>
              <span className="mg__hint">{ROLE_WORDS[role] ?? ''}</span>
            </label>

            {mode === 'one' && (
              <label className="iv__field">
                <span className="cs__label">Their email</span>
                <input
                  className="cs__input"
                  type="email"
                  value={one}
                  onChange={(e) => setOne(e.target.value)}
                  placeholder="name@organisation.com"
                  autoComplete="off"
                />
              </label>
            )}
          </div>

          {mode === 'list' && (
            <label className="iv__field">
              <span className="cs__label">Addresses</span>
              <textarea
                className="cs__input iv__paste"
                rows={7}
                value={list}
                onChange={(e) => setList(e.target.value)}
                placeholder={'ada@organisation.com\nben@organisation.com, operator\nor paste straight from an email: Ada <ada@org.com>; Ben <ben@org.com>'}
              />
              <span className="mg__hint">
                One per line, with a role after a comma if it differs. {rows.length ? `${rows.length} found.` : ''}
              </span>
            </label>
          )}

          {mode === 'file' && (
            <div
              className={`iv__drop${dragging ? ' iv__drop--over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files[0];
                if (file) void readFile(file);
              }}
            >
              <p className="iv__dropTitle">{fileName ? fileName : 'Drop a CSV file here'}</p>
              <p className="mg__hint">
                {fileRows
                  ? `${fileRows.length} row${fileRows.length === 1 ? '' : 's'} read. Columns: email, and role if you want one.`
                  : 'Columns: email, and role if you want one. A header row is optional.'}
              </p>
              <div className="iv__dropActions">
                <button type="button" className="cs__btn" onClick={() => fileInput.current?.click()}>
                  Choose a file
                </button>
                <button type="button" className="iv__link" onClick={template}>
                  Download a template
                </button>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv,.txt"
                className="cs__srOnly"
                tabIndex={-1}
                aria-label="CSV file of people to invite"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void readFile(file);
                  e.target.value = '';
                }}
              />
            </div>
          )}

          <label className="iv__field">
            <span className="cs__label">A note in the email (optional)</span>
            <input
              className="cs__input"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="You will be handling the onboarding approvals."
            />
          </label>

          {problem && (
            <p className="iv__problem" role="alert">
              {problem}
            </p>
          )}

          {!checked && (
            <div className="iv__actions">
              <button type="button" className="cs__btn cs__btn--primary" disabled={busy || !rows.length} onClick={() => void check()}>
                {busy ? 'Checking…' : rows.length > 1 ? `Check ${rows.length} people` : 'Check'}
              </button>
              <span className="mg__hint">Nothing is sent yet.</span>
            </div>
          )}
        </div>

        {checked && (
          <div className="iv__review" aria-live="polite">
            <p className="iv__summary">
              <strong>{ready.length}</strong> ready to invite
              {notGoing.length ? (
                <>
                  {' '}
                  · <strong>{notGoing.length}</strong> will not be sent
                </>
              ) : null}
            </p>
            <InviteTable rows={checked} />
            <div className="iv__actions">
              <button type="button" className="cs__btn cs__btn--primary" disabled={busy || !ready.length} onClick={() => void send()}>
                {busy ? 'Sending…' : ready.length === 1 ? 'Send 1 invitation' : `Send ${ready.length} invitations`}
              </button>
              <button type="button" className="cs__btn" disabled={busy} onClick={() => setChecked(null)}>
                Change the list
              </button>
            </div>
          </div>
        )}

        {results && (
          <div className="iv__review" role="status">
            <p className="iv__summary">
              <strong>{results.filter((r) => r.status === 'sent').length}</strong> sent
              {results.some((r) => r.status === 'failed') && (
                <>
                  {' '}
                  · <strong>{results.filter((r) => r.status === 'failed').length}</strong> failed
                </>
              )}
              {results.some((r) => r.status === 'skipped') && (
                <>
                  {' '}
                  · <strong>{results.filter((r) => r.status === 'skipped').length}</strong> not sent
                </>
              )}
            </p>
            <InviteTable rows={results} />
            <div className="iv__actions">
              <button type="button" className="cs__btn cs__btn--primary" onClick={onBack}>
                Back to people
              </button>
              <button type="button" className="cs__btn" onClick={() => setResults(null)}>
                Invite more
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const STATUS_WORDS: Record<Checked['status'], string> = {
  ready: 'Ready',
  sent: 'Sent',
  skipped: 'Not sent',
  failed: 'Failed',
};

function InviteTable({ rows }: { rows: Checked[] }) {
  return (
    <table className="vw__table iv__table">
      <thead>
        <tr>
          <th scope="col">Email</th>
          <th scope="col">Role</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.email}-${i}`}>
            <td style={{ overflowWrap: 'anywhere' }}>{r.email || <em>empty</em>}</td>
            <td>{roleName(r.role)}</td>
            <td>
              <span className={`iv__status iv__status--${r.status}`}>{STATUS_WORDS[r.status]}</span>
              {r.note && <span className="iv__note">{r.note}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
