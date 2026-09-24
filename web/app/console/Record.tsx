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

import { useState } from 'react';
import { RecordTrail } from './Trail';
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
  viewerRoles: string[];
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
  onDecide,
  onCompleteTask,
  onExport,
}: {
  record: RecordDetail;
  /** Set when this record is waiting on a decision from whoever is signed in. */
  approval?: PendingApproval;
  /** Set when a task on this record is assigned to them. */
  task?: PendingTask;
  busy: string | null;
  onBack: () => void;
  onDecide: (instanceId: string, approvalKey: string, decision: 'approved' | 'rejected', reason: string) => void;
  onCompleteTask: (instanceId: string, taskKey: string, answers: Record<string, string>) => void;
  onExport: (instanceId: string, reference: string, format: 'json' | 'csv') => void;
}) {
  const [showTrail, setShowTrail] = useState(false);
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [completionAnswers, setCompletionAnswers] = useState<Record<string, string>>({});
  const [receiptError, setReceiptError] = useState<string | null>(null);
  // A majority vote reads as a vote: "Vote for", "Vote against".
  const voting = approval?.progress?.of !== undefined;

  const working = busy !== null;
  const shown = record.fields.filter((f) => f.value !== '[redacted]');
  const hidden = record.fields.length - shown.length;

  return (
    <div className="rc">
      <div className="rc__bar">
        {receiptError && <span role="alert" className="fm__error">{receiptError}</span>}
        <button type="button" className="rc__back" onClick={onBack}>
          <Icon name="back" />
          Back to your work
        </button>
        <span style={{ flexGrow: 1 }} />
        <button type="button" className="cs__btn" onClick={() => onExport(record.instanceId, record.reference, 'json')}>
          <Icon name="export" />
          Export
        </button>
        <button type="button" className="cs__btn" onClick={() => onExport(record.instanceId, record.reference, 'csv')}>
          <Icon name="table" />
          CSV
        </button>
      </div>

      <header className="rc__head">
        <div>
          {/* The reference is in the page heading already; repeating it here
              made the page open with the same string twice. */}
          <h2 className="rc__state">{record.stateName}</h2>
          <p className="rc__meta">
            Version {record.version} · you are seeing this as{' '}
            {record.viewerRoles.join(', ') || 'somebody with no role in this process'}
          </p>
        </div>
      </header>

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

          {rejecting ? (
            <div className="rc__reason">
              <label className="rc__reasonLabel" htmlFor="reject-reason">
                {voting ? 'Why are you voting against?' : 'Why are you rejecting this? The applicant may be told.'}
              </label>
              <textarea
                id="reject-reason"
                className="rc__reasonBox"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="rc__reasonActions">
                <button type="button" className="cs__btn" onClick={() => setRejecting(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="cs__btn cs__btn--danger"
                  disabled={working || !reason.trim()}
                  onClick={() => onDecide(record.instanceId, approval.approvalKey, 'rejected', reason.trim())}
                >
                  <Icon name="reject" />
                  {voting ? 'Vote against' : 'Confirm rejection'}
                </button>
              </div>
            </div>
          ) : (
            <div className="rc__decisionActions">
              <button type="button" className="cs__btn" disabled={working} onClick={() => setRejecting(true)}>
                <Icon name="reject" />
                {voting ? 'Vote against' : 'Reject'}
              </button>
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
        <div className="rc__answers">
          <div className="cs__panel">
            <div className="cs__panelHead">
              <h2 className="cs__tab">What they sent</h2>
              {hidden > 0 && (
                <span className="cs__sort">
                  {hidden} {hidden === 1 ? 'answer is' : 'answers are'} hidden from your role
                </span>
              )}
            </div>
            <dl className="rc__fields">
              {record.fields.map((f) => (
                /*
                  * The chip lives inside the <dd>, not beside it. A <div> in a
                  * <dl> may hold a dt/dd pair and nothing else — a third
                  * element makes the whole list malformed, and a screen reader
                  * then has no reliable pairing between any label and any
                  * value on the page.
                  */
                <div className="rc__field" key={f.key}>
                  <dt className="rc__label">{f.label}</dt>
                  <dd className="rc__value">
                    <span className="rc__valueText">
                      {f.value === '[redacted]' ? (
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
                    <span className={`rc__class rc__class--${f.classification}`} title={classOf(f.classification).long}>
                      {classOf(f.classification).short}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <aside className="rc__side">
          <div className="cs__card">
            <span className="cs__cardLabel">WHAT HAPPENS NEXT</span>
            <p className="rc__next">{record.nextAction}</p>
          </div>

          <div className={`cs__card rc__trailCard${showTrail ? ' rc__trailCard--open' : ''}`}>
            <span className="cs__cardLabel">THE TRAIL</span>
            {!showTrail && (
              <p className="rc__sideNote">
                Every event, job, attempt and result for this record — what ran, in what order, and what failed.
              </p>
            )}
            <button type="button" className="cs__btn" aria-expanded={showTrail} aria-controls="record-trail" onClick={() => setShowTrail((w) => !w)}>
              <Icon name={showTrail ? 'hide' : 'trail'} />
              {showTrail ? 'Hide the trail' : 'Show the trail'}
            </button>
            {showTrail && (
              <div id="record-trail" className="rc__trailContent" role="region" aria-label="The trail">
                <RecordTrail instanceId={record.instanceId} />
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
