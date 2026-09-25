'use client';

/**
 * One record, given the whole page.
 *
 * It was a panel below the work list: the thing somebody opens in order to
 * make a decision, squeezed under the list they opened it from, with the
 * decision buttons left behind in that list. So the answer to "should I
 * approve this" was in one place and the Approve button was in another.
 *
 * Here the record is the page. The decision sits at the top, above the
 * answers, because it is the reason anybody came — and it is the same call to
 * the same endpoint the list made, checked by the runtime and not by this
 * page.
 */

import { useEffect, useMemo, useState } from 'react';
import { RecordTrail } from './Trail';
import { BulkBar } from './Views';
import { Icon } from './Icon';
import { answer, who } from './format';
import { isSignature, SignatureView } from '../../components/signature-field';

export interface RecordDetail {
  instanceId: string;
  reference: string;
  processKey: string;
  processName: string;
  version: number;
  stateName: string;
  nextAction: string;
  stateType?: string;
  completedAt?: string | null;
  viewerRoles: string[];
  canAddNote?: boolean;
  notes?: { id: number; text: string; actor: string | null; createdAt: string }[];
  fields: {
    key: string;
    label: string;
    classification: string;
    value: unknown;
    /** The answer in words, from the server; absent on an older API. */
    text?: string | null;
    table?: { columns: string[]; rows: string[][]; references?: unknown[][] };
  }[];
}

export interface PendingApproval {
  instanceId: string;
  approvalKey: string;
  approvalName: string;
  allowRequestChanges?: boolean;
  waitingHours: number;
  late: boolean;
  summary: string;
  progress?: { have: number; need: number; against?: number; of?: number } | null;
}

export interface PendingTask {
  instanceId: string;
  taskKey: string;
  taskName: string;
  description?: string;
  requiredFields?: { key: string; label: string; type: string }[];
  assignee: string | null;
  late: boolean;
  summary: string;
}

/*
 * The four-letter chips said CONF, INTE, REST and PUBL. They are the field's
 * data classification, which decides who may see it and how long it is kept,
 * and nobody outside this codebase reads "INTE".
 */
const CLASS_WORDS: Record<string, { short: string; long: string }> = {
  public: { short: 'public', long: 'Public — no restriction on who may see this.' },
  internal: { short: 'internal', long: 'Internal — for people in the workspace.' },
  confidential: {
    short: 'confidential',
    long: 'Confidential — only roles this process grants sight of it.',
  },
  restricted: {
    short: 'restricted',
    long: 'Restricted — the tightest class. Special-category or financial.',
  },
};

function classOf(key: string) {
  return CLASS_WORDS[key] ?? { short: key, long: key };
}

