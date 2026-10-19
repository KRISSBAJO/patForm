'use client';

import { useState } from 'react';
import { postJson } from './stepup';

/*
 * Import people from a spreadsheet (PRD ORG-09). Three steps: choose a CSV
 * (or paste it), check every row, then import. Nothing is saved until every
 * row is clean; the check says exactly what is wrong on which row.
 */

type RowResult = { row: number; email: string; name: string; action: 'create' | 'update' | 'unchanged' | 'error'; changes: string[]; errors: string[]; warnings: string[] };
type Result = {
  applied: boolean; rows: RowResult[];
  summary: { create: number; update: number; unchanged: number; errors: number; unitsToCreate: string[]; entitiesToCreate: string[] };
  invitations?: { sent: number; failed: { email: string; reason: string }[] };
};

const COLUMNS: Record<string, string[]> = {
  email: ['email', 'email address', 'work email', 'e-mail'],
  name: ['name', 'full name', 'display name', 'staff name'],
  role: ['role', 'workspace role', 'access'],
  unit: ['unit', 'department', 'team', 'branch', 'org unit'],
  manager: ['manager', 'manager email', 'line manager', 'reports to'],
  title: ['title', 'job title', 'position', 'position title'],
  entity: ['entity', 'legal entity', 'company'],
};
const TEMPLATE = 'email,name,unit,manager,title,role,entity\r\nada@yourcompany.com,Ada Okafor,Head office,,Chief executive,admin,Your Company Ltd\r\nbayo@yourcompany.com,Bayo Adeyemi,Operations > Lagos,ada@yourcompany.com,Branch lead,,Your Company Ltd\r\n';

