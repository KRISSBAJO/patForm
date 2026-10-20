'use client';

import './meetings.css';
import { EmptyState, ShellSync, type ModuleShell } from './module-shell';
import { Illustration } from './illustrations';
import { useCallback, useEffect, useState } from 'react';
import { postJson } from './stepup';

/*
 * Expenses (PRD Module 5). Finance sees what is owed, reviews lines, checks
 * bank details, pays, exports, and keeps the policy, rates and budgets.
 * Everyone else sees only their own bank details, which they keep here.
 * Approved is not paid: a claim shows as paid only after Finance records a
 * payment reference, and that needs the bank details checked first.
 */

type Tab = 'claims' | 'advances' | 'budgets' | 'exports' | 'settings' | 'mine';
type Settlement = {
  id: string; instance_id: string; claimant: string; claimant_name: string; amount: string; currency: string;
  status: 'awaiting_payment' | 'paid' | 'failed' | 'void'; reference: string | null; note: string | null;
  paid_at: string | null; created_at: string; advance_reference: string | null;
  requested_amount: string | null; approved_amount: string | null; advance_applied: string;
  original_currency: string | null; original_amount: string | null; fx_rate: string | null;
  export_batch: number | null; bank_last4: string | null; bank_name: string | null; bank_verified: boolean; bank_changed: boolean;
};
type Advance = {
  id: string; instance_id: string; reference: string; holder: string; holder_name: string; amount: string; currency: string;
  status: 'approved' | 'disbursed' | 'awaiting_return' | 'retired' | 'void'; outstanding: string; spent: string; returned: string;
  disbursed_at: string | null; due_at: string | null; overdue: boolean;
};
type Settings = {
  categories: string[]; autoApproveLimit: number; managerLimit: number; lineLimit: number; receiptThreshold: number;
  advanceRetirementDays: number; accountCodes: Record<string, string>; defaultAccountCode: string | null;
  requireVerifiedBeneficiary: boolean; currency: string;
};
type Summary = {
  currency: string; awaitingPayment: number; awaitingAmount: number; failed: number; paidLast30Days: number; unexported: number;
  bankUnchecked: number; advancesOpen: number; advancesOverdue: number; heldOnAdvances: number;
};
type Line = { index: number; description: string; requested: number; approved: number; status: string; reason: string | null };
type Budget = { id: string; cost_centre: string; period_start: string; period_end: string; amount: string; mode: string; reserved: string; consumed: string; available: number };
type Rate = { id: string; from_currency: string; to_currency: string; rate: string; effective_from: string; source: string; entered_by: string | null };
type ExportBatch = { batch_no: number; rows: number; total: string; currency: string; checksum: string; created_at: string; created_by: string | null; claims: number };
type MyBank = { accountName: string; bankName: string; bankCode: string | null; account: string; version: number; updatedAt: string } | null;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}
function useFeed<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try { setData(await get<T>(path)); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}

const money = (v: string | number | null, c: string) => `${c} ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (v: string | number | null) => Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const day = (v: string | null) => (v ? new Date(v).toLocaleDateString([], { dateStyle: 'medium' }) : '');
const initials = (n: string) => n.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();

const SETTLEMENT_WORDS: Record<Settlement['status'], string> = {
  awaiting_payment: 'To pay', paid: 'Paid', failed: 'Payment failed', void: 'Void',
};
const ADVANCE_WORDS: Record<Advance['status'], string> = {
  approved: 'To pay out', disbursed: 'Held', awaiting_return: 'Balance due back', retired: 'Retired', void: 'Void',
};
const pillOf = (s: string) => ({ awaiting_payment: 'open', paid: 'passed', failed: 'failed', void: 'cancelled', approved: 'open', disbursed: 'called', awaiting_return: 'open', retired: 'passed', overdue: 'failed', enforced: 'called', advisory: 'draft' }[s] ?? 'draft');
const Pill = ({ s, text }: { s: string; text?: string }) => <span className={`mx__pill mx__pill--${pillOf(s)}`}><i />{text ?? s.replace(/_/g, ' ')}</span>;
const Field = ({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) => <div className={`mx__field ${wide ? 'mx__field--wide' : ''}`}><label>{label}</label>{children}</div>;
const Avatar = ({ name }: { name: string }) => <span className="mx__avatar mx__avatar--lg" style={{ marginLeft: 0 }}>{initials(name)}</span>;
const Bar = ({ value, max, warn }: { value: number; max: number; warn?: boolean }) => <div className="mx__voteBar" style={{ height: 6 }}><span className="is-for" style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`, background: warn ? '#c0392b' : 'var(--mod, #7a3e9d)' }} /></div>;

