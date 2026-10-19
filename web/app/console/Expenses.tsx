'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
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
const day = (v: string | null) => (v ? new Date(v).toLocaleDateString() : '');
const list = { listStyle: 'none', margin: 0, padding: 0 } as const;

const SETTLEMENT_WORDS: Record<Settlement['status'], string> = {
  awaiting_payment: 'Approved, not paid yet', paid: 'Paid', failed: 'Payment failed — still owed', void: 'Void',
};
const ADVANCE_WORDS: Record<Advance['status'], string> = {
  approved: 'Approved, not paid out', disbursed: 'Paid out, to be retired', awaiting_return: 'Balance to be returned', retired: 'Retired', void: 'Void',
};

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
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setNote(null);
    try {
      const done = await postJson<{ unpaidClaimsAffected: number }>('/api/expenses/bank', form);
      setForm({ ...form, accountNumber: '' }); setEditing(false); await mine.reload();
      setNote(done.unpaidClaimsAffected ? `Saved. Finance will check the new details before paying your ${done.unpaidClaimsAffected} unpaid claim(s).` : 'Saved.');
    } catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const b = mine.data;
  return <section className="ig__panel" aria-labelledby="mybank-heading">
    <div className="ig__panelHead"><div><h3 id="mybank-heading">My bank details</h3><p>Where your expense claims are paid. Only the last four digits are ever shown; Finance checks the details before paying.</p></div>
      {!editing && <button type="button" className="cs__btn cs__btn--primary" onClick={() => { setEditing(true); if (b) setForm({ accountName: b.accountName, bankName: b.bankName, bankCode: b.bankCode ?? '', accountNumber: '' }); }}>{b ? 'Change' : 'Add bank details'}</button>}
    </div>
    {note && <p className="ig__notice" role="status">{note}</p>}
    {mine.error && <p className="ig__error" role="alert">{mine.error}</p>}
    {!editing && <ul style={list}><li className="ig__row"><div className="ig__rowMain">{b ? <><strong>{b.accountName}</strong><span className="ig__status">{b.bankName}</span><p>{b.account}{b.bankCode ? ` · code ${b.bankCode}` : ''} · updated {day(b.updatedAt)}</p></> : <p>No bank details yet. Add them so Finance can pay your claims.</p>}</div></li></ul>}
    {editing && <form className="ig__form" onSubmit={save}>
      <div><label className="cs__label" htmlFor="mb-name">Name on the account</label><input id="mb-name" className="cs__input" required maxLength={120} value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} /></div>
      <div><label className="cs__label" htmlFor="mb-bank">Bank</label><input id="mb-bank" className="cs__input" required maxLength={120} value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} /></div>
      <div><label className="cs__label" htmlFor="mb-code">Bank or sort code (optional)</label><input id="mb-code" className="cs__input" maxLength={20} value={form.bankCode} onChange={(e) => setForm({ ...form, bankCode: e.target.value })} /></div>
      <div><label className="cs__label" htmlFor="mb-number">Account number</label><input id="mb-number" className="cs__input" required inputMode="numeric" autoComplete="off" maxLength={40} value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} /></div>
      <div className="pp2__roleEdit"><button type="submit" className="cs__btn cs__btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="cs__btn" onClick={() => setEditing(false)}>Cancel</button></div>
    </form>}
  </section>;
}