/** A small CSV reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

function toRows(table: string[][]): { rows: Record<string, string>[]; unknown: string[]; missingEmail: boolean } {
  const [header, ...body] = table;
  if (!header) return { rows: [], unknown: [], missingEmail: true };
  const map = header.map((h) => {
    const key = h.trim().toLowerCase();
    return Object.entries(COLUMNS).find(([, names]) => names.includes(key))?.[0] ?? null;
  });
  const unknown = header.filter((_, i) => !map[i]).map((h) => h.trim()).filter(Boolean);
  const rows = body.map((cells) => {
    const out: Record<string, string> = {};
    map.forEach((k, i) => { if (k) out[k] = (cells[i] ?? '').trim(); });
    return out;
  });
  return { rows, unknown, missingEmail: !map.includes('email') };
}

export function DirectoryImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<{ rows: Record<string, string>[]; unknown: string[] } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendInvitations, setSendInvitations] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const read = (value: string) => {
    setText(value); setResult(null); setProblem(null);
    const table = parseCsv(value);
    const out = toRows(table);
    if (!value.trim()) { setParsed(null); return; }
    if (out.missingEmail) { setParsed(null); setProblem('The first row must be the column names, and one of them must be "email".'); return; }
    if (!out.rows.length) { setParsed(null); setProblem('There are column names but no people under them.'); return; }
    setParsed(out);
  };

  const run = async (dryRun: boolean) => {
    if (!parsed) return;
    setBusy(true); setProblem(null);
    try {
      const done = await postJson<Result>('/api/directory/import', { rows: parsed.rows, dryRun, sendInvitations });
      setResult(done);
      if (done.applied) onImported();
    } catch (err) { setProblem(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const s = result?.summary;
  const shown = result ? result.rows.filter((r) => showAll || r.errors.length || r.warnings.length || r.action !== 'unchanged') : [];

  return <section className="cs__panel dim" aria-labelledby="dim-heading">
    <div className="dim__head">
      <div><h3 id="dim-heading">Import people from a spreadsheet</h3>
        <p>Save your staff list as CSV with a header row. Columns: <strong>email</strong> (required), name, unit, manager (their email), title, role, entity. Write nested units as <em>Operations &gt; Lagos</em>.</p></div>
      <button type="button" className="cs__btn" onClick={onClose}>Close</button>
    </div>

    {!result?.applied && <div className="dim__step">
      <div className="pp2__roleEdit">
        <label className="cs__btn" htmlFor="dim-file">Choose a CSV file</label>
        <input id="dim-file" type="file" accept=".csv,text/csv,text/plain" className="ex__sr" onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(read); }} />
        <a className="cs__btn" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="people-template.csv">Get the template</a>
      </div>
      <label className="cs__label" htmlFor="dim-text">Or paste it here</label>
      <textarea id="dim-text" className="cs__input dim__text" rows={6} spellCheck={false} value={text} onChange={(e) => read(e.target.value)} placeholder={TEMPLATE} />
      {parsed && <p className="dim__note">{parsed.rows.length} {parsed.rows.length === 1 ? 'person' : 'people'} found.{parsed.unknown.length ? ` Ignoring columns: ${parsed.unknown.join(', ')}.` : ''}</p>}
      {problem && <p className="pp2__problem" role="alert">{problem}</p>}
      <div className="pp2__roleEdit">
        <button type="button" className="cs__btn cs__btn--primary" disabled={!parsed || busy} onClick={() => void run(true)}>{busy && !result ? 'Checking…' : 'Check the file'}</button>
      </div>
    </div>}

    {result && s && <div className="dim__step" role="status">
      {result.applied
        ? <p className="ig__notice">Imported: {s.create} added, {s.update} updated{s.unitsToCreate.length ? `, ${s.unitsToCreate.length} units created` : ''}.{result.invitations ? ` Invitations sent: ${result.invitations.sent}${result.invitations.failed.length ? `; ${result.invitations.failed.length} could not be sent` : ''}.` : ' No invitations were sent; you can invite people from the People page.'}</p>
        : s.errors
          ? <p className="ig__error">{s.errors} {s.errors === 1 ? 'row needs' : 'rows need'} fixing. Nothing has been saved. Fix the file and check again.</p>
          : <p className="ig__notice">Everything checks out: {s.create} to add, {s.update} to update, {s.unchanged} unchanged{s.unitsToCreate.length ? `, ${s.unitsToCreate.length} new units (${s.unitsToCreate.join('; ')})` : ''}{s.entitiesToCreate.length ? `, new entities: ${s.entitiesToCreate.join(', ')}` : ''}.</p>}
      {result.invitations?.failed.length ? <ul className="dim__list">{result.invitations.failed.map((f) => <li key={f.email}>{f.email}: {f.reason}</li>)}</ul> : null}

      <table className="ex__table dim__table">
        <thead><tr><th scope="col">Row</th><th scope="col">Person</th><th scope="col">What happens</th></tr></thead>
        <tbody>{shown.map((r) => <tr key={r.row} className={r.errors.length ? 'dim__bad' : ''}>
          <td>{r.row}</td>
          <td><strong>{r.name || '—'}</strong><br /><small>{r.email}</small></td>
          <td>
            {r.errors.map((x) => <div key={x} className="dim__err">✕ {x}</div>)}
            {!r.errors.length && <div>{r.action === 'create' ? 'Add' : r.action === 'update' ? 'Update' : 'No change'}{r.changes.length ? `: ${r.changes.join('; ')}` : ''}</div>}
            {r.warnings.map((x) => <div key={x} className="dim__warn">! {x}</div>)}
          </td>
        </tr>)}</tbody>
      </table>
      {!showAll && result.rows.length > shown.length && <button type="button" className="cs__btn" onClick={() => setShowAll(true)}>Show unchanged rows too ({result.rows.length - shown.length})</button>}

      {!result.applied && !s.errors && (s.create > 0 || s.update > 0) && <div className="pp2__roleEdit dim__go">
        <label className="pp2__inlineLabel"><input type="checkbox" checked={sendInvitations} onChange={(e) => setSendInvitations(e.target.checked)} /> Email an invitation to the {s.create} new {s.create === 1 ? 'person' : 'people'} so they can set a password</label>
        <button type="button" className="cs__btn cs__btn--primary" disabled={busy} onClick={() => void run(false)}>{busy ? 'Importing…' : `Import ${s.create + s.update} ${s.create + s.update === 1 ? 'person' : 'people'}`}</button>
      </div>}
      {result.applied && <button type="button" className="cs__btn cs__btn--primary" onClick={onClose}>Done</button>}
    </div>}
  </section>;
}