function bankWords(s: Settlement): { text: string; ok: boolean } {
  if (!s.bank_last4) return { text: 'No bank details given', ok: false };
  if (s.bank_changed) return { text: `Bank details changed — check again (${s.bank_name} •••• ${s.bank_last4})`, ok: false };
  if (s.bank_verified) return { text: `Bank checked: ${s.bank_name} •••• ${s.bank_last4}`, ok: true };
  return { text: `Bank not checked yet: ${s.bank_name} •••• ${s.bank_last4}`, ok: false };
}

/** Anyone in the workspace keeps their own bank details here. */
function MyBankDetails() {
  const mine = useFeed<MyBank>('/api/expenses/bank');
  const [form, setForm] = useState({ accountName: '', bankName: '', bankCode: '', accountNumber: '' });
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setNote(null);
    try {
      const done = await postJson<{ unpaidClaimsAffected: number }>('/api/expenses/bank', form);
      setForm({ ...form, accountNumber: '' }); setEditing(false); await mine.reload();
      setNote({ text: done.unpaidClaimsAffected ? `Saved. Finance will check the new details before paying your ${done.unpaidClaimsAffected} unpaid claim(s).` : 'Saved.' });
    } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); }
    finally { setBusy(false); }
  };
  const b = mine.data;
  return <div className="mx__card">
    <div className="mx__cardHead"><h3>My bank details</h3>{!editing && <button type="button" className="mx__btn mx__btn--sm" onClick={() => { setEditing(true); if (b) setForm({ accountName: b.accountName, bankName: b.bankName, bankCode: b.bankCode ?? '', accountNumber: '' }); }}>{b ? 'Change' : 'Add bank details'}</button>}</div>
    {note && <p className={`mx__notice ${note.err ? 'mx__notice--err' : ''}`} style={{ margin: '0 20px 12px' }} role="status">{note.text}</p>}
    {mine.error && <p className="mx__notice mx__notice--err" style={{ margin: '0 20px 12px' }} role="alert">{mine.error}</p>}
    {!editing && (b ? <div className="ex__bankCard"><Illustration name="verify" size={56} /><div><strong>{b.accountName}</strong><span>{b.bankName}{b.bankCode ? ` · code ${b.bankCode}` : ''}</span><span className="ex__mono">{b.account}</span><small className="mx__tiny">Updated {day(b.updatedAt)} · only the last four digits are ever shown · Finance checks the details before paying</small></div></div>
      : <EmptyState icon="search" title="No bank details yet" text="Add them so Finance can pay your claims. Only the last four digits are ever shown." action={{ label: 'Add bank details', onClick: () => setEditing(true) }} />)}
    {editing && <div className="mx__cardBody"><form className="mx__form" onSubmit={save}>
      <Field label="Name on the account"><input required maxLength={120} value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} /></Field>
      <Field label="Bank"><input required maxLength={120} value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} /></Field>
      <Field label="Bank or sort code (optional)"><input maxLength={20} value={form.bankCode} onChange={(e) => setForm({ ...form, bankCode: e.target.value })} /></Field>
      <Field label="Account number"><input required inputMode="numeric" autoComplete="off" maxLength={40} value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} /></Field>
      <div className="mx__field--wide mx__voteBtns" style={{ marginTop: 0 }}><button type="submit" className="mx__btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setEditing(false)}>Cancel</button></div>
    </form></div>}
  </div>;
}

function LineReview({ settlementId, onDone }: { settlementId: string; onDone: (message: string) => void }) {
  const lines = useFeed<{ currency: string | null; rate: number; lines: Line[] }>(`/api/expenses/settlements/${settlementId}/lines`);
  const [edits, setEdits] = useState<Record<number, { approved: string; reason: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (lines.data) setEdits(Object.fromEntries(lines.data.lines.map((l) => [l.index, { approved: String(l.approved), reason: l.reason ?? '' }])));
  }, [lines.data]);
  if (lines.error) return <p className="mx__notice mx__notice--err" role="alert">{lines.error}</p>;
  if (!lines.data) return <p className="mx__tiny">Loading lines…</p>;
  const cur = lines.data.currency ?? '';
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const changed = lines.data!.lines.filter((l) => edits[l.index] && (Number(edits[l.index]!.approved) !== l.approved || (edits[l.index]!.reason || null) !== l.reason));
      if (!changed.length) { setError('Nothing changed.'); return; }
      const done = await postJson<{ amount: number; status: string }>(`/api/expenses/settlements/${settlementId}/lines`, {
        lines: changed.map((l) => ({ index: l.index, approved: Number(edits[l.index]!.approved), reason: edits[l.index]!.reason })),
      });
      onDone(done.status === 'void' ? 'Every line was rejected; the claim is void.' : `Lines saved. To pay now: ${done.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}.`);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return <div className="ex__lines">
    {lines.data.rate !== 1 && <p className="mx__tiny">Claimed in {cur} at {lines.data.rate} (rate kept from submission).</p>}
    <table className="ex__table">
      <thead><tr><th scope="col">Line</th><th scope="col">Claimed ({cur})</th><th scope="col">Approve ({cur})</th><th scope="col">Reason if less</th></tr></thead>
      <tbody>{lines.data.lines.map((l) => <tr key={l.index}>
        <td>{l.description}</td>
        <td>{l.requested.toFixed(2)}</td>
        <td><label className="ex__sr" htmlFor={`ln-${settlementId}-${l.index}`}>Approve for {l.description}</label><input id={`ln-${settlementId}-${l.index}`} className="mx__input" inputMode="decimal" value={edits[l.index]?.approved ?? ''} onChange={(e) => setEdits({ ...edits, [l.index]: { ...edits[l.index]!, approved: e.target.value } })} /></td>
        <td><label className="ex__sr" htmlFor={`lr-${settlementId}-${l.index}`}>Reason for {l.description}</label><input id={`lr-${settlementId}-${l.index}`} className="mx__input" maxLength={300} value={edits[l.index]?.reason ?? ''} onChange={(e) => setEdits({ ...edits, [l.index]: { ...edits[l.index]!, reason: e.target.value } })} /></td>
      </tr>)}</tbody>
    </table>
    {error && <p className="mx__notice mx__notice--err" role="alert">{error}</p>}
    <div><button type="button" className="mx__btn mx__btn--sm" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save line decisions'}</button></div>
  </div>;
}