function LineReview({ settlementId, onDone }: { settlementId: string; onDone: (message: string) => void }) {
  const lines = useFeed<{ currency: string | null; rate: number; lines: Line[] }>(`/api/expenses/settlements/${settlementId}/lines`);
  const [edits, setEdits] = useState<Record<number, { approved: string; reason: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (lines.data) setEdits(Object.fromEntries(lines.data.lines.map((l) => [l.index, { approved: String(l.approved), reason: l.reason ?? '' }])));
  }, [lines.data]);
  if (lines.error) return <p className="ig__error" role="alert">{lines.error}</p>;
  if (!lines.data) return <p className="ig__rowMain">Loading lines…</p>;
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
    {lines.data.rate !== 1 && <p className="ig__rowMain">Claimed in {cur} at {lines.data.rate} (rate kept from submission).</p>}
    <table className="ex__table">
      <thead><tr><th scope="col">Line</th><th scope="col">Claimed ({cur})</th><th scope="col">Approve ({cur})</th><th scope="col">Reason if less</th></tr></thead>
      <tbody>{lines.data.lines.map((l) => <tr key={l.index}>
        <td>{l.description}</td>
        <td>{l.requested.toFixed(2)}</td>
        <td><label className="ex__sr" htmlFor={`ln-${settlementId}-${l.index}`}>Approve for {l.description}</label><input id={`ln-${settlementId}-${l.index}`} className="cs__input" inputMode="decimal" value={edits[l.index]?.approved ?? ''} onChange={(e) => setEdits({ ...edits, [l.index]: { ...edits[l.index]!, approved: e.target.value } })} /></td>
        <td><label className="ex__sr" htmlFor={`lr-${settlementId}-${l.index}`}>Reason for {l.description}</label><input id={`lr-${settlementId}-${l.index}`} className="cs__input" maxLength={300} value={edits[l.index]?.reason ?? ''} onChange={(e) => setEdits({ ...edits, [l.index]: { ...edits[l.index]!, reason: e.target.value } })} /></td>
      </tr>)}</tbody>
    </table>
    {error && <p className="pp2__problem" role="alert">{error}</p>}
    <button type="button" className="cs__btn cs__btn--primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save line decisions'}</button>
  </div>;
}