export function RecordPage({
  record,
  approval,
  task,
  busy,
  onBack,
  backLabel,
  onDecide,
  onCompleteTask,
  onExport,
  onActionDone,
}: {
  record: RecordDetail;
  /** Set when this record is waiting on a decision from whoever is signed in. */
  approval?: PendingApproval;
  /** Set when a task on this record is assigned to them. */
  task?: PendingTask;
  busy: string | null;
  onBack: () => void;
  backLabel: string;
  onDecide: (instanceId: string, approvalKey: string, decision: 'approved' | 'rejected' | 'changes_requested', reason: string) => void;
  onCompleteTask: (instanceId: string, taskKey: string, answers: Record<string, string>) => void;
  onExport: (instanceId: string, reference: string, format: 'json' | 'csv') => void;
  onActionDone: () => void;
}) {
  const [showTrail, setShowTrail] = useState(false);
  const [reason, setReason] = useState('');
  const [decisionMode, setDecisionMode] = useState<'rejected' | 'changes_requested' | null>(null);
  const [completionAnswers, setCompletionAnswers] = useState<Record<string, string>>({});
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [classification, setClassification] = useState('all');
  const [conceal, setConceal] = useState(false);
  const [actions, setActions] = useState<{ kind: 'set_answer' | ''; field: string } | null>(null);
  const [editableFields, setEditableFields] = useState<string[]>([]);
  const [hasRecordActions, setHasRecordActions] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState('');
  // A majority vote reads as a vote: "Vote for", "Vote against".
  const voting = approval?.progress?.of !== undefined;

  const working = busy !== null;
  const shown = record.fields.filter((f) => f.value !== '[redacted]');
  const hidden = record.fields.length - shown.length;
  const selectedRecord = useMemo(() => new Map([[record.instanceId, record.reference]]), [record.instanceId, record.reference]);
  const isFinished = record.stateType === 'terminal' || Boolean(record.completedAt);
  useEffect(() => {
    if (isFinished) return;
    let live = true;
    fetch(`/api/bulk/options?process=${encodeURIComponent(record.processKey)}`, { credentials: 'same-origin' })
      .then(async (response) => response.ok ? response.json() : null)
      .then((options: { fields?: { key: string }[]; templates?: unknown[]; tasks?: unknown[]; moveTargets?: unknown[] } | null) => {
        if (!live || !options) return;
        setEditableFields(options.fields?.map((field) => field.key) ?? []);
        setHasRecordActions(Boolean(options.fields?.length || options.templates?.length || options.tasks?.length || options.moveTargets?.length));
      }).catch(() => {});
    return () => { live = false; };
  }, [record.processKey, isFinished]);
  const classes = ['all', ...['public', 'internal', 'confidential', 'restricted'].filter((key) => record.fields.some((f) => f.classification === key))];
  const filteredFields = record.fields.filter((f) => {
    if (classification !== 'all' && f.classification !== classification) return false;
    const term = query.trim().toLocaleLowerCase();
    return !term || `${f.label} ${f.key} ${f.value === '[redacted]' ? '' : f.text ?? (typeof f.value === 'string' ? f.value : '')}`.toLocaleLowerCase().includes(term);
  });
  const saveNote = async () => {
    if (!noteText.trim() || noteBusy) return;
    setNoteBusy(true);
    setNoteError('');
    try {
      const response = await fetch(`/api/records/${record.instanceId}/notes`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: noteText.trim() }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error ?? 'The note could not be saved.');
      }
      setNoteText('');
      setNoteOpen(false);
      onActionDone();
    } catch (error) {
      setNoteError(error instanceof Error ? error.message : 'The note could not be saved.');
    } finally { setNoteBusy(false); }
  };

  return (
    <div className="rc">
      <div className="rc__bar">
        {receiptError && <span role="alert" className="fm__error">{receiptError}</span>}
        <button type="button" className="rc__back" onClick={onBack}>
          <Icon name="back" />
          {backLabel}
        </button>
        <span style={{ flexGrow: 1 }} />
        <button type="button" className="cs__btn" onClick={() => onExport(record.instanceId, record.reference, 'json')}>
          <Icon name="export" />
          Export JSON
        </button>
        <button type="button" className="cs__btn" onClick={() => onExport(record.instanceId, record.reference, 'csv')}>
          <Icon name="table" />
          Export CSV
        </button>
        {record.canAddNote && <button type="button" className="cs__btn" onClick={() => setNoteOpen((open) => !open)} aria-expanded={noteOpen} aria-controls="record-note-form"><Icon name="note" /> Add note</button>}
        {!isFinished && hasRecordActions && <button type="button" className="cs__btn cs__btn--primary" onClick={() => setActions({ kind: '', field: '' })}>Take action</button>}
      </div>

      <header className="rc__head">
        <div>
          <span className="rc__eyebrow">{record.processName.toUpperCase()} · VERSION {record.version}</span>
          <h2 className="rc__state">Submission answers</h2>
          <p className="rc__meta">
            {record.fields.length} recorded {record.fields.length === 1 ? 'field' : 'fields'} · Viewing as {record.viewerRoles.map((role) => role.replace(/_/g, ' ')).join(', ') || 'a workspace member'}
          </p>
        </div>
        <span className="rc__statePill"><span aria-hidden="true" />{record.stateName}</span>
      </header>

      {noteOpen && record.canAddNote && <section id="record-note-form" className="rc__noteComposer" aria-label="Add a note to this record">
        <div><h3>Add a record note</h3><p>Notes are saved with the record and visible to people who can operate this process.</p></div>
        <label className="vw__srOnly" htmlFor="record-note-text">Record note</label>
        <textarea id="record-note-text" value={noteText} onChange={(event) => setNoteText(event.target.value)} maxLength={2000} rows={3} placeholder="Write a short update or handover note…" />
        {noteError && <p className="fm__error" role="alert">{noteError}</p>}
        <div className="rc__noteComposerActions"><span>{noteText.length} / 2,000</span><button type="button" className="cs__btn" onClick={() => setNoteOpen(false)}>Cancel</button><button type="button" className="cs__btn cs__btn--primary" disabled={!noteText.trim() || noteBusy} onClick={saveNote}>{noteBusy ? 'Saving…' : 'Save note'}</button></div>
      </section>}

      {/*
        * The decision, above everything.
        *
        * Shown only when the runtime already has work waiting for this person
        * on this record — the same source the work list reads. A button that
        * appears and then gets refused teaches people to distrust the page.
        */}
      {approval && (
        <section className="rc__decision" data-late={approval.late ? 'true' : undefined}>
          <div className="rc__decisionText">
            <h3>{approval.approvalName}</h3>
            <p>
              Waiting {approval.waitingHours}h{approval.late ? ' — past its service level' : ''}. {approval.summary}
            </p>
            {approval.progress && approval.progress.of !== undefined ? (
              <p className="rc__progress">
                A vote among {approval.progress.of}: {approval.progress.have} for, {approval.progress.against ?? 0}{' '}
                against so far. It passes when {approval.progress.need} vote for it, and fails as soon as that can no
                longer happen — a tie fails. You vote once.
              </p>
            ) : approval.progress ? (
              <p className="rc__progress">
                {approval.progress.have} of {approval.progress.need} approved so far — your decision counts once, and
                anyone who has decided already will not see this again.
              </p>
            ) : null}
          </div>

          {decisionMode ? (
            <div className="rc__reason">
              <label className="rc__reasonLabel" htmlFor="reject-reason">
                {decisionMode === 'changes_requested' ? 'What must be corrected? The applicant may be told.' : voting ? 'Why are you voting against?' : 'Why are you rejecting this? The applicant may be told.'}
              </label>
              <textarea
                id="reject-reason"
                className="rc__reasonBox"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="rc__reasonActions">
                  <button type="button" className="cs__btn" onClick={() => setDecisionMode(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="cs__btn cs__btn--danger"
                  disabled={working || !reason.trim()}
                  onClick={() => onDecide(record.instanceId, approval.approvalKey, decisionMode, reason.trim())}
                >
                  <Icon name="reject" />
                  {decisionMode === 'changes_requested' ? 'Send back for changes' : voting ? 'Vote against' : 'Confirm rejection'}
                </button>
              </div>
            </div>
          ) : (
            <div className="rc__decisionActions">
              <button type="button" className="cs__btn" disabled={working} onClick={() => setDecisionMode('rejected')}>
                <Icon name="reject" />
                {voting ? 'Vote against' : 'Reject'}
              </button>
              {approval.allowRequestChanges && !voting && (
                <button type="button" className="cs__btn" disabled={working} onClick={() => setDecisionMode('changes_requested')}>
                  Request changes
                </button>
              )}
              <button
                type="button"
                className="cs__btn cs__btn--primary"
                disabled={working}
                onClick={() => onDecide(record.instanceId, approval.approvalKey, 'approved', 'Approved in the console')}
              >
                <Icon name="approve" />
                {voting ? 'Vote for' : 'Approve'}
              </button>
            </div>
          )}
        </section>
      )}

      {task && (
        <section className="rc__decision" data-late={task.late ? 'true' : undefined}>
          <div className="rc__decisionText">
            <h3>{task.taskName}</h3>
            <p>
              Assigned to {who(task.assignee)}
              {task.late ? ' — overdue' : ''}. {task.summary}
            </p>
            {task.description && <p>{task.description}</p>}
            {task.requiredFields?.map((field) => {
              const recorded = record.fields.find((f) => f.key === field.key)?.value;
              const value = completionAnswers[field.key] ?? (typeof recorded === 'string' && recorded !== '[redacted]' ? recorded : '');
              return (
                <div key={field.key} style={{ marginTop: 12 }}>
                  <label htmlFor={`task-${field.key}`}>{field.label} <span aria-hidden="true">*</span></label>
                  {field.type === 'long_text' ? (
                    <textarea
                      id={`task-${field.key}`}
                      className="rc__reasonBox"
                      value={value}
                      onChange={(e) => setCompletionAnswers((was) => ({ ...was, [field.key]: e.target.value }))}
                      required
                    />
                  ) : (
                    <input
                      id={`task-${field.key}`}
                      className="rc__reasonBox"
                      value={value}
                      onChange={(e) => setCompletionAnswers((was) => ({ ...was, [field.key]: e.target.value }))}
                      required
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="rc__decisionActions">
            <button
              type="button"
              className="cs__btn cs__btn--primary"
              disabled={working || task.requiredFields?.some((field) => {
                const recorded = record.fields.find((f) => f.key === field.key)?.value;
                const value = completionAnswers[field.key] ?? (typeof recorded === 'string' && recorded !== '[redacted]' ? recorded : '');
                return !value.trim();
              })}
              onClick={() => onCompleteTask(record.instanceId, task.taskKey, completionAnswers)}
            >
              <Icon name="done" />
              Mark done
            </button>
          </div>
        </section>
      )}

      <div className="rc__body">
        <div className="rc__answers cs__panel">
          <div className="rc__tableIntro"><div><span className="rc__eyebrow">RECORDED RESPONSES</span><h3>Fields and answers</h3></div><span>{hidden > 0 ? `${hidden} hidden from your role` : `${shown.length} visible answers`}</span></div>
          <div className="rc__toolbar">
            <label className="rc__search"><Icon name="search"/><span className="vw__srOnly">Search fields and answers</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search fields and answers" type="search" /></label>
            <div className="rc__filters" role="group" aria-label="Filter by classification">{classes.map((key) => <button key={key} type="button" className={classification === key ? 'rc__filter rc__filter--active' : 'rc__filter'} aria-pressed={classification === key} onClick={() => setClassification(key)}>{key === 'all' ? 'All' : classOf(key).short}<span>{key === 'all' ? record.fields.length : record.fields.filter((f) => f.classification === key).length}</span></button>)}</div>
            <button className="rc__conceal" type="button" aria-pressed={conceal} onClick={() => setConceal((value) => !value)}><Icon name={conceal ? 'hide' : 'open'}/>{conceal ? 'Show sensitive values' : 'Hide sensitive values'}</button>
          </div>
          {copyStatus && <p className="rc__copyStatus" role="status">{copyStatus}</p>}
          {actions && <BulkBar key={`${actions.kind}:${actions.field}`} processKey={record.processKey} selected={selectedRecord} initialKind={actions.kind} initialField={actions.field} singleRecord onClear={() => setActions(null)} onDone={() => { setActions(null); onActionDone(); }} />}
          <div className="rc__tableScroll"><table className="rc__answerTable"><thead><tr><th scope="col">Field or question</th><th scope="col">Submitted value</th><th scope="col">Classification</th><th scope="col">Actions</th></tr></thead><tbody>
              {filteredFields.map((f) => (
                <tr className="rc__field" key={f.key}>
                  <th scope="row" className="rc__label">{f.label}</th>
                  <td className="rc__value">
                    <span className="rc__valueText">
                      {conceal && (f.classification === 'confidential' || f.classification === 'restricted') && f.value !== '[redacted]' ? (
                        <span className="rc__concealed">Concealed on this screen</span>
                      ) : f.value === '[redacted]' ? (
                        <span className="cs__redacted">hidden from your role</span>
                      ) : isSignature(f.value) ? (
                        <SignatureView value={f.value} />
                      ) : typeof f.value === 'string' && /^receipt-file:[0-9a-f-]{36}$/.test(f.value) ? (
                        <button type="button" className="cs__btn" onClick={async () => {
                          const id = String(f.value).slice('receipt-file:'.length);
                          const response = await fetch(`/api/records/${record.instanceId}/receipts/${id}`);
                          const result = await response.json();
                          if (!response.ok) { setReceiptError(result.error ?? 'The document is unavailable.'); return; }
                          window.location.assign(result.url);
                        }}>Download scanned document</button>
                      ) : f.table && f.table.rows.length ? (
                        <table className="rc__rows">
                          <thead>
                            <tr>
                              {f.table.columns.map((c) => (
                                <th key={c} scope="col">
                                  {c}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {f.table.rows.map((r, i) => (
                              <tr key={i}>
                                {r.map((cell, j) => (
                                  <td key={j}>{typeof f.table?.references?.[i]?.[j] === 'string' &&
                                    /^receipt-file:[0-9a-f-]{36}$/.test(String(f.table.references[i][j])) ? (
                                    <button type="button" className="cs__btn" onClick={async () => {
                                      const id = String(f.table!.references![i]![j]).slice('receipt-file:'.length);
                                      const response = await fetch(`/api/records/${record.instanceId}/receipts/${id}`);
                                      const result = await response.json();
                                      if (!response.ok) { setReceiptError(result.error ?? 'The document is unavailable.'); return; }
                                      window.location.assign(result.url);
                                    }}>Download document</button>
                                  ) : cell}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : f.text ? (
                        f.text
                      ) : (
                        (answer(f.value) ?? <span className="rc__blank">not answered</span>)
                      )}
                    </span>
                  </td>
                  <td><span className={`rc__class rc__class--${f.classification}`} title={classOf(f.classification).long}>{classOf(f.classification).short}</span></td>
                  <td className="rc__rowActions">{!isFinished && editableFields.includes(f.key) && <button type="button" onClick={() => setActions({ kind: 'set_answer', field: f.key })}>Edit</button>}{!conceal && f.value !== '[redacted]' && (typeof f.value === 'string' || typeof f.value === 'number' || typeof f.value === 'boolean') && <button type="button" className="rc__iconButton" aria-label={`Copy ${f.label}`} title={`Copy ${f.label}`} onClick={async () => { try { await navigator.clipboard.writeText(f.text ?? String(f.value)); setCopyStatus(`${f.label} copied to clipboard.`); } catch { setCopyStatus('Clipboard access was unavailable.'); } }}><Icon name="copy" /></button>}</td>
                </tr>
              ))}
          </tbody></table></div>
          {filteredFields.length === 0 && <p className="rc__noResults">No answers match your search and filter.</p>}
          <div className="rc__tableFoot">Showing {filteredFields.length} of {record.fields.length} fields{conceal && <span> · Sensitive values are concealed on this screen only</span>}</div>
        </div>

        <div className="rc__side">
          <section className="rc__sidePanel rc__sidePanel--next"><span className="rc__eyebrow">CURRENT OUTCOME</span><h2>What happens next</h2><p>{record.nextAction}</p></section>
          <section className="rc__sidePanel rc__sidePanel--history"><span className="rc__eyebrow">ACTIVITY</span><h2>Record history</h2>
            {record.canAddNote && <div className="rc__notesSection"><div className="rc__notesHead"><strong>Notes</strong><span>{record.notes?.length ?? 0}</span></div>{record.notes?.length ? <div className="rc__notesList">{record.notes.map((note) => <article key={note.id}><p>{note.text}</p><small>{note.actor ?? 'Workspace member'} · {new Date(note.createdAt).toLocaleString()}</small></article>)}</div> : <p className="rc__notesEmpty">No notes yet.</p>}<button type="button" className="rc__noteLink" onClick={() => { setNoteOpen(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><Icon name="note" /> Add note</button></div>}
            <button type="button" className="cs__btn" aria-expanded={showTrail} aria-controls="record-trail" onClick={() => setShowTrail((w) => !w)}>
              <Icon name={showTrail ? 'hide' : 'trail'} />
              {showTrail ? 'Hide history' : 'Show history'}
            </button>
            {showTrail && (
              <div id="record-trail" className="rc__trailContent" role="region" aria-label="The trail">
                <RecordTrail instanceId={record.instanceId} />
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
