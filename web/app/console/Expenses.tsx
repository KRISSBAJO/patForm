'use client';

import './meetings.css';
import { EmptyState, ShellSync, type ModuleShell } from './module-shell';
import { COUNTRIES, CURRENCIES, Choice, F, Sheet, SheetSection } from './sheet';
import { DataTable } from './datatable';
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

type Tab = 'claims' | 'runs' | 'advances' | 'mine' | 'budgets' | 'reports' | 'exports' | 'settings' | 'bank';
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

type ClaimRow = Settlement & { category: string | null; cost_centre: string | null; purpose: string | null; expense_date: string | null; run_no: number | null; payment_run_id: string | null };
type AdvanceRow = Advance & { purpose: string | null; created_at: string };
type RunRow = { id: string; run_no: number; status: string; currency: string; count: number; total: string; reference: string | null; note: string | null; created_at: string; paid_at: string | null; created_by_name: string | null };
type RunDetail = RunRow & { items: { id: string; instance_id: string; amount: string; currency: string; status: string; reference: string | null; claimant_name: string; cost_centre: string | null; category: string | null; bank_name: string | null; account_last4: string | null }[] };
type MyClaim = { id: string; state: string; outcome: string | null; created_at: string; purpose: string | null; category: string | null; cost_centre: string | null; expense_date: string | null; amount: string; currency: string; settlement_status: string | null; to_pay: string | null; paid_at: string | null; reference: string | null };
type Category = { id: string; key: string; name: string; account_code: string | null; max_per_line: string | null; max_per_claim: string | null; receipt_required: boolean; note_required: boolean; active: boolean; sort_order: number };
type RateCard = { id: string; kind: string; label: string; branch_id: string | null; branch: string | null; branch_country: string | null; country: string | null; rate: string; currency: string; unit: string; effective_from: string; effective_to: string | null; active: boolean };
type Report = { from: string; to: string; currency: string; totals: { claims: number; total: number; paid: number; average: number; reduced: number; reducedBy: number }; advances: { open: number; held: number; overdue: number }; byMonth: Row[]; byCategory: Row[]; byCostCentre: Row[]; byClaimant: Row[]; byStatus: Row[] };
type Row = { key: string; count: number; total: number };
const flag = (cc: string | null) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');
const STATE: Record<string, string> = { draft: 'Draft', manager_review: 'With manager', finance_review: 'With Finance', awaiting_evidence: 'Needs evidence', approved: 'Approved', rejected: 'Rejected', abandoned: 'Abandoned' };

/** Bars for a report breakdown. */
function Breakdown({ title, rows, currency, labels }: { title: string; rows: Row[]; currency: string; labels?: Record<string, string> }) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  return <div className="mx__card"><div className="mx__cardHead"><h3>{title}</h3><small>{rows.length ? money(rows.reduce((t, r) => t + r.total, 0), currency) : ''}</small></div>
    <div className="ex__bars">{rows.map((r) => <div key={r.key} className="ex__bar"><span className="ex__barLabel">{labels?.[r.key] ?? r.key}</span><span className="ex__barTrack"><span style={{ width: `${(r.total / max) * 100}%` }} /></span><span className="ex__barValue">{money(r.total, currency)}<small>{r.count}</small></span></div>)}{!rows.length && <small className="mx__tiny" style={{ padding: '0 20px 16px' }}>Nothing in this period.</small>}</div></div>;
}