export function ExpensesView({ canAdminister, canOperate, onOpenRecord, shell }: { canAdminister: boolean; canOperate: boolean; onOpenRecord: (instanceId: string) => void; shell?: ModuleShell }) {
  const [tab, setTab] = useState<Tab>(canOperate ? 'claims' : 'mine');
  const pickTab = (id: Tab) => { setTab(id); shell?.onSection?.(id); };
  const summary = useFeed<Summary>(canOperate ? '/api/expenses/summary' : null);
  const settlements = useFeed<Settlement[]>(canOperate ? '/api/expenses/settlements' : null);
  const advances = useFeed<Advance[]>(canOperate ? '/api/expenses/advances' : null);
  const budgets = useFeed<Budget[]>(canOperate ? '/api/expenses/budgets' : null);
  const exports = useFeed<ExportBatch[]>(canOperate ? '/api/expenses/exports' : null);
  const settings = useFeed<Settings>(canOperate ? '/api/expenses/settings' : null);
  const rates = useFeed<Rate[]>(canOperate ? '/api/expenses/rates' : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [acting, setActing] = useState<{ id: string; kind: 'pay' | 'fail' | 'void' | 'disburse' | 'return' | 'lines' | 'bank' } | null>(null);
  const [revealed, setRevealed] = useState<{ accountName: string; bankName: string; bankCode: string | null; accountNumber: string } | null>(null);
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [draft, setDraft] = useState<Settings | null>(null);
  const [categoriesText, setCategoriesText] = useState('');
  const [codesText, setCodesText] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [adding, setAdding] = useState<null | 'budget' | 'rate'>(null);
  const [budgetForm, setBudgetForm] = useState({ costCentre: '', periodStart: '', periodEnd: '', amount: '', mode: 'advisory' });
  const [rateForm, setRateForm] = useState({ from: '', rate: '', source: '', effectiveFrom: '' });
  const [exportRange, setExportRange] = useState({ from: '', to: '' });

  useEffect(() => {
    if (!settings.data) return;
    setDraft(settings.data);
    setCategoriesText(settings.data.categories.join(', '));
    setCodesText(Object.entries(settings.data.accountCodes).map(([k, v]) => `${k}=${v}`).join('\n'));
  }, [settings.data]);
  useEffect(() => {
    if (shell?.section && shell.section !== tab) { setTab(shell.section as Tab); setActing(null); setNote(null); setAdding(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell?.section]);

  const reloadAll = async () => { await Promise.all([summary.reload(), settlements.reload(), advances.reload(), budgets.reload(), exports.reload()]); };
  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { setNote({ text: await work() }); setActing(null); setRevealed(null); setReference(''); setReason(''); setAmount(''); await reloadAll(); }
    catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); }
    finally { setBusy(null); }
  };

  const s = summary.data;
  const cur = s?.currency ?? settings.data?.currency ?? '';
  const openSettlements = (settlements.data ?? []).filter((x) => showClosed || x.status === 'awaiting_payment' || x.status === 'failed');
  const openAdvances = (advances.data ?? []).filter((x) => showClosed || !['retired', 'void'].includes(x.status));
  const tabs: { id: Tab; name: string; count: number | null }[] = canOperate ? [
    { id: 'claims', name: 'Claims to pay', count: ((s?.awaitingPayment ?? 0) + (s?.failed ?? 0)) || null },
    { id: 'advances', name: 'Advances', count: s?.advancesOpen || null },
    { id: 'budgets', name: 'Budgets', count: budgets.data?.length || null },
    { id: 'exports', name: 'Exports', count: s?.unexported || null },
    { id: 'settings', name: 'Policy and rates', count: null },
    { id: 'mine', name: 'My bank details', count: null },
  ] : [{ id: 'mine', name: 'My bank details', count: null }];
  const error = ({ claims: settlements.error, advances: advances.error, budgets: budgets.error, exports: exports.error, settings: settings.error ?? rates.error, mine: null } as Record<Tab, string | null>)[tab] ?? summary.error;

  const actionForm = (id: string) => {
    if (!acting || acting.id !== id || acting.kind === 'lines' || acting.kind === 'bank') return null;
    const k = acting.kind;
    const needsRef = k === 'pay' || k === 'disburse' || k === 'return';
    const label = { pay: 'Record payment', fail: 'Mark payment failed', void: 'Void this claim', disburse: 'Record pay-out', return: 'Record money returned' }[k];
    return <form className="mx__ask ex__inline" onSubmit={(e) => {
      e.preventDefault();
      void act(id, async () => {
        if (k === 'pay') { await postJson(`/api/expenses/settlements/${id}`, { to: 'paid', reference }); return 'Payment recorded.'; }
        if (k === 'fail') { await postJson(`/api/expenses/settlements/${id}`, { to: 'failed', note: reason }); return 'Marked as failed. The claim stays approved and still owed.'; }
        if (k === 'void') { await postJson(`/api/expenses/settlements/${id}`, { to: 'void', note: reason }); return 'Claim voided.'; }
        if (k === 'disburse') { await postJson(`/api/expenses/advances/${id}/disburse`, { reference }); return 'Advance paid out. The holder has until the due date to retire it.'; }
        await postJson(`/api/expenses/advances/${id}/return`, { amount, reference }); return 'Return recorded.';
      });
    }}>
      <strong className="ex__inlineTitle">{label}</strong>
      {k === 'return' && <><label htmlFor={`amt-${id}`}>Amount returned</label><input id={`amt-${id}`} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} /></>}
      {needsRef
        ? <><label htmlFor={`ref-${id}`}>{k === 'return' ? 'Receipt or transfer reference' : 'Payment reference (bank or payroll batch)'}</label><input id={`ref-${id}`} required maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} /></>
        : <><label htmlFor={`why-${id}`}>Reason</label><input id={`why-${id}`} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></>}
      <div className="mx__voteBtns" style={{ marginTop: 0 }}>
        <button type="submit" className={`mx__btn mx__btn--sm ${k === 'void' ? 'mx__btn--danger' : ''}`} disabled={busy === id}>{busy === id ? 'Saving…' : 'Save'}</button>
        <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setActing(null)}>Cancel</button>
      </div>
    </form>;
  };

  const bankCheck = (x: Settlement) => {
    if (!acting || acting.id !== x.id || acting.kind !== 'bank') return null;
    return <div className="mx__ask ex__inline">
      <strong className="ex__inlineTitle">Check {x.claimant_name}&rsquo;s bank details</strong>
      <small className="mx__tiny">Compare them with what you hold on file or the claimant&rsquo;s confirmation. Viewing them is recorded.</small>
      {revealed
        ? <p className="ex__revealed"><strong>{revealed.accountName}</strong> · {revealed.bankName}{revealed.bankCode ? ` · code ${revealed.bankCode}` : ''} · account <span className="ex__mono">{revealed.accountNumber}</span></p>
        : <div><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy === `${x.id}-reveal`} onClick={() => void (async () => { setBusy(`${x.id}-reveal`); setNote(null); try { setRevealed(await postJson(`/api/expenses/settlements/${x.id}/bank`, {})); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } finally { setBusy(null); } })()}>Show full details</button></div>}
      <div className="mx__voteBtns" style={{ marginTop: 0 }}>
        <button type="button" className="mx__btn mx__btn--sm" disabled={!revealed || busy === x.id} onClick={() => void act(x.id, async () => { await postJson(`/api/expenses/settlements/${x.id}/verify-bank`, {}); return 'Bank details checked. You can record the payment.'; })}>These details are correct</button>
        <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setActing(null); setRevealed(null); }}>Cancel</button>
      </div>
    </div>;
  };

  const saveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    void act('settings', async () => {
      const accountCodes: Record<string, string> = {};
      for (const line of codesText.split(/\r?\n/)) { const [k, v] = line.split('='); if (k?.trim() && v?.trim()) accountCodes[k.trim()] = v.trim(); }
      await postJson('/api/expenses/settings', {
        autoApproveLimit: draft.autoApproveLimit, managerLimit: draft.managerLimit, lineLimit: draft.lineLimit, receiptThreshold: draft.receiptThreshold,
        advanceRetirementDays: draft.advanceRetirementDays, requireVerifiedBeneficiary: draft.requireVerifiedBeneficiary,
        defaultAccountCode: draft.defaultAccountCode ?? '', accountCodes,
        categories: categoriesText.split(',').map((c) => c.trim()).filter(Boolean),
      });
      await settings.reload();
      return 'Policy saved. New claims use it from now on.';
    });
  };

  const download = (filename: string, csv: string) => {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
  };

  const num = (label: string, key: 'autoApproveLimit' | 'managerLimit' | 'lineLimit' | 'receiptThreshold' | 'advanceRetirementDays', hint?: string) => draft && <Field label={label}><input inputMode="decimal" disabled={!canAdminister} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} />{hint && <small className="mx__tiny">{hint}</small>}</Field>;

  return <div className="mx">
    <ShellSync sections={tabs} onSections={shell?.onSections} />
    {!shell && <div className="mx__segs" style={{ marginBottom: 14 }}>{tabs.map((t) => <button key={t.id} type="button" className={`mx__seg ${tab === t.id ? 'is-on' : ''}`} onClick={() => { pickTab(t.id); setActing(null); setNote(null); }}>{t.name}{t.count ? ` · ${t.count}` : ''}</button>)}</div>}

    <section className="mx__band">
      <div className="mx__bandGrid">
        <div>
          <div className="mx__eyebrow">Expenses</div>
          <h2 className="mx__bandTitle">{canOperate ? (s && s.awaitingPayment + s.failed ? `${money(s.awaitingAmount, cur)} owed to staff` : 'Nothing owed right now') : 'Your expenses'}</h2>
          <p className="mx__bandSub">{canOperate ? 'Approved claims are paid once the bank details are checked.' : 'Keep your bank details current so Finance can pay you.'}</p>
          <div className="mx__bandActions">
            {canOperate && <button type="button" className="mx__btn mx__btn--light" onClick={() => pickTab('claims')}>Pay claims</button>}
            {canOperate && <button type="button" className="mx__btn mx__btn--outline" onClick={() => pickTab('exports')}>Export to accounts</button>}
            <button type="button" className={`mx__btn ${canOperate ? 'mx__btn--outline' : 'mx__btn--light'}`} onClick={() => pickTab('mine')}>My bank details</button>
          </div>
        </div>
        {canOperate && s && <>
          <div className={`mx__kpi ${s.awaitingPayment ? 'mx__kpi--live' : ''}`}><span>To pay</span><strong>{s.awaitingPayment}</strong><small>{money(s.awaitingAmount, cur)} · {s.bankUnchecked} bank check{s.bankUnchecked === 1 ? '' : 's'} to do</small></div>
          <div className={`mx__kpi ${s.failed ? 'mx__kpi--live' : ''}`}><span>Failed</span><strong>{s.failed}</strong><small>still owed · {s.paidLast30Days} paid in 30 days</small></div>
          <div className="mx__kpi"><span>Advances held</span><strong>{s.advancesOpen}</strong><small>{money(s.heldOnAdvances, cur)} · {s.advancesOverdue} overdue</small></div>
        </>}
      </div>
    </section>

    {note && <p className={`mx__notice ${note.err ? 'mx__notice--err' : ''}`} style={{ marginTop: 16 }} role="status">{note.text}</p>}
    {error && <p className="mx__notice mx__notice--err" style={{ marginTop: 16 }} role="alert">{error}</p>}

    <div className="mx__stack" style={{ marginTop: 18 }}>
      {tab === 'mine' && <MyBankDetails />}

      {tab === 'claims' && <div className="mx__card">
        <div className="mx__cardHead"><h3>Approved claims</h3><div className="mx__segs"><button type="button" className={`mx__seg ${!showClosed ? 'is-on' : ''}`} onClick={() => setShowClosed(false)}>To pay</button><button type="button" className={`mx__seg ${showClosed ? 'is-on' : ''}`} onClick={() => setShowClosed(true)}>All, with paid and closed</button></div></div>
        <div className="ex__records">{openSettlements.map((x) => {
          const bank = bankWords(x);
          const open = x.status === 'awaiting_payment' || x.status === 'failed';
          const cut = x.requested_amount !== null && x.approved_amount !== null && Number(x.approved_amount) < Number(x.requested_amount);
          const active = acting?.id === x.id;
          return <div key={x.id} className={`ex__record ${active ? 'is-open' : ''}`}>
            <div className="ex__recordHead">
              <Avatar name={x.claimant_name} />
              <div className="mx__main">
                <strong>{x.claimant_name} <Pill s={x.status} text={SETTLEMENT_WORDS[x.status]} /></strong>
                <small>approved {day(x.created_at)}{x.reference ? ` · ref ${x.reference}` : ''}{x.paid_at ? ` · paid ${day(x.paid_at)}` : ''}{x.export_batch ? ` · export batch ${x.export_batch}` : ''}{x.note ? ` · ${x.note}` : ''}</small>
                <small>{cut ? `${money(x.approved_amount, x.currency)} approved of ${money(x.requested_amount, x.currency)} claimed` : ''}{x.original_currency && x.original_currency !== x.currency ? `${cut ? ' · ' : ''}claimed ${money(x.original_amount, x.original_currency)} at ${Number(x.fx_rate)}` : ''}{Number(x.advance_applied) > 0 ? ` · ${money(x.advance_applied, x.currency)} from advance ${x.advance_reference}` : ''}</small>
                {open && <small className={`ex__bank ${bank.ok ? 'is-ok' : 'is-off'}`}>{bank.text}</small>}
              </div>
              <div className="ex__amount"><strong>{money(x.amount, x.currency)}</strong><small>{open ? 'to pay' : x.status}</small></div>
            </div>
            <div className="ex__recordBtns">
              <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => onOpenRecord(x.instance_id)}>Open claim</button>
              {open && <>
                <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" aria-expanded={active && acting.kind === 'lines'} onClick={() => setActing(active && acting.kind === 'lines' ? null : { id: x.id, kind: 'lines' })}>Review lines</button>
                {!bank.ok && x.bank_last4 && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setRevealed(null); setActing({ id: x.id, kind: 'bank' }); }}>Check bank details</button>}
                <button type="button" className="mx__btn mx__btn--sm" disabled={settings.data?.requireVerifiedBeneficiary !== false && !bank.ok} title={bank.ok ? undefined : 'Check the bank details first'} onClick={() => setActing({ id: x.id, kind: 'pay' })}>Record payment</button>
                {x.status === 'awaiting_payment' && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setActing({ id: x.id, kind: 'fail' })}>Payment failed</button>}
                <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setActing({ id: x.id, kind: 'void' })}>Void</button>
              </>}
            </div>
            {actionForm(x.id)}
            {bankCheck(x)}
            {active && acting.kind === 'lines' && <LineReview settlementId={x.id} onDone={(m) => { setNote({ text: m }); setActing(null); void reloadAll(); }} />}
          </div>;
        })}
        {settlements.data && !openSettlements.length && <EmptyState icon="inbox" title={showClosed ? 'No claims yet' : 'Nothing waiting to be paid'} text="Approved claims arrive here. Check the bank details, then record each payment with its reference." />}</div>
      </div>}

      {tab === 'advances' && <div className="mx__card">
        <div className="mx__cardHead"><h3>Cash advances</h3><div className="mx__segs"><button type="button" className={`mx__seg ${!showClosed ? 'is-on' : ''}`} onClick={() => setShowClosed(false)}>Open</button><button type="button" className={`mx__seg ${showClosed ? 'is-on' : ''}`} onClick={() => setShowClosed(true)}>All</button></div></div>
        <div className="ex__records">{openAdvances.map((x) => <div key={x.id} className={`ex__record ${acting?.id === x.id ? 'is-open' : ''}`}>
          <div className="ex__recordHead">
            <Avatar name={x.holder_name} />
            <div className="mx__main">
              <strong>{x.holder_name} <Pill s={x.overdue ? 'overdue' : x.status} text={x.overdue ? 'Overdue' : ADVANCE_WORDS[x.status]} /></strong>
              <small>{x.reference}{x.due_at ? ` · retire by ${day(x.due_at)}` : ''}{x.disbursed_at ? ` · paid out ${day(x.disbursed_at)}` : ''}</small>
              <div className="ex__split"><Bar value={Number(x.spent) + Number(x.returned)} max={Number(x.amount)} warn={x.overdue} /><small className="mx__tiny">{money(x.spent, x.currency)} spent · {money(x.returned, x.currency)} returned · {money(x.outstanding, x.currency)} still held</small></div>
            </div>
            <div className="ex__amount"><strong>{money(x.amount, x.currency)}</strong><small>advanced</small></div>
          </div>
          <div className="ex__recordBtns">
            <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => onOpenRecord(x.instance_id)}>Open request</button>
            {x.status === 'approved' && <button type="button" className="mx__btn mx__btn--sm" onClick={() => setActing({ id: x.id, kind: 'disburse' })}>Record pay-out</button>}
            {(x.status === 'disbursed' || x.status === 'awaiting_return') && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setActing({ id: x.id, kind: 'return' })}>Money returned</button>}
          </div>
          {actionForm(x.id)}
        </div>)}
        {advances.data && !openAdvances.length && <EmptyState icon="send" title="No open advances" text="When an advance request is approved it appears here. Record the pay-out; the holder retires it with a claim that quotes its reference." />}</div>
      </div>}

      {tab === 'budgets' && <>
        <div className="mx__card">
          <div className="mx__cardHead"><h3>Budgets by cost centre</h3>{canAdminister && <button type="button" className="mx__btn mx__btn--sm" onClick={() => setAdding(adding === 'budget' ? null : 'budget')}>{adding === 'budget' ? 'Close' : '+ Set a budget'}</button>}</div>
          {adding === 'budget' && canAdminister && <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('budget', async () => { await postJson('/api/expenses/budgets', budgetForm); setBudgetForm({ ...budgetForm, amount: '' }); setAdding(null); return 'Budget saved.'; }); }}>
            <Field label="Cost centre"><input required maxLength={60} value={budgetForm.costCentre} onChange={(e) => setBudgetForm({ ...budgetForm, costCentre: e.target.value })} /></Field>
            <Field label={`Amount (${cur})`}><input required inputMode="decimal" value={budgetForm.amount} onChange={(e) => setBudgetForm({ ...budgetForm, amount: e.target.value })} /></Field>
            <Field label="From"><input type="date" required value={budgetForm.periodStart} onChange={(e) => setBudgetForm({ ...budgetForm, periodStart: e.target.value })} /></Field>
            <Field label="To"><input type="date" required value={budgetForm.periodEnd} onChange={(e) => setBudgetForm({ ...budgetForm, periodEnd: e.target.value })} /></Field>
            <Field label="When it runs out" wide><div className="mx__segs"><button type="button" className={`mx__seg ${budgetForm.mode === 'advisory' ? 'is-on' : ''}`} onClick={() => setBudgetForm({ ...budgetForm, mode: 'advisory' })}>Warn, but let claims through</button><button type="button" className={`mx__seg ${budgetForm.mode === 'enforced' ? 'is-on' : ''}`} onClick={() => setBudgetForm({ ...budgetForm, mode: 'enforced' })}>Refuse claims it cannot cover</button></div><small className="mx__tiny">Saving the same cost centre and start date again changes it.</small></Field>
            <div className="mx__field--wide"><button type="submit" className="mx__btn" disabled={busy === 'budget'}>Save budget</button></div>
          </form></div>}
          <div className="ex__budgets">{(budgets.data ?? []).map((b) => { const total = Number(b.amount); const used = Number(b.consumed) + Number(b.reserved); return <div key={b.id} className="ex__budget">
            <div className="ex__budgetHead"><strong>{b.cost_centre}</strong><Pill s={b.mode} text={b.mode === 'enforced' ? 'Enforced' : 'Advisory'} /></div>
            <small className="mx__tiny">{day(b.period_start)} to {day(b.period_end)}</small>
            <div className="ex__budgetBig"><strong style={{ color: b.available < 0 ? '#c0392b' : undefined }}>{money(b.available, cur)}</strong><small>left of {money(b.amount, cur)}</small></div>
            <Bar value={used} max={total} warn={b.available < 0} />
            <small className="mx__tiny">{short(b.consumed)} spent · {short(b.reserved)} in progress</small>
          </div>; })}
          {budgets.data && !budgets.data.length && <EmptyState icon="check" title="No budgets yet" text="Claims are not checked against a budget until one is set. An enforced budget refuses a claim it cannot cover; an advisory one lets it through and marks it." action={canAdminister ? { label: 'Set a budget', onClick: () => setAdding('budget') } : undefined} />}</div>
        </div>
      </>}

      {tab === 'exports' && <>
        <div className="mx__card"><div className="mx__cardHead"><h3>Export paid claims</h3><small>{s ? `${s.unexported} paid claim${s.unexported === 1 ? '' : 's'} waiting` : ''}</small></div>
          <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('export', async () => { const out = await postJson<{ batchNo: number; claims: number; rows: number; total: number; currency: string; filename: string; csv: string }>('/api/expenses/exports', exportRange); download(out.filename, out.csv); return `Batch ${out.batchNo}: ${out.claims} claims, ${out.rows} rows, ${money(out.total, out.currency)}. The file has downloaded.`; }); }}>
            <Field label="Paid from"><input type="date" value={exportRange.from} onChange={(e) => setExportRange({ ...exportRange, from: e.target.value })} /></Field>
            <Field label="Paid to"><input type="date" value={exportRange.to} onChange={(e) => setExportRange({ ...exportRange, to: e.target.value })} /></Field>
            <div className="mx__field--wide"><button type="submit" className="mx__btn" disabled={busy === 'export' || !s?.unexported}>Export CSV</button><small className="mx__tiny" style={{ marginLeft: 12 }}>Leave the dates empty to take everything waiting. One row per approved line with its account code; bank details are never included.</small></div>
          </form></div></div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Batches</h3><small>each batch goes out once</small></div>
          <ul className="mx__list" style={{ marginTop: 10 }}>{(exports.data ?? []).map((b) => <li key={b.batch_no}><div className="mx__date"><strong>{b.batch_no}</strong><small>batch</small></div><div className="mx__main"><strong>{b.claims} claim{b.claims === 1 ? '' : 's'} · {money(b.total, b.currency)}</strong><small>{new Date(b.created_at).toLocaleString()} by {b.created_by ?? 'someone'} · {b.rows} rows · checksum <span className="ex__mono">{b.checksum.slice(0, 12)}…</span></small></div></li>)}{exports.data && !exports.data.length && <li><EmptyState icon="register" title="No batches yet" text="Each export is numbered and checksummed so accounts can tie it back." /></li>}</ul></div>
      </>}

      {tab === 'settings' && draft && <>
        <div className="mx__card"><div className="mx__cardHead"><h3>Expense policy</h3><small>amounts in {cur} · every new claim copies these numbers when submitted</small></div>
          <div className="mx__cardBody"><form className="mx__form" onSubmit={saveSettings}>
            {num('Approve automatically up to', 'autoApproveLimit')}
            {num('Manager alone approves up to', 'managerLimit')}
            {num('Any single item over this goes to Finance', 'lineLimit')}
            {num('Receipt needed for claims over', 'receiptThreshold')}
            {num('Days to retire an advance', 'advanceRetirementDays')}
            <Field label="Before paying"><div className="mx__segs"><button type="button" className={`mx__seg ${draft.requireVerifiedBeneficiary ? 'is-on' : ''}`} disabled={!canAdminister} onClick={() => setDraft({ ...draft, requireVerifiedBeneficiary: true })}>Bank details must be checked</button><button type="button" className={`mx__seg ${!draft.requireVerifiedBeneficiary ? 'is-on' : ''}`} disabled={!canAdminister} onClick={() => setDraft({ ...draft, requireVerifiedBeneficiary: false })}>No check needed</button></div></Field>
            <Field label="Categories Finance accepts (comma separated)" wide><input disabled={!canAdminister} value={categoriesText} onChange={(e) => setCategoriesText(e.target.value)} /></Field>
            <Field label="Account code per category (one per line: travel=6100)"><textarea rows={4} disabled={!canAdminister} value={codesText} onChange={(e) => setCodesText(e.target.value)} /></Field>
            <Field label="Account code for anything else"><input maxLength={40} disabled={!canAdminister} value={draft.defaultAccountCode ?? ''} onChange={(e) => setDraft({ ...draft, defaultAccountCode: e.target.value })} /></Field>
            <div className="mx__field--wide">{canAdminister ? <button type="submit" className="mx__btn" disabled={busy === 'settings'}>{busy === 'settings' ? 'Saving…' : 'Save policy'}</button> : <small className="mx__tiny">Only owners and admins can change the policy.</small>}</div>
          </form></div></div>
        <div className="mx__card"><div className="mx__cardHead"><h3>Exchange rates into {cur}</h3>{canAdminister && <button type="button" className="mx__btn mx__btn--sm" onClick={() => setAdding(adding === 'rate' ? null : 'rate')}>{adding === 'rate' ? 'Close' : '+ Add a rate'}</button>}</div>
          {adding === 'rate' && canAdminister && <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('rate', async () => { await postJson('/api/expenses/rates', rateForm); setRateForm({ from: '', rate: '', source: '', effectiveFrom: '' }); setAdding(null); await rates.reload(); return 'Rate added. New claims in that currency use it from its start date.'; }); }}>
            <Field label="Currency"><input required maxLength={3} placeholder="USD" value={rateForm.from} onChange={(e) => setRateForm({ ...rateForm, from: e.target.value.toUpperCase() })} /></Field>
            <Field label={`1 unit = how many ${cur}`}><input required inputMode="decimal" value={rateForm.rate} onChange={(e) => setRateForm({ ...rateForm, rate: e.target.value })} /></Field>
            <Field label="Source"><input required maxLength={120} placeholder="Central bank official rate" value={rateForm.source} onChange={(e) => setRateForm({ ...rateForm, source: e.target.value })} /></Field>
            <Field label="From"><input type="date" value={rateForm.effectiveFrom} onChange={(e) => setRateForm({ ...rateForm, effectiveFrom: e.target.value })} /></Field>
            <div className="mx__field--wide"><button type="submit" className="mx__btn" disabled={busy === 'rate'}>Add rate</button><small className="mx__tiny" style={{ marginLeft: 12 }}>Rates are never edited: a new rate takes over from its start date, and claims already submitted keep theirs.</small></div>
          </form></div>}
          <ul className="mx__list">{(rates.data ?? []).map((r) => <li key={r.id}><span className="mx__avatar" style={{ marginLeft: 0, fontSize: 10 }}>{r.from_currency}</span><div className="mx__main"><strong>1 {r.from_currency} = {Number(r.rate)} {r.to_currency}</strong><small>from {day(r.effective_from)} · {r.source}{r.entered_by ? ` · added by ${r.entered_by}` : ''}</small></div></li>)}{rates.data && !rates.data.length && <li><EmptyState icon="templates" title="No rates yet" text="Claims in other currencies need a rate into the workspace currency before they can be submitted." /></li>}</ul></div>
      </>}
    </div>
  </div>;
}