export function ExpensesView({ canAdminister, canOperate, onOpenRecord }: { canAdminister: boolean; canOperate: boolean; onOpenRecord: (instanceId: string) => void }) {
  const [tab, setTab] = useState<Tab>(canOperate ? 'claims' : 'mine');
  const summary = useFeed<Summary>(canOperate ? '/api/expenses/summary' : null);
  const settlements = useFeed<Settlement[]>(canOperate ? '/api/expenses/settlements' : null);
  const advances = useFeed<Advance[]>(canOperate ? '/api/expenses/advances' : null);
  const budgets = useFeed<Budget[]>(canOperate ? '/api/expenses/budgets' : null);
  const exports = useFeed<ExportBatch[]>(canOperate ? '/api/expenses/exports' : null);
  const settings = useFeed<Settings>(canOperate ? '/api/expenses/settings' : null);
  const rates = useFeed<Rate[]>(canOperate ? '/api/expenses/rates' : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [acting, setActing] = useState<{ id: string; kind: 'pay' | 'fail' | 'void' | 'disburse' | 'return' | 'lines' | 'bank' } | null>(null);
  const [revealed, setRevealed] = useState<{ accountName: string; bankName: string; bankCode: string | null; accountNumber: string } | null>(null);
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [draft, setDraft] = useState<Settings | null>(null);
  const [categoriesText, setCategoriesText] = useState('');
  const [codesText, setCodesText] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [budgetForm, setBudgetForm] = useState({ costCentre: '', periodStart: '', periodEnd: '', amount: '', mode: 'advisory' });
  const [rateForm, setRateForm] = useState({ from: '', rate: '', source: '', effectiveFrom: '' });
  const [exportRange, setExportRange] = useState({ from: '', to: '' });

  useEffect(() => {
    if (!settings.data) return;
    setDraft(settings.data);
    setCategoriesText(settings.data.categories.join(', '));
    setCodesText(Object.entries(settings.data.accountCodes).map(([k, v]) => `${k}=${v}`).join('\n'));
  }, [settings.data]);

  const reloadAll = async () => { await Promise.all([summary.reload(), settlements.reload(), advances.reload(), budgets.reload(), exports.reload()]); };
  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { setNote(await work()); setActing(null); setRevealed(null); setReference(''); setReason(''); setAmount(''); await reloadAll(); }
    catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const s = summary.data;
  const cur = s?.currency ?? settings.data?.currency ?? '';
  const openSettlements = (settlements.data ?? []).filter((x) => showClosed || x.status === 'awaiting_payment' || x.status === 'failed');
  const openAdvances = (advances.data ?? []).filter((x) => showClosed || !['retired', 'void'].includes(x.status));
  const tabs: { id: Tab; name: string; count: number | null; icon: 'table' | 'export' | 'trail' | 'account' | 'done' }[] = canOperate ? [
    { id: 'claims', name: 'Claims to pay', count: (s?.awaitingPayment ?? 0) + (s?.failed ?? 0), icon: 'table' },
    { id: 'advances', name: 'Advances', count: s?.advancesOpen ?? 0, icon: 'export' },
    { id: 'budgets', name: 'Budgets', count: budgets.data?.length ?? 0, icon: 'done' },
    { id: 'exports', name: 'Exports', count: s?.unexported ?? 0, icon: 'trail' },
    { id: 'settings', name: 'Policy and rates', count: null, icon: 'trail' },
    { id: 'mine', name: 'My bank details', count: null, icon: 'account' },
  ] : [{ id: 'mine', name: 'My bank details', count: null, icon: 'account' }];
  const error = ({ claims: settlements.error, advances: advances.error, budgets: budgets.error, exports: exports.error, settings: settings.error ?? rates.error, mine: null } as Record<Tab, string | null>)[tab] ?? summary.error;

  const actionForm = (id: string) => {
    if (!acting || acting.id !== id || acting.kind === 'lines' || acting.kind === 'bank') return null;
    const k = acting.kind;
    const needsRef = k === 'pay' || k === 'disburse' || k === 'return';
    const label = { pay: 'Record payment', fail: 'Mark payment failed', void: 'Void this claim', disburse: 'Record pay-out', return: 'Record money returned' }[k];
    return <form className="ig__form" style={{ margin: '12px 0' }} onSubmit={(e) => {
      e.preventDefault();
      void act(id, async () => {
        if (k === 'pay') { await postJson(`/api/expenses/settlements/${id}`, { to: 'paid', reference }); return 'Payment recorded.'; }
        if (k === 'fail') { await postJson(`/api/expenses/settlements/${id}`, { to: 'failed', note: reason }); return 'Marked as failed. The claim stays approved and still owed.'; }
        if (k === 'void') { await postJson(`/api/expenses/settlements/${id}`, { to: 'void', note: reason }); return 'Claim voided.'; }
        if (k === 'disburse') { await postJson(`/api/expenses/advances/${id}/disburse`, { reference }); return 'Advance paid out. The holder has until the due date to retire it.'; }
        await postJson(`/api/expenses/advances/${id}/return`, { amount, reference }); return 'Return recorded.';
      });
    }}>
      <div className="ig__formTitle"><strong>{label}</strong></div>
      {k === 'return' && <div><label className="cs__label" htmlFor={`amt-${id}`}>Amount returned</label><input id={`amt-${id}`} className="cs__input" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} /></div>}
      {needsRef
        ? <div><label className="cs__label" htmlFor={`ref-${id}`}>{k === 'return' ? 'Receipt or transfer reference' : 'Payment reference (bank or payroll batch)'}</label><input id={`ref-${id}`} className="cs__input" required maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        : <div><label className="cs__label" htmlFor={`why-${id}`}>Reason</label><input id={`why-${id}`} className="cs__input" required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
      <div className="pp2__roleEdit" style={{ alignSelf: 'end' }}>
        <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === id}>{busy === id ? 'Saving…' : 'Save'}</button>
        <button type="button" className="cs__btn" onClick={() => setActing(null)}>Cancel</button>
      </div>
    </form>;
  };

  const bankCheck = (x: Settlement) => {
    if (!acting || acting.id !== x.id || acting.kind !== 'bank') return null;
    return <div className="ig__form" style={{ margin: '12px 0' }}>
      <div className="ig__formTitle"><strong>Check {x.claimant_name}&rsquo;s bank details</strong><p>Compare them with what you hold on file or the claimant&rsquo;s confirmation. Viewing them is recorded.</p></div>
      {revealed
        ? <div style={{ gridColumn: '1 / -1' }}><p className="ig__rowMain"><strong>{revealed.accountName}</strong> · {revealed.bankName}{revealed.bankCode ? ` · code ${revealed.bankCode}` : ''} · account <span className="ig__mono">{revealed.accountNumber}</span></p></div>
        : <button type="button" className="cs__btn" disabled={busy === `${x.id}-reveal`} onClick={() => void (async () => { setBusy(`${x.id}-reveal`); setNote(null); try { setRevealed(await postJson(`/api/expenses/settlements/${x.id}/bank`, {})); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); } finally { setBusy(null); } })()}>Show full details</button>}
      <div className="pp2__roleEdit" style={{ alignSelf: 'end' }}>
        <button type="button" className="cs__btn cs__btn--primary" disabled={!revealed || busy === x.id} onClick={() => void act(x.id, async () => { await postJson(`/api/expenses/settlements/${x.id}/verify-bank`, {}); return 'Bank details checked. You can record the payment.'; })}>These details are correct</button>
        <button type="button" className="cs__btn" onClick={() => { setActing(null); setRevealed(null); }}>Cancel</button>
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

  return <div className="ig__workspace">
    <header className="ig__hero">
      <span className="ig__eyebrow">EXPENSES</span>
      <h2>{canOperate ? 'What Finance owes, and who holds advances' : 'Your expenses'}</h2>
      <p>{canOperate ? 'Approved is not paid. A claim shows as paid only when Finance records the payment reference, after checking the bank details.' : 'Keep your bank details up to date so Finance can pay your claims. Make a claim from the expense claim form.'}</p>
    </header>

    {s && <section className="pp2__overview" aria-label="Expenses at a glance" style={{ marginBottom: 18 }}>
      <div><span>Approved, not paid</span><strong>{s.awaitingPayment}</strong><small>{money(s.awaitingAmount, cur)} owed · {s.bankUnchecked} bank checks to do</small></div>
      <div><span>Payments failed</span><strong>{s.failed}</strong><small>Still owed to staff</small></div>
      <div><span>Advances open</span><strong>{s.advancesOpen}</strong><small>{money(s.heldOnAdvances, cur)} held · {s.advancesOverdue} overdue</small></div>
    </section>}

    <div className="ig__surface">
      <div className="ig__tabs" role="tablist" aria-label="Expenses areas">
        {tabs.map((item, index) => <button key={item.id} id={`ex-tab-${item.id}`} type="button" role="tab" aria-controls={`ex-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className="ig__tab" onClick={() => { setTab(item.id); setActing(null); setNote(null); }} onKeyDown={(event) => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : -1; if (next < 0) return; event.preventDefault(); const id = tabs[next]!.id; setTab(id); setActing(null); document.getElementById(`ex-tab-${id}`)?.focus(); }}>
          <Icon name={item.icon} /><span>{item.name}</span>{item.count !== null && <span className="ig__tabCount">{item.count}</span>}
        </button>)}
      </div>

      <section id={`ex-panel-${tab}`} role="tabpanel" aria-labelledby={`ex-tab-${tab}`} className="ig__panel">
        {tab === 'mine' ? <MyBankDetails /> : <>
        <div className="ig__panelHead">
          <div>
            <h3>{{ claims: 'Approved claims', advances: 'Cash advances', budgets: 'Budgets by cost centre', exports: 'Accounting export', settings: 'Expense policy', mine: '' }[tab]}</h3>
            <p>{{
              claims: 'Review lines if needed, check the bank details, then record each payment with its reference. A failed payment stays owed; a paid claim cannot be changed.',
              advances: 'Record when an advance is paid out. The holder retires it with an expense claim that quotes its reference, or returns the balance.',
              budgets: 'An enforced budget refuses a claim it cannot cover; an advisory one lets it through and marks it. Approved claims use the budget; rejected ones give it back.',
              exports: 'Paid claims go out once, in a numbered batch, one row per approved line with its account code. Bank details are never included.',
              settings: 'Every new claim copies these numbers when it is submitted, so a change here never re-routes a claim already in progress.',
              mine: '',
            }[tab]}</p>
          </div>
          {(tab === 'claims' || tab === 'advances') && <label className="pp2__inlineLabel"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show paid and closed</label>}
        </div>
        {note && <p className="ig__notice" role="status">{note}</p>}
        {error && <p className="ig__error" role="alert">{error}</p>}

        {tab === 'claims' && <ul style={list}>
          {openSettlements.map((x) => {
            const bank = bankWords(x);
            const open = x.status === 'awaiting_payment' || x.status === 'failed';
            const cut = x.requested_amount !== null && x.approved_amount !== null && Number(x.approved_amount) < Number(x.requested_amount);
            return <li key={x.id} className="ig__row" style={{ flexWrap: 'wrap' }}>
              <div className="ig__rowMain">
                <strong>{x.claimant_name}</strong>
                <span className={`ig__status ${x.status === 'paid' ? '' : 'ig__status--off'}`}>{SETTLEMENT_WORDS[x.status]}</span>
                <p>
                  {money(x.amount, x.currency)} to pay
                  {cut ? ` · ${money(x.approved_amount, x.currency)} approved of ${money(x.requested_amount, x.currency)} claimed` : ''}
                  {x.original_currency && x.original_currency !== x.currency ? ` · claimed ${money(x.original_amount, x.original_currency)} at ${Number(x.fx_rate)}` : ''}
                  {Number(x.advance_applied) > 0 ? ` · ${money(x.advance_applied, x.currency)} from advance ${x.advance_reference}` : ''}
                </p>
                <p>approved {day(x.created_at)}{x.reference ? ` · ref ${x.reference}` : ''}{x.paid_at ? ` · paid ${day(x.paid_at)}` : ''}{x.export_batch ? ` · export batch ${x.export_batch}` : ''}{x.note ? ` · ${x.note}` : ''}</p>
                {open && <p className={bank.ok ? '' : 'ig__rowError'}>{bank.text}</p>}
                {actionForm(x.id)}
                {bankCheck(x)}
                {acting?.id === x.id && acting.kind === 'lines' && <LineReview settlementId={x.id} onDone={(m) => { setNote(m); setActing(null); void reloadAll(); }} />}
              </div>
              <div className="pp2__roleEdit">
                <button type="button" className="cs__btn" onClick={() => onOpenRecord(x.instance_id)}>Open claim</button>
                {open && <>
                  <button type="button" className="cs__btn" aria-expanded={acting?.id === x.id && acting.kind === 'lines'} onClick={() => setActing(acting?.id === x.id && acting.kind === 'lines' ? null : { id: x.id, kind: 'lines' })}>Review lines</button>
                  {!bank.ok && x.bank_last4 && <button type="button" className="cs__btn" onClick={() => { setRevealed(null); setActing({ id: x.id, kind: 'bank' }); }}>Check bank details</button>}
                  <button type="button" className="cs__btn cs__btn--primary" disabled={settings.data?.requireVerifiedBeneficiary !== false && !bank.ok} title={bank.ok ? undefined : 'Check the bank details first'} onClick={() => setActing({ id: x.id, kind: 'pay' })}>Record payment</button>
                  {x.status === 'awaiting_payment' && <button type="button" className="cs__btn" onClick={() => setActing({ id: x.id, kind: 'fail' })}>Payment failed</button>}
                  <button type="button" className="cs__btn" onClick={() => setActing({ id: x.id, kind: 'void' })}>Void</button>
                </>}
              </div>
            </li>;
          })}
          {settlements.data && !openSettlements.length && <li className="ig__row"><div className="ig__rowMain"><p>Nothing waiting to be paid.</p></div></li>}
        </ul>}

        {tab === 'advances' && <ul style={list}>
          {openAdvances.map((x) => <li key={x.id} className="ig__row" style={{ flexWrap: 'wrap' }}>
            <div className="ig__rowMain">
              <strong>{x.holder_name} · {x.reference}</strong>
              <span className={`ig__status ${x.overdue ? 'ig__status--off' : ''}`}>{x.overdue ? 'Overdue' : ADVANCE_WORDS[x.status]}</span>
              <p>{money(x.amount, x.currency)} advanced · {money(x.outstanding, x.currency)} still held · {money(x.spent, x.currency)} spent · {money(x.returned, x.currency)} returned{x.due_at ? ` · retire by ${day(x.due_at)}` : ''}</p>
              {actionForm(x.id)}
            </div>
            <div className="pp2__roleEdit">
              <button type="button" className="cs__btn" onClick={() => onOpenRecord(x.instance_id)}>Open request</button>
              {x.status === 'approved' && <button type="button" className="cs__btn cs__btn--primary" onClick={() => setActing({ id: x.id, kind: 'disburse' })}>Record pay-out</button>}
              {(x.status === 'disbursed' || x.status === 'awaiting_return') && <button type="button" className="cs__btn" onClick={() => setActing({ id: x.id, kind: 'return' })}>Money returned</button>}
            </div>
          </li>)}
          {advances.data && !openAdvances.length && <li className="ig__row"><div className="ig__rowMain"><p>No open advances.</p></div></li>}
        </ul>}

        {tab === 'budgets' && <>
          {canAdminister && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('budget', async () => { await postJson('/api/expenses/budgets', budgetForm); setBudgetForm({ ...budgetForm, amount: '' }); return 'Budget saved.'; }); }}>
            <div className="ig__formTitle"><strong>Set a budget</strong><p>Saving the same cost centre and start date again changes it.</p></div>
            <div><label className="cs__label" htmlFor="bg-cc">Cost centre</label><input id="bg-cc" className="cs__input" required maxLength={60} value={budgetForm.costCentre} onChange={(e) => setBudgetForm({ ...budgetForm, costCentre: e.target.value })} /></div>
            <div><label className="cs__label" htmlFor="bg-amt">Amount ({cur})</label><input id="bg-amt" className="cs__input" required inputMode="decimal" value={budgetForm.amount} onChange={(e) => setBudgetForm({ ...budgetForm, amount: e.target.value })} /></div>
            <div><label className="cs__label" htmlFor="bg-from">From</label><input id="bg-from" type="date" className="cs__input" required value={budgetForm.periodStart} onChange={(e) => setBudgetForm({ ...budgetForm, periodStart: e.target.value })} /></div>
            <div><label className="cs__label" htmlFor="bg-to">To</label><input id="bg-to" type="date" className="cs__input" required value={budgetForm.periodEnd} onChange={(e) => setBudgetForm({ ...budgetForm, periodEnd: e.target.value })} /></div>
            <div><label className="cs__label" htmlFor="bg-mode">When it runs out</label><select id="bg-mode" className="cs__input" value={budgetForm.mode} onChange={(e) => setBudgetForm({ ...budgetForm, mode: e.target.value })}><option value="advisory">Warn, but let claims through</option><option value="enforced">Refuse claims it cannot cover</option></select></div>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'budget'}>Save budget</button>
          </form>}
          <ul style={list}>
            {(budgets.data ?? []).map((b) => <li key={b.id} className="ig__row"><div className="ig__rowMain">
              <strong>{b.cost_centre}</strong><span className={`ig__status ${b.available < 0 ? 'ig__status--off' : ''}`}>{b.mode === 'enforced' ? 'Enforced' : 'Advisory'}</span>
              <p>{day(b.period_start)} to {day(b.period_end)} · {money(b.amount, cur)} budget · {money(b.consumed, cur)} spent · {money(b.reserved, cur)} in progress · <strong>{money(b.available, cur)} left</strong></p>
            </div></li>)}
            {budgets.data && !budgets.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No budgets yet. Claims are not checked against a budget until one is set.</p></div></li>}
          </ul>
        </>}

        {tab === 'exports' && <>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('export', async () => { const out = await postJson<{ batchNo: number; claims: number; rows: number; total: number; currency: string; filename: string; csv: string }>('/api/expenses/exports', exportRange); download(out.filename, out.csv); return `Batch ${out.batchNo}: ${out.claims} claims, ${out.rows} rows, ${money(out.total, out.currency)}. The file has downloaded.`; }); }}>
            <div className="ig__formTitle"><strong>Export paid claims not yet exported</strong><p>{s ? `${s.unexported} paid claim(s) waiting.` : ''} Leave the dates empty to take everything waiting.</p></div>
            <div><label className="cs__label" htmlFor="xp-from">Paid from</label><input id="xp-from" type="date" className="cs__input" value={exportRange.from} onChange={(e) => setExportRange({ ...exportRange, from: e.target.value })} /></div>
            <div><label className="cs__label" htmlFor="xp-to">Paid to</label><input id="xp-to" type="date" className="cs__input" value={exportRange.to} onChange={(e) => setExportRange({ ...exportRange, to: e.target.value })} /></div>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'export' || !s?.unexported}>Export CSV</button>
          </form>
          <ul style={list}>
            {(exports.data ?? []).map((b) => <li key={b.batch_no} className="ig__row"><div className="ig__rowMain">
              <strong>Batch {b.batch_no}</strong><span className="ig__status">{b.claims} claims</span>
              <p>{new Date(b.created_at).toLocaleString()} by {b.created_by ?? 'someone'} · {b.rows} rows · {money(b.total, b.currency)} · checksum <span className="ig__mono">{b.checksum.slice(0, 12)}…</span></p>
            </div></li>)}
          </ul>
        </>}

        {tab === 'settings' && draft && <>
          <form className="ig__form" onSubmit={saveSettings}>
            <div className="ig__formTitle"><strong>Limits</strong><p>Amounts are in {cur}. Claims in other currencies are converted at the rate in force when they are submitted.</p></div>
            <div><label className="cs__label" htmlFor="ex-auto">Approve automatically up to</label><input id="ex-auto" className="cs__input" inputMode="decimal" disabled={!canAdminister} value={draft.autoApproveLimit} onChange={(e) => setDraft({ ...draft, autoApproveLimit: Number(e.target.value) })} /></div>
            <div><label className="cs__label" htmlFor="ex-mgr">Manager alone approves up to</label><input id="ex-mgr" className="cs__input" inputMode="decimal" disabled={!canAdminister} value={draft.managerLimit} onChange={(e) => setDraft({ ...draft, managerLimit: Number(e.target.value) })} /></div>
            <div><label className="cs__label" htmlFor="ex-line">Any single item over this goes to Finance</label><input id="ex-line" className="cs__input" inputMode="decimal" disabled={!canAdminister} value={draft.lineLimit} onChange={(e) => setDraft({ ...draft, lineLimit: Number(e.target.value) })} /></div>
            <div><label className="cs__label" htmlFor="ex-receipt">Receipt needed for claims over</label><input id="ex-receipt" className="cs__input" inputMode="decimal" disabled={!canAdminister} value={draft.receiptThreshold} onChange={(e) => setDraft({ ...draft, receiptThreshold: Number(e.target.value) })} /></div>
            <div><label className="cs__label" htmlFor="ex-days">Days to retire an advance</label><input id="ex-days" className="cs__input" inputMode="numeric" disabled={!canAdminister} value={draft.advanceRetirementDays} onChange={(e) => setDraft({ ...draft, advanceRetirementDays: Number(e.target.value) })} /></div>
            <div><label className="pp2__inlineLabel"><input type="checkbox" disabled={!canAdminister} checked={draft.requireVerifiedBeneficiary} onChange={(e) => setDraft({ ...draft, requireVerifiedBeneficiary: e.target.checked })} /> Bank details must be checked before paying</label></div>
            <div style={{ gridColumn: '1 / -1' }}><label className="cs__label" htmlFor="ex-cats">Categories Finance accepts (comma separated)</label><input id="ex-cats" className="cs__input" disabled={!canAdminister} value={categoriesText} onChange={(e) => setCategoriesText(e.target.value)} /></div>
            <div><label className="cs__label" htmlFor="ex-codes">Account code per category (one per line: travel=6100)</label><textarea id="ex-codes" className="cs__input" rows={4} disabled={!canAdminister} value={codesText} onChange={(e) => setCodesText(e.target.value)} /></div>
            <div><label className="cs__label" htmlFor="ex-default">Account code for anything else</label><input id="ex-default" className="cs__input" maxLength={40} disabled={!canAdminister} value={draft.defaultAccountCode ?? ''} onChange={(e) => setDraft({ ...draft, defaultAccountCode: e.target.value })} /></div>
            {canAdminister ? <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'settings'}>{busy === 'settings' ? 'Saving…' : 'Save policy'}</button>
              : <p className="ig__rowMain">Only owners and admins can change the policy.</p>}
          </form>
          {canAdminister && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('rate', async () => { await postJson('/api/expenses/rates', rateForm); setRateForm({ from: '', rate: '', source: '', effectiveFrom: '' }); await rates.reload(); return 'Rate added. New claims in that currency use it from its start date.'; }); }}>
            <div className="ig__formTitle"><strong>Add an exchange rate into {cur}</strong><p>Rates are never edited: a new rate takes over from its start date, and claims already submitted keep theirs.</p></div>
            <div><label className="cs__label" htmlFor="rt-from">Currency</label><input id="rt-from" className="cs__input" required maxLength={3} placeholder="USD" value={rateForm.from} onChange={(e) => setRateForm({ ...rateForm, from: e.target.value.toUpperCase() })} /></div>
            <div><label className="cs__label" htmlFor="rt-rate">1 unit = how many {cur}</label><input id="rt-rate" className="cs__input" required inputMode="decimal" value={rateForm.rate} onChange={(e) => setRateForm({ ...rateForm, rate: e.target.value })} /></div>
            <div><label className="cs__label" htmlFor="rt-src">Source</label><input id="rt-src" className="cs__input" required maxLength={120} placeholder="Central bank official rate" value={rateForm.source} onChange={(e) => setRateForm({ ...rateForm, source: e.target.value })} /></div>
            <div><label className="cs__label" htmlFor="rt-eff">From</label><input id="rt-eff" type="date" className="cs__input" value={rateForm.effectiveFrom} onChange={(e) => setRateForm({ ...rateForm, effectiveFrom: e.target.value })} /></div>
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'rate'}>Add rate</button>
          </form>}
          <ul style={list}>
            {(rates.data ?? []).map((r) => <li key={r.id} className="ig__row"><div className="ig__rowMain"><strong>1 {r.from_currency} = {Number(r.rate)} {r.to_currency}</strong><p>from {day(r.effective_from)} · {r.source}{r.entered_by ? ` · added by ${r.entered_by}` : ''}</p></div></li>)}
          </ul>
        </>}
        </>}
      </section>
    </div>
  </div>;
}