/** The allowance calculator a claimant uses before filling the form. */
function Allowance({ branches }: { branches: { id: string; name: string; country: string }[] }) {
  const [kind, setKind] = useState<'per_diem' | 'mileage'>('per_diem');
  const [qty, setQty] = useState('1');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [branch, setBranch] = useState('');
  const out = useFeed<{ amount: number | null; currency: string; card: { label: string; rate: string; unit: string } | null; options: { label: string; rate: string; currency: string; unit: string }[] }>(`/api/expenses/allowance?kind=${kind}&quantity=${encodeURIComponent(qty || '0')}&date=${date}${branch ? `&branch=${branch}` : ''}`);
  const o = out.data;
  return <div className="mx__card"><div className="mx__cardHead"><h3>What can I claim?</h3><small>per diem and mileage at your branch&rsquo;s rate</small></div>
    <div className="mx__cardBody"><div className="mx__form">
      <F label="Allowance" wide><Choice value={kind} onChange={setKind} options={[['per_diem', 'Per diem'], ['mileage', 'Mileage']]} /></F>
      <F label={kind === 'mileage' ? 'Distance' : 'Days'}><input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></F>
      <F label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></F>
      {branches.length > 0 && <F label="Branch" hint="defaults to yours" wide><select value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">My branch</option>{branches.map((b) => <option key={b.id} value={b.id}>{flag(b.country)} {b.name}</option>)}</select></F>}
    </div>
    {o && <div className="ex__allowance">{o.card ? <><strong>{money(o.amount, o.currency)}</strong><small>{o.card.label} · {money(o.card.rate, o.currency)} per {o.card.unit.replace('_', ' ')}</small></> : <small className="mx__tiny">No {kind === 'mileage' ? 'mileage' : 'per diem'} rate applies to you yet. Ask Finance to add one in Setup.</small>}</div>}
    {out.error && <p className="mx__notice mx__notice--err">{out.error}</p>}</div></div>;
}

export function ExpensesView({ canAdminister, canOperate, onOpenRecord, shell }: { canAdminister: boolean; canOperate: boolean; onOpenRecord: (instanceId: string) => void; shell?: ModuleShell }) {
  const [tab, setTab] = useState<Tab>(canOperate ? 'claims' : 'mine');
  const pickTab = (id: Tab) => { setTab(id); shell?.onSection?.(id); setSelected(null); setRun(null); };
  const summary = useFeed<Summary>(canOperate ? '/api/expenses/summary' : null);
  const budgets = useFeed<Budget[]>(canOperate ? '/api/expenses/budgets' : null);
  const exports = useFeed<ExportBatch[]>(canOperate ? '/api/expenses/exports' : null);
  const settings = useFeed<Settings>(canOperate ? '/api/expenses/settings' : null);
  const rates = useFeed<Rate[]>(canOperate ? '/api/expenses/rates' : null);
  const categories = useFeed<{ categories: Category[]; currency: string; canEdit: boolean }>(canOperate ? '/api/expenses/categories' : null);
  const cards = useFeed<{ cards: RateCard[]; currency: string; canEdit: boolean }>('/api/expenses/rate-cards');
  const branches = useFeed<{ branches: { id: string; name: string; country: string; currency: string; active: boolean }[] }>('/api/hr/branches');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<ClaimRow | null>(null);
  const [advance, setAdvance] = useState<AdvanceRow | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [sheet, setSheet] = useState<null | 'pay' | 'fail' | 'void' | 'bank' | 'lines' | 'disburse' | 'return' | 'run' | 'runPay' | 'budget' | 'rate' | 'category' | 'rateCard' | 'export'>(null);
  const [f, setForm] = useState<Record<string, string>>({});
  const v = (k: string) => f[k] ?? '';
  const set = (k: string, val: string) => setForm((x) => ({ ...x, [k]: val }));
  const [revealed, setRevealed] = useState<{ accountName: string; bankName: string; bankCode: string | null; accountNumber: string } | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [setupTab, setSetupTab] = useState<'policy' | 'categories' | 'cards' | 'rates'>('policy');
  const [range, setRange] = useState({ from: new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
  const report = useFeed<Report>(canOperate && tab === 'reports' ? `/api/expenses/report?from=${range.from}&to=${range.to}` : null);

  useEffect(() => { if (settings.data) setDraft(settings.data); }, [settings.data]);
  useEffect(() => {
    if (shell?.section && shell.section !== tab) { setTab(shell.section as Tab); setSheet(null); setNote(null); setSelected(null); setRun(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell?.section]);

  const reloadAll = async () => { await Promise.all([summary.reload(), budgets.reload(), exports.reload(), categories.reload(), cards.reload(), rates.reload()]); setTick((t) => t + 1); };
  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { setNote({ text: await work() }); await reloadAll(); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } finally { setBusy(null); }
  };
  const done = (id: string, work: () => Promise<string>) => void act(id, async () => { const m = await work(); setSheet(null); setForm({}); setRevealed(null); return m; });
  const refreshSelected = async () => { if (selected) { const p = await get<{ rows: ClaimRow[] }>(`/api/expenses/claims/search?size=1&q=${encodeURIComponent(selected.claimant)}&status=${selected.status}`); setSelected(p.rows.find((r) => r.id === selected.id) ?? null); } };
  const openRun = async (id: string) => { try { setRun(await get<RunDetail>(`/api/expenses/runs/${id}`)); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } };

  const s = summary.data;
  const cur = s?.currency ?? settings.data?.currency ?? cards.data?.currency ?? '';
  const br = (branches.data?.branches ?? []).filter((b) => b.active);
  const tabs: { id: Tab; name: string; count: number | null }[] = canOperate ? [
    { id: 'claims', name: 'Claims to pay', count: ((s?.awaitingPayment ?? 0) + (s?.failed ?? 0)) || null },
    { id: 'runs', name: 'Payment runs', count: null },
    { id: 'advances', name: 'Advances', count: s?.advancesOpen || null },
    { id: 'mine', name: 'My claims', count: null },
    { id: 'budgets', name: 'Budgets', count: budgets.data?.length || null },
    { id: 'reports', name: 'Reports', count: null },
    { id: 'exports', name: 'Exports', count: s?.unexported || null },
    { id: 'settings', name: 'Setup', count: null },
    { id: 'bank', name: 'My bank details', count: null },
  ] : [{ id: 'mine', name: 'My claims', count: null }, { id: 'bank', name: 'My bank details', count: null }];
  const download = (filename: string, csv: string) => { const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url); };
  const bankOf = (x: Settlement) => bankWords(x);
  const canPay = (x: Settlement) => settings.data?.requireVerifiedBeneficiary === false || bankOf(x).ok;
  const cardList = cards.data?.cards ?? [];

  return <div className="mx">
    <ShellSync sections={tabs} onSections={shell?.onSections} />
    {!shell && <div className="mx__segs mx__segs--wrap" style={{ marginBottom: 14 }}>{tabs.map((t) => <button key={t.id} type="button" className={`mx__seg ${tab === t.id ? 'is-on' : ''}`} onClick={() => pickTab(t.id)}>{t.name}{t.count ? ` · ${t.count}` : ''}</button>)}</div>}

    <section className="mx__band">
      <div className="mx__bandGrid">
        <div>
          <div className="mx__eyebrow">Expenses</div>
          <h2 className="mx__bandTitle">{canOperate ? (s && s.awaitingPayment + s.failed ? `${money(s.awaitingAmount, cur)} owed to staff` : 'Nothing owed right now') : 'Your expenses'}</h2>
          <p className="mx__bandSub">{canOperate ? 'Check bank details, pay in runs, export to accounts.' : 'Your claims, allowances and bank details.'}</p>
          <div className="mx__bandActions">
            {canOperate && <button type="button" className="mx__btn mx__btn--light" onClick={() => { pickTab('claims'); setForm({}); setSheet('run'); }}>+ Payment run</button>}
            {canOperate && <button type="button" className="mx__btn mx__btn--outline" onClick={() => pickTab('reports')}>Reports</button>}
            <button type="button" className={`mx__btn ${canOperate ? 'mx__btn--outline' : 'mx__btn--light'}`} onClick={() => pickTab('mine')}>My claims</button>
          </div>
        </div>
        {canOperate && s && <>
          <div className={`mx__kpi ${s.awaitingPayment ? 'mx__kpi--live' : ''}`}><span>To pay</span><strong>{s.awaitingPayment}</strong><small>{money(s.awaitingAmount, cur)} · {s.bankUnchecked} bank check{s.bankUnchecked === 1 ? '' : 's'} to do</small></div>
          <div className={`mx__kpi ${s.failed ? 'mx__kpi--live' : ''}`}><span>Failed</span><strong>{s.failed}</strong><small>still owed · {money(s.paidLast30Days, cur)} paid in 30 days</small></div>
          <div className="mx__kpi"><span>Advances held</span><strong>{s.advancesOpen}</strong><small>{money(s.heldOnAdvances, cur)} · {s.advancesOverdue} overdue</small></div>
        </>}
      </div>
    </section>

    {note && <p className={`mx__notice ${note.err ? 'mx__notice--err' : ''}`} style={{ marginTop: 16 }} role="status">{note.text}</p>}

    <div className="mx__stack" style={{ marginTop: 18 }}>
      {tab === 'claims' && <>
        {selected && <div className="ex__record is-open" style={{ background: '#fff' }}>
          <div className="ex__recordHead"><Avatar name={selected.claimant_name} />
            <div className="mx__main"><strong>{selected.claimant_name} <Pill s={selected.status} text={SETTLEMENT_WORDS[selected.status]} />{selected.run_no && <Pill s="called" text={`Run ${selected.run_no}`} />}</strong>
              <small>{[selected.category, selected.cost_centre, selected.expense_date && `spent ${day(selected.expense_date)}`, `approved ${day(selected.created_at)}`].filter(Boolean).join(' · ')}{selected.reference ? ` · ref ${selected.reference}` : ''}{selected.paid_at ? ` · paid ${day(selected.paid_at)}` : ''}{selected.export_batch ? ` · export batch ${selected.export_batch}` : ''}</small>
              {selected.purpose && <small>{selected.purpose}</small>}
              <small>{selected.requested_amount !== null && selected.approved_amount !== null && Number(selected.approved_amount) < Number(selected.requested_amount) ? `${money(selected.approved_amount, selected.currency)} approved of ${money(selected.requested_amount, selected.currency)} claimed` : ''}{selected.original_currency && selected.original_currency !== selected.currency ? ` · claimed ${money(selected.original_amount, selected.original_currency)} at ${Number(selected.fx_rate)}` : ''}{Number(selected.advance_applied) > 0 ? ` · ${money(selected.advance_applied, selected.currency)} from advance ${selected.advance_reference}` : ''}{selected.note ? ` · ${selected.note}` : ''}</small>
              {['awaiting_payment', 'failed'].includes(selected.status) && <small className={`ex__bank ${bankOf(selected).ok ? 'is-ok' : 'is-off'}`}>{bankOf(selected).text}</small>}
            </div>
            <div className="ex__amount"><strong>{money(selected.amount, selected.currency)}</strong><small>{['awaiting_payment', 'failed'].includes(selected.status) ? 'to pay' : selected.status}</small></div>
          </div>
          <div className="ex__recordBtns">
            <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setSelected(null)}>Close</button>
            <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => onOpenRecord(selected.instance_id)}>Open the claim record</button>
            {['awaiting_payment', 'failed'].includes(selected.status) && <>
              <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setSheet('lines')}>Review lines</button>
              {!bankOf(selected).ok && selected.bank_last4 && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setRevealed(null); setSheet('bank'); }}>Check bank details</button>}
              <button type="button" className="mx__btn mx__btn--sm" disabled={!canPay(selected) || !!selected.payment_run_id} title={selected.payment_run_id ? 'In a payment run' : canPay(selected) ? undefined : 'Check the bank details first'} onClick={() => { setForm({}); setSheet('pay'); }}>Record payment</button>
              {selected.status === 'awaiting_payment' && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({}); setSheet('fail'); }}>Payment failed</button>}
              <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({}); setSheet('void'); }}>Void</button>
            </>}
          </div>
        </div>}
        <DataTable<ClaimRow> path="/api/expenses/claims/search" title="Claims" defaultSort="created_at:desc" refreshKey={tick} onRow={(r) => { setSelected(r); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
          columns={[
            { key: 'claimant', label: 'Claimant', sortable: true, render: (r) => <span className="dt__cell"><Avatar name={r.claimant_name} /><span><strong>{r.claimant_name}</strong><small>{[r.category, r.cost_centre].filter(Boolean).join(' · ')}</small></span></span> },
            { key: 'amount', label: 'To pay', sortable: true, align: 'right', render: (r) => <strong>{money(r.amount, r.currency)}</strong> },
            { key: 'status', label: 'Status', sortable: true, render: (r) => <Pill s={r.status} text={SETTLEMENT_WORDS[r.status]} /> },
            { key: 'bank', label: 'Bank', render: (r) => ['awaiting_payment', 'failed'].includes(r.status) ? <Pill s={bankOf(r).ok ? 'paid' : 'failed'} text={bankOf(r).ok ? 'Checked' : r.bank_last4 ? (r.bank_changed ? 'Changed' : 'Unchecked') : 'None'} /> : '' },
            { key: 'run', label: 'Run', sortable: true, render: (r) => r.run_no ? `Run ${r.run_no}` : '' },
            { key: 'created_at', label: 'Approved', sortable: true, render: (r) => day(r.created_at) },
            { key: 'paid_at', label: 'Paid', sortable: true, hide: true, render: (r) => day(r.paid_at) },
            { key: 'reference', label: 'Reference', hide: true },
            { key: 'purpose', label: 'Purpose', hide: true },
          ]}
          filters={[{ key: 'status', label: 'Status', kind: 'facet', multi: true }, { key: 'category', label: 'Category', kind: 'facet', multi: true }, { key: 'cost_centre', label: 'Cost centre', kind: 'facet', multi: true }, { key: 'bank_checked', label: 'Bank', kind: 'select', options: [['true', 'Checked'], ['false', 'Not checked']] }, { key: 'amount_min', label: 'Amount from', kind: 'text' }, { key: 'from', label: 'Approved after', kind: 'date_from' }, { key: 'to', label: 'Approved before', kind: 'date_to' }]}
          toolbar={<button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({}); setSheet('run'); }}>+ Payment run</button>}
          empty={{ title: 'No claims yet', text: 'Approved claims arrive here. Check the bank details, then pay one by one or in a run.' }} />
      </>}

      {tab === 'runs' && <>
        {run && <div className="mx__card"><div className="mx__cardHead"><h3>Run {run.run_no} <Pill s={run.status === 'paid' ? 'paid' : run.status === 'cancelled' ? 'void' : 'awaiting_payment'} text={run.status} /></h3><div className="mx__bar"><small>{run.count} claim{run.count === 1 ? '' : 's'} · {money(run.total, run.currency)}{run.reference ? ` · ${run.reference}` : ''}{run.note ? ` · ${run.note}` : ''}{run.paid_at ? ` · paid ${day(run.paid_at)}` : ''}</small><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setRun(null)}>Close</button></div></div>
          <div className="ex__recordBtns" style={{ padding: '0 20px 12px' }}>
            {canAdminister && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy === run.id} onClick={() => void act(run.id, async () => { const out = await get<{ filename: string; csv: string; lines: number }>(`/api/expenses/runs/${run.id}/bank-file`); download(out.filename, out.csv); return `Bank file with ${out.lines} line(s) downloaded. Generating it is recorded.`; })}>Bank file</button>}
            {run.status === 'draft' && <><button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({}); setSheet('runPay'); }}>Mark the run paid</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(run.id, async () => { await postJson(`/api/expenses/runs/${run.id}/cancel`, {}); setRun(null); return 'Run cancelled; the claims are free to pay again.'; })}>Cancel run</button></>}
          </div>
          <ul className="mx__list">{run.items.map((it) => <li key={it.id}><Avatar name={it.claimant_name} /><div className="mx__main"><strong>{it.claimant_name}</strong><small>{[it.category, it.cost_centre].filter(Boolean).join(' · ')}{it.bank_name ? ` · ${it.bank_name} •••• ${it.account_last4}` : ' · no bank details'}{it.reference ? ` · ${it.reference}` : ''}</small></div><strong>{money(it.amount, it.currency)}</strong><Pill s={it.status} text={SETTLEMENT_WORDS[it.status as Settlement['status']] ?? it.status} /><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => onOpenRecord(it.instance_id)}>Open</button></li>)}</ul></div>}
        <DataTable<RunRow> path="/api/expenses/runs" title="Payment runs" defaultSort="run_no:desc" refreshKey={tick} onRow={(r) => { void openRun(r.id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
          columns={[
            { key: 'run_no', label: 'Run', sortable: true, render: (r) => <strong>Run {r.run_no}</strong> },
            { key: 'status', label: 'Status', sortable: true, render: (r) => <Pill s={r.status === 'paid' ? 'paid' : r.status === 'cancelled' ? 'void' : 'awaiting_payment'} text={r.status} /> },
            { key: 'count', label: 'Claims', sortable: true, align: 'right' },
            { key: 'total', label: 'Total', sortable: true, align: 'right', render: (r) => <strong>{money(r.total, r.currency)}</strong> },
            { key: 'reference', label: 'Bank reference' },
            { key: 'created_at', label: 'Created', sortable: true, render: (r) => `${day(r.created_at)}${r.created_by_name ? ` · ${r.created_by_name}` : ''}` },
            { key: 'paid_at', label: 'Paid', sortable: true, render: (r) => day(r.paid_at) },
          ]}
          filters={[{ key: 'status', label: 'Status', kind: 'facet', multi: true }, { key: 'from', label: 'Created after', kind: 'date_from' }]}
          toolbar={<button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({}); setSheet('run'); }}>+ Payment run</button>}
          empty={{ title: 'No payment runs yet', text: 'A run gathers every claim with checked bank details, gives you the bank file, and pays them all under one reference.', action: { label: 'Create a run', onClick: () => { setForm({}); setSheet('run'); } } }} />
      </>}

      {tab === 'advances' && <>
        {advance && <div className="ex__record is-open" style={{ background: '#fff' }}>
          <div className="ex__recordHead"><Avatar name={advance.holder_name} /><div className="mx__main"><strong>{advance.holder_name} <Pill s={advance.overdue ? 'failed' : advance.status} text={advance.overdue ? 'Overdue' : ADVANCE_WORDS[advance.status]} /></strong><small>{advance.reference}{advance.purpose ? ` · ${advance.purpose}` : ''}{advance.due_at ? ` · retire by ${day(advance.due_at)}` : ''}{advance.disbursed_at ? ` · paid out ${day(advance.disbursed_at)}` : ''}</small><div className="ex__split"><Bar value={Number(advance.spent) + Number(advance.returned)} max={Number(advance.amount)} warn={advance.overdue} /><small className="mx__tiny">{money(advance.spent, advance.currency)} spent · {money(advance.returned, advance.currency)} returned · {money(advance.outstanding, advance.currency)} still held</small></div></div><div className="ex__amount"><strong>{money(advance.amount, advance.currency)}</strong><small>advanced</small></div></div>
          <div className="ex__recordBtns"><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setAdvance(null)}>Close</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => onOpenRecord(advance.instance_id)}>Open request</button>{advance.status === 'approved' && <button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({}); setSheet('disburse'); }}>Record pay-out</button>}{(advance.status === 'disbursed' || advance.status === 'awaiting_return') && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({}); setSheet('return'); }}>Money returned</button>}</div>
        </div>}
        <DataTable<AdvanceRow> path="/api/expenses/advances/search" title="Cash advances" defaultSort="created_at:desc" refreshKey={tick} onRow={(r) => { setAdvance(r); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
          columns={[
            { key: 'holder', label: 'Holder', sortable: true, render: (r) => <span className="dt__cell"><Avatar name={r.holder_name} /><span><strong>{r.holder_name}</strong><small>{r.reference}</small></span></span> },
            { key: 'amount', label: 'Advanced', sortable: true, align: 'right', render: (r) => money(r.amount, r.currency) },
            { key: 'outstanding', label: 'Held', sortable: true, align: 'right', render: (r) => <strong>{money(r.outstanding, r.currency)}</strong> },
            { key: 'status', label: 'Status', sortable: true, render: (r) => <Pill s={r.overdue ? 'failed' : r.status} text={r.overdue ? 'Overdue' : ADVANCE_WORDS[r.status]} /> },
            { key: 'due_at', label: 'Retire by', sortable: true, render: (r) => day(r.due_at) },
            { key: 'created_at', label: 'Approved', sortable: true, render: (r) => day(r.created_at) },
          ]}
          filters={[{ key: 'status', label: 'Status', kind: 'facet', multi: true }, { key: 'overdue', label: 'Overdue', kind: 'select', options: [['true', 'Overdue only'], ['false', 'Not overdue']] }, { key: 'due_to', label: 'Due before', kind: 'date_to' }]}
          empty={{ title: 'No advances', text: 'When an advance request is approved it appears here. Record the pay-out; the holder retires it with a claim that quotes its reference.' }} />
      </>}

      {tab === 'mine' && <>
        <div className="hr__grid2">
          <DataTable<MyClaim> path="/api/expenses/mine/search" title="My claims" defaultSort="created_at:desc" refreshKey={tick} onRow={(r) => onOpenRecord(r.id)}
            columns={[
              { key: 'expense_date', label: 'Date', sortable: true, render: (r) => day(r.expense_date) },
              { key: 'purpose', label: 'Claim', render: (r) => <span><strong>{r.purpose ?? 'Expense claim'}</strong><br /><small className="mx__tiny">{[r.category, r.cost_centre].filter(Boolean).join(' · ')}</small></span> },
              { key: 'amount', label: 'Claimed', sortable: true, align: 'right', render: (r) => <strong>{money(r.amount, r.currency)}</strong> },
              { key: 'state', label: 'Stage', sortable: true, render: (r) => <Pill s={r.state === 'approved' ? 'paid' : r.state === 'rejected' ? 'void' : 'awaiting_payment'} text={STATE[r.state] ?? r.state} /> },
              { key: 'paid', label: 'Payment', render: (r) => r.settlement_status ? <Pill s={r.settlement_status} text={SETTLEMENT_WORDS[r.settlement_status as Settlement['status']] ?? r.settlement_status} /> : '' },
            ]}
            filters={[{ key: 'state', label: 'Stage', kind: 'select', options: Object.entries(STATE) }, { key: 'paid', label: 'Payment', kind: 'select', options: [['awaiting_payment', 'To pay'], ['paid', 'Paid'], ['failed', 'Failed']] }, { key: 'from', label: 'From', kind: 'date_from' }, { key: 'to', label: 'To', kind: 'date_to' }]}
            empty={{ title: 'No claims yet', text: 'Claims you make with the expense claim form show here with where they are and when they were paid.' }} />
          <div className="mx__stack"><Allowance branches={br} /></div>
        </div>
      </>}

      {tab === 'bank' && <MyBankDetails />}

      {tab === 'budgets' && <div className="mx__card">
        <div className="mx__cardHead"><h3>Budgets by cost centre</h3>{canAdminister && <button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ mode: 'advisory' }); setSheet('budget'); }}>+ Set a budget</button>}</div>
        <div className="ex__budgets">{(budgets.data ?? []).map((b) => { const total = Number(b.amount); const used = Number(b.consumed) + Number(b.reserved); return <div key={b.id} className="ex__budget">
          <div className="ex__budgetHead"><strong>{b.cost_centre}</strong><Pill s={b.mode} text={b.mode === 'enforced' ? 'Enforced' : 'Advisory'} /></div>
          <small className="mx__tiny">{day(b.period_start)} to {day(b.period_end)}</small>
          <div className="ex__budgetBig"><strong style={{ color: b.available < 0 ? '#c0392b' : undefined }}>{money(b.available, cur)}</strong><small>left of {money(b.amount, cur)}</small></div>
          <Bar value={used} max={total} warn={b.available < 0} />
          <small className="mx__tiny">{short(b.consumed)} spent · {short(b.reserved)} in progress</small>
          {canAdminister && <div className="mx__voteBtns" style={{ marginTop: 4 }}><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({ costCentre: b.cost_centre, periodStart: b.period_start.slice(0, 10), periodEnd: b.period_end.slice(0, 10), amount: String(Number(b.amount)), mode: b.mode }); setSheet('budget'); }}>Change</button></div>}
        </div>; })}
        {budgets.data && !budgets.data.length && <EmptyState icon="check" title="No budgets yet" text="Claims are not checked against a budget until one is set. An enforced budget refuses a claim it cannot cover; an advisory one lets it through and marks it." action={canAdminister ? { label: 'Set a budget', onClick: () => { setForm({ mode: 'advisory' }); setSheet('budget'); } } : undefined} />}</div>
      </div>}

      {tab === 'reports' && <>
        <div className="mx__card"><div className="mx__cardHead"><h3>Spend</h3><div className="mx__bar"><input type="date" className="mx__input" style={{ height: 34 }} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /><small>to</small><input type="date" className="mx__input" style={{ height: 34 }} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act('csv', async () => { const out = await get<{ filename: string; csv: string }>(`/api/expenses/claims/search?format=csv&from=${range.from}&to=${range.to}`); download(out.filename, out.csv); return 'Downloaded every claim in the period.'; })}>Export period</button></div></div>
          {report.error && <p className="mx__notice mx__notice--err" style={{ margin: '0 20px 12px' }}>{report.error}</p>}
          {report.data && <div className="hr__ledger"><div style={{ background: 'var(--mod-tint, #fbf3e8)' }}><span>Approved</span><strong>{money(report.data.totals.total, report.data.currency)}</strong><small className="mx__tiny">{report.data.totals.claims} claims</small></div><div><span>Paid</span><strong>{money(report.data.totals.paid, report.data.currency)}</strong></div><div><span>Average claim</span><strong>{money(report.data.totals.average, report.data.currency)}</strong></div><div><span>Reduced in review</span><strong>{report.data.totals.reduced}</strong><small className="mx__tiny">{money(report.data.totals.reducedBy, report.data.currency)} taken off</small></div><div><span>Advances held</span><strong>{money(report.data.advances.held, report.data.currency)}</strong><small className="mx__tiny">{report.data.advances.open} open · {report.data.advances.overdue} overdue</small></div></div>}
        </div>
        {report.data && <div className="hr__grid2"><div className="mx__stack"><Breakdown title="By month" rows={report.data.byMonth} currency={report.data.currency} /><Breakdown title="By cost centre" rows={report.data.byCostCentre} currency={report.data.currency} /></div><div className="mx__stack"><Breakdown title="By category" rows={report.data.byCategory} currency={report.data.currency} /><Breakdown title="Top claimants" rows={report.data.byClaimant} currency={report.data.currency} /><Breakdown title="By status" rows={report.data.byStatus} currency={report.data.currency} labels={SETTLEMENT_WORDS} /></div></div>}
      </>}

      {tab === 'exports' && <>
        <div className="mx__card"><div className="mx__cardHead"><h3>Export paid claims to accounts</h3><div className="mx__bar"><small>{s ? `${s.unexported} paid claim${s.unexported === 1 ? '' : 's'} waiting` : ''}</small><button type="button" className="mx__btn mx__btn--sm" disabled={!s?.unexported} onClick={() => { setForm({}); setSheet('export'); }}>Export batch</button></div></div>
          <ul className="mx__list">{(exports.data ?? []).map((b) => <li key={b.batch_no}><div className="mx__date"><strong>{b.batch_no}</strong><small>batch</small></div><div className="mx__main"><strong>{b.claims} claim{b.claims === 1 ? '' : 's'} · {money(b.total, b.currency)}</strong><small>{new Date(b.created_at).toLocaleString()} by {b.created_by ?? 'someone'} · {b.rows} rows · checksum <span className="ex__mono">{b.checksum.slice(0, 12)}…</span></small></div></li>)}{exports.data && !exports.data.length && <li><EmptyState icon="register" title="No batches yet" text="Each export is numbered and checksummed so accounts can tie it back. One row per approved line with its account code; bank details are never included." /></li>}</ul></div>
      </>}

      {tab === 'settings' && <>
        <div className="mx__segs">{([['policy', 'Policy'], ['categories', 'Categories'], ['cards', 'Per diem & mileage'], ['rates', 'Exchange rates']] as const).map(([k, l]) => <button key={k} type="button" className={`mx__seg ${setupTab === k ? 'is-on' : ''}`} onClick={() => setSetupTab(k)}>{l}</button>)}</div>
        {setupTab === 'policy' && draft && <div className="mx__card"><div className="mx__cardHead"><h3>Expense policy</h3><small>amounts in {cur} · every new claim copies these numbers when submitted</small></div>
          <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('settings', async () => { await postJson('/api/expenses/settings', { autoApproveLimit: draft.autoApproveLimit, managerLimit: draft.managerLimit, lineLimit: draft.lineLimit, receiptThreshold: draft.receiptThreshold, advanceRetirementDays: draft.advanceRetirementDays, requireVerifiedBeneficiary: draft.requireVerifiedBeneficiary, defaultAccountCode: draft.defaultAccountCode ?? '' }); await settings.reload(); return 'Policy saved. New claims use it from now on.'; }); }}>
            {([['autoApproveLimit', 'Approve automatically up to'], ['managerLimit', 'Manager alone approves up to'], ['lineLimit', 'Any single item over this goes to Finance'], ['receiptThreshold', 'Receipt needed for claims over'], ['advanceRetirementDays', 'Days to retire an advance']] as const).map(([k, label]) => <F key={k} label={label}><input inputMode="decimal" disabled={!canAdminister} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} /></F>)}
            <F label="Account code for anything else"><input maxLength={40} disabled={!canAdminister} value={draft.defaultAccountCode ?? ''} onChange={(e) => setDraft({ ...draft, defaultAccountCode: e.target.value })} /></F>
            <F label="Before paying" wide><Choice value={draft.requireVerifiedBeneficiary ? 'yes' : 'no'} onChange={(x) => canAdminister && setDraft({ ...draft, requireVerifiedBeneficiary: x === 'yes' })} options={[['yes', 'Bank details must be checked'], ['no', 'No check needed']]} /></F>
            <div className="mx__field--wide">{canAdminister ? <button type="submit" className="mx__btn" disabled={busy === 'settings'}>Save policy</button> : <small className="mx__tiny">Only owners and admins can change the policy.</small>}</div>
          </form></div></div>}
        {setupTab === 'categories' && <div className="mx__card"><div className="mx__cardHead"><h3>Categories</h3><div className="mx__bar"><small>each with its account code and its own caps</small>{canAdminister && <button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ active: 'yes' }); setSheet('category'); }}>+ Category</button>}</div></div>
          <ul className="mx__list">{(categories.data?.categories ?? []).map((c) => <li key={c.id} className={c.active ? '' : 'is-done'}><span className="mx__avatar" style={{ marginLeft: 0, fontSize: 10 }}>{c.account_code ?? '—'}</span><div className="mx__main"><strong>{c.name} {!c.active && <Pill s="void" text="Off" />}{c.receipt_required && <Pill s="called" text="Receipt" />}{c.note_required && <Pill s="called" text="Note" />}</strong><small>{[c.account_code && `account ${c.account_code}`, c.max_per_line !== null && `max ${money(c.max_per_line, cur)} an item`, c.max_per_claim !== null && `max ${money(c.max_per_claim, cur)} a claim`].filter(Boolean).join(' · ') || 'no caps'}</small></div>{canAdminister && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({ key: c.key, name: c.name, accountCode: c.account_code ?? '', maxPerLine: c.max_per_line === null ? '' : String(Number(c.max_per_line)), maxPerClaim: c.max_per_claim === null ? '' : String(Number(c.max_per_claim)), receipt: c.receipt_required ? 'yes' : 'no', note: c.note_required ? 'yes' : 'no', active: c.active ? 'yes' : 'no', sortOrder: String(c.sort_order) }); setSheet('category'); }}>Edit</button>}</li>)}</ul>
          <p className="mx__tiny" style={{ margin: '0 20px 16px' }}>The claim form offers the categories that are on. A new category reaches the form once the process is republished with it in the dropdown.</p></div>}
        {setupTab === 'cards' && <div className="mx__card"><div className="mx__cardHead"><h3>Per diem and mileage</h3><div className="mx__bar"><small>a rate per branch, per country, or for everyone · the most specific one applies</small>{canAdminister && <button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ kind: 'per_diem', unit: 'day', currency: cur, effectiveFrom: new Date().toISOString().slice(0, 10), active: 'yes' }); setSheet('rateCard'); }}>+ Rate</button>}</div></div>
          <ul className="mx__list">{cardList.map((c) => <li key={c.id} className={c.active ? '' : 'is-done'}><span className="mx__avatar" style={{ marginLeft: 0, fontSize: 10 }}>{c.kind === 'mileage' ? 'KM' : 'PD'}</span><div className="mx__main"><strong>{c.label} {!c.active && <Pill s="void" text="Off" />}</strong><small>{money(c.rate, c.currency)} per {c.unit.replace('_', ' ')} · {c.branch ? `${flag(c.branch_country)} ${c.branch}` : c.country ? `${flag(c.country)} ${c.country}` : 'everyone'} · from {day(c.effective_from)}{c.effective_to ? ` to ${day(c.effective_to)}` : ''}</small></div>{canAdminister && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setForm({ id: c.id, kind: c.kind, label: c.label, branchId: c.branch_id ?? '', country: c.country ?? '', rate: String(Number(c.rate)), currency: c.currency, unit: c.unit, effectiveFrom: c.effective_from, effectiveTo: c.effective_to ?? '', active: c.active ? 'yes' : 'no' }); setSheet('rateCard'); }}>Edit</button>}</li>)}{cards.data && !cardList.length && <li><EmptyState icon="templates" title="No rates yet" text="Set a per diem for each branch or country and a mileage rate, and people see what they can claim before they claim it." action={canAdminister ? { label: 'Add a rate', onClick: () => { setForm({ kind: 'per_diem', unit: 'day', currency: cur, effectiveFrom: new Date().toISOString().slice(0, 10), active: 'yes' }); setSheet('rateCard'); } } : undefined} /></li>}</ul></div>}
        {setupTab === 'rates' && <div className="mx__card"><div className="mx__cardHead"><h3>Exchange rates into {cur}</h3>{canAdminister && <button type="button" className="mx__btn mx__btn--sm" onClick={() => { setForm({ effectiveFrom: new Date().toISOString().slice(0, 10) }); setSheet('rate'); }}>+ Add a rate</button>}</div>
          <ul className="mx__list">{(rates.data ?? []).map((r) => <li key={r.id}><span className="mx__avatar" style={{ marginLeft: 0, fontSize: 10 }}>{r.from_currency}</span><div className="mx__main"><strong>1 {r.from_currency} = {Number(r.rate)} {r.to_currency}</strong><small>from {day(r.effective_from)} · {r.source}{r.entered_by ? ` · added by ${r.entered_by}` : ''}</small></div></li>)}{rates.data && !rates.data.length && <li><EmptyState icon="templates" title="No rates yet" text="Claims in other currencies need a rate into the workspace currency before they can be submitted. Rates are never edited: a new rate takes over from its date." /></li>}</ul></div>}
      </>}
    </div>

    {sheet === 'pay' && selected && <Sheet eyebrow={selected.claimant_name} title="Record the payment" subtitle={`${money(selected.amount, selected.currency)} to ${bankOf(selected).text.replace(/^Bank checked: /, '')}.`} onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === selected.id || !v('reference')} onClick={() => done(selected.id, async () => { await postJson(`/api/expenses/settlements/${selected.id}`, { to: 'paid', reference: v('reference') }); await refreshSelected(); return 'Payment recorded.'; })}>Record</button></>}>
      <SheetSection title="Reference" hint="The bank or payroll batch reference, so the payment can be traced."><F label="Payment reference" wide><input autoFocus maxLength={120} value={v('reference')} onChange={(e) => set('reference', e.target.value)} /></F></SheetSection>
    </Sheet>}
    {(sheet === 'fail' || sheet === 'void') && selected && <Sheet eyebrow={selected.claimant_name} title={sheet === 'fail' ? 'Payment failed' : 'Void this claim'} subtitle={sheet === 'fail' ? 'The claim stays approved and still owed; the reason is kept.' : 'The claim will not be paid. This cannot be undone.'} onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className={`mx__btn ${sheet === 'void' ? 'mx__btn--danger' : ''}`} disabled={busy === selected.id || !v('reason')} onClick={() => { const kind = sheet; done(selected.id, async () => { await postJson(`/api/expenses/settlements/${selected.id}`, { to: kind === 'fail' ? 'failed' : 'void', note: v('reason') }); await refreshSelected(); return kind === 'fail' ? 'Marked as failed. The claim stays approved and still owed.' : 'Claim voided.'; }); }}>{sheet === 'fail' ? 'Mark failed' : 'Void the claim'}</button></>}>
      <SheetSection title="Reason"><F label="Why" wide><textarea autoFocus rows={3} maxLength={500} value={v('reason')} onChange={(e) => set('reason', e.target.value)} /></F></SheetSection>
    </Sheet>}
    {sheet === 'bank' && selected && <Sheet eyebrow={selected.claimant_name} title="Check the bank details" subtitle="Compare them with what you hold on file or the claimant's confirmation. Viewing the full number is recorded." onClose={() => { setSheet(null); setRevealed(null); }}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => { setSheet(null); setRevealed(null); }}>Cancel</button><button type="button" className="mx__btn" disabled={!revealed || busy === selected.id} onClick={() => done(selected.id, async () => { await postJson(`/api/expenses/settlements/${selected.id}/verify-bank`, {}); await refreshSelected(); return 'Bank details checked. You can record the payment.'; })}>These details are correct</button></>}>
      <SheetSection title="On file"><div className="mx__field--wide">{revealed ? <div className="ex__bankCard" style={{ padding: 0 }}><Illustration name="verify" size={48} /><div><strong>{revealed.accountName}</strong><span>{revealed.bankName}{revealed.bankCode ? ` · code ${revealed.bankCode}` : ''}</span><span className="ex__mono">{revealed.accountNumber}</span></div></div> : <button type="button" className="mx__btn mx__btn--ghost" disabled={busy === `${selected.id}-reveal`} onClick={() => void (async () => { setBusy(`${selected.id}-reveal`); try { setRevealed(await postJson(`/api/expenses/settlements/${selected.id}/bank`, {})); } catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); } finally { setBusy(null); } })()}>Show full details</button>}</div></SheetSection>
    </Sheet>}
    {sheet === 'lines' && selected && <Sheet wide eyebrow={selected.claimant_name} title="Review the lines" subtitle="Approve, reduce or reject each item before paying. The submitted amounts are never changed." onClose={() => setSheet(null)}>
      <SheetSection title="Items"><div className="mx__field--wide"><LineReview settlementId={selected.id} onDone={(m) => { setSheet(null); setNote({ text: m }); void reloadAll(); void refreshSelected(); }} /></div></SheetSection>
    </Sheet>}
    {(sheet === 'disburse' || sheet === 'return') && advance && <Sheet eyebrow={advance.holder_name} title={sheet === 'disburse' ? 'Record the pay-out' : 'Money returned'} subtitle={sheet === 'disburse' ? `${money(advance.amount, advance.currency)} to the holder. They retire it with a claim that quotes ${advance.reference}.` : 'The balance handed back, with its receipt or transfer reference.'} onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === advance.id || !v('reference') || (sheet === 'return' && !v('amount'))} onClick={() => { const kind = sheet; done(advance.id, async () => { if (kind === 'disburse') { await postJson(`/api/expenses/advances/${advance.id}/disburse`, { reference: v('reference') }); setAdvance(null); return 'Advance paid out. The holder has until the due date to retire it.'; } await postJson(`/api/expenses/advances/${advance.id}/return`, { amount: v('amount'), reference: v('reference') }); setAdvance(null); return 'Return recorded.'; }); }}>Record</button></>}>
      <SheetSection title="Details">{sheet === 'return' && <F label="Amount returned"><input autoFocus inputMode="decimal" value={v('amount')} onChange={(e) => set('amount', e.target.value)} /></F>}<F label={sheet === 'return' ? 'Receipt or transfer reference' : 'Payment reference'} wide><input autoFocus={sheet === 'disburse'} maxLength={120} value={v('reference')} onChange={(e) => set('reference', e.target.value)} /></F></SheetSection>
    </Sheet>}
    {sheet === 'run' && <Sheet eyebrow="Payment run" title="Create a payment run" subtitle="Gathers every claim that is ready: approved, not in a run, bank details checked where the policy asks. One currency per run." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'run'} onClick={() => done('run', async () => { const r = await postJson<{ id: string; runNo: number; count: number; total: number; currency: string; skipped: number }>('/api/expenses/runs', { settlementIds: 'all', note: v('note') }); setTab('runs'); shell?.onSection?.('runs'); await openRun(r.id); return `Run ${r.runNo}: ${r.count} claim${r.count === 1 ? '' : 's'}, ${money(r.total, r.currency)}.${r.skipped ? ` ${r.skipped} left out (bank details not checked).` : ''}`; })}>Create the run</button></>}>
      <SheetSection title="Note"><F label="Note (optional)" wide><input autoFocus value={v('note')} onChange={(e) => set('note', e.target.value)} placeholder="October payroll batch" /></F></SheetSection>
    </Sheet>}
    {sheet === 'runPay' && run && <Sheet eyebrow={`Run ${run.run_no}`} title="Mark the run paid" subtitle={`${run.count} claims, ${money(run.total, run.currency)}, under one bank reference.`} onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === run.id || !v('reference')} onClick={() => done(run.id, async () => { const r = await postJson<{ paid: number }>(`/api/expenses/runs/${run.id}/pay`, { reference: v('reference') }); await openRun(run.id); return `${r.paid} claims paid under ${v('reference')}.`; })}>Mark paid</button></>}>
      <SheetSection title="Reference"><F label="Bank reference" wide><input autoFocus maxLength={120} value={v('reference')} onChange={(e) => set('reference', e.target.value)} /></F></SheetSection>
    </Sheet>}
    {sheet === 'budget' && <Sheet eyebrow="Budgets" title={v('costCentre') ? `Budget for ${v('costCentre')}` : 'Set a budget'} subtitle="Saving the same cost centre and start date again changes it." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'budget' || !v('costCentre') || !v('amount') || !v('periodStart') || !v('periodEnd')} onClick={() => done('budget', async () => { await postJson('/api/expenses/budgets', { costCentre: v('costCentre'), periodStart: v('periodStart'), periodEnd: v('periodEnd'), amount: v('amount'), mode: v('mode') || 'advisory' }); return 'Budget saved.'; })}>Save</button></>}>
      <SheetSection title="Budget"><F label="Cost centre"><input autoFocus maxLength={60} value={v('costCentre')} onChange={(e) => set('costCentre', e.target.value)} /></F><F label={`Amount (${cur})`}><input inputMode="decimal" value={v('amount')} onChange={(e) => set('amount', e.target.value)} /></F><F label="From"><input type="date" value={v('periodStart')} onChange={(e) => set('periodStart', e.target.value)} /></F><F label="To"><input type="date" value={v('periodEnd')} onChange={(e) => set('periodEnd', e.target.value)} /></F><F label="When it runs out" wide><Choice value={v('mode') || 'advisory'} onChange={(x) => set('mode', x)} options={[['advisory', 'Warn, but let claims through'], ['enforced', 'Refuse claims it cannot cover']]} /></F></SheetSection>
    </Sheet>}
    {sheet === 'rate' && <Sheet eyebrow="Exchange rates" title={`Add a rate into ${cur}`} subtitle="Rates are never edited: a new rate takes over from its start date, and claims already submitted keep theirs." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'rate' || !v('from') || !v('rate') || !v('source')} onClick={() => done('rate', async () => { await postJson('/api/expenses/rates', { from: v('from'), rate: v('rate'), source: v('source'), effectiveFrom: v('effectiveFrom') }); return 'Rate added. New claims in that currency use it from its start date.'; })}>Add</button></>}>
      <SheetSection title="Rate"><F label="Currency"><input list="ex-currencies" autoFocus maxLength={3} value={v('from')} onChange={(e) => set('from', e.target.value.toUpperCase())} placeholder="USD" /><datalist id="ex-currencies">{CURRENCIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</datalist></F><F label={`1 unit = how many ${cur}`}><input inputMode="decimal" value={v('rate')} onChange={(e) => set('rate', e.target.value)} /></F><F label="Source" wide><input maxLength={120} value={v('source')} onChange={(e) => set('source', e.target.value)} placeholder="Central bank official rate" /></F><F label="From"><input type="date" value={v('effectiveFrom')} onChange={(e) => set('effectiveFrom', e.target.value)} /></F></SheetSection>
    </Sheet>}
    {sheet === 'category' && <Sheet eyebrow="Categories" title={v('key') ? `Edit ${v('name')}` : 'New category'} subtitle="Its account code for the export, and the caps and evidence it insists on." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'category' || !v('name')} onClick={() => done('category', async () => { await postJson('/api/expenses/categories', { key: v('key') || undefined, name: v('name'), accountCode: v('accountCode'), maxPerLine: v('maxPerLine') || null, maxPerClaim: v('maxPerClaim') || null, receiptRequired: v('receipt') === 'yes', noteRequired: v('note') === 'yes', active: v('active') !== 'no', sortOrder: v('sortOrder') || 0 }); return 'Category saved.'; })}>Save</button></>}>
      <SheetSection title="Category"><F label="Name"><input autoFocus value={v('name')} onChange={(e) => set('name', e.target.value)} /></F><F label="Account code"><input maxLength={40} value={v('accountCode')} onChange={(e) => set('accountCode', e.target.value)} placeholder="6100" /></F></SheetSection>
      <SheetSection title="Caps" hint={`In ${cur}. Leave empty for no cap.`}><F label="Max per item"><input inputMode="decimal" value={v('maxPerLine')} onChange={(e) => set('maxPerLine', e.target.value)} /></F><F label="Max per claim"><input inputMode="decimal" value={v('maxPerClaim')} onChange={(e) => set('maxPerClaim', e.target.value)} /></F></SheetSection>
      <SheetSection title="Evidence"><F label="Receipt" wide><Choice value={v('receipt') === 'yes' ? 'yes' : 'no'} onChange={(x) => set('receipt', x)} options={[['no', 'Policy threshold applies'], ['yes', 'Always required']]} /></F><F label="Note" wide><Choice value={v('note') === 'yes' ? 'yes' : 'no'} onChange={(x) => set('note', x)} options={[['no', 'Optional'], ['yes', 'Must say what it was for']]} /></F>{v('key') && <F label="Status" wide><Choice value={v('active') === 'no' ? 'no' : 'yes'} onChange={(x) => set('active', x)} options={[['yes', 'On'], ['no', 'Off']]} /></F>}</SheetSection>
    </Sheet>}
    {sheet === 'rateCard' && <Sheet eyebrow="Per diem and mileage" title={v('id') ? `Edit ${v('label')}` : 'New rate'} subtitle="A branch rate beats a country rate, which beats one for everyone." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'rateCard' || !v('label') || !v('rate')} onClick={() => done('rateCard', async () => { await postJson('/api/expenses/rate-cards', { id: v('id') || undefined, kind: v('kind'), label: v('label'), branchId: v('branchId') || undefined, country: v('country') || undefined, rate: v('rate'), currency: v('currency'), unit: v('unit'), effectiveFrom: v('effectiveFrom'), effectiveTo: v('effectiveTo') || undefined, active: v('active') !== 'no' }); return 'Rate saved.'; })}>Save</button></>}>
      <SheetSection title="Rate"><F label="Kind" wide><Choice value={v('kind') || 'per_diem'} onChange={(x) => { set('kind', x); set('unit', x === 'mileage' ? 'km' : 'day'); }} options={[['per_diem', 'Per diem'], ['mileage', 'Mileage']]} /></F><F label="Label" wide><input autoFocus value={v('label')} onChange={(e) => set('label', e.target.value)} placeholder={v('kind') === 'mileage' ? 'Own car' : 'Lagos per diem'} /></F><F label="Rate"><input inputMode="decimal" value={v('rate')} onChange={(e) => set('rate', e.target.value)} /></F><F label="Currency"><select value={v('currency')} onChange={(e) => set('currency', e.target.value)}>{CURRENCIES.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}</select></F><F label="Per" wide><Choice value={v('unit')} onChange={(x) => set('unit', x)} options={v('kind') === 'mileage' ? [['km', 'Kilometre'], ['mile', 'Mile']] : [['day', 'Day'], ['half_day', 'Half day'], ['night', 'Night']]} /></F></SheetSection>
      <SheetSection title="Who it applies to" hint="Pick a branch, or a country, or neither for everyone."><F label="Branch"><select value={v('branchId')} onChange={(e) => { set('branchId', e.target.value); if (e.target.value) set('country', ''); }}><option value="">Any</option>{br.map((b) => <option key={b.id} value={b.id}>{flag(b.country)} {b.name}</option>)}</select></F><F label="Country"><select value={v('country')} onChange={(e) => { set('country', e.target.value); if (e.target.value) set('branchId', ''); }}><option value="">Any</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{flag(c)} {n}</option>)}</select></F></SheetSection>
      <SheetSection title="When"><F label="From"><input type="date" value={v('effectiveFrom')} onChange={(e) => set('effectiveFrom', e.target.value)} /></F><F label="Until" hint="leave empty if open-ended"><input type="date" value={v('effectiveTo')} onChange={(e) => set('effectiveTo', e.target.value)} /></F>{v('id') && <F label="Status" wide><Choice value={v('active') === 'no' ? 'no' : 'yes'} onChange={(x) => set('active', x)} options={[['yes', 'On'], ['no', 'Off']]} /></F>}</SheetSection>
    </Sheet>}
    {sheet === 'export' && <Sheet eyebrow="Exports" title="Export a batch" subtitle="Paid claims not yet exported, one row per approved line with its account code. Leave the dates empty for everything waiting." onClose={() => setSheet(null)}
      footer={<><button type="button" className="mx__btn mx__btn--ghost" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="mx__btn" disabled={busy === 'export'} onClick={() => done('export', async () => { const out = await postJson<{ batchNo: number; claims: number; rows: number; total: number; currency: string; filename: string; csv: string }>('/api/expenses/exports', { from: v('from'), to: v('to') }); download(out.filename, out.csv); return `Batch ${out.batchNo}: ${out.claims} claims, ${out.rows} rows, ${money(out.total, out.currency)}. The file has downloaded.`; })}>Export</button></>}>
      <SheetSection title="Paid between"><F label="From"><input type="date" value={v('from')} onChange={(e) => set('from', e.target.value)} /></F><F label="To"><input type="date" value={v('to')} onChange={(e) => set('to', e.target.value)} /></F></SheetSection>
    </Sheet>}
  </div>;
}
